/**
 * Spell 5 — Vortex.
 *
 * A swirling column of airborne snow around the player that visibly *strips*
 * surface snow from the ground, holds it aloft, and lets it settle back.
 *
 * The stripping is the point, and it is the one thing here that no other spell
 * does: this is the only effect in the demo that takes the terrain state buffer
 * *back*. A brush with a negative depression is a perfectly ordinary brush as
 * far as the simulation is concerned — the accumulation is additive and the
 * clamp floors it at zero — so "remove snow from a ring" and "put it back" are
 * the same code path as everything else, with a sign on it.
 *
 * The airborne mass is two systems working from one description:
 *
 *   three helices   swept tubes of dense slush, wound around the player and
 *                   rotating. These give the column a readable *shape*; a vortex
 *                   made only of particles is a cloud, and a cloud does not
 *                   spiral.
 *   the grains      emitted continuously *along those same helices*, with the
 *                   helix's own tangential velocity, and short-lived enough that
 *                   they never get far from the path that launched them. That is
 *                   how the spray swirls without the particle simulation needing
 *                   to know what a vortex is — the same trick the surf plume uses
 *                   to leave the crest the mesh is actually drawing.
 */

import { PROFILE_TUBE } from "./waterBody.js";
import { clamp01, smooth01, bell, transport } from "./bending.js";

import type { SpellContext } from "./spellSystem.js";

/** How many helices. Three reads as a spiral; two reads as a double helix. */
const HELICES = 3;
/** Spine samples per helix. See the note on `STRAND_COLS` — this curve is tight. */
const COLS = 64;
/** Seconds of full-strength spin, before the ease-out. */
const HOLD = 3.0;

const RAMP = 0.55;

const FADE = 1.1;

/** Height of the column, metres. */
const TOP = 4.8;
/** Turns each helix makes from the ground to the top. */
const TURNS = 1.35;

/** Radius of the helix at the ground, metres. */
const RADIUS_AT_GROUND = 2.55;
/** How much the helix narrows by the top, metres. */
const RADIUS_TAPER = 1.15;
/** Base of the waist modulation on the radius, dimensionless. */
const WAIST_BASE = 0.78;
/** Depth of that waist, dimensionless. */
const WAIST_GAIN = 0.34;
/** Height fraction at which the waist sits, 0 ground, 1 top. */
const WAIST_AT = 1.2;
/** Radius of the helix tube at its fattest, metres. */
const TUBE_RADIUS = 0.125;
/** Base of the tube's radius ripple, dimensionless. */
const TUBE_RIPPLE_BASE = 0.78;
/** Depth of that ripple, dimensionless. */
const TUBE_RIPPLE_GAIN = 0.34;
/** Height fraction the tube ripple advances per sample. */
const TUBE_RIPPLE_RATE = 3.4;
/** Rate the tube ripple drifts in time, radians per second. */
const TUBE_RIPPLE_DRIFT = 2.2;
/** Phase the taper opens at, height fraction. */
const TAPER_AT = 0.04;
/** Band the taper closes over, height fraction. */
const TAPER_SPAN = 0.92;
/** Section roll rate, radians per second. */
const ROLL_RATE = 0.7;
/** Roll handed to each successive helix, radians. */
const ROLL_PER_HELIX = 2.1;
/** Foam at the top of the column, 0..1. */
const FOAM_TOP = 0.22;
/** Extra foam toward the ground, 0..1. */
const FOAM_GROUND_GAIN = 0.3;
/** Milkiness of the helices, 0 clear water, 1 opaque slush. */
const HELIX_MILKINESS = 0.88;
/** Alpha gain on the envelope for the helices. */
const HELIX_ALPHA_GAIN = 1.3;

