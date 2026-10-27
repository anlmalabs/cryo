/**
 * SNOWFLOW — entry point and frame orchestration.
 *
 * WebGL2 only, by design (this build; the original was WebGPU-only). Three.js
 * is a rasterizer here — no feature-detect branches: if the context or the
 * float render targets aren't there we say so once and stop.
 */

import * as THREE from "three";

import { registerShaders } from "./shaders/registry.js";
import { S, onChange, applyPreset, type SettingValue } from "./core/settings.js";
import {
 sample, checkSpike, stats, mark, installDrawCounter, endFrameDraws,
} from "./core/perf.js";
import { initInput, pollInput, endFrame, input, isDown } from "./core/input.js";
import { CameraRig, expDamp } from "./core/camera.js";
import { createGfx } from "./core/gfx.js";
import { CharacterController } from "./character/controller.js";
import { Character } from "./character/character.js";
import { SnowContact } from "./character/snowContact.js";
import { SprayField } from "./vfx/particles.js";

import { MuzzleMarkers } from "./vfx/muzzleMarkers.js";
import { SmokeTrails } from "./vfx/smokeTrails.js";
import { SurfWake } from "./vfx/surfWake.js";
import { SpellSystem } from "./spells/spellSystem.js";
import { Speeder } from "./player/speeder.js";
import { CollisionPass, emitBurnTrail } from "./physics/collisionPass.js";
import { Overlay } from "./ui/overlay.js";
import { createFpsMeter } from "./ui/fpsMeter.js";
import { createPerfHud } from "./ui/perfHud.js";
import { Sky } from "./render/sky.js";
import { ShadowSystem } from "./render/shadows.js";
import { Terrain } from "./terrain/terrain.js";
import { DepthPass } from "./render/depthPass.js";
import { PostChain } from "./post/postChain.js";
import { whenReady } from "./core/gpuUtil.js";
import * as loading from "./core/loading.js";
import { audio } from "./audio/engine.js";
import { createSoundButton } from "./ui/soundButton.js";
import { createTouchControls } from "./ui/touchControls.js";
import { OPENING, applyOpening, installShotCapture } from "./core/openingShot.js";
import { loadModelAsset } from "./walkers/modelAsset.js";

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

import { Wingman, EnemyFire, WreckController, Wreck, squadImpact, _vel, _camAt, CLEAR_COLOR, CRASH_AUDIBLE, DEATH_CAM_RATE, DEATH_CAM_DIST, DEATH_CAM_DIST_PILOT, RESPAWN_OUT, DEATH_CAM_PITCH, DEATH_CAM_PITCH_PILOT, WRECK_CLIMB, WRECK_LEAN, PILOT_TOSS_BASE, PILOT_TOSS_SPREAD, PILOT_THROW_BASE, PILOT_THROW_SPREAD, SKIP_SPLASH_SWAY, SKIP_PUFF_SWAY, CRASH_UP_MIN, CRASH_UP_SPREAD, SKIP_UP_MIN, SKIP_UP_SPREAD, CRASH_LIFE_MIN, CRASH_LIFE_SPREAD, SKIP_LIFE_MIN, SKIP_LIFE_SPREAD, SKIP_RADIUS, CRASH_RADIUS, PLUME_BASE_Y, CRASH_RING_MIN, CRASH_RING_SPREAD, SKIP_RING_MIN, SKIP_RING_SPREAD, RING_HEIGHT, RING_LIFT_MIN, RING_LIFT_SPREAD, SKIP_RING_RADIUS, CRASH_RING_RADIUS, CRASH_RING_LIFE_MIN, CRASH_RING_LIFE_SPREAD, SKIP_RING_LIFE_MIN, SKIP_RING_LIFE_SPREAD, SKIP_PUFF_GREY, SKIP_PUFF_LIFE, SKIP_PUFF_LIFE_SPREAD, CRASH_CLOUD_Y, CRASH_CLOUD_RADIUS } from "./mainContracts.js";

import { boot } from "./mainInit.js";

boot().catch((err) => {
 console.error(err);
 loading.fail("Startup failed — see console.");
});
