import { S, onChange } from "./core/settings.js";
import { CameraRig } from "./core/camera.js";
import { CharacterController } from "./character/controller.js";
import { Character } from "./character/character.js";
import { SprayField } from "./vfx/particles.js";
import { MuzzleMarkers } from "./vfx/muzzleMarkers.js";
import { SmokeTrails } from "./vfx/smokeTrails.js";
import { Sky } from "./render/sky.js";
import { ShadowSystem } from "./render/shadows.js";
import { Terrain } from "./terrain/terrain.js";
import { DepthPass } from "./render/depthPass.js";
import { Speeder } from "./player/speeder.js";
import type { Gfx } from "./core/gfx.js";
import type { ModelAsset } from "./walkers/modelAsset.js";
import type { FlightState } from "./mainContracts.js";
import * as loading from "./core/loading.js";

export type BuildBootAssetsContext = {
 gfx: Gfx;
 canvas: HTMLCanvasElement;
 FLYING: boolean;
 state: FlightState;
 speederReady: Promise<ModelAsset> | null;
};

export type BootAssets = {
 rig: CameraRig;
 sky: Sky;
 shadows: ShadowSystem;
 depthPass: DepthPass;
 terrain: Terrain;
 character: CharacterController;
 shipController: CharacterController | null;
 figure: Character;
 spray: SprayField;
 muzzleMarkers: MuzzleMarkers;
 smoke: SmokeTrails;
 speeder: Speeder | null;
};

export async function buildBootAssets(ctx: BuildBootAssetsContext): Promise<BootAssets> {
 const { gfx, canvas, FLYING, speederReady } = ctx;

 const rig = new CameraRig(gfx, canvas);

 await loading.phase("integrating atmosphere", 0.2);
 const sky = new Sky(gfx);
 await sky.solve();

 const shadows = new ShadowSystem(gfx);

 const depthPass = new DepthPass(gfx);

 await loading.phase("baking heightfield", 0.34);
 const terrain = new Terrain(gfx, sky, shadows);
 await terrain.build();
 onChange("showTerrain", (v) => {
  if (terrain.mesh) terrain.mesh.visible = v === true;
 });
 depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial());

 await loading.phase("placing character", 0.62);

 const character = new CharacterController(terrain);
 character.position.set(0, 0, 0);
 character.position.y = terrain.heightAt(0, 0);
 if (S.speeder === true) rig.yaw = character.facing;

 const shipController = S.speeder === true ? new CharacterController(terrain) : null;
 if (shipController) {
  shipController.position.copy(character.position);
  shipController.facing = character.facing;
  shipController._climb = S.speeder !== false ? Math.max(0, S.speederClimbMax || 0) : 0;
  shipController._climbWant = shipController._climb;
  shipController._vertEase = 0;
  shipController._cruiseGround = NaN;
  shipController.position.y += shipController._climb;
 }

 const figure = new Character(gfx, terrain, sky, shadows, character);
 figure.registerPrepass(depthPass);
 onChange("showCharacter", () => figure.setVisible(S.showCharacter !== false && !ctx.state.flying));

 const spray = new SprayField(gfx, terrain, sky, shadows);
 const muzzleMarkers = new MuzzleMarkers(gfx);
 muzzleMarkers.bindCamera(rig.camera.viewProjection);
 const smoke = new SmokeTrails(gfx);
 smoke.bindCamera(rig.camera.viewProjection);

 let speeder: Speeder | null = null;
 if (FLYING && speederReady !== null && shipController) {
  const asset = await speederReady;
  speeder = new Speeder(gfx, terrain, sky, shadows, asset, shipController, spray);
 }
 speeder?.registerPrepass(depthPass);

 return {
  rig, sky, shadows, depthPass, terrain, character, shipController,
  figure, spray, muzzleMarkers, smoke, speeder,
 };
}