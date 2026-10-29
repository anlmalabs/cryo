/**
 * Terrain system: owns the heightfield, the clipmap mesh, the snow material,
 * the shadow-pass materials and the generated detail map.
 *
 * Per frame this uploads a handful of uniforms and nothing else. No geometry is
 * rebuilt, no buffer is re-uploaded, nothing is allocated.
 *
 * Port note: the five terrain materials (beauty, prepass, three cascade depth)
 * share one set of uniform *entry objects*, so writing a value once covers every
 * pipeline — which is also what structurally guarantees the invariant the source
 * repeats five times over: all passes must see identical clipmap parameters or
 * the depth passes place vertices somewhere the beauty pass does not.
 *
 * `viewProjection` has no engine auto-binding here. The shared entry's Matrix4
 * is recomputed in `mesh.onBeforeRender` from the token camera — which main.js
 * syncs from the rig (post-jitter) at the top of `renderFrame`, before any pass
 * draws — so the beauty and prepass pipelines always carry this frame's
 * jittered matrix.
 */

import * as THREE from "three";
import type { Gfx } from "../core/gfx.js";

import { Heightfield, HEIGHT_RES } from "./heightfield.js";
import { DeformationField } from "./deformation.js";
import {
 buildClipmapMesh,
 BASE_SPACING,
 GRID_HALF_N,
} from "./clipmapMesh.js";
import { S } from "../core/settings.js";
import { makeMaterial, FullscreenPass, bakeOnce, whenReady } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";
import type { Sky } from "../render/sky.js";
import type { ShadowSystem } from "../render/shadows.js";

const DETAIL_RES = 1024;

/** Lattice of the generated snow grain: texels per world unit, metres^-1. */
const GRAIN_SCALE = 0.013;

/** Cascade shadow-map width per side, texels — the fallback when no shadow
 *  system is wired, so the shared `shadowTexel` is still meaningful. */
const SHADOW_RES = 2048;

/** Shadow filter radius, in world metres, as a multiple of the map texel. */
const SHADOW_SOFTNESS = 1.8;

/** Shadow depth bias, metres. Snow has no thin geometry to peter-pan, so this
 *  can stay small and keep contact shadows attached. */
const SHADOW_BIAS = 0.022;

/** Fallback cascade split distances, metres, before the shadow system is built. */
const DEFAULT_SPLITS = [26, 95, 330, 330];

/** Slack below the baked minimum height, metres, for casters proud of the map. */
const HEIGHT_MARGIN_LO = 4;

/** Slack above the baked maximum height, metres, for casters proud of the map. */
const HEIGHT_MARGIN_HI = 6;

const CASCADE_COUNT = 3;

// Indexed by the `S.debugView` enum string, so a real (not JSDoc) record type
// is what makes `[S.debugView]` legal.
const DEBUG_MODES: Record<string, number> = {
 beauty: 0, deform: 1, normals: 2, depth: 3, cascades: 4,
 footprint: 5, fineNormals: 6, shadow: 7, ndotl: 8, shadowMap: 9,
 albedo: 10,
};

/** Fallback for the shared prepass fragment while peers land (§7.9). */
const PREPASS_FALLBACK = `precision highp float;
precision highp int;

in float vViewZ;
in float vMask;

layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = vec4(vViewZ, vMask, 0.0, 1.0);
}
`;

/**
 * One shader uniform's value, as this module binds them: a number, a
 * colour/vector object three's own materials mutate in place, or a buffer
 * or texture bound zero-copy. `sky`/`shadows` peers are stubs whose entries
 * may never have been written, so those bindings are optional by way of the
 * `||` fallback rather than by widening this union.
 */
type TerrainUniformValue =
 | number
 | boolean
 | THREE.Vector2
 | THREE.Vector3
 | THREE.Vector4
 | THREE.Matrix4
 | THREE.Matrix4[]
 | THREE.Color
 | THREE.Texture
 | Float32Array;

