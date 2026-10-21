/**
 * Spell 3 — Bloom.
 *
 * A targeted eruption. A column of powder and water bursts up out of the drift,
 * blowing a crater with a raised rim, then falls back as a slow glittering
 * curtain of fallout.
 *
 * Three things run on different clocks and that is the whole design:
 *
 *   the column   fast. Up in a third of a second, held for a beat, then it
 *                collapses back down its own axis rather than fading — the mass
 *                goes back where it came from.
 *   the crater   instant, and permanent. One brush, at the moment of the burst.
 *   the fallout  slow. Four seconds of it, and it is what the player is actually
 *                looking at for most of the spell. A burst with no fallout is a
 *                flash; a burst with fallout is weather.
 *
 * The column leans. A perfectly vertical cylinder of water reads as a rendered
 * primitive no matter what is on it, and two degrees of drift with a little
 * sway takes that away completely.
 */

import { PROFILE_TUBE } from "./waterBody.js";
import { clamp01, smooth01, bell, transport } from "./bending.js";

import type { SpellContext } from "./spellSystem.js";

const COLS = 34;

/** Full height of the column at peak, metres. */
const HEIGHT = 5.6;
/**
 * Radius of the column at its widest, metres.
 *
 * An eruption is a *mass* of material leaving the ground, and the aspect ratio
 * is most of what says so. The water material's absorption is keyed to the
 * radius as well, so a thin column is also a colourless one.
 */
const GIRTH = 0.66;

/** Seconds from cast to the column being gone. */
const LIFE = 1.75;

/** Seconds of fallout after that. */
const FALLOUT = 3.4;

// ---------------------------------------------------------------------------
// Column timing
// ---------------------------------------------------------------------------

/** Seconds from cast to the burst firing — the crater and the throw. */
const BURST_AT = 0.10;

/** Seconds the column takes to reach full height from the burst. */
const RISE_TIME = 0.34;

/** Seconds from the burst at which the column starts collapsing. */
const HOLD_TIME = 0.95;

/** Seconds the collapse runs, height returning to zero rather than fading. */
const COLLAPSE_TIME = 0.80;

/** Envelope below this — the column's visible radius is gone, stop drawing. */
const ENVELOPE_EPS = 0.002;

// ---------------------------------------------------------------------------
// Column lean and sway
// ---------------------------------------------------------------------------

/** Lean drift amplitude, metres — a random lean direction per cast. */
const LEAN_AMP = 0.16;

/** Sway rate, radians/second — a constant lean-drift oscillation frequency. */
const SWAY_RATE = 3.1;

/** Sway amplitude, metres — peak horizontal offset from lean plus sway. */
const SWAY_AMP = 0.12;

/** Sway attenuation on the depth axis — the lean reads stronger across. */
const SWAY_DEPTH = 0.6;

/**
 * Lean factor: converts a lean offset into the column centreline
 * displacement. Half, so the head's lean is half the lean offset.
 */
const LEAN_FACTOR = 0.5;

// ---------------------------------------------------------------------------
// Column radius shape — normalised radius profile against height fraction h
// ---------------------------------------------------------------------------

/** Radius at the shaft's thinnest, as a fraction of GIRTH. */
const SHAPE_BASE = 0.42;

/** Radial ripple base — the ripple wobbles around this multiple of shape. */
const SHAPE_RIPPLE_BASE = 0.9;

/** Column surface phase rate, radians/second — the relief drifts down it. */
const COLUMN_PHASE_RATE = 1.5;

/** Column alpha gain against the envelope — alpha peaks before env does. */
const COLUMN_ALPHA_GAIN = 1.5;

/** Milkiness while the column is still rising, matching SHAPE_BASE. */
const MILK_FULL = 0.42;

/** Milkiness once collapsed — zero radius, so it decollapses to nothing. */
const MILK_COLLAPSED = 0.5;

/** Waist weight: narrows the mid-shaft as bell() peaks. */
const SHAPE_WAIST = 0.58;

