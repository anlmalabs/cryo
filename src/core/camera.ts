/**
 * Third-person spring-arm rig — action-MMO framing.
 *
 * The arm is deliberately *not* rigid: the pivot chases the character through a
 * critically-damped spring, so hard acceleration pulls the camera back and the
 * character drifts forward in frame. FOV widens with speed, the rig banks into
 * carves, and everything eases. Nothing here snaps.
 *
 * Open snow field, so there is no obstacle collision solve — only the ground
 * itself pushes the arm up, which buys a rig that never pops through a drift.
 *
 * Port note: there is no engine camera underneath any more. `rig.camera` is a
 * plain object — position, fov (vertical, RADIANS), aspect, near/far, and the
 * hand-built left-handed view/projection matrices — and it is the single
 * source of truth every pass renders with. The post chain jitters
 * `camera.projection` after `rig.update`; nothing else may touch these
 * matrices mid-frame.
 */

import * as THREE from "three";
import { input } from "./input.js";
import { S, type SettingValue } from "./settings.js";
import type { Gfx } from "./gfx.js";
import {
 setFrame, invertRigid, mulMat4, invertMat4, perspectiveFovLH,
} from "./mat4.js";

// ------------------------------------------------------- reduced motion
/**
 * The user's motion preference — read once here, kept live afterwards.
 *
 * This is the single point in the codebase that asks the question. The CSS
 * `@media (prefers-reduced-motion: reduce)` block in index.html neutralises
 * every stylesheet animation and transition, but it has no reach into the
 * simulation, so the one piece of JS-driven motion left on screen was the
 * camera's trauma shake below.
 *
 * Deliberately *not* an `S` key: the preference belongs to the user's
 * machine rather than to this demo's tuning, and `settings.ts` owns both the
 * key list and the overlay's widgets. Read as a media query instead, the same
 * way `main.ts` reads `(pointer: coarse)`.
 *
 * A media query is a live subscription, not a snapshot — an OS-level setting
 * can flip while the page is open, and `change` re-latches it without a
 * reload. No settings write, no overlay row, nothing to get out of sync.
 */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const reducedMotionMQ = window.matchMedia?.(REDUCED_MOTION_QUERY) ?? null;

/**
 * The motion preference, live. True while the user has asked for less.
 *
 * A live binding rather than a constant so the `change` listener below can
 * re-latch it in place: importers read the current value, and a media query
 * is a subscription rather than a snapshot — an OS setting flipped while the
 * page is open shows up on the very next frame.
 */
export let reducedMotion = reducedMotionMQ?.matches === true;

reducedMotionMQ?.addEventListener("change", (e: MediaQueryListEvent) => {
 reducedMotion = e.matches;
});

// ------------------------------------------------------- module-scope scratch
const _pivot = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _frame = new Float32Array(16); // camera world frame, rebuilt every update

/** Height probes taken along the spring arm each frame. */
const ARM_SAMPLES = 5;

// CHASE_SWING is gone. It keyed off the per-frame mouse accumulator — so it
// never engaged on an actual A/D turn, fired as a rubbery counter-drag on
// freelook instead, and integrated a frame-rate-dependent offset into the yaw
// that never came back. The damped facing-follow below does the job it was
// after (the craft leads into the turn and presents its flank) from the real
// steer, and returns to exactly zero on the straight by construction.

const PITCH_MIN = -0.62; // radians, looking up
const PITCH_MAX = 1.05; // radians, looking down
const DIST_MIN = 2.6; // metres, tightest zoom-in
const DIST_MAX = 11.0; // metres, widest zoom-out

// ------------------------------------------------------------ framing knobs
// All speeds are 1/second exponential-damping rates; all lengths are metres.

/** Field of view, vertical, in radians (~58 deg). */
const FOV_BASE = 1.02;
/** Near/far clip planes, metres. */
const NEAR_Z = 0.12;
const FAR_Z = 4200;

