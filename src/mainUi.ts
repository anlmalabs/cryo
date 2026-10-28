import { initInput } from "./core/input.js";
import { CameraRig } from "./core/camera.js";
import { CharacterController } from "./character/controller.js";
import { Overlay } from "./ui/overlay.js";
import { createFpsMeter, type FpsMeter } from "./ui/fpsMeter.js";
import { createPerfHud, type PerfHud } from "./ui/perfHud.js";
import { createSoundButton, type SoundButton } from "./ui/soundButton.js";
import { createTouchControls, type TouchControls } from "./ui/touchControls.js";
import type { AudioEngine } from "./audio/engine.js";

export type BuildUiContext = {
 canvas: HTMLCanvasElement;
 rig: CameraRig;
 character: CharacterController;
 audio: AudioEngine;
};

export type UiState = {
 overlay: Overlay;
 fpsMeter: FpsMeter;
 perfHud: PerfHud;
 touchControls: TouchControls;
 soundButton: SoundButton;
};


export function buildUi(ctx: BuildUiContext): UiState {
 const { canvas, rig, character, audio: audioEngine } = ctx;

 const overlay = new Overlay({ rig, character, actions: {} });
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
