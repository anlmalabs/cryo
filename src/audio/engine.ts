/**
 * The audio engine — one graph, decoded buffers, and a mixer wired to `S`.
 *
 * Shape of it:
 *
 *   one-shots ─┐
 *   loops ─────┴─► bus gain (ambience | music | sfx | voice) ─► master ─► limiter ─► out
 *
 * Three rules this file exists to enforce:
 *
 *  1. **Nothing decodes at play time.** `load()` runs behind the boot screen and
 *     fetches every entry in the manifest into an `AudioBuffer`. A one-shot fired
 *     from the render loop is a `createBufferSource` and a `start()` — no fetch,
 *     no decode, no promise, and nothing that can hitch a frame.
 *
 *  2. **The context is created suspended and only ever resumed from a gesture.**
 *     Browsers refuse to start audio otherwise, and a demo that silently fails
 *     to play is worse than one that asks. `unlock()` is the only resume path
 *     and it is called from the boot gate or the sound button — both clicks.
 *
 *  3. **Gain is a ramp, never an assignment.** Writing `gain.value` from the
 *     render loop steps the parameter at frame boundaries, which is audible as a
 *     zipper on anything continuous. Everything here goes through
 *     `setTargetAtTime` or an explicit ramp.
 *
 * The mixer reads `S.audioMuted` / `S.masterVolume` / `S.ambienceVolume` /
 * `S.musicVolume` / `S.sfxVolume` and subscribes to them, so the overlay sliders
 * are live.
 */

import { S, onChange, type SettingKey } from "../core/settings.js";
import { assetCandidates } from "../core/assets.js";
import { AUDIO_MANIFEST } from "./manifest.js";

/**
 * Hard ceiling on simultaneous one-shots. Reached only by a bug — the manifest's
 * `minGap` floors keep the real count in single digits — but an unbounded voice
 * count is how a stuck trigger turns into a locked-up audio thread.
 */
const MAX_VOICES = 24;

/** How far ahead the loop scheduler queues overlap segments, seconds. */
const LOOKAHEAD = 0.6;

/**
 * Release applied to a voice cut short by a new one in its exclusive group. Long
 * enough not to click, short enough that the two do not audibly overlap.
 */
const SOLO_RELEASE = 0.06;

/**
 * Head-room a scheduled `start()`/`stop()` is given against the audio thread,
 * seconds. Not a musical offset — a 5 ms margin is small enough to be
 * undetectable and large enough that a stop lands after the release ramp it
 * trails rather than inside it.
 */
const SCHEDULE_MARGIN = 0.005;

/**
 * Fraction of a segment the crossfade may occupy at most. Below half, so an
 * overlapped join always carries more programme than transition — the join
 * reads as a breath in the texture rather than as the asset stuttering.
 */
const CROSSFADE_MAX_FRACTION = 0.45;

/**
 * Shortest segment the overlap scheduler will lay out, seconds. Under this a
 * join's two ramps would overlap their own successor's.
 */
const MIN_SEGMENT_SEC = 0.05;

/**
 * How much of an asset's load progress its decode counts for. The last slice:
 * decode is real work but not measurable, so it gets a flat reservation and
 * the reported number stays monotonic rather than stalling mid-file.
 */
const LOAD_DECODE_WEIGHT = 0.85;

/**
 * Master open rate for the resume gesture, seconds. Faster than `applyMix`'s
 * default: this is the frame the player asked for sound, and the fade here is
 * only there to keep the first sample from clicking.
 */
const UNLOCK_MIX_RATE = 0.008;

/**
 * Mix limiter envelope, seconds. Fast enough that a stack of several voices in
 * one frame is caught before it clips, slow enough to release without
 * pumping — it only ever sees pile-ups, so it stays transparent otherwise.
 */
const LIMITER_ATTACK = 0.004;
const LIMITER_RELEASE = 0.16;