/** Pitch that opens the shot: on the craft vs. shoulder-height on foot. */
const PITCH_SHIP = 0.42;
const PITCH_FOOT = 0.17;
/** Arm length at boot, metres. */
const DIST_SHIP = 11.5;
const DIST_FOOT = 6.2;
/** Over-the-shoulder offset in camera space, metres (ship: none). */
const SHOULDER_FOOT = 0.85;
/** Pivot height above the target's feet, metres. */
const PIVOT_HEIGHT_SHIP = 4.2;
const PIVOT_HEIGHT_FOOT = 1.62;
/** Clearance the arm keeps above the snow, metres. */
const GROUND_CLEARANCE_SHIP = 3.4;
const GROUND_CLEARANCE_FOOT = 1.35;
/** Initial yaw, radians. */
const YAW_START = 2.4;

// -------------------------------------------------------------- update knobs

/** How hard each fractional turn-of-the-wheel zooms (1/s fraction). */
const ZOOM_RATE = 0.35;
/** Damping rate pulling the eased arm length to its target, 1/s. */
const ZOOM_DAMP = 9;
/** How far the pivot leads the target's velocity, metres per m/s. */
const LEAD_GAIN = 1.35;
/** Fraction of that lead actually applied to the pivot, ratio. */
const LEAD_MIX = 0.09;
/** Pivot spring frequency and damping (1 = critical). */
const PIVOT_SPRING_FREQ = 7.5;
const PIVOT_SPRING_DAMPING = 1.0;
/** Boost-breath ease rate, 1/s, and its FOV contribution, ratio. */
const BREATH_RATE = 2.5;
const BREATH_FOV = 0.04;
/** Fraction of FOV the frame inhales with speed, ratio. */
const SPEED_FOV = 0.19;
/** Damping rate of the FOV toward its target, 1/s. */
const FOV_DAMP = 3.2;
/** Bank angle per unit of lean, radians. */
const ROLL_PER_LEAN = 0.085;
/** Roll ease rate, 1/s. */
const ROLL_DAMP = 5.0;
/** Trauma decay per second (trauma is squared before it is used). */
const TRAUMA_DECAY = 1.15;
/**
 * How fast the reduced-motion gate on `shake` opens or closes, 1/second
 * (exponential damping rate).
 *
 * Turning the shake off by multiplying by zero would step the camera by
 * whatever offset the current trauma had built up — up to ~0.16 m at full
 * trauma — which is itself a jolt, so the preference eases the multiplier
 * instead. Roughly a third of a second to ring out from a standing shake,
 * and the existing `SHAKE_EPSILON` retires the offsets entirely once the
 * gate has rung out, so there is no residue left to carry.
 */
const SHAKE_GATE_DAMP = 9.0;

// --- the ground-clearance probes -------------------------------------------
/** Seconds of travel each probe looks ahead to predict oncoming snow. */
const PREDICT_SECONDS = 0.12;
/**
 * Clearance profile along the arm: `base + taper * t`, where t = 0 at the
 * pivot and 1 at the eye. At the pivot the arm only wants the base fraction
 * (so it is not shoved up merely for being near the player's own feet), and
 * the full clearance is restored by the eye.
 */
const CLEARANCE_BASE_FRACTION = 0.35;
const CLEARANCE_TAPER = 0.65;
/** Ground lift ease rates, 1/s — rise fast, relax slowly. */
const LIFT_RISE = 10;
const LIFT_FALL = 4.5;

// --- compose-xform ----------------------------------------------------------
/** How far the eye is lifted off the pivot's own line, metres. */
const UP_OFFSET = 0.22;

