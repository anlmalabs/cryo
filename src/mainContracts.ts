import * as THREE from "three";


/**
 * The flight mode, shared by every module that touches it.
 *
 * Before the `main.ts` split these were four closure variables in one scope;
 * the split copied their *values* between modules, so each module wrote its
 * own copy and the copies drifted — the boot crash was the extreme case,
 * where one module read a state object that was never handed to it.
 *
 * - `flying` — is the player flying the craft (as opposed to on foot).
 */
export type FlightState = {
 flying: boolean,
};

/** Creates the one {@link FlightState} instance the app runs on. */
export function createFlightState(flying: boolean): FlightState {
 return { flying };
}



// (purged dead wreck types — see collisionPass.ts for the local interface copy)

/**
 * The fake burst `SNOWFLOW.squadImpact` publishes, and the pass is handed.
 *
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

