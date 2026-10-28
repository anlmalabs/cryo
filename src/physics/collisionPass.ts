/**
 * The collision pass — where the craft finally meet the machines.
 *
 * Everything upstream is a piece: colliders.js knows where things touch,
 * impact.js knows what a touch does to a velocity, the models know their own
 * capsules, the craft know how to take a shove. This module is the frame that
 * and the wrecks, sweeps every flying craft's sphere through it, resolves the
 * earliest contact per craft, and routes the consequences — deflection, spin,
 * scramble, stumble, snow, smoke, fire, sound — to their owners.
 *
 * Design rules, inherited from the contract the pieces were built to:
 *
 *   swept, never sampled   Craft move metres per frame; every test is against
 *                          the frame's motion, so speed cannot tunnel.
 *   earliest hit wins      One contact resolved per craft per frame. The
 *                          depenetration guarantees next frame starts clean,
 *                          so a second contact simply waits a frame.
 *   no stop on contact     Responses come from `speederImpactResponse`:
 *                          tangential velocity survives, scrapes slide.
 *   massive stays massive  A model takes a tempo hiccup (`stumble`), never
 *                          a displacement. Wrecks take nothing at all.
 *
 * The player's damage ladder lives here rather than on the controller,
 * because it is a *game* rule, not a physics one: 'hit' steps it with a grace
 * window, 'crash' trips it, and the third rung is a field repair — explosion,
 * a twenty-second burn, and the ladder resets. No death screen.
 *
 * Everything is preallocated at construction; the frame path allocates
 * nothing. Every collaborator is null-checked so a boot without a speeder,
 */

import * as THREE from "three";
import { S } from "../core/settings.js";
import { input } from "../core/input.js";
import { makeCapsulePool, sweptSphereVsCapsule, sweptSphereVsSphere } from "./colliders.js";
import { speederImpactResponse, severityFor } from "./impact.js";
import type { Capsule, CapsuleOwner } from "./colliders.js";
import type { ImpactResponse, Severity } from "./impact.js";
import type { CharacterController } from "../character/controller.js";
import type { Speeder } from "../player/speeder.js";
import type { Terrain } from "../terrain/terrain.js";
import type { SprayField } from "../vfx/particles.js";
import type { SmokeTrails } from "../vfx/smokeTrails.js";
import type { CameraRig } from "../core/camera.js";
import type { AudioEngine } from "../audio/engine.js";

/**
 * What a response needs from whichever controller drives the frame: the
 * the same pose and the same impact entry point. Declared structurally so
 * the two do not have to share a base class.
 */
interface Respondable {
 position: THREE.Vector3;
 velocity: THREE.Vector3;
 facing: number;
 /**
  * Apply a resolved impact. `spin` is rad/s, `scrambleSec` how long control
  * is degraded for.
  */
 applyImpact(vx: number, vz: number, spin: number, scrambleSec: number): void;
}

/**
 * which does not export and does not declare `collisionHit`. The pass only
 * ever calls that on a non-null wing, so it is optional here; both shapes are
 * accepted without an `any`.
 */
interface Escort {
 /**
  * The pilot: the same published surface the player's `CharacterController`
  * offers, which is what the sweeps respond through. Note `main.ts` declares
  * not satisfy this — see the report for the consequence and why it is
  * untypeable from this file's side alone.
  */
 pilot: Respondable & { bounced: boolean };
 /**
  * would apply to is gone, so the call is guarded at both use sites.
  */
 collisionHit?(severity: Severity, px: number, py: number, pz: number): void;
}

/**
 * A wreck's hull controller stand-in: the pose numbers the pool reads.
 * `main.ts` constructs these by hand rather than taking a controller, and its
 * own `WreckController` type is not exported, so it is restated here.
 */
interface WreckController {
 position: THREE.Vector3;
 velocity: THREE.Vector3;
 facing: number;
 groundY: number;
}

/** One hull in the graveyard, after the player's crash. */
interface Wreck {
 hull: Speeder;
 ctl: WreckController;
 active: boolean;
 burnT: number;
 age: number;
 smokeT: number;
 pilotX: number;
 pilotZ: number;
 /** A wreck takes nothing from being struck — `CapsuleOwner`'s contract. */
 stumble?: never;
}

/**
 * A capsule's back-reference, as the pass uses it: an optional `stumble`
 * (which `colliders.ts`'s `CapsuleOwner` declares, and both a model and a
 * wreck slot answer differently to) plus the world pose the stumble's side
 * carry `ctl` instead — so the pose is read defensively here.
 */
interface CapsuleRef extends CapsuleOwner {
 position?: { x: number, y: number, z: number };
 yaw?: number;
}

/** A parked hull: the world point the player left it at. */
interface ParkedPoint { x: number, y: number, z: number }

/** Everything the pass reacts through; all optional so boot can stub a module. */
interface CollisionCtx {
 character?: CharacterController | null;
 activeCharacter?: (() => CharacterController | null) | null;
 speeder?: Speeder | null;
 parked?: (() => ParkedPoint | null) | null;
 terrain?: Terrain | null;
 spray?: SprayField | null;
 smoke?: SmokeTrails | null;
 rig?: CameraRig | null;
 audio?: AudioEngine | null;
}

/** One craft's collision slot: the sphere's own history, per craft. */
interface CraftSlot {
 wing: Escort | null;
 /** True once a previous position has been recorded. */
 has: boolean;
 /** Where the sphere was at the previous frame. */
 prevX: number; prevY: number; prevZ: number;
 /** Where it is this frame. */
 cx: number; cy: number; cz: number;
 /** Motion over the frame, in XZ and Y. */
 mx: number; my: number; mz: number;
 active: boolean;
 downed: boolean;
 squashT: number;
 fxT: number;
}

/** A contact point on a capsule, as the sweep leaves it. */
interface AxisPoint { x: number, y: number, z: number }

/** Craft collision sphere radius, metres. Deliberately under the T-47's
 *  half-width: a sphere is a fat proxy for a flat hull, and a hit the player
 *  didn't visually earn reads as a bug — while the AT-AT's between-the-legs
 *  corridor (about 3.9 m of daylight at the default scale) must stay
 *  flyable, because that run is the whole point of a snowspeeder. */
const CRAFT_R = 1.6;

/** Wreck capsule: half-length along the hull line and radius, metres. */
const WRECK_HALF = 2.6;
const WRECK_R = 2.2;

/** Metres in one frame past which the move was a placement, not flight.
 *  Both integrators clamp their step to 1/30 s, so the fastest thing here —
 *  a boosted craft at ~57 m/s — covers under 2 m; a respawn covers 480. */
const TELEPORT = 12;

/** Seconds of degraded control a contact buys, by severity. Both maps are
 *  keyed by a severity string produced upstream (`speederImpactResponse` is
 *  untyped, so `severity` is `any` there), which is why the keys are narrowed
 *  at the use sites rather than declared as a union the compiler can't see. */
const SCRAMBLE: Record<string, number> = { scrape: 0, hit: 0.9, crash: 2.0 };

/** Player camera trauma per severity — the player feels their own hits only. */
const TRAUMA: Record<string, number> = { scrape: 0.12, hit: 0.35, crash: 0.9 };

/** The field-repair burn after the ladder trips, seconds. */
const PLAYER_BURN = 20;

const PLAYER_GRACE = 4;

/**
 * Seconds lying in the snow before the run starts again.
 *
 * Long, on purpose. The camera spends them circling the wreck — at the crash
 * cam's rate that is comfortably more than a full turn — and there is
 * something to look at: the hull sunk to its skids and burning, the pilot
 * thrown clear of the skid line, the crater, and the machines walking on past
 * it. A crash the player is hurried away from may as well not have happened.
 */
const RECOVER = 9.0;

/** Seconds between a craft's scrape effects — see `_contactFx`. */
const SCRAPE_GAP = 0.22;