// --- shake ------------------------------------------------------------------
/** Trauma below this is treated as exactly zero (already squared below). */
const SHAKE_EPSILON = 0.0001;
/** Frequency multiplier of the positional shake signal, 1/s. */
const POSITIONAL_SHAKE_FREQ = 26;
/** Per-axis positional shake amplitude of the noise signal, metres. */
const SHAKE_AMP_X = 0.16;
const SHAKE_AMP_Y = 0.16;
const SHAKE_AMP_Z = 0.10;
/** Frequency multipliers of the angular shake signals, 1/s. */
const SHAKE_FREQ_PITCH = 31;
const SHAKE_FREQ_YAW = 29;
const SHAKE_FREQ_ROLL = 23;
/** Per-axis angular shake amplitude, radians. */
const SHAKE_AMP_PITCH = 0.02;
const SHAKE_AMP_YAW = 0.02;
const SHAKE_AMP_ROLL = 0.05;

/**
 * Read a numeric knob off the shared settings struct. `S` is a union of
 * number | boolean | string, so a lookup is not a number until it has been
 * checked — and a toggle mistakenly read as a tuning value must fail loudly
 * here rather than quietly serving `false` as 0.
 */
function numSetting(v: SettingValue): number {
 if (typeof v !== "number") {
  throw new TypeError(`camera setting expected a number, got ${typeof v}`);
 }
 return v;
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v: number, lo: number, hi: number): number {
 if (v < lo) return lo;
 if (v > hi) return hi;
 return v;
}

