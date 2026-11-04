import { describe, it, expect } from "vitest";
import { meshChunk } from "../src/mining/greedyMesher.js";
import { CHUNK } from "../src/mining/voxelGrid.js";

describe("greedyMesher", () => {
  it("single solid voxel -> 12 triangles", () => {
    const voxels = new Uint8Array(CHUNK * CHUNK * CHUNK);
    const idx = (x: number, y: number, z: number) => (y * CHUNK + z) * CHUNK + x;
    voxels[idx(0, 0, 0)] = 1;
    const r = meshChunk(voxels, 0, 0, 0);
    expect(r.indices.length / 3).toBe(12);
  });
  it("two adjacent same-material voxels merge: internal face culled -> 12 triangles", () => {
    // 6 merged quads x 2 tris = 12; unmerged-culled would be 10 quads = 20 tris (pins the merge)
    const voxels = new Uint8Array(CHUNK * CHUNK * CHUNK);
    const idx = (x: number, y: number, z: number) => (y * CHUNK + z) * CHUNK + x;
    voxels[idx(0, 0, 0)] = 1;
    voxels[idx(1, 0, 0)] = 1;
    const r = meshChunk(voxels, 0, 0, 0);
    expect(r.indices.length / 3).toBe(12);
  });
});
