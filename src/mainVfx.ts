import { onChange } from "./core/settings.js";
import { CollisionPass } from "./physics/collisionPass.js";
import { SnowContact } from "./character/snowContact.js";
import { SurfWake } from "./vfx/surfWake.js";
import { SpellSystem } from "./spells/spellSystem.js";
import { PostChain } from "./post/postChain.js";
// opening shot purged
import type { FlightState, Wingman } from "./mainContracts.js";
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
 speeder: Speeder | null;
 wingmen: Wingman[];
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
};

export function buildVfx(ctx: VfxContext): VfxState {
 const gfx = ctx.gfx, sky = ctx.sky, shadows = ctx.shadows, depthPass = ctx.depthPass;
 const terrain = ctx.terrain, character = ctx.character, shipController = ctx.shipController;
 const figure = ctx.figure, spray = ctx.spray, smoke = ctx.smoke;
 const rig = ctx.rig, audio = ctx.audio;
 const speeder = ctx.speeder, wingmen = ctx.wingmen;
 const state = ctx.state;
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
  terrain, spray, smoke, rig, audio,
  parked: () => {
   if (state.flying || !speeder) return null;
   const dx = character.position.x - speeder.position.x;
   const dz = character.position.z - speeder.position.z;
   if (dx * dx + dz * dz < 3.5 * 3.5) return null;
   return speeder.position;
  },
 });

 // The collision pass is told what is solid: the player's craft, the parked
 // hull, and the wreck graveyard. Every collaborator is optional, so a boot
 // without a speeder still runs the parts it has.

 speeder?.setVisible(true);

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

 const post = new PostChain(gfx, rig, depthPass, sky);

 return { collision, contact, wake, spells, post };
}
