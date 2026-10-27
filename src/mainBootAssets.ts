import * as THREE from "three";
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
import type { Wingman, Wreck } from "./mainContracts.js";
import {
 WRECK_CLIMB, WRECK_LEAN,
 PILOT_TOSS_BASE, PILOT_TOSS_SPREAD, PILOT_THROW_BASE, PILOT_THROW_SPREAD,
} from "./mainContracts.js";
import * as loading from "./core/loading.js";

export type BuildBootAssetsContext = {
 gfx: Gfx;
 canvas: HTMLCanvasElement;
 FLYING: boolean;
 flying: boolean;
 /** Live flight state, so `showFigure` follows later mode changes. */
 isFlying: () => boolean;
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
 wingmen: Wingman[];
 wrecks: Wreck[];
 leaveWreck: ((x: number, z: number, facing: number) => null) | null;
 showFigure: () => void;
};

export async function buildBootAssets(ctx: BuildBootAssetsContext): Promise<BootAssets> {
 const { gfx, canvas, FLYING, speederReady } = ctx;

 const rig = new CameraRig(gfx, canvas);

 // ------------------------------------------------------------------ sky
 await loading.phase("integrating atmosphere", 0.2);
 const sky = new Sky(gfx);
 await sky.solve();

 // -------------------------------------------------------------- shadows
 const shadows = new ShadowSystem(gfx);

 // The camera-space depth prepass. Babylon scheduled it by registration
 // order; here the schedule is the explicit pass list in `renderFrame`.
 const depthPass = new DepthPass(gfx);

 // -------------------------------------------------------------- terrain
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
 // Flying, the arm is a chase camera and A/D drags it round with the nose —
 // so it has to *start* behind the nose. The figure's opening bearing is a
 // composition (it frames the walkers); a craft's is simply where it points.
 if (S.speeder === true) rig.yaw = character.facing;

 /** @type {CharacterController|null} */
 const shipController = S.speeder === true ? new CharacterController(terrain) : null;
 if (shipController) {
  shipController.position.copy(character.position);
  shipController.facing = character.facing;
 }

 // The figure: skeleton, garment simulation, shell fur. Hidden while the
 // player is flying — it is still simulated, because the speeder reads the
 // same controller and the cloth solve costs a fraction of a millisecond, but
 // nothing draws it.
 const figure = new Character(gfx, terrain, sky, shadows, character);
 figure.registerPrepass(depthPass);
 const showFigure = () => figure.setVisible(S.showCharacter !== false && !ctx.isFlying());
 onChange("showCharacter", showFigure);

 // Airborne snow: footfall kick now, the surf plume and spell spray later.
 const spray = new SprayField(gfx, terrain, sky, shadows);
 // Tuning rings on the gun heads, live under the overlay's muzzle sliders.
 const muzzleMarkers = new MuzzleMarkers(gfx);
 muzzleMarkers.bindCamera(rig.camera.viewProjection);
 // Damage smoke and fire off wounded craft — the wingmen's ladder.
 const smoke = new SmokeTrails(gfx);
 smoke.bindCamera(rig.camera.viewProjection);

 // ------------------------------------------------------------ the speeder
 /** @type {Speeder|null} */
 let speeder: Speeder | null = null;
 // `loadModelAsset` throws on a bad file rather than resolving null, so the
 // null arm of the ternary is a construction artifact: the promise exists
 // exactly when the build has a ship, and so does the controller that is
 // constructed beside it. Narrowing on those two values is what states the
 // invariant to the compiler — an `if (FLYING)` guard cannot, because `FLYING`
 // is a plain boolean and carries no type information.
 if (FLYING && speederReady !== null && shipController) {
  const asset = await speederReady;
  speeder = new Speeder(gfx, terrain, sky, shadows, asset, shipController, spray);
 }
 speeder?.registerPrepass(depthPass);

 /**
  * The escorts. The escort module was removed with the walker herd, so
  * nothing populates this and it is always empty at runtime — but it is
  * retained, because the collision pass and the presentation loop are
  * written against a *list* of other craft (the wingman is one of n, not
  * a singleton) and rewriting them to drop the loop is the very code loss
  * this file has already suffered twice.
  * @type {Wingman[]}
 */
 const wingmen: Wingman[] = [];
 // Where a cannon bolt lands, the infantry reacts — the player's guns report
 // through this handler. Three rings around the burst:
 //
 //   < 1.7 m   a hit. One of the three deaths, held on its final frame; the
 //             body lies in the snow a while, then the herd recycles it
 //             back in at its squad's station like any other re-entry.
 //   < 6 m     a near miss. The trooper dives *away* from the burst —
 //             jumpLeft for an impact on his right, jumpRight for his
 //             left — then the get-up, then the walk again.
 //   < 9 m     close enough to flinch.
 //
 // The get-up starts five and a half seconds in: Mixamo's clip spends its
 // first act lying still and rolling over, and a soldier who dove clear of
 // a shellburst stirs and rises rather than napping through the battle.
 // Walkers purged: no AT-AT/AT-ST bolt chains remain.

 let wrecks: Wreck[] = [];
 let leaveWreck: ((x: number, z: number, facing: number) => null) | null = null;
 // Same narrowing as the speeder above: the promise, not the `FLYING` flag, is
 // what tells the compiler the awaited asset is a value rather than a null.
 if (FLYING && speederReady !== null) {
  const speederAsset2 = await speederReady;
  wrecks = [];
  const ctl = {
   position: new THREE.Vector3(0, -500, 0),
   velocity: new THREE.Vector3(),
   facing: 0, lean: WRECK_LEAN, steerRate: 0,
   speed01: 0, speedRaw: 0,
   climb: WRECK_CLIMB, lift01: 0, pathY: 0, groundY: 0,
   driveHeld: false, boostHeld: false, fireHeld: false,
  };
  const hull = new Speeder(gfx, terrain, sky, shadows, speederAsset2, ctl, null);
  hull.grounded = true;
  hull.registerPrepass(depthPass);
  hull.setVisible(false);
  wrecks.push({
   hull, ctl, active: false, burnT: 0, age: 0, smokeT: 0,
   pilotX: 0, pilotZ: 0,
  });
  leaveWreck = (x: number, z: number, facing: number) => {
   const wk = wrecks[0];
   if (!wk) return null;
   wk.active = true; wk.burnT = 32; wk.age = 0; wk.smokeT = 0;
   wk.ctl.position.set(x, 0, z); wk.ctl.facing = facing;
   wk.ctl.lean = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.15);
   wk.ctl.groundY = terrain.heightAt(x, z); wk.ctl.pathY = wk.ctl.groundY;
   wk.hull.snowOverride = 0; wk.hull.setVisible(true);
   const side = facing + (Math.random() < 0.5 ? 1 : -1) * (PILOT_TOSS_BASE + Math.random() * PILOT_TOSS_SPREAD);
   const throwOut = PILOT_THROW_BASE + Math.random() * PILOT_THROW_SPREAD;
   wk.pilotX = x + Math.sin(side) * throwOut;
   wk.pilotZ = z + Math.cos(side) * throwOut;
   return null;
  };
 }

 return {
  rig, sky, shadows, depthPass, terrain, character, shipController,
  figure, spray, muzzleMarkers, smoke, speeder, wingmen, wrecks, leaveWreck,
  showFigure,
 };
}
