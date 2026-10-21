/**
 * Garment simulation — verlet cloth on coarse grids.
 *
 * Each garment is a closed tube of particles, `cols` around by `rows` down.
 * The grids are deliberately coarse (twenty by twelve for the robe) because the
 * render mesh does not use them directly: the vertex shader reconstructs a
 * smooth surface from them with Catmull-Rom, so tessellation and simulation cost
 * are completely decoupled. Doubling the visible smoothness costs nothing here.
 *
 * Every particle carries a bind-pose position and one bone. Its kinematic target
 * each frame is that bind position pushed through the bone's skinning matrix —
 * exactly what a rigidly-skinned vertex would do. A per-particle `pinRate`
 * decides how hard it is pulled toward that target, in units of 1/second:
 *
 *   Infinity   the waistband, the collar, the shoulder of a sleeve. Welded.
 *   10-60      follows the body closely, with a frame or two of give.
 *   1-5        follows loosely — this is where a garment starts to read as cloth.
 *   0.2-0.5    shape memory only. Stops a free hem from slowly collapsing into
 *              a rope without meaningfully resisting motion.
 *
 * Expressing the pull as a rate rather than a per-frame blend is not a detail:
 * a "0.05 blend" applied 165 times a second is a 12 ms time constant, which is
 * a weld. Anything time-based in a system that also has to survive a frame-rate
 * change has to be written as a rate.
 *
 * Wind is *apparent* wind — the field wind minus the character's own velocity —
 * with quadratic drag, so the robe whips back hard during a snow-surf run
 * without needing a special case for it.
 *
 * Allocation: none per frame. All state is typed arrays sized at construction.
 */

import { S } from "../core/settings.js";
import { clamp01, GRAVITY } from "../spells/bending.js";
import {
 B_ROOT, B_CHEST, B_UPPER_L, B_FORE_L, B_HAND_L,
 B_UPPER_R, B_FORE_R, B_HAND_R, B_NECK, B_SHIN_L, B_SHIN_R,
 B_THIGH_L, B_THIGH_R, B_FOOT_L, B_FOOT_R,
 type Figure,
} from "./figure.js";
import type { CharacterController } from "./controller.js";
import { M_ROBE, M_MANTLE } from "./build.js";

// -----------------------------------------------------------------------------
//  Solver tuning
// -----------------------------------------------------------------------------

/** Which body capsules a panel is allowed to collide against. */
const C_TORSO = 1;
const C_LEGS = 2;
const C_ARM_L = 4;
const C_ARM_R = 8;

/** Constraint relaxation iterations. Six is where the robe stops looking rubbery. */
const ITERATIONS = 6;

/**
 * Float stride of one point. `pos`, `prev`, `target` and `bindPos` are packed
 * as XYZ triples per particle; `joint` is the same triple per bone.
 */
const FLOATS_PER_POINT = 3;

/** Float stride of a column-major `mat4` in the skinning matrix array. */
const MAT4_FLOATS = 16;

/** Bending constraints only engage on the last three of `ITERATIONS` passes. */
const BEND_START_ITERATION = ITERATIONS - 3;

/** Bending stiffness on those late passes. Solved hard it fights the distance
 *  constraints and the garment goes stiff. */
const BEND_STIFFNESS = 0.22;

/** Stiffness for the distance constraints, which are solved hard. */
const LINK_STIFFNESS = 1;

/** Two sub-steps below this frame time, seconds. Verlet with hard pins is
 *  stable, but a long step lets the hem overshoot through the legs before the
 *  collision pass sees it. */
const SUBSTEP_MIN_H = 1 / 55;

/** Longest permitted sub-step, seconds — the 30 Hz floor the solver holds. */
const MAX_SUBSTEP_H = 1 / 30;

/** Sub-steps taken once a frame is split. Two spans the whole frame. */
const SPLIT_STEPS = 2;

/** Quadratic drag coefficient against the apparent wind. At walking pace this
 *  is a fraction of gravity; at nineteen metres a second it is four times it,
 *  which is what lays the robe out flat behind a surf run. */
const WIND_DRAG = 0.085;

/** Peak field wind speed, m/s, before the gust envelope and turbulence. */
const WIND_SPEED = 3.2;

/** Fraction of the drag that also becomes turbulence, m/s² per m/s. */
const TURBULENCE_FROM_DRAG = 0.25;

/** Turbulence floor, m/s², scaled by the wind strength. A purely drag-driven
 *  turbulence vanishes at rest — the robe would hang dead still whenever the
 *  gust envelope passed through zero, which is the one moment the eye is most
 *  likely to catch it. The floor is small: a couple of centimetres of ripple at
 *  the hem, no silhouette change. */
