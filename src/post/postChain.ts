/**
 * The post-processing chain.
 *
 * ## Order and sizes
 *
 * Nine passes, hand-rolled onto explicit render targets (the Babylon build
 * chained `PostProcess` objects where pass *i* rendered into pass *i+1*'s
 * texture; here every pass owns its declared output — same effect, simpler):
 *
 * ```
 *   pass        renders at   reads                          writes into
 *   ssr          full        sceneColor, depth              dofRT (scratch)
 *   taa          full        ssr result, history[1-k], depth  history[k]
 *   shafts       1/4         depth                          shaftsRT
 *   bloomA       1/4         history[k]  (bright pass)      bloomA
 *   bloomB       1/16        bloomA result                  bloomB
 *   bloomC       1/16        bloomB result (tent blur)      bloomC
 *   dof          full        history[k], depth              dofRT
 *   composite    full        dofRT, bloomA, bloomC, shafts  compositeRT
 *   sharpen      full        compositeRT                    the canvas
 * ```
 *
 * SSR borrows `dofRT` as its output: it is a full-res RGBA16F target that
 * nothing needs until the DoF pass, which runs long after TAA has consumed the
 * SSR result — so the chain gets by on exactly the registry's target list.
 * TAA writes one of two persistent full-res history textures (ping-pong
 * `k = 1-k` per frame, since a pass may not sample the target it is writing
 * to); that is what lets bloomA and dof read the *resolved full-res scene*
 * after the chain has moved on to sixteenth-resolution textures.
 *
 * ## Why every pass stays attached
 *
 * A disabled effect early-outs in its own shader and becomes a full-screen
 * copy — a fraction of a millisecond, for a settings overlay that is hidden by
 * default — so toggling settings never reallocates anything.
 *
 * ## Jitter
 *
 * The temporal resolve needs the projection offset by a subpixel amount each
 * frame, and everything downstream needs to agree about which offset. This
 * class owns that: `update()` records the *unjittered* view-projection for next
 * frame's reprojection, then writes the offset straight into the two matrix
 * elements that shear clip x and y by w — `projection.elements[8]/[9]` — and
 * recomputes the shared `viewProjection`/inverse. Nothing may touch those
 * matrices again until `endFrame()`: the depth prepass and the beauty pass
 * both bind the same jittered matrix and line up to the subpixel — which they
 * have to, or the resolve integrates two different samplings of the same
 * surface.
 */

import * as THREE from "three";
import { S } from "../core/settings.js";
import { getShader } from "../shaders/registry.js";
import { FullscreenPass } from "../core/gpuUtil.js";
import { mulMat4, invertMat4 } from "../core/mat4.js";
import type { Gfx } from "../core/gfx.js";
import type { CameraRig } from "../core/camera.js";
import type { DepthPass } from "../render/depthPass.js";
import type { Sky } from "../render/sky.js";

// Indexed by the `S.tonemap` enum string, so a real (not JSDoc) record type is
// what makes `[S.tonemap]` legal.
const TONEMAP_MODES: Record<string, number> = { agx: 0, aces: 1, none: 2 };

/**
 * Maximum circle of confusion, as a fraction of the frame height.
 *
 * Scaled by the height rather than fixed in pixels so the depth-of-field look
 * does not change with the resolution-scale slider: 0.0024 is 3.5 px at 1440p,
 * and against the pass's own 1.5 px early-out only pixels past roughly three
 * hundred metres run a gather at all.
 */
const MAX_COC_FRACTION = 0.0024;

/** Vignette strength — how far the frame corners are pulled down, 0 none. */
const VIGNETTE_STRENGTH = 0.22;

/**
 * Halton(2,3). Eight subpixel positions, low-discrepancy so the accumulated
 * sample pattern is even at every prefix length rather than only after all
 * eight — which matters because the history is continuously being partially
 * rejected and rarely gets a clean run of eight.
 */
const JITTER = buildHalton(8);

/**
 * Bloom/shaft render-target reduction, expressed as a *mip-level shift* rather
 * than a scale factor. Each pyramid level halves each axis twice — a 4x
 * reduction — so the quarter-res shafts and bloom bright pass sit 2 levels
 * down and the two sixteenth-res tent levels sit 4 levels down. Written as
 * shifts because that is what the allocation does to `w`/`h`.
 */
