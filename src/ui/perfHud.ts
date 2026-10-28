/**
 * MangoHud-style performance HUD.
 *
 * A compact, dark, translucent corner panel that is on by default. It borrows
 * its numbers from `stats` (perf.js already samples every frame) and keeps its
 * own fixed-size ring buffer of frame times for the scrolling graph, so
 * perf.js's collection contract is untouched.
 *
 * Refreshes text readouts at ~4 Hz (formatting every frame is garbage) but
 * redraws the frame-time graph every frame so hitches are visible as they land.
 */
import { stats, BUDGET_60FPS_MS, BUDGET_90FPS_MS } from "../core/perf.js";

const CSS = `
#perfHud {
  position: fixed; top: 10px; left: 10px; z-index: 85;
  display: none;
  font: 400 10px/1.2 ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
  color: #dbe6f2;
  background: rgba(8, 11, 18, 0.74);
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  padding: 4px 6px 5px;
  min-width: 140px;
  pointer-events: none; user-select: none;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255,255,255,0.05);
}
#perfHud.show { display: block; }
#perfHud .ph-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 3px; }
#perfHud .ph-fps { font-size: 15px; font-weight: 700; color: #eaf4ff; letter-spacing: -0.02em; }
#perfHud .ph-fps-l { font-size: 8px; color: #7f93a8; letter-spacing: 0.12em; text-transform: uppercase; }
#perfHud .ph-ft { margin-left: auto; font-size: 10px; color: #9fb4c8; }
#perfHud canvas { display: block; width: 100%; height: 32px; border-radius: 3px;
  background: rgba(0, 0, 0, 0.34); border: 1px solid rgba(255,255,255,0.08); }
#perfHud .ph-rows { margin-top: 3px; }
#perfHud .ph-row { display: flex; justify-content: space-between; font-size: 9px; }
#perfHud .ph-row .k { color: #7f93a8; }
#perfHud .ph-row .v { color: #dbe6f2; }
`;

const CAP = 180; // ~2 s of history at 90 fps
const PERIOD = 250; // text refresh, ms
const GRAPH_H = 32;

/** y-axis top of the eased graph, ms — floor and ceiling of its range. */
const AXIS_FLOOR_MS = 33.3; // 30 fps: the resting ceiling
const AXIS_CEILING_MS = 80;
/** How far above the observed max the axis may stretch, ratio. */
const AXIS_HEADROOM = 1.25;
/** Fraction of the remaining distance the eased axis closes per frame. */
const AXIS_EASE = 0.08;
/** fps below which this HUD's headline figure is coloured red. */
const FPS_BAD = 30;
/** …and the top of its amber band, fps. A lower, coarser ladder than the
 *  overlay's: this HUD has room for one number and reads over the shoulder. */
const FPS_WARN_HUD = 55;
/** Half-pixel inset keeps the 1 px guide lines off the pixel grid's edge, px. */
const BAR_INSET = 0.5;

/**
 * Bar colour for a frame time in ms.
 *
 * Thresholds frame TIME, not fps: this HUD's graph is drawn from `stats.last`
 * samples in milliseconds, the same domain `FrameGraph` and `barColour` in
 * core/perf.ts work in. The bands are the imported 90 fps / 60 fps budgets —
 * they are NOT derived from `perfTier`'s 88 fps boundary, which is deliberately
 * not the same number as 11.1 ms.
 */
function graphBarColour(ms: number): string {
 if (ms > BUDGET_60FPS_MS) return "#e8734f";
 if (ms > BUDGET_90FPS_MS) return "#e8b04f";
 return "#6fb2e0";
}

/** The performance HUD's public surface. */
export type PerfHud = {
 readonly visible: boolean;
 toggle(): void;
 /** `gfx` is accepted for signature parity with `fpsMeter.update` and the
  *  overlay's own row pump; the HUD reads nothing off the device. */
 update(dtMs: number, gfx: unknown): void;
 dispose(): void;
};