/** Waist peak position: fraction of height at which the shaft is thinnest. */
const SHAPE_WAIST_AT = 1.15;

/** Flare weight: the loose mass at the head spreading out. */
const SHAPE_FLARE = 0.55;

/** Flare onset: height fraction above which the flare term is active. */
const SHAPE_FLARE_AT = 0.72;

/** Flare width: height fraction over which the flare ramps in. */
const SHAPE_FLARE_WIDTH = 0.28;

/** Foot weight: the broad base where the column leaves the ground. */
const SHAPE_FOOT = 0.75;

/** Foot height: height fraction below which the foot term is full. */
const SHAPE_FOOT_HEIGHT = 0.22;

/** Radial ripple amplitude, metres — a sin() wobble around the shaft. */
const SHAPE_RIPPLE = 0.2;

/**
 * Foam at the column surface: the head is coming apart, the foot is grinding
 * against the crater rim. Normalised 0–1, same scale as the `SHAPE_*` block
 * above, and it is parameterised against the same height fraction `h`.
 */

/** Base foam present everywhere on the shaft. */
const FOAM_BASE = 0.30;

/** Foam weight of the head term — where the column is coming apart. */
const FOAM_HEAD = 0.55;

/** Foam head onset: height fraction above which the head term is active. */
const FOAM_HEAD_AT = 0.55;

/** Foam head width: height fraction over which the head term ramps in. */
const FOAM_HEAD_WIDTH = 0.45;

/** Foam weight of the foot term — grinding against the crater rim. */
const FOAM_FOOT = 0.4;

/** Foam foot height: height fraction below which the foot term is full. */
const FOAM_FOOT_HEIGHT = 0.18;

// ---------------------------------------------------------------------------
// Column lights — crater light and head light
// ---------------------------------------------------------------------------

/** Crater light height above the ground, metres. */
const CRATER_LIGHT_H = 0.35;

/** Crater light radius, metres — falloff reaches exactly zero here. */
const CRATER_LIGHT_R = 22.0;

/** Crater light intensity at full envelope. */
const CRATER_LIGHT_INTENSITY = 11.0;

/** Head light radius, metres. */
const HEAD_LIGHT_R = 9.0;

/** Head light intensity at full envelope. */
const HEAD_LIGHT_INTENSITY = 7.5;

/** Head light height at full column height, as a fraction of HEIGHT. */
const HEAD_LIGHT_TOP = 0.92;

// ---------------------------------------------------------------------------
// Crater brush — one deep brush plus a broken outer ring
// ---------------------------------------------------------------------------

/** Crater brush radius, metres. */
const CRATER_RADIUS = 1.15;

/** Crater brush depression depth, normalised deformation units. */
const CRATER_DEPRESS = 0.52;

/** Crater brush rim height — the mass has to go somewhere. */
const CRATER_RIM = 0.40;

/** Crater brush packing — soil compacted by the blast. */
const CRATER_PACK = 0.72;

/** Crater brush glazing — the surface partly melted and re-frozen. */
const CRATER_GLAZE = 0.30;

/** Crater brush ovality — slightly oval so it is not a stamped circle. */
const CRATER_OVAL = 1.15;

/** Number of brushes in the broken outer ring. */
const RING_BRUSHES = 4;

/** Outer-ring brush distance from centre, metres. */
const RING_DIST = 1.5;

/** Outer-ring brush distance jitter, metres. */
const RING_DIST_JITTER = 0.7;

/** Outer-ring brush radius, metres. */
const RING_RADIUS = 0.5;

/** Outer-ring brush radius jitter, metres. */
const RING_RADIUS_JITTER = 0.35;

/** Outer-ring brush angular jitter, radians. */
const RING_ANGLE_JITTER = 1.2;

/** Outer-ring brush rim height. */
const RING_RIM = 0.20;

/** Outer-ring brush rim jitter. */
const RING_RIM_JITTER = 0.14;

/** Outer-ring brush packed/glazed strength. */
const RING_PACK = 0.15;

/** Outer-ring brush ovality. */
const RING_OVAL = 1.4;

