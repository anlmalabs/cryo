/**
 * Procedural character geometry.
 *
 * Nothing here is authored in a DCC tool. Every surface is a lofted tube, a
 * swept ring or a Bezier-blended shell evaluated from the bind-pose skeleton, so
 * the whole figure is a few hundred lines of tables and a smooth-normal pass.
 *
 * Three meshes come out, because three different vertex programs drive them:
 *
 *   body   linearly blend-skinned to the bones — head, cowl, torso, arms,
 *          trousers, boots, belt.
 *   cloth  driven from the simulated garment grids, sampled with Catmull-Rom in
 *          the vertex shader so a 24x14 solve renders as a smooth surface.
 *   fur    shell fur: the same rim ring emitted N times, each pushed further
 *          along its normal, alpha-tested into strands.
 *
 * Normals are never derived analytically. Everything is built as positions plus
 * indices and then run through one area-weighted smooth-normal pass, which is
 * both less code and immune to the sign errors that analytic normals on a swept
 * surface invite. Closed rings share their seam vertex rather than duplicating
 * it, so the seam is smooth too.
 *
 * Build time only — none of this runs after load, and it allocates freely.
 *
 * Port note: `scene` in the signatures is the Babylon parameter; here it is the
 * `gfx` device layer, kept for signature parity. The meshes come back bare —
 * material assignment and draw-list registration happen in `character.js`.
 */

import * as THREE from "three";
import type { Gfx } from "../core/gfx.js";
import type { CharacterMeshMetadata } from "./character.js";
import type { ClothPanel } from "./cloth.js";
import {
 B_ROOT, B_SPINE, B_CHEST, B_NECK, B_HEAD, B_HOOD,
 B_UPPER_L, B_FORE_L, B_HAND_L, B_UPPER_R, B_FORE_R, B_HAND_R,
 B_THIGH_L, B_SHIN_L, B_FOOT_L, B_THIGH_R, B_SHIN_R, B_FOOT_R,
} from "./figure.js";

// ------------------------------------------------------------- material slots
export const M_ROBE = 0;     // deep indigo wool
export const M_MANTLE = 1;   // lighter blue-grey over-mantle
const M_TUNIC = 2;    // pale cream under-layer
const M_LEATHER = 3;  // belt and boots
const M_SKIN = 4;     // face, deep in shade
const M_TRIM = 5;     // pale blue banding
const M_FUR = 6;      // hood and cuff trim

/** Segments around a limb. 14 is smooth at the distances this is seen from. */
const SEG = 14;

/**
 * Paired body parts are built twice: once per side, index 0 mirrored to `-1`
 * and index 1 at `+1`. One pass per body side.
 */
const SIDE_COUNT = 2;

// ------------------------------------------------------------------- skull

/**
 * The skull is a half-ellipsoid swept as rings. These are metres, bind
 * space, measured from the head centre.
 */
const SKULL_RINGS = 8;      // rings from the crown down to the jaw
const SKULL_RADIUS = 0.105; // radius of the sweep, metres
const SKULL_RY = 0.089;     // section half-width on the face axis, metres
const SKULL_RZ = 0.096;     // section half-depth, metres
const SKULL_R_MIN = 0.004;  // section collapse at the poles, metres
const SKULL_Z_PULL = 0.006; // rings drift forward toward the crown, metres
const SKULL_OCCLUSION = 0.22; // baked occlusion of the shaded cavity, 0..1

// ------------------------------------------------------------ section geometry

/**
 * Cap centre placement: a fraction of the larger section radius, pushed out
 * along the ring's own axis. Ratio of metres, dimensionless.
 */
const CAP_EXTENT = 0.7;

/**
 * Spine blend bands, by bind-pose height in metres, with the blend's own
 * height in metres. Each band is a height threshold where the weight of the
 * next bone takes over.
 */
const SPINE_BASE_TOP = 1.06;     // metres: below this, root and spine blend
const SPINE_BASE_FROM = 0.88;    // metres: bottom of the root/spine blend
const SPINE_BASE_SPAN = 0.18;    // metres: height the root/spine blend spans
const SPINE_MID_TOP = 1.26;      // metres: below this, spine and chest blend
const SPINE_MID_SPAN = 0.20;     // metres: height the spine/chest blend spans
const SPINE_TOP_SPAN = 0.20;     // metres: height the chest/neck blend spans

/** How far each blend reaches up the next bone's influence, as a ratio. */
const SPINE_BASE_NEXT = 0.5;     // fraction of the upper bone's weight gained
const SPINE_TOP_NEXT = 0.35;     // fraction of the upper bone's weight gained

/**
 * A mesh out of this module: every builder finishes by attaching build stats —
 * triangle count, vertex count, and on the fur mesh the shell flag — which the
 * perf HUD and the material pass read. Three's `Mesh` has no such field, so the
 * shape is named once here and the callers consume it structurally.
 */
export type BuilderMesh = THREE.Mesh & { metadata: CharacterMeshMetadata };

// -----------------------------------------------------------------------------

class Builder {
 /** Position, xyz per vertex, metres in bind space. */
 pos: number[] = [];
 /** Normal, xyz per vertex. Zeroed until the smooth pass or an override. */
 nrm: number[] = [];
 /** Texture coordinates, uv per vertex, metres of surface. */
 uv: number[] = [];
 /** Material slot and baked occlusion, two scalars per vertex. */
 aux: number[] = [];
 /** Bone index for each of two influences, two per vertex. */
 bi: number[] = [];
 /** Bone weight for each of two influences, two per vertex. */
 bw: number[] = [];
 /** Triangle list as vertex indices. */
 idx: number[] = [];
 /** Set when `nrm` is written directly and must skip the smooth pass. */
 explicitNormals: boolean;