const MIP_L1 = 2;
const MIP_L2 = 4;

/**
 * Downsample kernel tap spacing, in source texels.
 *
 * One destination pixel of a 4x reduction covers a 4x4 block of the source, so
 * a kernel tapped at one texel reads only a quarter of it and the missed three
 * quarters alias straight into the glow. Doubling the spacing is what makes the
 * downsample cover its own footprint.
 */
const KERNEL_TAP_SPACING = 2;

/**
 * Depth-of-field focal-plane pursuit rate, 1/second.
 *
 * The focal plane tracks the spring arm's subject distance exponentially: 4/s
 * reaches ~90% of a new target in about half a second, which is slow enough
 * that a re-lengthening arm reads as a rack of focus rather than a jump.
 */
const FOCUS_EASE_RATE = 4.0;

/**
 * Field-of-view slack, radians, before the sun counts as off screen.
 *
 * A dot product of 0.05 against the view direction means the sun sits a hair
 * under 87 degrees off the camera axis — far enough outside the frustum that
 * the shafts would be reading an empty region, close enough that a sun
 * skimming the frame edge still lights the air it is about to leave.
 */
const SUN_SCREEN_MARGIN = 0.05;

// ------------------------------------------------------- module-scope scratch
const _sunWorld = new THREE.Vector3();

export class PostChain {
 /** The device layer that owns the chain's targets. */
 gfx: Gfx;
 /** The rig the chain takes its camera matrices from. */
 rig: CameraRig;
 /** The depth prepass this chain reads for every screen-space effect. */
 depth: DepthPass;
 /** The sky, for the sun's screen position and colour. */
 sky: Sky | null;
 /** Seconds since the chain was built. */
 time: number;
 /** 0..1, written each frame by the surf state. */
 speedStreak: number;
 /** Eased focal distance, metres. Tracks the spring arm. */
 focusDist: number;
 /** Frames rendered since boot, driving the jitter sequence. */
 _frame: number;
 /** Frames of settled history the temporal resolve may blend. */
 _historyValid: number;
 /** Which of the two history targets is current; flipped every frame. */
 _k: number;
 /** The unjittered view-projection of the previous frame. */
 _prevViewProj: THREE.Matrix4;
 /** The unjittered view-projection of the current frame. */
 _curViewProj: THREE.Matrix4;
 /** The inverse of the current unjittered view-projection. */
 _invView: THREE.Matrix4;
 /** (near, far, 1/far, 1/near) for reconstructing view depth in the passes. */
 _projInfo: THREE.Vector2;
 /** (1/width, 1/height), the framebuffer size inverted. */
 _invRes: THREE.Vector2;
 /** This frame's subpixel offset in NDC. */
 _jitterNdc: THREE.Vector2;
 /** The sun's position in UV, once projected. */
 _sunUV: THREE.Vector2;
 /** 1 when the sun is inside the frame's field of view, else 0. */
 _sunOnScreen: number;
 /** The sun's radiance, eased from the sky's own value. */
 _sunColor: THREE.Color;
 /** The bloom knee's (threshold, softness, 0, 0) curve. */
 _bloomCurve: THREE.Vector4;
 /** Full-res RGBA16F scene colour the chain reads. */
 sceneColor: THREE.WebGLRenderTarget;
 /** TAA history ping-pong. */
 history: THREE.WebGLRenderTarget[];
 /** 1/4-res target for the light shafts. */
 _shaftsRT: THREE.WebGLRenderTarget;
 /** 1/4-res bright-pass output. */
 _bloomA: THREE.WebGLRenderTarget;
 /** 1/16-res first tent blur. */
 _bloomB: THREE.WebGLRenderTarget;
 /** 1/16-res second tent blur. */
 _bloomC: THREE.WebGLRenderTarget;
 /** Full-res scratch: SSR's output early in the chain, DoF's later. */
 _dofRT: THREE.WebGLRenderTarget;
 /** sRGB 8-bit composite the chain writes back to the canvas. */
 _compositeRT: THREE.WebGLRenderTarget;
 /** The nine passes, in chain order. */
 ssr: FullscreenPass;
 taa: FullscreenPass;
 shafts: FullscreenPass;
 bloomA: FullscreenPass;
 bloomB: FullscreenPass;
 bloomC: FullscreenPass;
 dof: FullscreenPass;
 composite: FullscreenPass;
 sharpen: FullscreenPass;
 /** For warm-up iteration; each has a `.name`. */
 passes: FullscreenPass[];
 /** Cancels the render-size subscription when the chain is disposed. */
 _unsub: () => void;