/**
 * How often the overlap scheduler re-queues segments, milliseconds. Four times
 * a second against the 0.6 s look-ahead: comfortably ahead of the schedule
 * even on a busy main thread, cheap enough to ignore.
 */
const PUMP_POLL_MS = 250;

/**
 * Head-room a release fade gets before its source stops, seconds. The stop is
 * always issued after the ramp, never inside it, or the fade clicks.
 */
const STOP_AFTER_FADE = 0.02;

const BUS_NAMES = ["ambience", "music", "sfx", "voice"] as const;

/** A mixer bus name — one gain node per name, all wired into `master`. */
type BusName = (typeof BUS_NAMES)[number];

/** The manifest's own key set, not `string`. */
type AudioKey = keyof typeof AUDIO_MANIFEST;

/**
 * The per-field view `play`/`loop` need. Every field is optional on the entry
 * itself — `minGap`, `exclusive`, `rate`, `loop` each exist only on some rows —
 * so this is the union of them rather than one row's shape, and the entries are
 * read through it rather than through the union TS cannot express.
 */
type AudioFields = Partial<
 Record<"url" | "bus" | "gain" | "rate" | "loop" | "trim" | "crossfade" | "minGap" | "exclusive" | "needs", unknown>
>;

/** Call-site options for `play`/`loop`. */
type PlayOpts = {
 gain?: number;
 rate?: number;
 delay?: number;
 bus?: string;
 minGap?: number;
 exclusive?: boolean | string;
};

/** A manifest numeric field — `minGap`, `rate` — or `undefined` if absent. */
function num(v: unknown): number | undefined {
 return typeof v === "number" ? v : undefined;
}

/**
 * Resolve the `AudioContext` constructor.
 *
 * Old Safari exposes Web Audio only as `window.webkitAudioContext`, which
 * `lib.dom` does not declare. The prefix is intersected onto `Window` with a
 * single optional field — the one thing it might be — and is only accepted
 * when the value is function-shaped. `undefined` means "no Web Audio at all".
 */
function readAudioContextCtor(): typeof AudioContext | undefined {
 if (window.AudioContext) return window.AudioContext;
 // Narrow rather than open: the prefix is either the constructor or it is not
 // there, and an unknown-typed window read would let any later access through.
 const w = window as Window & { webkitAudioContext?: typeof AudioContext };
 const prefixed = w.webkitAudioContext;
 return typeof prefixed === "function" ? prefixed : undefined;
}

export class AudioEngine {
 /** The context, once `_ensureContext` has built it. Null until then. */
 ctx: AudioContext | null = null;
 /** Master bus gain — the `S.masterVolume` fader. */
 master: GainNode | null = null;
 /** Limiter across the whole mix, after `master`. */
 limiter: DynamicsCompressorNode | null = null;
 /** One gain per bus name, all wired into `master`. */
 buses: Record<BusName, GainNode> = Object.create(null) as Record<BusName, GainNode>;
 /** Decoded audio per manifest key. */
 buffers: Map<string, AudioBuffer> = new Map();

 /**
  * Keys whose fetch/decode threw. The load loop is deliberately non-fatal:
  * one asset missing is not a reason to drop the other forty, so `load()`
  * still resolves and `buffers` simply keeps that key absent. Recording it
  * here is what makes that policy auditable — `failed.has(k)` now tells a
  * caller "this asset was attempted and threw" apart from "never attempted",
  * where both used to read as an absent key in `buffers`.
  */
 failed: Set<string> = new Set();

 /** True once every manifest entry has been fetched and decoded (or failed). */
 loaded = false;
 /** True once a user gesture has resumed the context. */
 unlocked = false;
 /**
  * The rejection from the last refused `ctx.resume()`, or null. The return
  * value of `unlock()` stays the boolean callers branch on; this keeps the
  * reason it came back false.
  */
 lastResumeError: unknown = null;


