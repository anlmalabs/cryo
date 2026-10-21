/**
 * Frame-time statistics and the graph renderer behind the overlay.
 *
 * Averages hide hitches, so everything here is percentile-based: the headline
 * numbers are the median and the 1% low (the 99th-percentile frame time), which
 * is what actually tells you whether a GC pause or a pipeline compile snuck in.
 *
 * Allocation policy: every buffer is created once at module load. `sample()`
 * runs per frame and allocates nothing; `recompute()` sorts an in-place typed
 * array copy and is throttled to 4 Hz.
 */

import type { WebGLRenderer } from "three";
import type { Gfx } from "./gfx.js";

const CAP = 512; // ~5.7 s of history at 90 fps

/** Percentile positions, as fractions of the sample count. */
const P50 = 0.5; // median
const P95 = 0.95;
const P99 = 0.99; // the 1% low
/** Recompute throttle: 4 Hz, in ms of accumulated frame time. */
const RECOMPUTE_MS = 250;
/** A spike is a frame more than this many ms over the median. */
const SPIKE_MARGIN_MS = 4;

// --------------------------------------------------------- budget thresholds
// Two ladders, deliberately different, because they answer different questions.
//
// `BUDGET_*_MS` — what a FRAME TIME must stay under. The graph draws its guides
//   at the 90 fps and 60 fps budgets, so the values are the rounded
//   1000/fps reciprocals (11.1 / 16.7 ms), not 1000/88.
//
// `FPS_*` — where a READOUT turns amber. All three tiers use 60 as the "bad"
//   floor; they differ only in the warn bar, because the headline median, the
//   1% low and the standalone meter are each graded on their own bar.
//
// The two sets are NOT interchangeable: 11.1 ms is 90 fps, but the headline
// readout does not go amber at 90 fps — it goes amber below 88. Never convert
// between them to "unify"; read the one the site is actually using.

/** 90 fps budget in ms — the graph's "comfortable" guide. */
export const BUDGET_90FPS_MS = 11.1;
/** 60 fps budget in ms — the graph's "playable floor" guide. */
export const BUDGET_60FPS_MS = 16.7;

/** fps at or above which the frame is considered good. */
export const FPS_GOOD = 88;
/** fps at or above which the frame is merely acceptable. */
export const FPS_WARN = 60;
/**
 * The overlay's `fpsLow` (1% low) row warns below this — a DIFFERENT band from
 * `FPS_GOOD`, deliberately: the low-fps figure is the worst 1% of frames, so it
 * is graded on a lower bar than the headline median. Do not unify the two.
 */
export const FPS_LOW_WARN = 75;

/** One of the three quality bands a frame time can land in. */
export type PerfTier = "good" | "warn" | "bad";

/**
 * Which budget band a frame *rate* falls in — the fps readouts' shared ladder
 * (the overlay's fps rows and the standalone fps meter).
 *
 * The frame-time graph does not use this one: it works in milliseconds against
 * the budget constants directly, see `barColour`.
 *
 *   fps >= FPS_GOOD  → "good"
 *   fps >= FPS_WARN  → "warn"    (the 60 fps floor)
 *   otherwise        → "bad"
 */
export function perfTier(fps: number): PerfTier {
 if (fps >= FPS_GOOD) return "good";
 if (fps >= FPS_WARN) return "warn";
 return "bad";
}

/**
 * The same ladder, instantiated for ONE site's own thresholds — the "bad"
 * floor is always `FPS_WARN`, and the caller names the warn bar.
 *
 * Use this where a readout is graded differently from the headline median:
 * the overlay's 1%-low row warns at `FPS_LOW_WARN`, not `FPS_GOOD`. Keeping the
 * bar a parameter (rather than a second hardcoded ladder) is what lets each
 * site say *why* its bar is what it is, without duplicating the branch order.
 *
 *   fps >= warn  → "good"   (no separate top bar: it is the same thing)
 *   fps >= FPS_WARN → "warn"
 *   otherwise    → "bad"
 */
export function perfTierWithWarn(fps: number, warn: number): PerfTier {
 if (fps >= warn) return "good";
 if (fps >= FPS_WARN) return "warn";
 return "bad";
}

/**
 * Bar colour for a frame time in ms: red past the 60 fps budget, amber past
 * the 90 fps one, blue otherwise.
 *
 * Read straight off the ms budgets rather than converted from the fps
 * thresholds — `perfTier`'s 88 fps boundary is not exactly 11.1 ms, so going
 * through it would recolour frames in between.
 */
function barColour(ms: number): string {
 if (ms > BUDGET_60FPS_MS) return "#e8734f";
 if (ms > BUDGET_90FPS_MS) return "#e8b04f";
 return "#6fb2e0";
}

const times = new Float32Array(CAP); // ring buffer of frame times, ms
const sorted = new Float32Array(CAP); // scratch for percentiles
let head = 0;
let count = 0;

/** Per-system timings, in ms, written by systems each frame via `mark()`. */
export const systemMs: Record<string, number> = Object.create(null);

/** Rolling stats, mutated in place — never reassigned, so consumers can hold a ref. */
export const stats = {
 last: 0,
 median: 0,
 mean: 0,
 p99: 0, // 1% low frame time
 p95: 0,
 max: 0,
 fps: 0,
 fpsLow: 0, // 1% low fps
 drawCalls: 0,
 triangles: 0,
 // WebGL2 has no dependable GPU timer (`EXT_disjoint_timer_query_webgl2` is
 // widely disabled), so this stays 0 and the overlay shows its dash.
 gpuMs: 0,
};

