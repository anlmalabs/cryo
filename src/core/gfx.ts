/**
 * The engine replacement — everything Babylon's `Engine`/`Scene` did
 * implicitly lives here explicitly.
 *
 * Owns: the `WebGLRenderer`, the boot capability gate, the layer constants,
 * the pass runner (material swap + layer mask + render), the screen-sized
 * render-target registry (resolutionScale / resize), and the token
 * `THREE.Camera` handed to `renderer.render` for its internal sorting only.
 *
 * Three is a rasterizer here, nothing more: every mesh sits at an identity
 * world matrix, every material is a `RawShaderMaterial`, and no shader reads a
 * Three auto-uniform. The camera whose matrices actually reach the GPU is the
 * plain object owned by `core/camera.js`.
 */

import * as THREE from "three";
import * as loading from "./loading.js";

/**
 * Private layer bit the pass runner toggles on casters for a material-swap
 * pass. Never assigned to a mesh permanently; must not collide with
 * `LAYER.SKY/OPAQUE/BLEND`.
 */
const PASS_LAYER = 30;

// ------------------------------------------------------- module-scope scratch
const _clearColor = new THREE.Color();
const _size = new THREE.Vector2();

/**
 * A mesh temporarily wearing another material for one pass. `_savedMaterial`
 * and `_savedMask` are the swap-back slot — the pass runner writes and then
 * clears them, so a record is used once at a time.
 */
interface Caster {
 mesh: THREE.Mesh;
 material: THREE.Material;
 // `THREE.Mesh.material` is `Material | Material[]`; the slot mirrors that so
 // the swap-back restores exactly what was there, arrays included. It is null
 // between passes, which is how the code knows a record is not mid-swap.
 _savedMaterial?: THREE.Material | THREE.Material[] | null;
 _savedMask?: number;
}

/** One render-pass request. Every field is optional; a bare `{}` renders as-is. */
interface RunPassOpts {
 /** Draw into this target, or the canvas when null/omitted. */
 target?: THREE.WebGLRenderTarget | null;
 /** [r,g,b,a] linear clear colour; alpha may be omitted, floats >1 allowed. */
 clearColor?: number[] | null;
 /** Clear depth as well as colour. */
 clearDepth?: boolean;
 /** Meshes to material-swap and draw alone this pass. */
 casters?: Caster[] | null;
 /** Layer mask to draw when `casters` is absent. */
 layer?: number;
 /** Camera to render with; defaults to the token camera. */
 camera?: THREE.Camera | null;
}

/** Render-target construction knobs; every fallback is three's own default. */
interface RenderTargetOpts {
 type?: THREE.TextureDataType;
 format?: THREE.PixelFormat;
 /**
  * A GL enum name three's own `PixelFormatGPU` union does not list (e.g.
  * "RG32F" for the RG32F heightfield). Kept as `string` on purpose: it is a
  * raw GL token, not a three format constant, and the one caller that uses
  * it needs to say a name three has no member for.
  */
 internalFormat?: string | null;
 filter?: THREE.MagnificationTextureFilter;
 wrap?: THREE.Wrapping;
 depth?: boolean;
 mips?: boolean;
}

function makeFallbackTexture(r: number, g: number, b: number, a: number): THREE.Texture {
 const data = new Uint8Array([r, g, b, a]);
 const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
 tex.colorSpace = THREE.NoColorSpace;
 tex.flipY = false;
 tex.premultiplyAlpha = false;
 tex.generateMipmaps = false;
 tex.minFilter = THREE.NearestFilter;
 tex.magFilter = THREE.NearestFilter;
 tex.wrapS = THREE.ClampToEdgeWrapping;
 tex.wrapT = THREE.ClampToEdgeWrapping;
 tex.needsUpdate = true;
 return tex;
}

