import { describe, it, expect } from "vitest";
import * as loading from "../src/core/loading.js";

describe("loading", () => {
 it("phase resolves without DOM", async () => {
  await expect(loading.phase("x", 0.5)).resolves.toBeUndefined();
 });
 it("done resolves", async () => {
  await expect(loading.done()).resolves.toBeUndefined();
 });
 it("gate returns false without gate markup", async () => {
  const r = await loading.gate();
  expect(r).toBe(false);
 });
 it("fail does not throw", () => {
  expect(() => loading.fail("boom")).not.toThrow();
 });
 it("nextFrame is a function", () => {
  expect(typeof loading.nextFrame).toBe("function");
 });
});