/**
 * The capsule kinds that are an Imperial machine's own body — the legs, the
 * belly and the head of an AT-AT, and the AT-ST's single pill. A craft
 * striking one of these makes a *different noise* from a craft striking
 * anything else: armour plate and servo, not the fuel-and-fire report of a
 * hull going in. `wreck` is deliberately absent — a wreck is a dead
 * snowspeeder, so hitting one is speeder-on-speeder and keeps the old sound.
 * A Set rather than a chain of `===` so adding a kind is one edit, and it is
 * built once at module scope, never per contact.
 */
const MACHINE_KINDS = new Set(["leg", "body", "head", "machine"]);

/**
 * Gain for the hull strike by severity. `speeder-hit-model.mp3` is a single
 * dry impact with no tail, so unlike the explosion it can be leaned on: a
 * glancing 'hit' is under half a full one, and a 'crash' into a leg is the
 * whole sample. Scrapes stay silent — the snow spray is the scrape.
 */
const HULL_SFX_GAIN = { hit: 0.45, crash: 1.0 };

/** Metres to nothing for the cannons' own report — the reference reach every
 *  local noise borrows, and what the dry hull strike uses. */
const SHOT_AUDIBLE = 420;

/** …and for an airframe exploding, which carries further. See `_bang`. */
const CRASH_AUDIBLE = 900;
/** Seconds into `speeder-crash-3.mp3` at which it hits the ground, and how
 *  long the player's fall takes (`CRASH_FALL_T` in the controller). The
 *  difference is how late the sample is fired so the two coincide. */
const CRASH_SFX_IMPACT = 1.8;
const CRASH_FALL = 2.1;

/** Squared metres of vertical clearance below which the Pythagoras corridor
 *  answer is abandoned and the craft is counted as having cleared the capsule
 *  vertically. One hundredth of a millimetre squared — it is the epsilon on
 *  `reach² − dy²` being zero, not a distance anything can feel. */
const VERTICAL_EPS2 = 1e-4;

/** Metres of extra clearance the depenetration leaves between the craft's
 *  sphere and the capsule it just pushed it out of. A hair, but it is the
 *  difference between starting next frame clear and starting it touching. */
const EASE_OUT = 0.05;

/** Fraction of the shortest way out that a craft already sphere-in-sphere with
 *  another gives when it starts its response. See `_sweepPair`. */
const ALREADY_TOUCHING = 0.5;

/** Fraction of the hover ease past which a craft counts as flying and takes
 *  part in collisions at all. Half the ease: the craft is airborne, not
 *  standing — anything less is the ease still climbing or the hull settling. */
const SURFING = 0.5;

/** Multiplier that widens the severity thresholds a craft-on-craft contact is
 *  a scrape off a craft should need more closing speed to count as a hit. */
const CRAFT_FORGIVENESS = 1.2;

/** Severity to spray count. Scrapes get a light dusting, a crash a full
 *  burst. One lookup, asked once per contact. */
const SPRAY_BY_SEVERITY: Record<string, number> = { crash: 10, hit: 6, scrape: 4 };

/** The snow-and-sparks burst thrown off a contact, in `SprayField.emit`
 *  arguments — metres, m/s, seconds. One row per quantity, velocities first:
 *  the cone the particles leave along, the speed they leave at, and the size
 *  and life they are born with. */
const SCRAPE_SPRAY = {
 /** Lateral scatter of the spawn point from the contact, metres ±. */
 SPAWN_SPREAD: 0.6,
 /** How fast the cone's own axis carries them, m/s. */
 OUT: 2,
 /** …and the spread of speed across the cone's mouth, m/s. */
 OUT_JITTER: 5,
 /** Sideways throw off the normal, m/s. */
 SIDEWAYS: 1.6,
 /** Upward speed, m/s. */
 RISE: 1.5,
 /** …and its spread, m/s. */
 RISE_JITTER: 3.5,
 /** Particle size at birth, metres. */
 SIZE: 0.06,
 /** …and its spread, metres. */
 SIZE_JITTER: 0.09,
 /** Lifetime, seconds. */
 LIFE: 0.5,
 /** …and its spread, seconds. */
 LIFE_JITTER: 0.6,
 /** Fraction of the burst born as white hot rather than grey snow. */
 HOT_CHANCE: 0.5,
 /** Air drag on the particle, per second. */
 DRAG: 1.4,
};

/** The smoke puffs shed by a normal 'hit' — `SmokeTrails.emit` arguments in
 *  metres, m/s and seconds. A short-lived grey plume climbing off the hull. */
const HIT_SMOKE = {
 /** Extra height over the contact where the puff is born, metres. */
 LIFT: 0.2,
 /** Lateral spread of the birth point, metres ±. */
 SPAWN_SPREAD: 4,
 /** Upward speed, m/s. */
 RISE: 1,
 /** …and its spread, m/s. */
 RISE_JITTER: 2,
 /** Particle size at birth, metres. */
 SIZE: 0.45,
 /** Growth per second, metres per second. */
 GROW: 1.2,
 /** Lifetime, seconds. */
 LIFE: 0.6,
 /** …and its spread, seconds. */
 LIFE_JITTER: 0.3,
 /** Opacity it fades to over that life, 0..1. */
 ALPHA: 0.5,
};

/** Puffs shed per 'hit' contact — a short plume, not a fireball. */
const HIT_PUFFS = 3;

/** The floor a scrape's trauma is scaled to, as a fraction of the full
 *  `TRAUMA.scrape` — a graze that barely closed on the machines still has to
 *  register, or holding the stick into a leg stops feeling like anything. */
const SCRAPE_TRAUMA_FLOOR = 0.15;

/** Grey, in 0..1 — the values `HIT_SMOKE` never bothers to say because they
 *  are the whole reason smoke is smoke and not fire. */
const SMOKE_GREY = 0.09;

/** The fuel-and-fire report a soft 'hit' on another craft plays at, as a
 *  hull going in, and it is played slightly faster for a lighter ring. */
const SPEEDER_HIT_GAIN = 0.25;
const SPEEDER_HIT_RATE = 1.1;

/** Metres above the gravestone's `groundY` that a wreck's capsule sits. The
 * hull is lying in the snow, not hovering — the offset puts the segment
 * through the body where the player's sphere should meet it. */
const WRECK_HOVER = 1.0;

/** The parked snowspeeder's collision capsule, metres: it hangs from `parked()`
 *  down to the hull, so its lower end is that far below the craft and its top
 *  end is a stretch above it. Radius is a separate constant below. */
const PARKED_LO = 1.0;
const PARKED_HI = 2.0;
/** Radius of the parked capsule, metres — same as the wreck's, because it is
 *  the same hull lying in the same snow. */
const PARKED_R = 2.0;

/** The two deformation stamps a landing leaves in the snow. Each row is one
 *  `terrain.deform.brush` call's arguments, in the order the function takes
 *  them: (x, z, radius, depth, berm, compression, ice, yaw, elongation,
 *  edge) — so the field names below are the brush's own parameter names and
 *  the meaning of each lives in the comment beside it. */
const CRATER_BRUSH = {
 /** Radius of the hole the hull dug, metres. */
 RADIUS: 3.4,
 /** Depth of the depression at the centre, metres. */
 DEPTH: 0.85,
 /** Metres of displaced mass thrown up onto the rim. */
 BERM: 0.6,
 /** Snow packed tighter inside the dent, 0..1. */
 COMPRESSION: 1.0,
 /** Frozen glazing left on the walls, 0..1. */
 ICE: 0.6,
 /** Orient of the long axis, radians — the crater is round, so any free. */
 YAW: 0,
 /** Long-axis multiple of the radius, 1 = round. */
 ELONGATION: 1.3,
 /** Rim roughness, 0..1 — a clean bevel. */
 EDGE: 1.0,
};

/** The furrow it ploughed getting there, one stroke this far behind the
 *  crater, metres. Same `brush` argument order as the crater. */
