/**
 * Shared bending primitives.
 *
 * The five spells differ in what they do and agree on how they move. This is the
 * "how": easing that never snaps, a frame that never flips, and the two queries
 * against the world every one of them needs.
 *
 * Nothing here allocates.
 */

/** The height query every spell makes against the terrain. */
interface GroundQuery {
 heightAt(x: number, z: number): number;
}

/** Coarse-march step of `groundRay`, metres. */
const RAY_STEP = 0.6;
/** Bisection steps after a crossing is bracketed. Eight reaches ~1 cm. */
const REFINE_STEPS = 8;
/** Stand-in height when the ray starts below the surface, metres. */
const BURIED_EPS = 0.001;

/**
 * Standard gravity, m/s².
 *
 * Positive magnitude, subtracted wherever it applies: `ay -= GRAVITY`. Here
 * rather than in any one caller because the cloth solver, the ribbon's
 * ballistic arc and the snow grains all need it, and three files each
 * defining their own copy is exactly how a sign convention drifts apart.
 */
export const GRAVITY = 9.81;

/** @param {number} v */
export function clamp01(v: number): number {
 if (v < 0) return 0;
 if (v > 1) return 1;
 return v;
}

/** @param {number} v @param {number} lo @param {number} hi */
export function clampRange(v: number, lo: number, hi: number): number {
 if (v < lo) return lo;
 if (v > hi) return hi;
 return v;
}

/** Hermite smoothstep on an already-normalised parameter. @param {number} t */
export function smooth01(t: number): number {
 const x = clamp01(t);
 return x * x * (3 - 2 * x);
}

/**
 * A bell that is zero at both ends and one in the middle, with zero slope
 * everywhere it matters.
 *
 * Used for every amplitude envelope in the spells. A linear ramp leaves a
 * visible corner at both ends of every arc, and the grammar here is "no instant
 * spawns, no instant despawns".
 * @param {number} t
 */
export function bell(t: number): number {
 const x = clamp01(t);
 const s = Math.sin(Math.PI * x);
 return s * s;
}

/** Framerate-independent exponential approach. @param {number} cur @param {number} target @param {number} rate @param {number} dt */
export function expDamp(cur: number, target: number, rate: number, dt: number): number {
 return target + (cur - target) * Math.exp(-rate * dt);
}

/**
 * Rotate a reference vector by the minimal rotation taking `t0` to `t1`.
 *
 * This is what keeps a swept section from spinning as its spine curves. The
 * obvious alternatives both fail on the shapes these spells draw:
 *
 *   Frenet frame       undefined wherever the spine is momentarily straight,
 *                      and it flips through 180 degrees at every inflection —
 *                      which a figure-eight has two of, by definition.
 *   up-referenced      degenerate wherever the spine passes through vertical,
 *                      which a ribbon thrown overhead does constantly.
 *
 * Parallel transport has no degeneracy at all: each frame is the previous one
 * rotated by the smallest rotation that lines the tangents up, so it only ever
 * turns as much as the curve does.
 *
 * Writes the transported right vector into `out[o..o+2]`.
 *
 * @param {Float32Array} out @param {number} o
 * @param {number} rx @param {number} ry @param {number} rz
 * @param {number} t0x @param {number} t0y @param {number} t0z
 * @param {number} t1x @param {number} t1y @param {number} t1z
 */
