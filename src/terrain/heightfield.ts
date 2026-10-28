/**
 * The baked macro heightfield.
 *
 * Two textures and one CPU mirror:
 *
 *   heightTex  RG32F, 4096² over a 2048 m field (0.5 m/texel). Sampled bicubically
 *              by the clipmap vertex shader.
 *   auxTex     RGBA16F, 2048². Slope XY, rock mask, exposure. Derived from
 *              heightTex rather than from the analytic function, so the normals
 *              describe exactly the surface the vertices displace to.
 *   heightCPU  Float32Array mirror of heightTex, read back once.
 *
 * The CPU mirror is the point of baking at all. Character grounding, footfall
 * placement and spell impact points all need heights, and re-implementing the
 * noise in JavaScript would mean f32 GPU maths against f64 JS maths — the two
 * would disagree by centimetres and the character would visibly float or sink.
 * Reading back the exact bake makes disagreement structurally impossible.
 *
 * WebGL note: `readRenderTargetPixels` from an RG32F attachment is
 * implementation-restricted, so the readback re-renders the bake into a
 * transient RGBA32F target, reads that, and keeps the source's stride-derivation
 * logic (268 MB, alive for one call, disposed immediately).
 */

import * as THREE from "three";
import type { Gfx } from "../core/gfx.js";
import { S } from "../core/settings.js";
import { FullscreenPass, bakeOnce } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";

const WORLD_SIZE = 2048; // metres across the whole field
export const HEIGHT_RES = 4096; // 0.5 m per texel
const AUX_RES = 2048;

/** Half-extent the player is kept inside, leaving margin for the far rings. */
const PLAY_RADIUS = 1000000; // effectively infinite

/**
 * CPU mirror decimation: the readback keeps every other texel in both axes,
 * so the mirror is HEIGHT_RES/CPU_DECIMATION square. 1 m spacing is ample
 * for grounding and holds 67 MB resident instead of 268 MB.
 */
const CPU_DECIMATION = 2;

/** Sides of the bicubic B-spline footprint, in texels — 4x4 taps. */
const BSPLINE_TAPS = 4;

/** Half a texel, so a texel-centre sample is not read off its edge. */
const HALF_TEXEL = 0.5;

/** Numerator of the 2x2 box average: four taps summed, divided by four. */
const BOX_TAPS = 4;

export class Heightfield {
 /** The device layer that owns the bake targets. */
 gfx: Gfx;
 /** World coordinate of the field's low corner, metres. */
 origin: THREE.Vector2;
 /** World extent of the field's side, metres. */
 size: number;
 /** World metres per height texel. */
 texelWorld: number;
 /** The CPU mirror of the height channel, or null before `bake()`. */
 heightCPU: Float32Array | null;
 /** Resolution of the CPU mirror in texels per side. */
 cpuRes: number;
 /** World metres per CPU-mirror texel. */
 cpuTexel: number;
 /** Measured relief, filled in by `_readback`. */
 minHeight: number;
 maxHeight: number;
 /** Set by `_readback` when the GPU→CPU mirror fails. */
 readbackError: string | null;
 /** RG32F: height in R, the rock mask in G. */
 _heightRT: THREE.WebGLRenderTarget;
 /** The height channel, bound as `heightTex`. */
 heightTex: THREE.Texture;
 /** RGBA16F: the channels the terrain derives its splat from. */
 _auxRT: THREE.WebGLRenderTarget;
 /** The derived channels, bound as `auxTex`. */
 auxTex: THREE.Texture;
 /** The bake that writes the height channel. */
 _heightPass: FullscreenPass;
 /** The bake that derives the aux channels from it. */
 _auxPass: FullscreenPass;