const FURROW_BEHIND = 4.5;
const FURROW_BRUSH = {
 RADIUS: 2.4,
 DEPTH: 0.5,
 BERM: 0.55,
 COMPRESSION: 1.0,
 ICE: 0.3,
 ELONGATION: 3.0,
 EDGE: 1.0,
};

/** The splash: a hull's worth of snow thrown up and out. `SprayField.emit`
 *  arguments again — metres, m/s, seconds. */
const CRASH_SPLASH = {
 /** Particles in the burst. */
 COUNT: 60,
 /** Ring the spray is born around the contact, metres. */
 RING: 1.5,
 /** Height over the terrain, metres. */
 LIFT: 0.5,
 /** Outward speed, m/s. */
 OUT: 3,
 /** …and its spread, m/s. */
 OUT_JITTER: 12,
 /** Upward speed, m/s. */
 RISE: 5,
 /** …and its spread, m/s. */
 RISE_JITTER: 11,
 /** Particle size at birth, metres. */
 SIZE: 0.08,
 /** …and its spread, metres. */
 SIZE_JITTER: 0.16,
 /** Lifetime, seconds. */
 LIFE: 0.8,
 /** …and its spread, seconds. */
 LIFE_JITTER: 0.9,
 /** Fraction of the burst born white hot rather than grey snow. */
 HOT_CHANCE: 0.5,
 /** Air drag per second. */
 DRAG: 1.5,
};

/** The smoke column boiling off the crater. Metres, m/s, seconds. */
const CRASH_SMOKE = {
 /** Puffs shed. */
 COUNT: 10,
 /** Lateral spread of the birth point, metres ±. */
 SPAWN_SPREAD: 3,
 /** Height over the terrain, metres. */
 HEIGHT: 1,
 /** …and its spread, metres. */
 HEIGHT_JITTER: 2,
 /** Lateral speed, m/s. */
 DRIFT: 3,
 /** Upward speed, m/s. */
 RISE: 1.5,
 /** …and its spread, m/s. */
 RISE_JITTER: 2.5,
 /** Particle size at birth, metres. */
 SIZE: 2.2,
 /** Growth per second, metres per second. */
 GROW: 1.6,
 /** Growth sign flip: a crash cloud thins as it rises. */
 SHRINK: -0.18,
 /** Lifetime, seconds. */
 LIFE: 5,
 /** …and its spread, seconds. */
 LIFE_JITTER: 3,
 /** Opacity it fades to over that life, 0..1. */
 ALPHA: 0.75,
};

/** Grey in 0..1, and the alpha the crash cloud fades to. */
const FIRE_SMOKE_TINT = 0.07;

/** Rungs on the player's damage ladder. A 'hit' inside grace steps it; the
 *  third rung is the crash, so the count is the ladder's length and not a
 *  number chosen for the min(). */
const LADDER_RUNGS = 3;

/** Damage at which the burning trail starts lighting fires, as a rung number.
 *  Below this it is smoke only: a wounded craft smokes, a *badly* wounded one
 *  flames. */
const TRAIL_FIRE_RUNG = 2;

/** Seconds between damage-trail puffs off a flying hull — also the window the
 *  inherited fall rate is measured over, because each puff reports how far the
 *  hull has dropped since the last one. Metres over this divisor is m/s. */
const PUFF_CADENCE = 0.05;

/** Ceiling on the fall rate the trail inherits, m/s downward. A craft going in
 *  can fall faster than the flame should be dragged, and clamping keeps level
 *  flight its own trail. */
const MAX_INHERITED_FALL = 14;

/** The damage trail's smoke row: metres, m/s, seconds — `SmokeTrails.emit`
 *  arguments. Drag-behind set by `S.burnBackZ`/`S.burnY`; the rest is a slow
 *  grey stream inheriting the hull's own sideways velocity. */
const TRAIL_SMOKE = {
 /** Fraction of the hull's sideways velocity the smoke carries. */
 DRIFT: 0.22,
 /** Lateral scatter at the birth point, metres ±. */
 SPAWN_SPREAD: 0.8,
 /** Upward speed, m/s. */
 RISE: 1.1,
 /** …and its spread, m/s. */
 RISE_JITTER: 0.6,
 /** Particle size at birth, metres. */
 SIZE: 0.5,
 /** …and its spread, metres. */
 SIZE_JITTER: 0.25,
 /** Growth per second, metres per second. */
 GROW: 1.7,
 /** Lifetime, seconds. */
 LIFE: 1.5,
 /** …and its spread, seconds. */
 LIFE_JITTER: 0.7,
 /** Opacity it fades to over that life, 0..1. */
 ALPHA: 0.55,
 /** Grey, 0..1 — the smoke-only tint. */
 TINT: 0.09,
 /** Darker grey, 0..1, when the fire row is lit alongside it: the two rows are
  *  one flame together, so the smoke half dims into it instead of competing. */
 TINT_WITH_FIRE: 0.045,
};

/** …and the fire row, lit only once the ladder is high enough. Same units; a
 *  short-lived hot flame, so it is darker, denser and slower than the smoke. */
const TRAIL_FIRE = {
 /** Height below the smoke row the flame is born, metres. */
 DROP: 0.25,
 /** Fraction of the hull's sideways velocity the flame carries. */
 DRIFT: 0.72,
 /** Lateral scatter at the birth point, metres ±. */
 SPAWN_SPREAD: 1.2,
 /** Upward speed, m/s. */
 RISE: 0.9,
 /** …and its spread, m/s. */
 RISE_JITTER: 0.8,
 /** Particle size at birth, metres. */
 SIZE: 0.62,
 /** …and its spread, metres. */
 SIZE_JITTER: 0.25,
 /** Growth per second, metres per second. */
 GROW: 1.4,
 /** Lifetime, seconds. */
 LIFE: 0.42,
 /** …and its spread, seconds. */
 LIFE_JITTER: 0.2,
 /** Opacity it fades to over that life, 0..1. */
 ALPHA: 0.8,
};

/** The flame's colour, 0..1 per channel — red dominates heavily and falls off
 *  through green to a barely-there blue, so the flame reads as a hot orange
 *  with a white-hot core rather than a clean primary. */
const FIRE_TINT = { R: 3.2, G: 1.05, B: 0.26 };

/** A world point with xyz — what the burn trail's callers hand it. Structural,
 *  so a `THREE.Vector3` (which is what `main.ts` passes) satisfies it without
 *  this module importing THREE. */
interface Vec3 {
 x: number;
 y: number;
 z: number;
}

/** The least of `SmokeTrails` the burn trail needs: one row per puff, in the
 *  order `SmokeTrails.emit` takes. Structural for the same reason as `Vec3`. */
interface SmokeTrailSink {
 emit(
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
  size: number, grow: number, life: number,
  r: number, g: number, b: number,
  a: number, buoyant: boolean
 ): void;
}

/** Fallback for the trail's drag-behind distance when `S.burnBackZ` is unset,
 *  metres. */
const BURN_BACK_DEFAULT = 2.4;

/** …and for its height over the drawn hull, `S.burnY`, metres. */
const BURN_LIFT_DEFAULT = 0.95;

/** Metres below the drawn hull where a terrain slam is reported as making
 *  contact. There is no capsule here and no reflection — the floor already ate
 *  the motion — so the snow comes off the belly rather than the point of the
 *  closure, which is what the eye follows. */
const SLAM_BELLY = 1.2;

/** Clamp a scalar into [lo, hi]. `lo > hi` is not a contract this file ever
 *  writes, so the `lo` win on an empty range is left as it falls.
 *  v/lo/hi: dimensionless, metres or seconds — same numbers either way. */
function clamp(v: number, lo: number, hi: number): number {
 if (v < lo) return lo;
 if (v > hi) return hi;
 return v;
}

