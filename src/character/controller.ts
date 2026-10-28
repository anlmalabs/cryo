/**
 * Character locomotion + snow-surf physics.
 *
 * This owns motion only — the visual rig, cloth and fur read the state this
 * produces. Two modes share one integrator:
 *
 *  - WALK: camera-relative desired velocity, eased facing, distance-driven gait
 *    phase so footfalls land where the feet actually are (no sliding).
 *  - SURF: momentum-carrying. Thrust along facing, steering from mouse yaw,
 *    strong lateral grip that bleeds into a drift as you push the carve, and
 *    slope-driven acceleration so dropping down a dune face feels like a gain.
 *
 * Blending between them is eased in both directions; there is no snap.
 */

import * as THREE from "three";
import { input } from "../core/input.js";
import { S } from "../core/settings.js";
import { expDamp } from "../core/camera.js";
import type { CameraRig } from "../core/camera.js";
import { clampRange as clamp } from "../spells/bending.js";

/**
 * Everything the locomotion needs from the terrain: a height to stand on and
 * a normal to lean, carve and slope against. Declared here so the figure and
 * the cloth can depend on the same shape rather than on a structural copy.
 */
export interface TerrainLike {
 /** Ground height in metres at the given world column. */
 heightAt(x: number, z: number): number;
 /** Ground normal (unit, +y up) written into `out` and returned. */
 normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
}

const _wish = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _n = new THREE.Vector3();

// `clamp` is `clampRange` from the shared family in `spells/bending.ts`: a
// closed-interval clamp, imported rather than re-implemented so this file, the
// figure and the spell system cannot drift apart on what a bound means.

/** Fraction of the surf blend at which the craft steps as craft/model. */
const SURF_SPLIT = 0.5;

const WALK_SPEED = 2.5;

/** Sprint speed, m/s. Also the gait's reference for glide and impact. */
export const RUN_SPEED = 5.4;

const WALK_ACCEL = 26;
const WALK_DECEL = 30;

/** Ease rate of the facing onto the direction of travel, 1/s. */
const TURN_EASE = 11;

const SURF_MAX = 19.5;

/* ------------------------------------------------------------------- time
 * The step the integrator actually runs at. A frame longer than this is
 * divided nowhere else — everything downstream (damping, thrust, drag, the
 * gait) uses the clamped `h`, so a stall cannot fling the craft.
 */
const FIXED_STEP = 1 / 30; // seconds
/** Below this the frame carries no time: freeze-time runs at dt = 0 and
 *  every `/ h` guard bails rather than producing a NaN. */
const ZERO_T = 1e-6; // seconds

/* -------------------------------------------------------------- surf blend
 * How fast the two modes trade places — asymmetric on purpose: leaving the
 * snow is fast, arriving on it takes longer so the transition reads.
 */
const SURF_EASE_ON = 2.6; // e-fold rate, 1/s
const SURF_EASE_OFF = 3.4; // e-fold rate, 1/s

/* ----------------------------------------------------------------- lean/trim
 * Lateral acceleration mapped onto lean, and how the two are eased.
 */
const LEAN_ACCEL_REF = 26; // m/s² for full lean
const LEAN_MIN = 0.35; // lean kept while walking, of the surf full lean
const LEAN_WALK = 0.65; // the rest: surf at 1.0
const LEAN_EASE = 6.5; // e-fold rate, 1/s
const CARVE_EASE = 9; // e-fold rate, 1/s

/* ----------------------------------------------------------------- streaks
 * Speed window the screen-space streaks open across, on foot or board.
 */
const STREAK_LO = 7; // m/s, where they start to read
const STREAK_SPAN = 11; // m/s, saturate by this

/* ------------------------------------------------------------------- crash
 * for a reason: their fall is cinema watched from outside, this one is
 * happening to the person holding the controller, and every second of it is a
 * second they cannot fly.
 */
const CRASH_FALL_T = 2.1;

/** The climb the descent profile aims at. Set exactly at the contact test's
 *  own threshold (`2.6 + climb < 1.2`, i.e. climb < -1.4, with a hair past it
 *  the landing arrives ON the 2.1 s clock from any starting height instead of
 *  0.1-0.6 s early depending on where the hit caught the craft. */
const CRASH_CONTACT = -1.5;

/** The snow's springiness under a hull that has just arrived at speed, and
 *  the damping on it. Chosen together: stiff enough that a fast arrival digs
 *  well under a metre (so it never reaches the hover floor, which is what used
 *  to stop the fall dead), damped just under critical so the hull beds in with
 *  a single soft rebound rather than bouncing or creeping down. Comfortably
 *  stable at the 1/30 s clamped step. */
const CRASH_SNOW_K = 190;
const CRASH_SNOW_DAMP = 19;

/** The hover height the drawn hull rides at (`HOVER` in speeder.js). The
 *  crash places the craft itself rather than leaving it to the hover solver,
 *  so it needs the same reference the presentation uses. */
const HOVER_REF = 2.6;

/**
 * The E ladder's mid rung, as a fraction of `speederClimbMax` — rung 3 is the
 * full ceiling. Also where the lift saturates: at and above this height the
 * craft is clean of every ground effect.
 */
const CLIMB_MID = 0.45;

const SURF_THRUST = 11.0;

/**
 * Throttle scheme only: the open throttle cruises this much beyond the
 * board's terminal speed — the craft is a fighter, not a sled — with the E
 * reheat multiplying on top. The spool stays the same eased ramp.
 */
const FLY_CRUISE = 1.5;

/** Boost factor eases on at this rate and off at this one, 1/s. */
const BOOST_EASE_ON = 3.0; // e-fold rate, 1/s
const BOOST_EASE_OFF = 1.4; // e-fold rate, 1/s
/**
 * What shift is worth in the slide.
 *
 * On foot it picks run over walk; sliding, there was nothing for it to do —
 * which in the speeder means the one key everybody reaches for did nothing at
 * all. Half again on the top speed and the thrust together, so the craft both
 * accelerates harder and runs out further rather than just getting there sooner.
 */
const BOOST = 1.95;
const SURF_DRAG = 0.42;

/** Quadratic drag coefficient and the linear floor it rides on. */
const DRAG_QUAD = 0.02; // 1/m — scales with v²
const DRAG_LINEAR = 0.9; // m/s, the always-present drag
const SURF_TURN = 2.35; // rad/s at full steer
const SURF_GRIP = 7.5;

/** Yaw-rate cap on a collision kick, rad/s. */
const IMPACT_SPIN_MAX = 3.5; // rad/s
/** Below this the impact spin is zeroed rather than decayed further. */
const IMPACT_SPIN_CUTOFF = 1e-4; // rad/s
/** The impact yaw kick bleeds off at this e-fold rate, 1/s. */
const IMPACT_SPIN_EASE = 1.4; // e-fold rate, 1/s

/** Board reverse scrub thrust when the stick is pulled back, m/s². */
const BOARD_BRAKE = 14; // m/s²
/** Slope assist: downhill acceleration per unit of |gradient|, m/s². */
const SLOPE_ASSIST = 26; // m/s²
/** Throttle spool and vertical-key spool, 1/s. */
const DRIVE_EASE = 9; // e-fold rate, 1/s