/** Idle spin rate of the column, radians per second. */
const SPIN_BASE = 5.2;
/** Extra spin the envelope adds at full strength, radians per second. */
const SPIN_GAIN = 2.4;
/** Radius of the spell light, metres. */
const LIGHT_RADIUS = 9.0;
/** Light colour, red. */
const LIGHT_R = 0.46;
/** Light colour, green. */
const LIGHT_G = 0.74;
/** Light colour, blue. */
const LIGHT_B = 1.0;
/** Height of the light above the ground, metres. */
const LIGHT_LIFT = 1.3;
/** Light intensity at full envelope. */
const LIGHT_INTENSITY = 9.0;

/** How far out the stripping ring reaches while held, metres. */
const RING_MAX = 3.1;
/** Radius the ring retreats to once the spell fades, metres. */
const RING_MIN = 0.9;
/** Growth rate of the ring while held, metres per second. */
const RING_GROWTH = 0.85;
/** Retreat rate of the ring while fading, metres per second. */
const RING_RETREAT = 2.2;
/** Seconds between ranks of strip brushes. */
const STRIP_CADENCE = 1 / 45;
/** Cap on seconds of owed time folded into a single rank. */
const STRIP_OWED_CAP = 0.05;
/** Brushes around the ring in one rank. */
const STRIP_SPAN = 9;
/** Rate the ring turns with the column, so it scours rather than stamps. */
const STRIP_TURN = 0.6;
/** Radius the strip brushes sit at, as a fraction of the ring radius. */
const STRIP_R = 0.82;
/** Random spread of that radius, as a fraction of the ring radius. */
const STRIP_R_JITTER = 0.3;
/** Radius of one strip brush, metres. */
const STRIP_BRUSH_RADIUS = 0.55;
/** Depression the brush writes while holding, in the `depth` channel. */
const STRIP_LIFT = 0.95;
/** Berm the brush writes while holding, in the `berm` channel. */
const STRIP_BERM = 0.05;
/** Compression the brush writes while holding, in the `ice` channel. */
const STRIP_PACK = 0.30;
/** Depression the brush writes while fading — negative, so it puts snow back. */
const STRIP_RETURN = -1.7;
/** Berm the brush writes while fading. */
const STRIP_SETTLE_BERM = 0.85;
/** Compression the brush writes while fading — negative, so it loosens. */
const STRIP_LOOSEN = -0.6;
/** Yaw of one strip brush, offset from its angle. */
const STRIP_YAW = Math.PI * 0.5;
/** Long axis of the strip brush, as a multiple of its radius. */
const STRIP_ELONGATION = 1.9;
/** Softness of the strip brush's outer edge, 0..1. */
const STRIP_EDGE = 1.0;

/** Envelope below which no grains are emitted. */
const GRAIN_ENV_MIN = 0.05;
/** Grains emitted per second at `sprayScale` 1 and full envelope. */
const GRAIN_RATE = 2600;
/** Hard cap on grains emitted in one frame. */
const GRAIN_CAP = 260;
/** Angular scatter on a grain's launch, radians each way. */
const GRAIN_ANGLE_JITTER = 0.9;
/** Random spread of the launch radius, as a fraction of that radius. */
const GRAIN_R_JITTER = 0.85;
/** Random width of that spread, as a fraction of the radius. */
const GRAIN_R_RANGE = 0.35;
/** Tangential speed at the ground, metres per second. */
const GRAIN_SPEED_TOP = 7.5;
/** Speed lost by the top of the column, metres per second. */
const GRAIN_SPEED_DROP = 2.6;
/** Random lateral push on a grain's velocity, metres per second each way. */
const GRAIN_PUSH = 1.2;
/** Zero-centring of that push, on `Math.random()`. */
const GRAIN_PUSH_CENTRE = 0.6;
/** Upward speed a grain is born with, metres per second. */
const GRAIN_RISE_BASE = 1.4;
/** Random extra upward speed, metres per second. */
const GRAIN_RISE_JITTER = 3.4;
/** Extra upward speed at the ground, metres per second. */
const GRAIN_RISE_GROUND = 2.5;
/** Radius of a grain, metres. */
const GRAIN_RADIUS = 0.028;
/** Random extra radius of a grain, metres. */
const GRAIN_RADIUS_JITTER = 0.062;
/** Lifetime of a grain, seconds, minimum. */
const GRAIN_LIFE = 0.30;
/** Random extra lifetime of a grain, seconds. */
const GRAIN_LIFE_JITTER = 0.26;

