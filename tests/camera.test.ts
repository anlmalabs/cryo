import { describe, it, expect } from "vitest";
import { expDamp } from "../src/core/camera.js";

describe("expDamp", () => {
 it("dt=0 returns cur", () => {
  expect(expDamp(5, 10, 1, 0)).toBe(5);
 });
 it("large dt approaches target", () => {
  expect(expDamp(5, 10, 1, 100)).toBeCloseTo(10);
 });
});