const TURBULENCE_FLOOR = 0.18;

/** Velocity damping per 1/60 s of elapsed sim time, applied as an exact
 *  exponential relative to that reference rate. */
const DAMP_PER_SIXTIETH = 0.90;

/** Frames per second the damping constant is normalised against. */
const DAMP_REFERENCE_FPS = 60;

/** How far the hem is held above the sampled snow surface, metres. The hem
 *  rides on the snow rather than through it. */
const GROUND_CLEARANCE = 0.012;

/** Full turn around a ring, radians. */
const TAU = Math.PI * 2;

/** Degrees to radians, for the wind bearing. */
const DEG_TO_RAD = Math.PI / 180;

/**
 * Coincident-particle guard, metres. Two particles closer than this are treated
 * as one point and the constraint is skipped rather than dividing by a length
 * that would blow the panel apart.
 */
const DEGENERATE_EPS = 1e-7;

/** Coincident-point guard for the capsule push, metres. Below this the particle
 *  sits on the capsule axis and the push direction is undefined. */
const DEGENERATE_PUSH_EPS = 1e-6;

/** Zero-length bone-axis fallback, metres². A degenerate capsule would make the
 *  projection `t` undefined, so its squared length falls back to this. */
const DEGENERATE_AXIS_EPS2 = 1e-6;

/** Skin flags for the sleeve maker: which arm a panel is pinned to. */
const SIDE_LEFT = 0;
const SIDE_RIGHT = 1;

/** Capsule table: [boneA, boneB, radius, mask]. Rebuilt from joints each frame. */
const CAPSULES = [
 [B_ROOT, B_NECK, 0.175, C_TORSO],
 [B_THIGH_L, B_SHIN_L, 0.125, C_LEGS],
 [B_SHIN_L, B_FOOT_L, 0.098, C_LEGS],
 [B_THIGH_R, B_SHIN_R, 0.125, C_LEGS],
 [B_SHIN_R, B_FOOT_R, 0.098, C_LEGS],
 [B_UPPER_L, B_FORE_L, 0.078, C_ARM_L],
 [B_FORE_L, B_HAND_L, 0.068, C_ARM_L],
 [B_UPPER_R, B_FORE_R, 0.078, C_ARM_R],
 [B_FORE_R, B_HAND_R, 0.068, C_ARM_R],
];

/**
 * The surface a garment rests on. Structural rather than the concrete `Terrain`
 * class, so a panel can be solved against a bare heightfield.
 */
interface TerrainLike {
 /** Snow height at a horizontal position, metres above the datum. */
 heightAt(x: number, z: number): number;
}

/**
 * One `[t, a, b]` control point of a `curve()` lookup: the parameter, then the
 * two outputs that rail interpolates — radius across and radius deep.
 */
type CurvePoint = [number, number, number];

/** Authored panel layout, before the solver sizes any arrays from it. */
interface ClothPanelSpec {
 /** Name, for diagnostics and transform-texture row bookkeeping. */
 name: string;
 /** Particles around the ring. */
 cols: number;
 /** Particles down the panel. */
 rows: number;
 /** Material id this panel renders with. */
 matId: number;
 /** Render-mesh resolution across, decoupled from `cols` by the shader. */
 renderCols: number;
 /** Render-mesh resolution down, decoupled from `rows` by the shader. */
 renderRows: number;
 /** Weave tiling across the surface, metres. */
 weaveU: number;
 /** Weave tiling down the surface, metres. */
 weaveV: number;
 /** Ambient-occlusion strength at the top edge. */
 aoTop: number;
 /** Ambient-occlusion strength at the bottom edge. */
 aoBottom: number;
 /** Which body capsules this panel collides against (`C_*` mask). */
 collide: number;
 /** Rows at the bottom that check the snow surface. Defaults to 0. */
 groundRows?: number;
}

export class ClothPanel {
 /** Name, for diagnostics and transform-texture row bookkeeping. */
 name: string;
 /** Particles around the ring. */
 cols: number;
 /** Particles down the panel. */
 rows: number;
 /** Material id this panel renders with. */
 matId: number;
 /** Render-mesh resolution across, decoupled from `cols` by the shader. */
 renderCols: number;
 /** Render-mesh resolution down, decoupled from `rows` by the shader. */
 renderRows: number;
 /** Weave tiling across the surface, metres. */
 weaveU: number;
 /** Weave tiling down the surface, metres. */
 weaveV: number;
 /** Ambient-occlusion strength at the top edge. */
 aoTop: number;
 /** Ambient-occlusion strength at the bottom edge. */
 aoBottom: number;
 /** Which body capsules this panel collides against (`C_*` mask). */
 collide: number;
 /** Rows at the bottom that check the snow surface. */
 groundRows: number;
 /** Row in the shared transform texture where this panel's grid starts. */
 nodeRow: number;

