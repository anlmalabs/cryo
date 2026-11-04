import { describe, it, expect } from "vitest";
import { VoxelGrid } from "../src/mining/voxelGrid.js";

describe("voxelGrid", () => {
 it("set/get roundtrip", () => {
  const g = new VoxelGrid(null);
  g.setVoxel(1, 2, 3, 1);
  expect(g.getVoxel(1, 2, 3)).toBe(1);
 });
 it("dirty flag", () => {
  const g = new VoxelGrid(null);
  g.setVoxel(0, 0, 0, 2);
  expect(g.dirty.size).toBeGreaterThan(0);
 });
 it("floorAt on carved column", () => {
  const g = new VoxelGrid(null);
  g.setVoxel(0, 0, 0, 1);
  const f = g.floorAt(0, 0);
  expect(f).not.toBeNull();
 });
 it("fill layering with constant height", () => {
  const h = 4.0;
  const hq = { heightAt: () => h };
  const g = new VoxelGrid(hq);
  g.ensureChunk(0, 0, 0);
  const c = g.getChunk(0, 0, 0)!;
  const surfVoxel = Math.floor(h / 0.5);
  const baseVoxel = surfVoxel - 8;
  for (let ly = 0; ly < 16; ly++) {
   const iy = ly;
   for (let lz = 0; lz < 16; lz++)
    for (let lx = 0; lx < 16; lx++) {
     const v = c[(ly * 16 + lz) * 16 + lx];
     if (iy > surfVoxel) expect(v).toBe(0);
     else if (iy === baseVoxel) expect(v).toBe(3);
     else if (iy < baseVoxel) expect(v).toBe(3);
     else if (iy <= surfVoxel) expect(v).toBe(1);
    }
  }
 });
});