 constructor(gfx: Gfx) {
  this.gfx = gfx;
  this.origin = new THREE.Vector2(-WORLD_SIZE / 2, -WORLD_SIZE / 2);
  this.size = WORLD_SIZE;
  this.texelWorld = WORLD_SIZE / HEIGHT_RES;

  /** @type {Float32Array|null} */
  this.heightCPU = null;
  this.cpuRes = 0;
  this.cpuTexel = 1;
  /** Measured relief, filled in by `_readback`. */
  this.minHeight = 0;
  this.maxHeight = 0;

  /** @type {string|null} Set by `_readback` when the GPU→CPU mirror fails. */
  this.readbackError = null;

  // Two channels, not four: the bake writes height in R and the rock mask
  // in G, and nothing reads B or A. At 4096² the two unused channels would
  // be 134 MB of VRAM holding zeroes. Filtered bilinearly only where the
  // hardware can (`caps.floatLinear`); the fallback steps, as warned at boot.
  const filter = gfx.caps.floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
  this._heightRT = gfx.makeRenderTarget("heightTex", HEIGHT_RES, HEIGHT_RES, {
   type: THREE.FloatType,
   format: THREE.RGFormat,
   internalFormat: "RG32F",
   filter,
   wrap: THREE.RepeatWrapping,
   depth: false,
  });
  this.heightTex = this._heightRT.texture;

  this._auxRT = gfx.makeRenderTarget("auxTex", AUX_RES, AUX_RES, {
   type: THREE.HalfFloatType,
   format: THREE.RGBAFormat,
   filter: THREE.LinearFilter,
   wrap: THREE.RepeatWrapping,
   depth: false,
  });
  this.auxTex = this._auxRT.texture;

  this._heightPass = new FullscreenPass(gfx, {
   name: "heightBake",
   fragment: getShader("heightBakePixelShader"),
   uniforms: {
    worldOrigin: { value: this.origin },
    worldSize: { value: this.size },
    windAngle: { value: 0 },
    heightAmp: { value: 1 },
   },
  });

  this._auxPass = new FullscreenPass(gfx, {
   name: "auxBake",
   fragment: getShader("auxBakePixelShader"),
   uniforms: {
    heightTex: { value: this.heightTex },
    texelWorld: { value: this.texelWorld },
    invHeightRes: { value: 1 / HEIGHT_RES },
   },
  });
 }

 /** Run both bakes and mirror the height to the CPU. */
 async bake() {
  const windAngle = (/** @type {number} */ (S.windDirection) * Math.PI) / 180;

  this._heightPass.material.uniforms.windAngle.value = windAngle;
  this._heightPass.material.uniforms.heightAmp.value = S.macroHeightScale;
  await bakeOnce(this._heightPass, this._heightRT, "heightBake");

  // The aux bake differentiates the height bake, so it has to run after.
  this._auxPass.material.uniforms.heightTex.value = this.heightTex;
  await bakeOnce(this._auxPass, this._auxRT, "auxBake");

  await this._readback();
 }

 async _readback() {
  // WebGL2 readbacks from RG32F attachments are not portable; re-render
  // the same bake (same shader text, same uniforms) into a transient
  // RGBA32F target and read that instead.
  let src = null;
  try {
   const transient = this.gfx.makeRenderTarget(
    "heightReadback", HEIGHT_RES, HEIGHT_RES,
    {
     type: THREE.FloatType,
     format: THREE.RGBAFormat,
     filter: THREE.NearestFilter,
     wrap: THREE.ClampToEdgeWrapping,
     depth: false,
    }
   );
   const buf = new Float32Array(HEIGHT_RES * HEIGHT_RES * 4);
   this._heightPass.render(transient);
   this.gfx.renderer.readRenderTargetPixels(
    transient, 0, 0, HEIGHT_RES, HEIGHT_RES, buf
   );
   this.gfx.renderer.setRenderTarget(null);
   transient.dispose();
   src = buf;
  } catch (err: unknown) {
   // Non-fatal by contract: `heightCPU` stays null and `heightAt` answers 0,
   // so grounding degrades to flat instead of aborting boot. The reason is
   // kept typed rather than left only in the console, so a flat world is
   // diagnosable instead of silently mysterious.
   this.readbackError = err instanceof Error && err.message ? err.message : String(err);
  }
  if (!src) {
   console.warn(`[heightfield] readback failed (${this.readbackError ?? "unknown reason"}); grounding will be flat`);
   return;
  }
  this.readbackError = null;

  // Derived rather than assumed. The read may hand back the texture's
  // own channel count or a widened RGBA copy depending on the backend, and
  // getting this wrong does not throw — it silently shears the grounding
  // field, which then shows up as the character sinking into slopes.
  const stride = Math.max(1, Math.round(src.length / (HEIGHT_RES * HEIGHT_RES)));

  // Keep only R, at reduced resolution: 1 m spacing is ample for grounding
  // and avoids holding 67 MB resident forever.
  //
  // Averaged as a 2x2 box rather than point-sampled. Point-sampling texel
  // 2x puts the sample at world (x + 0.25) while `heightAt` reconstructs
  // as though it sat at (x + 0.5), and a quarter-texel shift on a steep
  // dune face sinks the character into the surface. The box filter lands
  // the sample exactly on the centre `heightAt` assumes.
  const res = HEIGHT_RES / CPU_DECIMATION;
  const dst = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
   const r0 = y * CPU_DECIMATION * HEIGHT_RES;
   const r1 = (y * CPU_DECIMATION + 1) * HEIGHT_RES;
   for (let x = 0; x < res; x++) {
    const c0 = x * CPU_DECIMATION;
    const c1 = c0 + 1;
    dst[y * res + x] =
     (src[(r0 + c0) * stride] + src[(r0 + c1) * stride] +
      src[(r1 + c0) * stride] + src[(r1 + c1) * stride]) / BOX_TAPS;
   }
  }

