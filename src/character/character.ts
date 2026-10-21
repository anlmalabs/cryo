/**
 * The character system.
 *
 * Owns the skeleton, the garment simulation, the three meshes and the seven
 * pipelines that draw them, and the single small texture that carries every
 * per-frame transform to the GPU.
 *
 * The transform texture is the spine of the whole thing. Rows 0-3 hold bone
 * skinning matrices, rows 4 and beyond hold simulated cloth nodes, and one
 * `update()` per frame writes both into a pre-allocated staging array and
 * uploads it once. Nothing else crosses to the GPU: no per-frame buffers, no
 * matrix uniforms, no vertex data.
 *
 * Allocation per frame: none.
 *
 * Port note on `viewProjection`: Babylon auto-bound it from the active camera.
 * Here every beauty/prepass material shares one module-scope `Matrix4`, and an
 * `onBeforeRender` hook on the meshes rebuilds it from the token camera —
 * whose matrices are the rig's jittered view/projection, copied by
 * `gfx.syncTokenCamera` at the top of the frame's render — immediately before
 * the draw. Same numbers, same jitter, no dependency on the rig object this
 * constructor never receives.
 */

import * as THREE from "three";

import { Figure, BONE_COUNT } from "./figure.js";
import { makePanels, ClothSolver } from "./cloth.js";
import type { ClothPanel } from "./cloth.js";
import { buildBody, buildFur, buildClothMesh } from "./build.js";
import { S } from "../core/settings.js";
import { makeMaterial, whenReady } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import type { ShadowSystem } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import type { Gfx } from "../core/gfx.js";
import type { Terrain } from "../terrain/terrain.js";
import type { Sky } from "../render/sky.js";
import type { DepthPass } from "../render/depthPass.js";
import type { CharacterController } from "./controller.js";

/** Transform texture geometry. Width covers the widest of bones or panel cols. */
const TEX_W = 48;

const TEX_H = 64;

/** First texture row available to cloth panels; 0-3 are the bone matrices. */
const CLOTH_ROW0 = 4;

/** How many cascades the figure casts into. See `ShadowSystem.registerCaster`. */
const CHAR_CASCADES = 2;

/** How many material slots the palette uploads. Two vec4 arrays, one per part. */
const PALETTE_SLOTS = 8;

/** RGBA floats per palette slot. */
const PALETTE_FLOATS = 4;

/** Byte layout of the palette uniforms: 8 slots x 4 floats. */
const PALETTE_STRIDE = PALETTE_SLOTS * PALETTE_FLOATS;

/** Draw-list render order for the opaque character meshes (§4.4). */
const BODY_RENDER_ORDER = 10;

/** The fur sorts last within the opaque group — its `discard` wants solid depth laid down first. */
const FUR_RENDER_ORDER = 10.5;

/**
 * Shadow-map texel size of the fallback (no `ShadowSystem`) stub: one texel of
 * a 2048² map, so a stubbed lookup samples the whole cascade rather than a dot.
 */
const STUB_SHADOW_TEXEL = 1 / 2048;

/** Cascade split distances of the fallback stub: near, mid, far, far. Metres. */
const STUB_SPLITS = [26, 95, 330, 330];

/** Threads per metre of the coarse hand-woven wool in the fabric shader. */
const WEAVE_DENSITY = 210;

/** Shell-fur strands per metre of hem. */
const FUR_DENSITY = 250;

/**
 * Fur droop, as tip travel in metres.
 *
 * Three terms: the wind laid flat, the craft's own forward acceleration
 * thrown the other way, and gravity hard-wired to the vertical. All three are
 * scaled to metres so the droop stays a small, physical displacement at any
 * speed.
 */
/** Wind term, metres per (rad/s of wind). */
const FUR_WIND_TRAVEL = 0.006;

/** Velocity term, metres per (m/s of character velocity). */
const FUR_VEL_TRAVEL = 0.0016;

/** Acceleration term, metres per (m/s²) — the sharpest response of the three. */
const FUR_ACC_TRAVEL = 0.00018;