/** Camera trauma added at the burst. */
const BURST_TRAUMA = 0.28;

// ---------------------------------------------------------------------------
// Thrown snow and water — the instant of the burst
// ---------------------------------------------------------------------------

/** Droplets emitted at the burst, before sprayScale. */
const THROW_COUNT = 430;

/** Innermost radius of the throw ring — biased toward the rim, metres. */
const THROW_R_MIN = 0.35;

/** Outermost radius of the throw ring, metres. */
const THROW_R_SPAN = 1.25;

/** Minimum upward velocity, metres/second. */
const THROW_UP_MIN = 5.5;

/** Upward velocity jitter, metres/second. */
const THROW_UP_JITTER = 8.5;

/** Minimum outward velocity, metres/second. */
const THROW_OUT_MIN = 1.6;

/** Outward velocity jitter, metres/second. */
const THROW_OUT_JITTER = 5.0;

/** Probability a droplet is a heavy clod rather than spray. */
const CLOD_CHANCE = 0.26;

/** Fraction of the upward speed a clod keeps — it is heavier, so it lags. */
const CLOD_UP_FRACTION = 0.7;

/** Droplet birth height above the ground, metres. */
const SPAWN_H = 0.10;

/** Droplet birth height jitter, metres. */
const SPAWN_H_JITTER = 0.5;

/** Clod minimum radius, metres. */
const CLOD_R_MIN = 0.028;

/** Clod radius jitter, metres. */
const CLOD_R_JITTER = 0.038;

/** Spray minimum radius, metres. */
const SPRAY_R_MIN = 0.075;

/** Spray radius jitter, metres. */
const SPRAY_R_JITTER = 0.115;

/** Clod normalised size minimum. */
const CLOD_SIZE_MIN = 1.1;

/** Clod normalised size jitter. */
const CLOD_SIZE_JITTER = 0.8;

/** Spray normalised size minimum. */
const SPRAY_SIZE_MIN = 1.4;

/** Spray normalised size jitter. */
const SPRAY_SIZE_JITTER = 1.5;

/** Clod drag — ballistic, or it never leaves the crater. */
const CLOD_DRAG = 0.65;

/** Spray drag minimum — ballistic-ish. */
const SPRAY_DRAG_MIN = 1.1;

/** Spray drag jitter. */
const SPRAY_DRAG_JITTER = 0.8;

// ---------------------------------------------------------------------------
// Fallout curtain
// ---------------------------------------------------------------------------

/** Droplets per second emitted by the curtain, before sprayScale. */
const CURTAIN_RATE = 360;

/** Curtain delay before emission ramps in, seconds. */
const CURTAIN_DELAY = 0.25;

/** Curtain ramp-in window, seconds. */
const CURTAIN_RAMP = 0.5;

/** Curtain decay onset, seconds after cast. */
const CURTAIN_DECAY_AT = 0.9;

/** Fraction of the fallout window the curtain decays over. */
const CURTAIN_DECAY_SPAN = 0.9;

/** Curtain envelope below this — nothing worth emitting, seconds-normalised. */
const CURTAIN_EPS = 0.01;

/** Droplet emission cap per frame. */
const CURTAIN_CAP = 60;

/** Curtain disc radius, metres. */
const CURTAIN_RADIUS = 3.6;

/** Curtain emission height minimum, metres — above the player's eye line. */
const CURTAIN_H_MIN = 2.2;

/** Curtain emission height jitter, metres. */
const CURTAIN_H_JITTER = 4.2;

/** Curtain horizontal drift velocity, metres/second (sign is random). */
const CURTAIN_DRIFT = 0.9;

/** Centred-random centre — subtract to get a symmetric [-v, +v] drift. */
const CENTRE_RANDOM = 0.5;

/** Curtain fall velocity minimum, metres/second. */
const CURTAIN_FALL_MIN = 0.2;

/** Curtain fall velocity jitter, metres/second. */
const CURTAIN_FALL_JITTER = 1.1;