export class CollisionPass {
 /** Whichever controller is driving this frame — written by `main.ts`. */
 character: CharacterController | null;
 /** Returns the driver, re-read each frame because the toggle swaps it. */
 _activeCharacter: () => CharacterController | null;
 speeder: Speeder | null;
 /** Where the player left their hull parked in the world, if anywhere. */
 parked: (() => ParkedPoint | null) | null;
 terrain: Terrain | null;
 spray: SprayField | null;
 smoke: SmokeTrails | null;
 rig: CameraRig | null;
 audio: AudioEngine | null;
 pool: Capsule[];
 /** One record per craft, player first. */
 slots: CraftSlot[];
 /** Candidate contact record, rewritten by every sweep query. */
 _hit: {
  t: number, nx: number, ny: number, nz: number,
  px: number, py: number, pz: number, cap: Capsule | null
 };
 /** Earliest contact so far in the current query. */
 _best: {
  t: number, nx: number, ny: number, nz: number,
  px: number, py: number, pz: number, cap: Capsule | null
 };
 /** The last response `speederImpactResponse` wrote, for the overlay. */
 _res: ImpactResponse;
 /** The point on a capsule axis nearest a query, reused. */
 _axisPt: AxisPoint;
 /** Params bag rewritten every query, never replaced. */
 _params: {
  vx: number, vz: number, speed: number, nx: number, nz: number,
  ovx: number, ovz: number, massRatio: number, hitSide: number,
  restitution: number, hitAt: number, crashAt: number,
 };
 /** The last contact resolved, for the overlay and for tuning. */
 lastImpact: {
  kind: string, severity: string, normalSpeed: number,
  spin: number, player: boolean
 };

 /** Player damage ladder: rungs taken, and the timers running on them. */
 _pDamage: number;
 _pGrace: number;
 _pBurnT: number;
 _pPuffT: number;
 /** Last hull height, for the burn trail's inherited fall rate. */
 _burnPrevY: number | null;
 /** Seconds left lying in the snow; 0 when not crashed. */
 _pRecover: number;

 /**
  * @param {CollisionCtx} ctx everything the pass reacts through; all optional.
  */
 constructor(ctx: CollisionCtx) {
  this.character = ctx.character ?? null;
  this._activeCharacter = ctx.activeCharacter ?? (() => this.character);
  this.speeder = ctx.speeder ?? null;
  this.parked = ctx.parked ?? null;
  this.terrain = ctx.terrain ?? null;
  this.spray = ctx.spray ?? null;
  this.smoke = ctx.smoke ?? null;
  this.rig = ctx.rig ?? null;
  this.audio = ctx.audio ?? null;


  // ------------------------------------------------------ the capsule pool
  // Sized for the worst the sliders can ask for: six capsules per AT-AT
  // (four legs, body, head), one per AT-ST, one per wreck slot, plus
  // slack — nothing grows after this line.
  let cap = 8;
  if (this.parked) cap += 1;
  this.pool = makeCapsulePool(cap);

  // ------------------------------------------------------- the craft slots
  // One record per craft, player first. Prev positions live here — the
  // sweep needs where the craft *was*, and neither controller keeps it.
  /** @type {CraftSlot[]} */
  this.slots = [];
  const slot = (wing: Escort | null) => ({
   wing, has: false, prevX: 0, prevY: 0, prevZ: 0,
   cx: 0, cy: 0, cz: 0, mx: 0, my: 0, mz: 0,
   active: false, downed: false, squashT: 0, fxT: 0,
  });
  this.slots.push(slot(null));

  // ---------------------------------------------------------- scratch
  // Two hit records (candidate and best-so-far), one response, one
  // params bag — rewritten every query, never replaced.
  this._hit = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
  this._best = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
  this._res = { vx: 0, vz: 0, spin: 0, normalSpeed: 0, severity: "scrape" };
  this._axisPt = { x: 0, y: 0, z: 0 };
  this._params = {
   vx: 0, vz: 0, speed: 0, nx: 0, nz: 0, ovx: 0, ovz: 0,
   massRatio: Infinity, hitSide: 0, restitution: 0.35,
   hitAt: 7, crashAt: 17,
  };

  /** The last contact resolved, for the overlay and for tuning: what
   *  was hit, how hard it closed, and what that bought. Read-only. */
  this.lastImpact = {
   kind: "", severity: "", normalSpeed: 0, spin: 0, player: false,
  };

  // ------------------------------------------------ player damage ladder
  this._pDamage = 0;
  this._pGrace = 0;
  this._pBurnT = 0;
  this._pPuffT = 0;
  /** Last hull height, for the burn trail's inherited fall rate. */
  this._burnPrevY = null;
  /** Seconds left lying in the snow; 0 when not crashed. */
  this._pRecover = 0;
 }

 /** @param {number} dt seconds; clamped to 1/30 like the craft integrators. */
 update(dt: number) {
  // The player's own crash runs on its own clock, above BOTH guards —
  // the freeze-time short-circuit and the collisions toggle. It is the
  // only path back to `endCrash`, so a crash interrupted by flipping
  // the overlay's collisions switch must still reach the ground and
  // hand the craft back, or the player is locked out of their own
  // craft forever.
  this._playerCrash(Math.min(dt, 1 / 30));
  // `S.collisions` is a boolean toggle; falsy is off.
  if (!S.collisions) {
   // Off is off: forget the prev positions so re-enabling does not
   // sweep a teleport's worth of motion through the field.
   for (const s of this.slots) s.has = false;
   return;
  }
  const h = Math.min(dt, 1 / 30);
  this._ladderUpkeep(h);
  if (h <= 1e-6) return; // freeze-time: nothing moved, nothing can hit

  this._rebuildPool();
  this._refreshSlots();

  for (const s of this.slots) {
   if (!s.active) continue;
   s.squashT = Math.max(0, s.squashT - h);
   s.fxT = Math.max(0, s.fxT - h);
   // A craft that is already dying is the crash sequence's, not
   // ours. Its ballistic is a scripted line into the snow — the
   // whole point of it is that nothing steers it any more — and a
   // kill usually happens *against* a capsule, so sweeping it would
   // bounce the corpse off the machine that killed it, re-fire the
   // fireball every frame it stayed embedded, and move the wreck.
   if (s.downed) continue;
   this._sweepWorld(s);
  }

  // Craft on craft — every pair, both sides responding, the downed and
  // the absent excluded.
  for (let i = 0; i < this.slots.length; i++) {
   const a = this.slots[i];
   if (!a.active || a.downed) continue;
   for (let j = i + 1; j < this.slots.length; j++) {
    const b = this.slots[j];
    if (!b.active || b.downed) continue;
    this._sweepPair(a, b);
   }
  }


  this._terrainSlam();

  // The corrected positions become next frame's starting line.
  for (const s of this.slots) {
   if (!s.active) continue;
   s.prevX = s.cx; s.prevY = s.cy; s.prevZ = s.cz;
  }
 }

 // ------------------------------------------------------------ frame setup

 _rebuildPool() {
  const pool = this.pool;
  let k = 0;
  if (this.parked) {
   const p = this.parked();
   if (p && k < pool.length) {
    const c = pool[k++];
    c.ax = p.x; c.ay = p.y - PARKED_LO; c.az = p.z;
    c.bx = p.x; c.by = p.y + PARKED_HI; c.bz = p.z;
    c.r = PARKED_R;
    c.kind = "wreck";
    c.owner = null;
    c.live = true;
   }
  }
  for (let i = k; i < pool.length; i++) pool[i].live = false;
 }