/** Rest droop with no wind and no motion, metres. */
const FUR_REST_DROOP = -0.018;

/** Floats per panel in `_panelParams`: rowBase, cols, rows, unused. */
const PANEL_PARAM_FLOATS = 4;

/** Maximum panel count `_panelParams` is sized for. */
const PANEL_PARAM_PANELS = 6;

/** Fur-droop wind scale: how much of the configured wind leaning reaches the tips. */
const FUR_WIND_SCALE = 0.6;

/**
 * Material palette. Eight slots, uploaded as two vec4 arrays so every value is
 * live-tunable and nothing is baked into the shader: deep indigo wool, a
 * lighter blue-grey mantle, a pale under-layer at the collar, dark leather.
 *
 * Two properties of these numbers are deliberate and were measured off the
 * render rather than picked as colours.
 *
 * They are *very* saturated. At thirteen degrees the sun has lost most of its
 * blue — the direct beam here is roughly 17:13:6 — so a merely blue-ish albedo
 * comes back out of the multiply as warm grey. The blue has to be about four
 * times the red in the albedo just to survive to two-to-one in the lit areas.
 *
 * They are *very* dark. AgX compresses hard, so an eighth of the snow's albedo
 * is only about three stops down and lands near mid grey on screen. Anything
 * lighter stops reading as a silhouette against the field, which is the one
 * thing the figure has to do at fifteen metres.
 */
const PALETTE = [
 // rgb, roughness
 [0.030, 0.048, 0.125, 0.80], // 0 robe, deep indigo
 [0.075, 0.105, 0.185, 0.74], // 1 mantle, blue-grey
 [0.230, 0.225, 0.205, 0.82], // 2 collar lining, warm pale
 [0.048, 0.033, 0.024, 0.60], // 3 leather
 [0.135, 0.095, 0.072, 0.85], // 4 skin, deep in shade
 [0.120, 0.195, 0.310, 0.70], // 5 trim / scarf, pale blue
 [0.700, 0.720, 0.760, 0.85], // 6 fur (unused by the fabric shader)
 [0.100, 0.100, 0.100, 0.80], // 7 spare
];

/**
 * (sheen, anisotropy, transmission, weave depth) per slot.
 *
 * Transmission is the number to be careful with. Sunlight through a *blue*
 * robe, multiplied by a *warm* sun, comes back grey — so a generous
 * transmission term does not make the garment glow, it desaturates it to the
 * point where the albedo stops mattering. Heavy wool is close to opaque; only
 * the thin under-layer gets a real value.
 */
const PARAMS = [
 [0.22, 0.55, 0.05, 1.00],
 [0.28, 0.45, 0.07, 0.90],
 [0.35, 0.30, 0.22, 1.10],
 [0.06, 0.20, 0.01, 0.35],
 [0.05, 0.00, 0.08, 0.00],
 [0.25, 0.60, 0.12, 1.00],
 [1.00, 0.00, 0.90, 0.00],
 [0.20, 0.00, 0.00, 0.50],
];

// ------------------------------------------------------- module-scope scratch
const _droop = new THREE.Vector3();
const _screen = new THREE.Vector2();
const _furCol = new THREE.Color(0.74, 0.755, 0.795);

/**
 * The one `viewProjection` every character material binds (§7.1). Rebuilt from
 * the token camera right before any character mesh draws — after the post
 * chain has jittered the projection and `gfx.syncTokenCamera` has copied it.
 */
const _viewProjection = new THREE.Matrix4();

/**
 * `onBeforeRender` hook: rebuild the shared `viewProjection` from the token
 * camera. Three passes the renderer and the scene too; neither is used here,
 * so they keep the underscore names rather than disappearing from the arity.
 * @param {unknown} _renderer
 * @param {unknown} _scene
 * @param {THREE.Camera} camera
 */
function _refreshViewProjection(_renderer: unknown, _scene: unknown, camera: THREE.Camera) {
 _viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
}