/* ----------------------------------------------------------- crash descent
 * Plough drag once the hull is in the snow rather than air, and the roll
 * profile: the initial roll rate, how fast it winds up, and where it caps.
 */
const CRASH_PLOUGH_DRAG = 3.2; // fraction of speed per second
const CRASH_AIR_DRAG = 0.35; // fraction of speed per second, in the air
const CRASH_ROLL_START = 0.7; // rad/s at the killing contact
const CRASH_ROLL_SPINUP = 0.9; // rad/s² of accumulating roll
const CRASH_ROLL_MAX = 2.6; // rad/s cap
/** Nose drift while rolling — it rolls, it does not turn. */
const CRASH_YAW_DRIFT = 0.25; // rad/s
/** Roll → lean conversion: lean earns this many radians per rad/s of roll. */
const CRASH_LEAN_K = 0.62; // rad/(rad/s)
/** Resting attitude the crashed hull holds if it is not told otherwise. */
const CRASH_REST_Y = 0.3; // metres above the contact ground
/** Height above the ground at which the crash is a landing, metres. */
const CRASH_LAND_Y = 1.2; // metres

/* --------------------------------------------------------- descent profile
 * A dying airframe does not spear in: steep middle, then a flare. The
 * profile below is `u²(0.6 + 0.4u)`; without the flare it is at its fastest
 * the instant it arrives, about fourteen metres a second, and no clever snow
 * makes a stop from that read as anything but a stop. So the profile keeps
 * its steepening middle and rolls the final fifth over into a smoothstep
 * ease-out, which halves the arrival rate.
 */
const DESC_BASE_A = 0.6; // profile's leading constant
const DESC_BASE_B = 0.4; // profile's u-weighted term
const DESC_FLARE_AT = 0.8; // u where the flare begins
const DESC_FLARE_SPAN = 0.2; // u across which it completes

/* -------------------------------------------------------------------- gait
 * Distance-driven: phase advances with ground travelled, which is what keeps
 * the feet planted instead of sliding.
 */
/** Gait: metres of travel per full stride cycle, scaled by speed. */
const STRIDE_BASE = 1.55;

/** Speed (m/s) above a sprint where the legs should glide, not run. */
const GLIDE_ABOVE = 1.2; // × RUN_SPEED
/** Stride shape: base length plus the speed-scaled fraction of it. */
const STRIDE_LO = 0.72; // fraction at a standstill
const STRIDE_HI = 0.28; // fraction added at run speed
/** Two plants per stride cycle, at these fractions of the cycle. */
const PLANT_PHASE = 0.5; // phase fraction
/** Below this speed the character is shuffling, not striding. */
const GAIT_MIN_SPEED = 0.15; // m/s
/** Foot impact opens at this base and reaches this cap. */
const FOOT_IMPACT_BASE = 0.35; // impact 0..1
const FOOT_IMPACT_CAP = 1.3; // impact 0..1
/** Lateral offset of a planted foot from the body centreline, metres. */
const FOOT_SIDE = 0.17; // metres

/* --------------------------------------------------------- scramble wobble */
const SCRAMBLE_HZ = 7; // wobble frequency, Hz
const SCRAMBLE_AMP = 0.55; // steer wobble amplitude, fraction of steer
const SCRAMBLE_STEER = 0.35; // steer authority left after a hit
const SCRAMBLE_THRUST = 0.5; // thrust multiplier while scrambled

/* ---------------------------------------------------------- terrain slam */
const SLAM_SPEED = 12; // m/s horizontal speed above which slam counts
const SLAM_SLOPE = 0.86; // normal-y below which the face opposes motion
const SLAM_CLOSURE = 7; // m/s of vertical closure that reads as a hit
const SLAM_RISE = 0.9; // metres the target must lead the craft by

/* ------------------------------------------------------- camera shake load */
const TRAUMA_FLOOR = 0.25; // lean·speed product before the rig gets trauma
const TRAUMA_K = 1.35; // trauma rate above the floor, per second

/* --------------------------------------------------------- steer + trims */
/** Camera-relative steer correction and the yaw term's weight. */
const STEER_CAM_K = 0.85; // raw A/D contribution
const STEER_YAW_K = 1.25; // facing-vs-camera-yaw contribution
const STEER_EASE = 12; // e-fold rate, 1/s
/** Ship vertical ease, and the intro fly-in climb easing. */
const VERT_EASE = 12; // e-fold rate, 1/s
/** Cruise path ground smoothing: how far the craft ignores micro-relief. */
const CRUISE_EASE = 0.5; // e-fold rate, 1/s
/** Vertical snap softness. */
const SNAP_EASE = 26; // e-fold rate, 1/s
/** Hill clearance floor while flying, fraction of lift01. */
const CLEAR_LIFT = 0.8; // fraction of lift01
/** The classic climb's descent easing. */
const CLIMB_EASE_OFF = 0.6; // × climbRate
/** Legacy: `S.speederClimbRate` fallback if unset or not a number. */
const CLIMB_RATE_FLOOR = 0.1; // m/s
const CLIMB_RATE_DEFAULT = 2.2; // m/s
/** Legacy: `S.speederClimbSpeed` fallback if unset. */
const CLIMB_SPEED_DEFAULT = 9; // m/s
/** E-ladder rungs: deck ride, mid, full ceiling. */
const CLIMB_RUNG_MID = CLIMB_MID; // × speederClimbMax
const CLIMB_RUNG_TOP = 1; // × speederClimbMax
const CLIMB_EASE_BOOST = 2; // × climbRate while climbing under throttle
/** Reverse thrust geared to this fraction of forward, under the throttle. */
const REVERSE_FWD_K = 0.9; // fraction of SURF_THRUST
/** Small-magnitude guard for the surf step's drag and steer divisions. */
const ZERO_V = 0.0001; // m/s
const ZERO_A = 0.001; // dimensionless (wish-vector length)

/** One frame of terrain-slam closure, published for the collision pass. */
interface Slam {
 /** Closing speed of the vertical gap, m/s (includes the -(v·n) term). */
 closing: number;
 /** Ground-normal x and z at the closure. */
 nx: number;
 nz: number;
}

export class CharacterController {
 /** Terrain the locomotion is standing on / flying over. */
 terrain: TerrainLike;

 /* ------------------------------------------------------- crash state */
 crashing = false;
 crashLanded: boolean;
 crashDown: boolean;
 _crashT: number;
 _crashSpin: number;
 _crashRoll: number;
 _crashVY: number;
 _crashClimb0: number;

 /* ----------------------------------------------------- core kinematics */
 /** World position of the craft/rider, metres. */
 position: THREE.Vector3;
 /** World velocity, m/s. */
 velocity: THREE.Vector3;
 /** Last frame's velocity, for the acceleration read. */
 prevVelocity: THREE.Vector3;
 /** This frame's acceleration, m/s². */
 acceleration: THREE.Vector3;
 /** Yaw, radians — which way the character faces on the horizontal plane. */
 facing = 0;

 /** Ground speed, m/s. */
 speed: number;
 /** 0..1 speed against SURF_MAX, for FOV/wind. */
 speed01: number;
 /** Unclamped speed against SURF_MAX, so the boost shows above 1. */
 speedRaw: number;