export function transport(out: Float32Array, o: number, rx: number, ry: number, rz: number, t0x: number, t0y: number, t0z: number, t1x: number, t1y: number, t1z: number) {
 // Axis and angle of the rotation taking t0 to t1.
 let ax = t0y * t1z - t0z * t1y;
 let ay = t0z * t1x - t0x * t1z;
 let az = t0x * t1y - t0y * t1x;
 const s = Math.hypot(ax, ay, az);

 if (s < 1e-7) {
  // Parallel or antiparallel. Antiparallel cannot happen between adjacent
  // samples of a spine sampled every few centimetres, so this is the
  // straight-line case and the frame simply carries over.
  out[o] = rx; out[o + 1] = ry; out[o + 2] = rz;
  return;
 }

 ax /= s; ay /= s; az /= s;
 const c = t0x * t1x + t0y * t1y + t0z * t1z;
 const ang = Math.atan2(s, c);
 const cs = Math.cos(ang);
 const sn = Math.sin(ang);

 // Rodrigues.
 const dot = ax * rx + ay * ry + az * rz;
 const cx = ay * rz - az * ry;
 const cy = az * rx - ax * rz;
 const cz = ax * ry - ay * rx;

 let ox = rx * cs + cx * sn + ax * dot * (1 - cs);
 let oy = ry * cs + cy * sn + ay * dot * (1 - cs);
 let oz = rz * cs + cz * sn + az * dot * (1 - cs);

 const l = Math.hypot(ox, oy, oz) || 1;
 out[o] = ox / l; out[o + 1] = oy / l; out[o + 2] = oz / l;
}

/**
 * Where a ray meets the snow.
 *
 * A coarse march followed by a bisection refine, against the CPU height mirror.
 * Eight refinement steps put the hit inside a centimetre, which is finer than
 * anything downstream of this can express.
 *
 * The march deliberately does not stop at the first sample below the surface if
 * the ray *starts* below it — a targeting ray fired from inside a drift should
 * come out of the drift and hit the far side, not report a hit at the origin.
 *
 * @param {{heightAt(x:number,z:number):number}} terrain
 * @param {number} ox @param {number} oy @param {number} oz
 * @param {number} dx @param {number} dy @param {number} dz
 * @param {number} maxDist
 * @returns {number} distance along the ray, or -1 for a miss
 */
function groundRay(terrain: GroundQuery, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
 const STEP = RAY_STEP;

 let prevT = 0;
 let prevAbove = oy - terrain.heightAt(ox, oz);
 if (prevAbove < 0) prevAbove = BURIED_EPS; // started buried; treat as above

 for (let t = STEP; t <= maxDist; t += STEP) {
  const x = ox + dx * t;
  const y = oy + dy * t;
  const z = oz + dz * t;
  const above = y - terrain.heightAt(x, z);

  if (above <= 0) {
   let lo = prevT;
   let hi = t;
   for (let k = 0; k < REFINE_STEPS; k++) {
    const mid = (lo + hi) * 0.5;  // bisection midpoint
    const my = oy + dy * mid;
    if (my - terrain.heightAt(ox + dx * mid, oz + dz * mid) > 0) lo = mid;
    else hi = mid;
   }
   return (lo + hi) * 0.5;
  }
  prevT = t;
  prevAbove = above;
 }
 return -1;
}

/**
 * Where the player is aiming, on the ground.
 *
 * Falls back to a fixed distance ahead when the ray misses — looking up at the
 * sky and pressing a key has to do *something*, and putting the effect at a sane
 * distance in front of the player is the only answer that is never surprising.
 *
 * Writes (x, y, z) into `out`.
 *
 * @param {Float32Array} out
 * @param {{heightAt(x:number,z:number):number}} terrain
 * @param {number} ox @param {number} oy @param {number} oz
 * @param {number} dx @param {number} dy @param {number} dz
 * @param {number} maxDist @param {number} fallback
 */
export function aimPoint(out: Float32Array, terrain: GroundQuery, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, fallback: number): number {
 const t = groundRay(terrain, ox, oy, oz, dx, dy, dz, maxDist);
 if (t > 0) {
  out[0] = ox + dx * t;
  out[1] = oy + dy * t;
  out[2] = oz + dz * t;
  return t;
 }
 // Flatten the direction and step out, then drop onto the surface.
 const fl = Math.hypot(dx, dz) || 1;
 out[0] = ox + (dx / fl) * fallback;
 out[2] = oz + (dz / fl) * fallback;
 out[1] = terrain.heightAt(out[0], out[2]);
 return fallback;
}
