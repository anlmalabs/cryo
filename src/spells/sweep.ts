/**
 * Spell 1 — Sweep.
 *
 * A crescent of slush rises out of the ground ahead of the player and runs
 * outward, ploughing a channel and throwing berms to either side.
 *
 * It is the wake's cross-section on a different spine, and that is not a
 * shortcut. A carve's wall of snow and a bent wave of slush are the same
 * object — mass thrown out of the ground and held up by its own momentum — so
 * they are drawn by the same section integral out of `lib/wake.glsl`, reached
 * through the water material's sheet profile. What differs is what the spine is:
 * the wake's is a record of where the board went, and this one is an arc that
 * grows outward from where the spell was cast.
 *
 * The channel is not a decal chased after the fact. Each frame the live crest
 * writes brushes into the terrain state buffer at the position the mesh is
 * actually drawing, so the mark and the wave cannot disagree — the same rule the
 * plume follows in the surf wake.
 */

import { PROFILE_SHEET } from "./waterBody.js";
import { clamp01, smooth01, bell } from "./bending.js";

import type { SpellContext } from "./spellSystem.js";

/** Spine samples across the crescent. */
const COLS = 48;

/**
 * Curvature radius of the crescent, metres — *fixed*, and this is the whole
 * shape of the spell.
 *
 * Not the distance travelled. Using that as the radius makes the wave an arc of
 * a circle centred on the caster, and ten metres out the crescent is twenty
 * metres wide — a ridge in the terrain rather than something thrown. A wave
 * front has a curvature of its own that has nothing to do with how far it has
 * run, so the arc keeps its shape and *translates*, and only its span opens up
 * as the ends spread.
 */
const CURVE = 5.5;
/** Half-angle of the arc at cast and at full spread, radians. */
const ARC0 = 0.52;

const ARC1 = 0.96;

/** Seconds from cast to fully collapsed. */
const LIFE = 2.4;
/**
 * Peak crest height at the centre of the arc, metres.
 *
 * Taller than the character, on the same reasoning as the surf wake's 2.4 m: at
 * the distance this demo actually frames from, a crest the height of the relief
 * the terrain already has does not read as thrown mass, it reads as a dune.
 */
const PEAK = 2.15;

// ---------------------------------------------------------------------------
// Launch and travel
// ---------------------------------------------------------------------------

/** Launch speed of the crest, m/s — ten, the speed that reads as thrown. */
const LAUNCH_SPEED = 11.5;

/** Exponential decay rate of that speed, 1/s — the wave is launched, not driven. */
const SPEED_DECAY = 1.15;

/** Coasting floor below which the speed does not decay, m/s — a walking pace. */
const TERMINAL_SPEED = 1.2;

/** Seconds from cast to the crest reaching full height. */
const RISE_WINDOW = 0.26;

/** Fraction of LIFE at which the fall begins. */
const FALL_START = 0.55;

/** Fraction of LIFE over which the fall runs to exactly zero. */
const FALL_WINDOW = 0.45;

/** Reach, metres, at the moment of cast — the wave's own origin. */
const WAVE_ORIGIN_REACH = 1.4;

/** Metres of travel over which the arc fully opens and the crest fully thins. */
const SPREAD_RANGE = 14;

/** Crest thinning per unit of spread, dimensionless — the same mass, more ground. */
const THINNING = 0.45;

/** Metres the crest is born ahead of the feet, so the player is never inside it. */
const BIRTH_OFFSET = 1.1;

// ---------------------------------------------------------------------------
// Sections along the crest
// ---------------------------------------------------------------------------

/** Metres the crest mesh is sunk below the terrain, metres. */
const SUNK_DEPTH = 0.13;

/** Baseline curl of the section, dimensionless — the bank, before the hook. */
const CURL_BASE = 0.48;

/** Extra curl at the centre of the arc, dimensionless. */
const CURL_CENTRE_GAIN = 0.47;

/** Lower bound of the curl's rise coupling, dimensionless. */
const CURL_RISE_MIN = 0.45;

/** Upper bound of the curl's rise coupling, dimensionless. */
const CURL_RISE_MAX = 0.55;

/** Foam along the leading edge at the horns, 0..1. */
const FOAM_BASE = 0.30;