/** @param {string} name @param {string} fallback */
function shaderOr(name: string, fallback: string) {
 try {
  return getShader(name);
 } catch (err) {
  console.warn("[character] missing peer shader", name, "- using fallback");
  return fallback;
 }
}

/** Contract §1.5: caster fragments write window depth into the R32F color RT. */
const FALLBACK_DEPTH_FRAGMENT = `precision highp float;
precision highp int;

layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0);
}
`;

/** Contract §7.9: the shared prepass output. */
const FALLBACK_PREPASS_FRAGMENT = `precision highp float;
precision highp int;

in float vViewZ;
in float vMask;

layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = vec4(vViewZ, vMask, 0.0, 1.0);
}
`;

/** One uniform slot: the value objects shared across character materials. */
type Uniforms = Record<string, { value: unknown }>;

/**
 * The build metadata `finishSkinned` attaches to every character mesh. Three
 * has no such field, so the builder casts and we name the shape once.
 */
export interface CharacterMeshMetadata {
 /** Triangles the mesh draws, for the perf HUD. */
 triangles: number;
 /** Vertex count of the solid halves; absent on the shell-fur mesh. */
 vertices?: number;
 /** True on the shell-fur mesh, which wires no solid geometry. */
 fur?: boolean;
}

/** A character mesh carries the build metadata `finishSkinned` attaches. */
type CharacterMesh = THREE.Mesh & { metadata: CharacterMeshMetadata };

export class Character {
 /** @type {import("../core/gfx.js").Gfx} */
 gfx!: Gfx;
 /** @type {import("../terrain/terrain.js").Terrain} */
 terrain!: Terrain;
 /** @type {import("../render/sky.js").Sky|null} */
 sky!: Sky | null;
 /** @type {import("../render/shadows.js").ShadowSystem|null} */
 shadows!: ShadowSystem | null;
 /** @type {import("./controller.js").CharacterController} */
 controller!: CharacterController;
 /** @type {import("./figure.js").Figure} */
 figure!: Figure;
 /** @type {import("./cloth.js").ClothPanel[]} */
 panels!: ClothPanel[];
 /** @type {import("./cloth.js").ClothSolver} */
 solver!: ClothSolver;

 /** Transform-texture backing store, RGBA float, one row per panel row. */
 _texData!: Float32Array;
 /** Flat (rowBase, cols, rows, 0) per panel, for the vertex shaders. */
 _panelParams!: Float32Array;
 charTex!: THREE.DataTexture;
 _matAlbedo!: Float32Array;
 _matParams!: Float32Array;

 _cameraPos!: THREE.Vector3;
 _lut!: unknown;
 _sunDir!: THREE.Vector3;
 _sunRadiance!: THREE.Color;
 _shR!: Float32Array;
 _cascadeTex!: THREE.Texture[];
 _cascadeMatrices!: THREE.Matrix4[];
 _cascadeParams!: Float32Array;
 _splits!: THREE.Vector4;
 _shadowTexel!: number;

 bodyMesh!: CharacterMesh;
 clothMesh!: CharacterMesh;
 furMesh!: CharacterMesh;
 bodyMat!: THREE.RawShaderMaterial;
 clothMat!: THREE.RawShaderMaterial;
 furMat!: THREE.RawShaderMaterial;

 _depthMats!: THREE.RawShaderMaterial[];
 _prepassMats!: THREE.RawShaderMaterial[] | null;
 triangles!: number;
 _mats!: THREE.RawShaderMaterial[];
 _fabricMats!: THREE.RawShaderMaterial[];
 _needSettle!: boolean;
 _visible!: boolean;