/** Height a grain is born above the ground, metres. */
const GRAIN_LIFT = 0.06;
/** Random extra height above that, metres. */
const GRAIN_LIFT_JITTER = 0.2;
/** Drag on a grain, 1/s — low, so it holds its launch velocity. */
const GRAIN_DRAG = 0.9;

/** Zero-centring offset on `Math.random()`, which returns 0..1. */
const RANDOM_CENTRE = 0.5;

const _rgt = new Float32Array(3);

export class Vortex {
 ctx!: SpellContext;
 active = false;
 /** One strand handle per helix; -1 when that helix has none. */
 strands: number[] = [-1, -1, -1];

 t = 0;
 x = 0;
 z = 0;
 spin = 0;
 _stripOwed = 0;
 _grainOwed = 0;
 /** How far out the stripping ring has reached, metres. */
 ring = RING_MIN;

 constructor(ctx: SpellContext) {
  this.ctx = ctx;
 }

 trigger() {
  const ctx = this.ctx;
  for (let i = 0; i < HELICES; i++) {
   if (this.strands[i] < 0) this.strands[i] = ctx.water.acquire();
  }
  this.t = 0;
  this.ring = RING_MIN;
  this._stripOwed = 0;
  this._grainOwed = 0;
  this.active = true;
 }

 /** @param {number} dt */
 update(dt: number) {
  if (!this.active) return;
  const ctx = this.ctx;
  this.t += dt;

  const total = RAMP + HOLD + FADE;
  if (this.t >= total) {
   this._end();
   return;
  }

  // The column follows the player. It is *their* vortex — walking out of
  // it would be the single most effect-like thing it could do.
  this.x = ctx.controller.position.x;
  this.z = ctx.controller.position.z;

  const env = smooth01(this.t / RAMP) * (1 - smooth01((this.t - RAMP - HOLD) / FADE));
  // Spins up and keeps spinning: the rotation does not ease out with the
  // envelope, so the last frame is a fading column that is still turning
  // rather than one that is winding down.
  this.spin += dt * (SPIN_BASE + SPIN_GAIN * env);

  this._helices(env);
  this._strip(dt, env);
  this._grains(dt, env);

  ctx.lights.add(
   this.x, ctx.terrain.heightAt(this.x, this.z) + LIGHT_LIFT, this.z,
   LIGHT_RADIUS, LIGHT_R, LIGHT_G, LIGHT_B, LIGHT_INTENSITY * env
  );
 }

