/**
 * Layered mining — voxel bedrock beneath the snow sim.
 *
 * Chunked byte grid: 16³ voxels per chunk, 0.5 m per voxel (matches the
 * heightfield texel). Voxel byte = material id: 0 empty, 1 snow, 2 ice, 3 rock.
 * Dirty chunks persist to IndexedDB (database `cryo-mining`, store `chunks`).
 */

const CHUNK = 16;
const VOXEL = 0.5;
const CHUNK_WORLD = CHUNK * VOXEL; // 8 metres
const BASE_DEPTH = 8; // voxels (4 m) below the surface floor
const BOUNDS = 256; // metres

const MAT_EMPTY = 0;
const MAT_SNOW = 1;
const MAT_ICE = 2;
const MAT_ROCK = 3;

export { MAT_EMPTY, MAT_SNOW, MAT_ICE, MAT_ROCK, CHUNK, VOXEL, CHUNK_WORLD };

export type VoxelCoord = { ix: number; iy: number; iz: number };
export type ChunkCoord = { cx: number; cy: number; cz: number };

export function worldToVoxel(x: number, y: number, z: number): VoxelCoord {
 return {
  ix: Math.floor(x / VOXEL),
  iy: Math.floor(y / VOXEL),
  iz: Math.floor(z / VOXEL),
 };
}

export function voxelToChunk(ix: number, iy: number, iz: number): ChunkCoord {
 return {
  cx: Math.floor(ix / CHUNK),
  cy: Math.floor(iy / CHUNK),
  cz: Math.floor(iz / CHUNK),
 };
}

export function chunkKey(cx: number, cy: number, cz: number): string {
 return cx + "," + cy + "," + cz;
}

function voxelIndex(ix: number, iy: number, iz: number): number {
 // local within chunk
 const lx = ((ix % CHUNK) + CHUNK) % CHUNK;
 const ly = ((iy % CHUNK) + CHUNK) % CHUNK;
 const lz = ((iz % CHUNK) + CHUNK) % CHUNK;
 return (ly * CHUNK + lz) * CHUNK + lx;
}

export interface HeightQuery {
 heightAt(x: number, z: number): number;
}

export class VoxelGrid {
 chunks: Map<string, Uint8Array> = new Map();
 dirty: Set<string> = new Set();
 version: number = 0;
 private heightQuery: HeightQuery | null;
 private memOnly: boolean = false;
 private db: IDBDatabase | null = null;
 private floorCache: Map<string, number | null> = new Map();
 private floorVersion: number = 0;

 constructor(heightQuery?: HeightQuery | null) {
  this.heightQuery = heightQuery ?? null;
 }

 setHeightQuery(hq: HeightQuery | null) {
  this.heightQuery = hq;
 }

 private inBounds(ix: number, iy: number, iz: number): boolean {
  const x = ix * VOXEL;
  const z = iz * VOXEL;
  if (Math.abs(x) > BOUNDS || Math.abs(z) > BOUNDS) return false;
  return true;
 }

 getChunk(cx: number, cy: number, cz: number): Uint8Array | null {
  return this.chunks.get(chunkKey(cx, cy, cz)) ?? null;
 }

 ensureChunk(cx: number, cy: number, cz: number): Uint8Array {
  const k = chunkKey(cx, cy, cz);
  let c = this.chunks.get(k);
  if (c) return c;
  c = new Uint8Array(CHUNK * CHUNK * CHUNK);
  // initial fill
  this.fillChunk(c, cx, cy, cz);
  this.chunks.set(k, c);
  this.dirty.add(k);
  return c;
 }