 /** Live one-shot count, for the voice cap. */
 _voices = 0;
 /** Context time of the last start, per key, for `minGap`. */
 _last: Record<string, number> = Object.create(null) as Record<string, number>;
 /**
  * Live voice per exclusive group — see the `exclusive` manifest field.
  */
 _solo: Record<string, { src: AudioBufferSourceNode; gain: GainNode }> =
  Object.create(null) as Record<string, { src: AudioBufferSourceNode; gain: GainNode }>;

 _boundSettings = false;

 /** Whether anything actually decoded — false means offer no sound at all. */
 get hasAssets() {
  return this.buffers.size > 0;
 }

 // ------------------------------------------------------------------ graph

 /**
  * Build the context and the mixer. Called by `load()`, so the graph exists
  * long before the gate — the context simply sits in `suspended` until a
  * gesture resumes it, which is the one state browsers let us start in.
  */
 _ensureContext() {
  if (this.ctx) return this.ctx;

  // Safari ships Web Audio only behind the vendor prefix, which lib.dom does
  // not declare — see `readAudioContextCtor`.
  const Ctor = readAudioContextCtor();
  if (!Ctor) {
   console.warn("[audio] Web Audio is unavailable; running silent");
   return null;
  }

  // `interactive` asks for the smallest buffer the platform will give us.
  // A wind bed would be happy with `playback`, but the carve hits are
  // gameplay feedback and latency reads as sloppiness.
  const ctx = new Ctor({ latencyHint: "interactive" });
  this.ctx = ctx;

  // A gentle limiter across the whole mix. The wind bed, the board, a carve
  // hit, a cast and a voice line can all be up in the same frame, and that
  // sum measures close enough to full scale to clip on a loud setting. This
  // is set high and fast so it only ever catches those stacks — it is not a
  // tone control, and on anything short of a pile-up it is transparent.
  this.limiter = ctx.createDynamicsCompressor();
  this.limiter.threshold.value = -6;
  this.limiter.knee.value = 6;
  this.limiter.ratio.value = 8;
  this.limiter.attack.value = LIMITER_ATTACK;
  this.limiter.release.value = LIMITER_RELEASE;
  this.limiter.connect(ctx.destination);

  this.master = ctx.createGain();
  this.master.gain.value = 0;
  this.master.connect(this.limiter);

  for (const name of BUS_NAMES) {
   const g = ctx.createGain();
   g.gain.value = 1;
   g.connect(this.master);
   this.buses[name] = g;
  }

  if (!this._boundSettings) {
   this._boundSettings = true;
   onChange(
    ["audioMuted", "masterVolume", "ambienceVolume", "musicVolume", "sfxVolume"],
    () => this.applyMix()
   );
   // A suspended context burns no CPU and, more to the point, a wind bed
   // droning out of a background tab is the kind of thing people close
   // the tab over.
   document.addEventListener("visibilitychange", () => {
    if (!this.unlocked || !this.ctx) return;
    if (document.hidden) this.ctx.suspend();
    else this.ctx.resume();
   });
  }

  this.applyMix();
  return ctx;
 }

 /**
  * The gain node for a bus, falling back to the sfx bus when the name is not
  * one of the four — so a manifest row or a call site naming an unknown bus
  * still lands somewhere audible rather than silencing the sound.
  * @param {string} [name]
  * @returns {GainNode}
  */
 _bus(name?: string): GainNode {
  const isBus = (n: string): n is BusName =>
   (BUS_NAMES as readonly string[]).includes(n);
  return isBus(name ?? "") ? this.buses[name as BusName] : this.buses.sfx;
 }