/** Extra foam at the centre of the arc, 0..1. */
const FOAM_CENTRE_GAIN = 0.45;

/** Metres of uv distance the spine advances per unit of u, metres. */
const UV_DISTANCE_PER_U = 2.0;

/** Milkiness of the slush, 0 clear water, 1 opaque slush. */
const SLUSH_MILKINESS = 0.48;

/** Alpha gain on the envelope, dimensionless — opaque at the crest. */
const ALPHA_GAIN = 1.4;

/** Radius of the spell light, metres. */
const LIGHT_RADIUS = 9.5;

/** Light colour, red — the cold of the slush. */
const LIGHT_R = 0.42;

/** Light colour, green. */
const LIGHT_G = 0.74;

/** Light colour, blue. */
const LIGHT_B = 1.0;

/** Light height above the crest, as a fraction of crest height. */
const LIGHT_TOP = 0.55;

/** Light intensity at full envelope. */
const LIGHT_INTENSITY = 13.0;

// ---------------------------------------------------------------------------
// The channel and its berms
// ---------------------------------------------------------------------------

/** Envelope below which the trench stops being cut. */
const PLOUGH_ENV_MIN = 0.05;

/** Metres of advance between ranks of channel brushes. */
const BRUSH_CADENCE = 0.25;

/** Metres of advance folded into a single rank, so the depth is frame-rate free. */
const BRUSH_QUEUE_CAP = 0.7;

/** Brushes across one rank — a dense enough row to read as a continuous trench. */
const PLOUGH_SPAN = 13;

/** Metres the trench sits behind the crest, metres — the channel is what it passed. */
const BRUSH_LAG = 0.5;

/** Bell weight below which a brush in the rank is skipped. */
const BRUSH_WEIGHT_MIN = 0.06;

/** Trench depth the channel writes, metres of snow, scaled by k, env and w. */
const CHANNEL_DEPTH = 0.95;

/** Berm the channel throws to its rim, metres. */
const BRUSH_BERM = 0.62;

/** Snow the run packs down over the channel, metres. */
const BRUSH_PACK = 0.55;

/** Slush the channel refreezes, metres. */
const BRUSH_ICE = 0.16;

/** Radius of one channel brush, metres. */
const BRUSH_RADIUS = 0.34;

/** Long axis of the brush along the trench, as a multiple of its radius. */
const BRUSH_ELONGATION = 2.2;

/** Softness of the brush's outer edge, 0..1. */
const BRUSH_EDGE = 0.9;

// ---------------------------------------------------------------------------
// Spray off the crest
// ---------------------------------------------------------------------------

/** Envelope below which nothing is thrown. */
const SPRAY_ENV_MIN = 0.08;

/** Spray emitted per metre of travel, before the overlay's scale. */
const SPRAY_PER_METRE = 120;

/** Hard cap on spray emitted in one frame, particles. */
const SPRAY_CAP = 150;

/** Bell weight below which a thrown particle is culled. */
const SPRAY_WEIGHT_MIN = 0.12;

/** Centre of the random radius the spray is born on, metres. */
const SPRAY_BIRTH_D = CURVE;

/** Offset of that radius below the centre, metres. */
const SPRAY_BIRTH_JITTER = 0.2;

/** Spread of that radius around the centre, metres. */
const SPRAY_BIRTH_SPREAD = 0.6;

/** Birth height as a fraction of the local crest amplitude, 0..1. */
const SPRAY_HEIGHT_MIN = 0.55;

/** Extra birth height from a random term, 0..1. */
const SPRAY_HEIGHT_SPREAD = 0.6;

/** Forward speed the spray leaves the crest at, m/s. */
const THROW_BASE = 1.4;

/** Random extra forward speed, m/s. */
const THROW_JITTER = 3.2;

/** Upward speed the spray leaves the crest at, m/s. */
const RISE_BASE = 1.5;

/** Random extra upward speed, m/s. */
const RISE_JITTER = 3.2;

/** Amplitude's share of the upward speed, dimensionless. */
const RISE_AMP_GAIN = 1.6;

/** Sideways jitter on the thrown velocity, m/s each way. */
const LATERAL_JITTER = 1.4;

