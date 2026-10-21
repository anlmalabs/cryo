/**
 * The opening shot — pinned, or computed.
 *
 * With `OPENING` null this file does nothing: the shot frames itself against
 * the sun and the window (the rule frame-the-shot-itself approach).
 * As shipped, `OPENING` holds a pinned shot rather than null.
 * Only `src/walkers/modelAsset.ts` exists now; walkers were purged.
 * That rule is aspect-aware and holds up from a phone to an ultrawide, which a
 * fixed set of coordinates cannot.
 *
 * But a rule is not a composition, and sometimes the shot you want is a
 * particular machine on a particular ridge with the sun in a particular gap.
 * For that: fly the camera there, press **F2**, and paste what lands on the
 * clipboard into `OPENING` below. The next load starts exactly there: the
 * camera and the player. The herd is not part of it. The capture writes an
 * empty `walkers: []` and `applyOpening` ignores that field, so a pinned shot
 * restores the framing and the player, and nothing else in the demo has to
 * know it was authored rather than derived.
 *
 *   F2                     capture the current shot to the clipboard, and log it
 *   SNOWFLOW.captureShot() the same thing, from the console
 *
 * Pinned coordinates are absolute, so a pinned shot is a fixed aspect ratio's
 * shot: it will frame differently on a phone than on the monitor it was authored
 * on. That is the trade — exactness for adaptability — and it is why the default
 * is the rule rather than a capture.
 */

import { input } from "./input.js";

/** Where the camera opens, in the rig's own yaw/pitch/distance convention. */
interface OpeningCamera {
 /** Radians. */
 yaw: number;
 /** Radians. */
 pitch: number;
 /** Metres along the arm. */
 distance: number;
}

/**
 * Where the player opens. `rise` is either the E-ladder rung to start held
 * (1..3) or a legacy boolean latch — old pins in the wild saved the boolean, new
 * ones save the rung, and both are read here.
 */
interface OpeningPlayer {
 x: number;
 z: number;
 facing?: number;
 rise?: boolean | number;
 climb?: number;
}

/** A pinned walker, for pins that still carry one (the herd is gone). */
interface OpeningWalker {
 x: number;
 z: number;
 yaw: number;
 phase?: number;
}

/** One captured shot. */
interface OpeningShot {
 camera: OpeningCamera;
 player: OpeningPlayer;
 walkers: OpeningWalker[];
}

/** The slice of the rig a shot writes. */
interface OpeningRig {
 yaw: number;
 pitch: number;
 distance: number;
 distanceTarget: number;
}

/** The slice of the character a shot writes. */
interface OpeningCharacter {
 position: { x: number; y: number; z: number };
 facing: number;
 climb: number;
 _climb?: number;
}

/** The slice of the terrain a shot needs. */
interface OpeningTerrain {
 heightAt(x: number, z: number): number;
}

/**
 * Paste a captured block here to pin the opening. Leave null to let the shot
 * frame itself.
 *
 * The `satisfies` keeps the pin's shape checked against `OpeningShot` without
 * widening `OPENING`'s inferred type past what the comment above claims: it is
 * a populated shot today, and `null` is a value a future edit may set there —
 * which is exactly why `applyOpening` takes `OpeningShot | null`.
 * @type {OpeningShot | null}
 */
export const OPENING = {
 camera: { yaw: -0.072, pitch: 0.213, distance: 11 },
 player: { x: 42.543, z: 17.645, facing: 0.266, rise: true, climb: 6 },
 // Deep — 400 m out, so reaching the line is a flight, not a hop. Same
 // bearings as the original composition, just further down them. The
 // third machine anchors the rear of the whole advance, behind even the
 // scouts and their squads, coming up out of the haze.
 // Inert as the code stands: `applyOpening` places the camera and the
 // player only, and the herd was purged, so nothing reads these entries.
 walkers: [
  { x: 59.13, z: 417.3, yaw: -2.862, phase: 0.384 },
  { x: 192.3, z: 420.78, yaw: -2.622, phase: 0.754 },
  { x: 112.0, z: 560.0, yaw: -3.01, phase: 0.12 },
 ],
} satisfies OpeningShot;

/**
 * Put the world into a captured shot.
 *
 * Called once at boot, before the first frame, so nothing has moved yet and no
 * system has read a position it would have to be told about again.
 *
 * @param {OpeningShot|null} shot the pinned shot; null frames itself
 * @param {OpeningRig} rig
 * @param {OpeningCharacter} character
 * @param {OpeningTerrain} terrain
 */
export function applyOpening(shot: OpeningShot | null, rig: OpeningRig, character: OpeningCharacter, terrain: OpeningTerrain) {
 if (!shot) return;

 if (shot.camera) {
  rig.yaw = shot.camera.yaw;
  rig.pitch = shot.camera.pitch;
  rig.distance = rig.distanceTarget = shot.camera.distance;
 }

 if (shot.player) {
  character.position.x = shot.player.x;
  character.position.z = shot.player.z;
  character.position.y = terrain.heightAt(shot.player.x, shot.player.z);
  // The craft's heading, not just its parking spot — a speeder start
  // aimed at nothing is half a shot.
  if (shot.player.facing !== undefined) character.facing = shot.player.facing;
  // The E ladder: a shot captured at altitude should *open* at that
  // altitude, rung held, not sink to the deck on frame one. Old pins
  // saved the boolean latch; new ones save the rung.
  if (shot.player.rise !== undefined) {
   input.riseLevel = typeof shot.player.rise === "number"
    ? Math.max(1, Math.min(3, shot.player.rise))
    : (shot.player.rise ? 3 : 1);
  }
  if (shot.player.climb !== undefined && character._climb !== undefined) {
   character._climb = shot.player.climb;
   character.climb = shot.player.climb;
   character.position.y += shot.player.climb;
  }
 }

}

/**
 * Snapshot the world as a paste-able `OPENING` block.
 *
 * @param {OpeningRig} rig
 * @param {OpeningCharacter} character
 * @returns {string}
 */
export function captureOpening(rig: OpeningRig, character: OpeningCharacter) {
 /** @param {number} v */
 const n = (v: number) => Number(v.toFixed(3));

 const lines = [
  "export const OPENING = {",
  `    camera: { yaw: ${n(rig.yaw)}, pitch: ${n(rig.pitch)}, ` +
  `distance: ${n(rig.distanceTarget)} },`,
  `    player: { x: ${n(character.position.x)}, z: ${n(character.position.z)}, ` +
  `facing: ${n(character.facing)}, rise: ${input.riseLevel}, ` +
  `climb: ${n(character.climb || 0)} },`,
  "    walkers: [],",
  "};",
 ];
 return lines.join("\n");
}

/**
 * Wire F2 to the capture.
 *
 * The clipboard write is best-effort: it needs a secure context and can be
 * refused, and a capture that only reaches the console is still a capture.
 * @param {OpeningRig} rig
 * @param {OpeningCharacter} character
 */
export function installShotCapture(rig: OpeningRig, character: OpeningCharacter): () => string {
 const capture = () => {
  const text = captureOpening(rig, character);
  console.log(
   "%c[opening shot] paste into src/core/openingShot.ts",
   "color:#8fc4e8", "\n\n" + text + "\n"
  );
  navigator.clipboard?.writeText(text).then(
   () => console.log("[opening shot] copied to clipboard"),
   () => console.log("[opening shot] clipboard refused — copy it from above")
  );
  return text;
 };

 window.addEventListener("keydown", (e) => {
  if (e.code !== "F2") return;
  e.preventDefault();
  capture();
 });

 return capture;
}