 /**
  * Push `S`'s mix values into the graph. Ramped rather than assigned so a
  * slider drag or a mute is a fade, not a click.
  *
  * @param {number} [smooth] time constant, seconds. The default is tuned for
  *   slider drags and mutes; `unlock` passes something much shorter, because
  *   40 ms of time constant is 120 ms to full scale and that is long enough to
  *   read as the demo being slow to make a sound.
  */
 applyMix(smooth = 0.04) {
  const ctx = this.ctx;
  if (!ctx || !this.master) return;
  const now = ctx.currentTime;
  const master = this.unlocked && !S.audioMuted ? (S.masterVolume as number) : 0;
  this.master.gain.setTargetAtTime(master, now, smooth);
  this.buses.ambience.gain.setTargetAtTime((S.ambienceVolume as number), now, smooth);
  this.buses.music.gain.setTargetAtTime((S.musicVolume as number), now, smooth);
  this.buses.sfx.gain.setTargetAtTime((S.sfxVolume as number), now, smooth);
  this.buses.voice.gain.setTargetAtTime((S.sfxVolume as number), now, smooth);
 }

 // ----------------------------------------------------------------- loading

 /**
  * Fetch and decode the whole manifest.
  *
  * Called early in `boot()` and awaited late, so the download overlaps device
  * creation, the heightfield bake and pipeline compilation — on a warm cache
  * it has been resolved for several seconds by the time anything waits on it.
  *
  * A single asset failing is not fatal: it is logged, its key stays absent
  * from `buffers`, and every later `play`/`loop` for that key is a no-op. A
  * missing carve sample must not take the demo down with it.
  *
  * @param {(p: number) => void} [onProgress] 0..1, monotonic
  */
 async load(onProgress?: (p: number) => void) {
  const ctx = this._ensureContext();
  if (!ctx) {
   this.loaded = true;
   return;
  }

  // `AUDIO_MANIFEST` is a `Record<string, AudioAsset>`, so `Object.keys` widens
  // to `string[]`; the cast restores the manifest's own key union and keeps the
  // lookups below checked rather than implicit-any.
  const keys = Object.keys(AUDIO_MANIFEST) as AudioKey[];
  // Per-asset completion, so the reported number is the mean of real
  // download fractions rather than a count of finished files.
  const frac = new Float64Array(keys.length);
  const report = () => {
   if (!onProgress) return;
   let sum = 0;
   for (let i = 0; i < frac.length; i++) sum += frac[i];
   onProgress(sum / frac.length);
  };

  await Promise.all(
   keys.map(async (k, i) => {
    const def = (AUDIO_MANIFEST as Record<AudioKey, (typeof AUDIO_MANIFEST)[AudioKey & string]>)[k];
    // Belongs to a feature that is switched off: not fetched, not
    // decoded, not waited for. `play` already no-ops on a key with no
    // buffer, so nothing downstream needs to know it is absent.
    //
    // `needs` is optional and per-asset, so it is read off a value typed
    // `unknown` (the object union TS cannot express `needs` on). A name absent
    // from `S` reads as falsy, exactly as the old `!S[def.needs]` did — the
    // settings key is then only used once it names a real one.
    const raw: unknown = def && typeof def === "object" && "needs" in def ? def.needs : undefined;
    const needs: SettingKey | undefined =
     typeof raw === "string" ? (raw as SettingKey) : undefined;
    if (needs && !S[needs]) {
     frac[i] = 1;
     report();
     return;
    }
    try {
     // Decode is the last 15%: it is real work, but it is not
     // measurable in progress, so it gets a flat reservation.
     const buf = await this._fetchDecode(
      def.url as string,
      (p: number) => {
       frac[i] = p * LOAD_DECODE_WEIGHT;
       report();
      }
     );
     this.buffers.set(k, buf);
    } catch (err: unknown) {
     // Deliberately non-fatal: one missing asset must not take the other
     // forty with it, so the loop continues and `buffers` simply keeps this
     // key absent. The non-fatality is recorded in `this.failed` so it is
     // visible to a caller rather than a swallow.
     console.warn("[audio] failed to load '" + k + "':", err);
     this.failed.add(k);
    }
    frac[i] = 1;
    report();
   })
  );

  this.loaded = true;
 }