export class CameraRig {
 /** The device layer; owned by `core/gfx.js`. */
 gfx: Gfx;
 /** May be null before boot has resolved the element; `_aspect` falls back. */
 canvas: HTMLElement | null;
 /**
  * The camera state — a plain object, not a THREE camera. `fov` is
  * vertical and in RADIANS (the source convention; walkers and the
  * overlay read it as such). `projection` carries the TAA jitter once
  * the post chain has run; `view` is LH with +Z forward.
  */
 camera: {
  position: THREE.Vector3;
  fov: number;
  aspect: number;
  minZ: number;
  maxZ: number;
  view: THREE.Matrix4;
  projection: THREE.Matrix4;
  viewProjection: THREE.Matrix4;
  invView: THREE.Matrix4;
  invViewProjection: THREE.Matrix4;
 };
 /** Current yaw/pitch/roll, radians. */
 yaw: number;
 pitch: number;
 roll: number;
 /** Where the roll is heading at the current lean, radians. */
 rollTarget: number;
 /** Arm length now and where it is heading, metres. */
 distance: number;
 distanceTarget: number;
 /** Unrotated FOV the speed widening rides on top of, radians. */
 baseFov: number;
 /** Active FOV, radians. */
 fov: number;
 /** Smoothed pivot position (the thing the spring chases). */
 pivot: THREE.Vector3;
 pivotVel: THREE.Vector3;
 /** Over-the-shoulder offset, in camera space, metres. */
 shoulder: number;
 /** Pivot height above the target's feet, metres. */
 pivotHeight: number;
 /** The rig's basis, republished every frame, published for aimers. */
 forward: THREE.Vector3;
 right: THREE.Vector3;
 up: THREE.Vector3;
 /** Trauma-based shake; `shake = trauma^2`. */
 trauma: number;
 shakeTime: number;
 /**
  * Multiplier on `shake`, eased between 0 and 1 by the reduced-motion
  * preference. Exists so switching the preference eases the shake out
  * instead of stepping it off mid-frame — see `update`'s shake block.
  */
 _shakeScale: number;
 /** Height sampler, injected once the terrain exists. */
 groundAt: ((x: number, z: number) => number) | null;
 /** Metres of snow the camera must keep beneath it. */
 groundClearance: number;
 /** The value `groundClearance` starts from, metres. */
 groundClearanceBase: number;
 /** Eased lift currently being applied to stay above the surface. */
 groundLift: number;
 /** Mouse-look offset riding on the facing-follow while flying. */
 _yawUser: number | null;
 /** Boost inhale 0..1 — eases the arm and FOV breathing on reheat. */
 _breath: number;
 _first: boolean;
 /**
  * @param {import("./gfx.js").Gfx} gfx
  * @param {HTMLElement|null} canvas the element whose client size drives the aspect
  */
 constructor(gfx: Gfx, canvas: HTMLElement | null) {
  this.gfx = gfx;
  this.canvas = canvas;

  /**
   * The camera state — a plain object, not a THREE camera. `fov` is
   * vertical and in RADIANS (the source convention; walkers and the
   * overlay read it as such). `projection` carries the TAA jitter once
   * the post chain has run; `view` is LH with +Z forward.
   */
  this.camera = {
   position: new THREE.Vector3(0, 3, -6),
   fov: FOV_BASE, // ~58deg vertical
   aspect: 16 / 9,
   minZ: NEAR_Z,
   maxZ: FAR_Z,
   view: new THREE.Matrix4(),
   projection: new THREE.Matrix4(),
   viewProjection: new THREE.Matrix4(),
   invView: new THREE.Matrix4(),
   invViewProjection: new THREE.Matrix4(),
  };

  this.yaw = YAW_START;
  // Looking down on the craft rather than along the ground behind it. A
  // speeder is read from above — you fly it by watching the snow come at
  // you — and the figure's shoulder-height framing put the horizon across
  // the middle of the hull.
  // Build-time capability gate (S.speeder): camera framing for a ship build vs walk-only. Not runtime mode.
  this.pitch = S.speeder !== false ? PITCH_SHIP : PITCH_FOOT;

  this.distance = S.speeder !== false ? DIST_SHIP : DIST_FOOT;
  this.distanceTarget = this.distance;

  /** Smoothed pivot position (the thing the spring chases). */
  this.pivot = new THREE.Vector3(0, 0, 0);
  this.pivotVel = new THREE.Vector3(0, 0, 0);

  /** Over-the-shoulder offset, in camera space. */
  this.shoulder = S.speeder !== false ? 0.0 : SHOULDER_FOOT;
  // The craft hovers a few metres up, so the pivot has to as well or the
  // arm sits under it and looks up through the floor.
  this.pivotHeight = S.speeder !== false ? PIVOT_HEIGHT_SHIP : PIVOT_HEIGHT_FOOT;
  /** Metres of clearance the arm keeps above the snow. */
  this.groundClearanceBase = S.speeder !== false ? GROUND_CLEARANCE_SHIP : GROUND_CLEARANCE_FOOT;

  this.baseFov = FOV_BASE;
  this.fov = FOV_BASE;

  this.roll = 0;
  this.rollTarget = 0;

  /**
   * The rig's basis, republished every frame. The spells aim with the
   * same three vectors, so there is only one place the convention for
   * "forward" is written down.
   */
  this.forward = new THREE.Vector3(0, 0, 1);
  this.right = new THREE.Vector3(1, 0, 0);
  this.up = new THREE.Vector3(0, 1, 0);

  // Trauma-based shake (Squirrel Eiserloh style): shake = trauma^2, so it
  // falls off perceptually rather than linearly.
  this.trauma = 0;
  this.shakeTime = 0;
  this._shakeScale = reducedMotion ? 0 : 1;

  /**
   * Height sampler, injected once the terrain exists.
   * @type {((x:number, z:number) => number)|null}
   */
  this.groundAt = null;
  /** Metres of snow the camera must keep beneath it. */
  this.groundClearance = this.groundClearanceBase;
  /** Eased lift currently being applied to stay above the surface. */
  this.groundLift = 0;

  /**
   * Mouse-look, kept as an offset *on top of* the facing-follow while
   * flying. Null until the first flying update so it can pick up whatever
   * offset the boot sequence left between yaw and facing.
   */
  this._yawUser = null;
  /** Boost inhale 0..1 — eases the arm and FOV breathing on reheat. */
  this._breath = 0;

  this._first = true;

  // Give the matrices real values from the start — the warm-up runs the
  // shadow fit and the bakes before the first `update()`.
  this.camera.fov = this.fov;
  this._composeMatrices(this.pitch, this.yaw, this.roll);
 }

 /** @param {number} amount 0..1 */
 addTrauma(amount: number) {
  this.trauma = Math.min(1, this.trauma + amount);
 }

