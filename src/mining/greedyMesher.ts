/**
 * Greedy mesher for a single 16³ chunk.
 *
 * Pure function. Returns interleaved position/normal/color arrays + indices.
 */

import { CHUNK, VOXEL } from "./voxelGrid.js";

const MAT_EMPTY = 0;

export interface MeshResult {
 positions: Float32Array;
 normals: Float32Array;
 colors: Uint8Array;
 indices: Uint32Array;
}

const PALETTE: number[][] = [
 [0, 0, 0],
 [230, 230, 240],
 [200, 220, 240],
 [120, 120, 130],
];

export function meshChunk(voxels: Uint8Array, originX: number, originY: number, originZ: number): MeshResult {
 // collect faces
 const faces: { axis: number; slice: number; u: number; v: number; w: number; du: number; dv: number; mat: number; sign: number }[] = [];
 // We'll do a simplified greedy: for each axis, for each slice, scan 2D grid, merge runs.
 // Axis 0 = X faces (normal +/- X), slices along X
 // For performance and correctness, implement standard greedy mesher.

 // Helper to index voxel
 const idx = (x: number, y: number, z: number) => (y * CHUNK + z) * CHUNK + x;

 // We'll generate quads per axis.
 interface Quad { x: number; y: number; z: number; du: number; dv: number; axis: number; sign: number; mat: number; }
 const quads: Quad[] = [];

 // Axis X (faces perpendicular to X): for each x slice boundary between x-1 and x
 for (let x = 0; x <= CHUNK; x++) {
  // for each y,z cell
  for (let y = 0; y < CHUNK; y++) {
   for (let z = 0; z < CHUNK; z++) {
    const a = (x > 0) ? voxels[idx(x - 1, y, z)] : 0;
    const b = (x < CHUNK) ? voxels[idx(x, y, z)] : 0;
    if (a === b) continue;
    if (a === MAT_EMPTY && b === MAT_EMPTY) continue;
    if (a !== MAT_EMPTY && b !== MAT_EMPTY) continue; // internal, no face
    // face exists between empty and solid
    const solid = a !== MAT_EMPTY ? a : b;
    const sign = a !== MAT_EMPTY ? 1 : -1; // solid on -x side -> normal +x? 
    // normal points from solid to empty
    const normalSign = a !== MAT_EMPTY ? 1 : -1;
    quads.push({ x, y, z, du: 1, dv: 1, axis: 0, sign: normalSign, mat: solid });
   }
  }
 }
 // This naive per-voxel won't merge; need greedy merge. Given time, implement merge for X axis only partially.
 // To satisfy tests (1 voxel -> 12 tris; 2 adjacent -> 10), we need merging. Let's implement greedy properly.

 // Reset quads; do greedy per axis.
 quads.length = 0;

 // We'll implement greedy merging for each axis using a mask grid.
 // Axis 0: faces in YZ plane, varying x.
 for (let x = 0; x <= CHUNK; x++) {
  // build mask[y][z]
  const mask: number[] = new Array(CHUNK * CHUNK).fill(0); // material*sign encoded; 0 = no face
  for (let y = 0; y < CHUNK; y++) {
   for (let z = 0; z < CHUNK; z++) {
    const a = (x > 0) ? voxels[idx(x - 1, y, z)] : 0;
    const b = (x < CHUNK) ? voxels[idx(x, y, z)] : 0;
    if (a === 0 && b === 0) continue;
    if (a !== 0 && b !== 0) continue;
    const solid = a !== 0 ? a : b;
    const normalSign = a !== 0 ? 1 : -1;
    // encode solid + sign
    mask[y * CHUNK + z] = solid * 10 + (normalSign > 0 ? 1 : 2);
   }
  }
  // greedy merge
  const visited = new Uint8Array(CHUNK * CHUNK);
  for (let y = 0; y < CHUNK; y++) {
   for (let z = 0; z < CHUNK; z++) {
    const i = y * CHUNK + z;
    if (visited[i]) continue;
    const m = mask[i];
    if (m === 0) { visited[i] = 1; continue; }
    const solid = Math.floor(m / 10);
    const signCode = m % 10;
    // merge in z
    let w = 1;
    while (z + w < CHUNK && !visited[y * CHUNK + (z + w)] && mask[y * CHUNK + (z + w)] === m) w++;
    // merge in y
    let h = 1;
    outer: while (y + h < CHUNK) {
     for (let dz = 0; dz < w; dz++) {
      const ii = (y + h) * CHUNK + (z + dz);
      if (visited[ii] || mask[ii] !== m) { break outer; }
     }
     h++;
    }
    // mark visited
    for (let dy = 0; dy < h; dy++)
     for (let dz = 0; dz < w; dz++)
      visited[(y + dy) * CHUNK + (z + dz)] = 1;
    const normalSign = signCode === 1 ? 1 : -1;
    quads.push({ x, y, z, du: h, dv: w, axis: 0, sign: normalSign, mat: solid });
   }
  }
 }

 // Axis Y (faces perpendicular to Y)
 for (let y = 0; y <= CHUNK; y++) {
  const mask: number[] = new Array(CHUNK * CHUNK).fill(0);
  for (let z = 0; z < CHUNK; z++) {
   for (let x = 0; x < CHUNK; x++) {
    const a = (y > 0) ? voxels[idx(x, y - 1, z)] : 0;
    const b = (y < CHUNK) ? voxels[idx(x, y, z)] : 0;
    if (a === 0 && b === 0) continue;
    if (a !== 0 && b !== 0) continue;
    const solid = a !== 0 ? a : b;
    const normalSign = a !== 0 ? 1 : -1;
    mask[z * CHUNK + x] = solid * 10 + (normalSign > 0 ? 1 : 2);
   }
  }
  const visited = new Uint8Array(CHUNK * CHUNK);
  for (let z = 0; z < CHUNK; z++) {
   for (let x = 0; x < CHUNK; x++) {
    const i = z * CHUNK + x;
    if (visited[i]) continue;
    const m = mask[i];
    if (m === 0) { visited[i] = 1; continue; }
    const solid = Math.floor(m / 10);
    const signCode = m % 10;
    let w = 1;
    while (x + w < CHUNK && !visited[z * CHUNK + (x + w)] && mask[z * CHUNK + (x + w)] === m) w++;
    let h = 1;
    outer: while (z + h < CHUNK) {
     for (let dx = 0; dx < w; dx++) {
      const ii = (z + h) * CHUNK + (x + dx);
      if (visited[ii] || mask[ii] !== m) { break outer; }
     }
     h++;
    }
    for (let dz = 0; dz < h; dz++)
     for (let dx = 0; dx < w; dx++)
      visited[(z + dz) * CHUNK + (x + dx)] = 1;
    const normalSign = signCode === 1 ? 1 : -1;
    quads.push({ x, y, z: z, du: w, dv: h, axis: 1, sign: normalSign, mat: solid });
    // store z start in z field; du=width in x, dv=height in z
   }
  }
 }

 // Axis Z
 for (let z = 0; z <= CHUNK; z++) {
  const mask: number[] = new Array(CHUNK * CHUNK).fill(0);
  for (let y = 0; y < CHUNK; y++) {
   for (let x = 0; x < CHUNK; x++) {
    const a = (z > 0) ? voxels[idx(x, y, z - 1)] : 0;
    const b = (z < CHUNK) ? voxels[idx(x, y, z)] : 0;
    if (a === 0 && b === 0) continue;
    if (a !== 0 && b !== 0) continue;
    const solid = a !== 0 ? a : b;
    const normalSign = a !== 0 ? 1 : -1;
    mask[y * CHUNK + x] = solid * 10 + (normalSign > 0 ? 1 : 2);
   }
  }
  const visited = new Uint8Array(CHUNK * CHUNK);
  for (let y = 0; y < CHUNK; y++) {
   for (let x = 0; x < CHUNK; x++) {
    const i = y * CHUNK + x;
    if (visited[i]) continue;
    const m = mask[i];
    if (m === 0) { visited[i] = 1; continue; }
    const solid = Math.floor(m / 10);
    const signCode = m % 10;
    let w = 1;
    while (x + w < CHUNK && !visited[y * CHUNK + (x + w)] && mask[y * CHUNK + (x + w)] === m) w++;
    let h = 1;
    outer: while (y + h < CHUNK) {
     for (let dx = 0; dx < w; dx++) {
      const ii = (y + h) * CHUNK + (x + dx);
      if (visited[ii] || mask[ii] !== m) { break outer; }
     }
     h++;
    }
    for (let dy = 0; dy < h; dy++)
     for (let dx = 0; dx < w; dx++)
      visited[(y + dy) * CHUNK + (x + dx)] = 1;
    const normalSign = signCode === 1 ? 1 : -1;
    quads.push({ x: x, y, z, du: w, dv: h, axis: 2, sign: normalSign, mat: solid });
   }
  }
 }

 // Build vertex/index buffers
 // Each quad -> 4 vertices, 2 tris (6 indices) but greedy merged quads still one quad face = 2 tris.
 // Count
 let vCount = 0;
 for (const q of quads) vCount += 4;
 const positions = new Float32Array(vCount * 3);
 const normals = new Float32Array(vCount * 3);
 const colors = new Uint8Array(vCount * 3);
 const indices = new Uint32Array(quads.length * 6);

 let vi = 0;
 let ii = 0;
 for (const q of quads) {
  const col = PALETTE[q.mat] || [255, 255, 255];
  // determine corner positions based on axis
  // axis 0: plane x = q.x (voxel boundary), spans y in [q.y, q.y+q.du] voxels, z in [q.z, q.z+q.dv] voxels
  // in world: origin + voxel coords
  const corners: [number, number, number][] = [];
  if (q.axis === 0) {
   const xw = originX + q.x * VOXEL;
   const y0 = originY + q.y * VOXEL;
   const y1 = originY + (q.y + q.du) * VOXEL;
   const z0 = originZ + q.z * VOXEL;
   const z1 = originZ + (q.z + q.dv) * VOXEL;
   corners.push([xw, y0, z0], [xw, y1, z0], [xw, y1, z1], [xw, y0, z1]);
  } else if (q.axis === 1) {
   const yw = originY + q.y * VOXEL;
   const x0 = originX + q.x * VOXEL; // note: for axis1 we stored x in q.x? need fix
   // Actually in axis1 loop we pushed x,z swapped? Let's recompute: we stored {x, y, z: z} with du=width(x), dv=height(z). But x variable there was loop x, z loop z. quad.x = x (voxel x start), q.z = z start (voxel z start)? We set z: z in push? We pushed z: z (the outer loop z). and x param = x. So q.x = voxel x start, q.z = voxel z start. Good.
   const x0b = originX + q.x * VOXEL;
   const x1b = originX + (q.x + q.du) * VOXEL;
   const z0b = originZ + q.z * VOXEL;
   const z1b = originZ + (q.z + q.dv) * VOXEL;
   corners.push([x0b, yw, z0b], [x1b, yw, z0b], [x1b, yw, z1b], [x0b, yw, z1b]);
  } else {
   const zw = originZ + q.z * VOXEL;
   const x0c = originX + q.x * VOXEL;
   const x1c = originX + (q.x + q.du) * VOXEL;
   const y0c = originY + q.y * VOXEL;
   const y1c = originY + (q.y + q.dv) * VOXEL;
   corners.push([x0c, y0c, zw], [x1c, y0c, zw], [x1c, y1c, zw], [x0c, y1c, zw]);
  }

  // normal
  let nx = 0, ny = 0, nz = 0;
  if (q.axis === 0) nx = q.sign;
  else if (q.axis === 1) ny = q.sign;
  else nz = q.sign;

  // If sign flips winding? We'll just emit corners in order; ensure CCW not critical for rasterizer (DoubleSide). Keep simple.
  const base = vi;
  for (let c = 0; c < 4; c++) {
   positions[vi * 3 + 0] = corners[c][0];
   positions[vi * 3 + 1] = corners[c][1];
   positions[vi * 3 + 2] = corners[c][2];
   normals[vi * 3 + 0] = nx;
   normals[vi * 3 + 1] = ny;
   normals[vi * 3 + 2] = nz;
   colors[vi * 3 + 0] = col[0];
   colors[vi * 3 + 1] = col[1];
   colors[vi * 3 + 2] = col[2];
   vi++;
  }
  // two triangles
  indices[ii++] = base;
  indices[ii++] = base + 1;
  indices[ii++] = base + 2;
  indices[ii++] = base;
  indices[ii++] = base + 2;
  indices[ii++] = base + 3;
 }

 return { positions, normals, colors, indices };
}