 /**
  * 0 = walking, 1 = fully surfing. Eased — entering and exiting are
  * transitions, not switches.
  */
 surf: number;
 /** Raw intent for this frame; drives the ease of `surf`. */
 surfActive = false;

 /**
  * 0 = not casting, 1 = fully in the bending stance. Written by the spell
  * system, read by the figure.
  *
  * It lives here rather than on the spell system because the figure
  * already reads the controller for everything else it poses from, and a
  * second source of "what is this character doing" is how the arms and the
  * legs end up disagreeing about which frame it is.
  */
 cast: number;
 /** Aim point of the cast, world space. */
 castAimX: number;
 castAimY: number;
 castAimZ: number;

 /** Signed lean, -1..1 (right positive), from lateral acceleration. */
 lean: number;
 /** Signed carve amount for wake shaping. Positive = turning right. */
 carve: number;

 /**
  * 0..1, how hard the screen-space speed streaks should read. Deadbanded
  * well above walking pace: streaks at a jog make the demo feel cheap.
  */
 streak01: number;

 /* -------------------------------------------------- gait / footfalls */
 gaitPhase: number;
 /**
  * True when the legs should be running a gait at all.
  *
  * One flag, read by the figure and by the contact system, because three
  * copies of "is this character walking" is three chances for the feet to
  * disagree with the footprints.
  */
 stepping: boolean;
 /** Set true for exactly one frame when a foot plants. */
 footfall = false;
 /** 0 = left foot, 1 = right foot — which foot just planted. */
 footIndex: number;
 /** World position of the foot that just planted. */
 footPos: THREE.Vector3;
 /** Impact strength 0..1, scales spray and deformation depth. */
 footImpact: number;

 /* --------------------------------------------------- ground contact */
 /** Cached terrain height under the character, metres. */
 groundY: number;
 /** Cached terrain normal under the character, unit +y up. */
 groundNormal: THREE.Vector3;
 /** Last frame's planar speed, for the walk facing ease. */
 _prevSpeed: number;

 /* ------------------------------------------------ eased key states */
 /**
  * The keyboard is a bank of switches and the craft is not. These carry
  * the switch positions through short exponential ramps so nothing
  * downstream — thrust, brake, top speed, turn rate, the camera pan that
  * follows the turn — ever steps in a single frame. The *equilibria* are
  * untouched: hold a key and within a tenth of a second or so every one
  * of these sits exactly where the raw key state used to put it.
  */
 /** Slewed throttle, -1..1. W and S spool (~110 ms) rather than switch. */
 _drive: number;
 /**
  * Eased boost factor, 1..BOOST. Spools up in about a third of a second
  * (the reheat lighting) and bleeds down over about one (the reheat
  * dying) — which is what turns the old one-frame halving of velocity on
  * shift-release into a strong, readable deceleration.
  */
 _boost = 1;
 /**
  * Metres of altitude held above the terrain-following path while E is
  * held (flying only). Eased both ways and asymptotic to
  * `S.speederClimbMax`, so "higher but not too high" is the shape of the
  * curve rather than a ceiling it bangs into.
  */
 _climb: number;
 /** Throttle scheme: where the vertical keys have flown the craft to. */
 _climbWant: number;
 /** The vertical keys, slewed (~80 ms) so the climb engages as a ramp. */
 _vertEase: number;
 /** Vertical rate of the eased climb, m/s — the hull pitches on this. */
 climbRate: number;
 /** Which climb scheme last ran, so a mid-flight swap can seamless. */
 _wasThrottle = false;
 /**
  * Slow-smoothed ground level the cruise path flattens toward. NaN until
  * the first frame seeds it.
  */
 _cruiseGround = NaN;
 /** Flattened base path (terrain-hugging at 0 climb, level at cruise). */
 pathY: number;
 /**
  * 0..1, how far up the climb the craft is — published so the ground
  * effects (the trench, the downwash) can pull away with altitude.
  */
 lift01: number;
 /**
  * Slewed steer, -1..1 — published because the presentation leans on its
  * derivative. An ~80 ms ramp: imperceptible as latency, but it converts
  * every step the keys (and the input disc-clamp) put on the steer into
  * a slope, which is the difference between a craft banking into a turn
  * and a craft being switched into one.
  */
 steer: number;
 /** d(steer)/dt of the slewed steer, for the bank lead. */
 steerRate: number;
 /** Published metres of climb — the speeder adds it to its hover height. */
 climb = 0;

 /* ------------------------------------------------------------ impacts */
 /**
  * Yaw-rate kick from a collision, rad/s. Added to `facing` every surf
  * frame and exp-decayed toward zero — the craft is knocked round, then
  * recovers. Written by `applyImpact`, capped at ±IMPACT_SPIN_MAX.
  */
 impactSpin: number;
 /**
  * Seconds of degraded control after a hit. While > 0 the steer
  * authority drops, a fading wobble rides the stick and the thrust is
  * multiplied by SCRAMBLE_THRUST — the pilot fighting the craft back,
  * not a lockout.
  */
 controlScramble: number;
 /** Where the scramble timer started, for the wobble's fade fraction. */
 _scrambleMax: number;
 /**
  * Internal clock for the scramble wobble. Its own accumulator rather
  * than wall time, so a paused frame doesn't jump the wobble phase and
  * the whole thing replays deterministically.
  */
 _scrambleT: number;
 /**
  * Published once per frame for the collision pass: null, or
  * {closing, nx, nz} on the frame the hover floor absorbed a hard
  * vertical closure (flying into a rising face). One reused object —
  * consumers must read it before the next update.
  */
 terrainSlam: Slam | null = null;
 _slam: Slam = { closing: 0, nx: 0, nz: 0 };
 /** Last frame's hover target height, for the slam closure rate. */
 _prevTargetY = NaN;

 /* ------------------------------------------------ held-key readback */
 /**
  * Which throttle key was held, published for the presentation. All three
  * are undefined after a crash until the keys are re-read, and the crash
  * pins them to `false` while it owns the frame.
  */
 fireHeld: boolean | undefined = undefined;
 driveHeld: boolean | undefined = undefined;
 boostHeld: boolean | undefined = undefined;

