# Porting spec: subsystem `audio-ui`

Source files (this tree's own modules, with their current line counts):

## Source inventory

| Module | Lines | Contents |
|---|---|---|
| `src/audio/engine.ts` | 844 | Web Audio engine + mixer, `AudioEngine`, `LoopVoice`, singleton `audio` |
| `src/audio/manifest.ts` | 282 | `AUDIO_MANIFEST` asset table |
| `src/audio/soundscape.js` | deleted | the game-state-to-sound mapper; the module is gone from this tree and no replacement module carries it. What survived of it lives in the collision pass (`src/physics/collisionPass.ts`, `_bang`) and in `src/main.ts` (the crash cue); see §1.3 |
| `src/ui/overlay.ts` | 737 | `Overlay`, the F1 settings/performance panel |
| `src/ui/fpsMeter.ts` | 88 | `createFpsMeter`, the standalone F-key fps readout |
| `src/ui/perfHud.ts` | 234 | `createPerfHud`, the MangoHud-style corner performance panel |
| `src/ui/fpsTier.ts` | 25 | `fpsTierSuffix`, the CSS spelling of a perf tier |
| `src/ui/soundButton.ts` | 123 | `createSoundButton`, the persistent bottom-left mute/unlock button |
| `src/ui/touchControls.ts` | 409 | `createTouchControls`, on-screen stick/buttons for touch devices |
| `public/audio/*` | 23 assets | mp3 inventory, itemized in §6 |

## Scope

This subsystem is almost entirely renderer-agnostic: it is Web Audio + DOM. It contains zero WGSL shaders, zero GPU textures, and zero render targets. The only renderer touch-point is the render size `Overlay.update` reads (§5). It ports to the Three.js build nearly verbatim; the work is in re-wiring its *inputs* (the cross-subsystem signals listed in §3) and keeping the boot-sequence contract intact.

---

## 1. Purpose & behavior

### 1.1 Audio engine

One Web Audio graph for the whole demo (`src/audio/engine.ts`):

```
one-shot voices ─┐
loop voices ─────┴─► bus gain ("ambience" | "music" | "sfx" | "voice") ─► master gain ─► limiter (DynamicsCompressor) ─► ctx.destination
```

Design rules the file enforces (keep all three in the port):

1. Nothing decodes at play time. `load()` runs during boot and fetches+decodes every manifest entry into an `AudioBuffer`. A one-shot fired from the render loop is only `createBufferSource()` + `start()`.
2. The context is created suspended and only resumed from a user gesture (`unlock()`), called synchronously *inside* a click handler (Safari requirement: a promise continuation is "a turn too late").
3. Gain is never assigned, always ramped (`setTargetAtTime` or explicit linear ramps) to avoid zipper noise from per-frame writes.

Constants:

| Constant | Value | Meaning |
|---|---|---|
| `MAX_VOICES` | 24 | hard cap on simultaneous one-shots (returns `null` past it) |
| `LOOKAHEAD` | 0.6 s | how far ahead the overlap-loop scheduler queues segments |
| `SOLO_RELEASE` | 0.06 s | fade applied to a voice displaced from its exclusive group |
| `BUS_NAMES` | `["ambience", "music", "sfx", "voice"]` | the four bus gain nodes |

Graph details:

- `AudioContext({ latencyHint: "interactive" })`; falls back to `webkitAudioContext`; if neither exists it logs `[audio] Web Audio is unavailable; running silent` and every later call no-ops.
- Limiter: `createDynamicsCompressor()` with `threshold=-6`, `knee=6`, `ratio=8`, `attack=0.004`, `release=0.16`, connected to destination.
- `master` GainNode starts at **0** (opened by `unlock()` → `applyMix`).
- Four bus GainNodes at 1.0, each → master. Note the **`voice` bus is driven by `S.sfxVolume`**: there is no separate voice fader.
- On first `_ensureContext()` it subscribes `applyMix()` to settings keys `["audioMuted","masterVolume","ambienceVolume","musicVolume","sfxVolume"]` via `onChange`, and adds a `visibilitychange` listener: hidden tab → `ctx.suspend()`, visible → `ctx.resume()` (only when already unlocked).

`applyMix(smooth = 0.04)`: ramps `master.gain` to `unlocked && !S.audioMuted ? S.masterVolume : 0`; `buses.ambience → S.ambienceVolume`; `buses.music → S.musicVolume`; `buses.sfx → S.sfxVolume`; `buses.voice → S.sfxVolume`. `unlock()` calls it with `smooth = 0.008` for a fast open.

Loading (`load(onProgress?)`):

- Iterates `AUDIO_MANIFEST` keys in parallel (`Promise.all`).
- An entry with `needs: "<settingsKey>"` is skipped entirely when `S[needs]` is falsy (not fetched, not decoded, counted as done for progress). In practice: `speederLaser1/2`, `speederJet`, `speederCrash` and `speederCrash3` skip unless `S.speeder === true`.
- Per-asset progress is streamed via `res.body.getReader()` against `content-length`; download maps to 0..0.85 of that asset's fraction, decode is the flat last 0.15. Reported progress is the mean over all entries, monotonic.
- Fetch tries each URL from `assetCandidates(path)` in order (CDN blob store first, same-origin `public/` second; see §6).
- One asset failing logs `[audio] failed to load '<key>':` and leaves the key absent from `buffers`; every later `play`/`loop` for it silently no-ops. Never fatal.
- Sets `this.loaded = true` at the end. `hasAssets` getter = `buffers.size > 0` (used by main.ts to decide whether to show the boot gate at all).

One-shots (`play(key, opts)`):

- Returns `null` (silently, not an error) when: locked, unknown key, buffer missing, voice cap hit, or the key's `minGap` (opts override manifest) has not elapsed since the last start of that key (tracked in `_last[key]` in context time).
- Voice chain: `BufferSource → per-voice Gain → bus`. `playbackRate.value = (opts.rate ?? 1) * (def.rate ?? 1)`; `gain.value = (opts.gain ?? 1) * (def.gain ?? 1)`; `src.start(now + (opts.delay ?? 0))`.
- Exclusive groups: `opts.exclusive ?? def.exclusive`; `true` means group = key itself, a string names a shared group. Starting a new voice in a group calls `_releaseSolo(group, now)` on the incumbent: cancel scheduled values, hold current value, linear ramp to 0 over `SOLO_RELEASE`, `src.stop(now + SOLO_RELEASE + 0.005)` in try/catch. The `onended` handler decrements `_voices`, disconnects both nodes, and deletes `_solo[group]` only if it still points at this source (a newer voice may have taken the slot).

Loops (`loop(key, opts)` → `LoopVoice`):

- Manifest entry must declare `loop: true` (otherwise warn + return null). The voice is returned stopped and silent; caller calls `start()` and rides the gain.
- `LoopVoice` fields: `unity = def.gain ?? 1`, `rate = (opts.rate ?? 1) * (def.rate ?? 1)`, `trim = def.trim ?? 0`, `crossfade = def.crossfade ?? 0`, `segment = max(0.05, buf.duration - trim*2)`, crossfade clamped to `segment * 0.45`. `gainNode.gain.value = (opts.gain ?? 0) * unity`; note the default *opts* gain for a loop is **0**, not 1.

#### Scheduling modes

- Native mode (`crossfade === 0`): single `BufferSource` with `loop = true`, `loopStart = trim`, `loopEnd = trim + segment`, started at `(now, trim)`. The only mode whose `setRate(r)` works (ramped with `setTargetAtTime(r, now, 0.08)`).
- Overlap mode (`crossfade > 0`): segments scheduled back to back with an equal-power-ish crossfade. `start()` sets `_nextAt = now + 0.005`, `_first = true`, calls `_pump()` once, then `setInterval(_pump, 250)` (4 Hz against the 0.6 s lookahead). `_pump` spawns segments while `_nextAt < now + LOOKAHEAD` (guard max 8 per tick). `_spawn(at)`: per-segment gain envelope. The first segment ramps 0→1 over 6 ms (click guard, so the bed opens "already there"), later segments ramp 0→1 over `crossfade`; then hold 1 until `at + segment - crossfade`, ramp to 0 at `at + segment`. `src.start(at, trim, segment + 0.02)`, `src.stop(at + segment + 0.01)`. Next segment starts at `at + segment - crossfade`, so the pair sums to roughly constant energy. A suspended context freezes `currentTime`, so the interval stops queueing in hidden tabs.

#### Gain riding

- `set(to, smooth = 0.09)`: per-frame-safe one-pole approach, `setTargetAtTime(to * unity, now, smooth)`. No-op unless running.
- `fade(to, seconds)`: cancel + hold + `linearRampToValueAtTime(to * unity, now + max(0.01, seconds))`. Used for entrances/exits where arrival matters.
- `stop(fadeSeconds = 0.25)`: fade to 0 first (order matters: `fade` no-ops once `running` is false), clear interval, `src.stop(now + fade + 0.02)` in native mode.
- `AudioEngine.stopAll(fade = 0.4)` stops every registered loop (loops are pushed into `engine._loops`; never removed except by `stopAll`, which is fine for this demo's lifetime).

Singleton: `export const audio = new AudioEngine();`, one AudioContext per page.

### 1.2 Manifest

In `src/audio/manifest.ts`: `AUDIO_MANIFEST: Record<string, AudioAsset>` with `AudioAsset = { url, bus?, gain?, rate?, needs?, loop?, trim?, crossfade?, minGap?, exclusive? }`. The full table (reproduce exactly), plus the stubbed `music` row that is commented out in the source and therefore not in the manifest:

| key | url (store-relative) | bus | gain | loop | trim | crossfade | minGap | exclusive | needs |
|---|---|---|---|---|---|---|---|---|---|
| `ambience` | `audio/ambiance.mp3` | ambience | 1.0 | yes | 0.2 | 2.5 | n/a | n/a | n/a |
| `music` (stubbed; see note below) | `audio/imperial.mp3` | music | 1.20 | yes | 0.08 | 4.0 | n/a | n/a | n/a |
| `slide` | `audio/slide-continue.mp3` | sfx | 0.85 | yes (native) | 0.04 | n/a | n/a | n/a | n/a |
| `turnA` | `audio/slide-turn-1.mp3` | sfx | 0.7 | n/a | n/a | n/a | 0.42 | n/a | n/a |
| `turnB` | `audio/slide-turn-2.mp3` | sfx | 0.7 | n/a | n/a | n/a | 0.42 | n/a | n/a |
| `excited1`..`excited6` | `audio/excited-1.mp3`..`-6.mp3` | voice | 0.95 | n/a | n/a | n/a | 20 | n/a | n/a |
| `lukeIntro` | `audio/luke-voice-1.mp3` | voice | 1.0 | n/a | n/a | n/a | n/a | n/a | n/a |
| `spell1` | `audio/effect1.mp3` | sfx | 0.55 | n/a | n/a | n/a | 0.1 | true | n/a |
| `spell2` | `audio/effect2.mp3` | sfx | 0.55 | n/a | n/a | n/a | 0.1 | true | n/a |
| `spell3` | `audio/effect3.mp3` | sfx | 0.55 | n/a | n/a | n/a | 0.1 | true | n/a |
| `spell4` | `audio/effect4.mp3` | sfx | 0.55 | n/a | n/a | n/a | 0.1 | true | n/a |
| `spell5` | `audio/effect5.mp3` | sfx | 0.55 | n/a | n/a | n/a | 0.1 | true | n/a |
| `speederLaser1` | `audio/airspeeder-laser-1.mp3` | sfx | 0.42 | n/a | n/a | n/a | 0.04 | n/a | `speeder` |
| `speederLaser2` | `audio/airspeeder-laser-2.mp3` | sfx | 0.42 | n/a | n/a | n/a | 0.04 | n/a | `speeder` |
| `speederCrash` | `audio/speeder-explosion.mp3` | sfx | 0.9 | n/a | n/a | n/a | 0.5 | n/a | `speeder` |
| `speederCrash2` | `audio/speeder-crash-2.mp3` | sfx | 0.95 | n/a | n/a | n/a | 6 | n/a | n/a |
| `speederCrash3` | `audio/speeder-crash-3.mp3` | sfx | 0.95 | n/a | n/a | n/a | 4 | n/a | `speeder` |
| `speederJet` | `audio/delta-jet.mp3` | sfx | 0.62 | yes (native) | 0.06 | n/a | n/a | n/a | `speeder` |
| `spell2Land` | `audio/effect2-landing.mp3` | sfx | 0.7 | n/a | n/a | n/a | 0.12 | n/a | n/a |

Notes that are load-bearing:

- `music.gain = 1.20` is a measured loudness match, derived in the `music` entry's comment at `src/audio/manifest.ts`. EBU R 128 integrated loudness puts the bed at −16.8 LUFS and the track at −19.5, so the track needs 2.7 dB to come level. The soundscape then holds the bed at 0.88 of unity while the player stands still, which gives `10^(2.7/20) * 0.88 = 1.20` rather than 1.36. That is the value to use if the entry is restored.
- The `music` entry is currently stubbed out: it is commented out in `src/audio/manifest.ts` with "Music stubbed out: no score track loaded or played", so no score track loads or plays in the live build, and the current `AUDIO_MANIFEST` carries no 1.20 gain. The derivation above is future-relevant rather than a description of live state. Of the rest of the `music` path, only the `S.musicVolume` fader survives: the `Soundscape` voice, its duck and its entrance envelope went with the module.
- `ambience` is deliberately unity so `S.ambienceVolume` is the single ceiling.
- The walker's samples are gone with the herd: neither `walkerStep` nor `walkerShot` has a manifest entry, and `audio/at-walker-canon.mp3` is not on disk.
- `trim` exists because MP3 decode leaves encoder padding that clicks on native loops; `crossfade > 0` switches an asset to the overlap scheduler.

### 1.3 Soundscape

The module is gone from this tree (`src/audio/soundscape.js`, deleted): there is no `src/audio/soundscape.ts`, and nothing else has
taken over its role. Nothing in the port decides *when* a continuous sound plays, because
nothing starts one: there is no `audio.loop(...)` call site anywhere in `src/`, so the wind bed,
the board loop, the jet and the score are all silent in the live build.

What survived of the soundscape's job sits in two call sites instead:

- `src/physics/collisionPass.ts` owns the distance model. Its `_bang(px, pz, gain, rate, key)`
  plays a manifest key with `gain * near³` and a delay of `min(1.6, d/343)`, where `d` is the
  planar distance from the character and `near = max(0, 1 - d/audible)`. `audible` is
  `CRASH_AUDIBLE` (900 m) for `speederCrash` and `SHOT_AUDIBLE` (420 m) for everything else.
- `src/main.ts` fires the one narrative cue: `speederCrash2` from the wingman's killing hit, on
  the same cubed falloff and the same 343 m/s delay.

The per-frame polling contract the soundscape had (`spells.castCount`,
`spells.ribbon.splashCount`, `walker.stepCount`, `walker.shotCount`, `speeder.shotCount`) has no
consumer left either: the walker herd was purged, and the spell and speeder counters are
published but never read, so the manifest's spell entries (`spell1` to `spell5`, `spell2Land`)
have no play site in this build.

### 1.4 Overlay

Settings + performance panel (`src/ui/overlay.ts`), hidden by default, toggled with F1 or Backquote (bindings live in `core/input.ts`, which calls the `onToggleOverlay` hook). Pure DOM: injects a `<style>` blob and builds `#ov`, a fixed 336 px right-edge panel. Contents top to bottom:

1. Header `SNOWFLOW / F1 to close`.
2. Frame graph: a 304×66 `<canvas>` driven by `FrameGraph` from `core/perf.ts` (2D context, bars colored by budget band: >16.7 ms red `#e8734f`, >11.1 ms amber `#e8b04f`, else blue `#6fb2e0`; guide lines at 11.1/16.7 ms; eased y-axis; median line on top). Redrawn at 20 Hz (`_graphAcc >= 50` ms).
3. Readout grid (2 columns): `fps`, `1% low`, `median`, `99th`, `gpu ms`, `draws`, `tris`, `spikes`, `res`. Refreshed at 4 Hz (250 ms). Color classes: fps row `bad` < 60, `warn` < 88; 1%-low row `bad` < 60, `warn` < 75; spikes row `warn` when count > 0. GPU shows `—` (not `0.00`) when `stats.gpuMs <= 0`, because an unavailable number and a zero one are not the same claim.
4. "Frame budget" section: one row per key in `systemMs` (created lazily, then only mutated) showing per-system CPU ms. The keys written by main.ts are `cpu character`, `cpu spells`, `cpu terrain`, `cpu wake+spray`, `cpu audio`, `cpu submit`, `cpu total`.
5. "Camera" debug section, refreshed at 10 Hz (100 ms): eye position (`fmt2` sign-padded 2-decimal, `white-space: pre` so columns don't jitter), yaw°/pitch° (yaw wrapped 0..360 compass, pitch signed), arm length + vertical fov°, player position, speed m/s + facing° (+ `surf N.NN` when `c.surf > 0.01`). Plus a selectable "pose" line, a paste-able console one-liner (`const s=SNOWFLOW;s.character.position.set(...);s.character.facing=...;s.rig.yaw=...;s.rig.pitch=...;s.rig.distance=s.rig.distanceTarget=...;`), and a "copy pose" button (clipboard with console fallback).
6. "Quality" preset buttons: `ultra`, `high`, `balanced` → `applyPreset(name)` then re-sync all widgets; active button highlighted by `S.preset`.
7. One group per `SCHEMA` entry (13 groups, 107 widget rows): `t:"f"` → `<input type=range>` with min/max/step + formatted value span (`fmtNum` decimal places derived from step), `oninput` → `set(k, parseFloat)`; `t:"b"` → custom switch div toggling on click; `t:"e"` → `<select>`, `onchange` → `set(k, value)`; `t:"c"` → `<input type=color>` over a trio of channel keys (`kr`/`kg`/`kb`); `t:"a"` → a button wired to a named callback in the overlay's `actions` bag. Widgets push `{k, sync}` records; `toggle()` re-syncs all on open so external writes (presets, console) are reflected.

DOM writes are guarded by `_txt(el, s)` which caches the last string on the element (`el._v`) and only touches `textContent` on change.

Public surface: `constructor(refs?: {rig?, character?, actions?})`, `attach(refs)` (late-bind), `toggle()`, `update(dtMs, gfx)`, `resetSpikes()` (delegates to perf), `visible`, `el`.

### 1.5 FPS meter

In `src/ui/fpsMeter.ts`, `createFpsMeter()` returns `{ visible, toggle(), update(dtMs), dispose() }`. A tiny fixed top-left pill (`#fpsm`) showing only `NN fps`. Toggled with the F key (hook wired through `initInput`'s `onToggleFps`). Reads `stats.fps` from `core/perf.ts` with no second clock. Refresh 250 ms; on `toggle()` the accumulator is pre-loaded (`acc = PERIOD`) so the first visible frame shows a number, not the stale one. Color thresholds identical to the overlay: class `bad` < 60, `warn` < 88; shows `--` when fps ≤ 0. `pointer-events: none; user-select: none`.

### 1.6 Sound button

In `src/ui/soundButton.ts`, `createSoundButton(audio, hooks?: { onEnable })` returns `{ reveal(), sync(), el }`. Fixed bottom-left 34×34 button (`#snd`), hidden (`opacity 0`, no pointer events) until `reveal()` adds `.ready`, called by main.ts after the boot screen is done. Inline SVG glyphs (speaker + arcs when audible, speaker + X when not); no image assets.

Click handler (order is deliberate):

- `btn.blur()` runs first, because Space is the slide key and a focused button would re-activate on it.
- If `!audio.unlocked`: call `audio.unlock()` synchronously in the handler (Safari), then `set("audioMuted", false)`, then on the promise: if resumed OK fire `hooks.onEnable()` (the port passes no hook: `createSoundButton(audio)`), then `sync()`.
- Else: `set("audioMuted", !S.audioMuted)`; `sync()`.

State lives in `S.audioMuted`, not in the widget; it subscribes `onChange("audioMuted", sync)` so the overlay's Mute toggle keeps the glyph honest. `sync()` computes `audible = audio.unlocked && !S.audioMuted` and sets class `on`, `innerHTML` glyph, `title`/`aria-label` (`"mute"` / `"sound on"`), `aria-pressed`.

### 1.7 Touch controls

In `src/ui/touchControls.ts`, `createTouchControls(hooks?: { onToggleOverlay })` → `{ visible, dispose() }`. Hand-rolled twin-stick rig, entirely DOM + Pointer Events, writing into the shared input structs from `core/input.ts` (`input`, `touch`). Nothing renders or is interactive until the first `pointerdown` with `pointerType === "touch"` anywhere on the page (capture listener on `window`); then `#tc` gets class `on`, `document.body` gets class `touch`, `touch.present = true`, and the `#hint` element (owned by the boot screen HTML) is rewritten to `"stick to fly · drag to look · hold fire"`.

Constants: `LOOK_SCALE = 0.0034` rad/px (higher than the mouse's 0.0022), `RADIUS = 62` px stick throw, `DEAD_ZONE = 0.14` (rescaled, not clipped: `scaled = (mag - dz)/(1 - dz)`), `SPRINT_AT = 0.86` deflection, `PINCH_SCALE = 0.004`.

Layout (each control captures its own pointer id → natural multi-touch):

- `.look`, the full-screen surface under everything: one-finger drags accumulate `input.lookX += dx*LOOK_SCALE`, `input.lookY += dy*LOOK_SCALE`; two fingers are a pinch, `input.zoomDelta -= (spread - prevSpread) * PINCH_SCALE` (look suppressed while pinching; pinch baseline re-taken when a finger lifts back to 2).
- `.stick`, the left 48% × 62% region: floating recentre (base+knob jump to the touch point); direction from the *unclamped* delta, throw clamped to RADIUS; writes `touch.x = ux*scaled`, `touch.z = -uy*scaled` (screen down = world back), `touch.active`, `touch.sprint = mag > SPRINT_AT`; release zeroes everything and re-rests the puck at `restX = RADIUS + 34`, `bottom - RADIUS - 46`.
- `fire` button (bottom right 108×62 pill): hold → `touch.surf = true/false`.
- climb/descend pair stacked above it (54 px circles, bottom `170px` and `104px` + safe-area inset): press → `input.riseLevel` up/down one rung (clamped to 1..3). The five spell buttons the walking demo had here are gone with the spell system, which flying hides.
- gear button (top left): → `hooks.onToggleOverlay()`.

`bindButton` uses `pointerdown`/`pointerup`/`pointercancel` with pointer capture, never `click`, which is too late for held controls and would let synthetic post-touch clicks double-fire; `click` is preventDefault-ed.

`core/input.ts` (owned by another subsystem, but the contract): `pollInput()` rebuilds `input.moveX/moveZ` from keys each frame and the stick wins while active (replaces, does not sum); `touch.surf` ORs into the slide/fire trigger; `endFrame()` zeroes `lookX/lookY/zoomDelta/spellPressed` each frame, which is why the touch layer accumulates with `+=`. `window blur` clears the touch struct too.

### 1.8 Boot / frame wiring

Construction order (from `src/main.ts`): `audio.load()` is kicked off before the WebGL device exists (network overlaps GPU init) and awaited at "loading audio" (progress 0.96). `Overlay` is built with `{ rig, character, actions: { captureShot } }`; `createFpsMeter()`; `createPerfHud()`; `initInput(canvas, { onToggleOverlay, onToggleFps })`; `createTouchControls({ onToggleOverlay })`; `createSoundButton(audio)`. There is no `Soundscape` in the port (see §1.3).

Gate: only if `audio.hasAssets`, `loading.gate(() => { unlocking = audio.unlock(); })`. The unlock is issued synchronously inside the click/keydown handler and awaited outside; then `soundButton.sync()`; after `loading.done()`, `soundButton.reveal()`; `setTimeout(() => overlay.resetSpikes(), 800)` (discard warm-up spikes).

Per-frame call order (this subsystem's slots):

```
pollInput() → gameplay updates …
→ render → mark("cpu character", …) etc. → endFrameDraws() → stats.triangles = …
→ sample(dtMs) → checkSpike(dtMs)
→ overlay.update(dtMs, gfx) → fpsMeter.update(dtMs) → perfHud.update(dtMs, gfx) → endFrame()
```

The `cpu audio` mark is still written by the frame loop, but it now measures the gap between the vfx block and the render: the soundscape it used to time is gone. `stats.gpuMs` is never written in the port: WebGL2 has no dependable timer, so it stays 0 and the overlay renders its dash.

Also exposed on `globalThis.SNOWFLOW`: `audio`, `overlay`, `touchControls` (console debugging; the pose script depends on `SNOWFLOW.character` / `SNOWFLOW.rig`). There is no `soundscape` on the handle.

---

## 2. Public API

### `src/audio/engine.ts`

`export class AudioEngine`:

| Member | Signature | Notes |
|---|---|---|
| getter | `get hasAssets(): boolean` | `true` when any buffer decoded |
| method | `async load(onProgress?: (p: number) => void): Promise<void>` | call once at boot, before the gate |
| method | `async unlock(): Promise<boolean>` | must be issued synchronously inside a gesture handler |
| method | `applyMix(smooth = 0.04): void` | ramps master + all four buses |
| method | `play(key, opts?: { gain?, rate?, delay?, bus?, minGap?, exclusive?: boolean\|string }): AudioBufferSourceNode\|null` | one-shot voice |
| method | `loop(key, opts?: { gain?, rate?, bus? }): LoopVoice\|null` | looping voice, returned stopped and silent |
| method | `stopAll(fade = 0.4): void` | fade out and stop every registered loop |
| fields | `ctx`, `master`, `limiter`, `buses`, `buffers: Map<string, AudioBuffer>`, `loaded`, `unlocked` | graph nodes and state |

`export class LoopVoice`: `start()`, `set(to, smooth = 0.09)`, `fade(to, seconds)`, `setRate(r)` (native mode only), `stop(fadeSeconds = 0.25)`, field `running`.

`export const audio`, the page-wide singleton.

### `src/audio/manifest.ts`

- `export const AUDIO_MANIFEST` (table in §1.2); JSDoc typedef `AudioAsset`.

### `src/audio/soundscape.js`

Deleted. There is no `Soundscape` class in this tree, and no module replaces it; §1.3 says where
the surviving pieces of its job went.

### `src/ui/overlay.ts`

`export class Overlay`:

| Member | Signature | Notes |
|---|---|---|
| constructor | `constructor(refs?: { rig?, character?, actions? })` | builds the panel and injects its `<style>` |
| method | `attach(refs): void` | late-bind of rig/character |
| method | `toggle(): void` | open/close, re-syncs all widgets on open |
| method | `update(dtMs: number, gfx): void` | dtMs in **milliseconds**; `gfx` is used only for `renderWidth`/`renderHeight` |
| method | `resetSpikes(): void` | delegates to perf |

### `src/ui/fpsMeter.ts`

- `export function createFpsMeter(): { visible, toggle(), update(dtMs), dispose() }`

### `src/ui/soundButton.ts`

- `export function createSoundButton(audio, hooks?: { onEnable?: () => void }): { reveal(), sync(), el }`

### `src/ui/touchControls.ts`

- `export function createTouchControls(hooks?: { onToggleOverlay?: () => void }): { visible, dispose() }`

### Settings keys consumed

The five mixer keys (exact keys in `src/core/settings.ts`) are subscribed via `onChange` and also read on every `applyMix`:

| Key | Default | Consumed by |
|---|---|---|
| `audioMuted` (bool) | false | engine mixer, sound button |
| `masterVolume` | 0.8 | engine mixer |
| `ambienceVolume` | 0.14 | engine mixer |
| `musicVolume` | 0.45 | engine mixer |
| `sfxVolume` | 1.0 | engine mixer, drives the `voice` bus too |

Other consumers:

| Key | Read as |
|---|---|
| `speeder` | manifest `needs` fields (`speederLaser1/2`, `speederJet`, `speederCrash`, `speederCrash3`) |
| `S.showSpells` | cast sounds (no play site left in this build) |
| whole `SCHEMA` array, `S.preset` | overlay widget build and sync |
| `audioMuted` | sound button, via `set`/`onChange` |

`S.showWalker` is gone from the settings store with the herd.

Settings API shape: `S` (flat mutable object), `SCHEMA` (widget metadata `{group, items:[{k,l,t:"f"|"b"|"e"|"c"|"a",min,max,step,opts}]}`), `set(k,v)` (notify), `onChange(keys, fn) → unsubscribe`, `applyPreset(name)` accepting `"ultra"`, `"high"` or `"balanced"`, and `PRESETS`.

---

## 3. Data flow
Cross-subsystem objects; none are GPU resources.

This subsystem exchanges no textures, render targets, or uniform buffers with anything. Its interfaces are plain JS objects polled per frame:

Consumed (owner in parentheses):

| Object / field | Owner | Used by | Notes |
|---|---|---|---|
| `controller.speed01` (0..1, normalized to slide top speed) | character/controller | (no consumer left) | the soundscape read it for the ambience/jet/slide levels and gates; nothing reads it for sound now |
| `controller.surf` (eased slide blend 0..1) | character/controller | overlay | overlay readout; the slide, turn and air gates were the soundscape's |
| `controller.carve` (eased lateral load, signed) | character/controller | (no consumer left) | the turn-hit gain + gate were the soundscape's; the wake is still shaped from the same signal |
| `controller.position` (`{x,y,z}`), `controller.groundY` | character/controller | overlay | readouts; the air detection and the walker distances were the soundscape's |
| `controller.speed` (m/s), `controller.facing` (rad) | character/controller | overlay | readouts + pose script |
| `spells.castCount`, `spells.lastCast` (1..5), `spells.ribbon.splashCount` | spells/spellSystem | (no consumer left) | published, never read: the soundscape that polled them is gone |
| `walkers.count`, `walkers.walkers[i].stepCount`, `.shotCount`, `.position.{x,z}` | walkers/walker (WalkerHerd) | (gone) | the herd was purged |
| `speeder.shotCount` | player/speeder | (no consumer left) | published, never read |
| `rig.camera.position`, `rig.yaw`, `rig.pitch`, `rig.distance`, `rig.distanceTarget`, `rig.fov` (rad, vertical) | core/camera (CameraRig) | overlay | readouts + pose script |
| `stats` (fps, fpsLow, median, p99, gpuMs, drawCalls, triangles), `systemMs`, `spikes`, `FrameGraph`, `resetSpikes` | core/perf | overlay, fpsMeter | perf owns the ring buffer; main.ts feeds it |
| `gfx.renderWidth` / `gfx.renderHeight` | core/gfx | overlay | the "res" readout, and the one renderer API in the subsystem |
| `input`, `touch` structs; `initInput` hooks `onToggleOverlay`, `onToggleFps` | core/input | touchControls, overlay/fps toggles | touch layer writes `touch.*`, `input.lookX/lookY/zoomDelta/spellPressed/spellHeld2` |
| `assetCandidates(path)` | core/assets | audio engine | CDN-first URL list |
| `loading.gate/done/phase`, `#hint` DOM element | core/loading + index.html | main.ts + touchControls | gate gesture = unlock; touch layer rewrites the hint text |
| `S`, `SCHEMA`, `set`, `onChange`, `applyPreset` | core/settings | all of the above | |

Produced for others:

| Object | Producer | Consumers |
|---|---|---|
| Audible output (Web Audio graph) | AudioEngine | the user |
| `touch` struct + `input.lookX/lookY/zoomDelta/spellPressed/spellHeld2` writes | touchControls | `core/input.pollInput` → camera rig, controller, spells |
| Settings writes via `set()` | overlay widgets, sound button | every `onChange` subscriber in the demo (terrain rebuilds, material freezes, resolution scale, etc.) |
| the unlocked engine (`audio.unlocked`) | the sound button's unlock | the audio engine: `play`/`loop` no-op until it is true |
| Overlay budget rows | overlay | humans (reads `systemMs`, written by main.ts `mark()`) |

Timing/update contract: `overlay.update(dtMs, gfx)` and `fpsMeter.update(dtMs)` run after render + `sample()`/`endFrameDraws()`; `endFrame()` (input) last of all. Touch look/zoom accumulators are consumed in the same frame they were written.

---

## 4. Shader inventory

None. This subsystem contains no WGSL, no GLSL, no GPU passes. The only drawing it does is the overlay's frame graph, on a plain 2D canvas (`getContext("2d", { alpha: true, desynchronized: true })`, which lives in `core/perf.ts`'s `FrameGraph` and is consumed here). Nothing to translate.

---

## 5. Babylon-specific machinery → Three.js equivalents

| Babylon usage | Where | Three.js WebGL2 replacement |
|---|---|---|
| `engine.getRenderWidth()`, `engine.getRenderHeight()` | `Overlay.update` "res" readout | Settled in the port: `update(dtMs, gfx)` takes the `Gfx` layer, and `gfx.renderWidth` / `gfx.renderHeight` are `renderer.getDrawingBufferSize()` (device pixels, matches Babylon's meaning). |
| `stats.gpuMs` fed by `engine.getGPUFrameTimeCounter()` (WebGPU timestamp queries, installed in main.ts) | overlay reads `stats.gpuMs` | WebGL2 has no core timestamp query. The port took the fallback: `stats.gpuMs` stays 0, and the overlay already renders `—` for 0/unavailable as the designed fallback. `EXT_disjoint_timer_query_webgl2` is not wired. Do not fake it with frame cadence. |
| `stats.drawCalls` fed by `installDrawCounter` wrapping `engine.drawElementsType`/`drawArraysType` (perf subsystem, but the overlay displays it) | overlay | `renderer.info.render.calls` latched after render (`renderer.info.autoReset` semantics: read after `renderer.render`, or set `autoReset = false` and reset manually at frame end). This is what the port does (`installDrawCounter` sets `autoReset = false`; `endFrameDraws()` latches and resets). Same for `renderer.info.render.triangles` if the hand-summed `stats.triangles` is replaced. |
| Everything else | copy-through | Nothing to replace. Web Audio, DOM, Pointer Events, `AudioContext.decodeAudioData` and canvas 2D are platform APIs. No coordinate-handedness issues, because the soundscape uses distances and heights only, with no panner nodes and no HRTF: audio is deliberately non-spatial except distance gain + delay. |

Boot-contract equivalents to preserve in the Three build: kick `audio.load()` before renderer/asset init so the download overlaps; keep the gate → synchronous `unlock()` → `soundscape.start()` sequence; keep `overlay.resetSpikes()` ~800 ms after boot; keep the coarse-pointer preset drop (`applyPreset("balanced")`, `S.resolutionScale = 0.7`) before anything reads sizes.

---

## 6. Assets

All audio is MP3 and fetched at runtime; there are no .bin layouts in this subsystem. Resolution order (from `core/assets.ts`) is `https://zpumgyyt6ujxyrej.public.blob.vercel-storage.com/<path>` first (public Vercel Blob, `access-control-allow-origin: *`, required for `decodeAudioData` on cross-origin bytes), then same-origin `<path>` (i.e. `public/audio/...`). Override with `VITE_ASSET_BASE` (empty string = local only).

Inventory of `public/audio/` (all present locally; sizes as on disk):

| file | bytes | manifest key(s) |
|---|---|---|
| `ambiance.mp3` | 695,040 | `ambience` |
| `slide-continue.mp3` | 69,120 | `slide` |
| `slide-turn-1.mp3` | 57,600 | `turnA` |
| `slide-turn-2.mp3` | 50,880 | `turnB` |
| `excited-1.mp3` … `excited-6.mp3` | 46,080 / 50,880 / 50,880 / 38,400 / 48,000 / 61,440 | `excited1..6` |
| `luke-voice-1.mp3` | 59,520 | `lukeIntro` |
| `effect1.mp3` | 142,080 | `spell1` |
| `effect2.mp3` | 43,200 | `spell2` |
| `effect2-landing.mp3` | 19,200 | `spell2Land` |
| `effect3.mp3` | 93,120 | `spell3` |
| `effect4.mp3` | 120,000 | `spell4` |
| `effect5.mp3` | 238,080 | `spell5` |
| `airspeeder-laser-1.mp3` | 55,680 | `speederLaser1` (needs `speeder`) |
| `airspeeder-laser-2.mp3` | 40,320 | `speederLaser2` (needs `speeder`) |
| `speeder-explosion.mp3` | 259,200 | `speederCrash` (needs `speeder`) |
| `speeder-crash-2.mp3` | 304,320 | `speederCrash2` |
| `speeder-crash-3.mp3` | 154,560 | `speederCrash3` (needs `speeder`) |
| `delta-jet.mp3` | 133,440 | `speederJet` (needs `speeder`) |

Every file on disk has a manifest entry and vice versa: 23 files, 23 entries. There is no `walkerStep` sample and no `walkerShot` sample, which is intentional (see §1.2). One key is played but has no entry: the collision pass asks for `speederHitWalker`, which is not in the manifest, so that one play no-ops. The sound button and touch controls ship no image assets (inline SVG / CSS only).

---

## 7. Porting risks & gotchas
The risks are listed in ranked order:

1. Gesture-unlock ordering (Safari). `audio.unlock()` must be called synchronously inside the click/keydown handler, and both `loading.gate(onEnter)` and the sound button do this deliberately, resolving the promise afterwards. If the Three port's boot flow awaits anything between the gesture and `ctx.resume()`, Safari refuses to resume and the demo is permanently silent. Preserve the callback-into-the-handler shape exactly (gate: `onEnter` runs before the promise resolves; button: `unlock()` before `set("audioMuted", false)`, `.then` only for `onEnable`/`sync`).
2. Frame-order dependency of the soundscape. Settled by its removal: the module that used to be a pure poller (`soundscape.update(dt)` after the controller/spells/walkers/speeder updates, edge-detecting `castCount`, `splashCount`, `stepCount`, `shotCount` and herd growth) is gone from this tree, and with it the counters it read. If a soundscape is ever brought back, it must stay a pure poller and the counter contracts have to come back with it, or casts get double-fired or dropped and the "adopt on first sight / after gate" logic (in `start()` and `_walkerSteps`) silently breaks, e.g. a burst of backdated walker steps when the herd slider grows.
3. GPU/draw stats plumbing disappears on WebGL2. `stats.gpuMs` comes from WebGPU timestamp queries and `stats.drawCalls` from wrapping Babylon's two draw entry points; neither exists in Three. The port uses `renderer.info` for draws/tris (`autoReset = false`, latched in `endFrameDraws()`) and accepts `—` for GPU ms (the overlay already handles 0 as "unavailable"); `EXT_disjoint_timer_query_webgl2` is not wired. Risk is quiet wrongness: leaving the old fields unset renders misleading zeros for draws/tris rather than dashes.
4. Loop seam fidelity depends on the exact envelope math. The overlap scheduler's constants (LOOKAHEAD 0.6 s, 250 ms pump, first-segment 6 ms click-guard vs. full-crossfade entrance, `_nextAt = at + segment - crossfade`, `trim` offsets against MP3 encoder padding) and the native loops' `loopStart/loopEnd = trim … trim+segment` are all audible if changed: the wind bed ticks every ~17 s, the music join stops passing as a musical decay, and the slide/jet loops click. Also keep the rule that only *native* loops may `setRate`, because retuning an overlap schedule walks the joins out of alignment.
5. Settings store is the nervous system. The overlay writes through `set()` and half the demo subscribes via `onChange`; the mixer subscribes to five audio keys; manifest `needs` reads `S.speeder` at load time; the coarse-pointer preset drop must happen before construction-time reads. If the Three port re-architects settings (e.g. a different store), every exact key in §2 must survive, including the semantics "`voice` bus is driven by `sfxVolume`" and "`audioMuted` is the single source of truth shared by two widgets".
6. Touch layer vs. input reconciliation. `touchControls` writes a *separate* `touch` struct precisely because `pollInput()` rebuilds `input.moveX/moveZ` from keys each frame (a direct write would be erased); look/zoom are `+=` accumulators zeroed in `endFrame()`. Reveal is gated on `pointerType === "touch"` (not `maxTouchPoints`), and every control does its own pointer capture (no `click`). Recreating this on top of a different input module without those two contracts (stick-wins-while-active, per-frame accumulator reset) yields dead sticks or runaway cameras on hybrid laptops.
7. Minor but real: `Overlay` and `fpsMeter.update` take **milliseconds**, which is easy to swap when re-wiring the loop, and overlay/fps must keep running under `freezeTime` (they use dtMs). The pose script emits `SNOWFLOW.*` console code, so keep the `globalThis.SNOWFLOW` handle (with `character`, `rig`) or the copy-pose feature emits dead code. The `#hint` element and `body.touch` CSS hook live in the host page HTML/boot screen, owned outside this subsystem, and the Three port's index.html must provide them. `visibilitychange` suspend/resume and the window-`blur` input clear are both required to avoid a droning background tab / stuck controls.
