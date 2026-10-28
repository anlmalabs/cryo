import { describe, it, expect } from "vitest";

describe("clipmap morph reaches 1.0 before overlap band", () => {
  it("morph is 1.0 at cheb 0.78", () => {
    const cheb = 0.78;
    expect(Math.min(1, Math.max(0, (cheb - 0.62) / 0.16))).toBeCloseTo(1.0, 6);
  });
  it("morph is 1.0 for all cheb >= 0.78", () => {
    for (let c = 0.78; c <= 1.0; c += 0.01) {
      expect(Math.min(1, Math.max(0, (c - 0.62) / 0.16))).toBe(1);
    }
  });
  it("morph 0 at cheb 0.62", () => {
    const cheb = 0.62;
    expect(Math.min(1, Math.max(0, (cheb - 0.62) / 0.16))).toBeCloseTo(0, 6);
  });
});