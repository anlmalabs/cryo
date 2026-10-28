/**
 * The figure — skeleton, bind pose, and the procedural locomotion that poses it.
 *
 * There is no rig file and no animation data. Everything here is solved from the
 * motion state the controller already produces. The one thing that buys has to
 * be paid for in exchange: **feet plant rather than slide**.
 *
 * Planting is not approximated. When a foot enters stance its world position is
 * recorded and then held absolutely fixed while the body travels over it; the
 * leg is solved by two-bone IK to reach that fixed point. A foot in this rig
 * cannot slide, because during stance nothing in the code is capable of moving
 * it. The gait phase itself is driven by distance travelled, not by a clock, so
 * the stride length and the ground speed are the same number by construction.
 *
 * Bone convention: a bone's local +Y runs from its own joint toward its child,
 * so a hanging arm has +Y pointing at the floor. Geometry is authored in
 * bind-pose world space and skinned by `world * inverseBind`.
 *
 * Allocation: none per frame. Everything lives in flat arrays sized at
 * construction.
 */

import type * as THREE from "three";

import { setFrameFromDir, invertRigid, mul, xformPoint } from "../core/mat4.js";
import type { CharacterController } from "./controller.js";
import { RUN_SPEED } from "./controller.js";
import { clampRange as clamp } from "../spells/bending.js";

// --------------------------------------------------------------- bone indices
export const B_ROOT = 0;
export const B_SPINE = 1;
export const B_CHEST = 2;
export const B_NECK = 3;
export const B_HEAD = 4;
export const B_HOOD = 5;
export const B_UPPER_L = 6;
export const B_FORE_L = 7;
export const B_HAND_L = 8;
export const B_UPPER_R = 9;
export const B_FORE_R = 10;
export const B_HAND_R = 11;
export const B_THIGH_L = 12;
export const B_SHIN_L = 13;
export const B_FOOT_L = 14;
export const B_THIGH_R = 15;
export const B_SHIN_R = 16;
export const B_FOOT_R = 17;
export const BONE_COUNT = 18;

/**
 * Bind pose, nine floats per bone: joint position, bone direction, front
 * reference. A 1.79 m figure with the pelvis at 0.95 — deliberately a little
 * long in the leg and narrow in the shoulder, because the silhouette is read at
 * fifteen metres through a robe and slightly heroic proportions survive that
 * better than accurate ones.
 */
const BIND = new Float32Array([
    /* ROOT    */ 0, 0.95, 0, 0, 1, 0, 0, 0, 1,
    /* SPINE   */ 0, 1.06, 0, 0, 1, 0, 0, 0, 1,
    /* CHEST   */ 0, 1.26, 0, 0, 1, 0, 0, 0, 1,
    /* NECK    */ 0, 1.46, 0, 0, 1, 0, 0, 0, 1,
    /* HEAD    */ 0, 1.55, 0, 0, 1, 0, 0, 0, 1,
    /* HOOD    */ 0, 1.55, 0, 0, 1, 0, 0, 0, 1,

    /* UPPER_L */ -0.185, 1.400, 0.000, -0.16, -0.987, 0, 0, 0, 1,
    /* FORE_L  */ -0.230, 1.123, 0.000, -0.05, -0.997, 0.06, 0, 0, 1,
    /* HAND_L  */ -0.243, 0.866, 0.016, -0.02, -0.992, 0.12, 0, 0, 1,
    /* UPPER_R */ 0.185, 1.400, 0.000, 0.16, -0.987, 0, 0, 0, 1,
    /* FORE_R  */ 0.230, 1.123, 0.000, 0.05, -0.997, 0.06, 0, 0, 1,
    /* HAND_R  */ 0.243, 0.866, 0.016, 0.02, -0.992, 0.12, 0, 0, 1,

    /* THIGH_L */ -0.100, 0.900, 0, 0, -1, 0, 0, 0, 1,
    /* SHIN_L  */ -0.100, 0.460, 0, 0, -1, 0, 0, 0, 1,
    /* FOOT_L  */ -0.100, 0.090, 0, 0, 0, 1, 0, 1, 0,
    /* THIGH_R */ 0.100, 0.900, 0, 0, -1, 0, 0, 0, 1,
    /* SHIN_R  */ 0.100, 0.460, 0, 0, -1, 0, 0, 0, 1,
    /* FOOT_R  */ 0.100, 0.090, 0, 0, 0, 1, 0, 1, 0,
]);

/** Segment lengths implied by the bind table, metres. */
const THIGH_LEN = 0.44;
const SHIN_LEN = 0.37;
const UPPER_LEN = 0.28;
const FORE_LEN = 0.26;

/** Pelvis height above the feet in the bind pose. */
const HIP_HEIGHT = 0.95;

// ------------------------------------------------------------- terrain contract
/**
 * Everything the locomotion needs from the terrain: a height to stand on and
 * the surface normal under a point. Narrow rather than the real `Terrain`
 * class, so the figure can be posed against anything that answers both.
 */
export interface TerrainLike {
 /** World height at the terrain surface above (x, z), metres. */
 heightAt(x: number, z: number): number;
 /** Unit surface normal at (x, z), written into `out` and returned. */
 normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
}

// --------------------------------------------------------- locomotion tuning
/** Largest integration step the pose is advanced by, seconds (1/30 s). */
const MAX_STEP = 1 / 30;

/* ------------------------------------------------------------- damp rates
 * Exponential approach rate for each eased pose value, 1/s. Larger is snappier.
 */
/** Torso pitch onto the run lean, 1/s. */
const RATE_PITCH = 7;
/** Torso roll onto the lean, 1/s. */
const RATE_ROLL = 8;
/** Pelvis bob, 1/s. */
const RATE_BOB = 18;
/** Pelvis height (crouch), 1/s. */
const RATE_HIP = 9;
/** Snow settle, 1/s. */
const RATE_SINK = 4;
/** Head pitch, 1/s. */
const RATE_HEAD_PITCH = 9;
/** Head yaw, 1/s. */
const RATE_HEAD_YAW = 6;
/** Hood yaw, 1/s. Slower than the head, which is the lag. */
const RATE_HOOD_YAW = 11;
/** Hood pitch, 1/s. */
const RATE_HOOD_PITCH = 9;