 /** Particle count, `cols * rows`. */
 count: number;
 /** Bind-pose position, XYZ triple per particle. The garment's rest shape. */
 bindPos: Float32Array;
 /** Current position, XYZ triple per particle. */
 pos: Float32Array;
 /** Previous-step position, XYZ triple per particle, for Verlet. */
 prev: Float32Array;
 /** Skinned kinematic target for this step, XYZ triple per particle. */
 target: Float32Array;
 /** Bone each particle is skinned by. */
 bone: Int32Array;
 /** Pull rate toward `target`, 1/second. `Infinity` means welded. */
 pinRate: Float32Array;
 /** Rest length around the ring, metres. */
 restU: Float32Array;
 /** Rest length down the panel, metres. */
 restV: Float32Array;
 /** Rest length of the bending pair two rows apart, metres. */
 restB: Float32Array;

 /** @param {ClothPanelSpec} spec */
 constructor(spec: ClothPanelSpec) {
  this.name = spec.name;
  this.cols = spec.cols;
  this.rows = spec.rows;
  this.matId = spec.matId;
  this.renderCols = spec.renderCols;
  this.renderRows = spec.renderRows;
  this.weaveU = spec.weaveU;
  this.weaveV = spec.weaveV;
  this.aoTop = spec.aoTop;
  this.aoBottom = spec.aoBottom;
  this.collide = spec.collide;
  /** Rows at the bottom that check the snow surface. */
  this.groundRows = spec.groundRows || 0;
  /** Row in the shared transform texture where this panel's grid starts. */
  this.nodeRow = 0;

  const n = this.cols * this.rows;
  this.count = n;
  const packed = n * FLOATS_PER_POINT;
  this.bindPos = new Float32Array(packed);
  this.pos = new Float32Array(packed);
  this.prev = new Float32Array(packed);
  this.target = new Float32Array(packed);
  this.bone = new Int32Array(n);
  this.pinRate = new Float32Array(n);

  // Rest lengths: around the ring, down the panel, and the bending pair
  // two rows apart. Measured from the bind pose, so the garment's rest
  // shape *is* its authored shape.
  this.restU = new Float32Array(n);
  this.restV = new Float32Array(n);
  this.restB = new Float32Array(n);
 }

 /** Called once the bind positions are filled in. */
 finalise() {
  const { cols, rows, bindPos } = this;
  for (let j = 0; j < rows; j++) {
   for (let i = 0; i < cols; i++) {
    const a = (j * cols + i) * FLOATS_PER_POINT;
    const bu = (j * cols + ((i + 1) % cols)) * FLOATS_PER_POINT;
    this.restU[j * cols + i] = dist3(bindPos, a, bindPos, bu);
    if (j + 1 < rows) {
     const bv = ((j + 1) * cols + i) * FLOATS_PER_POINT;
     this.restV[j * cols + i] = dist3(bindPos, a, bindPos, bv);
    }
    if (j + 2 < rows) {
     const bb = ((j + 2) * cols + i) * FLOATS_PER_POINT;
     this.restB[j * cols + i] = dist3(bindPos, a, bindPos, bb);
    }
   }
  }
  this.pos.set(bindPos);
  this.prev.set(bindPos);
 }
}

/** @param {Float32Array} a @param {number} ia @param {Float32Array} b @param {number} ib @returns {number} */
function dist3(a: Float32Array, ia: number, b: Float32Array, ib: number): number {
 return Math.hypot(a[ia] - b[ib], a[ia + 1] - b[ib + 1], a[ia + 2] - b[ib + 2]);
}

// -----------------------------------------------------------------------------
//  Garment shapes
// -----------------------------------------------------------------------------

/** Piecewise-linear lookup over a table of `[t, a, b]` control points. */
/** @param {CurvePoint[]} table @param {number} t @returns {number[]} */
function curve(table: CurvePoint[], t: number): number[] {
 let i = 0;
 while (i < table.length - 2 && t > table[i + 1][0]) i++;
 const A = table[i], Bb = table[i + 1];
 const s = Bb[0] > A[0] ? (t - A[0]) / (Bb[0] - A[0]) : 0;
 const k = Math.min(1, Math.max(0, s));
 return [A[1] + (Bb[1] - A[1]) * k, A[2] + (Bb[2] - A[2]) * k];
}

/**
 * The robe: a long tube from the waist, flaring to a hem that is cut high at
 * the front so the boots read, and trails behind. The asymmetry is what makes
 * the silhouette move when the figure turns.
 */