/** Curtain droplet minimum radius, metres. */
const CURTAIN_R_MIN = 0.028;

/** Curtain droplet radius jitter, metres. */
const CURTAIN_R_JITTER = 0.055;

/** Curtain droplet normalised size minimum. */
const CURTAIN_SIZE_MIN = 1.6;

/** Curtain droplet normalised size jitter. */
const CURTAIN_SIZE_JITTER = 1.9;

/** Curtain droplet drag — high, so it hangs and settles rather than flies. */
const CURTAIN_DRAG = 4.6;

const _rgt = new Float32Array(3);

export class Bloom {
 ctx!: SpellContext;
 active = false;
 strand = -1;
 t = 0;
 x = 0; y = 0; z = 0;
 _leanX = 0;
 _leanZ = 0;
 _burst = false;
 _curtainOwed = 0;

 constructor(ctx: SpellContext) {
  this.ctx = ctx;
  this.active = false;
  this.strand = -1;

  this.t = 0;
  this.x = 0;
  this.y = 0;
  this.z = 0;
  this._leanX = 0;
  this._leanZ = 0;
  this._burst = false;
  this._curtainOwed = 0;
 }

 /** @param {number} x @param {number} y @param {number} z ground target */
 trigger(x: number, y: number, z: number) {
  if (this.strand < 0) this.strand = this.ctx.water.acquire();
  this.x = x;
  this.y = y;
  this.z = z;
  this.t = 0;
  this._burst = false;
  this._curtainOwed = 0;
  // A different lean each cast, so two Blooms in the same place are not
  // the same object twice.
  const a = Math.random() * Math.PI * 2;
  this._leanX = Math.cos(a) * LEAN_AMP;
  this._leanZ = Math.sin(a) * LEAN_AMP;
  this.active = true;
 }

 /** @param {number} dt */
 update(dt: number) {
  if (!this.active) return;
  this.t += dt;

  if (this.t >= LIFE + FALLOUT) {
   this._end();
   return;
  }

  // ---- the burst ----------------------------------------------------
  // Fires once, on the frame the column reaches the surface. Everything
  // that happens at that instant — the crater, the ring of thrown snow,
  // the light spike — happens here rather than at trigger time, so they
  // are all the same event.
  if (!this._burst && this.t >= BURST_AT) {
   this._burst = true;
   this._crater();
   this._throw();
  }

  this._column();
  this._curtain(dt);
 }