 /** Who is flying this frame, and where their sphere centre sits. */
 _refreshSlots() {
  for (const s of this.slots) {
   if (s.wing === null) {
    // The player's sphere rides the controller's XZ and the drawn
    // hull's Y — the hover ease is what the eye sees hit things.
    const c = this._activeCharacter();
    const on = !!c && !!this.speeder && S.speeder === true && c.surf > SURFING;
    s.active = on;
    // Mid-crash the craft is the fall's, exactly as a downed
    // scripted, and bouncing it off the machine that just killed
    // it would fight the very sequence that machine started.
    if (on && c.crashing) {
     s.downed = true;
     s.cx = c.position.x;
     s.cy = c.position.y;
     s.cz = c.position.z;
     s.has = false;
     continue;
    }
    s.downed = false;
    if (on) {
     s.cx = c.position.x;
     // The sphere rides the drawn hull's Y: the hover ease is what the eye
     // sees hit things, and the controller's own Y is the smooth path.
     s.cy = this.speeder!.position.y;
     s.cz = c.position.z;
    }
    if (!s.active) { s.has = false; continue; }
   }
   if (!s.has) {
    // the overlap branch still depenetrates a bad spawn.
    s.prevX = s.cx; s.prevY = s.cy; s.prevZ = s.cz;
    s.has = true;
   }
   s.mx = s.cx - s.prevX; s.my = s.cy - s.prevY; s.mz = s.cz - s.prevZ;
   // its crash site, the opening flyover restages the flight, and
   // the console can put the player anywhere — swept as travel, any
   // of those drags a segment across the whole battle line and
   // "hits" the first machine it crosses, which would then yank the
   // craft back to it. Nothing under power covers TELEPORT metres in
   // one clamped frame, so anything that does is a placement, and a
   // placement starts a fresh sweep from where it landed.
   if (s.mx * s.mx + s.my * s.my + s.mz * s.mz > TELEPORT * TELEPORT) {
    s.prevX = s.cx; s.prevY = s.cy; s.prevZ = s.cz;
    s.mx = 0; s.my = 0; s.mz = 0;
   }
  }
 }

 // ---------------------------------------------------------- world contacts

 /** Sweep one craft against every live capsule; resolve the earliest. */
 /** @param {CraftSlot} s */
 _sweepWorld(s: CraftSlot) {
  const pool = this.pool;
  const hit = this._hit, best = this._best;
  let found = false;
  for (let i = 0; i < pool.length; i++) {
   const cap = pool[i];
   if (!cap.live) continue;
   if (!sweptSphereVsCapsule(
    s.prevX, s.prevY, s.prevZ, s.mx, s.my, s.mz, cap, CRAFT_R, hit
   )) continue;
   if (!found || hit.t < best.t) {
    best.t = hit.t;
    best.nx = hit.nx; best.ny = hit.ny; best.nz = hit.nz;
    best.px = hit.px; best.py = hit.py; best.pz = hit.pz;
    best.cap = hit.cap;
    found = true;
   }
  }
  if (!found) return;

  const ctl = s.wing ? s.wing.pilot : this._activeCharacter();
  if (!ctl) return;
  const vel = ctl.velocity;

  // Both craft own their own height — the hover floor and the climb
  // ladder write y every frame and would undo anything put there — so
  // the resolution plane is XZ, and a contact has to be answered
  // *sideways* or not at all.
  //
  // Which means the 3D normal is the wrong push direction: under an
  // AT-AT's belly it points straight down, and its horizontal share is
  // a rounding error. The honest question is how far out from the
  // capsule's *axis* the craft has to stand to clear it at the height
  // it is flying, and Pythagoras answers it: with the craft dy below
  // the axis, the horizontal clearance needed is
  // sqrt(reach² − dy²) — zero once dy alone already clears, which is
  // exactly the under-belly corridor granting itself.
  const cap = best.cap;
  if (!cap) return;
  const reach = cap.r + CRAFT_R;
  const closest = this._closestOnAxis(cap, s.cx, s.cy, s.cz);
  const dy = s.cy - closest.y;
  const need2 = reach * reach - dy * dy;
  if (need2 <= VERTICAL_EPS2) return; // cleared vertically: the corridor holds
  const need = Math.sqrt(need2);

  // The way out is radially away from the axis, in the ground plane.
  let nx = s.cx - closest.x, nz = s.cz - closest.z;
  let nl = Math.hypot(nx, nz);
  if (nl < 1e-4) {
   // Dead on the axis: back out the way the craft came in.
   const vl = Math.hypot(vel.x, vel.z);
   if (vl > 1e-4) { nx = -vel.x / vl; nz = -vel.z / vl; }
   else { nx = 1; nz = 0; }
   nl = 0;
  } else { nx /= nl; nz /= nl; }

  if (nl < need) {
   const outX = closest.x + nx * (need + EASE_OUT);
   const outZ = closest.z + nz * (need + EASE_OUT);
   ctl.position.x = outX;
   ctl.position.z = outZ;
   s.cx = outX; s.cz = outZ;
  }

  // The obstacle's own ground velocity — a model striding into you
  // closes faster than the speedometer says.
  let ovx = 0, ovz = 0;
  const wk = best.cap ? best.cap.owner : null;

  const res = this._respond(
   ctl, vel, nx, nz, ovx, ovz, Infinity,
   best.px, best.pz, S.impactHit, S.impactCrash
  );
  const li = this.lastImpact;
  li.kind = cap.kind; li.severity = res.severity;
  li.normalSpeed = res.normalSpeed; li.spin = res.spin;
  li.player = s.wing === null;

  // The model feels it too — as a beat, never as a shove. Nudged away
  // which is gone, so a wreck reads nothing and takes no stumble.
  const pose = wk as CapsuleRef | null;
  if (pose && pose.position && pose.yaw !== undefined
   && typeof pose.stumble === "function") {
   const rightward = (best.px - pose.position.x) * Math.cos(pose.yaw)
    - (best.pz - pose.position.z) * Math.sin(pose.yaw);
   pose.stumble(res.normalSpeed / 25, rightward > 0 ? -1 : 1);
  }

  this._contactFx(
   res.severity, best.px, best.py, best.pz, s.wing === null, nx, nz,
   s, res.normalSpeed, cap.kind
  );
  if (s.wing === null) {
   if (res.severity !== "scrape") this._playerLadder(res.severity);
  }
 }

 /**
  * The point on a capsule's axis nearest a world point — the reference
  * every planar clearance question is asked against. Written into one
  * reused record.
  */
 /** @param {Capsule} cap @param {number} x @param {number} y @param {number} z */
 _closestOnAxis(cap: Capsule, x: number, y: number, z: number) {
  const ex = cap.bx - cap.ax, ey = cap.by - cap.ay, ez = cap.bz - cap.az;
  const len2 = ex * ex + ey * ey + ez * ez;
  let t = 0;
  if (len2 > 1e-8) {
   t = clamp(
    ((x - cap.ax) * ex + (y - cap.ay) * ey + (z - cap.az) * ez) / len2,
    0, 1
   );
  }
  const out = this._axisPt;
  out.x = cap.ax + ex * t;
  out.y = cap.ay + ey * t;
  out.z = cap.az + ez * t;
  return out;
 }

 // ------------------------------------------------------------ craft pairs

