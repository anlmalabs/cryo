/**
 * Scene depth prepass — linear view depth and a specular mask, for the post chain.
 *
 * Every screen-space effect needs to know how far away a pixel is: TAA
 * reprojects last frame's colour through it, the light shafts test occlusion
 * along it, depth of field takes its circle of confusion from it, and the
 * screen-space reflections march it.
 *
 * A generic depth renderer cannot supply it. Nothing in this scene has CPU
 * geometry that matches what is drawn: the terrain's vertices are grid indices
 * placed by the clipmap vertex shader, the character is skinned from a transform
 * texture, the wake is a lattice evaluated from a spine, and the crystals are
 * generated from a growth curve. So this owns the pass, exactly as the shadow
 * cascades do, and for the same reason — a caster registers the vertex program
 * it is actually drawn with.
 *
 * Channels, RGBA16F:
 *
 *   r   linear view depth in metres — the clip-space w, which for a perspective
 *       projection *is* the view-space z, carried through as a varying rather
 *       than reconstructed from the depth buffer. Exact, and it costs one
 *       interpolant.
 *   g   specular mask: 0 matte snow, 1 mirror ice. Only the reflection pass
 *       reads it, and only where it is non-zero.
 *   ba  spare.
 *
 * Half float rather than full: the relative precision is 2^-11, so the error is
 * 0.05% of the distance — five millimetres at ten metres, fifteen centimetres at
 * three hundred. Every consumer works in units of "fraction of the distance to
 * the pixel", so that is far below anything any of them can resolve, and it
 * halves the bandwidth of a target that is written once and read a dozen times.
 *
 * Sampled NEAREST, deliberately: every consumer reconstructs a position from
 * this, and a bilinear tap across a silhouette returns a depth that belongs to
 * neither surface — a halo of wrong occlusion around every edge.
 */

import * as THREE from "three";
import type { Gfx } from "../core/gfx.js";
import { whenReady } from "../core/gpuUtil.js";

/**
 * Cleared depth. Beyond the camera's far plane, so the sky reads as "nothing
 * here" to every consumer without any of them needing a separate mask.
 */
export const DEPTH_FAR = 9000;

/** Clear color of the prepass target. */
const CLEAR = [DEPTH_FAR, 0, 0, 1];

/** Render-scale of the tracked prepass target: full resolution, unitsless. */
const PREPASS_SCALE = 1;

export class DepthPass {
 /** The device layer that owns the prepass target. */
 gfx: Gfx;
 /** Every registered prepass material, compiled in `warmUp`. */
 materials: THREE.Material[];
 /** Meshes to draw into the prepass, each with its own prepass material. */
 casters: { mesh: THREE.Mesh, material: THREE.Material }[];
 /** Render-target size in pixels, republished for the shaders that read it. */
 size: THREE.Vector2;
 /** The prepass target ("scenePrepass"). Bound as `depthTex` by the post passes. */
 rtt: THREE.WebGLRenderTarget;
 /** Cancels the render-size subscription when the pass is disposed. */
 _unsub: () => void;

 constructor(gfx: Gfx) {
  this.gfx = gfx;

  this.materials = [];
  this.casters = [];

  /** Render-target size in pixels, republished for the shaders that read it. */
  this.size = new THREE.Vector2(1, 1);

  const w = gfx.renderWidth;
  const h = gfx.renderHeight;

  /**
   * The prepass target ("scenePrepass"). Bound as `depthTex` by the post
   * passes via `.rtt.texture`.
   * @type {THREE.WebGLRenderTarget}
   */
  this.rtt = gfx.makeRenderTarget("scenePrepass", w, h, {
   type: THREE.HalfFloatType,
   format: THREE.RGBAFormat,
   filter: THREE.NearestFilter,
   depth: true,
  });
  gfx.trackScreenTarget(this.rtt, PREPASS_SCALE);
  this.size.set(this.rtt.width, this.rtt.height);

  this._unsub = gfx.onResize(() => {
   this.size.set(this.rtt.width, this.rtt.height);
  });
 }

 /**
  * Draw `mesh` into the prepass with `material`.
  *
  * The material must declare `viewProjection` bound to the shared — jittered
  * — camera matrix, so the depth and the colour line up to the subpixel, and
  * output via `prepass.fragment.glsl`'s varyings (`vViewZ`, `vMask`).
  *
  * @param {THREE.Mesh} mesh
  * @param {THREE.Material} material
  */
 registerCaster(mesh: THREE.Mesh, material: THREE.Material) {
  if (!mesh || !material) return;
  this.casters.push({ mesh, material });
  this.materials.push(material);
 }

 /**
  * Render the prepass (§4.3 step 3). Cleared to (9000, 0, 0, 1); casters
  * wear their prepass materials for exactly this pass.
  */
 render(gfx: Gfx) {
  gfx.runPass({
   target: this.rtt,
   clearColor: CLEAR,
   clearDepth: true,
   casters: this.casters,
  });
 }

 /**
  * Compile every registered prepass pipeline, behind the loading screen.
  *
  * Stays serial: `whenReady` compiles through `core/gpuUtil.js`'s single
  * shared `_compileScene`, which each call adds a mesh to and removes it
  * from again. Running the calls concurrently interleaves those mutations
  * on one scene, so one compile can strip the mesh another still needs.
  * Serial also gives each material its own full 25 s watchdog rather than
  * sharing one wall-clock budget across all of them.
  */
 async warmUp() {
  for (let i = 0; i < this.materials.length; i++) {
   await whenReady(
    this.gfx, this.materials[i],
    "prepass:" + (this.materials[i].name || i)
   );
  }
 }

 dispose() {
  if (this._unsub) this._unsub();
  this.rtt.dispose();
  for (let i = 0; i < this.materials.length; i++) this.materials[i].dispose();
  this.materials.length = 0;
  this.casters.length = 0;
 }
}