 /**
  * @param {number} dt seconds
  * @param {THREE.Vector3} targetPos character world position (feet)
  * @param {THREE.Vector3} targetVel character world velocity
  * @param {number} lean signed lean amount, -1..1, for banking
  * @param {number} speed01 normalised speed for FOV widening
  * @param {number|null} facing craft heading while flying; null on foot.
  *        When given, the rig owns following it — the controller no longer
  *        writes `rig.yaw` directly.
  */
 update(dt: number, targetPos: THREE.Vector3, targetVel: THREE.Vector3, lean: number, speed01: number, facing: number | null = null, targetFacing: number | null = null) {
  // ------------------------------------------------------------- look
  const flying = facing !== null;
  if (flying) {
   // The yaw chases the craft's heading through a damped follow, with
   // the mouse kept as a separate additive offset. Same steady-state
   // framing as the old `rig.yaw += turn` weld — the follow converges
   // in about a tenth of a second — but the pan *rate* now ramps with
   // the steer instead of stepping with the keys, and a hard turn lets
   // the craft lead the frame by a few degrees and show its flank.
   if (this._yawUser === null) {
    this._yawUser = angleDelta(facing, this.yaw);
   }
   this._yawUser += input.lookX;
   // Near-welded by default; the cinematic layer relaxes the follow as
   // speed builds, so the faster the run the more the craft leads it.
   let rate = 18;
   if (S.cinematicCam) rate -= 9 * Math.min(1, speed01) * numSetting(S.camYawLag);
   this.yaw = angleDamp(this.yaw, facing + this._yawUser, rate, dt);
  } else {
   this.yaw += input.lookX;
   // On foot the arm swings wide without the player asking for it, which
   // reads badly against a walking gait. Only re-center to the body's own
   // bearing very lazily, only while the player is moving, and only when
   // they are not actively looking — dragging against an in-progress look
   // makes the camera feel like it is fighting the mouse.
   if (targetFacing != null && input.lookX === 0 && targetVel && (targetVel.x * targetVel.x + targetVel.z * targetVel.z) > 1) {
    this.yaw = angleDamp(this.yaw, targetFacing, 2.2, dt);
   }
  }
  this.pitch = clamp(this.pitch + input.lookY, PITCH_MIN, PITCH_MAX);

  // ------------------------------------------------------------- zoom
  this.distanceTarget = clamp(
   this.distanceTarget + input.zoomDelta * (this.distanceTarget * ZOOM_RATE),
   DIST_MIN,
   DIST_MAX
  );
  // Eased zoom — expDamp is framerate-independent.
  this.distance = expDamp(this.distance, this.distanceTarget, ZOOM_DAMP, dt);

  // ------------------------------------------------------------ pivot
  _pivot.copy(targetPos);
  _pivot.y += this.pivotHeight;

  // Lead the camera slightly into the direction of travel so fast motion
  // shows more of what's ahead.
  const lead = Math.min(1, speed01) * LEAD_GAIN;
  _pivot.x += targetVel.x * lead * LEAD_MIX;
  _pivot.z += targetVel.z * lead * LEAD_MIX;

  if (this._first) {
   this.pivot.copy(_pivot);
   this._first = false;
  } else {
   // Softer spring under acceleration = the arm stretches, then recovers.
   springDamp(this.pivot, this.pivotVel, _pivot, PIVOT_SPRING_FREQ, PIVOT_SPRING_DAMPING, dt);
  }

  // -------------------------------------------------------------- fov
  // Boost breath: while the reheat is lit the frame inhales — a little
  // extra arm and a touch more FOV, eased in over half a second and eased
  // back out on release. It rides *on top of* the composed arm length so
  // the player's own zoom (distanceTarget) is never touched.
  this._breath = expDamp(
   this._breath,
   flying && S.cinematicCam && input.sprint ? 1 : 0,
   BREATH_RATE, dt
  );
  const breath = this._breath * numSetting(S.camBoostBreath);
  const fovWant = this.baseFov * (1 + speed01 * SPEED_FOV) + breath * BREATH_FOV;
  this.fov = expDamp(this.fov, fovWant, FOV_DAMP, dt);

  // ------------------------------------------------------------- bank
  this.rollTarget = -lean * ROLL_PER_LEAN;
  this.roll = expDamp(this.roll, this.rollTarget, ROLL_DAMP, dt);

  // ------------------------------------------------------------ shake
  // Trauma still accumulates and still decays at its normal rate while the
  // user has asked for reduced motion — only the offsets it drives are
  // suppressed, and eased out rather than cut. Halting the decay instead
  // would leave a full trauma value banked against the moment the
  // preference is switched back off, which would fire the whole stored
  // shake at once: exactly the abrupt jump the preference asks to avoid,
  // and the reason the multiplier ramps instead of snapping to zero.
  this._shakeScale = expDamp(
   this._shakeScale, reducedMotion ? 0 : 1, SHAKE_GATE_DAMP, dt
  );
  this.trauma = Math.max(0, this.trauma - dt * TRAUMA_DECAY);
  this.shakeTime += dt;
  const shake = this.trauma * this.trauma * this._shakeScale;

  // ------------------------------------------------------ compose xform
  const cp = Math.cos(this.pitch);
  _fwd.set(
   Math.sin(this.yaw) * cp,
   -Math.sin(this.pitch),
   Math.cos(this.yaw) * cp
  );
  _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  _up.crossVectors(_right, _fwd);
  _up.normalize();

  this.forward.copy(_fwd);
  this.right.copy(_right);
  this.up.copy(_up);

  _desired.copy(this.pivot);
  _desired.add(_tmp.copy(_fwd).multiplyScalar(-(this.distance + breath)));
  _desired.add(_tmp.copy(_right).multiplyScalar(this.shoulder));
  _desired.add(_tmp.copy(_up).multiplyScalar(UP_OFFSET));

  // ---- keep the arm out of the snow --------------------------------
  // The lift rises quickly and relaxes slowly: snapping down the instant a
  // crest passes under the arm reads as a jolt, while being slow to rise
  // means a frame or two actually inside the snow.
  if (this.groundAt) {
   // Worst case over the whole arm, not just the eye: a crest between
   // the player and the camera can fill the view while the eye itself
   // is legally above the snow.
   let need = 0;
   // Predictive as well as reactive: each probe also looks ~0.12 s
   // along the rig's own travel, so an approaching crest starts the
   // lift *before* it slides under the arm. That early warning is what
   // lets the rise rate drop from a near-instant 26 to 10 — a felt
   // ease-in instead of a vertical kick — without ever clipping snow.
   const px = this.pivotVel.x * PREDICT_SECONDS;
   const pz = this.pivotVel.z * PREDICT_SECONDS;
   for (let i = 0; i <= ARM_SAMPLES; i++) {
    const t = i / ARM_SAMPLES;
    const x = this.pivot.x + (_desired.x - this.pivot.x) * t;
    const z = this.pivot.z + (_desired.z - this.pivot.z) * t;
    const y = this.pivot.y + (_desired.y - this.pivot.y) * t;
    const g = Math.max(this.groundAt(x, z), this.groundAt(x + px, z + pz));
    // Clearance eases in along the arm so it does not shove the
    // camera up merely for being near the player's own feet.
    const gh = g + this.groundClearance * (CLEARANCE_BASE_FRACTION + CLEARANCE_TAPER * t);
    const d = gh - y;
    if (d > need) need = d;
   }

   this.groundLift = expDamp(
    this.groundLift, need, need > this.groundLift ? LIFT_RISE : LIFT_FALL, dt
   );
   _desired.y += this.groundLift;
  }

  if (shake > SHAKE_EPSILON) {
   const t = this.shakeTime * POSITIONAL_SHAKE_FREQ;
   // 31.7 / 71.3 are decorrelated phase offsets into the same noise
   // channel, so the three axes do not move in lockstep. Arbitrary
   // irrational-ish seeds, not a unit — kept inline.
   _desired.x += (noise1(t) * 2 - 1) * shake * SHAKE_AMP_X;
   _desired.y += (noise1(t + 31.7) * 2 - 1) * shake * SHAKE_AMP_Y;
   _desired.z += (noise1(t + 71.3) * 2 - 1) * shake * SHAKE_AMP_Z;
  }

  // The Babylon build wrote position + Euler angles and let the engine
  // build the view. Here the same final angles — shake included — feed
  // the hand-built LH view directly.
  const cam = this.camera;
  cam.position.copy(_desired);
  cam.fov = this.fov;
  // + 11 / + 53 / + 97 are per-axis phase offsets into the same noise
  // channel (see the positional shake above) — decorrelation seeds, not
  // units, so they stay inline.
  this._composeMatrices(
   this.pitch + (shake > SHAKE_EPSILON ? (noise1(this.shakeTime * SHAKE_FREQ_PITCH + 11) * 2 - 1) * shake * SHAKE_AMP_PITCH : 0),
   this.yaw + (shake > SHAKE_EPSILON ? (noise1(this.shakeTime * SHAKE_FREQ_YAW + 53) * 2 - 1) * shake * SHAKE_AMP_YAW : 0),
   this.roll + (shake > SHAKE_EPSILON ? (noise1(this.shakeTime * SHAKE_FREQ_ROLL + 97) * 2 - 1) * shake * SHAKE_AMP_ROLL : 0)
  );
 }