 /**
  * @param {string} path store-relative, e.g. `audio/ambiance.mp3`
  * @param {(p: number) => void} onProgress
  * @returns {Promise<AudioBuffer>}
  */
 async _fetchDecode(path: string, onProgress: (p: number) => void) {
  // The store first, this origin second. A sound that has been committed
  // but not yet uploaded still plays. See `core/assets.js`.
  let res = null;
  let lastError = null;
  // Sequential by necessity: this is a fallback chain, not a fan-out. The
  // second URL is only fetched when the first has actually failed, and
  // `await` inside the loop is what makes "try the next one" mean anything.
  // `lastError` carries the *last* failure rather than the first, so the
  // message names the origin that was tried most recently.
  for (const url of assetCandidates(path)) {
   try {
    const r = await fetch(url);
    if (r.ok) { res = r; break; }
    lastError = new Error(url + " — " + r.status + " " + r.statusText);
   } catch (err) {
    lastError = err;
   }
  }
  if (!res) throw lastError || new Error("not found: " + path);

  const total = Number(res.headers.get("content-length")) || 0;
  /** @type {ArrayBuffer} */
  let bytes;

  if (total > 0 && res.body) {
   const reader = res.body.getReader();
   /** @type {Uint8Array[]} */
   const chunks = [];
   let read = 0;
   // Sequential by construction: a `ReadableStream` reader yields one chunk
   // at a time and each chunk is appended at the running byte offset, so
   // there is no work to parallelise and none to skip. `read` is the progress
   // cursor, not a loop index.
   for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    read += value.length;
    onProgress(Math.min(1, read / total));
   }
   const flat = new Uint8Array(read);
   let off = 0;
   for (let i = 0; i < chunks.length; i++) {
    flat.set(chunks[i], off);
    off += chunks[i].length;
   }
   bytes = flat.buffer;
  } else {
   // No content-length (compressed transfer, some dev servers): fall
   // back to a plain read and report the file as one step.
   bytes = await res.arrayBuffer();
   onProgress(1);
  }

