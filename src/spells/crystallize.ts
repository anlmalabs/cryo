/**
 * Spell 4 — Crystallise.
 *
 * Water snaps to ice. A formation grows out of the drift at the aim point, and
 * the patch it grew from stays glazed long after the prisms have gone.
 *
 * Two mechanisms, and the split matters:
 *
 *   the formation   geometry, in `crystals.js`. It grows over about a second and
 *                   a half, stands for half a minute, and sublimates back into
 *                   the drift. This is the thing the player looks at.
 *   the glaze       the ice channel of the terrain state buffer, which decays on
 *                   a fifteen-minute constant. This is the thing that satisfies
 *                   "permanently altering the surface": the snow shader answers
 *                   it with a roughness of 0.07 and a genuinely reflective
 *                   surface, so a Crystallise patch stays visible from across the
 *                   field as a slick of ice.
 *
 * The prisms are planted along a short *spiral* rather than in a disc. A random
 * scatter reads as scattered; a spiral with the crystals getting shorter as they
 * go out reads as something that grew from a centre, which is what it is.
 */

import { smooth01 } from "./bending.js";

import type { SpellContext } from "./spellSystem.js";

/** Seconds the whole cast takes to finish planting. */
const PLANT_TIME = 0.85;

/** Crystals in one formation. */
const COUNT = 34;

/** Seconds the formation stands at full size before sublimating. */
const STAND = 34;

/** Seconds past the last prism that the frost spray keeps falling. */
const FROST_TAIL = 0.4;

/** Seconds past the last prism that the spell is still `active`. */
const DRAIN_TIME = 1.6;

/** Seconds the forming light takes to fall from peak to nothing. */
const FORM_TIME = 0.9;

/** Ember flicker rate, radians per second. */
const EMBER_RATE = 1.7;

/** Peak intensity the forming light adds over its floor. */
const EMBER_BOOST = 12.0;

/** Height the spell light sits above the cast point, metres. */
const LIGHT_LIFT = 0.55;

/** Floor of the light intensity, against the forming peak. */
const LIGHT_FLOOR = 0.35;

/** Radius, metres, of the glaze brush under the formation. */
const GLAZE_RADIUS = 1.55;

/** Compression the glaze brush writes into the snow, 0..1. */
const GLAZE_COMPRESSION = 0.85;

/** Satellite brushes scattered around the glaze, count. */
const SATELLITE_COUNT = 3;

/** Radius of the satellite brushes, metres. */
const SATELLITE_RADIUS = 0.55;

/** Scatter of the satellite brushes around the glaze, metres. */
const SATELLITE_SCATTER = 1.3;

/** Half-range the satellite radius jitters by, metres. */
const SATELLITE_RADIUS_RANGE = 0.5;

/**
 * The zero-centring offset on `Math.random()`, which returns 0..1. Subtracting
 * it turns that into a band centred on zero; the *width* of the band is set by
 * the multiplier beside it — `PLANT_JITTER` for position, `LEAN_JITTER` for the
 * lean axis.
 */
const RANDOM_CENTRE = 0.5;

/** Lateral jitter on each prism's position, metres each side of centre. */
const PLANT_JITTER = 0.16;

/** Lateral jitter on each prism's lean axis, radians each side of centre. */
const LEAN_JITTER = 0.12;

/** Depth each prism is buried below the surface at, metres. */
const PLANT_DEPTH = 0.06;

/** Height of a full-size prism, metres. */
const PRISM_HEIGHT = 1.75;

/** Radius of a full-size prism, metres. */
const PRISM_RADIUS = 0.15;

/** How much the outer prisms shrink relative to the centre. */
const PRISM_TAPER = 0.58;

/** Scale randomness of a prism, from small to large. */
const SCALE_MIN = 0.6;

/** Width of the scale random range, added to `SCALE_MIN`. */
const SCALE_RANGE = 0.8;

/** Radius randomness of a prism, from thin to thick. */
const RADIUS_MIN = 0.7;

/** Width of the radius random range, added to `RADIUS_MIN`. */
const RADIUS_RANGE = 0.7;

/** Lean of the innermost prism, radians. */
const TILT_BASE = 0.10;

/** How much the outer prisms lean more than the inner, radians. */
const TILT_SPREAD = 0.42;

/** Grow time of a planted prism, seconds, minimum. */
const GROW_BASE = 0.45;

/** Grow-time scatter added to `GROW_BASE` per prism, seconds. */
const GROW_RANGE = 0.55;