function makeRobe() {
 const p = new ClothPanel({
  // Thirty-six columns is set by the fold count, not by smoothness: nine
  // pleats need four samples each to survive the grid at all, and the
  // Catmull-Rom reconstruction turns four samples per fold into a clean
  // wave. Twenty columns aliased them into a wobble.
  name: "robe", cols: 36, rows: 12, matId: M_ROBE,
  renderCols: 72, renderRows: 32,
  // Metres of surface, so the shader's weave and slub scales are physical.
  weaveU: 1.75, weaveV: 1.05,
  aoTop: 0.55, aoBottom: 0.42,
  collide: C_TORSO | C_LEGS, groundRows: 2,
 });

 const RATE = [Infinity, 30, 10, 4, 1.6, 0.9, 0.55, 0.4, 0.35, 0.3, 0.3, 0.3];

 for (let j = 0; j < p.rows; j++) {
  const v = j / (p.rows - 1);
  for (let i = 0; i < p.cols; i++) {
   const a = (i / p.cols) * TAU;
   const sa = Math.sin(a), ca = Math.cos(a);
   // The flare accelerates downward, and the back flares furthest —
   // that extra fabric is what becomes the train. The exponent is a
   // pure curve-shaping term with no unit.
   const f = Math.pow(v, 1.25);

   // Pleats. A garment cut as a smooth cone stays a smooth cone: the
   // solver has nothing to break the symmetry with, and a robe with no
   // vertical folds reads as a traffic cone no matter how good the
   // shading is. Putting the folds in the *rest shape* means the
   // constraints preserve them, they deepen toward the hem where the
   // fabric is loose, and they travel with the garment rather than
   // sliding across it the way a normal map would.
   //
   // Three incommensurate frequencies, so no two folds are alike and
   // the pattern never repeats around the tube. Amplitudes are metres
   // of radial displacement at full flare; the frequencies are folds
   // per turn and the terms are phase offsets in radians.
   const fold =
    0.118 * Math.sin(a * 7 + 0.6) +
    0.055 * Math.sin(a * 12 + 2.1) +
    0.026 * Math.sin(a * 19 + 4.4);
   const pleat = 1 + f * fold;

   // ca = +1 at the front, -1 at the back. The hem hangs *lowest* at
   // the crest of a fold, where there is most fabric to hang — in
   // phase with the pleat it produced a row of hard spikes instead.
   //
   // Cut high at the front and long at the back. Ankle length all the
   // way round hides the boots, and with the boots hidden the entire
   // foot-planting solve is invisible. Heights are metres at the waist
   // and the hem; the third term is metres of fold-locked scallop.
   const hemY = 0.300 + 0.200 * ca - 0.048 * Math.sin(a * 7 + 0.6);
   const y = 0.990 + (hemY - 0.990) * v;

   // Ring radii, metres, at the waist and at the hem. The back stays
   // deeper than the front by 0.12 of the front radius, which is what
   // makes the train read from the side.
   const rx = (0.158 + (0.345 - 0.158) * f) * pleat;
   const rz = (0.128 + (0.318 - 0.128) * f * (1 - 0.12 * ca)) * pleat;

   const o = (j * p.cols + i) * FLOATS_PER_POINT;
   p.bindPos[o] = rx * sa;
   p.bindPos[o + 1] = y;
   p.bindPos[o + 2] = rz * ca - 0.010 * v;
   p.bone[j * p.cols + i] = B_ROOT;
   p.pinRate[j * p.cols + i] = RATE[j];
  }
 }
 p.finalise();
 return p;
}

/**
 * The over-mantle: a short cape that clears the shoulders and falls to the
 * small of the back. Its job is to break up the vertical line of the robe and
 * to catch the light on the shoulders, which is the read that says "layered"
 * from fifteen metres.
 */