/** The uniform-name-keyed entry objects every terrain pipeline shares. */
interface TerrainUniforms {
 /** Written through `.copy()` each frame. */
 cameraPos: { value: THREE.Vector3 };
 /** Written through `.set()` each frame. */
 lodCenter: { value: THREE.Vector2 };
 /** Written through `.set()` on resize. */
 screenSize: { value: THREE.Vector2 };
 /** Everything else: numbers, textures, buffers and the cascade bindings. */
 [name: string]: { value: TerrainUniformValue };
}

/** The clipmap mesh: three's mesh with this project's stashed mesh counts. */
type ClipmapMesh = THREE.Mesh & {
 metadata: { triangles: number; vertices: number };
};

export class Terrain {
 /** The shared renderer handle. */
 gfx: Gfx;
 /** Owning the sky LUT, sun and SH. */
 sky: Sky;
 /** The cascade system this registers casters with. */
 shadows: ShadowSystem;
 /** The baked height and rock-mask channels. */
 heightfield: Heightfield;
 /** The terrain state buffer. Feet, the surf wake and every spell write here. */
 deform: DeformationField;
 /** Generated snow grain, tiled at three world scales by the material. */
 _detailRT: THREE.WebGLRenderTarget;
 /** The grain texture, bound as `detailTex`. */
 detailTex: THREE.Texture;
 /** The bake that generates the grain. */
 _detailPass: FullscreenPass;
 /** The clipmap mesh itself, carrying its triangle and vertex counts. */
 mesh: ClipmapMesh;
 /** The one viewProjection every camera-facing terrain pipeline reads. */
 _viewProjection: THREE.Matrix4;
 /** The snow material the mesh wears in the beauty pass. */
 material: THREE.RawShaderMaterial;
 /** One depth material per cascade; null until the first is built. */
 _depthMats: THREE.RawShaderMaterial[] | null;
 /** The prepass material, built on demand. */
 prepassMat: THREE.RawShaderMaterial | null;
 /**
  * The uniform entry objects shared by every terrain material: one write in
  * `update()` covers all five pipelines. Keyed by uniform name, because
  * `spells` replaces entries wholesale by name (§7.5).
  */
 _u!: TerrainUniforms;
 /** The deform texture currently bound, to catch the ping-pong swap. */
 _boundDeform!: THREE.Texture;
 /** Pulsar shimmer clock. */
 _clock: number = 0;

 /**
  * @param gfx the shared renderer handle
  * @param sky owning the sky LUT, sun and SH
  * @param shadows the cascade system this registers casters with
  */
 constructor(gfx: Gfx, sky: Sky, shadows: ShadowSystem) {
  this.gfx = gfx;
  this.sky = sky;
  this.shadows = shadows;

  this.heightfield = new Heightfield(gfx);

  /** The terrain state buffer. Feet, the surf wake and every spell write here. */
  this.deform = new DeformationField(gfx);

  // Generated snow grain, tiled at three world scales by the material.
  this._detailRT = gfx.makeRenderTarget("detailTex", DETAIL_RES, DETAIL_RES, {
   type: THREE.UnsignedByteType,
   format: THREE.RGBAFormat,
   filter: THREE.LinearFilter,
   wrap: THREE.RepeatWrapping,
   depth: false,
   mips: true,
  });
  this.detailTex = this._detailRT.texture;
  this._detailPass = new FullscreenPass(gfx, {
   name: "detailBake",
   fragment: getShader("detailBakePixelShader"),
   uniforms: {
    resolution: { value: DETAIL_RES },
    grainScale: { value: GRAIN_SCALE },
   },
  });

  this.mesh = buildClipmapMesh();
  gfx.addMesh(this.mesh, gfx.LAYER.OPAQUE, 10);

  // The one viewProjection every camera-facing terrain pipeline reads.
  // Refreshed at draw time from the token camera (see class comment).
  this._viewProjection = new THREE.Matrix4();
  const vp = this._viewProjection;
  this.mesh.onBeforeRender = (
   _renderer: THREE.WebGLRenderer,
   _scene: THREE.Scene,
   camera: THREE.Camera
  ) => {
   if (camera === gfx.threeCamera) {
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
   }
  };

  this._buildSharedUniforms();

  this.material = this._makeSnowMaterial();
  this.mesh.material = this.material;

  /** @type {THREE.RawShaderMaterial[]|null} */
  this._depthMats = null;
  this.prepassMat = null;

  // One depth material per cascade, so each can carry its own matrix
  // without any mid-frame uniform swapping.
  if (shadows && typeof shadows.registerCaster === "function") {
   shadows.registerCaster(this.mesh, (c: number) => this._makeDepthMaterial(c));
  }

  this.setDeformTexture(this.deform.texture);
 }

