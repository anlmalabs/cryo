/**
 * Snow spray — a pooled, CPU-simulated, GPU-billboarded particle system.
 *
 * One system serves every source of airborne snow in the demo: footfalls now,
 * the snow-surf plume and the spell spray later. That is deliberate. A separate
 * emitter per effect means separate pipelines, separate warm-up, separate
 * sorting, and five slightly different ideas about what lit snow powder looks
 * like. There is one pipeline here and one lighting model.
 *
 * Simulation is on the CPU because the particle count is small (a footfall is
 * eighteen grains) and the alternative — a compute pass plus indirect draw —
 * costs more in dispatch overhead than the whole simulation costs to run. What
 * *is* on the GPU is the expansion: the mesh is a static grid of quads whose
 * only vertex attribute is a particle index and a corner, and the vertex shader
 * fetches the particle's state out of a small data texture. So the CPU writes
 * eight floats per live particle per frame and nothing else crosses the bus.
 *
 * Allocation: none per frame. Everything is a typed array sized at construction,
 * and dead particles are recycled through a free ring rather than compacted.
 */

import * as THREE from "three";

import { S } from "../core/settings.js";
import { getShader } from "../shaders/registry.js";
import { makeMaterial, whenReady } from "../core/gpuUtil.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import type { ShadowSystem } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import { GRAVITY } from "../spells/bending.js";

/**
 * Pool size. A hard cap, not a target — an emission is simply dropped when it is
 * exhausted.
 *
 * Sized for the surf plume, which is the heaviest consumer by an order of
 * magnitude and which needs sheer count more than it needs anything else: at
 * 1200 live grains the plume renders as a field of separated soft discs — legible
 * as bokeh, not as snow — and the only thing that turns that into a continuous
 * mass is enough of them to overlap. 75 a metre at 19.5 m/s across two
 * populations lands near 3500 live, and the footfall kick and the spells still
 * have to fit alongside.
 *
 * The cost of the headroom is one pass over the array per frame — 5120 iterations
 * of a dozen flops, which does not register — plus 160 KB of data texture.
 */
const CAPACITY = 5120;

/** Terminal fall speed of a snow grain, m/s. Drag is tuned to land here. */
const TERMINAL = 1.9;

/**
 * Horizontal velocity scale applied to the wind by `S.windStrength`, m/s per
 * unit strength. `S.windDirection` only chooses the axis.
 */
const WIND_SCALE = 2.4;

/** Speed kept after a grain lands on the snow, as a fraction per axis. */
const SETTLE_FRICTION = 0.2;
/** Life consumed per second by a grain already sitting on the snow. */
const SETTLE_AGE_MULTIPLIER = 2.5;

/** Drag of a heavy clod, 1/s. Powder gets 5.2. */
const CLOD_DRAG = 1.1;
/** Drag of settling powder, 1/s — soft-edged but quick to stop. */
const POWDER_DRAG = 5.2;
/** `kind` at or above which a grain is a heavy clod rather than powder. */
const CLOD_KIND = 0.5;

/** Puff radius growth per second at end of life, as a multiple of size. */
const POWDER_GROWTH = 1.3;
/** Alpha fade-in rate on a normalised 0..1 age, per unit of age. */
const FADE_IN_STRENGTH = 8;

/** Wind resampled lazily: the largest dt the integrator accepts, seconds. */
const MAX_STEP = 1 / 30;

/**
 * Shadow sampling softness — a dimensionless multiplier on the sun's angular
 * size, per `shaders/lib/shading.glsl`. Not a length: see `penumbraWorld`.
 */
const SHADOW_SOFTNESS = 1.6;
/** Depth bias in the shadow map, metres. */
const SHADOW_BIAS = 0.05;
/** Fallback shadow-map texel size when no ShadowSystem is handed in. */
const FALLBACK_SHADOW_TEXEL = 1 / 2048;

/**
 * Golden angle π(3 − √5) as a fraction of a turn, to six places.
 *
 * The Fibonacci-sphere seed hash. `src/spells/crystals.ts` rounds the same
 * constant one digit higher (`0.618034`); this file keeps the value it has
 * always used, so the hash it produces is unchanged.
 */
