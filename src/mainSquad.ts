import type { CharacterController } from "./character/controller.js";
import type { SprayField } from "./vfx/particles.js";
import type { SmokeTrails } from "./vfx/smokeTrails.js";
import type { Terrain } from "./terrain/terrain.js";
import type { AudioEngine } from "./audio/engine.js";
import type { EnemyFire, Wingman } from "./mainContracts.js";
import {
 CRASH_AUDIBLE,
 SKIP_SPLASH_SWAY, SKIP_PUFF_SWAY,
 CRASH_UP_MIN, CRASH_UP_SPREAD, SKIP_UP_MIN, SKIP_UP_SPREAD,
 CRASH_LIFE_MIN, CRASH_LIFE_SPREAD, SKIP_LIFE_MIN, SKIP_LIFE_SPREAD,
 SKIP_RADIUS, CRASH_RADIUS, PLUME_BASE_Y,
 CRASH_RING_MIN, CRASH_RING_SPREAD, SKIP_RING_MIN, SKIP_RING_SPREAD,
 RING_HEIGHT, RING_LIFT_MIN, RING_LIFT_SPREAD,
 SKIP_RING_RADIUS, CRASH_RING_RADIUS,
 CRASH_RING_LIFE_MIN, CRASH_RING_LIFE_SPREAD,
 SKIP_RING_LIFE_MIN, SKIP_RING_LIFE_SPREAD,
 SKIP_PUFF_GREY, SKIP_PUFF_LIFE, SKIP_PUFF_LIFE_SPREAD,
 CRASH_CLOUD_Y, CRASH_CLOUD_RADIUS,
} from "./mainContracts.js";

export type BuildSquadContext = {
 wingmen: Wingman[];
 character: CharacterController;
 terrain: Terrain;
 spray: SprayField;
 smoke: SmokeTrails;
 audio: AudioEngine;
 leaveWreck: ((x: number, z: number, facing: number) => null) | null;
};

export type SquadState = {
 pumpBounces: () => void;
};