function makeMantle() {
 const p = new ClothPanel({
  name: "mantle", cols: 28, rows: 7, matId: M_MANTLE,
  renderCols: 64, renderRows: 22,
  weaveU: 1.35, weaveV: 0.72,
  aoTop: 0.85, aoBottom: 0.6,
  collide: C_TORSO | C_ARM_L | C_ARM_R,
 });

 const RATE = [Infinity, 40, 12, 4, 1.5, 0.8, 0.45];
 // The collar has to clear the torso it sits on: start it inside the
 // shoulders (0.176 across) and the top of the mantle only emerges at the
 // shoulder line, which reads as a flat plate bolted to the chest.
 const RAD: CurvePoint[] = [
  [0.00, 0.176, 0.148],
  [0.20, 0.222, 0.176],
  [0.55, 0.235, 0.196],
  [1.00, 0.246, 0.214],
 ];
 // Stops around the elbow, so the sleeves and their fur cuffs stay visible
 // below it. A mantle long enough to cover the forearms swallows the whole
 // silhouette into one dark mass.
 const YT: CurvePoint[] = [
  [0.00, 1.442, 0],
  [0.20, 1.352, 0],
  [0.55, 1.220, 0],
  [1.00, 0.000, 0], // filled per column below
 ];

 for (let j = 0; j < p.rows; j++) {
  const v = j / (p.rows - 1);
  const [rx, rz] = curve(RAD, v);
  for (let i = 0; i < p.cols; i++) {
   const a = (i / p.cols) * TAU;
   const sa = Math.sin(a), ca = Math.cos(a);
   // Front hangs shorter than the back, and the edge scallops with the
   // folds rather than cutting a clean arc. Heights are metres; the
   // scallop amplitudes are metres and the fold frequencies are folds
   // per turn.
   YT[3][1] = 1.045 + 0.115 * ca + 0.035 * Math.sin(a * 7 + 1.4);
   const y = curve(YT, v)[0];
   const pleat = 1 + v * (0.062 * Math.sin(a * 7 + 1.4) + 0.026 * Math.sin(a * 11 + 3.0));

   const o = (j * p.cols + i) * FLOATS_PER_POINT;
   p.bindPos[o] = rx * sa * pleat;
   p.bindPos[o + 1] = y;
   p.bindPos[o + 2] = rz * ca * pleat - 0.012;
   p.bone[j * p.cols + i] = B_CHEST;
   p.pinRate[j * p.cols + i] = RATE[j];
  }
 }
 p.finalise();
 return p;
}

/**
 * A sleeve. Pinned tightly along the arm and genuinely loose only past the
 * wrist, where the cuff drapes. A fully free sleeve looks wonderful for about
 * four seconds and then slides off the elbow.
 */
/** @param {0 | 1} side */
function makeSleeve(side: 0 | 1) {
 const s = side === SIDE_LEFT ? -1 : 1;
 const p = new ClothPanel({
  name: "sleeve" + side, cols: 10, rows: 8, matId: M_ROBE,
  renderCols: 26, renderRows: 20,
  weaveU: 0.46, weaveV: 0.66,
  aoTop: 0.6, aoBottom: 0.5,
  collide: side === SIDE_LEFT ? C_ARM_L : C_ARM_R,
 });

 const UP: [number, number, number] = [s * 0.185, 1.400, 0.000];
 const EL: [number, number, number] = [s * 0.230, 1.123, 0.000];
 const WR: [number, number, number] = [s * 0.243, 0.866, 0.016];

 // Beyond the wrist, continuing the forearm's direction.
 let dx = WR[0] - EL[0], dy = WR[1] - EL[1], dz = WR[2] - EL[2];
 const dl = Math.hypot(dx, dy, dz);
 dx /= dl; dy /= dl; dz /= dl;

 // (segment, t, radius) per row. Segment 0 = upper arm, 1 = forearm,
 // 2 = past the wrist. Radii are metres; the t values are the fraction
 // of the way along the owning segment.
 const ROWS: [number, number, number][] = [
  [0, 0.00, 0.084], [0, 0.45, 0.076], [0, 1.00, 0.072],
  [1, 0.40, 0.068], [1, 0.75, 0.064], [1, 1.00, 0.061],
  [2, 0.045, 0.072], [2, 0.125, 0.098],
 ];
 const BONE = [
  B_UPPER_L, B_UPPER_L, B_UPPER_L,
  B_FORE_L, B_FORE_L, B_FORE_L, B_FORE_L, B_HAND_L,
 ];
 const BONE_R = [
  B_UPPER_R, B_UPPER_R, B_UPPER_R,
  B_FORE_R, B_FORE_R, B_FORE_R, B_FORE_R, B_HAND_R,
 ];
 const RATE = [Infinity, 50, 26, 40, 18, 9, 5, 1.2];

 for (let j = 0; j < p.rows; j++) {
  const [seg, t, r] = ROWS[j];
  let cx, cy, cz;
  if (seg === 0) {
   cx = UP[0] + (EL[0] - UP[0]) * t;
   cy = UP[1] + (EL[1] - UP[1]) * t;
   cz = UP[2] + (EL[2] - UP[2]) * t;
  } else if (seg === 1) {
   cx = EL[0] + (WR[0] - EL[0]) * t;
   cy = EL[1] + (WR[1] - EL[1]) * t;
   cz = EL[2] + (WR[2] - EL[2]) * t;
  } else {
   cx = WR[0] + dx * t; cy = WR[1] + dy * t; cz = WR[2] + dz * t;
  }
  for (let i = 0; i < p.cols; i++) {
   const a = (i / p.cols) * TAU;
   const o = (j * p.cols + i) * FLOATS_PER_POINT;
   // The arm is near-vertical in the bind pose, so the ring lies in XZ.
   p.bindPos[o] = cx + Math.sin(a) * r;
   p.bindPos[o + 1] = cy;
   p.bindPos[o + 2] = cz + Math.cos(a) * r;
   p.bone[j * p.cols + i] = (side === SIDE_LEFT ? BONE : BONE_R)[j];
   p.pinRate[j * p.cols + i] = RATE[j];
  }
 }
 p.finalise();
 return p;
}