 /**
  * @param {TerrainLike} terrain
  */
 constructor(terrain: TerrainLike) {
  this.terrain = terrain;
  this.crashLanded = false;
  this.crashDown = false;
  this._crashT = 0;
  this._crashSpin = 0;
  this._crashRoll = 0;
  this._crashVY = 0;
  this._crashClimb0 = 0;

  this.position = new THREE.Vector3(0, 0, 0);
  this.velocity = new THREE.Vector3(0, 0, 0);
  this.prevVelocity = new THREE.Vector3(0, 0, 0);
  this.acceleration = new THREE.Vector3(0, 0, 0);

  this.facing = 0; // yaw, radians
  this.speed = 0;
  this.speed01 = 0; // normalised against SURF_MAX, for FOV/wind
  this.speedRaw = 0;

  /** 0 = walking, 1 = fully surfing. Eased. */
  this.surf = 0;
  this.surfActive = false;

  /**
   * 0 = not casting, 1 = fully in the bending stance. Written by the spell
   * system, read by the figure.
   *
   * It lives here rather than on the spell system because the figure
   * already reads the controller for everything else it poses from, and a
   * second source of "what is this character doing" is how the arms and the
   * legs end up disagreeing about which frame it is.
   */
  this.cast = 0;
  this.castAimX = 0;
  this.castAimY = 0;
  this.castAimZ = 1;

  /** Signed lean, -1..1 (right positive), from lateral acceleration. */
  this.lean = 0;
  /** Signed carve amount for wake shaping. Positive = turning right. */
  this.carve = 0;
  /**
   * 0..1, how hard the screen-space speed streaks should read. Deadbanded
   * well above walking pace: streaks at a jog make the demo feel cheap.
   */
  this.streak01 = 0;

  // ------------------------------------------------------------- gait
  this.gaitPhase = 0;
  /**
   * True when the legs should be running a gait at all.
   *
   * One flag, read by the figure and by the contact system, because three
   * copies of "is this character walking" is three chances for the feet to
   * disagree with the footprints.
   */
  this.stepping = true;
  /** Set true for exactly one frame when a foot plants. */
  this.footfall = false;
  /** 0 = left foot, 1 = right foot — which foot just planted. */
  this.footIndex = 0;
  /** World position of the foot that just planted. */
  this.footPos = new THREE.Vector3();
  /** Impact strength 0..1, scales spray and deformation depth. */
  this.footImpact = 0;

  this.groundY = 0;
  this.groundNormal = new THREE.Vector3(0, 1, 0);

  this._prevSpeed = 0;

  // ---------------------------------------------------- eased key states
  // The keyboard is a bank of switches and the craft is not. These three
  // carry the switch positions through short exponential ramps so nothing
  // downstream — thrust, brake, top speed, turn rate, the camera pan that
  // follows the turn — ever steps in a single frame. The *equilibria* are
  // untouched: hold a key and within a tenth of a second or so every one
  // of these sits exactly where the raw key state used to put it.
  /** Slewed throttle, -1..1. W and S spool (~110 ms) rather than switch. */
  this._drive = 0;
  /**
   * Eased boost factor, 1..BOOST. Spools up in about a third of a second
   * (the reheat lighting) and bleeds down over about one (the reheat
   * dying) — which is what turns the old one-frame halving of velocity on
   * shift-release into a strong, readable deceleration.
   */
  this._boost = 1;
  /**
   * Metres of altitude held above the terrain-following path while E is
   * held (flying only). Eased both ways and asymptotic to
   * `S.speederClimbMax`, so "higher but not too high" is the shape of the
   * curve rather than a ceiling it bangs into.
   */
  this._climb = 0;
  /** Throttle scheme: where the vertical keys have flown the craft to. */
  this._climbWant = 0;
  /** The vertical keys, slewed (~80 ms) so the climb engages as a ramp. */
  this._vertEase = 0;
  /** Vertical rate of the eased climb, m/s — the hull pitches on this. */
  this.climbRate = 0;
  this._wasThrottle = false;
  /** Slow-smoothed ground level the cruise path flattens toward. */
  this._cruiseGround = NaN;
  /** Flattened base path (terrain-hugging at 0 climb, level at cruise). */
  this.pathY = 0;
  /**
   * 0..1, how far up the climb the craft is — published so the ground
   * effects (the trench, the downwash) can pull away with altitude.
   */
  this.lift01 = 0;
  /**
   * Slewed steer, -1..1 — published because the presentation leans on its
   * derivative. An ~80 ms ramp: imperceptible as latency, but it converts
   * every step the keys (and the input disc-clamp) put on the steer into
   * a slope, which is the difference between a craft banking into a turn
   * and a craft being switched into one.
   */
  this.steer = 0;
  /** d(steer)/dt of the slewed steer, for the bank lead. */
  this.steerRate = 0;

  // ------------------------------------------------------------ impacts
  /**
   * Yaw-rate kick from a collision, rad/s. Added to `facing` every surf
   * frame and exp-decayed toward zero — the craft is knocked round, then
   * recovers. Written by `applyImpact`, capped at ±3.5.
   */
  this.impactSpin = 0;
  /**
   * Seconds of degraded control after a hit. While > 0 the steer
   * authority drops, a fading wobble rides the stick and the thrust is
   * halved — the pilot fighting the craft back, not a lockout.
   */
  this.controlScramble = 0;
  /** Where the scramble timer started, for the wobble's fade fraction. */
  this._scrambleMax = 0;
  /**
   * Internal clock for the scramble wobble. Its own accumulator rather
   * than wall time, so a paused frame doesn't jump the wobble phase and
   * the whole thing replays deterministically.
   */
  this._scrambleT = 0;
  /**
   * Published once per frame for the collision pass: null, or
   * {closing, nx, nz} on the frame the hover floor absorbed a hard
   * vertical closure (flying into a rising face). One reused object —
   * consumers must read it before the next update.
   */
  this.terrainSlam = null;
  this._slam = { closing: 0, nx: 0, nz: 0 };
  /** Last frame's hover target height, for the slam closure rate. */
  this._prevTargetY = NaN;
 }

 /**
  * Collision response entry point (called by the collision pass).
  *
  * Sets the planar velocity outright — the impact math upstream already
  * decided what survives the hit — adds a yaw-rate kick that `_surfStep`
  * bleeds into the facing, and starts (or extends, never shortens) the
  * control scramble.
  *
  * @param {number} vx  new world velocity x, m/s
  * @param {number} vz  new world velocity z, m/s
  * @param {number} spin  signed yaw-rate kick, rad/s
  * @param {number} scrambleSec  seconds of degraded control
  */
 applyImpact(vx: number, vz: number, spin: number, scrambleSec: number): void {
  if (this.crashing) return;
  this.velocity.x = vx;
  this.velocity.z = vz;
  this.impactSpin = clamp(
   this.impactSpin + spin, -IMPACT_SPIN_MAX, IMPACT_SPIN_MAX
  );
  if (scrambleSec > this.controlScramble) {
   this.controlScramble = scrambleSec;
   this._scrambleMax = Math.max(this._scrambleMax, scrambleSec);
  }
 }

 /**
  * Put the craft in. Called when a contact was hard enough that flying
  * away from it would be a lie — the player has hit an AT-AT, or driven
  * into a hillside at speed, and what follows is not a damage state but a
  * crash.
  *
  * momentum is what it was, and the craft rolls around its own long axis
  * cinema seen from outside and is allowed five and a half seconds; this
  * one is happening to the person holding the controller, and every one of
  * those seconds is a second they cannot fly, so it is roughly half that.
  *
  * @param {number} [spinDir] which way it rolls in, ±1; random if omitted
  */
 beginCrash(spinDir?: number): void {
  if (this.crashing) return;
  this.crashing = true;
  this.crashLanded = false;
  this.crashDown = false;
  this._crashT = 0;
  this._crashSpin = spinDir || (Math.random() < SURF_SPLIT ? -1 : 1);
  this._crashRoll = CRASH_ROLL_START;
  this._crashVY = 0;
  this._crashClimb0 = this._climb;
  this.impactSpin = 0;
  this.controlScramble = 0;
  this._scrambleMax = 0;
  this.terrainSlam = null;
 }

