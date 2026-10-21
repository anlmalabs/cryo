/**
 * Damage smoke — the black trail off a wounded craft, and the fire that
 * follows. A small pooled billboard system: puffs are emitted with a
 * position, a drift, a size, a life and a colour, CPU-simmed like the spray
 * (buoyancy for smoke, quick decay for flame) and drawn in one premultiplied
 * pass so dark smoke genuinely occludes while fire adds.
 *
 * Owned by nobody in particular: the wingmen feed it their damage states,
 * and anything else that wants to burn can emit into the same pool.
 *
 * Allocation per frame: none.
 */

import * as THREE from "three";
import { makeMaterial } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";

/** The slice of `core/gfx.js`'s `Gfx` this module touches. */
interface GfxLike {
 scene: THREE.Scene;
 LAYER: { SKY: number; OPAQUE: number; BLEND: number };
 addMesh(mesh: THREE.Object3D, layerBit: number, renderOrder: number): THREE.Object3D;
}

/** How many puffs the pool holds, simultaneously. */
const POOL = 160;
/**
 * Buoyant acceleration of smoke, m/s². Flame is 0 — it hangs where it was
 * shed. Applied as a straight acceleration, not a drag-balanced rise.
 */
const BUOYANCY = 2.2;
/** Per-second velocity decay of a puff, as a fraction kept (0..1). */
const DRAG_PER_SECOND = 1.6;
/** Lower bound on `DRAG_PER_SECOND * dt`, so no dt step ever overshoots. */
const DRAG_MAX = 0.9;
/** Smallest radius a puff may shrink to, metres. */
const MIN_PUFF_RADIUS = 0.02;
/** Seconds of a puff's life spent fading in, as a 0..1 envelope exponent. */
const FADE_IN_RATE = 5;

export class SmokeTrails {
 gfx: GfxLike;
 /** (centre xyz, radius) then (rgb, alpha), one column per puff. */
 _data: Float32Array;
 _pos: Float32Array;
 _vel: Float32Array;
 _life: Float32Array;
 _life0: Float32Array;
 _size: Float32Array;
 _grow: Float32Array;
 _col: Float32Array;
 /** 1 = buoyant smoke, 0 = flame (no rise, fast fade). */
 _buoy: Float32Array;
 _next: number;
 _cameraPos: THREE.Vector3;
 texture: THREE.DataTexture;
 mesh: THREE.Mesh & { metadata: { triangles: number; vertices: number } };
 material: THREE.RawShaderMaterial;

 constructor(gfx: GfxLike) {
  this.gfx = gfx;
  this._data = new Float32Array(POOL * 2 * 4);
  this._pos = new Float32Array(POOL * 3);
  this._vel = new Float32Array(POOL * 3);
  this._life = new Float32Array(POOL);
  this._life0 = new Float32Array(POOL).fill(1);
  this._size = new Float32Array(POOL);
  this._grow = new Float32Array(POOL);
  this._col = new Float32Array(POOL * 4);
  this._buoy = new Float32Array(POOL);
  this._next = 0;
  this._cameraPos = new THREE.Vector3();

  this.texture = new THREE.DataTexture(
   this._data, POOL, 2, THREE.RGBAFormat, THREE.FloatType
  );
  this.texture.colorSpace = THREE.NoColorSpace;
  this.texture.flipY = false;
  this.texture.premultiplyAlpha = false;
  this.texture.generateMipmaps = false;
  this.texture.minFilter = THREE.NearestFilter;
  this.texture.magFilter = THREE.NearestFilter;
  this.texture.wrapS = THREE.ClampToEdgeWrapping;
  this.texture.wrapT = THREE.ClampToEdgeWrapping;
  this.texture.needsUpdate = true;

  this.mesh = this._buildMesh();
  this.material = makeMaterial({
   name: "smokeTrails",
   vertex: getShader("smokeVertexShader"),
   fragment: getShader("smokePixelShader"),
   uniforms: {
    viewProjection: { value: new THREE.Matrix4() },
    cameraPos: { value: this._cameraPos },
    puffTex: { value: this.texture },
   },
   // Premultiplied over — smoke occludes, fire adds, one draw.
   transparent: true,
   blending: THREE.CustomBlending,
   blendEquation: THREE.AddEquation,
   blendSrc: THREE.OneFactor,
   blendDst: THREE.OneMinusSrcAlphaFactor,
   depthWrite: false,
   depthTest: true,
   side: THREE.DoubleSide,
  });
  this.mesh.material = this.material;
  gfx.addMesh(this.mesh, gfx.LAYER.BLEND, 44);
  this.mesh.visible = false;
 }

