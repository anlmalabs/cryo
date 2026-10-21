/**
 * Where the character meets the snow.
 *
 * Translates locomotion state into brushes on the terrain state buffer. This is
 * the only thing standing between the physics in `controller.js` and the marks
 * left on the field, and it is deliberately separate from both: the controller
 * should not know a deformation buffer exists, and the buffer should not know
 * what a foot is.
 *
 * Three writers:
 *
 *   footfall   one splat per plant, frame-accurate with the gait event. A boot
 *              is longer than it is wide and oriented with the body, so the
 *              brush is elongated and yawed rather than round.
 *   body drag  a shallow continuous scuff under a walking character, so the
 *              trail is a trail and not a row of disconnected prints.
 *   surf wake  a deep continuous groove with berms thrown to the outside of the
 *              turn. This is the centrepiece's mark on the world.
 *
 * Zero allocation: brushes are pushed straight into the field's staging array.
 */

import { S } from "../core/settings.js";
import { input } from "../core/input.js";
import { RUN_SPEED } from "./controller.js";
import type { CharacterController } from "./controller.js";
import type { DeformationField } from "../terrain/deformation.js";
import type { Figure } from "./figure.js";
import type { SprayField } from "../vfx/particles.js";

/**
 * Boot geometry, metres. `WIDTH` is the short-axis radius, so the print is
 * 20 cm across and 34 cm long — a boot plus the collapse of the snow around it,
 * which is what a print in deep snow actually measures. Narrower than this and
 * the print is only six texels wide and the rim detail has nowhere to live.
 */
const BOOT_WIDTH = 0.10;
const BOOT_ELONG = 1.7;

/** Surf groove geometry, metres. */
const SURF_WIDTH = 0.30;
const SURF_ELONG = 2.6;

// --- footfall print -------------------------------------------------------
/** Depth at rest, metres: a boot in unpacked snow settles 13 cm in. */
const BOOT_DEPTH = 0.17;
/** Extra depth per unit impact, metres — lands the 13-27 cm band. */
const BOOT_DEPTH_IMPACT = 0.14;
/** Berm height at rest, metres. Displaced snow piles at the rim. */
const BOOT_BERM = 0.10;
/** Extra berm per unit impact, metres. */
const BOOT_BERM_IMPACT = 0.08;
/** Compression of the packed snow under the print, ratio. */
const BOOT_COMPRESS = 0.9;
/** Rim roughness of the print, ratio — boots tear their edges. */
const BOOT_EDGE = 1.0;
/** Impact ceiling: past it the print stops deepening. */
const FOOT_IMPACT_MAX = 1.3;
/** Impact offset, the flat part of the curve before speed adds to it. */
const FOOT_IMPACT_BASE = 0.35;
/** Footfall fires only above this much surf blend, ratio. */
const FOOT_SURF_FLOOR = 0.02;
/** Walking scuff runs at all below this much surf blend, ratio. */
const FOOT_SURF_CEIL = 0.98;

// --- spray grains ---------------------------------------------------------
/** Speed below which a landing throws nothing, m/s. */
const KICK_MIN_SPEED = 0.4;
/** Grain count at zero impact. */
const KICK_GRAINS = 6;
/** Extra grains per unit impact. */
const KICK_GRAINS_IMPACT = 14;
/** Horizontal scatter radius, metres. */
const KICK_SPREAD = 0.9;
/** Upward launch at zero random rise, m/s. */
const KICK_UP_BASE = 0.9;
/** Extra upward rise beyond that, m/s. */
const KICK_UP_RISE = 1.9;
/** Backward throw at zero impact and zero random, m/s. */
const KICK_BACK_BASE = 0.5;
/** Extra backward throw per unit impact, m/s. */
const KICK_BACK_IMPACT = 1.6;
/** Fraction of grains that are heavy clods, ratio. */
const KICK_CLOD_CHANCE = 0.22;
/** Forward offset of the launch origin, metres. */
const KICK_ORIGIN_XZ = 0.09;
/** Vertical offset of the launch origin, metres. */
const KICK_ORIGIN_Y = 0.03;
/** Vertical spread of the launch origin, metres. */
const KICK_ORIGIN_Y_RISE = 0.05;
/** Inward pull of the scatter on the horizontal velocity, ratio. */
const KICK_SCATTER_PULL = 1.3;
/** Body's own velocity carried into the throw, ratio. */
const KICK_VELOCITY_INHERIT = 0.25;
/** Upward throw multiplier for a heavy clod, ratio. */
const CLOD_UP = 1.25;
/** Upward throw multiplier for powder, ratio — neutral. */
const POWDER_UP = 1.0;
/** Clod grain size, metres. */
const CLOD_SIZE_BASE = 0.014;
/** Extra clod size, metres. */
const CLOD_SIZE_RISE = 0.012;
/** Powder grain size, metres. */
const POWDER_SIZE_BASE = 0.020;
/** Extra powder size, metres. */
const POWDER_SIZE_RISE = 0.030;
/** Clod grain lifetime, seconds. */
const CLOD_LIFE_BASE = 0.55;
/** Extra clod lifetime, seconds. */
const CLOD_LIFE_RISE = 0.35;
/** Powder grain lifetime, seconds. */
const POWDER_LIFE_BASE = 0.55;
/** Extra powder lifetime, seconds. */
const POWDER_LIFE_RISE = 0.60;

