import * as THREE from "three";
import { VoxelGrid, worldToVoxel } from "./voxelGrid.js";
import { meshChunk } from "./greedyMesher.js";
import type { Gfx } from "../core/gfx.js";
import type { Terrain } from "../terrain/terrain.js";
import type { DepthPass } from "../render/depthPass.js";
import type { ShadowSystem } from "../render/shadows.js";
import type { Sky } from "../render/sky.js";
import { getShader } from "../shaders/registry.js";

const LOAD_RADIUS = 96;
const UNLOAD_RADIUS = 128;
const INITIAL_RADIUS = 48;
const VOXEL = 0.5;
const CHUNK_WORLD = 8;
const BASE_DEPTH = 4;
const MESH_BUDGET = 4;

export class Excavation {
 gfx: Gfx;
 terrain: Terrain;
 depthPass: DepthPass;
 shadows: ShadowSystem;
 sky: Sky;
 grid: VoxelGrid;
 meshes: Map<string, THREE.Mesh> = new Map();
 triangles: number = 0;
 saveTimer: number | null = null;
 camPos: THREE.Vector3 = new THREE.Vector3();

 material!: THREE.RawShaderMaterial;
 prepassMaterial!: THREE.RawShaderMaterial;
 _shadowMaterials: THREE.RawShaderMaterial[] = [];
 _vp: THREE.Matrix4 = new THREE.Matrix4();

 _scanCX = Infinity;
 _scanCZ = Infinity;
 _queue: { cx: number; cy: number; cz: number }[] = [];
 _queued: Set<string> = new Set();
 _coords: Map<string, [number, number, number]> = new Map();

 _cyMin = -1;
 _cyMax = 1;

 constructor(gfx: Gfx, terrain: Terrain, depthPass: DepthPass, shadows: ShadowSystem, sky: Sky) {
  this.gfx = gfx;
  this.terrain = terrain;
  this.depthPass = depthPass;
  this.shadows = shadows;
  this.sky = sky;
  this.grid = new VoxelGrid({ heightAt: (x, z) => terrain.heightfield.heightAt(x, z) });
 }

 async init(): Promise<void> {
  await this.grid.initPersistence();
  await this.grid.loadAll();

  const hf = this.terrain.heightfield as { minHeight?: number; maxHeight?: number };
  let mn = hf?.minHeight;
  let mx = hf?.maxHeight;
  if (typeof mn !== "number" || !Number.isFinite(mn)) mn = NaN;
  if (typeof mx !== "number" || !Number.isFinite(mx)) mx = NaN;
  if (Number.isFinite(mn) && Number.isFinite(mx)) {
   this._cyMin = Math.floor((mn - BASE_DEPTH * VOXEL) / CHUNK_WORLD) - 1;
   this._cyMax = Math.floor(mx / CHUNK_WORLD) + 1;
  } else {
   this._cyMin = -1;
   this._cyMax = 1;
  }

  this.material = this.makeMaterial();
  this.prepassMaterial = this.makePrepassMaterial();
  this._shadowMaterials = [this._makeDepthMaterial(0), this._makeDepthMaterial(1)];
  this.material.uniforms.viewProjection.value = this._vp;
  this.prepassMaterial.uniforms.viewProjection.value = this._vp;

  this.ensureChunksAround(0, 0, INITIAL_RADIUS);
  while (this._queue.length) {
   this._drainOne();
  }
  this.scheduleSave();

  window.addEventListener("pagehide", () => { void this.grid.saveDirty(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) void this.grid.saveDirty(); });
 }

 ensureChunksAround(cx: number, cz: number, radius: number) {
  const rChunks = Math.ceil(radius / 8);
  for (let dx = -rChunks; dx <= rChunks; dx++) {
   for (let dz = -rChunks; dz <= rChunks; dz++) {
    const wx = dx * 8;
    const wz = dz * 8;
    const v = worldToVoxel(wx, 0, wz);
    const chunkX = Math.floor(v.ix / 16);
    const chunkZ = Math.floor(v.iz / 16);
    for (let cy = this._cyMin; cy <= this._cyMax; cy++) {
     const key = chunkX + "," + cy + "," + chunkZ;
     if (!this._queued.has(key) && !this.meshes.has(key)) {
      this._queued.add(key);
      this._queue.push({ cx: chunkX, cy, cz: chunkZ });
     }
    }
   }
  }
 }

 _drainOne() {
  if (this._queue.length === 0) return;
  const e = this._queue.shift()!;
  const key = e.cx + "," + e.cy + "," + e.cz;
  this._queued.delete(key);
  this.grid.ensureChunk(e.cx, e.cy, e.cz);
  this.rebuildChunk(e.cx, e.cy, e.cz);
 }