  return await (this.ctx as AudioContext).decodeAudioData(bytes);
 }

 // ------------------------------------------------------------------ unlock

 /**
  * Resume the context. Must be called synchronously from inside a user
  * gesture handler — the boot gate's button or the sound button.
  *
  * The boolean is the contract callers branch on (`false` = no sound, stay
  * mute), so a refused resume still returns `false`. What was lost was the
  * reason: it went to the console and nowhere else. `lastResumeError` holds
  * the rejection so a caller or a test can read why, not just that.
  * @returns {Promise<boolean>}
  */
 async unlock() {
  const ctx = this._ensureContext();
  if (!ctx) return false;
  try {
   if (ctx.state !== "running") await ctx.resume();
  } catch (err: unknown) {
   console.warn("[audio] resume refused:", err);
   this.lastResumeError = err;
   return false;
  }
  this.unlocked = ctx.state === "running";
  // Open the master fast — this is the gesture that asked for sound, so the
  // fade here exists only to keep the first sample from clicking.
  this.applyMix(UNLOCK_MIX_RATE);
  return this.unlocked;
 }

 // ----------------------------------------------------------------- playback

 /**
  * Fire a one-shot. Silently returns null when the engine is locked, the key
  * is unknown, the asset failed to load, the voice cap is reached, or the
  * key's `minGap` has not elapsed — every one of those is a normal condition
  * for a call made from a render loop, not an error.
  *
  * An asset marked `exclusive` holds one voice at a time: starting it again
  * releases the voice already playing rather than layering onto it. Spells are
  * the case that needs it — nothing rate-limits how fast a player can press
  * `1`, the spell simply restarts, and a five-second effect stacked six deep is
  * a wall of noise where the sound should have restarted with the spell.
  *
  * @param {string} key manifest key
  * @param {{ gain?: number, rate?: number, delay?: number, bus?: string,
  *           minGap?: number, exclusive?: boolean|string }} [opts]
  * @returns {AudioBufferSourceNode|null}
  */
 play(key: string, opts?: PlayOpts) {
  if (!this.unlocked || !this.ctx) return null;
  // An unknown key is a no-op, not an error — every call site is a render
  // loop — so it is narrowed to the manifest's key union before the lookup,
  // and an absent entry falls through the `!def` guard below.
  const entry = key in AUDIO_MANIFEST ? AUDIO_MANIFEST[key as AudioKey] : undefined;
  const buf = this.buffers.get(key);
  if (!entry || !buf) return null;

  // Every field below is optional on the entry and absent on some rows, so it
  // is read through the field view rather than off one row's shape.
  const def = entry as AudioFields;

  const ctx = this.ctx;
  const now = ctx.currentTime;

  const gap = opts?.minGap ?? num(def.minGap) ?? 0;
  if (gap > 0 && now - (this._last[key] ?? -1e9) < gap) return null;
  if (this._voices >= MAX_VOICES) return null;
  this._last[key] = now;

  // One voice per exclusive group. The group defaults to the key itself, so
  // re-casting a spell cuts its own sound and leaves every other spell's
  // alone. `exclusive` is three states — `true` = the key is the group, a
  // string = that named group, anything else = free to layer — written as
  // branches because a ternary chain over three states hides the third.
  const solo = opts?.exclusive ?? def.exclusive;
  let group = "";
  if (solo === true) group = key;
  else if (typeof solo === "string") group = solo;
  if (group) this._releaseSolo(group, now);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const rate = opts?.rate ?? num(def.rate) ?? 1;
  src.playbackRate.value = rate;

  const g = ctx.createGain();
  const gain = (opts?.gain ?? 1) * (num(def.gain) ?? 1);
  g.gain.value = gain;

  src.connect(g).connect(this._bus(opts?.bus ?? (def.bus as string | undefined)));

  this._voices++;
  src.onended = () => {
   this._voices--;
   src.disconnect();
   g.disconnect();
   // Only clear the slot if it is still this voice: a newer one may have
   // taken it over, and this handler runs after that voice has started.
   if (group && this._solo[group]?.src === src) delete this._solo[group];
  };

  src.start(now + (opts?.delay ?? 0));
  if (group) this._solo[group] = { src, gain: g };
  return src;
 }

 /**
  * Fade out and stop whatever holds an exclusive group, so a new voice can
  * take it. Ramped rather than stopped outright — cutting a buffer mid-cycle
  * is a click.
  *
  * @param {string} group
  * @param {number} now context time
  */
 _releaseSolo(group: string, now: number) {
  const live = this._solo[group];
  if (!live) return;
  delete this._solo[group];
  const p = live.gain.gain;
  p.cancelScheduledValues(now);
  p.setValueAtTime(p.value, now);
  p.linearRampToValueAtTime(0, now + SOLO_RELEASE);
  // `onended` does the disconnecting and the voice-count bookkeeping.
  try {
   live.src.stop(now + SOLO_RELEASE + SCHEDULE_MARGIN);
  } catch {
   // Already stopped — nothing to release.
  }
 }

}

/**
 * One continuous sound.
 *
 * Two modes, chosen by whether the manifest entry declares a `crossfade`:
 *
 *  - **native** — a single source with `loop = true` and the loop points pulled
 *    inside the encoder padding. Cheap, and the only mode whose playback rate
 *    can be modulated, which the surf loop needs.
 *
 *  - **overlap** — segments scheduled back to back with an equal-power-ish
 *    crossfade over the join. Costs a timer and two live sources, and in exchange
 *    it does not care whether the file's head and tail match, which is the
 *    difference between a wind bed that breathes and one that ticks every

/**
 * The engine is a singleton because an `AudioContext` is: browsers cap how many
 * a page may create, and a second mixer would be a second set of faders for the
 * same output.
 */
export const audio = new AudioEngine();