/** Probability a thrown particle is a clod rather than a droplet. */
const CLOD_PROBABILITY = 0.2;

/** Radius of a thrown clod, metres. */
const CLOD_RADIUS = 0.022;

/** Random extra radius of a clod, metres. */
const CLOD_RADIUS_JITTER = 0.024;

/** Radius of a thrown droplet, metres. */
const DROP_RADIUS = 0.050;

/** Random extra radius of a droplet, metres. */
const DROP_RADIUS_JITTER = 0.075;

/** Lifetime of a thrown clod, seconds. */
const CLOD_LIFE = 0.6;

/** Random extra lifetime of a clod, seconds. */
const CLOD_LIFE_JITTER = 0.5;

/** Lifetime of a thrown droplet, seconds. */
const DROP_LIFE = 0.55;

/** Random extra lifetime of a droplet, seconds. */
const DROP_LIFE_JITTER = 0.7;

/** Drag on a thrown clod, 1/s. */
const CLOD_DRAG = 0.8;

/** Drag on a thrown droplet, 1/s. */
const DROP_DRAG = 1.6;

/** Random extra drag on a thrown droplet, 1/s. */
const DROP_DRAG_JITTER = 1.4;

/** Zero-centring offset on `Math.random()`, which returns 0..1. */
const RANDOM_CENTRE = 0.5;

export class Sweep {
 ctx!: SpellContext;
 active = false;
 strand = -1;
 t = 0;
 ox = 0;
 oz = 0;
 dx = 0;
 dz = 1;
 /** Metres the crest has travelled from the origin. */
 reach = 0;
 _brushOwed = 0;
 _sprayOwed = 0;

 constructor(ctx: SpellContext) {
  this.ctx = ctx;
  this.active = false;
  this.strand = -1;

  this.t = 0;
  this.ox = 0;
  this.oz = 0;
  this.dx = 0;
  this.dz = 1;
  this.reach = 0;
  this._brushOwed = 0;
  this._sprayOwed = 0;
 }

 /** @param {number} ax @param {number} az flat aim direction */
 trigger(ax: number, az: number) {
  const ctx = this.ctx;
  const ch = ctx.controller;

  // A recast restarts rather than stacking: two crescents from the same
  // point are one crescent with a seam in it.
  if (this.strand < 0) this.strand = ctx.water.acquire();
  if (this.strand < 0) return;

  const fl = Math.hypot(ax, az) || 1;
  this.dx = ax / fl;
  this.dz = az / fl;
  // Born a little ahead of the feet, so the player is never inside it.
  this.ox = ch.position.x + this.dx * BIRTH_OFFSET;
  this.oz = ch.position.z + this.dz * BIRTH_OFFSET;
  this.t = 0;
  this.reach = WAVE_ORIGIN_REACH;
  this._brushOwed = 0;
  this._sprayOwed = 0;
  this.active = true;
 }