 /**
  * @param {import("../core/gfx.js").Gfx} gfx
  * @param {import("../terrain/terrain.js").Terrain} terrain
  * @param {import("../render/sky.js").Sky|null} sky
  * @param {import("../render/shadows.js").ShadowSystem|null} shadows
  * @param {import("./controller.js").CharacterController} controller
  */
 constructor(gfx: Gfx, terrain: Terrain, sky: Sky | null, shadows: ShadowSystem | null, controller: CharacterController) {
  this.gfx = gfx;
  this.terrain = terrain;
  this.sky = sky;
  this.shadows = shadows;
  this.controller = controller;

  this.figure = new Figure(terrain);
  this.panels = makePanels();
  this.solver = new ClothSolver(this.panels, terrain);

  // ---- transform texture -------------------------------------------
  this._texData = new Float32Array(TEX_W * TEX_H * 4);
  let row = CLOTH_ROW0;
  /** Flat (rowBase, cols, rows, 0) per panel, for the vertex shaders. */
  this._panelParams = new Float32Array(PANEL_PARAM_PANELS * PANEL_PARAM_FLOATS);
  for (let i = 0; i < this.panels.length; i++) {
   const p = this.panels[i];
   if (p.cols > TEX_W) throw new Error(`panel ${p.name} is ${p.cols} columns wide, wider than the transform texture's ${TEX_W} — raise TEX_W above ${p.cols} or reduce that panel's \`cols\`.`);
   p.nodeRow = row;
   this._panelParams[i * 4] = row;
   this._panelParams[i * 4 + 1] = p.cols;
   this._panelParams[i * 4 + 2] = p.rows;
   row += p.rows;
  }
  if (row > TEX_H) throw new Error(`the panels need ${row} transform-texture rows (TEX_H is ${TEX_H}) — raise TEX_H or shrink the panels' rows/panel count.`);

  this.charTex = new THREE.DataTexture(
   this._texData, TEX_W, TEX_H, THREE.RGBAFormat, THREE.FloatType
  );
  this.charTex.name = "charTex";
  this.charTex.minFilter = THREE.NearestFilter;
  this.charTex.magFilter = THREE.NearestFilter;
  this.charTex.wrapS = THREE.ClampToEdgeWrapping;
  this.charTex.wrapT = THREE.ClampToEdgeWrapping;
  this.charTex.generateMipmaps = false;
  this.charTex.colorSpace = THREE.NoColorSpace;
  this.charTex.flipY = false;
  this.charTex.premultiplyAlpha = false;
  this.charTex.needsUpdate = true;

  // ---- palette ------------------------------------------------------
  this._matAlbedo = new Float32Array(PALETTE_STRIDE);
  this._matParams = new Float32Array(PALETTE_STRIDE);
  for (let i = 0; i < PALETTE_SLOTS; i++) {
   for (let k = 0; k < PALETTE_FLOATS; k++) {
    this._matAlbedo[i * 4 + k] = PALETTE[i][k];
    this._matParams[i * 4 + k] = PARAMS[i][k];
   }
  }

  // ---- shared uniform value objects (stub-tolerant, zero-copy) ------
  this._cameraPos = new THREE.Vector3();
  this._lut = sky && sky.lut ? sky.lut : gfx.blackTex;
  this._sunDir = sky && sky.sunDir ? sky.sunDir : new THREE.Vector3(0, 1, 0);
  this._sunRadiance = sky && sky.sunRadiance ? sky.sunRadiance : new THREE.Color(1, 1, 1);
  this._shR = sky && sky.sh ? sky.sh : new Float32Array(36);

  const maps = shadows && shadows.maps ? shadows.maps : null;
  this._cascadeTex = [];
  for (let i = 0; i < CASCADE_COUNT; i++) {
   // A cascade cleared to 1.0 is "fully lit" — white is the safe stub.
   this._cascadeTex.push(maps && maps[i] ? maps[i] : gfx.whiteTex);
  }
  this._cascadeMatrices = shadows && shadows.matrixValues
   ? shadows.matrixValues
   : [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()];
  this._cascadeParams = shadows && shadows.paramData
   ? shadows.paramData
   : new Float32Array(12);
  this._splits = shadows && shadows.splitsVec4
   ? shadows.splitsVec4
   : new THREE.Vector4(STUB_SPLITS[0], STUB_SPLITS[1], STUB_SPLITS[2], STUB_SPLITS[3]);
  this._shadowTexel = shadows && shadows.texelSize ? shadows.texelSize : STUB_SHADOW_TEXEL;

  // ---- meshes and materials -----------------------------------------
  // The builders return a bare `THREE.Mesh` today, although every one of them
  // attaches its triangle/vertex/fur counts to `metadata` on the way out
  // (`finishSkinned`). The declared return type does not say so yet, so the
  // reads below stay honest by trusting the declared type — see
  // `CharacterMeshMetadata` and the note on `triangles`.
  this.bodyMesh = buildBody(gfx);
  this.clothMesh = buildClothMesh(gfx, this.panels);
  this.furMesh = buildFur(gfx);

  this.bodyMat = this._makeSurfaceMaterial("charBody", "char", "char", false);
  this.clothMat = this._makeSurfaceMaterial("charCloth", "cloth", "char", true);
  this.furMat = this._makeFurMaterial();

  this.bodyMesh.material = this.bodyMat;
  this.clothMesh.material = this.clothMat;
  this.furMesh.material = this.furMat;

  // Opaque scene group (§4.4): body and cloth at 10; the fur draws last
  // within the group — its `discard` disables early-Z, so it wants every
  // opaque depth already laid down when it runs.
  gfx.addMesh(this.bodyMesh, gfx.LAYER.OPAQUE, BODY_RENDER_ORDER);
  gfx.addMesh(this.clothMesh, gfx.LAYER.OPAQUE, BODY_RENDER_ORDER);
  gfx.addMesh(this.furMesh, gfx.LAYER.OPAQUE, FUR_RENDER_ORDER);

  for (const m of [this.bodyMesh, this.clothMesh, this.furMesh]) {
   m.onBeforeRender = _refreshViewProjection;
  }

  /** @type {THREE.RawShaderMaterial[]} */
  this._depthMats = [];
  if (shadows && shadows.registerCaster) {
   shadows.registerCaster(
    this.bodyMesh, (c: number) => this._makeDepthMaterial("charDepth", c, false), CHAR_CASCADES
   );
   shadows.registerCaster(
    this.clothMesh, (c: number) => this._makeDepthMaterial("clothDepth", c, true), CHAR_CASCADES
   );
  }
  // Fur is not registered as a caster. Its shadow lands inside the hood's
  // own, an alpha-tested 22-shell depth pass is not cheap, and what it
  // would contribute is a slightly fuzzier edge on a shadow already an
  // order of magnitude softer than that.

  this.triangles =
   this.bodyMesh.metadata.triangles +
   this.clothMesh.metadata.triangles +
   this.furMesh.metadata.triangles;

  this._mats = [this.bodyMat, this.clothMat, this.furMat];
  this._fabricMats = [this.bodyMat, this.clothMat];
  this._needSettle = true;

  this._visible = true;
  this.setVisible(S.showCharacter !== false);
 }

