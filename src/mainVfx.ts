import { S, onChange } from "./core/settings.js";
import { input } from "./core/input.js";
import { CollisionPass } from "./physics/collisionPass.js";
import { SnowContact } from "./character/snowContact.js";
import { SurfWake } from "./vfx/surfWake.js";
import { SpellSystem } from "./spells/spellSystem.js";
import { PostChain } from "./post/postChain.js";
import { OPENING, applyOpening } from "./core/openingShot.js";
import { RESPAWN_OUT } from "./mainContracts.js";
import type { FlightState, Wingman, Wreck } from "./mainContracts.js";
import type { Gfx } from "./core/gfx.js";
import type { CameraRig } from "./core/camera.js";
import type { Sky } from "./render/sky.js";
import type { ShadowSystem } from "./render/shadows.js";
import type { DepthPass } from "./render/depthPass.js";
import type { Terrain } from "./terrain/terrain.js";
import type { CharacterController } from "./character/controller.js";
import type { Character } from "./character/character.js";
import type { SprayField } from "./vfx/particles.js";
import type { SmokeTrails } from "./vfx/smokeTrails.js";
import type { Speeder } from "./player/speeder.js";
import type { AudioEngine } from "./audio/engine.js";

/**
 * Everything `buildVfx` needs from the boot.
 *
 * The context was an untyped bag once, and the boot crash came straight out of
 * that: a field the module read was never handed to it, and nothing said so
 * until the first frame. The bag is gone — every field is named, typed and
 * required, so a missing one is a compile error.
 */
export type VfxContext = {
 gfx: Gfx;
 sky: Sky;
 shadows: ShadowSystem;
 depthPass: DepthPass;
 terrain: Terrain;
 character: CharacterController;
 shipController: CharacterController | null;
 figure: Character;
 spray: SprayField;
 smoke: SmokeTrails;
 rig: CameraRig;
 audio: AudioEngine;
 showFigure: () => void;
 speeder: Speeder | null;
 wingmen: Wingman[];
 wrecks: Wreck[];
 leaveWreck: ((x: number, z: number, facing: number) => null) | null;
 /** The one shared flight state; read and written live, never copied. */
 state: FlightState;
};

/** What `buildVfx` hands back: the systems it built and the two mode hooks. */
export type VfxState = {
 collision: CollisionPass;
 contact: SnowContact;
 wake: SurfWake;
 spells: SpellSystem;
 post: PostChain;
 startFlyover: () => void;
 applyModeExtras: () => void;
};