// --- walking scuff --------------------------------------------------------
/** Speed below which a standing character bores no hole, m/s. */
const SCUFF_MIN_SPEED = 0.25;
/** Distance in one frame after which the scuff saturates, metres. */
const SCUFF_MAX_DIST = 0.35;
/** Scuff brush radius, metres. */
const SCUFF_RADIUS = 0.22;
/** Deepest scuff depth, metres — shallower than the prints it links. */
const SCUFF_DEPTH = 0.20;
/** Berm matching the scuff depth, metres. */
const SCUFF_BERM = 0.22;
/** Compression of the scuffed snow, ratio. */
const SCUFF_COMPRESS = 0.8;
/** Elongation along the direction of travel, ratio. */
const SCUFF_ELONG = 1.5;
/** Edge roughness: a churned path is rougher than a print, ratio. */
const SCUFF_EDGE = 0.85;

// --- surf wake -------------------------------------------------------------
/** Speed at which the wake reaches full strength, m/s. */
const WAKE_FULL_SPEED = 6;
/** Below this much of full speed the wake is not drawn, ratio. */
const WAKE_MIN_GAIN = 0.05;
/** Speed at which the trench stops deepening and starts widening, m/s. */
const WAKE_WIDEN_SPEED = 6;
/** Speed range over which the trench widens, m/s. */
const WAKE_WIDEN_RANGE = 12;
/** Fraction of the board's bite a hovering craft still moves, ratio. */
const CRAFT_BITE = 0.4;
/** Clearance below which a hover effect starts fading in, metres. */
const CRAFT_CLEAR_BASE = 3.2;
/** Height range over which the hover effect fades out, metres. */
const CRAFT_CLEAR_RANGE = 3.3;
/** Distance after which the wake saturates, metres. */
const WAKE_MAX_DIST = 0.6;
/** Wake depth below this is nothing, metres. */
const WAKE_EPS = 0.001;
/** Trench offset per unit carve toward the lean, metres. */
const WAKE_LEAN_OFF = 0.12;
/** Extra groove width per unit `fast`, ratio. */
const WAKE_FAST_WIDTH = 0.35;
/** Deepest trench depth, metres. */
const WAKE_DEPTH = 1.20;
/** Trench berm, metres. */
const WAKE_BERM = 0.30;
/** Compression of the packed trench floor, ratio. */
const WAKE_COMPRESS = 4.0;
/** Edge roughness of the board's cut, ratio. */
const WAKE_EDGE = 0.55;
/** Berm weight at centred carve, ratio — each side takes half. */
const WAKE_SIDE_BASE = 0.5;
/** Berm weight shift per unit carve, ratio. */
const WAKE_SIDE_CARVE = 0.5;
/** Berm offset at centred carve, metres. */
const WAKE_OFF_BASE = 1.5;
/** Extra berm offset per unit `fast`, metres. */
const WAKE_OFF_FAST = 0.5;
/** Thrown-mass scale, ratio. */
const WAKE_THROW = 0.75;
/** Minimum thrown mass off the inside berm, ratio. */
const WAKE_THROW_IN = 0.55;
/** Extra thrown mass on the outside of a full lean, ratio. */
const WAKE_THROW_OUT = 0.9;
/** Extra thrown mass per unit `fast`, ratio. */
const WAKE_THROW_FAST = 0.5;
/** Berm brush width as a fraction of the groove width, ratio. */
const WAKE_BERM_WIDTH = 0.95;
/** Thrown-wall multiplier applied to each berm, ratio. */
const WAKE_WALL = 2.0;
/** Berm elongation along the board, ratio. */
const WAKE_BERM_ELONG = 0.8;
/** Edge roughness of the thrown wall, ratio — full, snow breaks clean. */
const WAKE_BERM_EDGE = 1.0;