 constructor() {
  this.pos = [];
  this.nrm = [];
  this.uv = [];
  this.aux = [];
  this.bi = [];
  this.bw = [];
  this.idx = [];
  this.explicitNormals = false;
 }

 /**
  * @param x metres, bind space
  * @param y metres, bind space
  * @param z metres, bind space
  * @param u metres of surface along the sweep
  * @param v metres of surface around the section
  * @param matId material slot
  * @param ao baked occlusion, 0..1
  * @param b0 bone index, first influence
  * @param w0 bone weight, first influence
  * @param b1 bone index, second influence, 0 when unused
  * @param w1 bone weight, second influence, 0 when unused
  * @returns {number} the new vertex's index
  */
 vert(x: number, y: number, z: number, u: number, v: number, matId: number, ao: number, b0: number, w0: number, b1: number, w1: number): number {
  this.pos.push(x, y, z);
  this.nrm.push(0, 0, 0);
  this.uv.push(u, v);
  this.aux.push(matId, ao);
  this.bi.push(b0, b1 || 0, 0, 0);
  this.bw.push(w0, w1 || 0, 0, 0);
  return this.pos.length / 3 - 1;
 }

 /**
  * @param vi vertex index to overwrite
  * @param x normal x
  * @param y normal y
  * @param z normal z
  */
 normal(vi: number, x: number, y: number, z: number): void {
  this.nrm[vi * 3] = x;
  this.nrm[vi * 3 + 1] = y;
  this.nrm[vi * 3 + 2] = z;
 }

 /**
  * @param a first vertex index
  * @param b second vertex index
  * @param c third vertex index
  */
 tri(a: number, b: number, c: number): void {
  this.idx.push(a, b, c);
 }

 /**
  * @param a first vertex index
  * @param b second vertex index
  * @param c third vertex index
  * @param d fourth vertex index
  */
 quad(a: number, b: number, c: number, d: number): void {
  // Both diagonals of every quad get used across the mesh, alternating is
  // not worth the bookkeeping on shapes this smooth.
  this.idx.push(a, b, c, a, c, d);
 }
}

/**
 * Area-weighted smooth normals.
 *
 * Area weighting rather than plain averaging: a long thin triangle at a cap
 * would otherwise pull the pole normal off toward its own plane.
 */
/** @param {Float32Array} pos vertex positions, xyz per vertex, metres
 *  @param {Uint32Array} idx triangle list
 *  @returns {Float32Array} unit normals, xyz per vertex
 */
function computeNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
 const n = new Float32Array(pos.length);
 for (let i = 0; i < idx.length; i += 3) {
  const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
  const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
  const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
  // Un-normalised cross product: its length is twice the triangle area,
  // which is exactly the weight we want.
  const fx = uy * vz - uz * vy;
  const fy = uz * vx - ux * vz;
  const fz = ux * vy - uy * vx;
  n[a] += fx; n[a + 1] += fy; n[a + 2] += fz;
  n[b] += fx; n[b + 1] += fy; n[b + 2] += fz;
  n[c] += fx; n[c + 1] += fy; n[c + 2] += fz;
 }
 for (let i = 0; i < n.length; i += 3) {
  const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
  n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
 }
 return n;
}

/**
 * Loft a closed tube through a list of rings.
 *
 * Each ring is `[cx, cy, cz, rx, rz, ao, b0, w0, b1, w1]` and the cross-section
 * plane is derived from the direction to the neighbouring rings, so a limb that
 * bends in the bind pose still gets circular sections rather than sheared ones.
 *
 * @param {Builder} B
 * @param {number[][]} rings
 * @param {number} matId
 * @param {[number,number,number]} ref reference axis the section frame avoids
 */
/** @param {Builder} B @param {number[][]} rings @param {number} matId @param {[number,number,number]} ref @param {boolean} capStart @param {boolean} capEnd */
function loft(B: Builder, rings: number[][], matId: number, ref: [number, number, number], capStart: boolean, capEnd: boolean): void {
 const n = rings.length;
 const first = [];
 let prevRow = null;
 let vAcc = 0;

 for (let r = 0; r < n; r++) {
  const cur = rings[r];
  const prev = rings[Math.max(0, r - 1)];
  const next = rings[Math.min(n - 1, r + 1)];

  let ax = next[0] - prev[0], ay = next[1] - prev[1], az = next[2] - prev[2];
  let al = Math.hypot(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;

  // U = axis x ref, W = axis x U — the two axes of the section plane.
  let ux = ay * ref[2] - az * ref[1];
  let uy = az * ref[0] - ax * ref[2];
  let uz = ax * ref[1] - ay * ref[0];
  let ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const wx = ay * uz - az * uy;
  const wy = az * ux - ax * uz;
  const wz = ax * uy - ay * ux;

  if (r > 0) {
   vAcc += Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]);
  }

  // Texture coordinates are metres of surface, not normalised. Every
  // scale in the fabric shader — the weave, the yarn slub — is a physical
  // size, and normalised UVs would make each of them a different size on
  // every part of the body.
  const circ = Math.PI * (cur[3] + cur[4]);

  const row = [];
  for (let s = 0; s < SEG; s++) {
   const a = (s / SEG) * Math.PI * 2;
   const ca = Math.cos(a), sa = Math.sin(a);
   const px = cur[0] + ux * cur[3] * sa + wx * cur[4] * ca;
   const py = cur[1] + uy * cur[3] * sa + wy * cur[4] * ca;
   const pz = cur[2] + uz * cur[3] * sa + wz * cur[4] * ca;
   row.push(B.vert(
    px, py, pz,
    (s / SEG) * circ, vAcc,
    matId, cur[5], cur[6], cur[7], cur[8], cur[9]
   ));
  }

  if (prevRow) {
   for (let s = 0; s < SEG; s++) {
    const s2 = (s + 1) % SEG;
    B.quad(prevRow[s], prevRow[s2], row[s2], row[s]);
   }
  }
  if (r === 0) first.push(...row);
  prevRow = row;
 }

 // Caps: a fan to a centre vertex placed on the ring's own axis.
 if (capStart) capRing(B, rings[0], rings[1], first, matId, true);
 if (capEnd) capRing(B, rings[n - 1], rings[n - 2], prevRow || [], matId, false);
}