export function makePanels() {
 return [makeRobe(), makeMantle(), makeSleeve(SIDE_LEFT), makeSleeve(SIDE_RIGHT)];
}

// -----------------------------------------------------------------------------
//  Solver
// -----------------------------------------------------------------------------

export class ClothSolver {
 /** Every panel this solver advances, shared with the figure's renderer. */
 panels: ClothPanel[];
 /** The surface the hems rest on. */
 terrain: TerrainLike;
 /** Apparent wind for the current step, m/s. */
 _wind: Float32Array;
 /** Scratch acceleration accumulator, m/s². */
 _acc: Float32Array;
 /** Simulated seconds elapsed; drives the wind's phases. */
 _t: number;

 /**
  * @param {ClothPanel[]} panels
  * @param {TerrainLike} terrain
  */
 constructor(panels: ClothPanel[], terrain: TerrainLike) {
  this.panels = panels;
  this.terrain = terrain;
  this._wind = new Float32Array(3);
  this._acc = new Float32Array(3);
  this._t = 0;
 }

 /**
  * @param {number} dt
  * @param {Figure} fig
  * @param {CharacterController} ch
  */
 update(dt: number, fig: Figure, ch: CharacterController) {
  let h = Math.min(dt, MAX_SUBSTEP_H);
  let steps = 1;
  if (h > SUBSTEP_MIN_H) { steps = SPLIT_STEPS; h *= 0.5; }
  this._t += dt;

  // ---- apparent wind ----------------------------------------------
  // The bearing wanders. A field wind that blows from exactly one compass
  // point forever pins the garment into a fixed shape and then only
  // modulates its depth — the robe reads as starched. Two slow, unrelated
  // terms, ±11 degrees, is enough that the fabric is always being taken
  // slightly differently. Amplitudes and phases are radians.
  const a = (/** @type {number} */ (S.windDirection) * DEG_TO_RAD)
   + 0.14 * Math.sin(this._t * 0.11)
   + 0.06 * Math.sin(this._t * 0.37 + 2.0);
  const ws = WIND_SPEED * /** @type {number} */ (S.windStrength);
  // Gusts across four time scales, so a standing figure is never dead still
  // and never metronomic either: a slow swell that arrives and passes, the
  // two mid rates that read as gusting, and a light flutter on top. The
  // envelope spans roughly 0.2x to 1.8x, so the robe genuinely gets pushed
  // and genuinely gets let go. The terms are dimensionless multipliers.
  const gust = 1
   + 0.26 * Math.sin(this._t * 0.19 + 0.5)
   + 0.30 * Math.sin(this._t * 0.7)
   + 0.16 * Math.sin(this._t * 2.3 + 1.1)
   + 0.08 * Math.sin(this._t * 5.1 + 2.7);
  this._wind[0] = Math.sin(a) * ws * gust - ch.velocity.x;
  // A vertical component on its own clock: an updraught lifts a hem in a way
  // no amount of horizontal wind does. Amplitudes are m/s.
  this._wind[1] = 0.35 * Math.sin(this._t * 1.9) + 0.22 * Math.sin(this._t * 0.43 + 1.3);
  this._wind[2] = Math.cos(a) * ws * gust - ch.velocity.z;

  for (let s = 0; s < steps; s++) {
   for (let i = 0; i < this.panels.length; i++) {
    this._step(this.panels[i], h, fig);
   }
  }
 }