/** How far forward the torso leans at a sprint, radians. */
const RUN_LEAN = 0.10;
/** Pitch added per m/s^2 of forward acceleration, radians per m/s^2. */
const LEAN_PER_ACCEL = 0.012;
/** Forward acceleration clamped to this floor before leaning, m/s². */
const LEAN_ACCEL_MIN = -9;
/** Forward acceleration clamped to this ceiling before leaning, m/s². */
const LEAN_ACCEL_MAX = 22;
/** Pitch lean onto the board, radians. */
const SURF_LEAN = 0.30;
/** Extra board lean at full surf speed, radians. */
const SURF_LEAN_SPEED01 = 0.16;
/** Torso roll per unit controller lean, radians. */
const ROLL_PER_LEAN = 0.16;
/** Extra torso roll on the board, radians. */
const ROLL_SURF = 0.34;

/** Pelvis drop at the bottom of a stance, metres. */
const BOB_DEPTH = 0.028;
/** Bob completes this many cycles per stride: one per footfall, so two. */
const BOB_CYCLES = 4;

/** Pelvis drop at a sprint, metres. */
const CROUCH_RUN = 0.035;
/** Pelvis drop on the board, metres. */
const CROUCH_SURF = 0.13;
/** Extra board crouch at full surf speed, metres. */
const CROUCH_SURF_SPEED01 = 0.05;

/** Snow the figure settles into while standing, metres. */
const SINK_IDLE = 0.045;
/** Extra snow it settles into while surfing, metres. */
const SINK_SURF = 0.055;

/** Twist and arm swing complete this many cycles per stride, so two. */
const GAIT_CYCLES = 2;
/** Pelvis counter-rotation against the shoulders at a sprint, radians. */
const TWIST_RUN = 0.13;
/** Chest twists this multiple of the pelvis twist, opposite sign. */
const CHEST_TWIST = -1.5;
/** Chest leans further forward than the pelvis by this, radians. */
const CHEST_PITCH_RUN = 0.05;
/** Extra chest pitch on the board, radians. */
const CHEST_PITCH_SURF = 0.10;
/** Chest rolls this multiple of the torso roll. */
const CHEST_ROLL = 1.15;

/** Head holds only this fraction of the chest's pitch, unitless ratio. */
const HEAD_STABILISE = 0.62;
/** Head eases up on the board by this, radians. */
const HEAD_LIFT_SURF = 0.10;
/** Head yaw per unit controller lean, radians. */
const HEAD_YAW_PER_LEAN = -0.22;
/** Head rolls this fraction of the torso roll. */
const HEAD_ROLL = 0.5;
/** Hood trails the head with this extra pitch, radians. */
const HOOD_LAG_PITCH = 0.05;

/** Vertical lift of the spine joint above the pelvis, metres. */
const SPINE_RISE = 0.11;
/** Vertical lift of the chest joint above the pelvis, metres. */
const CHEST_RISE = 0.31;
/** Vertical lift of the neck joint above the chest, metres. */
const NECK_RISE = 0.20;
/** Vertical lift of the head joint above the neck, metres. */
const HEAD_RISE = 0.09;

/** Vertical distance from the ankle to the sole, metres. */
const ANKLE_HEIGHT = 0.09;

/** Reach safety factor: the IK target is pulled this far inside full reach. */
const IK_REACH_FACTOR = 0.995;
/** Distance below which a two-bone target is treated as coincident, metres. */
const IK_DEGENERATE_DIST = 1e-4;
/** Pole length below which a directionless pole is replaced, metres. */
const IK_DEGENERATE_POLE = 1e-5;

/** How close the eased foot weight gets to its target each second, 1/s. */
const WEIGHT_RATE = 22;
/** Smoothing rate of a planted foot while standing still, 1/s. */
const PLANT_RATE = 7;

/** Ground speed above which the gait actually advances, m/s. */
const MOVING_EPS = 0.2;

/** Fraction of the gait cycle a foot is down: a walk plants for 0.66. */
const DUTY_WALK = 0.66;
/** Duty factor lost over the walk-to-run transition. */
const DUTY_RUN = 0.20;

/** Half a stride ahead of the body at rest, metres. */
const STEP_MIN = 0.34;
/** Extra half-stride at a sprint, metres. */
const STEP_RUN = 0.42;

/** Peak swing-arc height of a foot above its target, metres. */
const SWING_LIFT = 0.055;
/** Extra swing-lift at a sprint, metres. */
const SWING_LIFT_RUN = 0.12;

/** Lateral offset of a foot from the body's centre line, metres. */
const FOOT_OFFSET = 0.105;
/** Lateral offset of the surf feet across the board, metres. */
const FOOT_SURF_LATERAL = 0.17;
/** Fore/aft offset of the surf feet along the body, metres. */
const FOOT_SURF_ALONG = 0.11;
/**
 * Surf blend floor: below this the feet are not touched at all, so a finished
 * run-out does not pay for two interpolations per frame.
 */
const SURF_BLEND_EPS = 0.001;
/** Surf feet ease back under the hips by this much, metres. */
const STAND_FOOT_FWD = 0.02;
/** Vertical sink of a planted foot while the body travels over it, ratio. */
const PLANT_SINK = 0.7;

/** How far the toe drops through a swing, radians at full swing. */
const TOE_DOWN = 0.55;

/** Knee pole tilts outward from the sagittal plane, metres. */
const KNEE_POLE = 0.22;
/** Lateral offset of a hip joint from the body's centre line, metres. */
const HIP_SPREAD = 0.10;
/** Vertical drop of the hip joint below the pelvis, metres. */
const HIP_DROP = 0.05;

