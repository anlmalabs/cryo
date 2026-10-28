import { S } from "./core/settings.js";
import type { CharacterController } from "./character/controller.js";
import type { Character } from "./character/character.js";
import type { Terrain } from "./terrain/terrain.js";
import type { Speeder } from "./player/speeder.js";
import type { FlightState } from "./mainContracts.js";

export type BuildFlightModeContext = {
 speeder: Speeder | null;
 shipController: CharacterController | null;
 character: CharacterController;
 terrain: Terrain;
 figure: Character;
 showFigure: () => void;
 applyModeExtras: () => void;
 /** The one shared flight state; the toggle writes `flying` on it. */
 state: FlightState;
};

export type FlightModeState = {
 toggleMode: () => void;
};

export function buildFlightMode(ctx: BuildFlightModeContext): FlightModeState {
 const { speeder, shipController, character, terrain, figure, showFigure, applyModeExtras } = ctx;

 const toggleMode = () => {
  if (!speeder || !shipController) return;
  if (ctx.state.flying) {
   character.position.copy(shipController.position);
   character.facing = shipController.facing;
   terrain.heightfield.clampToPlayArea(character.position);
   terrain.heightfield.clampToPlayArea(shipController.position);
   ctx.state.flying = false;
   speeder.setVisible(true);
   speeder.grounded = false;
   showFigure();
   // Ground the figure at the surface instead of hover height.
   character.position.y = terrain.heightAt(character.position.x, character.position.z);
   character.groundY = character.position.y;
   character.velocity.y = 0;
   // Restore walk gait state; ship velocity is too high for stepping.
   character.surf = 0;
   character.surfActive = false;
   character.stepping = true;
   character.gaitPhase = 0;
   character.velocity.set(0, 0, 0);
   character.speed = 0; character.speed01 = 0; character.speedRaw = 0;
   character.lean = 0; character.streak01 = 0; character.carve = 0;
   character.crashing = false; character.crashLanded = false; character.crashDown = false;
   character.terrainSlam = null;
   character.cast = 0; character.castAimX = 0; character.castAimY = 0; character.castAimZ = 0;
   character.pathY = 0; character.lift01 = 0; character.impactSpin = 0;
   character.acceleration.set(0, 0, 0);
   character.footfall = false; character.footImpact = 0;
  } else {
   shipController.position.copy(character.position);
   shipController.velocity.copy(character.velocity);
   shipController.facing = character.facing;
   shipController.surf = 0;
   shipController.surfActive = false;
   shipController.stepping = true;
   shipController.gaitPhase = 0;
   shipController.cast = 0;
   shipController.impactSpin = 0;
   shipController._prevSpeed = 0;
   shipController._drive = 0;
   shipController._boost = 1;
   shipController._climb = S.speeder !== false ? Math.max(0, S.speederClimbMax || 0) : 0;
   shipController._climbWant = shipController._climb;
   shipController._vertEase = 0;
   shipController.climbRate = 0;
   shipController._cruiseGround = NaN;
   shipController.steer = 0;
   shipController.steerRate = 0;
   shipController.controlScramble = 0;
   shipController._scrambleMax = 0;
   shipController._scrambleT = 0;
   shipController.fireHeld = undefined;
   shipController.driveHeld = undefined;
   shipController.boostHeld = undefined;
   shipController._prevTargetY = NaN;
   shipController._slam = { closing: 0, nx: 0, nz: 0 };
   shipController.speed = 0;
   shipController.carve = 0;
   shipController.terrainSlam = null;
   terrain.heightfield.clampToPlayArea(shipController.position);
   terrain.heightfield.clampToPlayArea(character.position);
   ctx.state.flying = true;
   speeder.setVisible(true);
   figure.setVisible(false);
  }
  applyModeExtras();
 };

 return { toggleMode };
}