export function buildVfx(ctx: VfxContext): VfxState {
 const gfx = ctx.gfx, sky = ctx.sky, shadows = ctx.shadows, depthPass = ctx.depthPass;
 const terrain = ctx.terrain, character = ctx.character, shipController = ctx.shipController;
 const figure = ctx.figure, spray = ctx.spray, smoke = ctx.smoke;
 const rig = ctx.rig, audio = ctx.audio;
 const showFigure = ctx.showFigure, speeder = ctx.speeder, wingmen = ctx.wingmen;
 const wrecks = ctx.wrecks;
 const state = ctx.state;
 const leaveWreck = ctx.leaveWreck;
 // ------------------------------------------------------------ collisions
 // The craft meet the machines: swept spheres against the walkers' capsule
 // sets, the wrecks and each other, with the consequences routed to their
 // owners — deflection and scramble to the craft, a stumble to the walker,
 // snow, smoke, fire and the report to the field. Gated live by
 // S.collisions; every collaborator is optional, so a boot without a
 // speeder or without wingmen runs the parts it has.
 const collision = new CollisionPass({
  activeCharacter: () => (state.flying && shipController) ? shipController : character,
  speeder, wingmen,
  wrecks, terrain, spray, smoke, rig, audio,
  parked: () => {
   if (state.flying || !speeder) return null;
   if (wrecks.length && wrecks[0]?.active) return null;
   const dx = character.position.x - speeder.position.x;
   const dz = character.position.z - speeder.position.z;
   if (dx * dx + dz * dz < 3.5 * 3.5) return null;
   return speeder.position;
  },
  // Where the player's own crash ends up, and what happens after it.
  // Back in the air where the fight is, and state.flying immediately.
  //
  // Dying mid-battle is not the same event as arriving at one: the player's
  // own craft is staged back down the approach, not teleported into an echelon.
  // already making way, with control.
  onRestart: () => {
   if (S.speeder !== true) return;
   if (!state.storyMode) {
    // Free flight: back in the air where the fight is.
    const bx = character.position.x;
    const bz = character.position.z;
    const h = 0;
    const sc = shipController || character;
    sc.position.x = bx - Math.sin(h) * RESPAWN_OUT;
    sc.position.z = bz - Math.cos(h) * RESPAWN_OUT;
    sc.facing = h;
    sc.velocity.set(Math.sin(h) * 24, 0, Math.cos(h) * 24);
    character.position.copy(sc.position);
    character.facing = sc.facing;
    character.velocity.copy(sc.velocity);
    input.riseLevel = 3;
    state.flying = true;
    speeder?.setVisible?.(true);
    figure.setVisible(false);
    applyModeExtras();
    return;
   }
   // Story mode: strand the ship into the wreck and continue on foot.
   leaveWreck?.(character.position.x, character.position.z, character.facing);
   state.flying = false;
   speeder?.setVisible?.(false);
   character.position.y = terrain.heightAt(character.position.x, character.position.z);
   character.groundY = character.position.y;
   character.velocity.set(0, 0, 0);
   character.crashing = false; character.crashLanded = false; character.crashDown = false;
   applyModeExtras();
   showFigure();
  },
 });

 // The collision pass is told what is solid: the player's craft, the parked
 // hull, and the wreck graveyard. Every collaborator is optional, so a boot
 // without a speeder still runs the parts it has.

 speeder?.setVisible(true);
 showFigure();

 // Walkers purged: no herd spray/footfall wiring.

 // Feet and the surf groove write into the terrain state buffer through here.
 const contact = new SnowContact(character, terrain.deform, figure.figure, spray);

 // The breaking wave, its bow crest and the plume it sheds.
 const wake = new SurfWake(gfx, sky, shadows, character, spray, terrain);
 onChange("showWake", (v) => wake.setEnabled(v));
 wake.registerPrepass(depthPass);

 // The five spells, the water body they bend and the ice they leave.
 // Flying hides the whole snowboarding half of the demo: the spells are cast
 // by a figure that is not there, and the surf wake is thrown by a board.
 /** The figure's half of the demo is inert while the player is in the ship. */
 const applyModeExtras = () => {
  S.showSpells = !state.flying;
  S.showWake = !state.flying;
 };
 applyModeExtras();

 const spells = new SpellSystem(
  gfx, sky, shadows, terrain, character, figure.figure, rig, spray
 );
 // Every surface a spell can light.
 spells.addConsumers(
  terrain.material, figure.bodyMat, figure.clothMat,
  wake.material, spray.material
 );
 // Walkers purged: no herd materials.
 spells.registerPrepass(depthPass);

 // The rig needs ground heights to keep the spring arm above the snow.
 rig.groundAt = (x: number, z: number) => terrain.heightAt(x, z);

 // The opening shot, if one has been pinned. Before the warm-up, so the
 // frames rendered behind the loading screen are already the shot rather than
 // wherever the default rule put things.
 applyOpening(OPENING, rig, character, terrain);

 // The flight's entrance: the three escorts restaged behind the player at
 // altitude and speed, aimed at the centre of the walker line — the game
 // opens with the formation sweeping overhead toward the battle. Called on
 // the boot gate's click rather than here: the simulation runs behind the
 // boot screen, and a flyover staged now would be long gone before the
 // player ever saw the field.
 const startFlyover = () => {
  // The opening beat: hold the player's stick until the escorts have
  // passed overhead and Luke's line has landed. Sized off the actual
  // clip and the actual formation timing rather than guessed — the
  // last ship starts 160 m back at 32 m/s. The run loop counts this
  // down, freezing movement input (the look stays free) and seeding
  // the craft's forward way the moment the hold releases.
  // The voice is the film's when the film made it down, the mp3's when
  // it didn't — whichever is actually going to play. The film's voice
  // starts late by design: an open hold for the fly-in, then the static
  // tune-in, then Luke — `leadIn` is that whole runway.
  const lead = 0.5;
  const voice = audio.buffers.get("lukeIntro")?.duration ?? 3.5;
  state.introHold = Math.max(5.4, lead + voice + 0.4);
  if (!wingmen.length) return;
  for (const w of wingmen) w.flyover(character.position, 0, 300);
  // The player's own entrance: their craft staged 150 m back along the
  // formation's bearing, making way toward the spot the boot pinned.
  // Flown by feeding the controller's velocity each frame (the intro
  // block in the run loop), so the presentation, the camera and the
  // snow all read a genuinely moving craft rather than a teleport.
  if (S.speeder === true) {
   const h = Math.atan2(0 - character.position.x, 300 - character.position.z);
   state.introFly = {
    toX: 0, toZ: 300,
    heading: Math.atan2(0 - character.position.x, 300 - character.position.z),
   };
   character.position.x -= Math.sin(h) * 150;
   character.position.z -= Math.cos(h) * 150;
   character.facing = h;
  }
 };

 const post = new PostChain(gfx, rig, depthPass, sky);

 return { collision, contact, wake, spells, post, startFlyover, applyModeExtras };
}