 /**
  * The uniform slots every character material shares. Values are the *same
  * objects* across materials — the rig/sky/shadow systems mutate them in
  * place and Three re-uploads per draw, so `sync` never copies matrices.
 /** @returns {Record<string, { value: unknown }>} */
 _sharedUniforms(): Uniforms {
  return {
   viewProjection: { value: _viewProjection },
   cameraPos: { value: this._cameraPos },
   sunDir: { value: this._sunDir },
   sunRadiance: { value: this._sunRadiance },
   shR: { value: this._shR },
   cascadeMatrices: { value: this._cascadeMatrices },
   cascadeSplits: { value: this._splits },
   cascadeParams: { value: this._cascadeParams },
   shadowTexel: { value: this._shadowTexel },
   shadowSoftness: { value: 1.4 },
   // Tighter than the terrain's: the figure is small, its cascade is
   // the near one, and a large bias here detaches the contact shadow
   // between the boots and the snow — which is the shadow that tells
   // you the character is standing on the ground rather than in it.
   shadowBias: { value: 0.012 },
   fogDensity: { value: S.fogDensity },
   fogHeightFalloff: { value: S.fogHeightFalloff },
   fogStart: { value: S.fogStart },
   aerialStrength: { value: S.aerialStrength },
   ambientIntensity: { value: S.ambientIntensity },
   charTex: { value: this.charTex },
   skyLUT: { value: this._lut },
   cascade0: { value: this._cascadeTex[0] },
   cascade1: { value: this._cascadeTex[1] },
   cascade2: { value: this._cascadeTex[2] },
  };
 }