 /** Hand the craft back, flying, wherever the caller has put it. */
 endCrash() {
  this.crashing = false;
  this.crashLanded = false;
  this.crashDown = false;
  this._crashT = 0;
  // The crash pinned these to `false`, and `false ?? input.fire` is
  // `false` — the fallback only fires on undefined. Left as they were,
  // the guns never worked again after the first crash.
  this.fireHeld = undefined;
  this.driveHeld = undefined;
  this.boostHeld = undefined;
  this.lean = 0;
  this.carve = 0;
  this.impactSpin = 0;
  this.controlScramble = 0;
  this._scrambleMax = 0;
  this._prevTargetY = NaN;
 }

 /**
  * One frame of going in: drag, a roll that keeps accelerating, and a
  * descent that arrives at the snow on a fixed clock rather than whenever
  * the terrain happens to come up.
  *
  * Publishes the same surface the presentation reads every other frame —
  * a crash the hull could not draw would not be worth having.
  *
  * @param {number} h clamped seconds
  */
 _crashStep(h: number): void {
  this._crashT += h;

  // No stick reaches this. The surf blend is pinned open so the hull
  // stays in its flying pose rather than trying to stand up mid-fall.
  this.surfActive = false;
  this.surf = 1;
  this.driveHeld = false;
  this.boostHeld = false;
  this.fireHeld = false;
  this.steer = 0;
  this.steerRate = 0;

  // Down is down. Everything below this line is the *fall*; once the
  // snow has it, the wreck lies there — it does not keep spinning like
  // a coin, which is what a roll that never stopped would look like.
  //
  // `crashDown` decides, not the one-frame `crashLanded` latch: that
  // latch is consumed by whoever is watching for the landing, so
  // reading it here would see the craft touch down and then, one frame
  // later, believe it was airborne again. The clock stays as a backstop.
  const flying = this._crashT < CRASH_FALL_T && !this.crashDown;

  // Momentum, bleeding — hard once it is ploughing snow rather than air.
  const drag = Math.max(0, 1 - h * (flying ? CRASH_AIR_DRAG : CRASH_PLOUGH_DRAG));
  this.velocity.x *= drag;
  this.velocity.z *= drag;
  this.position.x += this.velocity.x * h;
  this.position.z += this.velocity.z * h;

  if (flying) {
   // The roll: it winds up, so the craft is turning over faster at
   // the snow than it was at the top. `lean` is what the hull banks
   // with, so a steadily growing lean IS a continuous roll.
   this._crashRoll = Math.min(CRASH_ROLL_MAX, this._crashRoll + h * CRASH_ROLL_SPINUP);
   this.lean += this._crashSpin * (this._crashRoll / CRASH_LEAN_K) * h;
   // A slow drift of the nose — it is rolling, not turning.
   this.facing += this._crashSpin * CRASH_YAW_DRIFT * h;
  }
  // Settled: the wreck keeps whatever attitude it came to rest at —
  // rolls itself level while lying in the snow gives the whole fall
  // away as animation.
  this.carve = 0;

  this.groundY = this.terrain.heightAt(this.position.x, this.position.z);
  this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);
  this.pathY = this.groundY;
  this.lift01 = 0;

  // The descent, on a normalised profile from whatever height the hit
  // interrupted down to the deck at u = 1 — so it arrives on the clock
  // holds the craft up for the first beat and then drops the nose.
  const prevClimb = this._climb;
  if (this._crashT < CRASH_FALL_T) {
   // The fall. `s` holds the craft up for the first beat and then
   // drops its nose, arriving at the snow steepening — which is what
   // a dead airframe does and what the pitch term needs to read.
   const u = this._crashT / CRASH_FALL_T;
   // Steepen, then FLARE. `u²(0.6+0.4u)` alone is fastest at the
   // instant it arrives — about fourteen metres a second — and no
   // amount of clever snow underneath makes a stop from that look
   // like anything but a stop. A dying airframe does not spear in;
   // it comes down steep and then pancakes as the last of the lift
   // washes off. So the profile keeps its steepening middle and
   // rolls the final fifth over into an ease-out, which halves the
   // arrival rate and leaves the spring below a far easier job.
   const base = u * u * (DESC_BASE_A + DESC_BASE_B * u);
   const f = Math.max(0, (u - DESC_FLARE_AT) / DESC_FLARE_SPAN);
   const s = base + (1 - base) * (f * f * (3 - 2 * f));
   this._climb = this._crashClimb0
    + (CRASH_CONTACT - this._crashClimb0) * s;
   // Carry the arrival rate over the boundary. Without it the whole
   // descent simply STOPS on the frame the profile runs out — ten
   // metres a second becomes zero between one frame and the next,
   // which is the moment that reads as the hull being stapled to the
   // ground rather than hitting it.
   this._crashVY = h > ZERO_T ? (this._climb - prevClimb) / h : 0;
  } else {
   // The plough. It arrives carrying real speed and sheds it into
   // the snow instead of against a wall: the hull keeps sinking,
   // less each frame, digs a little past where it will finally lie,
   // and floats back up to rest. Both halves are the same event and
   // they are a third of a second apart: the hull arrives, the spring
   // absorbs the arrival, and the settle that follows is what reads as
   // weight, because stopping dead would read instead as the craft
   // being welded to the snow.
   // Snow that resists like snow: a spring back toward the resting
   // height, damped, rather than a floor the hull hits. The first
   // version of this DID bleed the arrival speed gradually — and
   // then drove straight into the hard clamp a frame later and
   // stopped dead anyway, which is the whole thing being fixed.
   // Stiff enough to absorb a fourteen-metre-a-second arrival inside
   // half a metre, damped to just under critical so it beds in with
   // one soft rebound instead of bouncing or creeping.
   this._crashVY += (CRASH_CONTACT - this._climb) * CRASH_SNOW_K * h;
   this._crashVY -= this._crashVY * CRASH_SNOW_DAMP * h;
   this._climb += this._crashVY * h;
  }
  this.climb = this._climb;
  this._climbWant = this._climb;
  // The honest derivative of the profile, not a zero: this is what the
  // hull's vertical-pitch term reads, and it is the difference between
  // a craft that dives into the snow and one that descends flat like a
  // lift. Peaks around 15-20 m/s from altitude — the pitch consumer
  // saturates its own clamp, so the nose drops to full deflection.
  this.climbRate = h > ZERO_T ? (this._climb - prevClimb) / h : 0;
  this.position.y = Math.max(
   this.groundY + HOVER_REF + this._climb, this.groundY + CRASH_REST_Y
  );

  const sp = Math.hypot(this.velocity.x, this.velocity.z);
  this.speed = sp;
  this.speed01 = clamp(sp / SURF_MAX, 0, 1);
  this.speedRaw = sp / SURF_MAX;
  this.acceleration.set(0, 0, 0);