/** @param {Builder} B @param {number[]} ring @param {number[]} neighbour @param {number[]} row @param {number} matId @param {boolean} isStart */
function capRing(B: Builder, ring: number[], neighbour: number[], row: number[], matId: number, isStart: boolean): void {
 let ax = ring[0] - neighbour[0], ay = ring[1] - neighbour[1], az = ring[2] - neighbour[2];
 const al = Math.hypot(ax, ay, az) || 1;
 ax /= al; ay /= al; az /= al;
 const ext = Math.max(ring[3], ring[4]) * CAP_EXTENT;
 const c = B.vert(
  ring[0] + ax * ext, ring[1] + ay * ext, ring[2] + az * ext,
  0.5, 0.5, matId, ring[5], ring[6], ring[7], ring[8], ring[9]
 );
 for (let s = 0; s < SEG; s++) {
  const s2 = (s + 1) % SEG;
  if (isStart) B.tri(c, row[s2], row[s]);
  else B.tri(c, row[s], row[s2]);
 }
}

/** Bone blend along the spine, by bind-pose height. */
/** @param {number} y bind-pose height in metres
 *  @returns {number[]} `[bone0, weight0, bone1, weight1]`
 */
function spineBones(y: number): number[] {
 if (y < SPINE_BASE_TOP) {
  const t = Math.min(1, Math.max(0, (y - SPINE_BASE_FROM) / SPINE_BASE_SPAN));
  return [B_ROOT, 1 - t * SPINE_BASE_NEXT, B_SPINE, t * SPINE_BASE_NEXT];
 }
 if (y < SPINE_MID_TOP) {
  const t = (y - SPINE_BASE_TOP) / SPINE_MID_SPAN;
  return [B_SPINE, 1 - t, B_CHEST, t];
 }
 const t = Math.min(1, (y - SPINE_MID_TOP) / SPINE_TOP_SPAN);
 return [B_CHEST, 1 - t * SPINE_TOP_NEXT, B_NECK, t * SPINE_TOP_NEXT];
}

/** Ring helper: `[cx,cy,cz, rx,rz, ao, b0,w0,b1,w1]`. */
/** @param {number} cx ring centre x, metres
 *  @param {number} cy ring centre y, metres
 *  @param {number} cz ring centre z, metres
 *  @param {number} rx section radius along U, metres
 *  @param {number} rz section radius along W, metres
 *  @param {number} ao baked occlusion, 0..1
 *  @param {number[]} bones `[b0, w0, b1, w1]`
 *  @returns {number[]} the ring as `[cx,cy,cz, rx,rz, ao, b0,w0,b1,w1]`
 */
function ring(cx: number, cy: number, cz: number, rx: number, rz: number, ao: number, bones: number[]): number[] {
 return [cx, cy, cz, rx, rz, ao, bones[0], bones[1], bones[2], bones[3]];
}

/** Rings along a straight bone segment, interpolating radius and bone weights. */
/** @param {number} x0 segment start x, metres
 *  @param {number} y0 segment start y, metres
 *  @param {number} z0 segment start z, metres
 *  @param {number} x1 segment end x, metres
 *  @param {number} y1 segment end y, metres
 *  @param {number} z1 segment end z, metres
 *  @param {number} r0 radius at the start, metres
 *  @param {number} r1 radius at the end, metres
 *  @param {number} steps rings to emit, excluding both ends
 *  @param {number} boneA bone index at the start
 *  @param {number} boneB bone index at the end
 *  @param {number} ao baked occlusion, 0..1
 *  @param {number} from parameter where the weight ramp starts
 *  @param {number} to parameter where the weight ramp ends
 *  @returns {number[][]} the rings
 */
function limbRings(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r0: number, r1: number, steps: number, boneA: number, boneB: number, ao: number, from: number, to: number): number[][] {
 const out = [];
 for (let i = 0; i <= steps; i++) {
  const t = i / steps;
  // Weight ramps from boneA to boneB across the segment's lower half, so
  // the joint bends smoothly instead of creasing at one ring.
  const w = Math.min(1, Math.max(0, (t - from) / (to - from)));
  const r = r0 + (r1 - r0) * t;
  out.push(ring(
   x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t,
   r, r, ao, [boneA, 1 - w, boneB, w]
  ));
 }
 return out;
}

// -----------------------------------------------------------------------------
//  Body
// -----------------------------------------------------------------------------

/**
 * The figure under the garments: head, cowl, torso, arms, trousers, boots.
 *
 * Most of this is only seen in slivers — the robe covers the torso, the mantle
 * covers the shoulders. What is genuinely on screen is the hood silhouette, the
 * boots, and the forearms, so that is where the ring counts go.
 */
/** @param {Gfx} scene unused — the Babylon parameter name kept for signature
 *  parity; here it is the `gfx` device layer
 *  @returns {BuilderMesh} the body mesh
 */