 /**
  * The uniform entry objects shared by every terrain material. One write in
  * `update()` covers all five pipelines; sky/shadow-owned values are bound
  * zero-copy (the owners mutate the same objects in place, §7.2/7.3).
  */
 _buildSharedUniforms() {
  const gfx = this.gfx;
  const sky = this.sky || {};
  const sh = this.shadows || {};
  const hf = this.heightfield;

  const skyLut = sky.lut
   ? (sky.lut.isTexture ? sky.lut : sky.lut)
   : gfx.blackTex;
  const maps = sh.maps || [];

  this._u = {
   // ---- camera / placement (vertex side) --------------------------
   viewProjection: { value: this._viewProjection },
   cameraPos: { value: new THREE.Vector3() },
   lodCenter: { value: new THREE.Vector2() },
   baseSpacing: { value: BASE_SPACING },
   gridHalfN: { value: GRID_HALF_N },
   worldOrigin: { value: hf.origin },
   worldSize: { value: hf.size },
   heightRes: { value: HEIGHT_RES },
   windAngle: { value: 0 },
   macroAmp: { value: S.macroHeightScale },
   sastrugiAmp: { value: S.sastrugiStrength },

   // ---- deformation window ----------------------------------------
   deformCenter: { value: this.deform.center },
   deformSize: { value: this.deform.size },
   deformTexel: { value: this.deform.texel },
   deformDepthScale: { value: S.deformDepth },

   // ---- textures ---------------------------------------------------
   heightTex: { value: hf.heightTex },
   auxTex: { value: hf.auxTex },
   deformTex: { value: this.deform.texture },
   detailTex: { value: this.detailTex },
   skyLUT: { value: skyLut },
   cascade0: { value: maps[0] || gfx.whiteTex },
   cascade1: { value: maps[1] || gfx.whiteTex },
   cascade2: { value: maps[2] || gfx.whiteTex },

   // ---- sun / sky (zero-copy where the owner exists) ---------------
   sunDir: { value: sky.sunDir || new THREE.Vector3(0, 1, 0) },
   sunRadiance: { value: sky.sunRadiance || new THREE.Color(1, 1, 1) },
   shR: { value: sky.sh || new Float32Array(36) },
   ambientIntensity: { value: S.ambientIntensity },

   // ---- shadows ----------------------------------------------------
   cascadeMatrices: {
    value: sh.matrixValues ||
     [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
   },
   cascadeSplits: { value: sh.splitsVec4 || new THREE.Vector4(...DEFAULT_SPLITS) },
   cascadeParams: { value: sh.paramData || new Float32Array(12) },
   shadowTexel: {
    value: sh.texelSize !== undefined ? sh.texelSize : 1 / SHADOW_RES,
   },
   shadowSoftness: { value: SHADOW_SOFTNESS },
   // Metres. Snow has no thin geometry to peter-pan, so this can stay
   // small and keep contact shadows attached.
   shadowBias: { value: SHADOW_BIAS },

   // ---- snow look --------------------------------------------------
   detailStrength: { value: S.detailNormalStrength },
   glintIntensity: { value: S.glintIntensity },
   glintGrazing: { value: S.glintGrazing },
   sssStrength: { value: S.sssStrength },
   sssRadius: { value: S.sssRadius },

   // ---- atmosphere -------------------------------------------------

   // ---- misc -------------------------------------------------------
   debugMode: { value: 0 },
   screenSize: { value: new THREE.Vector2(1, 1) },

   // ---- spell lights (spells replaces .value wholesale, §7.5) ------
   spellLightPos: { value: new Float32Array(16) },
   spellLightCol: { value: new Float32Array(16) },
   spellLightCount: { value: 0 },
  };
 }

 _makeSnowMaterial() {
  const u = this._u;
  return makeMaterial({
   name: "snow",
   vertex: getShader("snowVertexShader"),
   fragment: getShader("snowPixelShader"),
   uniforms: {
    viewProjection: u.viewProjection,
    cameraPos: u.cameraPos,
    lodCenter: u.lodCenter,
    baseSpacing: u.baseSpacing,
    gridHalfN: u.gridHalfN,
    worldOrigin: u.worldOrigin,
    worldSize: u.worldSize,
    heightRes: u.heightRes,
    windAngle: u.windAngle,
    macroAmp: u.macroAmp,
    sastrugiAmp: u.sastrugiAmp,
    sunDir: u.sunDir,
    sunRadiance: u.sunRadiance,
    shR: u.shR,
    cascadeMatrices: u.cascadeMatrices,
    cascadeSplits: u.cascadeSplits,
    cascadeParams: u.cascadeParams,
    shadowTexel: u.shadowTexel,
    shadowSoftness: u.shadowSoftness,
    shadowBias: u.shadowBias,
    detailStrength: u.detailStrength,
    glintIntensity: u.glintIntensity,
    glintGrazing: u.glintGrazing,
    sssStrength: u.sssStrength,
    sssRadius: u.sssRadius,
    deformCenter: u.deformCenter,
    deformSize: u.deformSize,
    deformTexel: u.deformTexel,
    deformDepthScale: u.deformDepthScale,
    ambientIntensity: u.ambientIntensity,
    debugMode: u.debugMode,
    screenSize: u.screenSize,
    spellLightPos: u.spellLightPos,
    spellLightCol: u.spellLightCol,
    spellLightCount: u.spellLightCount,
    heightTex: u.heightTex,
    auxTex: u.auxTex,
    detailTex: u.detailTex,
    skyLUT: u.skyLUT,
    cascade0: u.cascade0,
    cascade1: u.cascade1,
    cascade2: u.cascade2,
    deformTex: u.deformTex,
   },
   // Babylon LH default (sideOrientation CCW, backFaceCulling=true)
   // ≙ GL frontFace CCW + cull back ≙ FrontSide here (§1.4).
   side: THREE.FrontSide,
  });
 }

 /**
  * The camera-space depth prepass material.
  *
  * Same clipmap and deformation code as the beauty pass through the same
  * includes; only the fragment stage differs. Registered with the prepass
  * rather than with the shadow system, so it takes `viewProjection` — the
  * same shared matrix, which by draw time carries this frame's temporal
  * jitter.
  */
 makePrepassMaterial() {
  const u = this._u;
  let fragment;
  try {
   fragment = getShader("prepassPixelShader");
  } catch (_err) {
   // Peer not landed yet (G1). Same contract output, locally spelled.
   fragment = PREPASS_FALLBACK;
  }
  const mat = makeMaterial({
   name: "terrainPrepass",
   vertex: getShader("terrainPrepassVertexShader"),
   fragment,
   uniforms: {
    viewProjection: u.viewProjection,
    cameraPos: u.cameraPos,
    lodCenter: u.lodCenter,
    baseSpacing: u.baseSpacing,
    gridHalfN: u.gridHalfN,
    worldOrigin: u.worldOrigin,
    worldSize: u.worldSize,
    heightRes: u.heightRes,
    windAngle: u.windAngle,
    sastrugiAmp: u.sastrugiAmp,
    deformCenter: u.deformCenter,
    deformSize: u.deformSize,
    deformDepthScale: u.deformDepthScale,
    heightTex: u.heightTex,
    auxTex: u.auxTex,
    deformTex: u.deformTex,
   },
   side: THREE.DoubleSide,
  });
  this.prepassMat = mat;
  return mat;
 }
 /** @param {number} cascade */
 _makeDepthMaterial(cascade: number) {
  const u = this._u;
  const mat = makeMaterial({
   name: "terrainDepth" + cascade,
   vertex: getShader("terrainDepthVertexShader"),
   fragment: getShader("terrainDepthPixelShader"),
   uniforms: {
    // Distinct per cascade — the shadow system writes this matrix
    // every frame (§7.8). Everything else is the shared set.
    lightViewProjection: { value: new THREE.Matrix4() },
    cameraPos: u.cameraPos,
    lodCenter: u.lodCenter,
    baseSpacing: u.baseSpacing,
    gridHalfN: u.gridHalfN,
    worldOrigin: u.worldOrigin,
    worldSize: u.worldSize,
    heightRes: u.heightRes,
    windAngle: u.windAngle,
    sastrugiAmp: u.sastrugiAmp,
    deformCenter: u.deformCenter,
    deformSize: u.deformSize,
    deformDepthScale: u.deformDepthScale,
    heightTex: u.heightTex,
    auxTex: u.auxTex,
    deformTex: u.deformTex,
   },
   side: THREE.DoubleSide,
   // Forces a distinct program per cascade, mirroring the source's
   // per-cascade Effect split.
   defines: { SNOW_CASCADE: cascade },
  });
  if (!this._depthMats) this._depthMats = [];
  this._depthMats.push(mat);
  return mat;
 }

 async build() {
  // Tilts a grain dome's flank to roughly 30 degrees. Higher reads as
  // gravel, lower stops registering at all.
  this._detailPass.material.uniforms.resolution.value = DETAIL_RES;
  this._detailPass.material.uniforms.grainScale.value = GRAIN_SCALE;
  await bakeOnce(this._detailPass, this._detailRT, "detailBake");

  await this.heightfield.bake();

  // The cascade fitter needs the world's vertical extent to size each
  // light volume's depth range. A margin covers carved berms and anything
  // standing on the snow.
  if (this.shadows && typeof this.shadows.setHeightBounds === "function") {
   this.shadows.setHeightBounds(
    this.heightfield.minHeight - HEIGHT_MARGIN_LO,
    this.heightfield.maxHeight + HEIGHT_MARGIN_HI
   );
  }
 }

 /**
  * Force every terrain pipeline to compile. Called behind the loading screen
  * so the first rendered frame never pays a compile.
  */
 async warmUp() {
  // Before the snow material, because its first compile binds whatever is
  // in the deformation target and reading uninitialised VRAM as a height
  // can put NaN into a vertex position.
  await this.deform.warmUp();
  this.setDeformTexture(this.deform.texture);

  await whenReady(this.gfx, this.material, "snow material");
  if (this.prepassMat) {
   await whenReady(this.gfx, this.prepassMat, "terrain prepass");
  }
  // Stays serial: `whenReady` compiles through core/gpuUtil.js's single
  // shared `_compileScene`, which each call mutates by adding and removing
  // its own mesh. Concurrent compiles interleave on that one scene, so one
  // can strip the mesh another still needs.
  if (this._depthMats) {
   for (let i = 0; i < this._depthMats.length; i++) {
    await whenReady(this.gfx, this._depthMats[i], "terrainDepth" + i);
   }
  }
 }

 /**
  * Point every terrain pipeline at a deformation target. Called once per
  * ping-pong flip; the shared entry means one write covers beauty, prepass
  * and all three depth materials at once.
  * @param {THREE.Texture} tex
  */
 setDeformTexture(tex: THREE.Texture) {
  this._boundDeform = tex;
  this._u.deformTex.value = tex;
 }

 /**
  * Advance the terrain state buffer and push this frame's uniforms.
  *
  * The deformation window follows the *player*, not the camera: the camera can
  * be swung right around and the marks the player left have to stay where they
  * were put.
  *
  * @param {THREE.Vector3} cameraPos
  * @param {{x:number, z:number}} focus world position the deform window centres on
  * @param {number} dt seconds
  */
 update(cameraPos: THREE.Vector3, focus: { x: number; z: number }, dt: number) {
  this._clock += dt;
  const u = this._u;
  const windAngle = (/** @type {number} */ (S.windDirection) * Math.PI) / 180;

  // Simulate first, then bind: the material must sample the target that
  // was written this frame, not the one from last frame, or every mark
  // lands a frame late and fast movement leaves a visible stagger.
  const deformTex = this.deform.update(dt, focus);
  if (deformTex !== this._boundDeform) {
   this.setDeformTexture(deformTex);
  }

  // Clipmap rings follow the player, not the viewer — see the note on
  // `lodCenter` in snow.vertex.glsl. No extra snapping here;
  // `placeClipmapVertex` snaps per ring already.
  u.cameraPos.value.copy(cameraPos);
  u.lodCenter.value.set(focus.x, focus.z);
  u.windAngle.value = windAngle;
  u.macroAmp.value = S.macroHeightScale;
  u.sastrugiAmp.value = S.sastrugiStrength;

  // Zero-copy bindings (sunDir, sunRadiance, shR, cascade matrices,
  // params, splits) are mutated in place by their owners; refresh the
  // references anyway in case a stubbed peer materialised late (G1).
  const sky = this.sky;
  if (sky) {
   if (sky.sunDir) u.sunDir.value = sky.sunDir;
   if (sky.sunRadiance) u.sunRadiance.value = sky.sunRadiance;
   if (sky.sh) u.shR.value = sky.sh;
   if (sky.lut) {
    u.skyLUT.value = sky.lut.isTexture ? sky.lut : sky.lut;
   }
  }
  const sh = this.shadows;
  if (sh) {
   if (sh.matrixValues) u.cascadeMatrices.value = sh.matrixValues;
   if (sh.splitsVec4) u.cascadeSplits.value = sh.splitsVec4;
   if (sh.paramData) u.cascadeParams.value = sh.paramData;
   if (sh.texelSize !== undefined) u.shadowTexel.value = sh.texelSize;
   if (sh.maps) {
    for (let i = 0; i < CASCADE_COUNT; i++) {
     if (sh.maps[i]) u["cascade" + i].value = sh.maps[i];
    }
   }
  }

  u.detailStrength.value = S.detailNormalStrength;
  // Pulsar shimmer: glints pulse at the star's 3 rad/s cadence so the
  // field shimmers in step with the pulsar without strobing the whole scene.
  const glintPulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this._clock * 3.0));
  u.glintIntensity.value = (S.glintIntensity as number) * glintPulse;
  u.glintGrazing.value = S.glintGrazing;
  u.sssStrength.value = S.sssStrength;
  u.sssRadius.value = S.sssRadius;

  u.ambientIntensity.value = S.ambientIntensity;

  u.deformTexel.value = this.deform.texel;
  u.deformDepthScale.value = S.deformDepth;

  u.debugMode.value = DEBUG_MODES[S.debugView] ?? 0;
  u.screenSize.value.set(this.gfx.renderWidth, this.gfx.renderHeight);
  this.material.wireframe = /** @type {boolean} */ (S.wireframe);

  // The prepass and shadow-pass materials share the entries written above,
  // so they already see the identical clipmap parameters — the invariant
  // the source restated per material lives in the sharing here.
 }

 /** @param {number} x @param {number} z */
 heightAt(x: number, z: number) {
  return this.heightfield.heightAt(x, z);
 }

 /** @param {number} x @param {number} z @param {THREE.Vector3} out */
 normalAt(x: number, z: number, out: THREE.Vector3) {
  return this.heightfield.normalAt(x, z, out);
 }

}
