import * as THREE from "three";
import { SmokeTrails } from "./vfx/smokeTrails.js";
import type { Speeder } from "./player/speeder.js";

/**
 * Where the intro flyover is heading.
 *
 * Written by the flyover itself and read by the frame loop, which is why it
 * travels on {@link FlightState} rather than being copied between modules.
 */
export type IntroFly = {
 toX: number,
 toZ: number,
 heading: number,
};

/**
 * The flight mode, shared by every module that touches it.
 *
 * Before the `main.ts` split these were four closure variables in one scope;
 * the split copied their *values* between modules, so each module wrote its
 * own copy and the copies drifted — the boot crash was the extreme case,
 * where one module read a state object that was never handed to it.
 *
 * - `flying` — is the player flying the craft (as opposed to on foot).
 * - `introHold` — seconds to hold the opening shot before moving on.
 * - `introFly` — the flyover target, or `null` when no flyover is running.
 */
export type FlightState = {
 flying: boolean,
 introHold: number,
 introFly: IntroFly | null,
};

/** Creates the one {@link FlightState} instance the app runs on. */
export function createFlightState(flying: boolean): FlightState {
 return { flying, introHold: 0, introFly: null };
}

/** An escort. Its module was removed; the shape is expressed by its uses. */
export type Wingman = {
 effects: {
  smoke: SmokeTrails,
  enemy: EnemyFire[],
  raid: { turn: number, size: number },
  onKillHit: (x: number, y: number, z: number) => void,
  onBounce: (x: number, y: number, z: number, facing: number) => void,
  onCrash: (x: number, y: number, z: number, facing: number) => void,
 },
 pilot: { bounced: boolean, _fx: unknown, position: THREE.Vector3, facing: number, velocity: THREE.Vector3, applyImpact(vx: number, vz: number, spin: number, scrambleSec: number): void },
 bounced: boolean,
 _bounceT: number,
 flyover: (target: THREE.Vector3, y: number, distance: number) => void,
 warmUp: () => unknown,
 tick: (dt: number) => void,
 update: (dt: number) => void,
 sync: (cameraPos: THREE.Vector3) => void,
 triangles: number,
};

/** The infantry's reaction pipe, read (never written) through the effects bag. */
export type EnemyFire = unknown;

/**
 * The controller stand-in a wreck's hull is hung off.
 *
 * A real `CharacterController` minus the flight machinery — the wreck is never
 * integrated, so `ctl` is only ever read for pose numbers, which is why the
 * wreck build constructs these fields by hand rather than taking a controller.
 */
export type WreckController = {
 position: THREE.Vector3,
 velocity: THREE.Vector3,
 facing: number,
 lean: number,
 steerRate: number,
 speed01: number,
 speedRaw: number,
 climb: number,
 lift01: number,
 pathY: number,
 groundY: number,
 driveHeld: boolean,
 boostHeld: boolean,
 fireHeld: boolean,
};

/** One hull in the graveyard: the player's own craft, stilled after the crash. */
export type Wreck = {
 hull: Speeder,
 ctl: WreckController,
 active: boolean,
 burnT: number,
 age: number,
 smokeT: number,
 pilotX: number,
 pilotZ: number,
};

/**
 * The fake burst `SNOWFLOW.squadImpact` publishes, and the pass is handed.
 *
 * Deleted with the trooper herd: nothing calls it now. The binding stays so
 * both publish sites keep resolving, and it is `undefined` rather than absent
 * so a compile-time error is raised the moment it is actually called instead
 * of the call silently vanishing — an inert purge remnant. `| undefined` also
 * keeps tsc from narrowing a singly-assigned `const` to the literal type,
 * which would make the declaration itself dead code. It is suppressed at the
 * two publish sites with a non-null assertion rather than `?.`, so calling
 * the console handle throws the TypeError instead of no-oping.
 */
export const squadImpact: ((x: number, y: number, z: number) => void) | undefined = undefined;

// ------------------------------------------------------- module-scope scratch

export const _vel = new THREE.Vector3();
/** Scratch: where the crash camera is pointed. See the death-cam block. */
export const _camAt = new THREE.Vector3();

/** Beauty clear — linear (§2.6). */
export const CLEAR_COLOR = [0.02, 0.03, 0.05, 1];

/**
 * Metres at which a craft coming apart stops being audible.
 *
 * Deliberately more than double the cannons' 420 m (`SHOT_AUDIBLE` in the
 * soundscape): a chin cannon is one gun among many and stops mattering across
 * the line, while a snowspeeder exploding is the loudest event in the battle
 * and the one the player most wants to hear happen. The falloff is the same
 * cubed curve either way, so a crash at 700 m is a faint distant thump — which
 * is the point — rather than nothing at all.
 */
export const CRASH_AUDIBLE = 900;