 /**
  * Rebuild `camera.view` (LH, +Z forward) from the given final angles and
  * the current `camera.position`, plus an UNJITTERED `camera.projection`.
  * Babylon Euler order is Y-then-X-then-Z (yaw, pitch, roll) — the basis
  * below is exactly that composition: yaw/pitch build the frame, roll spins
  * right/up about forward.
  *
  * Also refreshes viewProjection/invView/invViewProjection so early readers
  * (the warm-up shadow fit runs before the post chain exists) see coherent
  * matrices; the post chain recomputes all three after jittering.
/** @param {number} pitch @param {number} yaw @param {number} roll */
 _composeMatrices(pitch: number, yaw: number, roll: number) {
  const cam = this.camera;
  cam.aspect = this._aspect();

  const cp = Math.cos(pitch);
  const fx = Math.sin(yaw) * cp;
  const fy = -Math.sin(pitch);
  const fz = Math.cos(yaw) * cp;

  const rx0 = Math.cos(yaw), ry0 = 0, rz0 = -Math.sin(yaw);

  // Real up = fwd x right — (0,1,0) at identity, exactly the frame
  // Babylon's Euler-built rotation produced. (The *published* `rig.up`
  // in `update()` keeps the source's own `right x fwd` — a sign oddity
  // consumers were tuned against — but the view matrix needs the true
  // basis or the world renders upside down.)
  let ux = fy * rz0 - fz * ry0;
  let uy = fz * rx0 - fx * rz0;
  let uz = fx * ry0 - fy * rx0;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;

  // Roll about forward: right' = right·cos + up·sin, up' = up·cos − right·sin.
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const rx = rx0 * cr + ux * sr;
  const ry = ry0 * cr + uy * sr;
  const rz = rz0 * cr + uz * sr;
  const ux2 = ux * cr - rx0 * sr;
  const uy2 = uy * cr - ry0 * sr;
  const uz2 = uz * cr - rz0 * sr;

  const p = cam.position;
  setFrame(
   _frame, 0, p.x, p.y, p.z,
   rx, ry, rz,
   ux2, uy2, uz2,
   fx, fy, fz
  );
  invertRigid(cam.view.elements, 0, _frame, 0);

  perspectiveFovLH(cam.projection.elements, cam.fov, cam.aspect, cam.minZ, cam.maxZ);

  mulMat4(cam.viewProjection.elements, cam.projection.elements, cam.view.elements);
  invertRigid(cam.invView.elements, 0, cam.view.elements, 0);
  invertMat4(cam.invViewProjection.elements, cam.viewProjection.elements);
 }