 /**
  * One surface material. The body and the garments differ only in their
  * vertex program — the fabric shading, the shadow lookup and the aerial
  * perspective are literally the same code.
/** @param {string} name @param {string} vertex @param {string} fragment @param {boolean} isCloth */
 _makeSurfaceMaterial(name: string, vertex: string, fragment: string, isCloth: boolean): THREE.RawShaderMaterial {
  const uniforms = this._sharedUniforms();
  uniforms.matAlbedo = { value: this._matAlbedo };
  uniforms.matParams = { value: this._matParams };
  uniforms.sssStrength = { value: S.sssStrength };
  // Threads per metre. Coarse hand-woven wool, which is what puts the
  // weave right at the edge of visibility at the distance the figure
  // is normally framed — present in a close-up, gone by ten metres.
  uniforms.weaveDensity = { value: WEAVE_DENSITY };
  uniforms.screenSize = { value: _screen };
  for (const key of SPELL_LIGHT_UNIFORMS) {
   uniforms[key] = { value: key === "spellLightCount" ? 0 : new Float32Array(16) };
  }
  if (isCloth) uniforms.panelParams = { value: this._panelParams };

  // Every garment is an open sheet and the cowl is a shell, so both faces
  // are visible. The fragment shader turns the normal toward the viewer
  // rather than trusting winding — see the note there.
  return makeMaterial({
   name,
   vertex: getShader(vertex + "VertexShader"),
   fragment: getShader(fragment + "PixelShader"),
   uniforms,
   side: THREE.DoubleSide,
  });
 }

 _makeFurMaterial() {
  const uniforms = this._sharedUniforms();
  uniforms.furDroop = { value: _droop };
  uniforms.furDensity = { value: FUR_DENSITY };
  uniforms.furColor = { value: _furCol };

  return makeMaterial({
   name: "charFur",
   vertex: getShader("furVertexShader"),
   fragment: getShader("furPixelShader"),
   uniforms,
   side: THREE.DoubleSide,
  });
 }
 /** @param {string} vertex @param {number} cascade @param {boolean} isCloth */
 _makeDepthMaterial(vertex: string, cascade: number, isCloth: boolean): THREE.RawShaderMaterial {
  const uniforms: Uniforms = {
   // One material instance per cascade, each holding its own matrix —
   // the ShadowSystem writes into it every refit. No mid-pass juggling.
   lightViewProjection: { value: new THREE.Matrix4() },
   charTex: { value: this.charTex },
  };
  if (isCloth) uniforms.panelParams = { value: this._panelParams };
  const mat = makeMaterial({
   name: vertex + cascade,
   vertex: getShader(vertex + "VertexShader"),
   fragment: shaderOr("terrainDepthPixelShader", FALLBACK_DEPTH_FRAGMENT),
   uniforms,
   side: THREE.DoubleSide,
  });
  this._depthMats.push(mat);
  return mat;
 }

 /**
  * Depth-prepass materials for the body and the garments.
  *
  * The fur is left out on the same grounds it is left out of the shadow
  * cascades: it is an alpha-tested twenty-two-shell pass, and what it would
  * contribute is a fractionally fuzzier occlusion edge on a hood rim that is
  * already inside its own baked cavity.
  *
  * @param {import("../render/depthPass.js").DepthPass} depth
  */
 registerPrepass(depth: DepthPass | null) {
  this._prepassMats = [];
  for (const spec of [
   { mesh: this.bodyMesh, vertex: "charPrepass", cloth: false },
   { mesh: this.clothMesh, vertex: "clothPrepass", cloth: true },
  ]) {
   const uniforms: Uniforms = {
    viewProjection: { value: _viewProjection },
    charTex: { value: this.charTex },
   };
   if (spec.cloth) uniforms.panelParams = { value: this._panelParams };
   const mat = makeMaterial({
    name: spec.vertex,
    vertex: getShader(spec.vertex + "VertexShader"),
    fragment: shaderOr("prepassPixelShader", FALLBACK_PREPASS_FRAGMENT),
    uniforms,
    side: THREE.DoubleSide,
   });
   this._prepassMats.push(mat);
   if (depth && depth.registerCaster) depth.registerCaster(spec.mesh, mat);
  }
 }
 /** @param {boolean} v */
 setVisible(v: boolean) {
  this._visible = !!v;
  this.bodyMesh.visible = this._visible;
  this.clothMesh.visible = this._visible;
  this.furMesh.visible = this._visible;
 }

