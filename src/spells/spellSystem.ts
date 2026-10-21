/**
 * The spell system — dispatch, shared context, and the casting pose.
 *
 * Owns the five spells, the water body they draw into, the ice they leave, and
 * the light pool every material reads. One `update()` per frame, in this order,
 * and the order is load-bearing:
 *
 *   1. clear the light pool
 *   2. dispatch input
 *   3. update every spell — they declare lights and write brushes here
 *   4. upload the water and the crystals
 *
 * The lights have to be cleared before the spells run and uploaded after, or a
 * spell that ended last frame keeps lighting the snow. The brushes have to be
 * written before `terrain.update()` runs the simulation pass, which is why this
 * is called from `main` alongside the character contact rather than after the
 * terrain.
 *
 * Allocation per frame: none.
 */

import * as THREE from "three";

import { input } from "../core/input.js";
import { S } from "../core/settings.js";
import { expDamp } from "../core/camera.js";
import { SpellLights } from "./spellLights.js";
import { WaterBody } from "./waterBody.js";
import { CrystalField } from "./crystals.js";
import { Sweep } from "./sweep.js";
import { Ribbon } from "./ribbon.js";
import { Bloom } from "./bloom.js";
import { Crystallize } from "./crystallize.js";
import { Vortex } from "./vortex.js";
import { aimPoint } from "./bending.js";

import type { Gfx } from "../core/gfx.js";
import type { Sky } from "../render/sky.js";
import type { ShadowSystem } from "../render/shadows.js";
import type { Terrain } from "../terrain/terrain.js";
import type { DeformationField } from "../terrain/deformation.js";
import type { CharacterController } from "../character/controller.js";
import type { Figure } from "../character/figure.js";
import type { CameraRig } from "../core/camera.js";
import type { SprayField } from "../vfx/particles.js";
import type { DepthPass } from "../render/depthPass.js";

/** Everything a spell needs from the world it runs in. */
export interface SpellContext {
 controller: CharacterController;
 figure: Figure | null;
 rig: CameraRig;
 terrain: Terrain;
 deform: DeformationField;
 spray: SprayField;
 water: WaterBody;
 crystals: CrystalField;
 lights: SpellLights;
 time: number;
 sprayScale: number;
 handPosition: (which: number, out: Float32Array, off: number) => void;
}

const _aim = new Float32Array(3);

/**
 * The five spells, by the key that casts them.
 *
 * `input.spellPressed` is a keyboard code in 1..5, and `SNOWFLOW.spells` lets
 * the console cast by that same number — so the wire format has to stay a
 * number, not an object. The enum is what makes that boundary honest: a spell
 * id is a small closed set, and every comparison below states which member it
 * means rather than hoping `3` is Bloom.
 *
 * Members are the spell index, in the order the spells update and are laid out
 * in `this.spells`.
 */
const enum SpellKind {
 SWEEP = 1,
 RIBBON = 2,
 BLOOM = 3,
 CRYSTALLIZE = 4,
 VORTEX = 5,
}

/**
 * Is this a key that casts one of the five spells?
 *
 * The keyboard and the console both hand the spell system a plain `number`,
 * so the narrow set is re-established here rather than trusted from the wire.
 */
function isSpellKind(key: number): key is SpellKind {
 return key >= SpellKind.SWEEP && key <= SpellKind.VORTEX;
}

/** Targeting ray length for the placed spells (Bloom, Crystallise), metres. */
const AIM_RAY_MAX = 22;
/** Where a miss lands, metres in front of the eye. */
const AIM_FALLBACK = 13;

/** Lateral offset of the fallback hand point from the chest, metres. */
const HAND_SIDE = 0.28;
/** Forward offset of the fallback hand point from the chest, metres. */
const HAND_FWD = 0.35;
/** Height of the fallback hand point, metres. */
const HAND_HEIGHT = 1.25;
/** Seconds a cast keeps the stance alive after the last one. */
const CAST_BLEND_HOLD = 0.55;
/** Ease rate of the casting stance, 1/s, in and out. */
const CAST_BLEND_IN = 7.0;
const CAST_BLEND_OUT = 3.2;
/** Camera trauma per cast, by spell. */
const TRAUMA_SWEEP = 0.12;
const TRAUMA_VORTEX = 0.10;

/** The five spells, in update order. */
type Spell = Sweep | Ribbon | Bloom | Crystallize | Vortex;

export class SpellSystem {
 lights!: SpellLights;
 water!: WaterBody;
 crystals!: CrystalField;
 ctx!: SpellContext;
 sweep!: Sweep;
 ribbon!: Ribbon;
 bloom!: Bloom;
 crystallize!: Crystallize;
 vortex!: Vortex;
 spells!: Spell[];
 _consumers!: THREE.RawShaderMaterial[];
 aim!: THREE.Vector3;
 castBlend = 0;
 _lastCast = -99;
 _time = 0;
 castCount = 0;
 lastCast = 0;
 debugRibbon = false;