/** Lifetime scatter added to `STAND` for each prism, seconds. */
const LIFE_SCATTER = 8.0;

/** Radius of the snow pushed aside by each planted prism, metres. */
const BRUSH_RADIUS_MULT = 3.2;

/** Radius of the frost spray ring, metres. */
const FROST_RADIUS = 1.8;

/** Frost grains emitted per second, at `sprayScale` 1. */
const FROST_RATE = 60.0;

/** Height above the cast point the frost starts at, metres. */
const FROST_LIFT = 0.05;

/** Vertical spread of the frost spray, metres. */
const FROST_RISE = 0.5;

/** Outward speed of the frost grains, metres per second, minimum. */
const FROST_OUT_MIN = 0.6;

/** Outward speed of the frost grains, metres per second, added to the min. */
const FROST_OUT_RANGE = 1.4;

/** Upward speed of the frost grains, metres per second, minimum. */
const FROST_UP_MIN = 0.9;

/** Upward speed of the frost grains, metres per second, added to the min. */
const FROST_UP_RANGE = 2.4;

/** Radius of a frost grain, metres. */
const GRAIN_SIZE = 0.012;

/** Width of the grain radius random range, added to `GRAIN_SIZE`. */
const GRAIN_RANGE = 0.020;

/** Lifetime of a frost grain, seconds, minimum. */
const GRAIN_LIFE_MIN = 0.7;

/** Lifetime of a frost grain, seconds, added to the minimum. */
const GRAIN_LIFE_RANGE = 0.9;

/** Fraction of frost grains that come out as clod rather than powder. */
const CLOD_FRACTION = 0.4;

/** Drag on a frost grain, 1/s. */
const GRAIN_DRAG = 2.4;

export class Crystallize {
 ctx!: SpellContext;
 active = false;
 t = 0;
 x = 0;
 y = 0;
 z = 0;
 _planted = 0;
 _seed = 0;

 constructor(ctx: SpellContext) {
  this.ctx = ctx;
 }

 /** @param {number} x @param {number} y @param {number} z ground target */
 trigger(x: number, y: number, z: number) {
  this.x = x;
  this.y = y;
  this.z = z;
  this.t = 0;
  this._planted = 0;
  this._seed = Math.random() * 1000;
  this.active = true;

  // The glaze goes down immediately, under where the formation will be, so
  // the ground has already changed material by the time the first prism is
  // tall enough to see. Doing it as the crystals land instead leaves a
  // beat where ice is standing on ordinary snow.
  const f = this.ctx.deform;
  f.brush(x, z, GLAZE_RADIUS, 0.10, 0.16, GLAZE_COMPRESSION, 1.0, Math.random() * Math.PI, 1.2, 0.85);
  for (let i = 0; i < SATELLITE_COUNT; i++) {
   const a = Math.random() * Math.PI * 2;
   const d = 1.1 + Math.random() * SATELLITE_SCATTER;
   f.brush(
    x + Math.cos(a) * d, z + Math.sin(a) * d,
    SATELLITE_RADIUS + Math.random() * SATELLITE_RADIUS_RANGE,
    0.04, 0.10, 0.5, 0.75, a, 1.5, 1.0
   );
  }
 }

 /** @param {number} dt */
 update(dt: number) {
  if (!this.active) return;
  const ctx = this.ctx;
  this.t += dt;

  // ---- planting ------------------------------------------------------
  // Spread over most of a second rather than all at once, so the formation
  // grows outward from the centre instead of appearing on one frame.
  const want = Math.min(COUNT, Math.ceil((this.t / PLANT_TIME) * COUNT));
  while (this._planted < want) {
   this._plantOne(this._planted);
   this._planted++;
  }

  // ---- light ---------------------------------------------------------
  // Bright and tight while it is forming, then a low ember that lasts as
  // long as the formation does. Ice does not emit, but the snow around a
  // cluster of refracting prisms under a low sun genuinely does pick up
  // caustic light, and a small amount of it here is what stops the
  // formation looking like it was pasted on.
  const form = 1 - smooth01((this.t - PLANT_TIME) / FORM_TIME);
  const ember = 0.10 + 0.06 * Math.sin(this.t * EMBER_RATE);
  const k = LIGHT_FLOOR + EMBER_BOOST * form;
  ctx.lights.add(this.x, this.y + LIGHT_LIFT, this.z, 7.5, 0.52, 0.80, 1.0, k * (1 + ember));

  // ---- frost spray ---------------------------------------------------
  if (this.t < PLANT_TIME + FROST_TAIL) this._frost(dt);

  // The spell itself is done once the last prism is in; the crystals age
  // on their own clock from there.
  if (this.t > PLANT_TIME + DRAIN_TIME) this.active = false;
 }