 /** Sphere-sphere sweep between two craft; both sides respond. */
 /** @param {CraftSlot} a @param {CraftSlot} b */
 _sweepPair(a: CraftSlot, b: CraftSlot) {
  const hit = this._hit;
  if (!sweptSphereVsSphere(
   a.prevX, a.prevY, a.prevZ,
   a.mx - b.mx, a.my - b.my, a.mz - b.mz,
   b.prevX, b.prevY, b.prevZ, CRAFT_R, CRAFT_R, hit
  )) return;
  const ctlA = a.wing ? a.wing.pilot : this._activeCharacter();
  const ctlB = b.wing ? b.wing.pilot : this._activeCharacter();
  // Either side without a controller has nowhere to write the response.
  if (!ctlA || !ctlB) return;

  // Horizontal normal away from B toward A.
  let nx = hit.nx, nz = hit.nz;
  const nl = Math.hypot(nx, nz);
  if (nl < 1e-4) { nx = 1; nz = 0; } else { nx /= nl; nz /= nl; }

  // Overlapping already: shoulder them apart evenly, planar only.
  if (hit.t === 0) {
   const dx = a.cx - b.cx, dz = a.cz - b.cz;
   const d = Math.hypot(dx, dz);
   const need = (CRAFT_R * 2 - d) * ALREADY_TOUCHING + EASE_OUT;
   if (need > 0) {
    ctlA.position.x += nx * need; ctlA.position.z += nz * need;
    ctlB.position.x -= nx * need; ctlB.position.z -= nz * need;
    a.cx = ctlA.position.x; a.cz = ctlA.position.z;
    b.cx = ctlB.position.x; b.cz = ctlB.position.z;
   }
  }

  // Equal mass, both sides: each craft runs its own response with the
  // other's velocity as the obstacle's, and thresholds a fifth kinder —
  // two hulls glancing off each other is drama, not a wall.
  const hitAt = S.impactHit * CRAFT_FORGIVENESS, crashAt = S.impactCrash * CRAFT_FORGIVENESS;
  const avx = ctlA.velocity.x, avz = ctlA.velocity.z;
  const bvx = ctlB.velocity.x, bvz = ctlB.velocity.z;
  const resA = this._respond(
   ctlA, ctlA.velocity, nx, nz, bvx, bvz, 1, hit.px, hit.pz, hitAt, crashAt
  );
  const sev = resA.severity;
  this._respond(
   ctlB, ctlB.velocity, -nx, -nz, avx, avz, 1, hit.px, hit.pz, hitAt, crashAt
  );

  this._contactFx(
   sev, hit.px, hit.py, hit.pz,
   a.wing === null || b.wing === null, nx, nz,
   a.wing === null ? a : b, resA.normalSpeed, "craft"
  );
  if (a.wing === null || b.wing === null) {
   if (sev !== "scrape") this._playerLadder(sev);
  }
  if (a.wing?.collisionHit) a.wing.collisionHit(sev, hit.px, hit.py, hit.pz);
  if (b.wing?.collisionHit) b.wing.collisionHit(sev, hit.px, hit.py, hit.pz);
 }

 // ------------------------------------------------------- shared machinery

 /** Fill the params bag, run the impact math, apply it to the craft.
  * @param {Respondable} ctl @param {THREE.Vector3} vel
  * @param {number} nx @param {number} nz @param {number} ovx @param {number} ovz
  * @param {number} massRatio @param {number} px @param {number} pz
  * @param {number} hitAt @param {number} crashAt */
 _respond(ctl: Respondable, vel: THREE.Vector3, nx: number, nz: number,
  ovx: number, ovz: number, massRatio: number, px: number, pz: number,
  hitAt: number, crashAt: number) {
  const p = this._params;
  p.vx = vel.x; p.vz = vel.z;
  p.speed = Math.hypot(vel.x, vel.z);
  p.nx = nx; p.nz = nz;
  p.ovx = ovx; p.ovz = ovz;
  p.massRatio = massRatio;
  // The lever arm: the contact's lateral offset in the craft's frame,
  // over the sphere radius — starboard positive, port negative.
  const f = ctl.facing ?? 0;
  p.hitSide = clamp(
   ((px - ctl.position.x) * Math.cos(f)
    - (pz - ctl.position.z) * Math.sin(f)) / CRAFT_R,
   -1, 1
  );
  p.restitution = S.impactBounce;
  p.hitAt = hitAt;
  p.crashAt = crashAt;
  const res = speederImpactResponse(this._res, p);
  ctl.applyImpact(
   res.vx, res.vz,
   res.spin * S.impactSpin,
   // `severity` is one of three literals by construction; String() only
   // narrows the type, the value is untouched.
   SCRAMBLE[String(res.severity)]
  );
  return res;
 }