 constructor(
  gfx: Gfx,
  sky: Sky,
  shadows: ShadowSystem,
  terrain: Terrain,
  controller: CharacterController,
  figure: Figure | null,
  rig: CameraRig,
  spray: SprayField,
 ) {
  this.lights = new SpellLights();
  this.water = new WaterBody(gfx, sky, shadows, this.lights, rig);
  this.crystals = new CrystalField(gfx, sky, shadows, this.lights, rig);

  this.ctx = {
   controller,
   figure: figure || null,
   rig,
   terrain,
   deform: terrain.deform,
   spray,
   water: this.water,
   crystals: this.crystals,
   lights: this.lights,
   time: 0,
   sprayScale: 1,
   handPosition: (which: number, out: Float32Array, off: number) => this._handPosition(which, out, off),
  };

  this.sweep = new Sweep(this.ctx);
  this.ribbon = new Ribbon(this.ctx);
  this.bloom = new Bloom(this.ctx);
  this.crystallize = new Crystallize(this.ctx);
  this.vortex = new Vortex(this.ctx);

  this.spells = [this.sweep, this.ribbon, this.bloom, this.crystallize, this.vortex];

  /**
   * Materials outside the spell system that shade with the spell lights.
   *
   * They are pushed rather than pulled because the pool is only complete
   * once every spell has declared, and that is later in the frame than any
   * of these systems runs. Registering them here keeps "who is lit by a
   * spell" a single list in one file instead of a `lights.apply()` call
   * scattered across five unrelated `_pushUniforms`.
   *
   * @type {import("three").RawShaderMaterial[]}
   */
  this._consumers = [];

  /** Aim direction, refreshed each frame from the rig. */
  this.aim = new THREE.Vector3(0, 0, 1);
  /** 0..1 eased: how far into a casting stance the figure should be. */
  this.castBlend = 0;
  this._lastCast = -99;
  this._time = 0;
  /**
   * Monotonic count of spells dispatched, and the key of the most recent
   * one (1..5). Published as a pair so a system that reacts to casts — the
   * soundscape — can poll a number for the edge and read which spell it
   * was, rather than the spell system handing out callbacks.
   */
  this.castCount = 0;
  this.lastCast = 0;
  /** Console override for the Ribbon hold. */
  this.debugRibbon = false;
 }

 /**
  * Declare a material that reads `snowSpellLights`.
  * @param {...THREE.RawShaderMaterial} mats
  */
 addConsumers(...mats: THREE.RawShaderMaterial[]) {
  for (let i = 0; i < mats.length; i++) {
   if (mats[i]) this._consumers.push(mats[i]);
  }
 }

 /**
  * Where a hand is, in world space.
  *
  * Falls back to a point in front of the chest when the figure is hidden, so
  * a spell cast with the character switched off still comes from somewhere
  * sensible rather than from the origin.
  */
 _handPosition(which: number, out: Float32Array, off: number) {
  const fig = this.ctx.figure;
  if (fig && S.showCharacter) {
   fig.handPosition(which, out, off);
   return;
  }
  const ch = this.ctx.controller;
  const fx = Math.sin(ch.facing);
  const fz = Math.cos(ch.facing);
  const side = which === 0 ? -HAND_SIDE : HAND_SIDE;
  out[off] = ch.position.x + fx * HAND_FWD + Math.cos(ch.facing) * side;
  out[off + 1] = ch.position.y + HAND_HEIGHT;
  out[off + 2] = ch.position.z + fz * HAND_FWD - Math.sin(ch.facing) * side;
 }

 /**
  * @param {number} dt
  * @param {THREE.Vector3} cameraPos
  */
 update(dt: number, cameraPos: THREE.Vector3) {
  const ctx = this.ctx;
  this._time += dt;
  ctx.time = this._time;
  ctx.sprayScale = S.spellSpray;
  this.lights.scale = S.spellLight;

  // Aim comes off the rig rather than the character: the player points
  // with the camera, and the figure turns to follow.
  this.aim.copy(this.ctx.rig.forward);

  this.lights.begin();

  if (S.showSpells) this._dispatch();
  else this._cancelAll();

  for (let i = 0; i < this.spells.length; i++) this.spells[i].update(dt);

  // The casting stance eases in while anything is up and out again after.
  // Nothing about it is a switch.
  const casting =
   this.ribbon.active || this._time - this._lastCast < CAST_BLEND_HOLD ? 1 : 0;
  this.castBlend = expDamp(
   this.castBlend, casting,
   casting ? CAST_BLEND_IN : CAST_BLEND_OUT, dt
  );
  const ch = this.ctx.controller;
  ch.cast = this.castBlend;
  ch.castAimX = this.aim.x;
  ch.castAimY = this.aim.y;
  ch.castAimZ = this.aim.z;

  // Everything outside the spell system that answers a spell light, after
  // the last declaration and before anything renders.
  for (let i = 0; i < this._consumers.length; i++) {
   this.lights.apply(this._consumers[i]);
  }

  this.water.update(dt, cameraPos);
  this.crystals.update(dt, cameraPos);
 }