 /**
  * @param {Gfx} gfx
  * @param {CameraRig} rig
  * @param {DepthPass} depthPass
  * @param {Sky|null} sky
  */
 constructor(gfx: Gfx, rig: CameraRig, depthPass: DepthPass, sky: Sky | null) {
  this.gfx = gfx;
  this.rig = rig;
  this.depth = depthPass;
  this.sky = sky;
  this.time = 0;

  /**
   * 0..1, written each frame by the surf state. Drives the radial smear
   * and the spindrift strands in the display transform.
   */
  this.speedStreak = 0;

  /** Eased focal distance, metres. Tracks the spring arm. */
  this.focusDist = 6.2;

  this._frame = 0;
  this._historyValid = 0;
  this._k = 0;

  this._prevViewProj = new THREE.Matrix4();
  this._curViewProj = new THREE.Matrix4();
  this._invView = new THREE.Matrix4();
  this._projInfo = new THREE.Vector2(1, 1);
  this._invRes = new THREE.Vector2(1, 1);
  this._jitterNdc = new THREE.Vector2(0, 0);
  this._sunUV = new THREE.Vector2(0.5, 0.5);
  this._sunOnScreen = 0;
  this._sunColor = new THREE.Color(1, 1, 1);
  this._bloomCurve = new THREE.Vector4(1, 1, 1, 1);

  const w = gfx.renderWidth;
  const h = gfx.renderHeight;

  // ----------------------------------------------------------- targets
  /**
   * The beauty target — main renders sky/opaque/blend into it, SSR reads
   * it back.
   * @type {THREE.WebGLRenderTarget}
   */
  this.sceneColor = gfx.makeRenderTarget("sceneColor", w, h, {
   type: THREE.HalfFloatType,
   filter: THREE.LinearFilter,
   depth: true,
  });
  gfx.trackScreenTarget(this.sceneColor, 1);

  /** @type {THREE.WebGLRenderTarget[]} TAA history ping-pong. */
  this.history = [
   gfx.makeRenderTarget("taaHistory0", w, h, {
    type: THREE.HalfFloatType, filter: THREE.LinearFilter,
   }),
   gfx.makeRenderTarget("taaHistory1", w, h, {
    type: THREE.HalfFloatType, filter: THREE.LinearFilter,
   }),
  ];
  gfx.trackScreenTarget(this.history[0], 1);
  gfx.trackScreenTarget(this.history[1], 1);

  // Quarter-res: the light shafts and the bloom bright pass. Each level of
  // the pyramid is a 4x reduction in each axis, so level 1 is a shift of 2
  // mip levels (1/4 resolution) and level 2 a shift of 4 (1/16) — the shifts
  // are mip levels, not scale factors.
  this._shaftsRT = gfx.makeRenderTarget(
   "shaftsRT", Math.max(1, w >> MIP_L1), Math.max(1, h >> MIP_L1), {
   type: THREE.HalfFloatType, filter: THREE.LinearFilter,
  });
  gfx.trackScreenTarget(this._shaftsRT, 0.25);

  this._bloomA = gfx.makeRenderTarget(
   "bloomA", Math.max(1, w >> MIP_L1), Math.max(1, h >> MIP_L1), {
   type: THREE.HalfFloatType, filter: THREE.LinearFilter,
  });
  gfx.trackScreenTarget(this._bloomA, 0.25);

  this._bloomB = gfx.makeRenderTarget(
   "bloomB", Math.max(1, w >> MIP_L2), Math.max(1, h >> MIP_L2), {
   type: THREE.HalfFloatType, filter: THREE.LinearFilter,
  });
  gfx.trackScreenTarget(this._bloomB, 0.0625);

  this._bloomC = gfx.makeRenderTarget(
   "bloomC", Math.max(1, w >> MIP_L2), Math.max(1, h >> MIP_L2), {
   type: THREE.HalfFloatType, filter: THREE.LinearFilter,
  });
  gfx.trackScreenTarget(this._bloomC, 0.0625);

  /** Full-res scratch for SSR early in the frame, DoF output later. */
  this._dofRT = gfx.makeRenderTarget("dofRT", w, h, {
   type: THREE.HalfFloatType, filter: THREE.LinearFilter,
  });
  gfx.trackScreenTarget(this._dofRT, 1);

  /** sRGB-encoded 8-bit; sharpen reads it and writes the canvas. */
  this._compositeRT = gfx.makeRenderTarget("compositeRT", w, h, {
   type: THREE.UnsignedByteType, filter: THREE.LinearFilter,
  });
  gfx.trackScreenTarget(this._compositeRT, 1);

  const depthTex = (depthPass && depthPass.rtt)
   ? depthPass.rtt.texture
   : gfx.blackTex;

  // ------------------------------------------------------------ passes
  this.ssr = new FullscreenPass(gfx, {
   name: "ssr",
   fragment: getShader("ssrPixelShader"),
   uniforms: {
    textureSampler: { value: this.sceneColor.texture },
    depthTex: { value: depthTex },
    projInfo: { value: this._projInfo },
    invRes: { value: this._invRes },
    enabled: { value: 0 },
    strength: { value: 1.0 },
   },
  });

  this.taa = new FullscreenPass(gfx, {
   name: "taa",
   fragment: getShader("taaPixelShader"),
   uniforms: {
    textureSampler: { value: this._dofRT.texture }, // the SSR result
    historyTex: { value: this.history[1].texture },
    depthTex: { value: depthTex },
    prevViewProj: { value: this._prevViewProj },
    invView: { value: this._invView },
    projInfo: { value: this._projInfo },
    invRes: { value: this._invRes },
    jitterNdc: { value: this._jitterNdc },
    historyValid: { value: 0 },
    enabled: { value: 0 },
    feedback: { value: 0.90 },
   },
  });

  this.shafts = new FullscreenPass(gfx, {
   name: "shafts",
   fragment: getShader("shaftsPixelShader"),
   uniforms: {
    textureSampler: { value: gfx.blackTex },
    depthTex: { value: depthTex },
    sunUV: { value: this._sunUV },
    sunOnScreen: { value: 0 },
    sunColor: { value: this._sunColor },
    enabled: { value: 0 },
    strength: { value: 0 },
    aspect: { value: 1 },
   },
  });

  this.bloomA = new FullscreenPass(gfx, {
   name: "bloomA",
   fragment: getShader("bloomDownPixelShader"),
   uniforms: {
    sourceTex: { value: this.history[0].texture },
    srcTexel: { value: new THREE.Vector2(0, 0) },
    prefilter: { value: 1 },
    curve: { value: this._bloomCurve },
   },
  });

  this.bloomB = new FullscreenPass(gfx, {
   name: "bloomB",
   fragment: getShader("bloomDownPixelShader"),
   uniforms: {
    sourceTex: { value: this._bloomA.texture },
    srcTexel: { value: new THREE.Vector2(0, 0) },
    prefilter: { value: 0 },
    curve: { value: new THREE.Vector4(0, 0, 0, 0) },
   },
  });

  this.bloomC = new FullscreenPass(gfx, {
   name: "bloomC",
   fragment: getShader("bloomBlurPixelShader"),
   uniforms: {
    textureSampler: { value: this._bloomB.texture },
    srcTexel: { value: new THREE.Vector2(0, 0) },
   },
  });

  this.dof = new FullscreenPass(gfx, {
   name: "dof",
   fragment: getShader("dofPixelShader"),
   uniforms: {
    sceneTex: { value: this.history[0].texture },
    depthTex: { value: depthTex },
    invRes: { value: this._invRes },
    enabled: { value: 0 },
    focusDist: { value: this.focusDist },
    maxCoc: { value: 3.5 },
   },
  });

  this.composite = new FullscreenPass(gfx, {
   name: "composite",
   fragment: getShader("tonemapPixelShader"),
   uniforms: {
    textureSampler: { value: this._dofRT.texture },
    bloomNear: { value: this._bloomA.texture },
    bloomFar: { value: this._bloomC.texture },
    shaftsTex: { value: this._shaftsRT.texture },
    exposure: { value: S.exposure },
    contrast: { value: S.contrast },
    mode: { value: 0 },
    grainAmount: { value: 0 },
    time: { value: 0 },
    vignette: { value: VIGNETTE_STRENGTH },
    speedStreak: { value: 0 },
    bloomAmount: { value: 0 },
    shaftAmount: { value: 0 },
   },
  });

  this.sharpen = new FullscreenPass(gfx, {
   name: "sharpen",
   fragment: getShader("sharpenPixelShader"),
   uniforms: {
    textureSampler: { value: this._compositeRT.texture },
    invRes: { value: this._invRes },
    amount: { value: 0 },
   },
  });

  /** For warm-up iteration; each has a `.name`. */
  this.passes = [
   this.ssr, this.taa, this.shafts, this.bloomA, this.bloomB,
   this.bloomC, this.dof, this.composite, this.sharpen,
  ];

  // A resize reallocates the tracked targets underneath us; the
  // reprojection would be against a differently-shaped frustum and the
  // history against a differently-sized buffer.
  this._unsub = gfx.onResize(() => {
   this._historyValid = 0;
   this._clearHistory();
  });
  this._clearHistory();
 }