const GOLDEN_ANGLE_FRACTION = 0.618033;
/** Conventional coprime x-weight in the seed hash, dimensionless. */
const SEED_X_WEIGHT = 0.137;
/** Conventional coprime z-weight in the seed hash, dimensionless. */
const SEED_Z_WEIGHT = 0.311;

/** The slice of `core/gfx.js`'s `Gfx` this module touches. */
interface GfxLike {
 scene: THREE.Scene;
 LAYER: { SKY: number; OPAQUE: number; BLEND: number };
 addMesh(mesh: THREE.Object3D, layerBit: number, renderOrder: number): THREE.Object3D;
 /** Fallback samplers for scenes with no sky / no shadow maps. */
 whiteTex: THREE.Texture;
 blackTex: THREE.Texture;
 /** Read only to pass to `whenReady`, which compiles against it. */
 renderer: THREE.WebGLRenderer;
 /** The token scene camera, same. */
 threeCamera: THREE.Camera;
}

/** The terrain query the spray makes, so a grain can stop on the snow. */
interface HeightQuery { heightAt(x: number, z: number): number }

/** The sky this module reads lighting from. */
interface SkyLike {
 sunDir?: THREE.Vector3;
 sunRadiance?: THREE.Color;
 sh?: { R: Float32Array } | Float32Array | null;
 lut?: THREE.Texture;
}

/**
 * The shadow state this module binds as uniforms: the owner's own type, with
 * the fields this module publishes into typed against how `ShadowSystem`
 * assigns them (dynamically, under its index signature).
 */
type ShadowLike = Omit<ShadowSystem, "matrixValues"> & Partial<Pick<ShadowSystem, "matrixValues">>;

/** One shader uniform: whatever three accepts, held as unknown by shape. */
type Uniform = { value: unknown };

export class SprayField {
 gfx: GfxLike;
 terrain: HeightQuery | null;
 sky: SkyLike | null;
 shadows: ShadowLike | null;
 /** Live grain positions, metres. Triples, capacity-major. */
 pos: Float32Array;
 /** Live grain velocities, m/s. Triples, capacity-major. */
 vel: Float32Array;
 /** Seconds a grain has been alive. */
 age: Float32Array;
 /** Seconds a grain will live for. */
 life: Float32Array;
 /** Grain radius, metres. */
 size: Float32Array;
 /** Per-grain random, 0..1. */
 seed: Float32Array;
 /** 0 = powder puff, 1 = heavy clod. Drives edge hardness and opacity. */
 kind: Float32Array;
 /** Linear drag coefficient, 1/s. Separate from `kind` on purpose. */
 drag: Float32Array;
 /** Index of the next slot to try. Wraps; a live slot is skipped. */
 _next: number;
 liveCount: number;
 /** Texture rows: 0 = (x, y, z, size), 1 = (age01, seed, kind, alpha). */
 _texData: Float32Array;
 dataTex: THREE.DataTexture;
 /** This frame's jittered view-projection. */
 _vp: THREE.Matrix4;
 _camPos: THREE.Vector3;
 _right: THREE.Vector3;
 _up: THREE.Vector3;
 mesh: THREE.Mesh & { metadata: { triangles: number; vertices: number } };
 material: THREE.RawShaderMaterial;
 _t: number;