 /** Render-size aspect; the ratio is scale-invariant. */
 _aspect() {
  const gfx = this.gfx;
  if (gfx && gfx.renderer) {
   const h = gfx.renderHeight;
   if (h > 0) return gfx.renderWidth / h;
  }
  const canvas = this.canvas;
  if (canvas && canvas.clientHeight > 0) {
   return canvas.clientWidth / canvas.clientHeight;
  }
  return 16 / 9;
 }

 /** @param {THREE.Vector3} out */
 getFlatForward(out: THREE.Vector3): THREE.Vector3 {
  out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  return out;
 }
 /** @param {THREE.Vector3} out */
 getFlatRight(out: THREE.Vector3): THREE.Vector3 {
  out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  return out;
 }
}

// ------------------------------------------------------------------ helpers

/** @param {number} cur @param {number} target @param {number} rate @param {number} dt */
export function expDamp(cur: number, target: number, rate: number, dt: number): number {
 return target + (cur - target) * Math.exp(-rate * dt);
}

// Local copies of the controller's angle helpers. Duplicated on purpose:
// controller.js imports expDamp from here, and a camera → controller import
// would close a module cycle for the sake of six lines.

/** @param {number} a @param {number} b */
function angleDelta(a: number, b: number): number {
 let d = b - a;
 while (d > Math.PI) d -= Math.PI * 2;
 while (d < -Math.PI) d += Math.PI * 2;
 return d;
}