export function buildBody(scene: Gfx): BuilderMesh {
 const B = new Builder();

 // ---- torso ------------------------------------------------------------
 const torso = [];
 const TORSO = [
  [0.88, 0.150, 0.120], [0.98, 0.142, 0.113], [1.06, 0.134, 0.106],
  [1.14, 0.140, 0.109], [1.22, 0.156, 0.118], [1.30, 0.172, 0.126],
  [1.38, 0.176, 0.126], [1.44, 0.160, 0.116],
 ];
 for (let i = 0; i < TORSO.length; i++) {
  const [y, rx, rz] = TORSO[i];
  torso.push(ring(0, y, 0, rx, rz, 0.72, spineBones(y)));
 }
 loft(B, torso, M_TRIM, [0, 0, 1], true, false);

 // ---- belt -------------------------------------------------------------
 const belt = [
  ring(0, 0.955, 0, 0.153, 0.124, 0.62, spineBones(0.955)),
  ring(0, 0.995, 0, 0.160, 0.130, 0.70, spineBones(0.995)),
  ring(0, 1.035, 0, 0.152, 0.123, 0.62, spineBones(1.035)),
 ];
 loft(B, belt, M_LEATHER, [0, 0, 1], false, false);

 // ---- neck + head ------------------------------------------------------
 const neck = [
  ring(0, 1.42, -0.005, 0.062, 0.058, 0.35, [B_NECK, 1, B_HEAD, 0]),
  ring(0, 1.50, 0.000, 0.058, 0.055, 0.30, [B_NECK, 0.5, B_HEAD, 0.5]),
  ring(0, 1.56, 0.002, 0.062, 0.060, 0.28, [B_HEAD, 1, 0, 0]),
 ];
 loft(B, neck, M_SKIN, [0, 0, 1], false, false);

 // The skull. Deliberately featureless: the face stays in shadow under the
 // cowl, and a half-finished face is far worse than a silhouette. It carries
 // a heavy baked occlusion so the cavity reads dark even when the sun swings
 // round to face it.
 const head = [];
 for (let i = 0; i <= SKULL_RINGS; i++) {
  const a = (i / SKULL_RINGS) * Math.PI;
  const y = HEAD_C[1] - Math.cos(a) * SKULL_RADIUS;
  const r = Math.sin(a);
  head.push(ring(
   0, y, HEAD_C[2] + r * SKULL_Z_PULL,
   SKULL_RY * r + SKULL_R_MIN, SKULL_RZ * r + SKULL_R_MIN,
   SKULL_OCCLUSION, [B_HEAD, 1, 0, 0]
  ));
 }
 loft(B, head, M_SKIN, [0, 0, 1], true, true);

 // A scarf across the lower face, as in the reference. It is what stops the
 // shadowed skull reading as an empty hood.
 const scarf = [
  ring(0, 1.560, 0.010, 0.086, 0.092, 0.30, [B_HEAD, 1, 0, 0]),
  ring(0, 1.600, 0.012, 0.094, 0.100, 0.34, [B_HEAD, 1, 0, 0]),
  ring(0, 1.638, 0.008, 0.092, 0.098, 0.30, [B_HEAD, 1, 0, 0]),
 ];
 loft(B, scarf, M_TRIM, [0, 0, 1], false, false);

 buildHood(B);

 // ---- arms -------------------------------------------------------------
 for (let a = 0; a < SIDE_COUNT; a++) {
  const s = a === 0 ? -1 : 1;
  const up = a === 0 ? B_UPPER_L : B_UPPER_R;
  const fo = a === 0 ? B_FORE_L : B_FORE_R;
  const hd = a === 0 ? B_HAND_L : B_HAND_R;

  const upper = limbRings(
   s * 0.185, 1.400, 0, s * 0.230, 1.123, 0,
   0.064, 0.050, 4, up, fo, 0.55, 0.72, 1.0
  );
  loft(B, upper, M_ROBE, [0, 0, 1], true, false);

  const fore = limbRings(
   s * 0.230, 1.123, 0, s * 0.243, 0.866, 0.016,
   0.050, 0.042, 4, fo, hd, 0.62, 0.75, 1.0
  );
  loft(B, fore, M_ROBE, [0, 0, 1], false, false);

  // The hand is a mitt. Fingers at this distance are three pixels of
  // noise; a clean silhouette reads better and costs nothing.
  const hand = [
   ring(s * 0.243, 0.866, 0.016, 0.044, 0.038, 0.55, [hd, 1, 0, 0]),
   ring(s * 0.245, 0.820, 0.024, 0.050, 0.040, 0.55, [hd, 1, 0, 0]),
   ring(s * 0.247, 0.780, 0.032, 0.046, 0.036, 0.52, [hd, 1, 0, 0]),
   ring(s * 0.248, 0.752, 0.038, 0.030, 0.026, 0.50, [hd, 1, 0, 0]),
  ];
  loft(B, hand, M_LEATHER, [0, 0, 1], false, true);
 }

 // ---- legs and boots ---------------------------------------------------
 for (let l = 0; l < SIDE_COUNT; l++) {
  const s = l === 0 ? -1 : 1;
  const th = l === 0 ? B_THIGH_L : B_THIGH_R;
  const sh = l === 0 ? B_SHIN_L : B_SHIN_R;
  const ft = l === 0 ? B_FOOT_L : B_FOOT_R;

  const thigh = limbRings(
   s * 0.100, 0.905, 0, s * 0.100, 0.460, 0,
   0.114, 0.086, 5, th, sh, 0.5, 0.74, 1.0
  );
  loft(B, thigh, M_ROBE, [0, 0, 1], true, false);

  // Trousers narrow to the ankle then flare into the boot shaft.
  const shin = [
   ring(s * 0.100, 0.460, 0, 0.086, 0.086, 0.55, [sh, 1, 0, 0]),
   ring(s * 0.100, 0.360, 0.004, 0.076, 0.076, 0.55, [sh, 1, 0, 0]),
   ring(s * 0.100, 0.270, 0.006, 0.070, 0.070, 0.52, [sh, 1, 0, 0]),
   ring(s * 0.100, 0.200, 0.006, 0.075, 0.076, 0.48, [sh, 0.6, ft, 0.4]),
   ring(s * 0.100, 0.140, 0.004, 0.080, 0.082, 0.44, [sh, 0.25, ft, 0.75]),
   ring(s * 0.100, 0.100, 0.000, 0.074, 0.078, 0.42, [ft, 1, 0, 0]),
  ];
  loft(B, shin, M_ROBE, [0, 0, 1], false, false);

  // The boot runs along the foot's own axis, so it swings with the ankle
  // roll rather than being a block bolted to the shin.
  const boot = [
   ring(s * 0.100, 0.055, -0.088, 0.046, 0.052, 0.35, [ft, 1, 0, 0]),
   ring(s * 0.100, 0.058, -0.050, 0.056, 0.066, 0.38, [ft, 1, 0, 0]),
   ring(s * 0.100, 0.054, 0.010, 0.058, 0.060, 0.42, [ft, 1, 0, 0]),
   ring(s * 0.100, 0.048, 0.078, 0.056, 0.050, 0.45, [ft, 1, 0, 0]),
   ring(s * 0.100, 0.043, 0.142, 0.050, 0.043, 0.48, [ft, 1, 0, 0]),
   ring(s * 0.100, 0.040, 0.190, 0.033, 0.031, 0.48, [ft, 1, 0, 0]),
  ];
  loft(B, boot, M_LEATHER, [0, 1, 0], true, true);
 }

 return finishSkinned(scene, "charBody", B);
}