 _dispatch() {
  // Ribbon is a hold, so it is polled rather than edge-triggered.
  // `debugRibbon` lets the console hold it without synthesising a key
  // event — the poll would otherwise release it on the very next frame.
  this.holdRibbon(input.spellHeld2 || this.debugRibbon);
  const key = input.spellPressed;
  if (isSpellKind(key) && key !== SpellKind.RIBBON) this.cast(key);
 }

 /**
  * Fire one spell, by key.
  *
  * Separated from the input poll so the console or a future rebind can cast
  * without synthesising a key event. `SNOWFLOW.spells` is the console handle.
  *
  * @param {number} key 1..5, as `input.spellPressed` reports it
  */
 cast(key: number) {
  const ctx = this.ctx;
  const rig = ctx.rig;

  if (key === SpellKind.RIBBON) {
   this.holdRibbon(true);
   return;
  }

  this._lastCast = this._time;
  this.castCount++;
  this.lastCast = key;

  if (key === SpellKind.SWEEP) {
   // Flat aim: the crescent runs along the ground, so a camera pointed
   // at the sky must not launch it into the air.
   const fl = Math.hypot(this.aim.x, this.aim.z) || 1;
   this.sweep.trigger(this.aim.x / fl, this.aim.z / fl);
   rig.addTrauma(TRAUMA_SWEEP);
   return;
  }

  if (key === SpellKind.BLOOM || key === SpellKind.CRYSTALLIZE) {
   // Both are placed where the player is looking. The ray starts at the
   // eye, so what the spell hits is exactly what is under the centre of
   // the screen — which is the only targeting rule that needs no
   // explanation and no reticle.
   //
   // Capped at 22 m of ray, not the 40 the terrain could answer for.
   // Looking out across a dune field the first surface the ray meets is
   // often forty metres away on the next ridge, and a Bloom that goes
   // off over there is an effect the player has to squint at. Beyond the
   // cap the spell lands at the cap distance instead, which is always
   // in front of them and always at a size worth looking at.
   const eye = rig.camera.position;
   aimPoint(
    _aim, ctx.terrain,
    eye.x, eye.y, eye.z,
    this.aim.x, this.aim.y, this.aim.z,
    AIM_RAY_MAX, AIM_FALLBACK
   );
   if (key === SpellKind.BLOOM) this.bloom.trigger(_aim[0], _aim[1], _aim[2]);
   else this.crystallize.trigger(_aim[0], _aim[1], _aim[2]);
   return;
  }

  if (key === SpellKind.VORTEX) {
   this.vortex.trigger();
   rig.addTrauma(TRAUMA_VORTEX);
  }
 }

 /** @param {boolean} held */
 holdRibbon(held: boolean) {
  if (held) {
   if (!this.ribbon.held) {
    this.ribbon.trigger();
    this._lastCast = this._time;
    this.castCount++;
    this.lastCast = SpellKind.RIBBON;
   }
  } else if (this.ribbon.held) {
   this.ribbon.release();
  }
 }

 _cancelAll() {
  for (let i = 0; i < this.spells.length; i++) this.spells[i].cancel();
 }

 /** Live spell count, for the overlay. */
 get activeCount() {
  let n = 0;
  for (let i = 0; i < this.spells.length; i++) if (this.spells[i].active) n++;
  return n;
 }

 /**
  * Register the ice formations with the depth prepass.
  *
  * Only the crystals: the water body is translucent and refractive, so a
  * depth for it would tell every screen-space consumer that the snow behind it
  * is not there — which is exactly wrong for a medium you can see through.
  *
   * @param {DepthPass} depth
   */
 registerPrepass(depth: DepthPass) {
  this.crystals.registerPrepass(depth);
 }

 get triangles() {
  return this.water.triangles + this.crystals.triangles;
 }

 /**
  * Compile every spell pipeline behind the loading screen.
  *
  * The first cast of any spell must not hitch, and this is the only thing
  * standing between that and a multi-hundred-millisecond freeze the first
  * time somebody presses 3. Both water profiles and the ice material are
  * exercised with real geometry — a pipeline compiled against an empty draw
  * is a warm-up that quietly covers nothing.
  */
 async warmUp(x: number, y: number, z: number) {
  await this.water.warmUp(x, y, z);
  await this.crystals.warmUp(x, y, z);
 }

 /**
  * Clear the warm-up geometry. Called after `main`'s warm-up frames, not
  * inside `warmUp` — the whole point is that those frames draw it.
  */
 finishWarmUp() {
  this.water.finishWarmUp();
  this.crystals.finishWarmUp();
 }

 dispose() {
  this.water.dispose();
  this.crystals.dispose();
 }
}
