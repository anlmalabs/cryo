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
  // carve: set voxel at iy=0 solid, iy=1 empty
  g.setVoxel(0, 0, 0, 1);
  // surface unknown (null heightQuery) -> surfVoxel 0
  const f = g.floorAt(0, 0);
  // topmost solid below empty -> 0 voxel top = 1*0.5? formula (iy+1)*0.5
  expect(f).not.toBeNull();
 });
});