 /** @param {ClothPanel} p @param {number} h @param {Figure} fig */
 _step(p: ClothPanel, h: number, fig: Figure) {
  const n = p.count;
  const pos = p.pos;
  const prev = p.prev;
  const target = p.target;
  const skin = fig.skin;

  // ---- kinematic targets, from the skeleton -------------------------
  for (let k = 0; k < n; k++) {
   const b = p.bone[k] * MAT4_FLOATS;
   const o = k * FLOATS_PER_POINT;
   const x = p.bindPos[o], y = p.bindPos[o + 1], z = p.bindPos[o + 2];
   target[o] = skin[b] * x + skin[b + 4] * y + skin[b + 8] * z + skin[b + 12];
   target[o + 1] = skin[b + 1] * x + skin[b + 5] * y + skin[b + 9] * z + skin[b + 13];
   target[o + 2] = skin[b + 2] * x + skin[b + 6] * y + skin[b + 10] * z + skin[b + 14];
  }

  // ---- integrate ----------------------------------------------------
  const wx = this._wind[0], wy = this._wind[1], wz = this._wind[2];
  const wmag = Math.hypot(wx, wy, wz);
  const drag = WIND_DRAG * wmag;
  const turb = (TURBULENCE_FLOOR + drag * TURBULENCE_FROM_DRAG) * /** @type {number} */ (S.windStrength);
  const damp = Math.pow(DAMP_PER_SIXTIETH, h * DAMP_REFERENCE_FPS);
  const h2 = h * h;

  for (let k = 0; k < n; k++) {
   if (!isFinite(p.pinRate[k])) continue; // welded; skip the integrator
   const o = k * FLOATS_PER_POINT;
   // Turbulence, hashed off the particle index so it does not pulse in
   // unison across the garment. The stride and time rate are radians of
   // phase per particle and per second; the amplitudes are m/s.
   const ph = k * 1.7 + this._t * 4.5;
   const tx = Math.sin(ph) * 0.9;
   const ty = Math.sin(ph * 1.31 + 2.1) * 0.7;
   const tz = Math.cos(ph * 0.87 + 0.4) * 0.9;

   const ax = wx * drag + tx * turb;
   const ay = wy * drag - GRAVITY + ty * turb;
   const az = wz * drag + tz * turb;

   const vx = (pos[o] - prev[o]) * damp;
   const vy = (pos[o + 1] - prev[o + 1]) * damp;
   const vz = (pos[o + 2] - prev[o + 2]) * damp;

   prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
   pos[o] = /** @type {number} */ (pos[o]) + (vx + ax * h2)
   pos[o + 1] = /** @type {number} */ (pos[o + 1]) + (vy + ay * h2)
   pos[o + 2] = /** @type {number} */ (pos[o + 2]) + (vz + az * h2)
  }

  // ---- constraints ---------------------------------------------------
  for (let it = 0; it < ITERATIONS; it++) {
   this._anchors(p, h);
   this._distance(p, it);
  }
  this._collide(p, fig);
 }

 /** Pull each particle toward its skinned target at its own rate. */
 /** @param {ClothPanel} p @param {number} h */
 _anchors(p: ClothPanel, h: number) {
  const n = p.count;
  const pos = p.pos;
  const target = p.target;
  for (let k = 0; k < n; k++) {
   const rate = p.pinRate[k];
   const o = k * FLOATS_PER_POINT;
   if (!isFinite(rate)) {
    pos[o] = target[o];
    pos[o + 1] = target[o + 1];
    pos[o + 2] = target[o + 2];
    continue;
   }
   if (rate <= 0) continue;
   // Divided by the iteration count so the total pull over one frame is
   // the rate the table asks for, not six times it.
   const w = (1 - Math.exp(-rate * h)) / ITERATIONS;
   pos[o] = /** @type {number} */ (pos[o]) + ((target[o] - pos[o]) * w)
   pos[o + 1] = /** @type {number} */ (pos[o + 1]) + ((target[o + 1] - pos[o + 1]) * w)
   pos[o + 2] = /** @type {number} */ (pos[o + 2]) + ((target[o + 2] - pos[o + 2]) * w)
  }
 }

 /**
  * Distance and bending constraints, Gauss-Seidel.
  *
  * Welded particles have infinite mass: they take none of the correction, so
  * a hem cannot drag the waistband off the hips.
  */
 /** @param {ClothPanel} p @param {number} iteration */
 _distance(p: ClothPanel, iteration: number) {
  const { cols, rows, pos, restU, restV, restB, pinRate } = p;
  const bendK = iteration >= BEND_START_ITERATION ? BEND_STIFFNESS : 0;

  for (let j = 0; j < rows; j++) {
   for (let i = 0; i < cols; i++) {
    const k = j * cols + i;

    // around the ring
    solveLink(pos, k, j * cols + ((i + 1) % cols), restU[k], pinRate, LINK_STIFFNESS);
    // down the panel
    if (j + 1 < rows) {
     solveLink(pos, k, (j + 1) * cols + i, restV[k], pinRate, LINK_STIFFNESS);
    }
    // bending, two rows apart
    if (bendK > 0 && j + 2 < rows) {
     solveLink(pos, k, (j + 2) * cols + i, restB[k], pinRate, bendK);
    }
   }
  }
 }