  this.heightCPU = dst;
  this.cpuRes = res;
  this.cpuTexel = this.size / res;

  // Actual relief, for anything that needs to bound the world vertically —
  // the shadow cascades size their light volume from it. Measured rather
  // than assumed, because the bake's amplitude is a tunable and a bound
  // that is quietly wrong clips geometry out of the depth map.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < dst.length; i++) {
   const v = dst[i];
   if (v < lo) lo = v;
   if (v > hi) hi = v;
  }
  this.minHeight = lo;
  this.maxHeight = hi;
 }

 /**
  * Bicubic B-spline height lookup, matching the vertex shader's
  * reconstruction so the ground the character stands on is the ground that
  * is drawn.
  * @param {number} x @param {number} z
  */
 heightAt(x: number, z: number) {
  const h = this.heightCPU;
  if (!h) return 0;
  const res = this.cpuRes;

  // Shift from texel *corner* to texel *centre*: the bicubic weights are
  // defined around the sample point, and the GPU bake samples texel centres.
  const worldSize = this.size;
  const localX = ((x - this.origin.x) % worldSize + worldSize) % worldSize;
  const localZ = ((z - this.origin.y) % worldSize + worldSize) % worldSize;
  const fx = (localX / worldSize) * res - HALF_TEXEL;
  const fz = (localZ / worldSize) * res - HALF_TEXEL;

  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;

  // Cubic B-spline weights.
  const wx = _w;
  const wz = _w2;
  bsplineWeights(tx, wx);
  bsplineWeights(tz, wz);

  let sum = 0;
  for (let j = 0; j < BSPLINE_TAPS; j++) {
   const zz = ((iz - 1 + j) % res + res) % res;
   const row = zz * res;
   let rowSum = 0;
   for (let i = 0; i < BSPLINE_TAPS; i++) {
    const xx = ((ix - 1 + i) % res + res) % res;
    rowSum += h[row + xx] * wx[i];
   }
   sum += rowSum * wz[j];
  }
  return sum;
 }

 /**
  * Surface normal from the same reconstruction, by central difference.
  * @param {number} x @param {number} z @param {THREE.Vector3} out
  */
 normalAt(x: number, z: number, out: THREE.Vector3) {
  const e = this.cpuTexel || 1;
  const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
  const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
  out.set(-hx / (2 * e), 1, -hz / (2 * e));
  out.normalize();
  return out;
 }

 /** Clamp a world position to the playable area, in place. */
 clampToPlayArea(v: THREE.Vector3) {
  const r = PLAY_RADIUS;
  const d = Math.hypot(v.x, v.z);
  if (d > r) {
   const k = r / d;
   v.x *= k;
   v.z *= k;
  }
 }

}

const _w = new Float32Array(4);
const _w2 = new Float32Array(4);

/** @param {number} t @param {Float32Array} out */
function bsplineWeights(t: number, out: Float32Array) {
 const t2 = t * t;
 const t3 = t2 * t;
 out[0] = (1 - 3 * t + 3 * t2 - t3) / 6;
 out[1] = (4 - 6 * t2 + 3 * t3) / 6;
 out[2] = (1 + 3 * t + 3 * t2 - 3 * t3) / 6;
 out[3] = t3 / 6;
}

/** @param {number} v @param {number} lo @param {number} hi */
function clampi(v: number, lo: number, hi: number) {
 return Math.min(hi, Math.max(lo, v));
}
