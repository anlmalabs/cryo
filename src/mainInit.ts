/**
 * SNOWFLOW — entry point and frame orchestration.
 *
 * WebGL2 only, by design (this build; the original was WebGPU-only). Three.js
 * is a rasterizer here — no feature-detect branches: if the context or the
 * float render targets aren't there we say so once and stop.
 */

import { buildVfx } from "./mainVfx.js";
import { startFrameLoop } from "./mainLoop.js";

import { registerShaders } from "./shaders/registry.js";
import { S, onChange, applyPreset, type SettingValue } from "./core/settings.js";
import { installDrawCounter, stats } from "./core/perf.js";
import { input } from "./core/input.js";
import { createGfx } from "./core/gfx.js";
import { whenReady } from "./core/gpuUtil.js";
import * as loading from "./core/loading.js";
import { audio } from "./audio/engine.js";
import { installShotCapture } from "./core/openingShot.js";
import { loadModelAsset } from "./walkers/modelAsset.js";

import { buildBootAssets } from "./mainBootAssets.js";
import { buildSquad } from "./mainSquad.js";
import { buildUi, chooseMode } from "./mainUi.js";
import { buildFlightMode } from "./mainFlightMode.js";
import { createFlightState, squadImpact, CLEAR_COLOR } from "./mainContracts.js";

// --------------------------------------------------------- recovered contracts
// The flight state `main.ts` carries for the code the walker/escort purge left
// behind. Both arrays are always empty at runtime — nothing populates them any
// more — but the collision pass and the presentation loop are still written
// against *lists* of craft, and their loops stay.

/**
 * The console debug handle `window.SNOWFLOW`.
 *
 * Nothing in this repo reads it — the only access is from the browser console,
 * so the global is genuinely unowned by any type here. It is declared rather
 * than reached through a double cast through `unknown` so the one assignment
 * below needs no suppression and the shape it publishes is checked.
 */
declare global {
 interface Window {
  SNOWFLOW?: unknown;
 }
}