 /** Push particles out of the body capsules and off the snow. */
 /** @param {ClothPanel} p @param {Figure} fig */
 _collide(p: ClothPanel, fig: Figure) {
  const n = p.count;
  const pos = p.pos;
  const joint = fig.joint;

  for (let c = 0; c < CAPSULES.length; c++) {
   const cap = CAPSULES[c];
   if ((p.collide & cap[3]) === 0) continue;
   const a = cap[0] * FLOATS_PER_POINT, b = cap[1] * FLOATS_PER_POINT;
   const ax = joint[a], ay = joint[a + 1], az = joint[a + 2];
   const bx = joint[b], by = joint[b + 1], bz = joint[b + 2];
   const ex = bx - ax, ey = by - ay, ez = bz - az;
   const elen2 = ex * ex + ey * ey + ez * ez || DEGENERATE_AXIS_EPS2;
   const r = cap[2];

   for (let k = 0; k < n; k++) {
    if (!isFinite(p.pinRate[k])) continue;
    const o = k * FLOATS_PER_POINT;
    let t = ((pos[o] - ax) * ex + (pos[o + 1] - ay) * ey + (pos[o + 2] - az) * ez) / elen2;
    t = clamp01(t);
    const cx = ax + ex * t, cy = ay + ey * t, cz = az + ez * t;
    let dx = pos[o] - cx, dy = pos[o + 1] - cy, dz = pos[o + 2] - cz;
    const d = Math.hypot(dx, dy, dz);
    if (d >= r || d < DEGENERATE_PUSH_EPS) continue;
    const push = (r - d) / d;
    pos[o] = /** @type {number} */ (pos[o]) + (dx * push)
    pos[o + 1] = /** @type {number} */ (pos[o + 1]) + (dy * push)
    pos[o + 2] = /** @type {number} */ (pos[o + 2]) + (dz * push)
   }
  }

  // The hem rides on the snow rather than through it. Only the bottom rows
  // check, because that is the only place it can happen and `heightAt` is
  // a filtered lookup, not free.
  if (p.groundRows > 0) {
   const start = (p.rows - p.groundRows) * p.cols;
   for (let k = start; k < n; k++) {
    const o = k * FLOATS_PER_POINT;
    const g = this.terrain.heightAt(pos[o], pos[o + 2]) + GROUND_CLEARANCE;
    if (pos[o + 1] < g) pos[o + 1] = g;
   }
  }
 }
}

/**
 * One distance constraint. Mass weighting is binary — a welded particle does not
 * move at all — which is both correct and much cheaper than carrying inverse
 * masses through the inner loop.
 */
/** @param {Float32Array} pos @param {number} ka @param {number} kb @param {number} rest @param {Float32Array} pinRate @param {number} stiffness */
function solveLink(pos: Float32Array, ka: number, kb: number, rest: number, pinRate: Float32Array, stiffness: number) {
 const a = ka * FLOATS_PER_POINT, b = kb * FLOATS_PER_POINT;
 const dx = pos[b] - pos[a];
 const dy = pos[b + 1] - pos[a + 1];
 const dz = pos[b + 2] - pos[a + 2];
 const d = Math.hypot(dx, dy, dz);
 if (d < DEGENERATE_EPS) return;
 const diff = ((d - rest) / d) * stiffness;

 const fa = isFinite(pinRate[ka]);
 const fb = isFinite(pinRate[kb]);
 if (fa && fb) {
  // Both free: split the correction in half so the pair averages out.
  const h = diff * 0.5;
  pos[a] = /** @type {number} */ (pos[a]) + (dx * h); pos[a + 1] = /** @type {number} */ (pos[a + 1]) + (dy * h); pos[a + 2] = /** @type {number} */ (pos[a + 2]) + (dz * h);
  pos[b] = /** @type {number} */ (pos[b]) - (dx * h); pos[b + 1] = /** @type {number} */ (pos[b + 1]) - (dy * h); pos[b + 2] = /** @type {number} */ (pos[b + 2]) - (dz * h);
 } else if (fa) {
  pos[a] = /** @type {number} */ (pos[a]) + (dx * diff); pos[a + 1] = /** @type {number} */ (pos[a + 1]) + (dy * diff); pos[a + 2] = /** @type {number} */ (pos[a + 2]) + (dz * diff);
 } else if (fb) {
  pos[b] = /** @type {number} */ (pos[b]) - (dx * diff); pos[b + 1] = /** @type {number} */ (pos[b + 1]) - (dy * diff); pos[b + 2] = /** @type {number} */ (pos[b + 2]) - (dz * diff);
 }
}