/** @param {number} cur @param {number} target @param {number} rate @param {number} dt */
function angleDamp(cur: number, target: number, rate: number, dt: number): number {
 return cur + angleDelta(cur, target) * (1 - Math.exp(-rate * dt));
}
/**
 * Semi-implicit damped spring toward `target`, mutating `pos` and `vel`.
 * @param {THREE.Vector3} pos
 * @param {THREE.Vector3} vel
 * @param {THREE.Vector3} target
 * @param {number} freq natural frequency (rad/s-ish)
 * @param {number} damping 1 = critical
 * @param {number} dt
 */
function springDamp(pos: THREE.Vector3, vel: THREE.Vector3, target: THREE.Vector3, freq: number, damping: number, dt: number) {
 const k = freq * freq;
 const c = 2 * damping * freq;
 // Substep rather than truncate. The old clamp to 1/45 kept the integrator
 // stable but silently integrated *less* than the elapsed time below 45 fps,
 // so the arm lagged more on a slow machine and rubber-banded after every
 // hitch. Splitting the real dt into sub-1/90 steps is stable at any frame
 // rate and always advances the spring by exactly the time that passed.
 // (dt arrives capped at 0.1 s by the main loop, so n tops out at 9.)
 const n = Math.max(1, Math.ceil(dt * 90));
 const h = dt / n;
 for (let i = 0; i < n; i++) {
  vel.x += (k * (target.x - pos.x) - c * vel.x) * h;
  vel.y += (k * (target.y - pos.y) - c * vel.y) * h;
  vel.z += (k * (target.z - pos.z) - c * vel.z) * h;
  pos.x += vel.x * h;
  pos.y += vel.y * h;
  pos.z += vel.z * h;
 }
}

/** Cheap smooth 1D value noise for shake. Deterministic, no allocation. */
/** @param {number} x */
function noise1(x: number): number {
 const i = Math.floor(x);
 const f = x - i;
 const u = f * f * (3 - 2 * f);
 return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

/** @param {number} n */
function hash1(n: number): number {
 // Sinusoidal PRNG: `127.1` and `43758.5453` are the classic GLSL hash
 // coefficients — the fractional part of `sin(n * 127.1)` scaled up is a
 // cheap deterministic pseudo-random per integer n. Not units; they belong
 // to the technique and stay inline.
 const s = Math.sin(n * 127.1) * 43758.5453;
 return s - Math.floor(s);
}