 /** Zero both history buffers — uninitialised VRAM must never enter TAA. */
 _clearHistory() {
  const r = this.gfx.renderer;
  for (let i = 0; i < 2; i++) {
   r.setRenderTarget(this.history[i]);
   r.setClearColor(0x000000, 1);
   r.clear(true, false, false);
  }
  r.setRenderTarget(null);
 }

 /**
  * Recompute the projection with this frame's subpixel offset, and publish
  * everything the screen-space passes derive from the camera.
  *
  * Must run after the rig has moved the camera and set its field of view,
  * and before anything reads the view-projection — the depth prepass and the
  * beauty pass both do.
  *
  * @param {number} dt
  * @param {number} [streak] 0..1 speed-streak amount for this frame
  * @param {number} [focus] metres to the subject, for depth of field
  */
 update(dt: number, streak?: number, focus?: number) {
  this.time += dt;
  if (streak !== undefined) this.speedStreak = streak;
  if (focus !== undefined) {
   // Eased: a focal plane that snaps when the spring arm re-lengthens is
   // the one thing a restrained depth of field can still make obvious.
   // Rate, 1/s: the focal plane reaches ~90% of a new target in about
   // half a second, which is slow enough that a re-lengthening spring arm
   // reads as a rack of focus rather than a jump.
   this.focusDist += (focus - this.focusDist) * Math.min(1, dt * FOCUS_EASE_RATE);
  }

  const gfx = this.gfx;
  const cam = this.rig.camera;
  const w = gfx.renderWidth;
  const h = gfx.renderHeight;
  this._invRes.set(1 / w, 1 / h);

  // ---- unjittered matrices, for reprojection and for the sun ---------
  // The rig just rebuilt `view` and an unjittered `projection`; latch the
  // clean products before the jitter goes in.
  this._curViewProj.copy(cam.viewProjection);
  this._invView.copy(cam.invView);

  const tanHalf = Math.tan(cam.fov * 0.5);
  this._projInfo.set(tanHalf * (w / h), tanHalf);

  // ---- the sun on screen, for the shafts -----------------------------
  if (this.sky) {
   _sunWorld.copy(this.sky.sunDir).multiplyScalar(2000).add(cam.position);
   const m = this._curViewProj.elements;
   const cw = m[3] * _sunWorld.x + m[7] * _sunWorld.y + m[11] * _sunWorld.z + m[15];
   const iw = 1 / (cw || 1);
   const cx = (m[0] * _sunWorld.x + m[4] * _sunWorld.y + m[8] * _sunWorld.z + m[12]) * iw;
   const cy = (m[1] * _sunWorld.x + m[5] * _sunWorld.y + m[9] * _sunWorld.z + m[13]) * iw;
   // The divide mirrors a point behind the camera rather than flagging
   // it. The dot product against the view direction is the only honest
   // test — the world-space forward is the third row of the LH view.
   const v = cam.view.elements;
   const fwdDot =
    this.sky.sunDir.x * v[2] +
    this.sky.sunDir.y * v[6] +
    this.sky.sunDir.z * v[10];
   this._sunUV.set(cx * 0.5 + 0.5, cy * 0.5 + 0.5); // NDC → UV
   this._sunOnScreen = fwdDot > SUN_SCREEN_MARGIN ? 1 : 0;
   this._sunColor.copy(this.sky.sunRadiance);
  } else {
   this._sunOnScreen = 0;
  }

  // ---- bloom knee ----------------------------------------------------
  // Threshold in exposed units, so it does not move when the exposure
  // slider does. Sunlit snow here exposes to ~1.26, so anything near 1.0
  // puts the entire lit half of the frame above the knee and the bloom
  // becomes a uniform milky veil. At 3.0 the field sits a stop and a half
  // below it and only the sun disc, the glints and lit spray reach it.
  const th = 3.0;
  const knee = 1.4;
  this._bloomCurve.set(th, th - knee, knee * 2, 0.25 / Math.max(knee, 1e-4));

  // ---- jitter ---------------------------------------------------------
  let jx = 0;
  let jy = 0;
  if (S.taa) {
   const idx = (this._frame % (JITTER.length >> 1)) * 2;
   jx = JITTER[idx];
   jy = JITTER[idx + 1];
  }
  this._jitterNdc.set((2 * jx) / w, (2 * jy) / h);

  const pm = cam.projection.elements;
  pm[8] += this._jitterNdc.x;
  pm[9] += this._jitterNdc.y;
  // Republish the shared products with the jitter in. Nothing may
  // recompute these between here and the end of the frame, or the depth
  // prepass and the beauty pass would be jittered differently.
  // `Mat4` accepts a `Float32Array` or a plain `number[]`, and each
  // `Matrix4.elements` is a 16-number tuple, so no cast is needed.
  mulMat4(cam.viewProjection.elements, cam.projection.elements, cam.view.elements);
  invertMat4(cam.invViewProjection.elements, cam.viewProjection.elements);

  // ---- history ping-pong ---------------------------------------------
  this._k = 1 - this._k;

  this._frame++;
 }