export function buildSquad(ctx: BuildSquadContext): SquadState {
 const { wingmen, character, terrain, spray, smoke, audio, leaveWreck } = ctx;

 /**
  * Where the wingmen's guns report a burst: the infantry's reaction pipe,
  * handed to each escort's `effects` bag as `enemy`. Nothing writes it
  * (the trooper herd is gone), but the bag's shape still carries the key
  * and the pass still reads it.
  * @type {EnemyFire[]}
 */
 const enemyFire: EnemyFire[] = [];
 // The shared fate token: one ship wounded and falling at a time, ever.
 const raid = { turn: 0, size: Math.max(1, wingmen.length) };
 /** Milliseconds inside which a second announcement of the same skip is
  *  the same skip. The two ground contacts of one fall are ~1.5 s apart
  *  and the crash does not route through `onBounce` at all, so anything
  *  under that is safe; a full second is comfortably clear of the
  *  duplicate-in-the-same-frame case it exists for. */
 const BOUNCE_DEBOUNCE = 1000;
 for (const w of wingmen) {
  w.effects = {
   smoke,
   enemy: enemyFire,
   raid,
   // The killing hit: a burst on the airframe itself, in the air —
   // the fireball the dying machine then flies out of. The volume's
   // centre normally sits LIFT above a ground impact, so the y is
   // walked down to land the burst at hull height.
   //
   // This is also where the *whole fall* starts speaking. Since the
   // crash choreography was re-timed onto `speeder-crash-2.mp3`, that
   // sample is no longer a report — it is the soundtrack of the next
   // seven and a half seconds: the hit, the long windmilling descent,
   // the first ground impact at 4.0 s, the final crash at 5.5 s and
   // the debris settling after. So it is fired exactly ONCE, here at
   // t = 0, and nothing downstream is allowed to speak again — not
   // the skip, not `onCrash`. Playing it at t=0 is what puts its
   // internal 4.0 s and 5.5 s marks on the frames where the craft
   // actually touches the snow; delaying it or restarting it at the
   // ground would smear the whole sequence out of sync.
   onKillHit: (x: number, y: number, z: number) => {
    // The cannon distance model, to the letter: linear to nothing
    // at 420 m, CUBED so it does not read as loud from across the
    // battle line, and 343 m/s of honest travel time on top.
    const kd = Math.hypot(
     x - character.position.x, z - character.position.z
    );
    // …but over a longer reach than a chin cannon. 420 m is the
    // range at which one gun firing stops mattering; a snowspeeder
    // coming apart is the loudest thing on this battlefield, and
    // it is *falling for five and a half seconds* — a fall that
    // usually carries it a couple of hundred metres closer to the
    // player before it lands. Cut at 420 and the deaths that read
    // as most cinematic, the ones out over the line, happen in
    // total silence. The cube keeps a distant one honestly faint.
    const kn = Math.max(0, 1 - kd / CRASH_AUDIBLE);
    if (kn > 0) {
     audio.play("speederCrash2", {
      gain: kn * kn * kn,
      delay: Math.min(1.6, kd / 343),
     });
    }
   },
   /**
    * The skip — first ground contact at t ≈ 4.0 s, the craft striking
    * the snow and bouncing back off it rather than ending there.
    *
    * Everything the crash does, one size down and one register
    * quieter: the same plume-and-ring splash shape, a short shallow
    * gouge along the skid line, a small dirty puff. Deliberately no
    * visual burst — the airframe is still whole, it is only touching —
    * and deliberately NO sound: `speeder-crash-2.mp3` has this exact
    * impact baked into it at 4.0 s and has been playing since the
    * killing hit, so anything fired here would double it.
    *
    * See `pumpBounces` for how this is reached: it is called both
    * ways, as a callback and off a one-frame latch. The debounce
    * lives here rather than at either call site precisely because
    * there are two of them — a pilot that announces the skip both
    * ways still only skips once, and a fall skips once by nature
    * (the next contact is the crash, and a respawn separates falls).
    */
   onBounce: (x: number, y: number, z: number, facing: number) => {
    const nowMs = performance.now();
    if (nowMs - (w._bounceT ?? -1e9) < BOUNCE_DEBOUNCE) return;
    w._bounceT = nowMs;
    const gy = terrain.heightAt(x, z);
    const fx2 = Math.sin(facing ?? 0), fz2 = Math.cos(facing ?? 0);
    // The scuff: shallow, long, laid along the direction of travel.
    terrain.deform.brush(
     x, z, 2.2, 0.3, 0.22, 0.75, 0.2, facing ?? 0, 3.4, 0.9
    );
    // The splash, at a third of the crash's count and half its
    // throw — a skip lifts a sheet of powder, not a column.
    for (let k = 0; k < 20; k++) {
     const a = Math.random() * Math.PI * 2;
     const out = 3 + Math.random() * 6;
     spray.emit(
      x + Math.cos(a) * SKIP_RADIUS, gy + PLUME_BASE_Y, z + Math.sin(a) * SKIP_RADIUS,
      Math.cos(a) * out + fx2 * SKIP_SPLASH_SWAY,
      SKIP_UP_MIN + Math.random() * SKIP_UP_SPREAD,
      Math.sin(a) * out + fz2 * SKIP_SPLASH_SWAY,
      0.05 + Math.random() * 0.07, SKIP_LIFE_MIN + Math.random() * SKIP_LIFE_SPREAD,
      Math.random() < 0.4 ? 1 : 0, 1.2
     );
    }
    // The low ring racing out from the touch point.
    for (let k = 0; k < 12; k++) {
     const a = (k / 12) * Math.PI * 2 + Math.random() * 0.3;
     const out = SKIP_RING_MIN + Math.random() * SKIP_RING_SPREAD;
     spray.emit(
      x + Math.cos(a) * SKIP_RING_RADIUS, gy + RING_HEIGHT, z + Math.sin(a) * SKIP_RING_RADIUS,
      Math.cos(a) * out, RING_LIFT_MIN + Math.random() * RING_LIFT_SPREAD,
      Math.sin(a) * out,
      0.04 + Math.random() * 0.05, SKIP_RING_LIFE_MIN + Math.random() * SKIP_RING_LIFE_SPREAD,
      1, 1.5
     );
    }
    // A puff, not a ball: grey, small, gone in a few seconds.
    for (let k = 0; k < 5; k++) {
     const a = Math.random() * Math.PI * 2;
     const rr = Math.random() * 0.9;
     smoke.emit(
      x + Math.cos(a) * rr, gy + 0.8 + Math.random() * 1.0,
      z + Math.sin(a) * rr,
      (Math.random() - 0.5) * 1.6 + fx2 * SKIP_PUFF_SWAY,
      0.6 + Math.random() * 1.0,
      (Math.random() - 0.5) * 1.6 + fz2 * SKIP_PUFF_SWAY,
      0.9 + Math.random() * 0.7, -0.1,
      SKIP_PUFF_LIFE + Math.random() * SKIP_PUFF_LIFE_SPREAD,
      SKIP_PUFF_GREY, SKIP_PUFF_GREY, SKIP_PUFF_GREY, 0.5, true
     );
    }
   },
   onCrash: (x: number, y: number, z: number, facing: number) => {
    // No report here on purpose. `speederCrash2` started at the
    // killing hit and its own timeline reaches the final crash at
    // 5.5 s, which is this frame — a second sample fired now would
    // land on top of the one already playing and smear the very
    // moment it is meant to punctuate. The fireball, the crater
    // and the snow are the whole of what this handler contributes.
    //
    // The arrival scar: the crater it dug and the trench it
    // ploughed getting there.
    terrain.deform.brush(x, z, 3.4, 0.85, 0.6, 1.0, 0.6, 0, 1.3, 1.0);
    terrain.deform.brush(
     x - Math.sin(facing) * 4.5, z - Math.cos(facing) * 4.5,
     2.4, 0.5, 0.55, 1.0, 0.3, facing, 3.0, 1.0
    );
    // The splash: a machine-sized slap of snow — a tall central
    // plume and a low fast ring racing out from the hull, the way
    // a heavy impact into powder actually reads.
    for (let k = 0; k < 60; k++) {
     const a = Math.random() * Math.PI * 2;
     const out = 4 + Math.random() * 11;
     spray.emit(
      x + Math.cos(a) * CRASH_RADIUS, y + PLUME_BASE_Y, z + Math.sin(a) * CRASH_RADIUS,
      Math.cos(a) * out, CRASH_UP_MIN + Math.random() * CRASH_UP_SPREAD, Math.sin(a) * out,
      0.06 + Math.random() * 0.1, CRASH_LIFE_MIN + Math.random() * CRASH_LIFE_SPREAD,
      Math.random() < 0.4 ? 1 : 0, 1.2
     );
    }
    for (let k = 0; k < 30; k++) {
     const a = (k / 30) * Math.PI * 2 + Math.random() * 0.2;
     const out = CRASH_RING_MIN + Math.random() * CRASH_RING_SPREAD;
     spray.emit(
      x + Math.cos(a) * CRASH_RING_RADIUS, y + RING_HEIGHT, z + Math.sin(a) * CRASH_RING_RADIUS,
      Math.cos(a) * out, RING_LIFT_MIN + Math.random() * RING_LIFT_SPREAD,
      Math.sin(a) * out,
      0.05 + Math.random() * 0.06, CRASH_RING_LIFE_MIN + Math.random() * CRASH_RING_LIFE_SPREAD,
      1, 1.6
     );
    }
    // The smoke ball: a fat black cloud boiling up off the
    // impact, then *shrinking* — negative growth — as it thins
    // and lets go over the next ten seconds.
    for (let k = 0; k < 14; k++) {
     const a = Math.random() * Math.PI * 2;
     const rr = Math.random() * CRASH_CLOUD_RADIUS;
     smoke.emit(
      x + Math.cos(a) * rr, y + CRASH_CLOUD_Y + Math.random() * 2.2,
      z + Math.sin(a) * rr,
      (Math.random() - 0.5) * 1.2,
      0.7 + Math.random() * 1.4,
      (Math.random() - 0.5) * 1.2,
      1.8 + Math.random() * 1.6, -0.22,
      6 + Math.random() * 5,
      0.05, 0.05, 0.05, 0.6, true
     );
    }
    leaveWreck?.(x, z, facing);
   },
  };
  // The pilot's own back-channel to the same handlers. SimPilot is a
  // bare character controller — it has never held an effects object,
  // the Wingman wrapper does — but the skip happens deep inside the
  // downed ballistic, where only the pilot knows the frame the snow was
  // touched. Handing it the same bag lets it call `this._fx?.onBounce?.()`
  // directly if it wants to; if it would rather raise a one-frame latch
  // instead, `pumpBounces` below picks that up. Both roads lead here,
  // and the debounce makes taking both harmless.
  w.pilot._fx = w.effects;
 }

 /**
  * The skip, delivered whichever way the flight code chose to announce it.
  *
  * Two contracts are honoured because the fall is authored on the other
  * side of the wall and either shape is reasonable there:
  *
  *   the callback   the pilot (or the wrapper) calls `onBounce(x,y,z,facing)`
  *                  at the contact frame, through `_fx` or `effects`.
  *   the latch      the pilot raises `bounced = true` for one frame — the
  *                  same shape as the existing `crashed` latch — and this
  *                  the wrapper forwards it rather than the pilot raising it.
  *
  * A pilot that does both fires once — see the debounce inside `onBounce`.
  */
 const pumpBounces = () => {
  for (const w of wingmen) {
   const P = w.pilot;
   if (!P) continue;
   if (!P.bounced && !w.bounced) continue;
   P.bounced = false;
   w.bounced = false;
   w.effects?.onBounce?.(P.position.x, P.position.y, P.position.z, P.facing);
  }
 };

 return { pumpBounces };
}