 /**
  * The column.
  *
  * Radius runs wide at the base, waists in the middle and flares at the head,
  * which is what a real ejection does: the mass at the top has had the
  * longest to spread and the least to hold it together.
  */
 _column() {
  const ctx = this.ctx;
  const water = ctx.water;
  const s = this.strand;
  if (s < 0) return;

  const t = this.t;
  // Rise, hold, collapse. The collapse runs the height back down rather
  // than fading the alpha, so the column withdraws into the crater.
  const rise = smooth01((t - BURST_AT) / RISE_TIME);
  const drop = 1 - smooth01((t - HOLD_TIME) / COLLAPSE_TIME);
  const env = rise * drop;
  if (env <= ENVELOPE_EPS) {
   water.setParams(s, PROFILE_TUBE, MILK_COLLAPSED, 0, 0);
   return;
  }

  const top = HEIGHT * env;
  const sway = Math.sin(t * SWAY_RATE) * SWAY_AMP;

  let px = 0, py = 0, pz = 0;
  let rx = 1, ry = 0, rz = 0;
  let t0x = 0, t0y = 1, t0z = 0;

  for (let c = 0; c < COLS; c++) {
   const u = c / (COLS - 1);
   // Column 0 is the *head*, so `u` runs downward. That matches every
   // other strand in the project — u is always "distance behind the
   // leading edge" — and keeps the relief field drifting the right way.
   const h = 1 - u;
   const y = this.y + top * h;
   const lean = h * h;
   const x = this.x + (this._leanX + sway) * lean * top * LEAN_FACTOR;
   const z = this.z + (this._leanZ - sway * SWAY_DEPTH) * lean * top * LEAN_FACTOR;

   if (c > 0) {
    let t1x = x - px, t1y = y - py, t1z = z - pz;
    const l = Math.hypot(t1x, t1y, t1z) || 1e-4;
    t1x /= l; t1y /= l; t1z /= l;
    transport(_rgt, 0, rx, ry, rz, t0x, t0y, t0z, t1x, t1y, t1z);
    rx = _rgt[0]; ry = _rgt[1]; rz = _rgt[2];
    t0x = t1x; t0y = t1y; t0z = t1z;
   } else {
    rx = 1; ry = 0; rz = 0;
    t0x = 0; t0y = -1; t0z = 0;
   }

   // Flared head, waisted middle, broad foot.
   const shape =
    SHAPE_BASE + SHAPE_WAIST * bell(clamp01(h * SHAPE_WAIST_AT))       // waist
    + SHAPE_FLARE * smooth01((h - SHAPE_FLARE_AT) / SHAPE_FLARE_WIDTH)        // flare
    + SHAPE_FOOT * (1 - smooth01(h / SHAPE_FOOT_HEIGHT));          // foot
   const rad = GIRTH * shape * env * (SHAPE_RIPPLE_BASE + SHAPE_RIPPLE * Math.sin(u * 9 + t * 6));

   // The head is where it is coming apart; the foot is where it is
   // grinding against the crater rim.
   const foam = clamp01(FOAM_BASE + FOAM_HEAD * smooth01((h - FOAM_HEAD_AT) / FOAM_HEAD_WIDTH)
    + FOAM_FOOT * (1 - smooth01(h / FOAM_FOOT_HEIGHT)));

   water.column(
    s, c, x, y, z, rad,
    rx, ry, rz, t * COLUMN_PHASE_RATE + u * 4,
    u * top, u, foam, 1
   );

   px = x; py = y; pz = z;
  }

  water.setParams(s, PROFILE_TUBE, MILK_FULL, clamp01(env * COLUMN_ALPHA_GAIN), COLS);

  // Two lights: one down in the crater, one riding the head. The crater
  // one is what actually lights the rim and the fallout around the base,
  // and it is the reason the effect reads as a hole full of light rather
  // than a bright column standing on dark ground.
  ctx.lights.add(
   this.x, this.y + CRATER_LIGHT_H, this.z,
   CRATER_LIGHT_R, 0.44, 0.78, 1.0, CRATER_LIGHT_INTENSITY * env
  );
  ctx.lights.add(
   this.x + this._leanX * top * LEAN_FACTOR, this.y + top * HEAD_LIGHT_TOP, this.z + this._leanZ * top * LEAN_FACTOR,
   HEAD_LIGHT_R, 0.55, 0.82, 1.0, HEAD_LIGHT_INTENSITY * env
  );
 }

 /** The crater: one brush, deep, with a heavy rim. */
 _crater() {
  const ctx = this.ctx;
  ctx.deform.brush(
   this.x, this.z,
   CRATER_RADIUS,
   CRATER_DEPRESS,   // depression
   CRATER_RIM,   // rim — the mass has to go somewhere and this is where
   CRATER_PACK,   // packed by the blast
   CRATER_GLAZE,   // and partly glazed
   Math.random() * Math.PI,
   CRATER_OVAL,   // very slightly oval, so it is not a stamped circle
   1.0
  );
  // A broken outer ring, thrown clear of the rim. Four smaller brushes
  // rather than one wide one: a crater with a perfectly even rim is the
  // tell that gives a single radial brush away.
  for (let i = 0; i < RING_BRUSHES; i++) {
   const a = (i / RING_BRUSHES) * Math.PI * 2 + Math.random() * RING_ANGLE_JITTER;
   const d = RING_DIST + Math.random() * RING_DIST_JITTER;
   ctx.deform.brush(
    this.x + Math.cos(a) * d, this.z + Math.sin(a) * d,
    RING_RADIUS + Math.random() * RING_RADIUS_JITTER,
    0, RING_RIM + Math.random() * RING_RIM_JITTER, RING_PACK, 0,
    a, RING_OVAL, 1.0
   );
  }
  ctx.rig.addTrauma(BURST_TRAUMA);
 }