 /** Lay the three helices. */
 _helices(env: number) {
  const ctx = this.ctx;
  const water = ctx.water;
  const groundY = ctx.terrain.heightAt(this.x, this.z);

  for (let hIdx = 0; hIdx < HELICES; hIdx++) {
   const s = this.strands[hIdx];
   if (s < 0) continue;
   const phase = (hIdx / HELICES) * Math.PI * 2;

   let px = 0, py = 0, pz = 0;
   let rx = 1, ry = 0, rz = 0;
   let t0x = 1, t0y = 0, t0z = 0;
   let dist = 0;

   for (let c = 0; c < COLS; c++) {
    const u = c / (COLS - 1);
    // Column 0 is the top of the helix — the leading edge of the
    // lift — so `u` runs downward, matching every other strand.
    const h = 1 - u;
    const ang = phase + this.spin + h * TURNS * Math.PI * 2;
    // Wide at the bottom where it is picking snow up, narrower and
    // faster at the top. Not a cone: the waist is what makes it read
    // as a vortex rather than as a party hat.
    const r = (RADIUS_AT_GROUND - RADIUS_TAPER * h)
     * (WAIST_BASE + WAIST_GAIN * bell(clamp01(h * WAIST_AT)));

    const x = this.x + Math.cos(ang) * r;
    const z = this.z + Math.sin(ang) * r;
    const y = groundY + TOP * h * env + 0.05;

    if (c > 0) {
     let t1x = x - px, t1y = y - py, t1z = z - pz;
     const l = Math.hypot(t1x, t1y, t1z) || 1e-4;
     t1x /= l; t1y /= l; t1z /= l;
     dist += l;
     transport(_rgt, 0, rx, ry, rz, t0x, t0y, t0z, t1x, t1y, t1z);
     rx = _rgt[0]; ry = _rgt[1]; rz = _rgt[2];
     t0x = t1x; t0y = t1y; t0z = t1z;
    } else {
     rx = 0; ry = 1; rz = 0;
    }

    // Both ends taper to nothing: the top because the snow is
    // dispersing, the bottom because it is still on the ground.
    //
    // Thin. The helices are here to give the column a readable
    // *shape*, not to be the column: the mass of it is the grains,
    // and a fat ribbon takes the reading away from them and turns
    // the spell into three solid loops with some snow near it.
    // Monotonic in `u`, with one slow modulation and nothing else.
    // Several terms keyed to world distance reach the sample Nyquist
    // and pinch the tube shut wherever their zeros line up, which
    // reads as vertebrae. Anything finer than the samples can carry
    // has to live in the relief field, which is band-limited on
    // purpose; see `waterRelief`.
    const taper = bell(u * TAPER_SPAN + TAPER_AT);
    const rad = TUBE_RADIUS * taper * env
     * (TUBE_RIPPLE_BASE + TUBE_RIPPLE_GAIN
      * Math.sin(u * TUBE_RIPPLE_RATE + ctx.time * TUBE_RIPPLE_DRIFT + hIdx));

    // The section roll carries *no* distance term.
    //
    // A roll that advances along the spine spirals everything keyed
    // to the section angle — including the relief field — so the
    // surface comes out cut with a screw thread, which on a thin
    // tube reads as vertebrae. The ribbon wants that
    // spiral, because it has an elliptical section and the twist is
    // the point; a round section gains nothing from it but the
    // artefact.
    water.column(
     s, c, x, y, z, rad,
     rx, ry, rz, ctx.time * ROLL_RATE + hIdx * ROLL_PER_HELIX,
     dist, u, FOAM_TOP + FOAM_GROUND_GAIN * (1 - h), 1
    );

    px = x; py = y; pz = z;
   }

   // Almost entirely opaque: this is lifted snow, not water. The small
   // amount of transparency left is what lets the far side of the
   // column show through the near side, which is most of what makes it
   // read as a rotating volume.
   water.setParams(s, PROFILE_TUBE, HELIX_MILKINESS, clamp01(env * HELIX_ALPHA_GAIN), COLS);
  }
 }

 /**
  * Strip the ground, then give it back.
  *
  * The ring grows outward while the spell holds and retreats while it fades,
  * so the snow comes back from the outside in — which is what settling snow
  * does, since the outermost material was lifted the least far.
  */
 _strip(dt: number, env: number) {
  const ctx = this.ctx;
  const f = ctx.deform;

  const holding = this.t < RAMP + HOLD;
  this.ring = holding
   ? Math.min(RING_MAX, this.ring + dt * RING_GROWTH)
   : Math.max(RING_MIN, this.ring - dt * RING_RETREAT);

  this._stripOwed += dt;
  if (this._stripOwed < STRIP_CADENCE) return;
  const k = Math.min(this._stripOwed, STRIP_OWED_CAP);
  this._stripOwed = 0;

  const N = STRIP_SPAN;
  // Holding: take snow away — depression up, no berm, because the mass is
  // in the air rather than piled at the rim. Fading: put it back, as
  // negative depression plus a little loose berm, because what lands is
  // broken snow sitting proud of what it fell on.
  const give = holding ? -1 : 1;

  for (let i = 0; i < N; i++) {
   // Rotating with the column, so the ring is scoured rather than
   // stamped: a fixed set of angles leaves nine radial scars.
   const a = (i / N) * Math.PI * 2 + this.spin * STRIP_TURN;
   const r = this.ring * (STRIP_R + Math.random() * STRIP_R_JITTER);
   f.brush(
    this.x + Math.cos(a) * r,
    this.z + Math.sin(a) * r,
    STRIP_BRUSH_RADIUS,
    give < 0 ? STRIP_LIFT * k * env : STRIP_RETURN * k,
    give < 0 ? STRIP_BERM * k * env : STRIP_SETTLE_BERM * k,
    give < 0 ? STRIP_PACK * k * env : STRIP_LOOSEN * k,
    0,
    a + STRIP_YAW, STRIP_ELONGATION, STRIP_EDGE
   );
  }
 }