 rebuildChunk(cx: number, cy: number, cz: number) {
  const key = cx + "," + cy + "," + cz;
  const voxels = this.grid.getChunk(cx, cy, cz);
  if (!voxels) return;
  const originX = cx * 16 * 0.5;
  const originY = cy * 16 * 0.5;
  const originZ = cz * 16 * 0.5;
  const res = meshChunk(voxels, originX, originY, originZ);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(res.positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(res.normals, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(res.colors, 3, true));
  geom.setIndex(new THREE.BufferAttribute(res.indices, 1));

  const old = this.meshes.get(key);
  if (old) {
   old.geometry.dispose();
   old.geometry = geom;
   this.recomputeTriangles();
   return;
  }

  const mesh = new THREE.Mesh(geom, this.material);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
   if (camera === this.gfx.threeCamera) {
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.material.uniforms.cameraPos.value.copy(this.camPos);
    this.prepassMaterial.uniforms.cameraPos.value.copy(this.camPos);
   }
  };
  this.gfx.addMesh(mesh, this.gfx.LAYER.OPAQUE, 12);
  this.depthPass.registerCaster(mesh, this.prepassMaterial);
  this.shadows.registerCaster(mesh, (c) => this._shadowMaterials[c], 2);
  this.meshes.set(key, mesh);
  this._coords.set(key, [cx, cy, cz]);
  this.recomputeTriangles();
 }

 makeMaterial(): THREE.RawShaderMaterial {
  const vs = getShader("voxelVertexShader");
  const fs = getShader("voxelPixelShader");
  const mat = new THREE.RawShaderMaterial({
   vertexShader: vs,
   fragmentShader: fs,
   uniforms: {
    viewProjection: { value: this._vp },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    cameraPos: { value: new THREE.Vector3() },
    fogDensity: { value: 0.005 },
   },
   side: THREE.FrontSide,
  });
  return mat;
 }

 makePrepassMaterial(): THREE.RawShaderMaterial {
  const vs = getShader("voxelPrepassVertexShader");
  const fs = getShader("prepassPixelShader");
  const mat = new THREE.RawShaderMaterial({
   vertexShader: vs,
   fragmentShader: fs,
   uniforms: {
    viewProjection: { value: this._vp },
    cameraPos: { value: new THREE.Vector3() },
   },
   side: THREE.FrontSide,
  });
  return mat;
 }

 _makeDepthMaterial(cascade: number): THREE.RawShaderMaterial {
  const mat = new THREE.RawShaderMaterial({
   vertexShader: getShader("voxelDepthVertexShader"),
   fragmentShader: getShader("terrainDepthPixelShader"),
   uniforms: {
    lightViewProjection: { value: new THREE.Matrix4() },
    cameraPos: { value: new THREE.Vector3() },
   },
   side: THREE.FrontSide,
  });
  return mat;
 }

 update(camPos: THREE.Vector3) {
  this.camPos.copy(camPos);
  this.material.uniforms.sunDir.value.copy(this.sky.sunDir);

  const scx = Math.floor(camPos.x / 8);
  const scz = Math.floor(camPos.z / 8);
  if (scx !== this._scanCX || scz !== this._scanCZ) {
   this._scanCX = scx;
   this._scanCZ = scz;
   this.ensureChunksAround(camPos.x, camPos.z, LOAD_RADIUS);

   for (const [key, coords] of this._coords) {
    const wx = coords[0] * 16 * 0.5;
    const wz = coords[2] * 16 * 0.5;
    const d = Math.hypot(wx - camPos.x, wz - camPos.z);
    if (d > UNLOAD_RADIUS) {
     const mesh = this.meshes.get(key);
     if (mesh) {
      this.depthPass.removeCaster(mesh);
      this.shadows.unregisterCaster(mesh);
      this.gfx.scene.remove(mesh);
      mesh.geometry.dispose();
      this.meshes.delete(key);
     }
     this._coords.delete(key);
    }
   }
  }

  let drained = 0;
  while (drained < MESH_BUDGET && this._queue.length > 0) {
   this._drainOne();
   drained++;
  }

  this.scheduleSave();
 }

 excavate(x: number, z: number, radius: number, depth: number) {
  const rVox = Math.ceil(radius / 0.5);
  const dVox = Math.ceil(depth / 0.5);
  let surf = 0;
  if (this.terrain) surf = this.terrain.heightfield.heightAt(x, z);
  const surfVoxel = Math.floor(surf / 0.5);
  const ix0 = Math.floor(x / 0.5);
  const iz0 = Math.floor(z / 0.5);
  for (let dx = -rVox; dx <= rVox; dx++) {
   for (let dz = -rVox; dz <= rVox; dz++) {
    if (dx * dx + dz * dz > rVox * rVox) continue;
    const ix = ix0 + dx;
    const iz = iz0 + dz;
    for (let dy = 0; dy < dVox; dy++) {
     const iy = surfVoxel - dy;
     this.grid.setVoxel(ix, iy, iz, 0);
    }
   }
  }
  try {
   this.terrain.deform.brush(x, z, radius, depth * 0.6, 0, 0, 0);
  } catch { }
  const flushed = this.grid.flushDirty();
  for (const c of flushed) {
   const key = c.cx + "," + c.cy + "," + c.cz;
   if (!this._queued.has(key)) {
    this._queued.add(key);
    this._queue.push({ cx: c.cx, cy: c.cy, cz: c.cz });
   }
  }
  this.scheduleSave();
 }

 floorAt(x: number, z: number): number | null {
  return this.grid.floorAt(x, z);
 }

 scheduleSave() {
  if (this.saveTimer !== null) return;
  this.saveTimer = window.setTimeout(() => {
   this.saveTimer = null;
   this.grid.saveDirty();
  }, 2000);
 }

 recomputeTriangles() {
  let t = 0;
  for (const m of this.meshes.values()) {
   const g = m.geometry;
   const idx = g.index;
   if (idx) t += idx.count / 3;
  }
  this.triangles = t;
 }
}