 /**
  * The look and the sound of a contact, by severity. Trauma is the
  *
  * A contact is not an event so much as a state: hold the stick into a
  * leg and the resolver re-contacts every second or third frame for as
  * long as you lean on it. Left alone that pays trauma several times a
  * second against a 1.15/s decay, so a *scrape* — a deflection and some
  * snow, by definition the mildest thing here — would shake the camera
  * harder than a crash and stream particles the whole time. So the
  * gentle end is rate-limited per craft and its trauma scales with the
  * closing speed that earned it; a real hit or crash always speaks,
  * because those separate the hulls and cannot repeat.
  *
  * `kind` is what was struck — the capsule's kind for a world contact,
  * `"craft"` for hull-on-hull, `"terrain"` for a slam. It picks the voice
  * and nothing else: hitting an Imperial machine is a metal strike
  * (`speederHitModel`), while another speeder, a wreck or a rising face
  * of ice is the old fuel-and-fire report (`speederCrash`). The look of
  * the contact — snow, smoke, fire — does not care what was hit.
  *
  * @param {Severity} sev
  * @param {number} px @param {number} py @param {number} pz contact point
  * @param {boolean} isPlayer whether the player's own hull was struck
  * @param {number} nx @param {number} nz unit normal, away from the obstacle
  * @param {CraftSlot} slot the craft that felt it, for per-craft rate limits
  * @param {number} closing m/s the two closed at
  * @param {string} kind what was struck; see `MACHINE_KINDS`
  */
 _contactFx(sev: Severity, px: number, py: number, pz: number, isPlayer: boolean,
  nx: number, nz: number, slot: CraftSlot, closing: number, kind: string) {
  if (sev === "scrape") {
   if (slot.fxT > 0) return;
   slot.fxT = SCRAPE_GAP;
  }
  if (isPlayer) {
   const t = sev === "scrape"
    ? TRAUMA.scrape * clamp((closing ?? 0) / S.impactHit, SCRAPE_TRAUMA_FLOOR, 1)
    // `sev` is one of three literals by construction; String() only narrows
    // the type, the value is untouched.
    : TRAUMA[String(sev)];
   this.rig?.addTrauma(t);
  }
  // A kick of snow and sparks off the contact, thrown along the normal.
  if (this.spray) {
   const n = SPRAY_BY_SEVERITY[String(sev)] ?? SPRAY_BY_SEVERITY.scrape;
   for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const out = SCRAPE_SPRAY.OUT + Math.random() * SCRAPE_SPRAY.OUT_JITTER;
    this.spray.emit(
     px + (Math.random() - 0.5) * SCRAPE_SPRAY.SPAWN_SPREAD,
     py + (Math.random() - 0.5) * SCRAPE_SPRAY.SPAWN_SPREAD,
     pz + (Math.random() - 0.5) * SCRAPE_SPRAY.SPAWN_SPREAD,
     nx * out + Math.cos(a) * SCRAPE_SPRAY.SIDEWAYS,
     SCRAPE_SPRAY.RISE + Math.random() * SCRAPE_SPRAY.RISE_JITTER,
     nz * out + Math.sin(a) * SCRAPE_SPRAY.SIDEWAYS,
     SCRAPE_SPRAY.SIZE + Math.random() * SCRAPE_SPRAY.SIZE_JITTER,
     SCRAPE_SPRAY.LIFE + Math.random() * SCRAPE_SPRAY.LIFE_JITTER,
     Math.random() < SCRAPE_SPRAY.HOT_CHANCE ? 1 : 0, SCRAPE_SPRAY.DRAG
    );
   }
  }
  // Armour or airframe? One question, asked once, answered for both rungs.
  const hull = MACHINE_KINDS.has(kind ?? "");
  if (sev === "hit") {
   if (hull) this._bang(px, pz, HULL_SFX_GAIN.hit, 1.0, "speederHitModel");
   else this._bang(px, pz, SPEEDER_HIT_GAIN, SPEEDER_HIT_RATE);
   if (this.smoke) {
    for (let i = 0; i < HIT_PUFFS; i++) {
     this.smoke.emit(
      px, py + HIT_SMOKE.LIFT, pz,
      (Math.random() - 0.5) * HIT_SMOKE.SPAWN_SPREAD,
      HIT_SMOKE.RISE + Math.random() * HIT_SMOKE.RISE_JITTER,
      (Math.random() - 0.5) * HIT_SMOKE.SPAWN_SPREAD,
      HIT_SMOKE.SIZE, HIT_SMOKE.GROW,
      HIT_SMOKE.LIFE + Math.random() * HIT_SMOKE.LIFE_JITTER,
      SMOKE_GREY, SMOKE_GREY, SMOKE_GREY, HIT_SMOKE.ALPHA, true
     );
    }
   }
  } else if (sev === "crash") {
   // A crash that is about to trip the player's ladder hands its
   // burst to `_trip` — otherwise one contact detonates two
   // fireballs from a three-slot pool and starts the same 6.4 s
   // recording twice in one frame. The metal strike stays: armour
   // rings first, then the fuel goes.
   const trips = isPlayer && this._pBurnT <= 0;
   if (hull) this._bang(px, pz, HULL_SFX_GAIN.crash, 1.0, "speederHitModel");
   else if (!trips) this._bang(px, pz, 1.0, 1.0);
  }
 }

 /**
  * The contact report, at the level and delay its distance earns — the
  * one place in this file that speaks, so the distance model is written
  * once and every voice obeys it.
  *
  * The model is the model cannons', to the letter, because the ear has
  * to be able to place a crash against the artillery it is standing in:
  * `near` falls linearly to nothing at 420 m and is then **cubed**, which
  * is the whole point — a squared falloff still reads as loud from half
  * the field away, and the battle line is a kilometre wide. The delay is
  * honest: 343 m/s, capped at 1.6 s so a distant hit is still recognisably
  * that hit and not a stray noise a beat later.
  *
  * The one place it departs from the cannons is the *reach*, and only for
  * the explosion: a chin cannon stops mattering at 420 m, but a craft
  * coming apart is the loudest thing out there, so it carries to
  * `CRASH_AUDIBLE`. The curve is identical either way — a far one is
  * faint, which is the whole ask — it simply does not fall off a cliff at
  * the range the fight is actually fought at. The dry hull strike keeps
  * the cannons' reach, because that is genuinely a local noise.
  *
  * @param {number} px @param {number} pz world contact, XZ
  * @param {number} gain pre-distance level, 0..1
  * @param {number} rate playback rate
  * @param {string} [key] manifest key; the fuel-and-fire report by default
  * @param {number} [lead] extra delay, seconds
  */
 _bang(px: number, pz: number, gain: number, rate: number, key = "speederCrash", lead = 0) {
  if (!this.audio || !this.character) return;
  const d = Math.hypot(
   px - this.character.position.x, pz - this.character.position.z
  );
  const audible = key === "speederCrash" ? CRASH_AUDIBLE : SHOT_AUDIBLE;
  const near = Math.max(0, 1 - d / audible);
  if (near <= 0) return; // out of earshot: do not spend a voice on it
  this.audio.play(key, {
   gain: gain * near * near * near,
   rate,
   delay: lead + Math.min(1.6, d / 343),
  });
 }

 // ---------------------------------------------------------- trooper squash

 // ------------------------------------------------------------ terrain slam

 /**
  * The controller publishes one frame of {closing, nx, nz} when the hover
  * floor absorbed a hard vertical closure — flying into a rising face.
  * There is no capsule and no reflection (the floor already ate the
  * motion); what is left to do is the *consequence*: severity from the
  * closing speed, the same fx path as every other contact, and a crash joins the
  * player's ladder like every other crash.
  */
 _terrainSlam() {
  const c = this._activeCharacter();
  const slam = c?.terrainSlam;
  // Plain truthiness on the toggle: `S.speeder` is a boolean, and `!x` is the
  // honest read. `!== true` would additionally demand the value is not merely
  // truthy but exactly `true`, which is a different question — and one that
  // silently fails for anything else the toggle could ever hold.
  if (!slam || !this.speeder || !S.speeder) return;
  const sev = severityFor(slam.closing, S.impactHit, S.impactCrash);
  const hull = this.speeder.position;
  this._contactFx(
   sev, hull.x, hull.y - SLAM_BELLY, hull.z, true, slam.nx, slam.nz,
   this.slots[0], slam.closing, "terrain"
  );
  if (sev !== "scrape") {
   c.applyImpact(c.velocity.x, c.velocity.z, 0, SCRAMBLE[sev]);
  }
  if (sev === "crash") this._playerLadder("crash");
  c.terrainSlam = null;
 }

 // ---------------------------------------------------- player damage ladder

 /**
  * 'hit' steps the ladder inside a grace window; 'crash' trips it
  * outright. Tripping is once — while the twenty-second burn runs, further
  * crashes are already part of the fire.
  */
 /** @param {Severity} sev */
 _playerLadder(sev: Severity) {
  if (this._pBurnT > 0) return;
  if (sev === "crash") { this._trip(); return; }
  if (this._pGrace > 0) return;
  this._pGrace = PLAYER_GRACE;
  this._pDamage = Math.min(LADDER_RUNGS, this._pDamage + 1);
  if (this._pDamage >= LADDER_RUNGS) this._trip();
 }

 /**
  * The third rung — and for the player that is not a damage state, it is
  * the crash.
  *
  * strange game that gave the person holding the controller less. So the
  * burst goes off on the hull in the air, the stick is taken away, and the
  * craft rolls down into the snow on its own clock; `_playerCrash` picks it
  * up from the landing.
  */
 _trip() {
  const c = this._activeCharacter();
  this._pDamage = 3;
  this._pBurnT = PLAYER_BURN;
  this._pGrace = PLAYER_GRACE;
  // The burst volume centres LIFT above the point it is given, so the
  // y is walked down to land it at hull height — same as `onKillHit`.
  const hull = this.speeder ? this.speeder.position : c?.position;
  // The crash, whole, fired once here at the top of the fall.
  //
  // `speeder-crash-3.mp3` is not a report — it is a timeline, with its
  // own impact at 1.8 s. The fall takes CRASH_FALL, so it goes out
  // CRASH_FALL - 1.8 late and its impact lands on the frame the hull
  // actually arrives. Nothing speaks again at the ground: the sample
  // already contains that moment, and a second report on top of it
  // would smear the one thing it exists to punctuate.
  if (hull) {
   this._bang(
    hull.x, hull.z, 1.0, 1.0, "speederCrash3",
    Math.max(0, CRASH_FALL - CRASH_SFX_IMPACT)
   );
  }
  this.rig?.addTrauma(1);
  // Which way it rolls in: keep whatever the impact was already turning
  // the nose, so the tumble is a continuation of the hit and not a new
  // idea the craft had.
  if (c) c.beginCrash?.(Math.sign(c.impactSpin) || 0);
 }

 /**
  * The player's crash, from the moment the snow arrives to the moment they
  * have a craft again.
  *
  * crater, the trench it ploughed getting there, a wall of snow — and then
  * a beat of lying in it, because a crash that hands control straight back
  * is not a crash, it is a stumble. `RECOVER` later the craft is flying
  * again from where it fell, nose along its old line, and the ladder is
  * clear.
  *
  * @param {number} h clamped seconds
  */
 _playerCrash(h: number) {
  const c = this._activeCharacter();
  if (!c) return;

  if (c.crashLanded && this._pRecover <= 0) {
   c.crashLanded = false;
   this._pRecover = RECOVER;
   const x = c.position.x, z = c.position.z;
   const y = (this.terrain?.heightAt(x, z) ?? c.position.y);
   const facing = c.facing;

   // No report here — see `_trip`. The crash sample started at the
   // top of the fall and its own impact is landing on this frame.
   this.rig?.addTrauma(1);
   // The hull stays where it died, and the pilot beside it — the
   // went in looks the same whoever was flying it. The player's own
   // craft is about to be re-staged miles away, so what is left
   // here reads as the ship they just lost.
   //
   // And the player's own hull goes away as the wreck arrives. They
   // occupy the same metre of snow for the length of the wait, and
   // two snowspeeders lying in one crater is the giveaway that one
   // of them is a prop. The wreck is the one that stays, because it
   // is the one that keeps burning, frosting, and standing there
   // after the run has started again.

   // The scar: the hole it made and the furrow behind it.
   const cb = CRATER_BRUSH;
   this.terrain?.deform?.brush?.(
    x, z, cb.RADIUS, cb.DEPTH, cb.BERM, cb.COMPRESSION, cb.ICE,
    cb.YAW, cb.ELONGATION, cb.EDGE
   );
   const fb = FURROW_BRUSH;
   this.terrain?.deform?.brush?.(
    x - Math.sin(facing) * FURROW_BEHIND, z - Math.cos(facing) * FURROW_BEHIND,
    fb.RADIUS, fb.DEPTH, fb.BERM, fb.COMPRESSION, fb.ICE,
    facing, fb.ELONGATION, fb.EDGE
   );

   // The splash: a hull's worth of snow thrown up and out.
   if (this.spray) {
    for (let i = 0; i < CRASH_SPLASH.COUNT; i++) {
     const a = Math.random() * Math.PI * 2;
     const out = CRASH_SPLASH.OUT + Math.random() * CRASH_SPLASH.OUT_JITTER;
     this.spray.emit(
      x + Math.cos(a) * CRASH_SPLASH.RING, y + CRASH_SPLASH.LIFT, z + Math.sin(a) * CRASH_SPLASH.RING,
      Math.cos(a) * out,
      CRASH_SPLASH.RISE + Math.random() * CRASH_SPLASH.RISE_JITTER,
      Math.sin(a) * out,
      CRASH_SPLASH.SIZE + Math.random() * CRASH_SPLASH.SIZE_JITTER,
      CRASH_SPLASH.LIFE + Math.random() * CRASH_SPLASH.LIFE_JITTER,
      Math.random() < CRASH_SPLASH.HOT_CHANCE ? 1 : 0, CRASH_SPLASH.DRAG
     );
    }
   }
   if (this.smoke) {
    const s = CRASH_SMOKE;
    for (let i = 0; i < s.COUNT; i++) {
     this.smoke.emit(
      x + (Math.random() - 0.5) * s.SPAWN_SPREAD, y + s.HEIGHT + Math.random() * s.HEIGHT_JITTER,
      z + (Math.random() - 0.5) * s.SPAWN_SPREAD,
      (Math.random() - 0.5) * s.DRIFT, s.RISE + Math.random() * s.RISE_JITTER,
      (Math.random() - 0.5) * s.DRIFT,
      s.SIZE + Math.random() * s.GROW, s.SHRINK, s.LIFE + Math.random() * s.LIFE_JITTER,
      FIRE_SMOKE_TINT, FIRE_SMOKE_TINT, FIRE_SMOKE_TINT, s.ALPHA, true
     );
    }
   }
  }

  if (this._pRecover > 0) {
   this._pRecover = Math.max(0, this._pRecover - h);
   if (this._pRecover === 0) {
    // And then it starts again, properly — not a craft popped
    // back into the air over its own wreck, but the run from the
    // back in to a battle that never stopped without them.
    c.endCrash?.();
    c.velocity.set(0, 0, 0);
    input.riseLevel = 3;
    this._pDamage = 0;
    this._pBurnT = 0;
    this._pGrace = PLAYER_GRACE;
    // A fresh craft, and it is visible again — `onRestart` is
    // what moves it, so this happens before the stage, never
    // leaving a hull to blink at the crash site for a frame.
    // visibility is now managed by onRestart (strand vs respawn)
   }
  }
 }

 /** Grace and burn timers, and the burning trail off the drawn hull. */
 /** @param {number} h clamped seconds */
 _ladderUpkeep(h: number) {
  if (this._pGrace > 0) this._pGrace = Math.max(0, this._pGrace - h);
  if (this._pBurnT > 0) {
   this._pBurnT -= h;
   if (this._pBurnT <= 0) {
    // Field repair: the fire dies and the ladder starts over.
    this._pBurnT = 0;
    this._pDamage = 0;
   }
  }
  // Not while going in, and not while lying in the wreck. The ladder's
  // trail is damage streaming off a craft that is still flying; once
  // the crash owns the sequence the fire belongs to the wreck, which
  // burns on its own. Left running, this kept emitting rising fire for
  // the full twenty seconds from a hull that was hidden and stationary
  // — a fireball climbing out of the snow beside the body, which is
  // exactly what the crash camera is pointed at.
  const crashing = this._activeCharacter()?.crashing || this._pRecover > 0;
  if (!crashing && this._pDamage >= 1 && this.smoke && this.speeder
   && this.character) {
   this._pPuffT -= h;
   if (this._pPuffT <= 0) {
    this._pPuffT = PUFF_CADENCE;
    // The hull's own vertical rate goes into the puff. A craft
    // going in drops ten metres a second, and a flame that only
    // ever rises is left hanging in the air above the wreck —
    // fire floating over an empty patch of snow. Clamped to
    // falling only, so level flight keeps the trail it had.
    const hy = this.speeder.position.y;
    const vy = (hy - (this._burnPrevY ?? hy)) / PUFF_CADENCE;
    this._burnPrevY = hy;
    const ac = this._activeCharacter();
    if (ac) {
     emitBurnTrail(
      this.smoke, this.speeder.position, ac.facing,
      ac.velocity, this._pDamage >= TRAIL_FIRE_RUNG,
      Math.max(-MAX_INHERITED_FALL, Math.min(0, vy))
     );
    }
   }
  }
 }
}
/**
 * The damage trail off a flying hull: a slow grey stream that lightens to fire
 * once the ladder is high enough. Both rows are born `BURN_BACK_DEFAULT`
 * metres behind the drawn hull and inherit its fall rate, so a craft going in
 * drags its flame with it instead of leaving it hanging.
 *
 * smoke: the field to emit into. pos: the drawn hull's world position.
 * facing: hull yaw, radians — the trail streams off the tail along it. vel:
 * the hull's world velocity, m/s. withFire: whether the second, fire row is
 * lit at all. vy: fall rate inherited this frame, m/s (negative is falling).
 */