/**
 * The cowl.
 *
 * Built as a swept Bezier: each strand runs from a point on the face-opening rim
 * to a point on the ring where the hood meets the shoulders, bowed outward by a
 * control point that is pushed furthest over the crown. That gives a genuinely
 * deep hood with a rolled opening, rather than a sphere with a hole in it.
 *
 * The rim curve this produces is reused verbatim by the fur trim, so the two can
 * never drift apart.
 */
const HOOD_COLS = 34;
const HOOD_ROWS = 9;
const HEAD_C: [number, number, number] = [0, 1.655, 0.005];
const FACE_DIR: [number, number, number] = (() => {
 const v: [number, number, number] = [0, -0.28, 0.96];
 const l = Math.hypot(v[0], v[1], v[2]);
 return [v[0] / l, v[1] / l, v[2] / l];
})();

/**
 * The cowl's rim: an ellipse around the head centre, metres, bind space.
 */
const RIM_RISE = 0.105; // rim centre, along the face direction, metres
const RIM_HALF_WIDTH = 0.152; // half the rim's horizontal axis, metres
const RIM_HALF_HEIGHT = 0.163; // half the rim's vertical axis, metres

/**
 * The ring where the cowl meets the shoulders, metres, bind space.
 */
const HOOD_BASE_RADIUS = 0.212; // half-width of that ring, metres
const HOOD_BASE_Y = 1.352; // height of that ring, metres
const HOOD_BASE_Z = -0.012; // its centre fore-and-aft, metres
const HOOD_BASE_DEPTH = 0.182; // half the ring's fore-and-aft axis, metres

/**
 * Cowl volume, metres, bind space. The control point sits out from the head
 * centre by a radius that is widest over the crown and tightest at the throat,
 * which is what gives the cowl its peak.
 */
const HOOD_RADIUS_BASE = 0.205; // radius at the throat, metres
const HOOD_RADIUS_CROWN = 0.062; // extra radius over the crown, metres
/** Baked occlusion: the inside of a cowl sees almost no sky, 0..1. */
const HOOD_AO_BASE = 0.34;
const HOOD_AO_INSIDE = 0.55; // extra occlusion where the sweep is fully deep
const HOOD_AO_FULL = 2.2; // sweep parameter at which the deep end is reached
/** UVs in metres: the rim is about a metre round, the sweep about 45 cm. */
const HOOD_UV_AROUND = 1.02;
const HOOD_UV_SWEEP = 0.45;

/** Face-opening rim point at parameter `s` (0 = crown, 0.5 = under the chin). */
/** @param {number} s rim parameter
 *  @param {number[]} out receives `[x, y, z]` in metres, bind space
 *  @returns {number[]} `out`, for chaining
 */
function hoodRimPoint(s: number, out: number[]): number[] {
 const a = s * Math.PI * 2;
 // U spans the rim horizontally, W vertically, both perpendicular to FACE_DIR.
 const ux = 1, uy = 0, uz = 0;
 const wx = FACE_DIR[1] * uz - FACE_DIR[2] * uy;
 const wy = FACE_DIR[2] * ux - FACE_DIR[0] * uz;
 const wz = FACE_DIR[0] * uy - FACE_DIR[1] * ux;
 const cx = HEAD_C[0] + FACE_DIR[0] * RIM_RISE;
 const cy = HEAD_C[1] + FACE_DIR[1] * RIM_RISE;
 const cz = HEAD_C[2] + FACE_DIR[2] * RIM_RISE;
 out[0] = cx + ux * RIM_HALF_WIDTH * Math.sin(a) + wx * RIM_HALF_HEIGHT * Math.cos(a);
 out[1] = cy + uy * RIM_HALF_WIDTH * Math.sin(a) + wy * RIM_HALF_HEIGHT * Math.cos(a);
 out[2] = cz + uz * RIM_HALF_WIDTH * Math.sin(a) + wz * RIM_HALF_HEIGHT * Math.cos(a);
 return out;
}