export class SnowContact {
 character: CharacterController;
 field: DeformationField | null;
 spray: SprayField | null;
 figure: Figure | null;
 _sinceSplat: number;
 _prevX: number;
 _prevZ: number;
 /**
  * @param {CharacterController} character
  * @param {DeformationField | null} field
  * @param {Figure?} [figure] posed skeleton, if built
  * @param {SprayField?} [spray]
  */
 constructor(character: CharacterController, field: DeformationField | null, figure: Figure | null, spray: SprayField | null) {
  this.character = character;
  this.field = field || null;
  this.spray = spray || null;
  /**
   * The posed figure, when there is one.
   *
   * The controller also produces footfall events, and they are close
   * enough to be tempting. But "close enough" is exactly what a footprint
   * cannot be: the print has to be under the boot, and only the figure
   * knows where the boot actually planted, because it is the thing that
   * decided. Taking the event from the same state machine that freezes the
   * stance foot makes the two agree by construction rather than by
   * matching two sets of constants.
   */
  this.figure = figure || null;

  /** Distance travelled since the last continuous splat, metres. */
  this._sinceSplat = 0;
  this._prevX = character.position.x;
  this._prevZ = character.position.z;
 }

 /** @param {number} dt seconds */
 update(dt: number) {
  const ch = this.character;
  const f = this.field;

  const dx = ch.position.x - this._prevX;
  const dz = ch.position.z - this._prevZ;
  const moved = Math.hypot(dx, dz);
  this._prevX = ch.position.x;
  this._prevZ = ch.position.z;

  // Stub tolerance: without a deformation field there is nothing to mark.
  if (!f) return;

  if (ch.surf > FOOT_SURF_FLOOR) this._surf(dt, moved);
  if (ch.surf < FOOT_SURF_CEIL) this._walk(dt, moved);

  // Footfalls fire regardless of mode; the gait suppresses them while
  // surfing because the feet are on the board.
  const fig = this.figure;
  for (let i = 0; i < 2; i++) {
   let px, pz;
   if (fig) {
    if (!fig.touchdown[i] || !ch.stepping) continue;
    px = fig.plant[i * 3];
    pz = fig.plant[i * 3 + 2];
   } else {
    if (!ch.footfall || i !== ch.footIndex) continue;
    px = ch.footPos.x;
    pz = ch.footPos.z;
   }

   // Recomputed here rather than read off the controller, so it cannot
   // be a frame stale relative to the plant it is describing.
   const impact = Math.min(FOOT_IMPACT_MAX, FOOT_IMPACT_BASE + ch.speed / RUN_SPEED);
   f.brush(
    px, pz,
    BOOT_WIDTH,
    BOOT_DEPTH + BOOT_DEPTH_IMPACT * impact,
    BOOT_BERM + BOOT_BERM_IMPACT * impact,
    BOOT_COMPRESS,          // compression: trodden snow is dense
    0,                      // no ice
    ch.facing,
    BOOT_ELONG,
    BOOT_EDGE               // full rim roughness — boots tear edges
   );

   const py = fig ? fig.plant[i * 3 + 1] : ch.position.y;
   this._kick(px, py, pz, impact);
  }
 }