 /**
  * Run the chain (§4.3 step 5): ssr → taa (→ history[k]) → shafts(¼) →
  * bloomA(¼) → bloomB(1/16) → bloomC(1/16) → dof → composite → sharpen →
  * canvas.
   * @param {Gfx} gfx
   */
 render(gfx: Gfx) {
  const k = this._k;
  const hist = this.history;
  const w = gfx.renderWidth;
  const h = gfx.renderHeight;

  // ---- ssr → dofRT (scratch) -----------------------------------------
  {
   const u = this.ssr.material.uniforms;
   u.textureSampler.value = this.sceneColor.texture;
   u.enabled.value = S.ssr ? 1 : 0;
   u.strength.value = 1.0;
   this.ssr.render(this._dofRT);
  }

  // ---- taa → history[k] ----------------------------------------------
  {
   const u = this.taa.material.uniforms;
   u.textureSampler.value = this._dofRT.texture;
   u.historyTex.value = hist[1 - k].texture;
   u.historyValid.value = this._historyValid;
   u.enabled.value = S.taa ? 1 : 0;
   u.feedback.value = 0.90;
   this.taa.render(hist[k]);
  }

  // ---- shafts (¼) -----------------------------------------------------
  {
   const u = this.shafts.material.uniforms;
   u.enabled.value = S.showLightShafts ? 1 : 0;
   u.strength.value = S.shaftStrength;
   u.aspect.value = w / h;
   u.sunOnScreen.value = this._sunOnScreen;
   this.shafts.render(this._shaftsRT);
  }

  // ---- bloom pyramid --------------------------------------------------
  // Level 0: the bright pass, reading the resolved frame at full
  // resolution. The tap spacing is *twice* a source texel, not one: each
  // level is a 4x reduction, so one destination pixel covers a 4x4 block
  // of the source, and a thirteen-tap kernel spaced at one texel only
  // reaches half of it — the missed half aliases straight into the glow.
  {
   const u = this.bloomA.material.uniforms;
   u.sourceTex.value = hist[k].texture;
   u.srcTexel.value.set(this._invRes.x * KERNEL_TAP_SPACING, this._invRes.y * KERNEL_TAP_SPACING);
   u.prefilter.value = 1;
   this.bloomA.render(this._bloomA);
  }
  // Level 1: a straight 4x reduction of level 0.
  {
   const u = this.bloomB.material.uniforms;
   u.sourceTex.value = this._bloomA.texture;
   u.srcTexel.value.set(
    (1 / Math.max(1, this._bloomA.width)) * KERNEL_TAP_SPACING,
    (1 / Math.max(1, this._bloomA.height)) * KERNEL_TAP_SPACING
   );
   u.prefilter.value = 0;
   this.bloomB.render(this._bloomB);
  }
  // The tent, spread wider than one texel: this is the level that has to
  // read as haze in the air rather than as a ring around the sun.
  {
   const u = this.bloomC.material.uniforms;
   u.textureSampler.value = this._bloomB.texture;
   u.srcTexel.value.set(
    (1 / Math.max(1, this._bloomB.width)) * KERNEL_TAP_SPACING,
    (1 / Math.max(1, this._bloomB.height)) * KERNEL_TAP_SPACING
   );
   this.bloomC.render(this._bloomC);
  }

  // ---- dof → dofRT ----------------------------------------------------
  {
   const u = this.dof.material.uniforms;
   u.sceneTex.value = hist[k].texture;
   u.enabled.value = S.dof ? 1 : 0;
   u.focusDist.value = this.focusDist;
   // Scaled to the frame height — see MAX_COC_FRACTION.
   u.maxCoc.value = h * MAX_COC_FRACTION;
   this.dof.render(this._dofRT);
  }

  // ---- composite → compositeRT (the one sRGB encode) ------------------
  {
   const u = this.composite.material.uniforms;
   u.textureSampler.value = this._dofRT.texture;
   u.exposure.value = S.exposure;
   u.contrast.value = S.contrast;
   u.mode.value = TONEMAP_MODES[S.tonemap] ?? 0;
   u.grainAmount.value = S.grain ? S.grainStrength : 0;
   u.time.value = this.time;
   u.vignette.value = VIGNETTE_STRENGTH;
   u.speedStreak.value = S.windStreaks ? this.speedStreak * /** @type {number} */(S.streakStrength) : 0;
   u.bloomAmount.value = S.bloom ? S.bloomStrength : 0;
   u.shaftAmount.value = S.showLightShafts ? 1 : 0;
   this.composite.render(this._compositeRT);
  }

  // ---- sharpen → canvas ----------------------------------------------
  {
   const u = this.sharpen.material.uniforms;
   u.amount.value = S.sharpen ? S.sharpenStrength : 0;
   this.sharpen.render(null);
  }
 }