/** @param {number} s rim parameter
 *  @param {number[]} out receives `[x, y, z]` in metres, bind space
 *  @returns {number[]} `out`, for chaining
 */
function hoodBasePoint(s: number, out: number[]): number[] {
 const a = s * Math.PI * 2;
 out[0] = HOOD_BASE_RADIUS * Math.sin(a);
 out[1] = HOOD_BASE_Y;
 out[2] = HOOD_BASE_Z - HOOD_BASE_DEPTH * Math.cos(a);
 return out;
}

/** @param {Builder} B */
function buildHood(B: Builder): void {
 const rim = [0, 0, 0];
 const base = [0, 0, 0];
 let prevRow = null;

 for (let r = 0; r <= HOOD_ROWS; r++) {
  const t = r / HOOD_ROWS;
  const row = [];
  for (let c = 0; c < HOOD_COLS; c++) {
   const s = c / HOOD_COLS;
   hoodRimPoint(s, rim);
   hoodBasePoint(s, base);

   // Control point.
   //
   // Not the chord's midpoint pushed away from the skull: at the crown
   // the chord runs from a rim point above and in front of the head to
   // a base point below and behind it, straight through the skull, so
   // its midpoint is already inside the head and "away from the head
   // centre" points down into the shoulders.
   //
   // The control direction has to be stated, not derived. It sweeps
   // from up-and-back over the crown, through sideways at the temples,
   // to down-and-forward under the chin — which is the same sweep the
   // rim parameter already makes, so it comes straight off `s`.
   const a = s * Math.PI * 2;
   const sa = Math.sin(a), ca = Math.cos(a);
   let nx = sa * 1.0;
   let ny = ca * 0.84;
   let nz = ca * -0.54;
   const nl = Math.hypot(nx, ny, nz) || 1;
   nx /= nl; ny /= nl; nz /= nl;
   // Radius out from the head: widest over the crown, tightest at the
   // throat, which is what gives the cowl its peak.
   const rad = HOOD_RADIUS_BASE + HOOD_RADIUS_CROWN * ca;
   const mx = HEAD_C[0] + nx * rad;
   const my = HEAD_C[1] + ny * rad;
   const mz = HEAD_C[2] + nz * rad;

   const it = 1 - t;
   const px = it * it * rim[0] + 2 * it * t * mx + t * t * base[0];
   const py = it * it * rim[1] + 2 * it * t * my + t * t * base[1];
   const pz = it * it * rim[2] + 2 * it * t * mz + t * t * base[2];

   // Occlusion: the inside of a cowl sees almost no sky. It is the
   // single cheapest thing that makes a hood read as deep.
   const ao = HOOD_AO_BASE + HOOD_AO_INSIDE * Math.min(1, t * HOOD_AO_FULL);
   // UVs in metres: the rim is about a metre round and the sweep from
   // rim to shoulder about 45 cm.
   row.push(B.vert(px, py, pz, s * HOOD_UV_AROUND, t * HOOD_UV_SWEEP, M_ROBE, ao, B_HOOD, 1, 0, 0));
  }
  if (prevRow) {
   for (let c = 0; c < HOOD_COLS; c++) {
    const c2 = (c + 1) % HOOD_COLS;
    B.quad(prevRow[c], prevRow[c2], row[c2], row[c]);
   }
  }
  prevRow = row;
 }
}

// -----------------------------------------------------------------------------
//  Fur
// -----------------------------------------------------------------------------

/** Shells per fur band. Below about 18 the layering is visible as banding. */
const HOOD_SHELLS = 22;
const CUFF_SHELLS = 18;

/**
 * Fur band on the hood rim, metres, bind space.
 */
const HOOD_FUR_COLS = 26; // positions around the band
const HOOD_FUR_RISE = 0.45; // band's tilt toward the face direction, ratio
const HOOD_FUR_RADIUS = 0.024; // band's core thickness, metres
const HOOD_FUR_LENGTH = 0.048; // strand length beyond the core, metres
const HOOD_FUR_AO = 0.62; // baked occlusion, 0..1

/**
 * Fur band on each cuff, metres, bind space.
 */
const CUFF_FUR_COLS = 12; // positions around the band
const CUFF_FUR_RADIUS_X = 0.240; // band centre's distance from the spine, metres
const CUFF_FUR_RADIUS_Y = 0.066; // band's radius about the forearm, metres
const CUFF_FUR_Y = 0.900; // band centre's height, metres
const CUFF_FUR_Z = 0.012; // band centre's depth, metres
const CUFF_FUR_RADIUS_Z = 0.064; // band's radius fore-and-aft, metres
const CUFF_FUR_RADIUS = 0.015; // band's core thickness, metres
const CUFF_FUR_LENGTH = 0.032; // strand length beyond the core, metres
const CUFF_FUR_AO = 0.52; // baked occlusion, 0..1

/**
 * Shell fur.
 *
 * A trim band is modelled as a partial torus around the edge it decorates: a
 * ring of cross-sections, each an arc of directions pointing away from the
 * garment. That surface is then emitted once per shell, each copy pushed
 * further along its own direction, and the fragment shader alpha-tests a hashed
 * strand field whose threshold rises with the shell parameter — so strands
 * taper, end at different lengths, and the band reads as fur rather than as a
 * smooth sausage.
 *
 * Bone-bound rather than cloth-bound, deliberately: the hood rim rides the hood
 * bone and the cuffs ride the forearms, both of which are rigid. Binding fur to
 * a simulated surface would need the shell direction to come out of the cloth
 * solve — a second vertex program, for very little visible gain.
 */
/** @param {Gfx} scene unused — the Babylon parameter name kept for signature
 *  parity; here it is the `gfx` device layer
 *  @returns {BuilderMesh} the fur mesh
 */