 constructor(gfx: GfxLike, terrain: HeightQuery | null, sky: SkyLike | null, shadows: ShadowLike | null) {
  this.gfx = gfx;
  this.terrain = terrain || null;
  this.sky = sky || null;
  this.shadows = shadows || null;

  this.pos = new Float32Array(CAPACITY * 3);
  this.vel = new Float32Array(CAPACITY * 3);
  this.age = new Float32Array(CAPACITY);
  this.life = new Float32Array(CAPACITY);
  this.size = new Float32Array(CAPACITY);
  this.seed = new Float32Array(CAPACITY);
  this.kind = new Float32Array(CAPACITY);
  this.drag = new Float32Array(CAPACITY);
  this._next = 0;
  this.liveCount = 0;

  this._texData = new Float32Array(CAPACITY * 2 * 4);
  this.dataTex = new THREE.DataTexture(
   this._texData, CAPACITY, 2, THREE.RGBAFormat, THREE.FloatType
  );
  this.dataTex.magFilter = THREE.NearestFilter;
  this.dataTex.minFilter = THREE.NearestFilter;
  this.dataTex.wrapS = THREE.ClampToEdgeWrapping;
  this.dataTex.wrapT = THREE.ClampToEdgeWrapping;
  this.dataTex.generateMipmaps = false;
  this.dataTex.colorSpace = THREE.NoColorSpace;
  this.dataTex.flipY = false;
  this.dataTex.premultiplyAlpha = false;
  this.dataTex.needsUpdate = true;

  // The jittered view-projection and the billboard basis, refreshed at
  // draw time (see the onBeforeRender hook below).
  this._vp = new THREE.Matrix4();
  this._camPos = new THREE.Vector3();
  this._right = new THREE.Vector3(1, 0, 0);
  this._up = new THREE.Vector3(0, 1, 0);

  this.mesh = buildQuadMesh();
  this.material = this._makeMaterial();
  this.mesh.material = this.material;
  // After the opaque pass: these are alpha-blended and write no depth.
  // Layer BLEND, renderOrder 50 — spray is always last (CONTRACTS §4.4).
  gfx.addMesh(this.mesh, gfx.LAYER.BLEND, 50);

  // The token camera is synced from the rig at the top of `renderFrame`,
  // after the whole sim has run — so the current frame's jittered matrices
  // are read here, at draw time, not during `update`. Same values as
  // `rig.camera.viewProjection` / `rig.camera.view` this frame.
  const vp = this._vp;
  const right = this._right;
  const up = this._up;
  this.mesh.onBeforeRender = (
   renderer: THREE.WebGLRenderer,
   scene: THREE.Scene,
   camera: THREE.Camera & { projectionMatrix: THREE.Matrix4; matrixWorldInverse: THREE.Matrix4 }
  ) => {
   vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
   const v = camera.matrixWorldInverse.elements;
   // Billboard basis, straight off the LH view matrix.
   right.set(v[0], v[4], v[8]);
   up.set(v[1], v[5], v[9]);
  };

  this._t = 0;
 }