 /**
  * Advance the figure and the garments, then push one texture upload and one
  * set of uniforms.
  *
  * Order matters: the skeleton has to be posed before the cloth can find its
  * kinematic targets, and both have to be written before the texture goes up,
  * or the garments render one frame behind the body they hang from.
  *
  * @param {number} dt
  */
 update(dt: number) {
  const ch = this.controller;
  this.figure.update(dt, ch);
  if (this._needSettle) {
   this._settleCloth();
   this._needSettle = false;
  }
  this.solver.update(dt, this.figure, ch);
  this._uploadTransforms();
 }

 /**
  * Push this frame's uniforms. Split from `update` because the garments have
  * to be solved before the contact system reads the feet, while the uniforms
  * cannot be written until the camera has moved and the cascades have been
  * refitted. Doing both at one point in the frame means one of them is a
  * frame stale, and the visible symptom — a shadow that lags the figure by a
  * frame during a fast carve — is exactly the sort of thing that reads as
  * "cheap" without being identifiable.
  *
  * @param {THREE.Vector3} cameraPos
  */
 sync(cameraPos: THREE.Vector3) {
  this._cameraPos.copy(cameraPos);
  this._pushUniforms();
 }

 /**
  * Drop every garment straight onto its kinematic target.
  *
  * Done once, on the first update. The panels are authored in bind space at
  * the world origin, and letting them fall from there to wherever the player
  * actually spawned takes a second of visible flapping — behind the loading
  * screen if we are lucky, in shot if we are not.
  */
 _settleCloth() {
  const skin = this.figure.skin;
  for (let pi = 0; pi < this.panels.length; pi++) {
   const p = this.panels[pi];
   for (let k = 0; k < p.count; k++) {
    const b = p.bone[k] * 16;
    const o = k * 3;
    const x = p.bindPos[o], y = p.bindPos[o + 1], z = p.bindPos[o + 2];
    p.pos[o] = skin[b] * x + skin[b + 4] * y + skin[b + 8] * z + skin[b + 12];
    p.pos[o + 1] = skin[b + 1] * x + skin[b + 5] * y + skin[b + 9] * z + skin[b + 13];
    p.pos[o + 2] = skin[b + 2] * x + skin[b + 6] * y + skin[b + 10] * z + skin[b + 14];
   }
   p.prev.set(p.pos);
  }
 }

 _uploadTransforms() {
  const d = this._texData;
  const skin = this.figure.skin;

  // Rows 0-3: bone matrices, one column per bone, one row per matrix
  // column. Written as four separate row writes rather than one blit,
  // because the texture is column-major in bones and row-major in memory.
  for (let b = 0; b < BONE_COUNT; b++) {
   const s = b * 16;
   for (let c = 0; c < 4; c++) {
    const o = (c * TEX_W + b) * 4;
    d[o] = skin[s + c * 4];
    d[o + 1] = skin[s + c * 4 + 1];
    d[o + 2] = skin[s + c * 4 + 2];
    d[o + 3] = skin[s + c * 4 + 3];
   }
  }

  for (let pi = 0; pi < this.panels.length; pi++) {
   const p = this.panels[pi];
   const pos = p.pos;
   for (let j = 0; j < p.rows; j++) {
    const rowO = ((p.nodeRow + j) * TEX_W) * 4;
    for (let i = 0; i < p.cols; i++) {
     const s = (j * p.cols + i) * 3;
     const o = rowO + i * 4;
     d[o] = pos[s];
     d[o + 1] = pos[s + 1];
     d[o + 2] = pos[s + 2];
     d[o + 3] = 1;
    }
   }
  }

  // One upload per frame: Three versions the texture and re-sends the
  // backing array on the next bind.
  this.charTex.needsUpdate = true;
 }