export function buildFur(scene: Gfx): BuilderMesh {
 const B = new Builder();
 B.explicitNormals = true;
 const p = [0, 0, 0];

 // ---- hood rim ---------------------------------------------------------
 // The band's outward direction is the rim's own bisector: away from the
 // skull, tilted along the face direction so the trim frames the opening.
 const cols = HOOD_FUR_COLS;
 const bases = new Float32Array(cols * 3);
 const outs = new Float32Array(cols * 3);
 for (let c = 0; c < cols; c++) {
  hoodRimPoint(c / cols, p);
  bases[c * 3] = p[0]; bases[c * 3 + 1] = p[1]; bases[c * 3 + 2] = p[2];
  let dx = p[0] - HEAD_C[0], dy = p[1] - HEAD_C[1], dz = p[2] - HEAD_C[2];
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx = dx / dl + FACE_DIR[0] * HOOD_FUR_RISE;
  dy = dy / dl + FACE_DIR[1] * HOOD_FUR_RISE;
  dz = dz / dl + FACE_DIR[2] * HOOD_FUR_RISE;
  const l2 = Math.hypot(dx, dy, dz) || 1;
  outs[c * 3] = dx / l2; outs[c * 3 + 1] = dy / l2; outs[c * 3 + 2] = dz / l2;
 }
 emitFurBand(B, cols, bases, outs, HOOD_FUR_RADIUS, HOOD_FUR_LENGTH, HOOD_SHELLS, B_HOOD, HOOD_FUR_AO);

 // ---- cuffs ------------------------------------------------------------
 for (let a = 0; a < SIDE_COUNT; a++) {
  const s = a === 0 ? -1 : 1;
  const bone = a === 0 ? B_FORE_L : B_FORE_R;
  const n = CUFF_FUR_COLS;
  const cb = new Float32Array(n * 3);
  const co = new Float32Array(n * 3);
  // The forearm runs almost straight down in the bind pose, so the band's
  // ring sits in the XZ plane around it and its outward is radial.
  for (let c = 0; c < n; c++) {
   const ang = (c / n) * Math.PI * 2;
   const rx = Math.sin(ang), rz = Math.cos(ang);
   // Sits on the sleeve at the wrist, just above the loose cuff rows,
   // where the garment is pinned hard enough that a bone-bound band
   // cannot visibly separate from it.
   cb[c * 3] = s * CUFF_FUR_RADIUS_X + rx * CUFF_FUR_RADIUS_Y;
   cb[c * 3 + 1] = CUFF_FUR_Y;
   cb[c * 3 + 2] = CUFF_FUR_Z + rz * CUFF_FUR_RADIUS_Z;
   co[c * 3] = rx; co[c * 3 + 1] = 0; co[c * 3 + 2] = rz;
  }
  emitFurBand(B, n, cb, co, CUFF_FUR_RADIUS, CUFF_FUR_LENGTH, CUFF_SHELLS, bone, CUFF_FUR_AO);
 }

 return finishSkinned(scene, "charFur", B, true);
}

/** Cross-section steps across a fur band, and the arc they cover. */
const FUR_ARC_STEPS = 4;
const FUR_ARC = 2.1; // radians, centred on the outward direction

/**
 * One fur band.
 *
 * @param {Builder} B
 * @param {number} cols positions around the ring
 * @param {Float32Array} bases ring positions, 3 floats each
 * @param {Float32Array} outs unit outward direction per ring position
 * @param {number} r0 radius of the band's core, metres
 * @param {number} len strand length beyond the core, metres
 * @param {number} shells
 * @param {number} bone
 * @param {number} ao
 */
/** @param {Builder} B @param {number} cols @param {Float32Array} bases @param {Float32Array} outs @param {number} r0 @param {number} len @param {number} shells @param {number} bone @param {number} ao */
function emitFurBand(B: Builder, cols: number, bases: Float32Array, outs: Float32Array, r0: number, len: number, shells: number, bone: number, ao: number): void {
 const dir = new Float32Array((cols * (FUR_ARC_STEPS + 1)) * 3);

 // Precompute the cross-section directions once: each is the outward vector
 // rotated about the ring's own tangent.
 for (let c = 0; c < cols; c++) {
  const cn = (c + 1) % cols;
  const cp = (c - 1 + cols) % cols;
  let tx = bases[cn * 3] - bases[cp * 3];
  let ty = bases[cn * 3 + 1] - bases[cp * 3 + 1];
  let tz = bases[cn * 3 + 2] - bases[cp * 3 + 2];
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;

  const ox = outs[c * 3], oy = outs[c * 3 + 1], oz = outs[c * 3 + 2];
  // Third axis of the cross-section plane.
  const ax = ty * oz - tz * oy;
  const ay = tz * ox - tx * oz;
  const az = tx * oy - ty * ox;

  for (let k = 0; k <= FUR_ARC_STEPS; k++) {
   const phi = (k / FUR_ARC_STEPS - 0.5) * FUR_ARC;
   const cs = Math.cos(phi), sn = Math.sin(phi);
   const o = (c * (FUR_ARC_STEPS + 1) + k) * 3;
   dir[o] = ox * cs + ax * sn;
   dir[o + 1] = oy * cs + ay * sn;
   dir[o + 2] = oz * cs + az * sn;
  }
 }

 // Arc length around the ring, so the strand field has a uniform pitch in
 // metres regardless of how big the band is. The shader multiplies this by a
 // density in cells per metre; anything else makes hood fur and cuff fur
 // come out at different scales.
 const arc = new Float32Array(cols + 1);
 for (let c = 1; c <= cols; c++) {
  const a = ((c - 1) % cols) * 3;
  const b = (c % cols) * 3;
  arc[c] = arc[c - 1] + Math.hypot(
   bases[b] - bases[a], bases[b + 1] - bases[a + 1], bases[b + 2] - bases[a + 2]
  );
 }

 const stride = FUR_ARC_STEPS + 1;
 for (let s = 0; s < shells; s++) {
  const t = s / (shells - 1);
  const rowBase = B.pos.length / 3;

  for (let c = 0; c <= cols; c++) {
   const ci = c % cols;
   for (let k = 0; k <= FUR_ARC_STEPS; k++) {
    const o = (ci * stride + k) * 3;
    const dx = dir[o], dy = dir[o + 1], dz = dir[o + 2];
    const rad = r0 + len * t;
    const across = (k / FUR_ARC_STEPS - 0.5) * FUR_ARC * r0;
    const vi = B.vert(
     bases[ci * 3] + dx * rad,
     bases[ci * 3 + 1] + dy * rad,
     bases[ci * 3 + 2] + dz * rad,
     arc[c], across,
     t, ao, bone, 1, 0, 0
    );
    B.normal(vi, dx, dy, dz);
   }
  }

  // Shells are independent sheets: each is stitched only to itself, never
  // to its neighbours. That is the whole idea — the gaps between them are
  // where you see through to the shell behind.
  for (let c = 0; c < cols; c++) {
   for (let k = 0; k < FUR_ARC_STEPS; k++) {
    const a = rowBase + c * stride + k;
    B.quad(a, a + 1, a + stride + 1, a + stride);
   }
  }
 }
}