 /**
  * One prism, on the spiral.
  *
  * The golden angle is doing real work here: it is the one rotation that
  * never repeats a radial line, so no two crystals in a formation line up
  * with each other however many there are. Any rational fraction of a turn
  * gives visible spokes.
  * @param {number} i
  */
 _plantOne(i: number) {
  const ctx = this.ctx;
  const n01 = i / (COUNT - 1);
  // 2.39996323 is the golden angle in radians, pi*(3 - sqrt(5)): the one
  // rotation that never repeats a radial line. The shader constant is
  // the same number, in `shaders/post/dof.fragment.glsl` as `GOLDEN`; the
  // spells' canonical name for the family is `GOLDEN_ANGLE` in
  // `crystals.ts`, which holds it as a fraction of a turn (0.618034) rather
  // than in radians. Deliberately inline, as `particles.ts` notes — the
  // canonical naming is owned elsewhere, and here it has to stay beside the
  // comment explaining why the rotation must be irrational.
  const ang = i * 2.39996323 + this._seed;
  // Outer reach of the spiral paired with the inner radius above, metres.
  // Not golden-derived — just the radius the formation spreads to.
  const r = 0.18 + Math.sqrt(n01) * 2.05;

  const x = this.x + Math.cos(ang) * r + (Math.random() - RANDOM_CENTRE) * PLANT_JITTER;
  const z = this.z + Math.sin(ang) * r + (Math.random() - RANDOM_CENTRE) * PLANT_JITTER;
  const y = ctx.terrain.heightAt(x, z) - PLANT_DEPTH;

  // Tall in the middle, low at the edges, with enough scatter that the
  // envelope is not a readable cone.
  //
  // The centre crystals are chest height on the character, deliberately —
  // a knee-height cluster is something the player walks past. Scale is the
  // cheapest drama there is.
  const scale = (1 - n01 * PRISM_TAPER) * (SCALE_MIN + Math.random() * SCALE_RANGE);
  const height = PRISM_HEIGHT * scale;
  const radius = PRISM_RADIUS * scale * (RADIUS_MIN + Math.random() * RADIUS_RANGE);

  // Leaning outward, more so further out — the way a real cluster grows
  // toward the space it has.
  const tilt = TILT_BASE + n01 * TILT_SPREAD * (SCALE_MIN + Math.random() * SCALE_RANGE);
  const ax = Math.cos(ang) * tilt + (Math.random() - RANDOM_CENTRE) * LEAN_JITTER;
  const az = Math.sin(ang) * tilt + (Math.random() - RANDOM_CENTRE) * LEAN_JITTER;

  ctx.crystals.plant(
   x, y, z, ax, 1, az,
   height, radius,
   GROW_BASE + Math.random() * GROW_RANGE,
   STAND + Math.random() * LIFE_SCATTER
  );

  // A little snow pushed aside where each one broke the surface.
  if ((i & 1) === 0) {
   ctx.deform.brush(
    x, z, radius * BRUSH_RADIUS_MULT,
    0.05, 0.09, 0.4, 0.9, ang, 1.2, 1.0
   );
  }
 }

 /** @param {number} dt */
 _frost(dt: number) {
  const ctx = this.ctx;
  const sp = ctx.spray;
  if (!sp) return;
  const count = ((FROST_RATE * ctx.sprayScale) * dt) | 0;
  for (let k = 0; k < count; k++) {
   const a = Math.random() * Math.PI * 2;
   const r = Math.random() * FROST_RADIUS;
   sp.emit(
    this.x + Math.cos(a) * r,
    this.y + FROST_LIFT + Math.random() * FROST_RISE,
    this.z + Math.sin(a) * r,
    Math.cos(a) * (FROST_OUT_MIN + Math.random() * FROST_OUT_RANGE),
    FROST_UP_MIN + Math.random() * FROST_UP_RANGE,
    Math.sin(a) * (FROST_OUT_MIN + Math.random() * FROST_OUT_RANGE),
    GRAIN_SIZE + Math.random() * GRAIN_RANGE,
    GRAIN_LIFE_MIN + Math.random() * GRAIN_LIFE_RANGE,
    Math.random() < CLOD_FRACTION ? 1 : 0,
    GRAIN_DRAG
   );
  }
 }

 cancel() {
  this.active = false;
 }
}