 /**
  * The airborne grains.
  *
  * Emitted at a point on one of the helices with that helix's own tangential
  * velocity, and given a life short enough (a third of a second) that a
  * straight-line integration never visibly departs from the curve it was
  * launched along. Nothing in the particle system knows this is a vortex; the
  * swirl is entirely in where and how the grains are born.
  */
 _grains(dt: number, env: number) {
  const ctx = this.ctx;
  const sp = ctx.spray;
  if (!sp || env < GRAIN_ENV_MIN) return;

  const rate = GRAIN_RATE * ctx.sprayScale * env;
  this._grainOwed += dt * rate;
  let count = this._grainOwed | 0;
  if (count <= 0) return;
  this._grainOwed -= count;
  if (count > GRAIN_CAP) count = GRAIN_CAP;

  const groundY = ctx.terrain.heightAt(this.x, this.z);

  for (let k = 0; k < count; k++) {
   // Weighted toward the bottom, where the snow is being picked up.
   const h = Math.random() * Math.random();
   const hIdx = (Math.random() * HELICES) | 0;
   const phase = (hIdx / HELICES) * Math.PI * 2;
   const ang = phase + this.spin + h * TURNS * Math.PI * 2
    + (Math.random() - RANDOM_CENTRE) * GRAIN_ANGLE_JITTER;
   const r = (RADIUS_AT_GROUND - RADIUS_TAPER * h)
    * (WAIST_BASE + WAIST_GAIN * bell(clamp01(h * WAIST_AT)))
    * (GRAIN_R_JITTER + Math.random() * GRAIN_R_RANGE);

   const cs = Math.cos(ang);
   const sn = Math.sin(ang);
   // Tangential: perpendicular to the radius, in the direction of spin.
   const speed = GRAIN_SPEED_TOP - GRAIN_SPEED_DROP * h;
   const vx = -sn * speed;
   const vz = cs * speed;

   sp.emit(
    this.x + cs * r,
    groundY + TOP * h * env + GRAIN_LIFT + Math.random() * GRAIN_LIFT_JITTER,
    this.z + sn * r,
    vx + cs * (Math.random() - GRAIN_PUSH_CENTRE) * GRAIN_PUSH,
    GRAIN_RISE_BASE + Math.random() * GRAIN_RISE_JITTER + (1 - h) * GRAIN_RISE_GROUND,
    vz + sn * (Math.random() - GRAIN_PUSH_CENTRE) * GRAIN_PUSH,
    GRAIN_RADIUS + Math.random() * GRAIN_RADIUS_JITTER,
    GRAIN_LIFE + Math.random() * GRAIN_LIFE_JITTER,
    0,
    // Low drag, short life: it holds the launch velocity for the
    // whole of its life, which is what keeps it on the spiral.
    GRAIN_DRAG
   );
  }
 }

 _end() {
  this.active = false;
  for (let i = 0; i < HELICES; i++) {
   if (this.strands[i] >= 0) {
    this.ctx.water.release(this.strands[i]);
    this.strands[i] = -1;
   }
  }
 }

 cancel() {
  this._end();
 }
}
