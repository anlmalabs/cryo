import * as THREE from "three";
import { VoxelGrid, worldToVoxel } from "./voxelGrid.js";
import { meshChunk } from "./greedyMesher.js";
import type { Gfx } from "../core/gfx.js";
import type { Terrain } from "../terrain/terrain.js";
import { getShader } from "../shaders/registry.js";

const LOAD_RADIUS = 96;
const UNLOAD_RADIUS = 128;
const INITIAL_RADIUS = 64;

export class Excavation {
 gfx: Gfx;
 terrain: Terrain;
 grid: VoxelGrid;
 meshes: Map<string, THREE.Mesh> = new Map();
 triangles: number = 0;
 saveTimer: number | null = null;
 camPos: THREE.Vector3 = new THREE.Vector3();

 constructor(gfx: Gfx, terrain: Terrain) {
  this.gfx = gfx;
  this.terrain = terrain;
  this.grid = new VoxelGrid({ heightAt: (x, z) => terrain.heightfield.heightAt(x, z) });
 }

 async init(): Promise<void> {
  await this.grid.initPersistence();
  await this.grid.loadAll();
  this.ensureChunksAround(0, 0, INITIAL_RADIUS);
  this.meshAllDirty();
  this.scheduleSave();
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
    for (let cy = -1; cy <= 1; cy++) {
     const key = chunkX + "," + cy + "," + chunkZ;
     if (!this.grid.chunks.has(key)) {
      this.grid.ensureChunk(chunkX, cy, chunkZ);
     }
    }
   }
  }
 }

 meshAllDirty() {
  const dirty = this.grid.flushDirty();
  for (const c of dirty) {
   this.rebuildChunk(c.cx, c.cy, c.cz);
  }
  for (const key of this.grid.chunks.keys()) {
   if (!this.meshes.has(key)) {
    const parts = key.split(",").map(Number);
    this.rebuildChunk(parts[0], parts[1], parts[2]);
   }
  }
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
   this.gfx.scene.remove(old);
   old.geometry.dispose();
  }
  const mat = this.makeMaterial();
  const mesh = new THREE.Mesh(geom, mat);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
   if (camera === this.gfx.threeCamera) {
    mat.uniforms.viewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    mat.uniforms.cameraPos.value.copy(this.camPos);
   }
  };
  this.gfx.addMesh(mesh, this.gfx.LAYER.OPAQUE, 12);
  this.meshes.set(key, mesh);
  this.recomputeTriangles();
 }

 makeMaterial(): THREE.RawShaderMaterial {
  const vs = getShader("voxelVertexShader");
  const fs = getShader("voxelPixelShader");
  const mat = new THREE.RawShaderMaterial({
   vertexShader: vs,
   fragmentShader: fs,
   uniforms: {
    viewProjection: { value: new THREE.Matrix4() },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    cameraPos: { value: new THREE.Vector3() },
    fogDensity: { value: 0.005 },
   },
   side: THREE.FrontSide,
  });
  return mat;
 }

 update(camPos: THREE.Vector3) {
  this.camPos.copy(camPos);
  this.ensureChunksAround(camPos.x, camPos.z, LOAD_RADIUS);
  for (const key of this.grid.chunks.keys()) {
   if (!this.meshes.has(key)) {
    const parts = key.split(",").map(Number);
    this.rebuildChunk(parts[0], parts[1], parts[2]);
   }
  }
  for (const [key, mesh] of this.meshes) {
   const parts = key.split(",").map(Number);
   const wx = parts[0] * 16 * 0.5;
   const wz = parts[2] * 16 * 0.5;
   const d = Math.hypot(wx - camPos.x, wz - camPos.z);
   if (d > UNLOAD_RADIUS) {
    this.gfx.scene.remove(mesh);
    mesh.geometry.dispose();
    this.meshes.delete(key);
   }
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
  this.meshAllDirty();
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