export function emitBurnTrail(
 smoke: SmokeTrailSink, pos: Vec3, facing: number, vel: Vec3,
 withFire: boolean, vy = 0
) {
 const back = S.burnBackZ ?? BURN_BACK_DEFAULT;
 const lift = S.burnY ?? BURN_LIFT_DEFAULT;
 const bx = pos.x - Math.sin(facing) * back;
 const by = pos.y + lift;
 const bz = pos.z - Math.cos(facing) * back;
 const ts = TRAIL_SMOKE;
 const tint = withFire ? ts.TINT_WITH_FIRE : ts.TINT;
 smoke.emit(
  bx, by, bz,
  vel.x * ts.DRIFT + (Math.random() - 0.5) * ts.SPAWN_SPREAD,
  ts.RISE + Math.random() * ts.RISE_JITTER + vy,
  vel.z * ts.DRIFT + (Math.random() - 0.5) * ts.SPAWN_SPREAD,
  ts.SIZE + Math.random() * ts.SIZE_JITTER, ts.GROW,
  ts.LIFE + Math.random() * ts.LIFE_JITTER,
  tint, tint, tint, ts.ALPHA, true
 );
 if (withFire) {
  const tf = TRAIL_FIRE;
  smoke.emit(
   bx, by - tf.DROP, bz,
   vel.x * tf.DRIFT + (Math.random() - 0.5) * tf.SPAWN_SPREAD,
   tf.RISE + Math.random() * tf.RISE_JITTER + vy,
   vel.z * tf.DRIFT + (Math.random() - 0.5) * tf.SPAWN_SPREAD,
   tf.SIZE + Math.random() * tf.SIZE_JITTER, tf.GROW,
   tf.LIFE + Math.random() * tf.LIFE_JITTER,
   FIRE_TINT.R, FIRE_TINT.G, FIRE_TINT.B, tf.ALPHA, false
  );
 }
}