 /**
  * Snow thrown by a boot landing.
  *
  * Fired from the same branch that stamps the print, so the grains leave the
  * ground on the exact frame the foot arrives — one event, rather than two
  * systems agreeing about when it happened.
  *
  * The kick goes up and *backward* relative to travel. A boot in deep snow
  * scoops: it enters forward, compresses, and throws the displaced snow out
  * behind the heel as the weight rolls over it.
  */
/** @param {number} x @param {number} y @param {number} z @param {number} impact */ _kick(x: number, y: number, z: number, impact: number) {
  const sp = this.spray;
  if (!sp) return;
  const ch = this.character;
  if (ch.speed < KICK_MIN_SPEED) return;

  const fx = Math.sin(ch.facing);
  const fz = Math.cos(ch.facing);
  // Many small grains rather than a few large ones. The size at which a
  // puff stops reading as powder and starts reading as a cotton ball is
  // somewhere around five centimetres, and it is a hard threshold.
  const n = KICK_GRAINS + ((impact * KICK_GRAINS_IMPACT) | 0);

  for (let k = 0; k < n; k++) {
   const spread = KICK_SPREAD;
   const rx = (Math.random() - 0.5) * spread;
   const rz = (Math.random() - 0.5) * spread;
   const up = KICK_UP_BASE + Math.random() * KICK_UP_RISE;
   const back = KICK_BACK_BASE + Math.random() * KICK_BACK_IMPACT * impact;
   // A fifth of it is heavier stuff that flies further and falls faster.
   const clod = Math.random() < KICK_CLOD_CHANCE ? 1 : 0;

   sp.emit(
    x + rx * KICK_ORIGIN_XZ, y + KICK_ORIGIN_Y + Math.random() * KICK_ORIGIN_Y_RISE, z + rz * KICK_ORIGIN_XZ,
    -fx * back + rx * KICK_SCATTER_PULL + ch.velocity.x * KICK_VELOCITY_INHERIT,
    up * (clod ? CLOD_UP : POWDER_UP),
    -fz * back + rz * KICK_SCATTER_PULL + ch.velocity.z * KICK_VELOCITY_INHERIT,
    clod ? CLOD_SIZE_BASE + Math.random() * CLOD_SIZE_RISE : POWDER_SIZE_BASE + Math.random() * POWDER_SIZE_RISE,
    clod ? CLOD_LIFE_BASE + Math.random() * CLOD_LIFE_RISE : POWDER_LIFE_BASE + Math.random() * POWDER_LIFE_RISE,
    clod
   );
  }
 }

 /**
  * Walking scuff. Very shallow, and only while actually moving — a standing
  * character should not slowly bore a hole.
  */
/** @param {number} dt @param {number} moved */ _walk(dt: number, moved: number) {
  const ch = this.character;
  if (!this.field) return;
  if (ch.speed < SCUFF_MIN_SPEED) return;

  const w = 1 - ch.surf;
  // Scaled by distance travelled, not by dt, so the groove has the same
  // depth per metre at any speed or frame rate. A given patch of ground
  // sits under the brush for (2 * radius / moved) frames, so the depth it
  // ends up at is roughly rate * 2 * radius * profile — independent of
  // both speed and frame rate, which is the point.
  const k = Math.min(moved, SCUFF_MAX_DIST);
  // Compression stays deliberately below saturation here. If the scuff
  // packed the whole path to 1.0, the boot prints stamped on top would
  // have nothing left to darken and the trail would read as one flat
  // ribbon instead of as a line of prints in a churned path.
  // Shallower and narrower than the boot prints it links, on purpose. It
  // was originally deep enough to dominate them, which turned a line of
  // footprints into one continuous ski track — fine while the feet were
  // hidden under a floor-length robe, wrong now that they are not.
  this.field.brush(
   ch.position.x, ch.position.z,
   SCUFF_RADIUS,
   SCUFF_DEPTH * k * w,
   SCUFF_BERM * k * w,
   SCUFF_COMPRESS * k * w,
   0,
   ch.facing,
   SCUFF_ELONG,
   SCUFF_EDGE
  );
 }