 /** The instant of the burst: a hard ring of thrown snow and water. */
 _throw() {
  const ctx = this.ctx;
  const sp = ctx.spray;
  if (!sp) return;
  const n = (THROW_COUNT * ctx.sprayScale) | 0;

  for (let k = 0; k < n; k++) {
   const a = Math.random() * Math.PI * 2;
   // Biased toward the rim, because that is where the mass leaves.
   const r = THROW_R_MIN + Math.sqrt(Math.random()) * THROW_R_SPAN;
   const up = THROW_UP_MIN + Math.random() * THROW_UP_JITTER;
   const out = THROW_OUT_MIN + Math.random() * THROW_OUT_JITTER;
   const clod = Math.random() < CLOD_CHANCE ? 1 : 0;

   sp.emit(
    this.x + Math.cos(a) * r,
    this.y + SPAWN_H + Math.random() * SPAWN_H_JITTER,
    this.z + Math.sin(a) * r,
    Math.cos(a) * out,
    up * (clod ? CLOD_UP_FRACTION : 1.0),
    Math.sin(a) * out,
    clod ? CLOD_R_MIN + Math.random() * CLOD_R_JITTER : SPRAY_R_MIN + Math.random() * SPRAY_R_JITTER,
    clod ? CLOD_SIZE_MIN + Math.random() * CLOD_SIZE_JITTER : SPRAY_SIZE_MIN + Math.random() * SPRAY_SIZE_JITTER,
    clod,
    // Ballistic, or it never leaves the crater.
    clod ? CLOD_DRAG : SPRAY_DRAG_MIN + Math.random() * SPRAY_DRAG_JITTER
   );
  }
 }

 /**
  * The fallout curtain.
  *
  * Fine, slow, high drag, and *emitted above the player's eye line* over a
  * wide disc, so it drifts down through the frame rather than sitting in a
  * cone over the crater. This is the part of the spell that lasts, and it is
  * also where the glinting has the best chance of being seen, since every
  * grain of it is lit by the crater light from below.
  * @param {number} dt
  */
 _curtain(dt: number) {
  const ctx = this.ctx;
  const sp = ctx.spray;
  if (!sp) return;

  const t = this.t;
  // Ramps in behind the burst and decays over the whole fallout window.
  const k = smooth01((t - CURTAIN_DELAY) / CURTAIN_RAMP) * (1 - smooth01((t - CURTAIN_DECAY_AT) / (FALLOUT * CURTAIN_DECAY_SPAN)));
  if (k <= CURTAIN_EPS) return;

  const rate = CURTAIN_RATE * ctx.sprayScale * k;
  this._curtainOwed += dt * rate;
  let count = this._curtainOwed | 0;
  if (count <= 0) return;
  this._curtainOwed -= count;
  if (count > CURTAIN_CAP) count = CURTAIN_CAP;

  for (let i = 0; i < count; i++) {
   const a = Math.random() * Math.PI * 2;
   const r = Math.sqrt(Math.random()) * CURTAIN_RADIUS;
   sp.emit(
    this.x + Math.cos(a) * r,
    this.y + CURTAIN_H_MIN + Math.random() * CURTAIN_H_JITTER,
    this.z + Math.sin(a) * r,
    (Math.random() - CENTRE_RANDOM) * CURTAIN_DRIFT,
    CURTAIN_FALL_MIN + Math.random() * CURTAIN_FALL_JITTER,
    (Math.random() - CENTRE_RANDOM) * CURTAIN_DRIFT,
    CURTAIN_R_MIN + Math.random() * CURTAIN_R_JITTER,
    CURTAIN_SIZE_MIN + Math.random() * CURTAIN_SIZE_JITTER,
    0,
    // High drag: this is meant to hang and settle, not to fly.
    CURTAIN_DRAG
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
