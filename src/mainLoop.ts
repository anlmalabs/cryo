import { S } from "./core/settings.js";
import { isDown, input, pollInput, endFrame } from "./core/input.js";
import { expDamp } from "./core/camera.js";
import { emitBurnTrail } from "./physics/collisionPass.js";
import { sample, checkSpike, stats, mark, endFrameDraws } from "./core/perf.js";
import { DEATH_CAM_RATE, DEATH_CAM_DIST, DEATH_CAM_DIST_PILOT, DEATH_CAM_PITCH, DEATH_CAM_PITCH_PILOT, _vel, _camAt } from "./mainContracts.js";
import type { FlightState, Wingman } from "./mainContracts.js";
import type { Gfx } from "./core/gfx.js";
import type { CameraRig } from "./core/camera.js";
import type { Sky } from "./render/sky.js";
import type { ShadowSystem } from "./render/shadows.js";
import type { Terrain } from "./terrain/terrain.js";
import type { CharacterController } from "./character/controller.js";
import type { Character } from "./character/character.js";
import type { SnowContact } from "./character/snowContact.js";
import type { CollisionPass } from "./physics/collisionPass.js";
import type { SpellSystem } from "./spells/spellSystem.js";
import type { SmokeTrails } from "./vfx/smokeTrails.js";
import type { SurfWake } from "./vfx/surfWake.js";
import type { SprayField } from "./vfx/particles.js";
import type { MuzzleMarkers } from "./vfx/muzzleMarkers.js";
import type { Speeder } from "./player/speeder.js";
import type { PostChain } from "./post/postChain.js";
import type { Overlay } from "./ui/overlay.js";
import type { FpsMeter } from "./ui/fpsMeter.js";
import type { PerfHud } from "./ui/perfHud.js";

/**
 * Everything the frame loop reads.
 *
 * This bag was untyped once, and the boot crash came out of the same hole:
 * a field the loop read was never handed to it and nothing said so. Every
 * field is now named and typed, so a missing one fails the build.
 */
export type FrameContext = {
 gfx: Gfx;
 rig: CameraRig;
 sky: Sky;
 shadows: ShadowSystem;
 terrain: Terrain;
 character: CharacterController;
 figure: Character;
 contact: SnowContact;
 wingmen: Wingman[];
 speeder: Speeder | null;
 shipController: CharacterController | null;
 collision: CollisionPass;
 spells: SpellSystem;
 smoke: SmokeTrails;
 wake: SurfWake;
 spray: SprayField;
 muzzleMarkers: MuzzleMarkers;
 overlay: Overlay;
 fpsMeter: FpsMeter;
 perfHud: PerfHud;
 post: PostChain;
 toggleMode: () => void;
 renderFrame: () => void;
 pumpBounces: () => void;
 /** The one shared flight state, read live every frame. */
 state: FlightState;
 /** The wall clock the first frame measures its delta from. */
 prev: number;
 /** Seconds of simulated time since the loop started. */
 time: number;
};

