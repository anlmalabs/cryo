/**
 * GPU helpers: material construction, fullscreen passes, and warm-up.
 *
 * In the Babylon build these existed because WebGPU compiles asynchronously
 * and a material constructed on one line was not usable on the next. WebGL2
 * compiles synchronously but janks instead, so the shape survives: everything
 * still compiles behind the loading screen, via `renderer.compileAsync` (which
 * rides `KHR_parallel_shader_compile` where present), and the 25 s labelled
 * watchdog stays as the compile-error diagnostic it always was.
 */

import * as THREE from "three";
import { composeShader } from "../shaders/registry.js";

// --------------------------------------------------------------- makeMaterial

/**
 * The shader-body + uniforms contract every caller fills in.
 *
 * The index signature is the documented pass-through: every key past
 * `name`/`vertex`/`fragment`/`uniforms` is spread onto the
 * `RawShaderMaterialParameters` bag as a material flag. It does NOT validate
 * those keys — a typo (`transparnet`) is passed through unchecked, exactly as
 * the original `& Record<string, unknown>` JSDoc did. The part that IS
 * recovered versus that JSDoc is `uniforms`: unlike a bare record of uniforms,
 * this narrows each value to `{ value: … }`, so it catches a material flag
 * passed in the uniforms slot as well as a bare uniform value passed there.
 */
interface MaterialOpts {
 /** Optional label; `mat.name` falls back to `""`. */
 name?: string;
 /** Raw GLSL ES 3.0 body (no `#version` line); chunks are resolved here. */
 vertex: string;
 /** Raw GLSL ES 3.0 body (no `#version` line); chunks are resolved here. */
 fragment: string;
 /** Named uniforms, passed straight through to the material. */
 uniforms?: Record<string, { value: unknown }>;
 /** Any other key is spread onto the material as a flag. Not validated. */
 [flag: string]: unknown;
}

/**
 * Build a `RawShaderMaterial` with `#include<snowXxx>` chunks resolved.
 */
export function makeMaterial(opts: MaterialOpts) {
 const { name, vertex, fragment, uniforms, ...flags } = opts;
 const mat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: composeShader(vertex),
  fragmentShader: composeShader(fragment),
  uniforms: uniforms || {},
  ...flags,
 });
 mat.name = name || "";
 return mat;
}

// ------------------------------------------------------------ fullscreen pass

/**
 * One shared clip-space triangle (−1..3) for every fullscreen pass. `vUV` is
 * in [0,1] over the viewport with v = 0 at the BOTTOM (GL convention) — the
 * orientation every bake and post shader in this port assumes.
 */
let _triGeometry: THREE.BufferGeometry | null = null;

function triGeometry() {
 if (!_triGeometry) {
  _triGeometry = new THREE.BufferGeometry();
  _triGeometry.setAttribute(
   "position",
   new THREE.BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2)
  );
  // The position here is 2D on purpose — it is already clip space — but
  // three's bounds pass reads a z off every vertex regardless, gets
  // `undefined` from a two-component attribute, and warns about a NaN
  // radius on every boot. The triangle covers the screen by definition
  // and is never culled, so give it bounds that say so.
  _triGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
 }
 return _triGeometry;
}

const FS_VERTEX = /* glsl */ `precision highp float;
precision highp int;

in vec2 position;
out vec2 vUV;

void main() {
    vUV = position * 0.5 + vec2(0.5);
    gl_Position = vec4(position, 0.0, 1.0);
}
`;

/** One fullscreen triangle drawn with the caller's GLSL body. */
interface FullscreenPassOpts {
 /** Label used in watchdog messages; `mat.name` falls back to `"fullscreen"`. */
 name?: string;
 /** Raw GLSL ES 3.0 body (no `#version` line); chunks are resolved here. */
 fragment: string;
 /** Named uniforms, passed straight through to the material. */
 uniforms?: Record<string, { value: unknown }>;
}

export class FullscreenPass {
 /** The device layer; owned by `core/gfx.js`. */
 gfx: GfxLike;
 /** Label used in watchdog messages. */
 name: string;
 _material: THREE.RawShaderMaterial;
 _mesh: THREE.Mesh;
 _scene: THREE.Scene;
 _camera: THREE.Camera;
 /**
  * @param {GfxLike} gfx
  * @param {{name?: string, fragment: string, uniforms?: Record<string, {value: unknown}>}} opts
  */
 constructor(gfx: GfxLike, opts: FullscreenPassOpts) {
  this.gfx = gfx;
  this.name = opts.name || "fullscreen";

  this._material = new THREE.RawShaderMaterial({
   glslVersion: THREE.GLSL3,
   vertexShader: FS_VERTEX,
   fragmentShader: composeShader(opts.fragment),
   uniforms: opts.uniforms || {},
   depthTest: false,
   depthWrite: false,
  });
  this._material.name = this.name;

  this._mesh = new THREE.Mesh(triGeometry(), this._material);
  this._mesh.frustumCulled = false;
  this._mesh.matrixAutoUpdate = false;

  this._scene = new THREE.Scene();
  this._scene.add(this._mesh);
  this._camera = new THREE.Camera();
 }