/**
 * The crash camera.
 *
 * `RATE` is radians a second around the wreck — roughly forty degrees, so the
 * fall and the wait together carry the shot well past a full circle. It was
 * a third of this to begin with and the orbit was real but invisible: a
 * hundred degrees spread over five seconds, from a camera already sitting
 * behind the craft, reads as the camera simply drifting rather than as a shot
 * moving around something. `DIST` stands the frame off far enough to hold the
 * whole hull, the crater and the machines still walking past behind it, and
 * `PITCH` looks down on it rather than at it.
 */
export const DEATH_CAM_RATE = 0.72;

export const DEATH_CAM_DIST = 26;
/** …and the standoff once the subject is a man rather than a machine. */
export const DEATH_CAM_DIST_PILOT = 13;

/** Metres short of the battle a respawning craft comes back in at — near
 *  enough to be in the fight within seconds, far enough to be a flight back
 *  rather than a teleport into the middle of it. */
export const RESPAWN_OUT = 260;

export const DEATH_CAM_PITCH = 0.42;
/**
 * …and the pitch once the subject is the pilot: nearly level with the snow.
 *
 * Looking down at 0.42 is the right angle on a wrecked machine — it shows the
 * crater and the skid line. It is the wrong angle on a man lying flat, which
 * from above is a shape on a white field. Down at the deck he is *in front of*
 * the camera, read against the sky and the burning hull behind him.
 */
export const DEATH_CAM_PITCH_PILOT = 0.1;

// -------------------------------------------------- crash choreography
// The wreck's repose and the pilot's launch, set when the hull is staged.
//
// `climb` is not a dive angle: the controller adds it to the hover height in
// metres (see `Speeder`'s lift term), so the wreck's staged value is an
// *altitude offset* — the hull sitting 2.35 m under its own hover line, which
// is what sinks it into the snow where the drift reads as already claiming it.
export const WRECK_CLIMB = -2.35;
/** Radians the hull is rolled over onto whichever side it settled on. */
export const WRECK_LEAN = 0.32;
/**
 * The pilot's toss, radians for the bearing scatter and metres for the throw.
 * `side` picks either side of the wreck's own heading and lands 0.9–1.6 rad
 * off it; the throw itself is 4–5.5 m clear of the hull.
 */
export const PILOT_TOSS_BASE = 0.9;
export const PILOT_TOSS_SPREAD = 0.7;
export const PILOT_THROW_BASE = 4;
export const PILOT_THROW_SPREAD = 1.5;

// -------------------------------------------------- crash particles
// Every burst below is one `emit` shape at a different scale — the same
// plume-and-ring splash, one size down and one register quieter for the skip
// than for the crash. The coefficients with a physical meaning are named; the
// per-emit random spreads stay inline beside the arguments they scatter.
//
// How much of the craft's flight the skip's snow inherits at the moment of
// the hit (m/s per m/s of craft velocity). The splash carries more of it than
// the puff off the same contact: it lifts a sheet of powder rather than
// heaving a column, so it is thrown further along the direction of travel.
export const SKIP_SPLASH_SWAY = 4;
export const SKIP_PUFF_SWAY = 2;
/** Up-drift, m/s, of the central plume each burst throws. */
export const CRASH_UP_MIN = 6;
export const CRASH_UP_SPREAD = 12;
export const SKIP_UP_MIN = 3;
export const SKIP_UP_SPREAD = 6;
/** Plume lifetime, s — the crash's snow hangs longer than a skip's. */
export const CRASH_LIFE_MIN = 0.06;
export const CRASH_LIFE_SPREAD = 0.1;
export const SKIP_LIFE_MIN = 0.05;
export const SKIP_LIFE_SPREAD = 0.07;
/** Disk radius the plume is born across, metres — the plume's footprint. */
export const SKIP_RADIUS = 0.4;
export const CRASH_RADIUS = 0.5;
/** Height the plume starts at above the contact point, metres. */
export const PLUME_BASE_Y = 0.2;
/** The low ring that races out after the plume: speed, height and radius. */
export const CRASH_RING_MIN = 12;
export const CRASH_RING_SPREAD = 8;
export const SKIP_RING_MIN = 6;
export const SKIP_RING_SPREAD = 5;
export const RING_HEIGHT = 0.15;
export const RING_LIFT_MIN = 1.5;
export const RING_LIFT_SPREAD = 2.5;
export const SKIP_RING_RADIUS = 1.0;
export const CRASH_RING_RADIUS = 1.4;
/** Ring lifetime, s. */
export const CRASH_RING_LIFE_MIN = 0.05;
export const CRASH_RING_LIFE_SPREAD = 0.06;
export const SKIP_RING_LIFE_MIN = 0.04;
export const SKIP_RING_LIFE_SPREAD = 0.05;
/** The dirty puff off a skip: grey, small, and gone in a few seconds. */
export const SKIP_PUFF_GREY = 0.09;
export const SKIP_PUFF_LIFE = 2.4;
export const SKIP_PUFF_LIFE_SPREAD = 2.0;
/** …and the fat fireball cloud over the crash: born higher, born wider. */
export const CRASH_CLOUD_Y = 1.2;
export const CRASH_CLOUD_RADIUS = 1.8;