export function createPerfHud(): PerfHud {
 const style = document.createElement("style");
 style.textContent = CSS;
 document.head.appendChild(style);

 const el = document.createElement("div");
 el.id = "perfHud";
 document.body.appendChild(el);

 const head = document.createElement("div");
 head.className = "ph-head";
 const fpsB = document.createElement("span");
 fpsB.className = "ph-fps";
 fpsB.textContent = "--";
 const fpsL = document.createElement("span");
 fpsL.className = "ph-fps-l";
 fpsL.textContent = "FPS";
 const ft = document.createElement("span");
 ft.className = "ph-ft";
 ft.textContent = "-- ms";
 head.appendChild(fpsB);
 head.appendChild(fpsL);
 head.appendChild(ft);
 el.appendChild(head);

 const cv = document.createElement("canvas");
 cv.width = 320;
 cv.height = GRAPH_H;
 el.appendChild(cv);
 const ctx = cv.getContext("2d", { alpha: true, desynchronized: true });

 const rows = document.createElement("div");
 rows.className = "ph-rows";
 el.appendChild(rows);

 // fixed row: scene triangle count
 const rowTris = makeRow(rows, "tris");

 // ring buffer of frame times (ms)
 const times = new Float32Array(CAP);
 let writeIdx = 0;
 let count = 0;
 let maxMs = 33.3;

 let visible = true;
 let acc = 0;
 const lastText = new Map();

 el.classList.add("show");
 function makeRow(parent: HTMLElement, label: string) {
  const r = document.createElement("div");
  r.className = "ph-row";
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "v";
  v.textContent = "—";
  r.appendChild(k);
  r.appendChild(v);
  parent.appendChild(r);
  return { row: r, k, v };
 }
 function txt(el2: HTMLElement, s: string) {
  if (lastText.get(el2) !== s) {
   el2.textContent = s;
   lastText.set(el2, s);
  }
 }

 function drawGraph() {
  if (!ctx) return;
  const w = cv.width;
  const h = cv.height;
  ctx.clearRect(0, 0, w, h);

  // ease axis
  const want = Math.max(
   AXIS_FLOOR_MS,
   Math.min(AXIS_CEILING_MS, stats.max * AXIS_HEADROOM || AXIS_FLOOR_MS)
  );
  maxMs += (want - maxMs) * AXIS_EASE;
  const inv = h / maxMs;

  // shaded target band: frame times under the 60 fps budget
  const y16 = h - BUDGET_60FPS_MS * inv;
  ctx.fillStyle = "rgba(90, 180, 140, 0.07)";
  ctx.fillRect(0, Math.max(0, y16), w, h - Math.max(0, y16));

  // guide lines
  ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
  const y33 = h - AXIS_FLOOR_MS * inv;
  if (y33 >= 0 && y33 <= h) ctx.fillRect(0, y33, w, 1);
  ctx.fillStyle = "rgba(255, 255, 255, 0.34)";
  if (y16 >= 0 && y16 <= h) ctx.fillRect(0, y16, w, 1);

  const n = count;
  if (n === 0) return;
  const step = w / CAP;
  const start = CAP - n; // left offset so strip is right-anchored
  for (let i = 0; i < n; i++) {
   const idx = (writeIdx - n + i + CAP * 2) % CAP;
   const v = times[idx];
   const bh = Math.min(h, v * inv);
   ctx.fillStyle = graphBarColour(v);
   ctx.fillRect((start + i) * step, h - bh, Math.max(1, step - BAR_INSET), bh);
  }
 }

 return {
  get visible() { return visible; },

  toggle() {
   visible = !visible;
   el.classList.toggle("show", visible);
  },

  /** `gfx` is accepted for signature parity with `fpsMeter.update` and the
   *  overlay's own row pump; the HUD reads nothing off the device. */
  update(dtMs: number, gfx: unknown) {
   if (!visible) return;

   // ring push (allocation-free)
   times[writeIdx] = stats.last;
   writeIdx = (writeIdx + 1) % CAP;
   if (count < CAP) count++;

   drawGraph();

   acc += dtMs;
   if (acc < PERIOD) return;
   acc = 0;

   const f = stats.fps;
   txt(fpsB, f > 0 ? f.toFixed(0) : "--");
   txt(ft, stats.last > 0 ? stats.last.toFixed(1) + " ms" : "-- ms");

   // colour fps
   el.classList.toggle("bad", f < FPS_BAD);
   el.classList.toggle("warn", f >= FPS_BAD && f < FPS_WARN_HUD);

   txt(rowTris.v, fmtK(stats.triangles));
  },

  dispose() {
   el.remove();
   style.remove();
  },
 };
}

/** Triangles to a short form: 128.5k, or the raw count. */
const TRI_K = 1000; // count at which triangles switch to the "k" suffix

function fmtK(n: number) {
 if (n >= TRI_K) return (n / TRI_K).toFixed(1) + "k";
 return String(n | 0);
}