/** Vertical drop of the idle walking hand target below the shoulder, metres. */
const ARM_SWING_DOWN = 0.43;
/** Fore/aft amplitude of a swinging hand at a sprint, metres. */
const ARM_SWING_RUN = 0.38;
/** Fore/aft amplitude of a swinging hand standing still, metres. */
const ARM_SWING_IDLE = 0.20;
/** Swing amplitude added at a sprint, metres. */
const ARM_SWING_PEAK = 0.42;
/** Lateral offset of a hand from the shoulder line, metres. */
const ARM_SIDE = 0.11;
/** Idle arm drift amplitude, slow, radians. */
const ARM_IDLE_SLOW = 0.02;
/** Idle arm drift frequency, slow, rad/s. */
const ARM_IDLE_SLOW_RATE = 0.9;
/** Idle arm drift amplitude, fast, radians. */
const ARM_IDLE_FAST = 0.012;
/** Idle arm drift frequency, fast, rad/s. */
const ARM_IDLE_FAST_RATE = 1.7;
/** Phase offset of the fast idle drift, radians. */
const ARM_IDLE_FAST_PHASE = 1.3;

/** Lateral offset of a shoulder from the chest's centre line, metres. */
const SHOULDER_OFFSET = 0.185;
/** Vertical drop of a shoulder joint below the chest, metres. */
const SHOULDER_DROP = 0.14;

/** Leading (right) hand reaches this far along the cast aim, metres. */
const CAST_LEAD_ALONG = 0.52;
/** Leading hand lifts this far above the shoulder, metres. */
const CAST_LEAD_LIFT = 0.26;
/** Trailing hand reaches this far along the cast aim, metres. */
const CAST_TRAIL_ALONG = 0.16;
/** Trailing hand sits this far above the shoulder, metres. */
const CAST_TRAIL_LIFT = 0.02;
/** Leading hand swings outward from the shoulder line, metres. */
const CAST_LEAD_OUT = 0.30;
/** Trailing hand draws inward across the body, metres. */
const CAST_TRAIL_OUT = -0.16;
/** Extra shoulder splay during a cast, metres. */
const CAST_SPLAY = 0.30;
/** Secondary lift applied to the cast target, metres. */
const CAST_TARGET_UP = 0.6;

/** Surf hands sit this far out from the shoulder line, metres. */
const SURF_ARM_OUT = 0.33;
/** Surf hands reach this far forward, metres. */
const SURF_ARM_FWD = 0.24;
/** Surf hand rise for the trailing arm, radians. */
const SURF_ARM_RISE = 0.02;
/** Surf hand rise added per unit carve, radians. */
const SURF_ARM_CARVE = 0.22;

/** Elbow pole tilts outward from the body's front axis, metres. */
const ELBOW_POLE = 0.55;
/** Elbows hang this far below the shoulder line, metres. */
const ELBOW_DROP = 0.35;

/** Local offset of a hand from its forearm joint, metres. */
const HAND_OFFSET = 0.09;

// ------------------------------------------------------- module-scope scratch
const _axes = new Float32Array(9);   // X, Y, Z of a composed basis
const _p = new Float32Array(3);
const _knee = new Float32Array(3);
const _hip = new Float32Array(3);
const _sh = new Float32Array(3);

/**
 * Compose an orthonormal basis from yaw, then pitch about its own right axis,
 * then roll about its own forward axis. Writes X, Y, Z into `_axes`.
 *
 * Positive pitch leans forward, positive roll tips the head to the character's
 * right — which is the sign the controller's `lean` already uses.
 */
/**
 * @param {number} yaw
 * @param {number} pitch
 * @param {number} roll
 */
function composeBasis(yaw: number, pitch: number, roll: number): void {
 const cy = Math.cos(yaw), sy = Math.sin(yaw);
 let xx = cy, xy = 0, xz = -sy;
 let yx = 0, yy = 1, yz = 0;
 let zx = sy, zy = 0, zz = cy;

 if (pitch !== 0) {
  const c = Math.cos(pitch), s = Math.sin(pitch);
  const nyx = yx * c + zx * s, nyy = yy * c + zy * s, nyz = yz * c + zz * s;
  const nzx = zx * c - yx * s, nzy = zy * c - yy * s, nzz = zz * c - yz * s;
  yx = nyx; yy = nyy; yz = nyz; zx = nzx; zy = nzy; zz = nzz;
 }
 if (roll !== 0) {
  const c = Math.cos(roll), s = Math.sin(roll);
  const nxx = xx * c - yx * s, nxy = xy * c - yy * s, nxz = xz * c - yz * s;
  const nyx = yx * c + xx * s, nyy = yy * c + xy * s, nyz = yz * c + xz * s;
  xx = nxx; xy = nxy; xz = nxz; yx = nyx; yy = nyy; yz = nyz;
 }

 _axes[0] = xx; _axes[1] = xy; _axes[2] = xz;
 _axes[3] = yx; _axes[4] = yy; _axes[5] = yz;
 _axes[6] = zx; _axes[7] = zy; _axes[8] = zz;
}

/**
 * Two-bone IK. Given a root joint, an end target and a pole direction, writes
 * the middle joint's world position into `out`.
 *
 * The target is pulled inside reach rather than clamped at it: a fully extended
 * leg reads as a stiff peg, and the last centimetre of reach is where all the
 * knee-lock artefacts live.
 */
/**
 * @param {number} rx
 * @param {number} ry
 * @param {number} rz
 * @param {number} tx
 * @param {number} ty
 * @param {number} tz
 * @param {number} px
 * @param {number} py
 * @param {number} pz
 * @param {number} l1
 * @param {number} l2
 * @param {Float32Array} out
 */