export function startFrameLoop(ctx: FrameContext): void {
 const { gfx, rig, sky, shadows, terrain, character, figure, contact, wingmen, speeder, shipController, collision, spells, smoke, wake, spray, muzzleMarkers, overlay, fpsMeter, perfHud, post, toggleMode, renderFrame, pumpBounces, state } = ctx;
 let prev = ctx.prev, time = ctx.time;
 // Loop-local clocks. These belong to the frame, not to the flight mode: they
 // count down inside the loop and nobody else reads them.
 /** Seconds into the player's crash, driving the camera's circle of the wreck. */
 let deathCamT = 0;
 /** The framing the player had before the crash, handed back after it. */
 let deathCamDist = 0;
 /**
  * The body the crash camera is circling — the player's own pilot, once they
  * have been thrown clear. Null during the fall and after.
  *
  * Never assigned a body yet, but the shot is built around it and the
  * framing constants (`DEATH_CAM_DIST_PILOT`, `DEATH_CAM_PITCH_PILOT`) are
  * sized for it, so the slot stays and the assignment is the missing piece
  * rather than the shape being wrong.
  */
 let deathCamPilot: { position: { x: number; y: number; z: number } } | null = null;
 /** Cadence clock for the overlay's burn preview trail. */
 let burnPreviewT = 0;
 /** The previous frame's mode-toggle key, for the edge trigger. */
 let prevToggleKey = false;
 gfx.renderer.setAnimationLoop(() => {
  const now = performance.now();
  let dtMs = now - prev;
  prev = now;
  if (dtMs > 100) dtMs = 100;
  const dt = S.freezeTime ? 0 : dtMs / 1000;
  time += dt;

  // Mode toggle: exit/enter the ship. BEFORE the input poll, so the poll
  // publishes the mode the frame's update is about to run in.
  const toggleDown = isDown("KeyR");
  if (toggleDown && !prevToggleKey) {
   toggleMode();
  }
  prevToggleKey = toggleDown;

  // Now the poll, in the mode the toggle just decided — `pollInput` reads
  // `input.flying` for the pinned surf/trigger and the throttle axes, and
  // `CharacterController._surfStep` reads it again for the steer and the
  // thrust curve. Publishing it before the toggle above meant one frame of
  // every one of those decisions running in the mode we had just left.
  input.flying = state.flying;
  pollInput();


  // Per-system CPU timing. There is no dependable GPU timer in WebGL2, so
  // the overlay's GPU row shows its dash and these rows stay `cpu`.
  const tFrame = performance.now();

  if (state.flying && shipController) {
   shipController.update(dt, rig);
   // Mirror into `character` so downstream camera/VFX/sound code keeps working.
   character.position.copy(shipController.position);
   character.velocity.copy(shipController.velocity);
   character.prevVelocity.copy(shipController.prevVelocity);
   character.acceleration.copy(shipController.acceleration);
   character.facing = shipController.facing;
   character.speed = shipController.speed;
   character.speed01 = shipController.speed01;
   character.speedRaw = shipController.speedRaw;
   character.lean = shipController.lean;
   character.carve = shipController.carve;
   character.streak01 = shipController.streak01;
   character.groundY = shipController.groundY;
   character.groundNormal.copy(shipController.groundNormal);
   character.surf = shipController.surf;
   character.surfActive = shipController.surfActive;
   character.crashing = shipController.crashing;
   character.crashLanded = shipController.crashLanded;
   character.crashDown = shipController.crashDown;
   character._crashT = shipController._crashT;
   character.terrainSlam = shipController.terrainSlam;
   character.pathY = shipController.pathY;
   character.lift01 = shipController.lift01;
   character.impactSpin = shipController.impactSpin;
   character.cast = shipController.cast;
   character.castAimX = shipController.castAimX;
   character.castAimY = shipController.castAimY;
   character.castAimZ = shipController.castAimZ;
   character.stepping = shipController.stepping;
   character.gaitPhase = shipController.gaitPhase;
   character.footfall = shipController.footfall;
   character.footIndex = shipController.footIndex;
   character.footPos.copy(shipController.footPos);
   // Presentation mirror: `character` is a view of the authoritative
   // shipController while flying. Keep this list in sync with the
   // CharacterController constructor field set.
   character._prevSpeed = shipController._prevSpeed;
   character._drive = shipController._drive;
   character._boost = shipController._boost;
   character._climb = shipController._climb;
   character._climbWant = shipController._climbWant;
   character._vertEase = shipController._vertEase;
   character.climb = shipController.climb;
   character.climbRate = shipController.climbRate;
   character._cruiseGround = shipController._cruiseGround;
   character.steer = shipController.steer;
   character.steerRate = shipController.steerRate;
   character.controlScramble = shipController.controlScramble;
   character._scrambleMax = shipController._scrambleMax;
   character._scrambleT = shipController._scrambleT;
   character.fireHeld = shipController.fireHeld;
   character.driveHeld = shipController.driveHeld;
   character.boostHeld = shipController.boostHeld;
   character._prevTargetY = shipController._prevTargetY;
   character._slam = shipController._slam;
   character.footImpact = shipController.footImpact;
  } else {
   character.footfall = false;
   character.update(dt, rig);
  }
  terrain.heightfield.clampToPlayArea(character.position);
  // Pose and simulate before the contact pass: the footprints are stamped
  // at the boot's actual planted position, which only exists once the
  // figure has been solved.
  figure.update(dt);
  contact.update(dt);
  // The walkers only read the player's position, so they can sit anywhere
  // after the controller has moved. Here, so their cost lands in the same
  // row of the overlay as the rest of the scene's inhabitants.
  // walkers/herds purged: no update.
  // The crash sites burn down and freeze over: smoke and fire for the
  if (state.flying) {
   speeder?.tick(dt);
   speeder?.update(dt);
  }
  for (const w of wingmen) {
   w.tick(dt);
   w.update(dt);
  }
  // The skip, if one of the falling craft touched the snow this frame
  // and said so with a latch rather than a call. Cheap — a flag test
  // per wingman — and it has to run after the pilots have moved, so
  // the contact point it reads is this frame's, not last frame's.
  pumpBounces();
  // After every craft has moved, before the rig frames the result: the
  // Collision pass works on whichever controller is actually driving this frame.
  collision.character = (state.flying && shipController) ? shipController : character;
  // contacts this frame's motion earned, resolved and reacted to.
  collision.update(dt);
  const tChar = performance.now();

  _vel.copy(character.velocity);
  // The death cam. While the craft is going in and lying there, the
  // frame stops being a cockpit view and becomes a shot *of* the crash:
  // the heading handed to the rig walks steadily round, and because the
  // rig chases whatever heading it is given, the camera circles the
  // wreck. The craft's own facing is untouched, so the hull lies still
  // while the world turns around it — turning the wreck instead would
  // spin it like a bottle. The bank is zeroed too: the roll belongs to
  // the falling craft, not to the camera watching it.
  let camFacing = state.flying ? character.facing : null;
  let camLean = character.lean;
  let camTarget = character.position;
  if (character.crashing) {
   if (deathCamT === 0) {
    // Remember the framing to give back afterwards — the player
    // may have zoomed it exactly where they like it.
    deathCamDist = rig.distanceTarget;
    if (deathCamPilot === null) {
    }
   }
   deathCamT += dt;
   camFacing = character.facing + deathCamT * DEATH_CAM_RATE;
   camLean = 0;
   // What the shot is ABOUT is the pilot.
   //
   // The wreck is scenery — it lands, it burns, it sits there. The
   // body thrown clear of it is the only thing in the frame still
   // doing something: three and a half seconds of dying, played out
   // in the snow. So once there is a body the camera takes it as its
   // subject and circles that, with the burning hull swinging
   // through the background as it goes. Until then (the fall itself,
   // before anything has hit) it stays on the craft.
   const body = deathCamPilot;
   if (body) {
    _camAt.set(body.position.x, body.position.y + 0.6, body.position.z);
    camTarget = _camAt;
   }
   // Stand off and look down — closer for a man than for a machine,
   // or the animation the shot exists for is four pixels of orange.
   rig.distanceTarget = body ? DEATH_CAM_DIST_PILOT : DEATH_CAM_DIST;
   rig.pitch = expDamp(
    rig.pitch,
    body ? DEATH_CAM_PITCH_PILOT : DEATH_CAM_PITCH, 1.4, dt
   );
  } else if (deathCamT > 0) {
   deathCamT = 0;
   deathCamPilot = null;
   rig.distanceTarget = deathCamDist || rig.distanceTarget;
  }
  // Flying, the rig is handed the craft's heading and chases it itself —
  // see CameraRig.update — rather than the controller stepping rig.yaw.
  rig.update(
   dt, camTarget, _vel, camLean, character.speed01, camFacing, character.facing
  );

  // Jitters the projection and republishes everything the screen-space
  // passes derive from the camera. Must be after the rig has moved and
  // before anything reads the view-projection — which the depth prepass
  // and the beauty pass both do.
  // The craft's streak when there is a craft: see `Speeder.streak01` for
  // why the character's is the wrong signal in the air.
  post.update(dt, (speeder && state.flying) ? speeder.streak01 : character.streak01, rig.distance);
  sky.update();
  sky.render(rig, time);
  shadows.update(rig.camera, sky.sunDir);
  // After the shadow refit, so the water and the ice carry this frame's
  // cascade matrices; before the terrain, so the brushes every spell
  // writes are in the staging array when the simulation pass runs.
  spells.update(dt, rig.camera.position);
  const tSpells = performance.now();
  terrain.update(rig.camera.position, character.position, dt);
  const tTerrain = performance.now();
  // After the shadow refit, so the figure's uniforms carry this frame's
  // cascade matrices rather than last frame's.
  figure.sync(rig.camera.position);
  // Also picks each walker's level of detail, which needs this frame's
  // camera and this frame's field of view.
  // walkers/herds purged: no sync.
  speeder?.sync(rig.camera.position);
  for (const w of wingmen) w.sync(rig.camera.position);
  // The tuning rings, after every transform they pin to has settled.
  muzzleMarkers.begin();
  if (S.showMuzzles) {
   // walkers/herds purged: no muzzle collection.
   speeder?.collectMuzzles?.(muzzleMarkers);
  }
  muzzleMarkers.commit(rig.camera.position);
  // Before the spray: the wake decides where its own lip is, and the
  // grains it sheds have to be in the pool before the pool is uploaded.
  wake.update(dt, rig.camera.position);
  spray.update(dt, rig.camera.position);
  // The overlay's burn preview: the wingmen's damage trail, lit on the
  // player craft so the burn sliders can be dialled against a hull the
  // player can actually orbit.
  if (S.burnPreview && speeder && state.flying) {
   burnPreviewT -= dt;
   if (burnPreviewT <= 0) {
    burnPreviewT = 0.05;
    // Off the *drawn* hull, not the controller — the controller
    // rides hover-height below the craft the player is looking at.
    emitBurnTrail(
     smoke, speeder.position, speeder.yaw,
     character.velocity, true
    );
   }
  }
  smoke.update(dt, rig.camera.position);
  const tVfx = performance.now();

  // Last, and a pure reader: every signal it mixes on — surf blend, carve
  // load, speed, cast count — has settled by here.
  const tAudio = performance.now();

  renderFrame();
  post.endFrame();
  const tRender = performance.now();

  mark("cpu character", tChar - tFrame);
  mark("cpu spells", tSpells - tChar);
  mark("cpu terrain", tTerrain - tSpells);
  mark("cpu wake+spray", tVfx - tTerrain);
  mark("cpu audio", tAudio - tVfx);
  mark("cpu submit", tRender - tAudio);
  mark("cpu total", tRender - tFrame);

  endFrameDraws();
  stats.triangles =
   (terrain.mesh && terrain.mesh.metadata ? terrain.mesh.metadata.triangles : 0) +
   (S.showCharacter && !state.flying ? figure.triangles : 0) +
   (speeder ? speeder.triangles : 0) +
   wingmen.reduce((t, w) => t + w.triangles, 0) +
   // walkers/herds purged: no triangle counts.
   (wake.mesh && wake.mesh.visible ? wake.mesh.metadata.triangles : 0) +
   spells.triangles +
   spray.liveCount * 2;

  sample(dtMs);
  checkSpike(dtMs);
  overlay.update(dtMs, gfx);
  fpsMeter.update(dtMs);
  perfHud.update(dtMs, gfx);

  endFrame();
 });
}