 /** @param {number} dt */
 update(dt: number) {
  if (!this.active) return;
  const ctx = this.ctx;
  const water = ctx.water;
  const terrain = ctx.terrain;
  const s = this.strand;
  if (s < 0) {
   this.active = false;
   return;
  }

  this.t += dt;
  const life01 = this.t / LIFE;
  if (life01 >= 1) {
   this._end();
   return;
  }

  // Speed decays: the wave is launched, not driven. Ten metres a second
  // down to a walking pace, which is what makes it read as something that
  // was thrown rather than something being pushed.
  const speed = LAUNCH_SPEED * Math.exp(-this.t * SPEED_DECAY) + TERMINAL_SPEED;
  const travelled = speed * dt;
  this.reach += travelled;

  // Rise fast, hold, fall. The fall is quadratic to exactly zero so the
  // last frame of the wave is flat rather than a step.
  const rise = smooth01(this.t / RISE_WINDOW);
  const fall = 1 - clamp01((life01 - FALL_START) / FALL_WINDOW);
  const env = rise * fall * fall;

  // A wave spreads as it runs: the arc opens up and the crest thins, so
  // the same mass covers more ground.
  const spread = clamp01((this.reach - WAVE_ORIGIN_REACH) / SPREAD_RANGE);
  const arc = ARC0 + (ARC1 - ARC0) * spread;
  const height = PEAK * env / (1 + spread * THINNING);

  // Circle centre, one curvature radius behind the leading point.
  const kx = this.ox + this.dx * (this.reach - CURVE);
  const kz = this.oz + this.dz * (this.reach - CURVE);
  // The crest's own right, for the arc parametrisation.
  const wx = this.dz;
  const wz = -this.dx;

  let px = 0, py = 0, pz = 0;
  for (let c = 0; c < COLS; c++) {
   const u = c / (COLS - 1);
   const th = (u - 0.5) * 2 * arc;
   const cs = Math.cos(th);
   const sn = Math.sin(th);
   // Outward radial at this angle: the direction the section faces, and
   // the direction the horn at that end of the crescent is running.
   const rx = this.dx * cs + wx * sn;
   const rz = this.dz * cs + wz * sn;

   const x = kx + rx * CURVE;
   const z = kz + rz * CURVE;
   // Sunk, so the base of the wall meets the trench floor it is cutting
   // rather than floating on the undisturbed surface.
   const y = terrain.heightAt(x, z) - SUNK_DEPTH;

   // Horns taper to nothing. The bell is on `u` rather than on the
   // angle so the two ends close symmetrically however wide the arc has
   // opened, and the sheet degenerates onto its own spine there instead
   // of ending on a cut edge.
   const amp = height * bell(u);

   // The crest curls harder in the middle, where the mass is. Pushed
   // most of the way to the section integral's plunging limit: at the
   // low end the sheet is a bank, and a bank lying on a dune field is
   // indistinguishable from the dune field. It has to hook over its own
   // face to read as a wave at all.
   const curl = CURL_BASE + CURL_CENTRE_GAIN * bell(u)
    * (CURL_RISE_MIN + CURL_RISE_MAX * rise);
   // Foam along the whole leading edge, heaviest at the centre.
   const foam = FOAM_BASE + FOAM_CENTRE_GAIN * bell(u);

   water.column(
    s, c, x, y, z, amp,
    rx, 0, rz, curl,
    this.reach + u * UV_DISTANCE_PER_U, life01, foam, 1
   );

   if (c === (COLS >> 1)) { px = x; py = y; pz = z; }
  }

  // Slush: mostly water, with enough entrained snow to be opaque at the
  // crest. Below about 0.4 it stops reading as slush and starts reading as
  // a glass sculpture; above about 0.6 the water disappears entirely and
  // it is just a snow berm that happens to be moving.
  water.setParams(s, PROFILE_SHEET, SLUSH_MILKINESS, clamp01(env * ALPHA_GAIN), COLS);

  // Light rides the middle of the crest, low, so it grazes the channel it
  // is cutting rather than lighting it from above.
  ctx.lights.add(
   px, py + height * LIGHT_TOP, pz,
   LIGHT_RADIUS, LIGHT_R, LIGHT_G, LIGHT_B, LIGHT_INTENSITY * env
  );

  this._plough(travelled, env);
  this._spray(travelled, env, height);
 }

 /**
  * The channel and its berms.
  *
  * Written per metre travelled rather than per second, so the trench has the
  * same depth at any speed or frame rate: a patch of ground sits under the
  * brush for (2 * radius / travelled) frames, and the depth it ends at is
  * therefore independent of both.
  */
 _plough(travelled: number, env: number) {
  if (env < PLOUGH_ENV_MIN) return;
  const ctx = this.ctx;
  const f = ctx.deform;

  this._brushOwed += travelled;
  // One rank of brushes every 25 cm of advance. Denser than that just
  // re-cuts the same trench; sparser leaves it scalloped.
  if (this._brushOwed < BRUSH_CADENCE) return;
  const k = Math.min(this._brushOwed, BRUSH_QUEUE_CAP);
  this._brushOwed = 0;

  const spread = clamp01((this.reach - WAVE_ORIGIN_REACH) / SPREAD_RANGE);
  const arc = ARC0 + (ARC1 - ARC0) * spread;
  const N = PLOUGH_SPAN;

  // Slightly behind the crest: the channel is what the wave has already
  // passed over, not what it is about to.
  const kx = this.ox + this.dx * (this.reach - BRUSH_LAG - CURVE);
  const kz = this.oz + this.dz * (this.reach - BRUSH_LAG - CURVE);
  const wx = this.dz;
  const wz = -this.dx;

  for (let i = 0; i < N; i++) {
   const u = i / (N - 1);
   const w = bell(u);
   if (w < BRUSH_WEIGHT_MIN) continue;
   const th = (u - 0.5) * 2 * arc;
   const cs = Math.cos(th);
   const sn = Math.sin(th);
   const rx = this.dx * cs + wx * sn;
   const rz = this.dz * cs + wz * sn;

   const x = kx + rx * CURVE;
   const z = kz + rz * CURVE;

   // The brush's long axis runs *along* the arc, so the trench is
   // continuous rather than a row of round pits. Yaw is the tangent.
   const yaw = Math.atan2(rz, -rx);

   f.brush(
    x, z,
    BRUSH_RADIUS,
    CHANNEL_DEPTH * k * env * w,   // channel
    BRUSH_BERM * k * env * w,   // berms at the rim
    BRUSH_PACK * k * env * w,   // slush packs what it runs over
    BRUSH_ICE * k * env * w,   // and refreezes a little of it
    yaw,
    BRUSH_ELONGATION,
    BRUSH_EDGE
   );
  }
 }