  // watching for it owns the fireball, the crater and what happens next.
  if (!this.crashDown && this.position.y - this.groundY < CRASH_LAND_Y) {
   this.crashLanded = true;
   this.crashDown = true;
  }
 }

 /**
  * One frame: the crash, or the walk/surf step, then the climb, the
  * vertical snap and everything the presentation reads.
  *
  * @param {number} dt frame delta, seconds — clamped to FIXED_STEP
  * @param {CameraRig} rig the chase rig this frame's steer feeds
  */
 update(dt: number, rig: CameraRig): void {
  const h = Math.min(dt, FIXED_STEP);

  this.prevVelocity.copy(this.velocity);

  // Going in. Owns the whole update — no stick, no thrust, no hover: the
  // craft is falling and the only thing left is which way it rolls.
  if (this.crashing) {
   this._crashStep(h);
   return;
  }

  this.surfActive = input.surf;

  // Ease the surf blend — entering and exiting are transitions, not switches.
  this.surf = expDamp(
   this.surf, this.surfActive ? 1 : 0,
   this.surfActive ? SURF_EASE_ON : SURF_EASE_OFF, h
  );

  rig.getFlatForward(_fwd);
  rig.getFlatRight(_right);

  if (this.surf > SURF_SPLIT) this._surfStep(h, rig);
  else this._walkStep(h);

  // On foot the character always faces where the camera is looking, so
  // walking/strafing reads relative to the view and the rig never has to
  // chase a separate bearing. (Surf keeps its own steer-based facing.)
  if (this.surf <= SURF_SPLIT) {
   this.facing = angleDamp(this.facing, rig.yaw, TURN_EASE, h);
  }

  // Scramble countdown — after the step, so the frame a hit lands still
  // steers with the full scramble it was just given.
  if (this.controlScramble > 0) {
   this.controlScramble = Math.max(0, this.controlScramble - h);
   if (this.controlScramble === 0) this._scrambleMax = 0;
  }

  // ---------------------------------------------------- integrate + snap
  this.position.x += this.velocity.x * h;
  this.position.z += this.velocity.z * h;

  this.groundY = this.terrain.heightAt(this.position.x, this.position.z);
  this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);

  // ---- climb (flying) -------------------------------------------------
  // Two schemes share this block and the eased `_climb` under them.
  //
  // Classic (default): hold nothing — E is a latch. The climb is an
  // exponential approach to `speederClimbMax`, so it can never overshoot
  // the configured ceiling and release settles it back the same way.
  //
  // Throttle (`S.flightThrottle`): free flight on the vertical. The held
  // key — slewed like the steer, so it engages as a ramp — walks a target
  // height between the deck and `speederCeiling` at `speederClimbSpeed`
  // m/s, and letting go *holds the altitude* rather than settling.
  const flyingNow = !!input.flying && this.surf > SURF_SPLIT;
  const throttleMode = flyingNow && S.flightThrottle === true;
  if (throttleMode !== this._wasThrottle) {
   // Mid-flight scheme change: adopt the current height as the flown
   // target so nothing jumps, and clear the classic latch.
   this._wasThrottle = throttleMode;
   this._climbWant = this._climb;
   input.riseLevel = 1;
  }
  const climbRate = Math.max(
   CLIMB_RATE_FLOOR, Number(S.speederClimbRate) || CLIMB_RATE_DEFAULT
  );
  const prevClimb = this._climb;
  let liftDenom: number;
  if (throttleMode) {
   const ceiling = Math.max(0, Number(S.speederCeiling) || 0);
   this._vertEase = expDamp(this._vertEase, input.vert, VERT_EASE, h);
   this._climbWant = clamp(
    this._climbWant
    + this._vertEase * (Number(S.speederClimbSpeed) || CLIMB_SPEED_DEFAULT) * h,
    0, ceiling
   );
   this._climb = expDamp(
    this._climb, this._climbWant,
    this._climbWant > this._climb ? climbRate * CLIMB_EASE_BOOST : climbRate, h
   );
   liftDenom = ceiling;
  } else {
   const climbMax = Math.max(0, Number(S.speederClimbMax) || 0);
   // Three rungs on the E ladder: the deck ride, a mid cruise, and
   // the top. Each is genuinely higher than the last; E steps up and
   // wraps (see input.riseLevel).
   const level = Math.max(1, Math.min(3, input.riseLevel | 0));
   const wantUp = flyingNow
    ? [0, 0, CLIMB_RUNG_MID, CLIMB_RUNG_TOP][level] * climbMax : 0;
   this._climb = expDamp(
    this._climb, wantUp,
    wantUp > this._climb ? climbRate : climbRate * CLIMB_EASE_OFF, h
   );
   this._climbWant = this._climb;
   this._vertEase = 0;
   // Lift saturates at the mid rung: the deck keeps its trench,
   // downwash and spray, and rungs 2 and 3 both fly fully clean of
   // the snow rather than trailing a faded version of it.
   liftDenom = climbMax * CLIMB_RUNG_MID;
  }
  this.climbRate = h > ZERO_T ? (this._climb - prevClimb) / h : 0;
  this.lift01 = liftDenom > ZERO_T ? Math.min(1, this._climb / liftDenom) : 0;
  /** Published metres of climb — the speeder adds it to its hover height. */
  this.climb = this._climb;

  // Cruise flattening: up at altitude the craft stops tracing every dune
  // and rides a level path that only drifts with the large-scale terrain
  // (a ~2 s smoothing of the ground). Blended in by how far up the climb
  // it is, with a floor so a hill taller than the cruise path still
  // pushes the craft over it rather than through it. On the deck (and on
  // the board) lift01 is 0 and this is exactly the old ground snap.
  if (!Number.isFinite(this._cruiseGround)) this._cruiseGround = this.groundY;
  this._cruiseGround = expDamp(this._cruiseGround, this.groundY, CRUISE_EASE, h);
  /** The flattened base path the hull rides — published for the speeder. */
  this.pathY = this.groundY
   + (this._cruiseGround - this.groundY) * this.lift01;
  const targetY = Math.max(
   this.pathY + this._climb, this.groundY + CLEAR_LIFT * this.lift01
  );
  // Snap with a little softness so micro-ripples don't jitter the rig.
  this.position.y = expDamp(this.position.y, targetY, SNAP_EASE, h);

  // ---- terrain slam ---------------------------------------------------
  // The hover snap absorbs vertical closures silently: fly fast into a
  // rising face and targetY leaps while the eased snap trails behind, so
  // the craft never "hits" anything. When that closure is fast, the slope
  // actually opposes the motion and the craft is quick, that *is* a hit —
  // published for one frame for the collision pass to consume. Climb-key
  // rises (the E ladder, the intro fly-in seeding `_climb`) move targetY
  // too, but those are self-inflicted: `climbRate` is subtracted from the
  // closure before thresholding so only the terrain's share counts.
  this.terrainSlam = null;
  if (flyingNow && h > ZERO_T && Number.isFinite(this._prevTargetY)) {
   const nx = this.groundNormal.x;
   const ny = this.groundNormal.y;
   const nz = this.groundNormal.z;
   const vn = this.velocity.x * nx + this.velocity.z * nz;
   const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
   if (hSpeed > SLAM_SPEED && ny < SLAM_SLOPE && vn < 0) {
    const closure =
     (targetY - this._prevTargetY) / h - this.climbRate;
    if (closure > SLAM_CLOSURE && targetY - this.position.y > SLAM_RISE) {
     this._slam.closing = closure - vn; // vn < 0: adds -(v·n)
     this._slam.nx = nx;
     this._slam.nz = nz;
     this.terrainSlam = this._slam;
    }
   }
  }
  this._prevTargetY = targetY;

  // --------------------------------------------------------- bookkeeping
  this.speed = Math.hypot(this.velocity.x, this.velocity.z);
  // Normalised against the *unboosted* top, so the FOV, the wind and the
  // jet all keep opening up past 1 while the boost is held rather than
  // pinning the instant it engages.
  this.speed01 = clamp(this.speed / SURF_MAX, 0, 1);
  /** Unclamped, for anything that wants to know about the boost. */
  this.speedRaw = this.speed / SURF_MAX;

  // Same guard as steerRate: freeze-time runs the whole loop at dt = 0,
  // and 0/0 here is a NaN that rides lean → carve → rig roll and never
  // comes back.
  if (h > ZERO_T) {
   this.acceleration.x = (this.velocity.x - this.prevVelocity.x) / h;
   this.acceleration.z = (this.velocity.z - this.prevVelocity.z) / h;
  } else {
   this.acceleration.x = 0;
   this.acceleration.z = 0;
  }

  // Lateral acceleration → lean. Project accel onto the character's right.
  const rx = Math.cos(this.facing);
  const rz = -Math.sin(this.facing);
  const latAcc = this.acceleration.x * rx + this.acceleration.z * rz;
  const leanWant = clamp(latAcc / LEAN_ACCEL_REF, -1, 1)
   * (LEAN_MIN + LEAN_WALK * this.surf);
  this.lean = expDamp(this.lean, leanWant, LEAN_EASE, h);
  this.carve = expDamp(this.carve, leanWant, CARVE_EASE, h);

  this.streak01 = this.surf
   * clamp((this.speed - STREAK_LO) / STREAK_SPAN, 0, 1);

  this._gait(h);
 }
 /** @param {number} h */

 _walkStep(h: number): void {
  const maxSpeed = input.sprint ? RUN_SPEED : WALK_SPEED;

  _wish.set(
   _fwd.x * input.moveZ + _right.x * input.moveX,
   0,
   _fwd.z * input.moveZ + _right.z * input.moveX
  );

  const wishLen = Math.hypot(_wish.x, _wish.z);
  if (wishLen > ZERO_A) {
   _wish.x = (_wish.x / wishLen) * maxSpeed;
   _wish.z = (_wish.z / wishLen) * maxSpeed;

   const a = WALK_ACCEL * h;
   this.velocity.x += clamp(_wish.x - this.velocity.x, -a, a);
   this.velocity.z += clamp(_wish.z - this.velocity.z, -a, a);

   // Face the direction of travel only when moving forward-dominantly.
   // Backing up or strafing sideways keeps the current facing, so the
   // character backpedals/strafes instead of spinning ~180° and dragging
   // the camera around in a circle ("walking in circles").
   // Facing is driven by the camera (see update()), not by the wish
   // vector, so the character always turns to where the camera is looking
   // and WASD reads as strafe/backpedal relative to that facing. Nothing
   // to do with the wish vector here.
  } else {
   const d = WALK_DECEL * h;
   const s = Math.hypot(this.velocity.x, this.velocity.z);
   if (s > ZERO_V) {
    const k = Math.max(0, s - d) / s;
    this.velocity.x *= k;
    this.velocity.z *= k;
   }
  }
 }
 /**
  * The surf step: steering, thrust, slope, grip and drag.
  *
  * @param {number} h clamped seconds
  * @param {CameraRig} rig the rig the camera-relative steer term reads
  */
 _surfStep(h: number, rig: CameraRig): void {
  // Steer from the mouse (camera yaw drift) plus explicit A/D.
  //
  // On a board those two terms are a servo: A/D pushes the facing and the
  // camera-relative term pulls it back toward where you are looking, which
  // is what makes a carve feel like leaning rather than like driving. It
  // also *caps* the turn — at equilibrium the two cancel, which on this
  // board is about forty degrees off the camera and is the whole point.
  //
  // In the speeder that cap is a bug. A craft you cannot turn around is not
  // flying, it is on rails, so A/D steers outright and the camera is
  // dragged along with it below.
  const flying = !!input.flying;
  const steerRaw = flying
   ? clamp(input.moveX, -1, 1)
   : clamp(
    input.moveX * STEER_CAM_K + angleDelta(this.facing, rig.yaw) * STEER_YAW_K,
    -1, 1
   );
  // Slew, don't sample: the keys step the steer 0 → 1 in one frame, and
  // used raw that steps the yaw *rate* of the entire view. The ramp is
  // ~80 ms — under any human's perception of latency, and it also eats
  // the 1.0 → 0.707 step the input disc-clamp puts on moveX every time
  // the throttle key changes while turning.
  const prevSteer = this.steer;
  this.steer = expDamp(this.steer, steerRaw, STEER_EASE, h);
  this.steerRate = h > ZERO_T ? (this.steer - prevSteer) / h : 0;
  let steer = this.steer;

  // Control scramble: after a hit the stick answers at a third of its
  // authority with a ~7 Hz wobble riding it, fading as the timer runs
  // out. The wobble runs on its own accumulator (not wall time) so it is
  // deterministic and freeze-time doesn't jump its phase. Zero cost —
  // and exactly zero change — when the timer is idle.
  if (this.controlScramble > 0) {
   this._scrambleT += h;
   const frac = this._scrambleMax > ZERO_T
    ? this.controlScramble / this._scrambleMax : 0;
   steer = clamp(
    steer * SCRAMBLE_STEER
    + Math.sin(this._scrambleT * SCRAMBLE_HZ * Math.PI * 2) * SCRAMBLE_AMP * frac,
    -1, 1
   );
  }
  const turn = steer * SURF_TURN * h;
  this.facing += turn;

  // A collision's yaw kick rides the facing directly and bleeds off —
  // the craft is knocked round, then straightens itself out.
  if (this.impactSpin !== 0) {
   this.facing += this.impactSpin * h;
   this.impactSpin = expDamp(this.impactSpin, 0, IMPACT_SPIN_EASE, h);
   if (Math.abs(this.impactSpin) < IMPACT_SPIN_CUTOFF) this.impactSpin = 0;
  }
  // The chase camera still follows the craft round — but the rig now
  // chases `facing` itself through a damped follow (see CameraRig.update)
  // instead of having `turn` added straight into `rig.yaw` here, so the
  // view's pan rate eases with the steer rather than stepping with it.

  // Camera shake, and only from the one thing that earns it: an edge
  // loaded up at speed. Added as a rate rather than as an impulse, so it
  // reaches an equilibrium against the rig's own decay — hard carve at top
  // speed settles around 0.4 trauma, which is a couple of centimetres of
  // rig movement. Anything you can consciously see here is too much.
  const load = Math.abs(steer) * (this.speed / SURF_MAX);
  if (load > TRAUMA_FLOOR) rig.addTrauma((load - TRAUMA_FLOOR) * TRAUMA_K * h);

  const fx = Math.sin(this.facing);
  const fz = Math.cos(this.facing);

  // Slope: heading downhill adds speed, uphill scrubs it.
  this.terrain.normalAt(this.position.x, this.position.z, _n);
  const slopeAssist = -(_n.x * fx + _n.z * fz) * SLOPE_ASSIST;

  // Eased, not switched: shift moves the *target* of the boost factor and
  // the factor chases it — quick on (the reheat lights), slow off (it
  // dies). The hard speed cap below still exists, but its ceiling now
  // glides down over about a second instead of halving the velocity in
  // one frame on shift-release.
  const throttleMode = flying && S.flightThrottle === true;
  const boostHeld = throttleMode ? input.boost : input.sprint;
  this._boost = expDamp(
   this._boost, boostHeld ? BOOST : 1,
   boostHeld ? BOOST_EASE_ON : BOOST_EASE_OFF, h
  );
  const boost = this._boost * (throttleMode ? FLY_CRUISE : 1);
  let thrust = SURF_THRUST * boost + slopeAssist;

  // The throttle spools the same way (~110 ms), so the key engages thrust
  // as a ramp the jet's own eased flame actually matches, instead of the
  // hull lurching a frame before the flame answers. Under the throttle
  // scheme that key is shift — W/S belong to the vertical — and there is
  // no reverse gear: a craft that can dive out of a run doesn't back up.
  this._drive = expDamp(
   this._drive,
   throttleMode ? (input.thrust ? 1 : 0) : input.moveZ,
   DRIVE_EASE, h
  );

  // Published for the presentation, which prefers these over its raw
  // so the jet plume answers the throttle, whichever key that is.
  this.driveHeld = throttleMode ? input.thrust : input.moving;
  this.boostHeld = boostHeld;

  // A board under a rider is always being pushed — that is what a slide is,
  // and letting go means stopping pushing. A craft holding station is not
  // being pushed at all, so flying, the thrust is gated on the throttle
  // actually being open: W drives, S is reverse thrust — it sheds speed
  // hard and, held, backs the craft up — and nothing at all leaves it
  // hovering where you left it instead of wandering off across the field.
  if (flying) {
   const fwd = this._drive;
   // One continuous curve through zero: forward thrust scaled by the
   // spooled throttle, astern geared to REVERSE_FWD_K of it. Both
   // directions ride the eased `_drive`, so brake engagement ramps
   // instead of stepping, and the top-speed clamp below caps reverse
   // exactly as it caps forward.
   thrust *= fwd > 0 ? fwd : 0;
   if (fwd < 0) thrust = SURF_THRUST * REVERSE_FWD_K * fwd;
  } else if (input.moveZ < 0) {
   // Board only.
   thrust -= BOARD_BRAKE; // pull back to scrub speed
  }

  // Scrambled controls also cost thrust: SCRAMBLE_THRUST power while the
  // pilot is wrestling the craft straight.
  if (this.controlScramble > 0) thrust *= SCRAMBLE_THRUST;

  this.velocity.x += fx * thrust * h;
  this.velocity.z += fz * thrust * h;

  // Lateral grip: kill sideways velocity, but not entirely — the residual
  // is what reads as a drift when you overcook the turn.
  const rx = Math.cos(this.facing);
  const rz = -Math.sin(this.facing);
  const lat = this.velocity.x * rx + this.velocity.z * rz;
  // Exact exponential rather than the Euler fraction `SURF_GRIP * h`: the
  // fraction removed more sideways velocity per frame at low frame rates
  // than at high ones, so the drift character stiffened whenever the frame
  // rate dipped. Same constant; at 60 fps the two differ by under 1%.
  const grip = 1 - Math.exp(-SURF_GRIP * h);
  this.velocity.x -= rx * lat * grip;
  this.velocity.z -= rz * lat * grip;

  // Quadratic drag → a natural terminal speed.
  const s = Math.hypot(this.velocity.x, this.velocity.z);
  if (s > ZERO_V) {
   const drag = SURF_DRAG * s * s * DRAG_QUAD + DRAG_LINEAR;
   const k = Math.max(0, s - drag * h) / s;
   this.velocity.x *= k;
   this.velocity.z *= k;
  }
  const top = SURF_MAX * boost;
  if (s > top) {
   const k = top / s;
   this.velocity.x *= k;
   this.velocity.z *= k;
  }
 }

 /**
  * Distance-driven gait. Phase advances with ground travelled, not with time,
 * which is what keeps feet planted instead of sliding.
 * @param {number} h
 */
 _gait(h: number): void {
  this.footfall = false;

  // Feet stay on the board while surfing — and for the run-out afterwards.
  //
  // The surf blend eases to zero in a fifth of a second, but the momentum
  // takes two thirds of one to bleed off, and in between the character is
  // travelling at nineteen metres a second. The gait is distance-driven, so
  // it answered that with a twelve-hertz cadence and the legs blurred. A
  // sprint is the fastest thing anyone walks at; above it, glide.
  this.stepping = this.surf <= SURF_SPLIT && this.speed <= RUN_SPEED * GLIDE_ABOVE;
  if (!this.stepping) {
   this.gaitPhase = 0;
   return;
  }

  const dist = this.speed * h;
  const stride = STRIDE_BASE
   * (STRIDE_LO + STRIDE_HI * Math.min(1, this.speed / RUN_SPEED));
  const prev = this.gaitPhase;
  this.gaitPhase = (this.gaitPhase + dist / stride) % 1;

  // Below this the character is shuffling, not striding — the events
  // below would fire on every cycle regardless.
  if (this.speed < GAIT_MIN_SPEED) return;

  // Two plants per cycle, at phase 0 and PLANT_PHASE.
  const crossed =
   (prev < PLANT_PHASE && this.gaitPhase >= PLANT_PHASE) || this.gaitPhase < prev;
  if (!crossed) return;

  this.footfall = true;
  this.footIndex = this.gaitPhase < PLANT_PHASE ? 0 : 1;
  this.footImpact = clamp(FOOT_IMPACT_BASE + this.speed / RUN_SPEED, 0, FOOT_IMPACT_CAP);

  // Offset the plant to the correct side of the body. Left foot is index
  // 0, so it lands on the negative lateral axis.
  const side = this.footIndex === 0 ? -FOOT_SIDE : FOOT_SIDE;
  const rx = Math.cos(this.facing);
  const rz = -Math.sin(this.facing);
  this.footPos.set(
   this.position.x + rx * side,
   this.position.y,
   this.position.z + rz * side
  );
 }
}

// ------------------------------------------------------------------ helpers

/**
 * Signed shortest-arc difference from `a` to `b`, in radians, wrapped to
 * (-π, π].
 *
 * @param {number} a current angle, radians
 * @param {number} b target angle, radians
 * @returns {number} the delta the shorter way round
 */
export function angleDelta(a: number, b: number): number {
 let d = b - a;
 while (d > Math.PI) d -= Math.PI * 2;
 while (d < -Math.PI) d += Math.PI * 2;
 return d;
}
/**
 * Framerate-independent easing across the shortest arc.
 *
 * @param {number} cur current angle, radians
 * @param {number} target angle to ease toward, radians
 * @param {number} rate e-fold rate, 1/s
 * @param {number} dt elapsed seconds
 * @returns {number} the eased angle, not wrapped
 */
export function angleDamp(
 cur: number, target: number, rate: number, dt: number
): number {
 return cur + angleDelta(cur, target) * (1 - Math.exp(-rate * dt));
}