 _pushUniforms() {
  const ch = this.controller;

  // Fur droop: gravity, plus the apparent wind, plus the character's own
  // acceleration thrown the other way. Scaled to metres of tip travel.
  const a = (/** @type {number} */ (S.windDirection) * Math.PI) / 180;
  const ws = FUR_WIND_SCALE * /** @type {number} */ (S.windStrength);
  _droop.set(
   Math.sin(a) * ws * FUR_WIND_TRAVEL
   - ch.velocity.x * FUR_VEL_TRAVEL - ch.acceleration.x * FUR_ACC_TRAVEL,
   FUR_REST_DROOP,
   Math.cos(a) * ws * FUR_WIND_TRAVEL
   - ch.velocity.z * FUR_VEL_TRAVEL - ch.acceleration.z * FUR_ACC_TRAVEL
  );

  // Everything zero-copy (sunDir, shR, cascade matrices/params/splits,
  // cameraPos, furDroop, screenSize, palette arrays) is a shared object
  // the owner mutates; only the plain-number settings need re-assigning.
  for (let i = 0; i < this._mats.length; i++) {
   const u = this._mats[i].uniforms;
   u.fogDensity.value = S.fogDensity;
   u.fogHeightFalloff.value = S.fogHeightFalloff;
   u.fogStart.value = S.fogStart;
   u.aerialStrength.value = S.aerialStrength;
   u.ambientIntensity.value = S.ambientIntensity;
  }

  _screen.set(this.gfx.renderWidth, this.gfx.renderHeight);

  for (let i = 0; i < this._fabricMats.length; i++) {
   const u = this._fabricMats[i].uniforms;
   u.sssStrength.value = S.sssStrength;
   u.weaveDensity.value = 210;
  }
 }

 /** Compile every pipeline behind the loading screen. */
 async warmUp() {
  await whenReady(this.gfx, this.bodyMat, "character body material");
  await whenReady(this.gfx, this.clothMat, "character cloth material");
  await whenReady(this.gfx, this.furMat, "character fur material");
  await this._warmMaterials(this._depthMats);
  if (this._prepassMats) await this._warmMaterials(this._prepassMats);
 }

 /**
  * Compile a list of materials one at a time, in order.
  *
  * Sequential by construction, not by oversight: `whenReady` ends in
  * `compileMaterial` (gpuUtil.ts), which adds a probe mesh to one
  * *module-scope shared* scene and removes it in its own `.finally()`.
  * Compiling two materials concurrently would race those add/remove pairs
  * on that one scene — the second material can compile while the first's
  * probe mesh is being torn down, which is an intermittent GL-side
  * corruption that no typecheck can see. `whenReady` also races a watchdog
  * per material, so `Promise.all` would discard the survivors' compile work
  * the moment one timed out.
  *
  * @param {readonly THREE.RawShaderMaterial[]} mats
  */
 private async _warmMaterials(mats: readonly THREE.RawShaderMaterial[]): Promise<void> {
  for (let i = 0; i < mats.length; i++) {
   const m = mats[i];
   await whenReady(this.gfx, m, m.name);
  }
 }

 dispose() {
  const scene = this.gfx.scene;
  for (const mesh of [this.bodyMesh, this.clothMesh, this.furMesh]) {
   scene.remove(mesh);
   mesh.geometry.dispose();
  }
  this.bodyMat.dispose();
  this.clothMat.dispose();
  this.furMat.dispose();
  for (let i = 0; i < this._depthMats.length; i++) this._depthMats[i].dispose();
  if (this._prepassMats) {
   for (let i = 0; i < this._prepassMats.length; i++) this._prepassMats[i].dispose();
  }
  this.charTex.dispose();
 }
}