export async function boot() {
 const canvas = document.getElementById("view") as HTMLCanvasElement;

 // A coarse pointer means a phone or a tablet, and a phone is a tile-based GPU
 // with a fraction of the bandwidth this was tuned against. Drop to the
 // balanced preset *here*, before anything is built: the deformation buffer's
 // resolution is read once at construction, so a preset applied after the
 // terrain exists would leave the single largest target at its desktop size.
 if (window.matchMedia?.("(pointer: coarse)").matches) {
  applyPreset("balanced");
  S.resolutionScale = 0.7;
 }

 // The other user preference this demo has to honour is asked for in
 // `core/camera.ts` — `prefers-reduced-motion`, which the stylesheet block
 // in index.html already covers for CSS motion but which cannot reach the
 // camera's trauma shake on its own.

 // Kick the audio download off before the device exists and await it at the
 // far end of the boot sequence. It is the only thing here that touches the
 // network, and it has nothing to do with the GPU work that follows — so it
 // runs underneath all of it and is, on any warm cache, long finished by the
 // time anything asks. Not awaited here on purpose; see "loading audio" below.
 const audioReady = audio.load();
 // The intro transmission rides the same reasoning: a megabyte of video
 // fetched to a blob underneath the GPU work, so the boot gate's click
 // plays local bytes instantly. Stub-tolerant — a miss costs the film,
 // not the boot, and the audio-only line takes over.
 // The hosted cut is the ONE source, deliberately: a local copy in
 // `public/video/` used to be tried first and win, which meant a freshly
 // uploaded clip silently lost to a stale file nobody remembered shipping.
 // Only the speeder (player) needs a baked asset now — the walker
 // herd, AT-ST escort and trooper infantry were purged.
 // Only when it is actually going to fly. Off — which is the default — the
 // speeder costs nothing at all: no fetch, no decode, no pipeline.
 // Build-time gate: whether this build includes the ship asset. NOT runtime mode.
 // Runtime mode is the shared `state.flying`, toggled live by toggleMode().
 const FLYING = S.speeder === true;
 // The one flight state, created here and threaded by reference through every
 // module that reads or writes it. Before the module split these were four
 // closure variables in one scope; the split copied their *values* between
 // modules and the copies drifted apart. One object, one writer per field.
 const state = createFlightState(FLYING);
 // `srgbAlbedo` is deliberately *off*.
 //
 // The hull reading dark looked like an sRGB-decoded map being read as linear,
 // and it is not: decoding it moves the mid-tones down and the craft got
 // darker still, when a T-47 is a light grey aircraft. So the maps arrive in
 // the space they are wanted in and something else is eating the value. The
 // option stays because the next model through here may genuinely need it.
 // Latched at boot like S.speeder — the toggle needs a reload to *create* the
 // craft, and only hides it live.
 const speederReady = FLYING ? loadModelAsset("models/speeder") : null;

 await loading.phase("creating device", 0.05);

 // WebGL2 + EXT_color_buffer_float gate lives inside createGfx; it fails the
 // boot screen itself with the precise reason, so a null is just "stop".
 const gfx = createGfx(canvas);
 if (!gfx) return;

 const applyScale = () => gfx.setRenderScale(S.resolutionScale);
 applyScale();
 onChange("resolutionScale", applyScale);
 window.addEventListener("resize", () => gfx.resize());

 installDrawCounter(gfx);
 registerShaders();

 await loading.phase("building scene", 0.12);

 const bootAssets = await buildBootAssets({ gfx, canvas, FLYING, state, speederReady });
 const rig = bootAssets.rig;
 const sky = bootAssets.sky;
 const shadows = bootAssets.shadows;
 const depthPass = bootAssets.depthPass;
 const terrain = bootAssets.terrain;
 const character = bootAssets.character;
 const shipController = bootAssets.shipController;
 const figure = bootAssets.figure;
 const spray = bootAssets.spray;
 const muzzleMarkers = bootAssets.muzzleMarkers;
 const smoke = bootAssets.smoke;
 const speeder = bootAssets.speeder;
 const wingmen = bootAssets.wingmen;
 const wrecks = bootAssets.wrecks;
 const leaveWreck = bootAssets.leaveWreck;
 const showFigure = bootAssets.showFigure;

 const squad = buildSquad({ wingmen, character, terrain, spray, smoke, audio, leaveWreck });
 const pumpBounces = squad.pumpBounces;

 const _vfx = buildVfx({ gfx, sky, shadows, depthPass, terrain, character, shipController, figure, spray, smoke, rig, audio, showFigure, speeder, wingmen, wrecks, leaveWreck, state });
 const collision = _vfx.collision;
 const contact = _vfx.contact;
 const wake = _vfx.wake;
 const spells = _vfx.spells;
 const post = _vfx.post;
 const startFlyover = _vfx.startFlyover;
 const applyModeExtras = _vfx.applyModeExtras;

 const flightMode = buildFlightMode({ speeder, shipController, character, terrain, figure, showFigure, applyModeExtras, state });
 const toggleMode = flightMode.toggleMode;

 // ------------------------------------------------------------ the frame
 /**
  * The explicit render schedule (§4.3). The deform sim pass already ran
  * inside `terrain.update`; from here: cascades → prepass → beauty →
  * post chain. Beauty renders three layers into one target with a single
  * clear — depth persists from the opaques into the blended group.
  */
 const renderFrame = () => {
  gfx.syncTokenCamera(rig.camera);
  shadows.render(gfx);
  depthPass.render(gfx);
  gfx.runPass({
   target: post.sceneColor,
   clearColor: CLEAR_COLOR,
   clearDepth: true,
   layer: gfx.LAYER.SKY,
  });
  gfx.runPass({ target: post.sceneColor, layer: gfx.LAYER.OPAQUE });
  gfx.runPass({ target: post.sceneColor, layer: gfx.LAYER.BLEND });
  post.render(gfx);
 };

 // F2 snapshots the camera, the player and the herd as a paste-able block —
 // wired before the overlay so its "Start location · copy" button can share
 // the exact same capture. See `core/openingShot.js` for what to do with it.
 const captureShot = installShotCapture(rig, character);

 const ui = buildUi({ canvas, rig, character, audio, captureShot });
 const overlay = ui.overlay;
 const fpsMeter = ui.fpsMeter;
 const perfHud = ui.perfHud;
 const touchControls = ui.touchControls;
 const soundButton = ui.soundButton;

 // ------------------------------------------------------------- warm-up
 // Everything that can compile, compiles here — behind the loading screen.
 await loading.phase("compiling pipelines", 0.78);
 shadows.update(rig.camera, sky.sunDir);
 sky.render(rig, 0);
 await terrain.warmUp();
 terrain.update(rig.camera.position, character.position, 0);
 figure.update(0);
 figure.sync(rig.camera.position);
 await figure.warmUp();
 // walkers/herds purged: no sync/warmUp.
 if (speeder) {
  speeder.update(0);
  speeder?.sync(rig.camera.position);
  await speeder.warmUp();
 }
 for (const w of wingmen) await w.warmUp();
 spray.update(0, rig.camera.position);
 await spray.warmUp();
 await wake.warmUp();
 await spells.warmUp(
  character.position.x + 3, character.position.y, character.position.z + 3
 );
 await whenReady(gfx, sky.material, "sky material");
 await depthPass.warmUp();
 post.update(0, 0, rig.distance);
 const passes = post.passes;
 // Sequential, and deliberately not `Promise.all`: `whenReady` polls until a
 // pass's pipeline has been bound, and two passes sharing a device poll far
 // slower under contention than one after another. Nine passes at a few
 // milliseconds each is not worth a scheduler fight on the boot path.
 for (let i = 0; i < passes.length; i++) {
  await whenReady(gfx, passes[i], "post:" + passes[i].name);
 }

 // The one-draw effect systems compile here too — an eye band or a smoke
 // puff whose shader compiles on its first visible frame is a hitch in the
 // opening seconds, which reads as the speeder stuttering.
 await whenReady(gfx, smoke.material, "smoke material");

 await loading.phase("warming render targets", 0.92);
 // A few real frames so every render target is allocated and every pipeline
 // has actually been bound at least once. Sequential on purpose, and not
 // batchable: each frame has to *complete* before the next begins, because
 // the render targets one frame allocates are the ones the next frame reads,
 // and the spell meshes had to be standing through them for their render
 // pipelines to exist.
 for (let i = 0; i < 3; i++) {
  renderFrame();
  await loading.nextFrame();
 }
 // Only now: the spell meshes had to be standing *through* those frames for
 // their render pipelines to exist. See `WaterBody.warmUp`.
 spells.finishWarmUp();

 // ------------------------------------------------------------- run loop
 // Seeded *here*, before the menu gate below is awaited: the first frame's
 // delta is measured from this instant, so the wait for the player to pick a
 // mode counts as the first frame's elapsed time (clamped to 100 ms). Moving
 // the seed into the loop would silently change that first frame's step.
 let prev = performance.now();
 let time = 0;

 // ------------------------------------------------------- main menu gate
 // The choice is written onto the shared state; the loop below reads it live.
 await chooseMode({ character, leaveWreck, speeder, applyModeExtras, showFigure, state });

 startFrameLoop({
  gfx, rig, sky, shadows, terrain, character, figure, contact, wrecks, wingmen, speeder, shipController, collision, spells, smoke, wake, spray, muzzleMarkers, overlay, fpsMeter, perfHud, post, toggleMode, renderFrame, pumpBounces,
  state, prev, time,
 });

 // ------------------------------------------------------- audio + the gate
 // Normally already resolved: the download has been running since before the
 // device existed. This phase only shows up on a cold cache or a slow line.
 await loading.phase("loading audio", 0.96);
 await audioReady;
 // A missing asset is non-fatal by design — one dead sample must not take the
 // other forty — so `load()` resolves regardless and the affected key simply
 // never plays. The engine records each in `failed`; say it out loud here,
 // before the game starts, rather than letting the game run quiet-by-omission.
 if (audio.failed.size) {
  console.error(
   "[audio] " + audio.failed.size + " asset(s) failed to load and are silent:",
   [...audio.failed]
  );
 }
 // The second transmission is fetched behind the boot with everything
 // else, so the moment it is called for it plays local bytes — a clip that
 // buffered mid-battle would arrive after the moment that earned it.

 // One click to enter, and that click is also the gesture that makes sound
 // legal. `unlock()` is issued from inside the handler — hence the callback —
 // and awaited here, so the context is resumed before the boot screen starts
 // to fade. Skipped entirely if nothing decoded: a button whose only job is
 // to start audio has none when there is no audio.
 //
 // Native TS annotation rather than JSDoc: `unlock()` is assigned inside the
 // gate callback closure, so control-flow analysis never widens the binding
 // and a `/** @type */` line above `let unlocking = null` is left dangling —
 // tsc then infers literal `null`, which makes the guard below dead code.
 let unlocking: Promise<boolean> | null = null;
 if (audio.hasAssets) {
  await loading.gate(() => {
   unlocking = audio.unlock();
  });
 }
 if (unlocking) {
  await unlocking;
 }
 soundButton.sync();

 // The instant the player is coming in — boot screen starting its fade —
 // stage the formation behind them, so the escorts thunder overhead in the
 // first seconds of the game rather than at some point during the loading.
 // Eliminate initial no-controls sequence in free flight mode only.
 if (state.storyMode) startFlyover();

 // After the loading screen has gone: it sits at a higher z-index than the
 // overlay, so opening the panel before this would hide it behind a full
 // screen of boot gradient.
 await loading.done();
 if (S.overlayOpen && !overlay.visible) overlay.toggle();
 soundButton.reveal();
 setTimeout(() => overlay.resetSpikes(), 800);

 const snowflowGlobal = window;
 snowflowGlobal.SNOWFLOW = {
  gfx, scene: gfx.scene, rig, character, figure, wrecks, speeder, collision, contact, spray, wake, spells,
  overlay, touchControls, terrain, sky, shadows, post, depthPass,
  audio,
  S, input, perfStats: stats,
  captureShot,
  /** Fake a cannon burst at (x, z) — for testing the squad's reactions. */
  // Inert purge remnant: never assigned, so a call throws exactly as it
  // would have without the `| undefined` on the binding above. `?.` here
  // would turn that TypeError into a silent no-op.
  squadImpact: (x: number, z: number) => squadImpact!(x, 0, z),
  /**
   * Print the speeder's look settings as a paste-able block.
   *
   * These four are dialled by eye against a moving craft over bright snow,
   * which is not a thing that can be solved on paper — so the loop is drag,
   * look, and read the numbers back out. Logged as source rather than as an
   * object so the answer can go straight into `settings.js`.
   */
  speederTuning() {
   const keys = ["speederFill", "speederTint", "speederRough", "speederAmbient",
    "speederDesat", "jetSpan", "jetDropY", "jetBackZ",
    "jetWidth", "jetLength", "jetFlare",
    "jetGlow", "jetHaloBack",
    "boltR", "boltG", "boltB", "boltWidth", "boltLength", "boltSpeed",
    "boltRange", "muzzleSpan", "muzzleDropY", "muzzleFwdZ",
    "speederClimbMax", "speederClimbRate",
    "surfWidth", "speederStreak",
    // The feel layer, so a session spent dragging the "Speeder
    // feel" sliders reads back out the same way the look does.
    "cinematicCam", "camYawLag", "speederBankLead",
    "speederTurbulence", "camBoostBreath"];
   const w = Math.max(...keys.map((k) => k.length));
   // The keys are literal names of settings this file does not otherwise
   // reference, so `S` cannot be indexed by a plain `string` — every one of
   // them exists on it, and the read is one-to-one with the list above.
   const readSetting = (k: string): SettingValue => S[k as keyof typeof S];
   const body = keys
    .map((k) => `    ${k}:${" ".repeat(w - k.length)} ${readSetting(k)},`)
    .join("\n");
   console.log("// speeder look — tuned\n" + body);
   return Object.fromEntries(keys.map((k) => [k, readSetting(k)]));
  },
 };
}