 /**
  * The surf wake.
  *
  * Three brushes: the groove the board cuts, and one berm on each side
  * weighted by the carve, so the outside of a turn throws a much heavier wall
  * of snow than the inside. That asymmetry is what makes a carve read as a
  * carve rather than as a straight furrow.
  */
/** @param {number} dt @param {number} moved */ _surf(dt: number, moved: number) {
  const ch = this.character;
  const f = this.field;
  if (!f) return;
  const s = ch.surf;

  // Below a walking pace there is no wake to speak of; splatting anyway
  // would just dig a pit wherever the player coasted to a stop.
  const speedK = Math.min(1, ch.speed / WAKE_FULL_SPEED);
  if (speedK < WAKE_MIN_GAIN) return;

  // A climbing craft pulls its downwash off the field: the trench and the
  // thrown berms fade quadratically with the climb, and are gone well
  // before the ceiling — snow that high is not being touched.
  const near = 1 - Math.min(1, Math.max(0, ch.lift01 || 0));
  // A hovering craft moves far less snow than a board with a rider's
  // weight on its edge: downwash disturbs the surface, it does not
  // carve it. Less than half the board's bite, or a low pass leaves a
  // scar that reads as ploughing rather than flying.
  let craft = 1;
  if (input.flying) {
   craft = CRAFT_BITE;
   // And it is gated on the *actual* daylight under the hull, not on
   // the climb state — a craft crossing a gully at deck trim is still
   // metres above the snow at the bottom of it, and downwash that
   // reaches down a cliff face reads as a glitch. Full effect skimming
   // at hover height, gone entirely past ~6.5 m of clearance.
   const clear = ch.position.y - ch.groundY;
   const low = 1 - Math.min(1, Math.max(0, (clear - CRAFT_CLEAR_BASE) / CRAFT_CLEAR_RANGE));
   craft *= low * low;
  }
  const k = Math.min(moved, WAKE_MAX_DIST) * s * speedK * near * near * craft;
  if (k <= WAKE_EPS) return;

  // Past the point where the trench stops deepening, extra speed still
  // means extra snow moved — it goes into width and into the walls, which
  // is what makes a fast run's scar read as bigger rather than just longer.
  const fast = Math.min(1, Math.max(0, ch.speed - WAKE_WIDEN_SPEED) / WAKE_WIDEN_RANGE);

  const yaw = ch.facing;
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);

  // --- the groove ------------------------------------------------------
  // The board rides the inside edge in a turn, so the trench offsets
  // slightly toward the lean.
  const lean = ch.carve;
  const gx = ch.position.x + rx * lean * WAKE_LEAN_OFF;
  const gz = ch.position.z + rz * lean * WAKE_LEAN_OFF;

  f.brush(
   gx, gz,
   SURF_WIDTH * /** @type {number} */ (S.surfWidth) * (1 + WAKE_FAST_WIDTH * fast),
   WAKE_DEPTH * k,   // deep — a run should be visible from across the field
   WAKE_BERM * k,
   WAKE_COMPRESS * k,    // the board packs the trench floor hard
   0,
   yaw,
   SURF_ELONG,
   WAKE_EDGE        // the board's edge is cleaner than a boot's
  );

  // --- thrown mass -----------------------------------------------------
  // The outside of the turn takes most of it, and the outside of a *right*
  // turn is the left-hand side — the board resists the turn and throws snow
  // away from its centre, the same way a carving snowboard's spray arcs out
  // of the turn rather than into it. `carve` is positive turning right, so
  // the weights run against it.
  //
  // The wake mesh in `src/vfx/surfWake.js` resolves its sides from the same
  // sign, so the airborne wave and the mark it leaves agree.
  const outside = Math.min(1, Math.abs(lean));
  const sideL = WAKE_SIDE_BASE + lean * WAKE_SIDE_CARVE; // weight on the left berm
  const sideR = WAKE_SIDE_BASE - lean * WAKE_SIDE_CARVE;

  const off = SURF_WIDTH * (WAKE_OFF_BASE + WAKE_OFF_FAST * fast);
  const throwK = WAKE_THROW * k * (WAKE_THROW_IN + WAKE_THROW_OUT * outside) * (1 + WAKE_THROW_FAST * fast);

  f.brush(
   ch.position.x - rx * off, ch.position.z - rz * off,
   SURF_WIDTH * WAKE_BERM_WIDTH,
   0, throwK * sideL * WAKE_WALL, 0, 0,
   yaw, SURF_ELONG * WAKE_BERM_ELONG, WAKE_BERM_EDGE
  );
  f.brush(
   ch.position.x + rx * off, ch.position.z + rz * off,
   SURF_WIDTH * WAKE_BERM_WIDTH,
   0, throwK * sideR * WAKE_WALL, 0, 0,
   yaw, SURF_ELONG * WAKE_BERM_ELONG, WAKE_BERM_EDGE
  );
 }
}