let sinceRecompute = 0;

/**
 * Push one frame time.
 * @param {number} ms
 */
export function sample(ms: number) {
 times[head] = ms;
 head = (head + 1) % CAP;
 if (count < CAP) count++;
 stats.last = ms;

 sinceRecompute += ms;
 if (sinceRecompute >= RECOMPUTE_MS) {
  sinceRecompute = 0;
  recompute();
 }
}

function recompute() {
 const n = count;
 if (n === 0) return;

 let sum = 0;
 let max = 0;
 for (let i = 0; i < n; i++) {
  const v = times[i];
  sorted[i] = v;
  sum += v;
  if (v > max) max = v;
 }

 // TypedArray sort is in-place and allocation-free.
 const view = n === CAP ? sorted : sorted.subarray(0, n);
 view.sort();

 stats.mean = sum / n;
 stats.max = max;
 stats.median = view[(n * P50) | 0];
 stats.p95 = view[Math.min(n - 1, (n * P95) | 0)];
 stats.p99 = view[Math.min(n - 1, (n * P99) | 0)];
 stats.fps = stats.median > 0 ? 1000 / stats.median : 0;
 stats.fpsLow = stats.p99 > 0 ? 1000 / stats.p99 : 0;
}

// --------------------------------------------------------------- draw counter

/**
 * Three keeps an accurate per-frame draw count in `renderer.info`, so unlike
 * the Babylon build there is nothing to wrap — only a reset to take over.
 * `autoReset` is turned off so the count survives until `endFrameDraws()`
 * latches it, whole-frame, for the overlay.
 */
let _renderer: WebGLRenderer | null = null;

export function installDrawCounter(gfx: Gfx) {
 _renderer = gfx.renderer;
 if (_renderer) _renderer.info.autoReset = false;
}

/** Latch the frame's draw count. Call once, after the frame's last render. */
export function endFrameDraws() {
 if (!_renderer) return;
 stats.drawCalls = _renderer.info.render.calls;
 _renderer.info.reset();
}

/** Record a per-system cost in ms (overwrites; call once per frame per system). */
export function mark(name: string, ms: number) {
 systemMs[name] = ms;
}

/** Number of frames exceeding `median + SPIKE_MARGIN_MS` since the last reset. */
export const spikes = { count: 0, sinceReset: 0 };

export function checkSpike(ms: number) {
 spikes.sinceReset++;
 if (stats.median > 0 && ms > stats.median + SPIKE_MARGIN_MS) spikes.count++;
}

export function resetSpikes() {
 spikes.count = 0;
 spikes.sinceReset = 0;
}

// --------------------------------------------------------------------- graph

/** y-axis floor/ceiling of the eased frame-time graph, in ms. */
const GRAPH_AXIS_FLOOR_MS = 22;
const GRAPH_AXIS_CEILING_MS = 60;
/** How far above the observed max the axis is allowed to stretch. */
const GRAPH_AXIS_HEADROOM = 1.25;
/** Fraction of the remaining distance the eased axis closes per frame. */
const GRAPH_AXIS_EASE = 0.08;

/**
 * Draws the frame-time history into a 2D canvas. Bars are coloured by which
 * budget band they land in, so a red column is instantly readable as a hitch.
 */
export class FrameGraph {
 canvas: HTMLCanvasElement;
 ctx: CanvasRenderingContext2D | null;
 /** Render size in CSS pixels. */
 w: number;
 h: number;
 /** y-axis top of the eased range, ms. */
 maxMs: number;
 /** @param {HTMLCanvasElement} canvas */
 constructor(canvas: HTMLCanvasElement) {
  this.canvas = canvas;
  this.ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  this.w = canvas.width;
  this.h = canvas.height;
  this.maxMs = GRAPH_AXIS_FLOOR_MS; // y-axis top, eased toward the observed max
 }

 draw() {
  const ctx = this.ctx;
  const w = this.w;
  const h = this.h;
  if (!ctx) return;

  // Ease the axis so it doesn't jump around while you read it.
  const want = Math.max(
   GRAPH_AXIS_FLOOR_MS,
   Math.min(GRAPH_AXIS_CEILING_MS, stats.max * GRAPH_AXIS_HEADROOM)
  );
  this.maxMs += (want - this.maxMs) * GRAPH_AXIS_EASE;
  const inv = h / this.maxMs;

  ctx.clearRect(0, 0, w, h);

  // Budget guides: 11.1 ms (90 fps) and 16.7 ms (60 fps).
  ctx.fillStyle = "rgba(143,196,232,0.10)";
  ctx.fillRect(0, h - BUDGET_90FPS_MS * inv, w, 1);
  ctx.fillStyle = "rgba(232,160,120,0.12)";
  ctx.fillRect(0, h - BUDGET_60FPS_MS * inv, w, 1);

  const n = count;
  if (n === 0) return;

  const step = w / CAP;
  for (let i = 0; i < n; i++) {
   // Walk oldest→newest so the graph scrolls left.
   const idx = (head - n + i + CAP * 2) % CAP;
   const v = times[idx];
   const bh = Math.min(h, v * inv);

   ctx.fillStyle = barColour(v);
   ctx.fillRect(i * step, h - bh, Math.max(1, step), bh);
  }

  // Median line on top of the bars.
  ctx.fillStyle = "rgba(219,230,242,0.55)";
  ctx.fillRect(0, h - stats.median * inv, w, 1);
 }
}