 private fillChunk(c: Uint8Array, cx: number, cy: number, cz: number) {
  for (let ly = 0; ly < CHUNK; ly++) {
   for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
     const wx = (cx * CHUNK + lx) * VOXEL;
     const wy = (cy * CHUNK + ly) * VOXEL;
     const wz = (cz * CHUNK + lz) * VOXEL;
     let mat = MAT_EMPTY;
     if (this.heightQuery) {
      const surf = this.heightQuery.heightAt(wx, wz);
      const surfVoxel = Math.floor(surf / VOXEL);
      const baseVoxel = surfVoxel - BASE_DEPTH;
      const iy = cy * CHUNK + ly;
      if (iy <= surfVoxel && iy >= baseVoxel) {
       mat = iy === baseVoxel ? MAT_ROCK : MAT_SNOW;
      }
      // hard floor at baseDepth
      if (iy < baseVoxel) mat = MAT_ROCK;
      if (wy > surf) mat = MAT_EMPTY;
     } else {
      // default: fill lower half
      if (ly < CHUNK / 2) mat = MAT_SNOW;
     }
     c[(ly * CHUNK + lz) * CHUNK + lx] = mat;
    }
   }
  }
 }

 getVoxel(ix: number, iy: number, iz: number): number {
  if (!this.inBounds(ix, iy, iz)) return MAT_EMPTY;
  const { cx, cy, cz } = voxelToChunk(ix, iy, iz);
  const c = this.chunks.get(chunkKey(cx, cy, cz));
  if (!c) return MAT_EMPTY;
  return c[voxelIndex(ix, iy, iz)];
 }

 setVoxel(ix: number, iy: number, iz: number, mat: number): boolean {
  if (!this.inBounds(ix, iy, iz)) return false;
  const { cx, cy, cz } = voxelToChunk(ix, iy, iz);
  const c = this.ensureChunk(cx, cy, cz);
  const i = voxelIndex(ix, iy, iz);
  if (c[i] === mat) return false;
  c[i] = mat;
  this.dirty.add(chunkKey(cx, cy, cz));
  this.version++;
  this.floorVersion++;
  this.floorCache.clear();
  return true;
 }

 flushDirty(): { cx: number; cy: number; cz: number }[] {
  const out: { cx: number; cy: number; cz: number }[] = [];
  for (const k of this.dirty) {
   const parts = k.split(",").map(Number);
   out.push({ cx: parts[0], cy: parts[1], cz: parts[2] });
  }
  return out;
 }

 async initPersistence(): Promise<void> {
  if (typeof indexedDB === "undefined") {
   this.memOnly = true;
   console.warn("[mining] IndexedDB unavailable; in-memory only");
   return;
  }
  try {
   const req = indexedDB.open("cryo-mining", 1);
   await new Promise<void>((resolve, reject) => {
    req.onupgradeneeded = () => {
     const db = req.result;
     if (!db.objectStoreNames.contains("chunks")) {
      db.createObjectStore("chunks", { keyPath: "key" });
     }
    };
    req.onsuccess = () => {
     this.db = req.result;
     resolve();
    };
    req.onerror = () => reject(req.error);
   });
  } catch (e) {
   this.memOnly = true;
   console.warn("[mining] IndexedDB open failed; in-memory only", e);
  }
 }

 async loadAll(): Promise<void> {
  if (this.memOnly || !this.db) return;
  const db = this.db;
  await new Promise<void>((resolve, reject) => {
   const tx = db.transaction("chunks", "readonly");
   const store = tx.objectStore("chunks");
   const req = store.getAll();
   req.onsuccess = () => {
    const rows = req.result as { key: string; bytes: Uint8Array; version: number }[];
    for (const r of rows) {
     const arr = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
     this.chunks.set(r.key, arr);
    }
    resolve();
   };
   req.onerror = () => reject(req.error);
  });
 }

 async saveDirty(): Promise<void> {
  if (this.memOnly || !this.db) return;
  const dirty = [...this.dirty];
  if (dirty.length === 0) return;
  const db = this.db;
  await new Promise<void>((resolve, reject) => {
   const tx = db.transaction("chunks", "readwrite");
   const store = tx.objectStore("chunks");
   for (const k of dirty) {
    const c = this.chunks.get(k);
    if (!c) continue;
    store.put({ key: k, bytes: c, version: this.version });
   }
   tx.oncomplete = () => {
    this.dirty.clear();
    resolve();
   };
   tx.onerror = () => reject(tx.error);
  });
 }

 floorAt(x: number, z: number): number | null {
  const ix = Math.floor(x / VOXEL);
  const iz = Math.floor(z / VOXEL);
  const cacheKey = ix + "," + iz;
  // memoized with version
  const cached = this.floorCache.get(cacheKey);
  // We can't distinguish version via cache; store version in key instead
  const vKey = cacheKey + "@" + this.floorVersion;
  if (this.floorCache.has(vKey)) {
   return this.floorCache.get(vKey)!;
  }
  // scan column descending
  // find surface voxel
  let surfVoxel = 0;
  if (this.heightQuery) {
   const surf = this.heightQuery.heightAt(x, z);
   surfVoxel = Math.floor(surf / VOXEL);
  } else {
   surfVoxel = 0;
  }
  // topmost solid voxel below an empty voxel
  let topSolid: number | null = null;
  for (let iy = surfVoxel; iy >= surfVoxel - 64; iy--) {
   const v = this.getVoxel(ix, iy, iz);
   if (v !== MAT_EMPTY) {
    // check voxel above is empty (or out of range treated empty)
    const above = iy + 1 > surfVoxel ? MAT_EMPTY : this.getVoxel(ix, iy + 1, iz);
    if (above === MAT_EMPTY) {
     topSolid = iy;
     break;
    }
   }
  }
  const result = topSolid === null ? null : (topSolid + 1) * VOXEL;
  this.floorCache.set(vKey, result);
  return result;
 }
}