function solveTwoBone(
 rx: number, ry: number, rz: number, tx: number, ty: number, tz: number,
 px: number, py: number, pz: number, l1: number, l2: number, out: Float32Array
): void {
 let dx = tx - rx, dy = ty - ry, dz = tz - rz;
 let dist = Math.hypot(dx, dy, dz);
 const maxReach = (l1 + l2) * IK_REACH_FACTOR;
 if (dist < IK_DEGENERATE_DIST) { dx = 0; dy = -1; dz = 0; dist = IK_DEGENERATE_DIST; }
 if (dist > maxReach) dist = maxReach;
 const inv = 1 / Math.hypot(dx, dy, dz);
 dx *= inv; dy *= inv; dz *= inv;

 // Cosine rule: how far along the root→target axis the middle joint projects.
 // The divisor is 2·dist, the law's own coefficient — not a tunable.
 const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
 const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

 // Pole, orthogonalised against the axis — this is what decides which way the
 // knee or elbow bends, and it has to be re-derived every frame because the
 // axis swings through it during a stride.
 const d = px * dx + py * dy + pz * dz;
 let ox = px - dx * d, oy = py - dy * d, oz = pz - dz * d;
 let ol = Math.hypot(ox, oy, oz);
 if (ol < IK_DEGENERATE_POLE) { ox = 0; oy = 0; oz = 1; ol = 1; }
 ox /= ol; oy /= ol; oz /= ol;

 out[0] = rx + dx * a + ox * h;
 out[1] = ry + dy * a + oy * h;
 out[2] = rz + dz * a + oz * h;
}

/** Framerate-independent exponential approach. */
/**
 * @param {number} cur
 * @param {number} target
 * @param {number} rate
 * @param {number} dt
 */
function damp(cur: number, target: number, rate: number, dt: number): number {
 return target + (cur - target) * Math.exp(-rate * dt);
}

export class Figure {
 /** Height field and normals the skeleton stands on. */
 terrain: TerrainLike;
 /** World matrix per bone. */
 world: Float32Array;
 /** Bind-pose world matrix per bone. */
 bind: Float32Array;
 /** Inverse of the above. */
 invBind: Float32Array;
 /** `world * invBind` — the matrix geometry is actually skinned by. */
 skin: Float32Array;
 /** World joint positions, three floats per bone. Cloth collision reads these. */
 joint: Float32Array;

 /** Where each foot is planted, world. Frozen for the whole stance phase. */
 plant: Float32Array;
 /** Live foot position (equals `plant` during stance). */
 footPos: Float32Array;
 /** Ground normal under each planted foot. */
 footNormal: Float32Array;
 /** 1 while the foot carries weight, 0 mid-swing. Eased. */
 footWeight: Float32Array;
 /** True while each foot is down, so touchdown can be told from a hold. */
 _wasStance: boolean[];
 /** Set for one frame when a foot touches down. Drives spray and splats. */
 touchdown: boolean[];

 /** Pelvis height above the ankles, metres. */
 hipY: number;
 /** Torso pitch, radians. */
 pitch: number;
 /** Torso roll, radians. */
 roll: number;
 /** Vertical pelvis bob this frame, metres. */
 bob: number;
 /** Head yaw relative to the chest, radians. */
 headYaw: number;
 /** Head pitch relative to the chest, radians. */
 headPitch: number;
 /** Hood yaw, eased. Radians. */
 hoodYaw: number;
 /** Hood pitch, eased. Radians. */
 hoodPitch: number;
 /** Arm phase accumulator for the idle drift. */
 armPhase: number;
 /** How far the figure has settled into the snow, metres. */
 sink: number;
 /** Seconds of pose accumulated since construction. */
 _t: number;
 /** Gait phase at the previous frame, for footfall edge detection. */
 _prevGait: number;

 /**
  * @param {TerrainLike} terrain
  */
 constructor(terrain: TerrainLike) {
  this.terrain = terrain;

  /** World matrix per bone. */
  this.world = new Float32Array(BONE_COUNT * 16);
  /** Bind-pose world matrix per bone. */
  this.bind = new Float32Array(BONE_COUNT * 16);
  /** Inverse of the above. */
  this.invBind = new Float32Array(BONE_COUNT * 16);
  /** `world * invBind` — the matrix geometry is actually skinned by. */
  this.skin = new Float32Array(BONE_COUNT * 16);

  /** World joint positions, three floats per bone. Cloth collision reads these. */
  this.joint = new Float32Array(BONE_COUNT * 3);

  for (let b = 0; b < BONE_COUNT; b++) {
   const o = b * 9;
   setFrameFromDir(
    this.bind, b * 16,
    BIND[o], BIND[o + 1], BIND[o + 2],
    BIND[o + 3], BIND[o + 4], BIND[o + 5],
    BIND[o + 6], BIND[o + 7], BIND[o + 8]
   );
   invertRigid(this.invBind, b * 16, this.bind, b * 16);
  }

  // ------------------------------------------------------------- gait
  /** Where each foot is planted, world. Frozen for the whole stance phase. */
  this.plant = new Float32Array(6);
  /** Live foot position (equals `plant` during stance). */
  this.footPos = new Float32Array(6);
  /** Ground normal under each planted foot. */
  this.footNormal = new Float32Array([0, 1, 0, 0, 1, 0]);
  /** 1 while the foot carries weight, 0 mid-swing. Eased. */
  this.footWeight = new Float32Array([1, 1]);
  this._wasStance = [true, true];
  /** Set for one frame when a foot touches down. Drives spray and splats. */
  this.touchdown = [false, false];

  // ------------------------------------------------- smoothed pose state
  this.hipY = HIP_HEIGHT;
  this.pitch = 0;
  this.roll = 0;
  this.bob = 0;
  this.headYaw = 0;
  this.headPitch = 0;
  this.hoodYaw = 0;
  this.hoodPitch = 0;
  this.armPhase = 0;
  /** How far the figure has settled into the snow, metres. */
  this.sink = 0.04;

  this._t = 0;
  this._prevGait = 0;
 }

