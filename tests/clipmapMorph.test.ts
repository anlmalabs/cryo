import { describe, it, expect } from "vitest";
import { BASE_SPACING, GRID_HALF_N } from "../src/terrain/clipmapMesh.js";

describe("clipmap mesh constants", () => {
 it("BASE_SPACING", () => expect(BASE_SPACING).toBe(0.085));
 it("GRID_HALF_N", () => expect(GRID_HALF_N).toBe(80));
});

describe("clipmap morph reaches 1.0 before overlap band", () => {
 // The real morph lives in the vertex shader; the formula is documented here
 // as the contract that the clipmap relies on. Keep the formula in sync with
 // src/shaders/terrain.vertex.glsl if it ever changes.
 const morph = (cheb: number) => Math.min(1, Math.max(0, (cheb - 0.62) / 0.16));
 it("morph is 1.0 at cheb 0.78", () => {
  expect(morph(0.78)).toBeCloseTo(1.0, 6);
 });
 it("morph is 1.0 for all cheb >= 0.78", () => {
  for (let c = 0.78; c <= 1.0; c += 0.01) {
   expect(morph(c)).toBe(1);
  }
 });
 it("morph 0 at cheb 0.62", () => {
  expect(morph(0.62)).toBeCloseTo(0, 6);
 });
});
