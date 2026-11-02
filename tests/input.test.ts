/**
 */
import { describe, it, expect } from "vitest";
import { input, touch, isDown } from "../src/core/input.js";

describe("input state", () => {
 it("input has movement fields", () => {
  expect(typeof input.moveX).toBe("number");
  expect(typeof input.moveZ).toBe("number");
  expect(typeof input.flying).toBe("boolean");
 });
 it("touch state", () => {
  expect(typeof touch.present).toBe("boolean");
 });
 it("isDown returns boolean", () => {
  expect(typeof isDown("KeyA")).toBe("boolean");
 });
});