// -----------------------------------------------------------------------------

/** @param {Gfx} scene unused — the Babylon parameter name kept for signature
 *  parity; here it is the `gfx` device layer
 *  @param {string} name mesh name
 *  @param {Builder} B the vertex data to finalise
 *  @param {boolean} [isFur] true when `B.nrm` holds authored normals
 *  @returns {BuilderMesh} the skinned mesh
 */
function finishSkinned(scene: Gfx, name: string, B: Builder, isFur: boolean = false): BuilderMesh {
 const pos = new Float32Array(B.pos);
 const idx = new Uint32Array(B.idx);
 const nrm = B.explicitNormals ? new Float32Array(B.nrm) : computeNormals(pos, idx);

 const geometry = new THREE.BufferGeometry();
 geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
 geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
 geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(B.uv), 2));
 geometry.setAttribute("aux", new THREE.BufferAttribute(new Float32Array(B.aux), 2));
 geometry.setAttribute("boneIdx", new THREE.BufferAttribute(new Float32Array(B.bi), 4));
 geometry.setAttribute("boneWt", new THREE.BufferAttribute(new Float32Array(B.bw), 4));
 geometry.setIndex(new THREE.BufferAttribute(idx, 1));

 const mesh = new THREE.Mesh(geometry) as BuilderMesh;
 mesh.name = name;

 // The mesh is placed entirely by the vertex shader from bone matrices, so
 // its world matrix is the identity for ever and its bounding box is a lie.
 mesh.frustumCulled = false;
 mesh.matrixAutoUpdate = false;
 mesh.metadata = {
  triangles: idx.length / 3, vertices: pos.length / 3, fur: !!isFur,
 };
 return mesh;
}

// -----------------------------------------------------------------------------
//  Cloth render mesh
// -----------------------------------------------------------------------------

/**
 * The render mesh for the simulated garments.
 *
 * It carries no positions of its own — `position` is `(u, v, panelIndex)` and
 * the vertex shader reconstructs the surface by Catmull-Rom interpolation of the
 * panel's simulated node grid. That decoupling is what lets a 24x14 verlet solve
 * render as a smooth 48x28 surface, and it means the sim cost is independent of
 * how finely the garment is tessellated.
 *
 * @param {ClothPanel[]} panels
 */
/** @param {Gfx} scene unused — the Babylon parameter name kept for signature
 *  parity; here it is the `gfx` device layer
 *  @param {ClothPanel[]} panels
 *  @returns {BuilderMesh} the cloth render mesh
 */
export function buildClothMesh(scene: Gfx, panels: ClothPanel[]): BuilderMesh {
 const pos: number[] = [];
 const uv: number[] = [];
 const aux: number[] = [];
 const idx: number[] = [];

 for (let pi = 0; pi < panels.length; pi++) {
  const p = panels[pi];
  const cu = p.renderCols;
  const cv = p.renderRows;
  const base = pos.length / 3;

  for (let j = 0; j <= cv; j++) {
   const v = j / cv;
   for (let i = 0; i <= cu; i++) {
    const u = i / cu;
    pos.push(u, v, pi);
    uv.push(u * p.weaveU, v * p.weaveV);
    // (matId, ao). Garments darken toward the hem, where they sit in
    // their own folds and close to the ground.
    aux.push(p.matId, p.aoTop + (p.aoBottom - p.aoTop) * v);
   }
  }

  const stride = cu + 1;
  for (let j = 0; j < cv; j++) {
   for (let i = 0; i < cu; i++) {
    const a = base + j * stride + i;
    const b = a + 1;
    const c = a + stride;
    const d = c + 1;
    idx.push(a, b, d, a, d, c);
   }
  }
 }

 const geometry = new THREE.BufferGeometry();
 geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
 geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
 geometry.setAttribute("aux", new THREE.BufferAttribute(new Float32Array(aux), 2));
 geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));

 const mesh = new THREE.Mesh(geometry) as BuilderMesh;
 mesh.name = "charCloth";
 mesh.frustumCulled = false;
 mesh.matrixAutoUpdate = false;
 mesh.metadata = { triangles: idx.length / 3, vertices: pos.length / 3 };
 return mesh;
}