 _buildMesh() {
  const positions = new Float32Array(POOL * 4 * 3);
  const indices = new Uint32Array(POOL * 6);
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (let m = 0; m < POOL; m++) {
   const v = m * 4;
   for (let c = 0; c < 4; c++) {
    positions[(v + c) * 3] = m;
    positions[(v + c) * 3 + 1] = corners[c][0];
    positions[(v + c) * 3 + 2] = corners[c][1];
   }
   const o = m * 6;
   indices[o] = v; indices[o + 1] = v + 1; indices[o + 2] = v + 2;
   indices[o + 3] = v + 1; indices[o + 4] = v + 3; indices[o + 5] = v + 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mesh = new THREE.Mesh(geometry) as THREE.Mesh & {
   metadata: { triangles: number; vertices: number };
  };
  mesh.name = "smokeTrails";
  mesh.metadata = { triangles: POOL * 2, vertices: POOL * 4 };
  return mesh;
 }

 /** Point the puffs through the same (jittered) camera as the scene. */
 bindCamera(viewProjection: THREE.Matrix4) {
  this.material.uniforms.viewProjection.value = viewProjection;
 }

 /**
  * One puff. Smoke wants `buoyant` true (it rises and lingers); flame
  * false (it hangs where it was born and dies fast).
  */
 emit(
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
  /** radius, metres */
  size: number,
  /** metres/second, may be negative */
  grow: number,
  /** seconds */
  life: number,
  r: number, g: number, b: number,
  /** premultiplied alpha at full envelope, 0..1 */
  a: number,
  buoyant: boolean
 ) {
  const i = this._next;
  this._next = (this._next + 1) % POOL;
  this._pos[i * 3] = x;
  this._pos[i * 3 + 1] = y;
  this._pos[i * 3 + 2] = z;
  this._vel[i * 3] = vx;
  this._vel[i * 3 + 1] = vy;
  this._vel[i * 3 + 2] = vz;
  this._life[i] = life;
  this._life0[i] = life;
  this._size[i] = size;
  this._grow[i] = grow;
  this._col[i * 4] = r;
  this._col[i * 4 + 1] = g;
  this._col[i * 4 + 2] = b;
  this._col[i * 4 + 3] = a;
  this._buoy[i] = buoyant ? 1 : 0;
 }

 /** @param {number} dt @param {THREE.Vector3} cameraPos */
 update(dt: number, cameraPos?: THREE.Vector3) {
  if (cameraPos) this._cameraPos.copy(cameraPos);
  let live = 0;
  const d = this._data;
  for (let i = 0; i < POOL; i++) {
   if (this._life[i] <= 0) {
    d[i * 4 + 3] = 0;
    continue;
   }
   this._life[i] -= dt;
   const t01 = Math.max(0, this._life[i] / this._life0[i]);
   // Smoke rises and slows; flame just decays where it was shed.
   const buoy = this._buoy[i];
   this._vel[i * 3 + 1] += buoy * BUOYANCY * dt;
   const drag = 1 - Math.min(DRAG_MAX, DRAG_PER_SECOND * dt);
   this._vel[i * 3] *= drag;
   this._vel[i * 3 + 1] *= drag;
   this._vel[i * 3 + 2] *= drag;
   this._pos[i * 3] += this._vel[i * 3] * dt;
   this._pos[i * 3 + 1] += this._vel[i * 3 + 1] * dt;
   this._pos[i * 3 + 2] += this._vel[i * 3 + 2] * dt;
   // Growth may be negative — a smoke ball that shrinks as it lets
   // go — but a puff never inverts through zero.
   this._size[i] = Math.max(MIN_PUFF_RADIUS, this._size[i] + this._grow[i] * dt);

   const a = i * 4;
   d[a] = this._pos[i * 3];
   d[a + 1] = this._pos[i * 3 + 1];
   d[a + 2] = this._pos[i * 3 + 2];
   d[a + 3] = this._size[i];
   const c = (POOL + i) * 4;
   d[c] = this._col[a];
   d[c + 1] = this._col[a + 1];
   d[c + 2] = this._col[a + 2];
   // In on the first fifth, out over the rest — a puff that pops to
   // full alpha in one frame reads as a sprite, not a shed.
   const env = Math.min(1, (1 - t01) * FADE_IN_RATE) * t01;
   d[c + 3] = this._col[a + 3] * env;
   live++;
  }
  this.texture.needsUpdate = true;
  this.mesh.visible = live > 0;
 }

 dispose() {
  this.gfx.scene.remove(this.mesh);
  this.mesh.geometry.dispose();
  this.material.dispose();
  this.texture.dispose();
 }
}
