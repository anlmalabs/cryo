import { initInput } from "./core/input.js";
import { CameraRig } from "./core/camera.js";
import { CharacterController } from "./character/controller.js";
import { Overlay } from "./ui/overlay.js";
import { createFpsMeter, type FpsMeter } from "./ui/fpsMeter.js";
import { createPerfHud, type PerfHud } from "./ui/perfHud.js";
import { createSoundButton, type SoundButton } from "./ui/soundButton.js";
import { createTouchControls, type TouchControls } from "./ui/touchControls.js";
import type { AudioEngine } from "./audio/engine.js";
import type { Speeder } from "./player/speeder.js";
import type { FlightState } from "./mainContracts.js";

export type BuildUiContext = {
 canvas: HTMLCanvasElement;
 rig: CameraRig;
 character: CharacterController;
 audio: AudioEngine;
 captureShot: () => string;
};

export type UiState = {
 overlay: Overlay;
 fpsMeter: FpsMeter;
 perfHud: PerfHud;
 touchControls: TouchControls;
 soundButton: SoundButton;
};

export type ChooseModeContext = {
 character: CharacterController;
 leaveWreck: ((x: number, z: number, facing: number) => null) | null;
 speeder: Speeder | null;
 applyModeExtras: () => void;
 showFigure: () => void;
 /** The one shared flight state; the choice writes `storyMode` and `flying` on it. */
 state: FlightState;
};

export function buildUi(ctx: BuildUiContext): UiState {
 const { canvas, rig, character, audio: audioEngine, captureShot } = ctx;

 const overlay = new Overlay({ rig, character, actions: { captureShot } });
 const toggleOverlay = () => overlay.toggle();
 // The same two numbers the overlay carries, on their own, for when the panel
 // would cover the thing being measured.
 const fpsMeter = createFpsMeter();
 const perfHud = createPerfHud();
 initInput(canvas, {
  onToggleOverlay: toggleOverlay,
  onToggleFps: () => fpsMeter.toggle(),
 });
 // Builds hidden and reveals itself on the first real touch, so a desktop with
 // a touchscreen never sees it. Everything it produces goes into the same
 // `input` struct the keyboard writes.
 const touchControls = createTouchControls({ onToggleOverlay: toggleOverlay });

 // The soundscape reads game state; nothing in the game knows it exists. It
 // stays silent until `start()`, which only happens on the gesture that
 // unlocks the engine — the boot gate below, or the corner button later.
 const soundButton = createSoundButton(audioEngine);
 // Mobile belt: some engines refuse an AudioContext resume that did not
 // ride a touch gesture, and a phone that entered through the gate without
 // sound would stay silent for ever. Any later touch retries the unlock;
 // once it lands, the listener has nothing left to do.
 window.addEventListener("pointerdown", () => {
  if (audioEngine.hasAssets && !audioEngine.unlocked) {
   audioEngine.unlock().then((ok) => {
    if (ok) {
     soundButton.sync();
    }
   });
  }
 }, { passive: true });

 return { overlay, fpsMeter, perfHud, touchControls, soundButton };
}

/**
 * Main-menu gate.
 *
 * The choice is written onto the shared flight state rather than returned:
 * `storyMode` is read by the crash-restart handler and by the boot's own
 * flyover decision, both of which run after this resolves, and a returned
 * copy was exactly the kind of value-copy that let the modules drift apart.
 */
export async function chooseMode(ctx: ChooseModeContext): Promise<void> {
 const { character, leaveWreck, speeder, applyModeExtras, showFigure, state } = ctx;

 await new Promise<void>((resolve) => {
  const menu = document.createElement("div");
  menu.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:radial-gradient(ellipse at 30% 20%,rgba(40,70,140,0.35),transparent 60%),radial-gradient(ellipse at 70% 80%,rgba(80,40,120,0.25),transparent 60%),rgba(4,6,14,0.92);color:#dfe6f5;font-family:ui-monospace,monospace;";
  const title = document.createElement("div");
  title.textContent = "SNOWFLOW";
  title.style.cssText = "font-size:1.6rem;letter-spacing:0.35em;text-transform:uppercase;font-weight:300;margin-bottom:4px;";
  const sub = document.createElement("div");
  sub.textContent = "S — story mode (ship stranded, repair to fly)    ·    Enter — free flight";
  sub.style.cssText = "font-size:0.72rem;letter-spacing:0.18em;text-transform:uppercase;opacity:0.6;margin-bottom:18px;";
  const btnStyle = "min-width:220px;padding:10px 20px;font-size:0.8rem;letter-spacing:0.2em;text-transform:uppercase;cursor:pointer;background:rgba(255,255,255,0.04);color:#dfe6f5;border:1px solid rgba(255,255,255,0.18);border-radius:2px;transition:background .15s,border-color .15s;";
  const storyBtn = document.createElement("button");
  storyBtn.textContent = "Story Mode  (S)";
  storyBtn.style.cssText = btnStyle;
  const flyBtn = document.createElement("button");
  flyBtn.textContent = "Free Flight  (Enter)";
  flyBtn.style.cssText = btnStyle;
  for (const b of [storyBtn, flyBtn]) {
   b.addEventListener("mouseenter", () => { b.style.background = "rgba(255,255,255,0.1)"; b.style.borderColor = "rgba(255,255,255,0.4)"; });
   b.addEventListener("mouseleave", () => { b.style.background = "rgba(255,255,255,0.04)"; b.style.borderColor = "rgba(255,255,255,0.18)"; });
  }
  menu.append(title, sub, storyBtn, flyBtn);
  document.body.append(menu);
  // (menu already appended above)

  let chosen = false;
  const choose = (story: boolean) => {
   if (chosen) return;
   chosen = true;
   menu.remove();
   window.removeEventListener("keydown", onKey);
   // The shared state is written here, before the promise resolves, so the
   // rest of the boot sees the mode the menu settled on.
   state.storyMode = story;
   resolve();
  };
  const onKey = (e: KeyboardEvent) => {
   if (e.code === "KeyS") choose(true);
   else if (e.code === "Enter") choose(false);
  };
  window.addEventListener("keydown", onKey);
  storyBtn.addEventListener("click", () => choose(true));
  flyBtn.addEventListener("click", () => choose(false));
 });

 if (state.storyMode) {
  const x = character.position.x, z = character.position.z, f = character.facing;
  leaveWreck?.(x, z, f);
  state.flying = false;
  speeder?.setVisible?.(false);
  applyModeExtras();
  showFigure();
 }
}