 /**
  * Pose the skeleton for this frame.
  * @param {number} dt
  * @param {CharacterController} ch
  */
 update(dt: number, ch: CharacterController): void {
  const h = Math.min(dt, MAX_STEP);
  this._t += h;

  const surf = ch.surf;
  const speed = ch.speed;
  const run = Math.min(1, speed / RUN_SPEED);

  // ---------------------------------------------------------- footfalls
  // Stance/swing is derived from the same distance-driven phase the
  // controller uses to fire footfall events, so the visual plant and the
  // snow splat are the same instant by construction.
  this._updateFeet(h, ch);

  // -------------------------------------------------------- body attitude
  // Lean forward with speed, and *into* acceleration — the classic read
  // that a figure is pushing rather than being dragged.
  const fwdAcc =
   ch.acceleration.x * Math.sin(ch.facing) + ch.acceleration.z * Math.cos(ch.facing);
  // Clamped, because the accelerations at either end of a surf run are an
  // order of magnitude larger than anything walking produces: letting go at
  // top speed decelerates at 30 m/s^2, which unclamped throws the torso
  // twenty degrees backwards and reads as a fall rather than as a scrub.
  const fwdVel = ch.velocity.x * Math.sin(ch.facing) + ch.velocity.z * Math.cos(ch.facing);
  const runLeanSign = fwdVel >= 0 ? 1 : -1;
  const pitchWant =
   RUN_LEAN * run * runLeanSign
   + LEAN_PER_ACCEL * clamp(fwdAcc, LEAN_ACCEL_MIN, LEAN_ACCEL_MAX)
   + surf * (SURF_LEAN + SURF_LEAN_SPEED01 * ch.speed01);
  this.pitch = damp(this.pitch, pitchWant, RATE_PITCH, h);

  const rollWant = ch.lean * (ROLL_PER_LEAN + ROLL_SURF * surf);
  this.roll = damp(this.roll, rollWant, RATE_ROLL, h);

  // Vertical bob: the pelvis drops through each stance and rises over the
  // supporting leg, twice per stride. Suppressed while surfing, where the
  // stance is a static crouch.
  const bobWant =
   (1 - surf) * (-BOB_DEPTH * run * (0.5 - 0.5 * Math.cos(BOB_CYCLES * Math.PI * ch.gaitPhase)));
  this.bob = damp(this.bob, bobWant, RATE_BOB, h);

  // Crouch: a little at running speed, a lot on the board.
  const crouch = CROUCH_RUN * run + surf * (CROUCH_SURF + CROUCH_SURF_SPEED01 * ch.speed01);
  this.hipY = damp(this.hipY, HIP_HEIGHT - crouch, RATE_HIP, h);

  // The figure settles into the snow it is standing on. Reading the real
  // depth would mean a GPU readback; this is the same number the contact
  // brushes are writing, held on the CPU.
  this.sink = damp(this.sink, SINK_IDLE + surf * SINK_SURF, RATE_SINK, h);

  // ------------------------------------------------------------- spine
  const gx = ch.position.x;
  const gz = ch.position.z;
  const groundY = this.terrain.heightAt(gx, gz);

  const rootY = groundY - this.sink + this.hipY + this.bob;

  composeBasis(ch.facing, this.pitch, this.roll);
  const rX = _axes[0], rY = _axes[1], rZ = _axes[2];
  const uX = _axes[3], uY = _axes[4], uZ = _axes[5];
  const fX = _axes[6], fY = _axes[7], fZ = _axes[8];

  // Pelvis. Its yaw counter-rotates against the shoulders during a stride,
  // which is most of what stops a procedural walk reading as a shop dummy.
  const twist = (1 - surf) * TWIST_RUN * run * Math.sin(GAIT_CYCLES * Math.PI * ch.gaitPhase);
  composeBasis(ch.facing + twist, this.pitch, this.roll);
  this._setBone(B_ROOT, gx, rootY, gz, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

  // Spine and chest lift along the pelvis up-axis, with the chest twisting
  // the opposite way and leaning a little further forward.
  const spineY = rootY + uY * SPINE_RISE;
  this._setBone(
   B_SPINE, gx + uX * SPINE_RISE, spineY, gz + uZ * SPINE_RISE,
   uX, uY, uZ, fX, fY, fZ
  );

  const chestTwist = twist * CHEST_TWIST;
  const chestPitch = this.pitch + CHEST_PITCH_RUN * run + surf * CHEST_PITCH_SURF;
  composeBasis(ch.facing + chestTwist, chestPitch, this.roll * CHEST_ROLL);
  const cUx = _axes[3], cUy = _axes[4], cUz = _axes[5];
  const cFx = _axes[6], cFy = _axes[7], cFz = _axes[8];
  const cRx = _axes[0], cRy = _axes[1], cRz = _axes[2];

  const chestX = gx + uX * CHEST_RISE, chestY = rootY + uY * CHEST_RISE, chestZ = gz + uZ * CHEST_RISE;
  this._setBone(B_CHEST, chestX, chestY, chestZ, cUx, cUy, cUz, cFx, cFy, cFz);

  const neckX = chestX + cUx * NECK_RISE, neckY = chestY + cUy * NECK_RISE, neckZ = chestZ + cUz * NECK_RISE;
  this._setBone(B_NECK, neckX, neckY, neckZ, cUx, cUy, cUz, cFx, cFy, cFz);

  // ------------------------------------------------------------- head
  // Head stabilisation: the head stays much closer to level than the chest
  // it sits on. Real necks do this and it is very obvious when missing.
  this.headPitch = damp(this.headPitch, -chestPitch * HEAD_STABILISE + surf * HEAD_LIFT_SURF, RATE_HEAD_PITCH, h);
  this.headYaw = damp(this.headYaw, ch.lean * HEAD_YAW_PER_LEAN, RATE_HEAD_YAW, h);
  composeBasis(ch.facing + chestTwist + this.headYaw, chestPitch + this.headPitch, this.roll * HEAD_ROLL);
  const headX = neckX + cUx * HEAD_RISE, headY = neckY + cUy * HEAD_RISE, headZ = neckZ + cUz * HEAD_RISE;
  this._setBone(B_HEAD, headX, headY, headZ, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

  // The hood is a lagged copy. A hood that tracks the skull exactly reads
  // as a helmet; a few frames of lag reads as fabric.
  this.hoodYaw = damp(this.hoodYaw, ch.facing + chestTwist + this.headYaw, RATE_HOOD_YAW, h);
  this.hoodPitch = damp(this.hoodPitch, chestPitch + this.headPitch + HOOD_LAG_PITCH, RATE_HOOD_PITCH, h);
  composeBasis(this.hoodYaw, this.hoodPitch, this.roll * HEAD_ROLL);
  this._setBone(B_HOOD, headX, headY, headZ, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

  // -------------------------------------------------------------- arms
  this._poseArms(h, ch, chestX, chestY, chestZ, cRx, cRy, cRz, cUx, cUy, cUz, cFx, cFy, cFz);

  // -------------------------------------------------------------- legs
  this._poseLeg(0, gx, rootY, gz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ);
  this._poseLeg(1, gx, rootY, gz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ);

  // ------------------------------------------------------------- skin
  for (let b = 0; b < BONE_COUNT; b++) {
   mul(this.skin, b * 16, this.world, b * 16, this.invBind, b * 16);
   this.joint[b * 3] = this.world[b * 16 + 12];
   this.joint[b * 3 + 1] = this.world[b * 16 + 13];
   this.joint[b * 3 + 2] = this.world[b * 16 + 14];
  }
 }

 /**
  * @param {number} b
  * @param {number} px
  * @param {number} py
  * @param {number} pz
  * @param {number} yx
  * @param {number} yy
  * @param {number} yz
  * @param {number} zx
  * @param {number} zy
  * @param {number} zz
  */
 _setBone(
  b: number, px: number, py: number, pz: number,
  yx: number, yy: number, yz: number, zx: number, zy: number, zz: number
 ): void {
  // X = Y x Z, completing the frame from the bone axis and its front
  // reference. Both are already orthonormal at every call site.
  setFrameFromDir(this.world, b * 16, px, py, pz, yx, yy, yz, zx, zy, zz);
 }

 /**
  * Advance the stance/swing state machine and place both ankles.
  *
  * Stance is the whole point. `plant` is written exactly once, on touchdown,
  * and read unchanged for the rest of the stance — so no amount of body
  * motion, camera motion or frame-rate variation can move a planted foot.
  */
 /**
  * @param {number} h
  * @param {CharacterController} ch
  */
 _updateFeet(h: number, ch: CharacterController): void {
  const surf = ch.surf;
  const speed = ch.speed;
  const run = Math.min(1, speed / RUN_SPEED);
  // Duty factor: a walk keeps both feet down for a moment, a run has a
  // flight phase. Interpolating between them is what makes the transition
  // from walk to run read as a gait change and not a speed change.
  const duty = DUTY_WALK - DUTY_RUN * run;

  // Feet plant along the direction of travel, not the facing: when backing
  // up or strafing the steps must land behind/side of the body instead of
  // ahead of it, otherwise the legs cross over and the gait reads as broken.
  const travelSpeed = Math.hypot(ch.velocity.x, ch.velocity.z);
  let tvx: number, tvz: number;
  if (travelSpeed > 1e-3) {
   tvx = ch.velocity.x / travelSpeed;
   tvz = ch.velocity.z / travelSpeed;
  } else {
   tvx = Math.sin(ch.facing);
   tvz = Math.cos(ch.facing);
  }
  const fwdX = tvx, fwdZ = tvz;
  const rgtX = tvz, rgtZ = -tvx;

  // Half a stride ahead, scaled by speed — this is the step length, and it
  // has to match the controller's stride or the feet skate.
  const half = STEP_MIN + STEP_RUN * run;
  // The controller owns this decision — see `stepping` there. Re-deriving
  // it from `surf` here is how the feet and the footprints end up
  // disagreeing about whether the character is walking.
  const moving = speed > MOVING_EPS && ch.stepping;

  for (let f = 0; f < 2; f++) {
   const side = f === 0 ? -FOOT_OFFSET : FOOT_OFFSET;
   // Left foot leads; the right is half a cycle behind.
   const ph = (ch.gaitPhase + (f === 0 ? 0 : 0.5)) % 1;
   const stance = !moving || ph < duty;

   // Where this foot would land if it touched down right now.
   const nx = ch.position.x + fwdX * half + rgtX * side;
   const nz = ch.position.z + fwdZ * half + rgtZ * side;

   if (stance) {
    if (!this._wasStance[f]) {
     // Touchdown. This is the only line in the file that writes a
     // plant position.
     this.plant[f * 3] = nx;
     this.plant[f * 3 + 1] = this.terrain.heightAt(nx, nz) - this.sink * PLANT_SINK;
     this.plant[f * 3 + 2] = nz;
     this.touchdown[f] = true;
    } else {
     this.touchdown[f] = false;
    }
    if (!moving) {
     // Standing: ease the feet back under the hips rather than
     // leaving them wherever the last stride dropped them.
     const sx = ch.position.x + rgtX * side + fwdX * STAND_FOOT_FWD;
     const sz = ch.position.z + rgtZ * side + fwdZ * STAND_FOOT_FWD;
     this.plant[f * 3] = damp(this.plant[f * 3], sx, PLANT_RATE, h);
     this.plant[f * 3 + 2] = damp(this.plant[f * 3 + 2], sz, PLANT_RATE, h);
     this.plant[f * 3 + 1] = damp(
      this.plant[f * 3 + 1],
      this.terrain.heightAt(this.plant[f * 3], this.plant[f * 3 + 2]) - this.sink * PLANT_SINK,
      PLANT_RATE, h
     );
    }
    this.footPos[f * 3] = this.plant[f * 3];
    this.footPos[f * 3 + 1] = this.plant[f * 3 + 1];
    this.footPos[f * 3 + 2] = this.plant[f * 3 + 2];
    this.footWeight[f] = damp(this.footWeight[f], 1, WEIGHT_RATE, h);
   } else {
    this.touchdown[f] = false;
    // Swing: from the plant it is leaving to the plant it is heading
    // for, on an arc. `nx/nz` keeps updating as the body moves, so
    // the foot is always aimed at where the body will actually be.
    const s = (ph - duty) / (1 - duty);
    const e = s * s * (3 - 2 * s);
    const ny = this.terrain.heightAt(nx, nz) - this.sink * PLANT_SINK;
    const px = this.plant[f * 3], py = this.plant[f * 3 + 1], pz = this.plant[f * 3 + 2];
    this.footPos[f * 3] = px + (nx - px) * e;
    this.footPos[f * 3 + 2] = pz + (nz - pz) * e;
    this.footPos[f * 3 + 1] =
     py + (ny - py) * e + Math.sin(Math.PI * s) * (SWING_LIFT + SWING_LIFT_RUN * run);
    this.footWeight[f] = damp(this.footWeight[f], 0, WEIGHT_RATE, h);
   }

   this._wasStance[f] = stance;
  }

  // Surfing: both feet ride the board, offset along the body's long axis
  // and rotated across the direction of travel. Blended in, never snapped.
  if (surf > SURF_BLEND_EPS) {
   for (let f = 0; f < 2; f++) {
    // Wide and staggered: feet apart across the direction of travel
    // for lateral stability, with the leading foot a little ahead.
    const lateral = f === 0 ? -FOOT_SURF_LATERAL : FOOT_SURF_LATERAL;
    const along = f === 0 ? FOOT_SURF_ALONG : -FOOT_SURF_ALONG;
    const sx = ch.position.x + fwdX * along + rgtX * lateral;
    const sz = ch.position.z + fwdZ * along + rgtZ * lateral;
    const sy = this.terrain.heightAt(sx, sz) - this.sink;
    const o = f * 3;
    this.footPos[o] += (sx - this.footPos[o]) * surf;
    this.footPos[o + 1] += (sy - this.footPos[o + 1]) * surf;
    this.footPos[o + 2] += (sz - this.footPos[o + 2]) * surf;
    this.footWeight[f] = Math.max(this.footWeight[f], surf);
   }
  }
 }

 /**
  * Solve one leg. `f` is 0 for left, 1 for right.
  *
  * The knee pole tilts outward as well as forward, because a knee that bends
  * in a perfectly sagittal plane looks mechanical — real legs track slightly
  * wide of the hip.
  */
 /**
  * @param {number} f
  * @param {number} rootX
  * @param {number} rootY
  * @param {number} rootZ
  * @param {number} rX
  * @param {number} rY
  * @param {number} rZ
  * @param {number} uX
  * @param {number} uY
  * @param {number} uZ
  * @param {number} fX
  * @param {number} fY
  * @param {number} fZ
  */
 _poseLeg(
  f: number, rootX: number, rootY: number, rootZ: number,
  rX: number, rY: number, rZ: number,
  uX: number, uY: number, uZ: number,
  fX: number, fY: number, fZ: number
 ): void {
  const side = f === 0 ? -HIP_SPREAD : HIP_SPREAD;
  const hipB = f === 0 ? B_THIGH_L : B_THIGH_R;
  const shinB = f === 0 ? B_SHIN_L : B_SHIN_R;
  const footB = f === 0 ? B_FOOT_L : B_FOOT_R;

  // Hip joint, carried by the pelvis frame.
  _hip[0] = rootX + rX * side - uX * HIP_DROP;
  _hip[1] = rootY + rY * side - uY * HIP_DROP;
  _hip[2] = rootZ + rZ * side - uZ * HIP_DROP;

  const ax = this.footPos[f * 3];
  const ay = this.footPos[f * 3 + 1] + ANKLE_HEIGHT; // ankle sits above the sole
  const az = this.footPos[f * 3 + 2];

  const outward = f === 0 ? -KNEE_POLE : KNEE_POLE;
  solveTwoBone(
   _hip[0], _hip[1], _hip[2], ax, ay, az,
   fX + rX * outward, fY + rY * outward, fZ + rZ * outward,
   THIGH_LEN, SHIN_LEN, _knee
  );

  this._setBone(
   hipB, _hip[0], _hip[1], _hip[2],
   _knee[0] - _hip[0], _knee[1] - _hip[1], _knee[2] - _hip[2],
   fX, fY, fZ
  );
  this._setBone(
   shinB, _knee[0], _knee[1], _knee[2],
   ax - _knee[0], ay - _knee[1], az - _knee[2],
   fX, fY, fZ
  );

  // The foot rolls: flat while loaded, toe-down through the swing. The
  // ground normal is folded in so a foot on a dune face lies along it.
  const w = this.footWeight[f];
  const toeDown = (1 - w) * TOE_DOWN;
  const c = Math.cos(toeDown), s = Math.sin(toeDown);
  // Rotate the foot's forward axis down about the body's right axis.
  const dx = fX * c - uX * s, dy = fY * c - uY * s, dz = fZ * c - uZ * s;
  this._setBone(footB, ax, ay, az, dx, dy, dz, uX, uY, uZ);
 }

 /**
  * Arms. Counter-swing against the legs while walking, and a wide, low
  * bending stance while surfing — hands out and forward, which is the
  * Water Tribe pose in the reference and also just what a person does at
  * twenty metres a second.
  */
 /**
  * @param {number} h
  * @param {CharacterController} ch
  * @param {number} cx
  * @param {number} cy
  * @param {number} cz
  * @param {number} rX
  * @param {number} rY
  * @param {number} rZ
  * @param {number} uX
  * @param {number} uY
  * @param {number} uZ
  * @param {number} fX
  * @param {number} fY
  * @param {number} fZ
  */
 _poseArms(
  h: number, ch: CharacterController,
  cx: number, cy: number, cz: number,
  rX: number, rY: number, rZ: number,
  uX: number, uY: number, uZ: number,
  fX: number, fY: number, fZ: number
 ): void {
  const surf = ch.surf;
  const run = Math.min(1, ch.speed / RUN_SPEED);
  const swing = Math.sin(GAIT_CYCLES * Math.PI * ch.gaitPhase)
   * (ARM_SWING_IDLE + ARM_SWING_PEAK * run) * (1 - surf);
  // Slow idle drift so a standing figure is never perfectly still.
  const idle = Math.sin(this._t * ARM_IDLE_SLOW_RATE) * ARM_IDLE_SLOW
   + Math.sin(this._t * ARM_IDLE_FAST_RATE + ARM_IDLE_FAST_PHASE) * ARM_IDLE_FAST;

  for (let a = 0; a < 2; a++) {
   const sgn = a === 0 ? -1 : 1;
   const upperB = a === 0 ? B_UPPER_L : B_UPPER_R;
   const foreB = a === 0 ? B_FORE_L : B_FORE_R;
   const handB = a === 0 ? B_HAND_L : B_HAND_R;

   // Shoulder, on the chest frame.
   _sh[0] = cx + rX * (sgn * SHOULDER_OFFSET) + uX * SHOULDER_DROP;
   _sh[1] = cy + rY * (sgn * SHOULDER_OFFSET) + uY * SHOULDER_DROP;
   _sh[2] = cz + rZ * (sgn * SHOULDER_OFFSET) + uZ * SHOULDER_DROP;

   // ---- walk target: hand swings fore and aft below the hip --------
   //
   // Every offset here is kept comfortably inside the arm's 0.54 m
   // reach. Put the target at or past full extension and the IK solver
   // does exactly what it is told — locks the elbow — and the figure
   // walks around with two straight poles for arms.
   const sw = swing * -sgn;
   let tx = _sh[0] + fX * (sw * ARM_SWING_RUN) - uX * ARM_SWING_DOWN + rX * (sgn * ARM_SIDE);
   let ty = _sh[1] + fY * (sw * ARM_SWING_RUN) - uY * ARM_SWING_DOWN + rY * (sgn * ARM_SIDE);
   let tz = _sh[2] + fZ * (sw * ARM_SWING_RUN) - uZ * ARM_SWING_DOWN + rZ * (sgn * ARM_SIDE);
   ty += idle * sgn;

   // ---- cast target: both hands up and out along the aim -----------
   //
   // A wide base, the leading hand extended along the flow and the
   // trailing hand drawn back across the body, so the arms describe the
   // arc the water is about to take. The right hand leads because that
   // is the hand the ribbon is emitted from.
   //
   // Blended, not switched, and it composes with the walk swing rather
   // than replacing it — a character casting while walking still walks.
   const cast = ch.cast;
   if (cast > SURF_BLEND_EPS) {
    const ax = ch.castAimX, ay = ch.castAimY, az = ch.castAimZ;
    // The leading hand reaches along the aim; the trailing one sits
    // low and inboard, cocked back.
    const lead = a === 1 ? 1 : 0;
    const outward = lead ? CAST_LEAD_OUT : CAST_TRAIL_OUT;
    const along = lead ? CAST_LEAD_ALONG : CAST_TRAIL_ALONG;
    const lift = lead ? CAST_LEAD_LIFT : CAST_TRAIL_LIFT;
    const px = _sh[0] + rX * (sgn * CAST_SPLAY + outward * sgn) + ax * along + uX * lift;
    const py = _sh[1] + rY * (sgn * CAST_SPLAY) + ay * along + uY * lift + lift * CAST_TARGET_UP;
    const pz = _sh[2] + rZ * (sgn * CAST_SPLAY + outward * sgn) + az * along + uZ * lift;
    tx += (px - tx) * cast;
    ty += (py - ty) * cast;
    tz += (pz - tz) * cast;
   }

   // ---- surf target: out, forward and a little down ----------------
   if (surf > SURF_BLEND_EPS) {
    const carve = ch.carve;
    // Trailing arm rises, leading arm drops into the turn — the
    // same asymmetry a snowboarder holds through a carve.
    const rise = SURF_ARM_RISE + carve * sgn * SURF_ARM_CARVE;
    const sx = _sh[0] + rX * (sgn * SURF_ARM_OUT) + fX * SURF_ARM_FWD + uX * rise;
    const sy = _sh[1] + rY * (sgn * SURF_ARM_OUT) + fY * SURF_ARM_FWD + uY * rise;
    const sz = _sh[2] + rZ * (sgn * SURF_ARM_OUT) + fZ * SURF_ARM_FWD + uZ * rise;
    tx += (sx - tx) * surf;
    ty += (sy - ty) * surf;
    tz += (sz - tz) * surf;
   }

   // Elbows point back and out.
   const px = -fX + rX * (sgn * ELBOW_POLE);
   const py = -fY + rY * (sgn * ELBOW_POLE) - ELBOW_DROP;
   const pz = -fZ + rZ * (sgn * ELBOW_POLE);
   solveTwoBone(
    _sh[0], _sh[1], _sh[2], tx, ty, tz, px, py, pz,
    UPPER_LEN, FORE_LEN, _p
   );

   this._setBone(
    upperB, _sh[0], _sh[1], _sh[2],
    _p[0] - _sh[0], _p[1] - _sh[1], _p[2] - _sh[2],
    fX, fY, fZ
   );
   this._setBone(
    foreB, _p[0], _p[1], _p[2],
    tx - _p[0], ty - _p[1], tz - _p[2],
    fX, fY, fZ
   );
   // The hand continues the forearm, rolled palm-inward.
   let hx = tx - _p[0], hy = ty - _p[1], hz = tz - _p[2];
   const hl = Math.hypot(hx, hy, hz) || 1;
   hx /= hl; hy /= hl; hz /= hl;
   this._setBone(handB, tx, ty, tz, hx, hy, hz, fX, fY, fZ);
  }
 }

 /**
  * World position of a hand, for spell emitters. Writes 3 floats to `out`.
  * @param {number} which 0 = left hand, 1 = right
  * @param {Float32Array} out
  * @param {number} od element offset to write at
  */
 handPosition(which: number, out: Float32Array, od: number): void {
  const b = which === 0 ? B_HAND_L : B_HAND_R;
  xformPoint(this.world, b * 16, 0, HAND_OFFSET, 0, out, od);
 }
}

export { HIP_HEIGHT };