 /** Spray off the crest — thrown outward and back over the top. */
 _spray(travelled: number, env: number, height: number) {
  const ctx = this.ctx;
  const sp = ctx.spray;
  if (!sp || env < SPRAY_ENV_MIN) return;

  const perMetre = SPRAY_PER_METRE * ctx.sprayScale;
  this._sprayOwed += travelled;
  let count = (this._sprayOwed * perMetre) | 0;
  if (count <= 0) return;
  this._sprayOwed -= count / perMetre;
  if (count > SPRAY_CAP) count = SPRAY_CAP;

  const spread = clamp01((this.reach - WAVE_ORIGIN_REACH) / SPREAD_RANGE);
  const arc = ARC0 + (ARC1 - ARC0) * spread;
  const terrain = ctx.terrain;
  const wx = this.dz;
  const wz = -this.dx;
  const kx = this.ox + this.dx * (this.reach - CURVE);
  const kz = this.oz + this.dz * (this.reach - CURVE);

  for (let k = 0; k < count; k++) {
   const u = Math.random();
   const w = bell(u);
   if (w < SPRAY_WEIGHT_MIN) continue;
   const th = (u - 0.5) * 2 * arc;
   const cs = Math.cos(th);
   const sn = Math.sin(th);
   const rx = this.dx * cs + wx * sn;
   const rz = this.dz * cs + wz * sn;

   const amp = height * w;
   const d = SPRAY_BIRTH_D + (Math.random() - SPRAY_BIRTH_JITTER) * SPRAY_BIRTH_SPREAD;
   const x = kx + rx * d;
   const z = kz + rz * d;
   const y = terrain.heightAt(x, z)
    + amp * (SPRAY_HEIGHT_MIN + SPRAY_HEIGHT_SPREAD * Math.random());

   // Thrown forward and up, off the front of the crest.
   const out = THROW_BASE + Math.random() * THROW_JITTER;
   const clod = Math.random() < CLOD_PROBABILITY ? 1 : 0;
   sp.emit(
    x, y, z,
    rx * out + (Math.random() - RANDOM_CENTRE) * LATERAL_JITTER,
    RISE_BASE + Math.random() * RISE_JITTER + amp * RISE_AMP_GAIN,
    rz * out + (Math.random() - RANDOM_CENTRE) * LATERAL_JITTER,
    clod ? CLOD_RADIUS + Math.random() * CLOD_RADIUS_JITTER
     : DROP_RADIUS + Math.random() * DROP_RADIUS_JITTER,
    clod ? CLOD_LIFE + Math.random() * CLOD_LIFE_JITTER
     : DROP_LIFE + Math.random() * DROP_LIFE_JITTER,
    clod,
    clod ? CLOD_DRAG : DROP_DRAG + Math.random() * DROP_DRAG_JITTER
   );
  }
 }

 _end() {
  this.active = false;
  if (this.strand >= 0) {
   this.ctx.water.release(this.strand);
   this.strand = -1;
  }
 }

 cancel() {
  this._end();
 }
}