 _makeMaterial() {
  const gfx = this.gfx;
  const sky = this.sky;
  const sh = this.shadows;

  // A heterogeneous bag — numbers, typed arrays, Vector3/Color, textures — and
  // it also carries keys written dynamically below (`cascade0..2`, the three
  // spell-light slots), so it is typed by shape rather than inferred as a
  // closed object literal. `unknown` because the values are only ever handed
  // to `makeMaterial`/three, never read back through this alias here.
  const uniforms: Record<string, Uniform> = {
   viewProjection: { value: this._vp },
   cameraPos: { value: this._camPos },
   camRight: { value: this._right },
   camUp: { value: this._up },

   sunDir: { value: sky && sky.sunDir ? sky.sunDir : new THREE.Vector3(0, 1, 0) },
   sunRadiance: { value: sky && sky.sunRadiance ? sky.sunRadiance : new THREE.Color(0, 0, 0) },
   shR: { value: sky && sky.sh ? sky.sh : new Float32Array(36) },

   cascadeMatrices: {
    value: sh && sh.matrixValues
     ? sh.matrixValues
     : [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
   },
   cascadeSplits: {
    value: sh && sh.splitsVec4 ? sh.splitsVec4 : new THREE.Vector4(26, 95, 330, 330),
   },
   cascadeParams: { value: sh && sh.paramData ? sh.paramData : new Float32Array(12) },
   shadowTexel: { value: sh && sh.texelSize ? sh.texelSize : FALLBACK_SHADOW_TEXEL },
   shadowSoftness: { value: SHADOW_SOFTNESS },
   shadowBias: { value: SHADOW_BIAS },

   ambientIntensity: { value: S.ambientIntensity },

   sprayTex: { value: this.dataTex },
   skyLUT: { value: sky && sky.lut ? sky.lut : gfx.blackTex },
  };
  for (let i = 0; i < CASCADE_COUNT; i++) {
   uniforms["cascade" + i] = {
    value: sh && sh.maps && sh.maps[i] ? sh.maps[i] : gfx.whiteTex,
   };
  }
  // Every consumer declares all three, lit or not (CONTRACTS §7.5).
  // SPELL_LIGHT_UNIFORMS order: pos, col, count.
  uniforms[SPELL_LIGHT_UNIFORMS[0]] = { value: new Float32Array(16) };
  uniforms[SPELL_LIGHT_UNIFORMS[1]] = { value: new Float32Array(16) };
  uniforms[SPELL_LIGHT_UNIFORMS[2]] = { value: 0 };

  return makeMaterial({
   name: "spray",
   vertex: getShader("sprayVertexShader"),
   fragment: getShader("sprayPixelShader"),
   uniforms,
   transparent: true,
   blending: THREE.NormalBlending,
   depthWrite: false,
   depthTest: true,
   side: THREE.DoubleSide,
  });
 }

 /**
  * Emit one grain. Everything is world space.
  *
  * @param {number} x @param {number} y @param {number} z
  * @param {number} vx @param {number} vy @param {number} vz
  * @param {number} size metres, radius
  * @param {number} life seconds
  * @param {number} kind 0 powder, 1 clod — appearance only
  * @param {number} [drag] 1/s. Defaults to the fall-in-place value for a
  *   grain of settling powder; pass something near 1 for anything thrown.
  */
 emit(
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
  /** radius, metres */
  size: number,
  /** seconds */
  life: number,
  /** 0 powder, 1 clod — appearance only */
  kind: number,
  /** 1/s. Omit for the kind-derived default. */
  drag?: number
 ) {
  // Find a free slot. Bounded scan: after CAPACITY tries the pool is full
  // and the emission is simply dropped, which at these counts never
  // happens and is the right failure anyway — a hitch is worse than a
  // missing grain.
  let i = this._next;
  for (let n = 0; n < CAPACITY; n++) {
   if (this.age[i] >= this.life[i]) break;
   i = (i + 1) % CAPACITY;
   if (n === CAPACITY - 1) return;
  }
  this._next = (i + 1) % CAPACITY;

  const o = i * 3;
  this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
  this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
  this.age[i] = 0;
  this.life[i] = life;
  this.size[i] = size;
  this.kind[i] = kind;
  this.drag[i] = drag === undefined ? (kind > CLOD_KIND ? CLOD_DRAG : POWDER_DRAG) : drag;
  // Fibonacci-sphere hash: the golden angle as a fraction of a turn, with the
  // conventional coprime x and z weights.
  this.seed[i] = (i * GOLDEN_ANGLE_FRACTION + x * SEED_X_WEIGHT + z * SEED_Z_WEIGHT) % 1;
 }

 /**
  * Advance and upload.
  * @param {number} dt
  * @param {THREE.Vector3} cameraPos
  */
 update(dt: number, cameraPos: THREE.Vector3) {
  this._t += dt;
  this._camPos.copy(cameraPos);

  // Substepped clamp rather than a fixed step: a hitch must not launch a
  // grain the length of a dune, but slow frames must still advance.
  const h = Math.min(dt, MAX_STEP);
  const wa = ((S.windDirection as number) * Math.PI) / 180;
  const wx = Math.sin(wa) * WIND_SCALE * (S.windStrength as number);
  const wz = Math.cos(wa) * WIND_SCALE * (S.windStrength as number);

  const terrain = this.terrain;
  const d = this._texData;
  let live = 0;

  for (let i = 0; i < CAPACITY; i++) {
   const o = i * 3;
   const to = i * 4;
   const t1 = (CAPACITY + i) * 4;

   if (this.age[i] >= this.life[i]) {
    // A dead slot still has to be written, or the last frame's
    // corpse keeps rendering. Zero size collapses the quad.
    d[to + 3] = 0;
    d[t1 + 3] = 0;
    continue;
   }

   this.age[i] += h;
   const a01 = this.age[i] / this.life[i];

   // Drag toward the wind horizontally and toward terminal vertically.
   // A settling grain reaches equilibrium almost at once; anything
   // thrown hard carries its arc. See the note on `drag` above.
   const k = this.drag[i];
   const vy = this.vel[o + 1];
   this.vel[o] += (wx - this.vel[o]) * Math.min(1, k * h);
   this.vel[o + 2] += (wz - this.vel[o + 2]) * Math.min(1, k * h);
   this.vel[o + 1] = vy - (GRAVITY + k * (vy + TERMINAL)) * h;

   this.pos[o] += this.vel[o] * h;
   this.pos[o + 1] += this.vel[o + 1] * h;
   this.pos[o + 2] += this.vel[o + 2] * h;

   // Settle on the snow instead of falling through it. The grain does
   // not bounce — it is snow landing on snow — it just stops and fades.
   if (terrain) {
    const g = terrain.heightAt(this.pos[o], this.pos[o + 2]);
    if (this.pos[o + 1] < g) {
     this.pos[o + 1] = g;
     this.vel[o] *= SETTLE_FRICTION; this.vel[o + 1] = 0; this.vel[o + 2] *= SETTLE_FRICTION;
     // Kill it faster once it is down.
     this.age[i] += h * SETTLE_AGE_MULTIPLIER;
    }
   }

   // Puffs expand as they disperse; clods do not.
   const grow = this.kind[i] > CLOD_KIND ? 1.0 : 1.0 + a01 * POWDER_GROWTH;
   // Fade in fast, out slowly.
   const alpha =
    Math.min(1, a01 * FADE_IN_STRENGTH) * (1 - a01) * (1 - a01);

   d[to] = this.pos[o];
   d[to + 1] = this.pos[o + 1];
   d[to + 2] = this.pos[o + 2];
   d[to + 3] = this.size[i] * grow;
   d[t1] = a01;
   d[t1 + 1] = this.seed[i];
   d[t1 + 2] = this.kind[i];
   d[t1 + 3] = alpha;
   live++;
  }

  this.liveCount = live;
  this.dataTex.needsUpdate = true;
  this._pushUniforms();
 }

 _pushUniforms() {
  const u = this.material.uniforms;

  // Shared objects — sunDir/sunRadiance/shR, the cascade block, the
  // billboard basis, the view-projection — are bound by reference and
  // mutated in place by their owners; only plain numbers move here.
  u.shadowSoftness.value = SHADOW_SOFTNESS;
  u.shadowBias.value = SHADOW_BIAS;

  u.ambientIntensity.value = S.ambientIntensity;
 }

 async warmUp() {
  await whenReady(this.gfx, this.material, "spray material");
 }
}

/**
 * A static grid of quads. `position` is `(particleIndex, cornerX, cornerY)` and
 * carries no geometry at all — the vertex shader places every corner.
 */
function buildQuadMesh() {
 const pos = new Float32Array(CAPACITY * 4 * 3);
 const idx = new Uint32Array(CAPACITY * 6);
 const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

 for (let i = 0; i < CAPACITY; i++) {
  for (let c = 0; c < 4; c++) {
   const o = (i * 4 + c) * 3;
   pos[o] = i;
   pos[o + 1] = CORNERS[c * 2];
   pos[o + 2] = CORNERS[c * 2 + 1];
  }
  const b = i * 4;
  const q = i * 6;
  idx[q] = b; idx[q + 1] = b + 1; idx[q + 2] = b + 2;
  idx[q + 3] = b; idx[q + 4] = b + 2; idx[q + 5] = b + 3;
 }

 const geometry = new THREE.BufferGeometry();
 geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
 geometry.setIndex(new THREE.BufferAttribute(idx, 1));

 // Placed entirely by the vertex shader, so the CPU-side bounds are a
 // fiction — pin them rather than letting three derive nonsense (or a
 // NaN radius) from the lattice indices.
 geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
 // App-level convention: systems stash their own triangle/vertex counts on
 // `mesh.metadata`; three's `Object3D` types do not declare it.
 const mesh = new THREE.Mesh(geometry) as THREE.Mesh & {
  metadata: { triangles: number; vertices: number };
 };
 mesh.name = "spray";
 mesh.metadata = { triangles: CAPACITY * 2, vertices: CAPACITY * 4 };
 return mesh;
}