 /**
  * Latch this frame's camera for next frame's reprojection. Called after
  * the render.
  */
 endFrame() {
  this._prevViewProj.copy(this._curViewProj);
  // Two frames of grace: the first fills history[0], the second history[1],
  // and only then is there something at `1 - k` worth reading.
  if (this._historyValid < 1) this._historyValid += 0.5;
 }

 /** Discard the temporal history — after a teleport, or a resolution change. */
 resetHistory() {
  this._historyValid = 0;
 }

 dispose() {
  if (this._unsub) this._unsub();
  for (let i = 0; i < this.passes.length; i++) {
   this.passes[i].material.dispose();
  }
  this.sceneColor.dispose();
  this.history[0].dispose();
  this.history[1].dispose();
  this._shaftsRT.dispose();
  this._bloomA.dispose();
  this._bloomB.dispose();
  this._bloomC.dispose();
  this._dofRT.dispose();
  this._compositeRT.dispose();
 }
}

// --------------------------------------------------------------------- helpers

/**
 * Halton(2,3) on [-0.5, 0.5], flattened to (x, y) pairs.
 * @param {number} n
 */
function buildHalton(n: number) {
 const out = new Float32Array(n * 2);
 for (let i = 0; i < n; i++) {
  out[i * 2] = radical(i + 1, 2) - 0.5;
  out[i * 2 + 1] = radical(i + 1, 3) - 0.5;
 }
 return out;
}

function radical(i = 0, base = 2) {
 let f = 1;
 let r = 0;
 let k = i;
 while (k > 0) {
  f /= base;
  r += f * (k % base);
  k = Math.floor(k / base);
 }
 return r;
}