 get material() {
  return this._material;
 }

 /**
  * Draw the triangle once into `target` (or the canvas when null).
  * @param {THREE.WebGLRenderTarget|null} target
  */
 render(target: THREE.WebGLRenderTarget | null) {
  const r = this.gfx.renderer;
  r.setRenderTarget(target || null);
  r.render(this._scene, this._camera);
 }
}

// -------------------------------------------------------------------- warm-up

const WATCHDOG_MS = 25000;

// Shared scaffolding for compiling a bare material.
let _compileScene: THREE.Scene | null = null;
/** The slice of `core/gfx.js`'s `Gfx` the warm-up path touches. */
interface GfxLike {
 renderer: THREE.WebGLRenderer;
 scene: THREE.Scene;
 threeCamera: THREE.Camera;
}

/** @param {GfxLike} gfx @param {THREE.Material} material */
function compileMaterial(gfx: GfxLike, material: THREE.Material) {
 if (!_compileScene) _compileScene = new THREE.Scene();
 const scene = _compileScene;
 const mesh = new THREE.Mesh(triGeometry(), material);
 mesh.frustumCulled = false;
 mesh.matrixAutoUpdate = false;
 scene.add(mesh);
 return gfx.renderer
  .compileAsync(scene, gfx.threeCamera)
  .finally(() => scene.remove(mesh));
}

/**
 * True for anything three would accept as a material. `isMaterial` is a
 * property three sets on the prototype, so this matches materials produced
 * anywhere in the process — including ones reconstructed across a module
 * boundary that `instanceof` would reject and this path would then skip.
 */
function isMaterial(v: unknown): v is THREE.Material {
 if (typeof v !== "object" || v === null || !("isMaterial" in v)) return false;
 return v.isMaterial === true;
}

/** True for a wrapper carrying a real material on `.material`. */
function hasMaterial(v: unknown): v is { material: THREE.Material } {
 if (typeof v !== "object" || v === null || !("material" in v)) return false;
 return isMaterial(v.material);
}

/**
 * A thing the warm-up path can compile: the pass itself, a bare material, or a
 * subsystem wrapper carrying one on `.material`. Anything else is a stub peer
 * with nothing to compile, which the watchdog tolerates.
 */
type Compilable =
 | FullscreenPass
 | THREE.Material
 | { material: THREE.Material }
 | null
 | undefined;

/**
 * Compile whatever `materialOrPass` is, behind a labelled 25 s watchdog.
 *
 * Accepts a `FullscreenPass`, a raw material, or any object carrying a
 * `.material` (a subsystem pass wrapper). When `drawFn` is given it is awaited
 * instead — for passes whose compilation needs a real draw.
 *
 * @param {GfxLike} gfx
 * @param {Compilable} materialOrPass
 * @param {string} label used in the timeout message
 * @param {() => unknown} [drawFn]
 * @returns {Promise<void>}
 */
export function whenReady(gfx: GfxLike, materialOrPass: Compilable, label: string, drawFn?: () => unknown) {
 // DOM lib returns a number from setTimeout; node's typings return a Timeout.
 // `window.setTimeout` is the browser call this actually makes, so number.
 let timer: number | null = null;
 const watchdog = new Promise((_resolve, reject) => {
  timer = setTimeout(() => {
   reject(new Error(
    label + " never became ready after 25s — " +
    "almost always a GLSL compile error; check the console."
   ));
  }, WATCHDOG_MS);
 });

 const work = (async () => {
  if (drawFn) {
   await drawFn();
   return;
  }
  const obj = materialOrPass;
  if (!obj) return;
  if (obj instanceof FullscreenPass) {
   await gfx.renderer.compileAsync(obj._scene, obj._camera);
   return;
  }
  // Narrowing through the guards keeps the original truthiness check on
  // `isMaterial` — the same set of materials the original code compiled.
  if (isMaterial(obj)) {
   await compileMaterial(gfx, obj);
   return;
  }
  if (hasMaterial(obj)) {
   await compileMaterial(gfx, obj.material);
   return;
  }
  // Nothing compilable — a stub peer. Tolerated (G1).
 })();

 return Promise.race([work, watchdog]).finally(() => clearTimeout(timer as number | undefined));
}

/**
 * The bake pattern: compile a fullscreen pass, then render it exactly once.
 * @param {FullscreenPass} pass
 * @param {THREE.WebGLRenderTarget|null} target
 * @param {string} [label]
 */
export async function bakeOnce(pass: FullscreenPass, target: THREE.WebGLRenderTarget | null, label?: string) {
 await whenReady(pass.gfx, pass, label || pass.name);
 pass.render(target);
}

/**
 * Compile every material currently in the main scene.
 * @param {import("./gfx.js").Gfx} gfx
 */
export function compileAll(gfx: GfxLike) {
 return gfx.renderer.compileAsync(gfx.scene, gfx.threeCamera);
}