export class Gfx {
 /** Layer bits — a mesh is in exactly one. */
 LAYER: { SKY: number; OPAQUE: number; BLEND: number };
 /** The container scene; meshes are added here at an identity world matrix. */
 scene: THREE.Scene;
 /** The renderer. Owns the GL context; nothing else may touch it. */
 renderer: THREE.WebGLRenderer;
 /** The element the renderer draws into. */
 canvas: HTMLCanvasElement;
 /** Capability flags probed at construction: 32F-filter and parallel compile. */
 caps: { floatLinear: boolean; parallelCompile: boolean };
 /** Token camera handed to `renderer.render` for its internal sorting only. */
 threeCamera: THREE.Camera;
 /** 1x1 textures bound when a peer sampler is missing, so boot cannot crash. */
 whiteTex: THREE.Texture;
 blackTex: THREE.Texture;
 /** Current resolution scale (the source's `S.resolutionScale`). */
 _scale: number;
 /** Screen-sized targets kept in step with the render size. */
 _tracked: { rt: THREE.WebGLRenderTarget; scale: number }[];
 /** Render-size subscribers, notified by `resize()`. */
 _resizeFns: Set<(w: number, h: number) => void>;
 /** @param {HTMLCanvasElement} canvas */
 constructor(canvas: HTMLCanvasElement) {
  /** @type {THREE.WebGLRenderer} */
  let renderer;
  try {
   renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // TAA handles edges; MSAA would just cost bandwidth
    stencil: false,
    powerPreference: "high-performance",
   });
  } catch (err) {
   console.error(err);
   throw new Error(
    "Could not create a WebGL2 context on this device, so the demo cannot start. " +
    "This usually means WebGL is disabled or blacklisted (common on VMs and on " +
    "some Chrome/linux software-fallback paths) — try an up-to-date browser on a " +
    "desktop GPU, or enable hardware acceleration."
   );
  }
  if (!renderer.capabilities.isWebGL2) {
   renderer.dispose();
   throw new Error(
    "This device exposes a WebGL context but only WebGL 1, and the demo's shaders " +
    "and render targets need WebGL 2 — try an up-to-date browser on a desktop GPU " +
    "with hardware acceleration on."
   );
  }

  const gl = renderer.getContext();
  // Every HDR target needs this; there is no fallback path worth having.
  if (!gl.getExtension("EXT_color_buffer_float")) {
   renderer.dispose();
   throw new Error(
    "This browser exposes WebGL2 but not float colour attachments " +
    "(EXT_color_buffer_float), which every HDR render target in the demo needs — " +
    "there is no lower-quality path to fall back to, so the demo cannot run here. " +
    "Try an up-to-date browser on a desktop GPU."
   );
  }
  // The heightfield is RG32F and is filtered in the vertex shader. Warn
  // and degrade (owners of 32F targets check `caps.floatLinear`).
  const floatLinear = !!gl.getExtension("OES_texture_float_linear");
  if (!floatLinear) {
   console.warn("[snowflow] float32-filterable unavailable; height will step");
  }
  const parallelCompile = !!gl.getExtension("KHR_parallel_shader_compile");

  // Color policy: sRGB encoding happens exactly once, inside the
  // tonemap/composite pass. Nothing here may touch color.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setPixelRatio(1);
  // All clears are explicit in `runPass` — the beauty pass renders three
  // layers into one target with depth persisting across all three.
  renderer.autoClear = false;
  // The draw counter latches and resets this manually (`perf.js`).
  renderer.info.autoReset = false;

  this.renderer = renderer;
  this.canvas = canvas;

  this.caps = { floatLinear, parallelCompile };

  /** Layer bits — a mesh is in exactly one. */
  this.LAYER = { SKY: 1, OPAQUE: 2, BLEND: 3 };

  this.scene = new THREE.Scene();

  // Token camera: `renderer.render` needs one for its internal sorting.
  // Its matrices are copied from the rig each frame and are never a
  // source of truth — RawShaderMaterial reads no Three auto-uniforms.
  this.threeCamera = new THREE.Camera();
  this.threeCamera.matrixAutoUpdate = false;
  this.threeCamera.matrixWorldAutoUpdate = false;

  // 1x1 fallbacks for stub tolerance: a material whose peer sampler is
  // missing binds one of these instead of crashing boot.
  this.whiteTex = makeFallbackTexture(255, 255, 255, 255);
  this.blackTex = makeFallbackTexture(0, 0, 0, 255);

  this._scale = 1;
  /** @type {{rt: THREE.WebGLRenderTarget, scale: number}[]} */
  this._tracked = [];
  /** @type {Set<(w:number, h:number) => void>} */
  this._resizeFns = new Set();

  this.resize();
 }

 /**
  * Add a mesh to the draw list. All world math lives in vertex shaders;
  * the scene graph is a container, so the matrix stays identity forever.
  * @param {THREE.Object3D} mesh
  * @param {number} layerBit one of `gfx.LAYER`
  * @param {number} renderOrder
  */
 addMesh(mesh: THREE.Object3D, layerBit: number, renderOrder: number): THREE.Object3D {
  mesh.layers.set(layerBit);
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  this.scene.add(mesh);
  return mesh;
 }

 /**
  * Run one render pass. The only mechanism for Babylon's
  * `setMaterialForRendering`: with `casters`, each mesh temporarily wears
  * its per-pass material and only those meshes draw; otherwise the given
  * layer renders with current materials.
  *
  * @param {{
  *   target?: THREE.WebGLRenderTarget|null,
  *   clearColor?: number[]|null,   // [r,g,b,a] linear, floats allowed >1
  *   clearDepth?: boolean,
  *   casters?: {mesh: THREE.Object3D, material: THREE.Material}[]|null,
  *   layer?: number,
  *   camera?: THREE.Camera|null,
  * }} opts
  */
 runPass(opts: RunPassOpts) {
  const r = this.renderer;
  const cam = opts.camera || this.threeCamera;
  const target = opts.target !== undefined ? opts.target : null;

  r.setRenderTarget(target);

  const clearColor = opts.clearColor;
  if (clearColor) {
   _clearColor.setRGB(clearColor[0], clearColor[1], clearColor[2]);
   r.setClearColor(_clearColor, clearColor.length > 3 ? clearColor[3] : 1);
  }
  if (clearColor || opts.clearDepth) {
   r.clear(!!clearColor, !!opts.clearDepth, false);
  }

  const casters = opts.casters;
  if (casters) {
   for (let i = 0; i < casters.length; i++) {
    const c = casters[i];
    c._savedMaterial = c.mesh.material;
    c._savedMask = c.mesh.layers.mask;
    c.mesh.material = c.material;
    c.mesh.layers.enable(PASS_LAYER);
   }
   cam.layers.set(PASS_LAYER);
   r.render(this.scene, cam);
   for (let i = 0; i < casters.length; i++) {
    const c = casters[i];
    // Both slots were written two loops ago and read exactly once, so they are
    // defined here; the non-null reads say so rather than re-deriving it.
    c.mesh.material = c._savedMaterial as THREE.Material | THREE.Material[];
    c.mesh.layers.mask = c._savedMask as number;
    c._savedMaterial = null;
   }
  } else {
   cam.layers.set(opts.layer || 0);
   r.render(this.scene, cam);
  }
 }

 /**
  * Create a render target under the port's texture policy (§2.2): no color
  * space, no flip, no premultiply, mips only when asked.
  *
  * @param {string} name
  * @param {number} w @param {number} h
  * @param {{
  *   type?: number, format?: number, internalFormat?: string|null,
  *   filter?: number, wrap?: number, depth?: boolean, mips?: boolean,
  * }} [opts]
  */
 makeRenderTarget(name: string, w: number, h: number, opts: RenderTargetOpts = {}) {
  const o = opts || {};
  const filter = o.filter !== undefined ? o.filter : THREE.LinearFilter;
  const mips = !!o.mips;
  const rt = new THREE.WebGLRenderTarget(w, h, {
   type: o.type !== undefined ? o.type : THREE.HalfFloatType,
   format: o.format !== undefined ? o.format : THREE.RGBAFormat,
   minFilter: mips ? THREE.LinearMipmapLinearFilter : filter,
   magFilter: filter,
   wrapS: o.wrap !== undefined ? o.wrap : THREE.ClampToEdgeWrapping,
   wrapT: o.wrap !== undefined ? o.wrap : THREE.ClampToEdgeWrapping,
   depthBuffer: !!o.depth,
   stencilBuffer: false,
   generateMipmaps: mips,
   colorSpace: THREE.NoColorSpace,
  });
  // `o.internalFormat` is a raw GL enum name; three's texture field is its own
  // `PixelFormatGPU` union, which is a different (smaller) set of tokens.
  if (o.internalFormat) {
   rt.texture.internalFormat = o.internalFormat as THREE.PixelFormatGPU;
  }
  rt.texture.name = name;
  rt.texture.flipY = false;
  rt.texture.premultiplyAlpha = false;
  return rt;
 }

 /**
  * Register a screen-sized target so resolutionScale changes and window
  * resizes keep it in step with the render size.
  * @param {THREE.WebGLRenderTarget} rt
  * @param {number} [scale] fraction of render size (1, 1/4, 1/16…)
  */
 trackScreenTarget(rt: THREE.WebGLRenderTarget, scale = 1) {
  this._tracked.push({ rt, scale });
  rt.setSize(
   Math.max(1, Math.round(this.renderWidth * scale)),
   Math.max(1, Math.round(this.renderHeight * scale))
  );
 }

 /** @param {number} s resolution scale (the source's `S.resolutionScale`) */
 setRenderScale(s: number) {
  this._scale = s || 1;
  this.resize();
 }

 /** Resize the canvas backbuffer and every tracked render target. */
 resize() {
  const canvas = this.canvas;
  const cssW = canvas.clientWidth || canvas.width || 1;
  const cssH = canvas.clientHeight || canvas.height || 1;
  const w = Math.max(1, Math.round(cssW * this._scale));
  const h = Math.max(1, Math.round(cssH * this._scale));
  this.renderer.setSize(w, h, false);

  for (let i = 0; i < this._tracked.length; i++) {
   const t = this._tracked[i];
   t.rt.setSize(
    Math.max(1, Math.round(w * t.scale)),
    Math.max(1, Math.round(h * t.scale))
   );
  }
  for (const fn of this._resizeFns) fn(w, h);
 }

 /**
  * Subscribe to render-size changes (the post chain resets its TAA history
  * here). Returns an unsubscribe function.
  * @param {(w:number, h:number) => void} fn
  */
 onResize(fn: (w: number, h: number) => void): () => boolean {
  this._resizeFns.add(fn);
  return () => this._resizeFns.delete(fn);
 }

 /** Drawing-buffer width in pixels. */
 get renderWidth() {
  return this.renderer.getDrawingBufferSize(_size).x;
 }

 /** Drawing-buffer height in pixels. */
 get renderHeight() {
  return this.renderer.getDrawingBufferSize(_size).y;
 }

 /**
  * Copy the rig camera's matrices into the token camera — for Three's
  * internal sorting only. Called by main once per frame, after the post
  * chain has jittered the projection.
  * @param {{view: THREE.Matrix4, projection: THREE.Matrix4}} rigCamera
  */
 syncTokenCamera(rigCamera: { view: THREE.Matrix4; projection: THREE.Matrix4 }) {
  const cam = this.threeCamera;
  cam.projectionMatrix.copy(rigCamera.projection);
  cam.projectionMatrixInverse.copy(rigCamera.projection).invert();
  cam.matrixWorldInverse.copy(rigCamera.view);
  cam.matrixWorld.copy(rigCamera.view).invert();
 }
}

/**
 * Build the device layer, or fail the boot screen and return null.
 *
 * `canvas` is typed loosely as an element because the callers resolve it through
 * `getElementById`; a null or non-canvas there is reported through `fail()` as
 * the same kind of boot stop as a missing capability, rather than throwing a
 * type-shaped surprise at whoever passes it.
 *
 * The failure message (no WebGL2 vs. no float render targets) is written by the
 * capability gate itself, so the caller only has to stop.
 * @param {HTMLElement|null} canvas
 * @returns {Gfx|null}
 */
export function createGfx(canvas: HTMLElement | null): Gfx | null {
 if (!(canvas instanceof HTMLCanvasElement)) {
  loading.fail("The canvas element is missing from the page, so there is nothing to render to.");
  return null;
 }
 try {
  return new Gfx(canvas);
 } catch (err: unknown) {
  // The capability gate in the constructor throws a specific, actionable
  // message and already did its own cleanup. `fail()` only renders what
  // it is given, so the typed reason has to survive the boundary here —
  // substituting a generic one would throw away the diagnosis.
  console.error(err);
  const message = err instanceof Error && err.message
   ? err.message
   : "The graphics device could not be initialised (no diagnostic was reported).";
  loading.fail(message);
  return null;
 }
}
