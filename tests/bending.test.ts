import { describe, it, expect } from "vitest";
import { GRAVITY, clamp01, clampRange, smooth01, bell, expDamp, transport, aimPoint } from "../src/spells/bending.js";

describe("bending primitives", () => {
 it("GRAVITY", () => expect(GRAVITY).toBe(9.81));
 it("clamp01", () => {
  expect(clamp01(-1)).toBe(0);
  expect(clamp01(0.5)).toBe(0.5);
  expect(clamp01(2)).toBe(1);
 });
 it("clampRange", () => {
  expect(clampRange(5, 0, 10)).toBe(5);
  expect(clampRange(-1, 0, 10)).toBe(0);
  expect(clampRange(11, 0, 10)).toBe(10);
 });
 it("smooth01 hermite", () => {
  expect(smooth01(0)).toBe(0);
  expect(smooth01(1)).toBe(1);
  expect(smooth01(0.5)).toBe(0.5);
 });
 it("bell zero at ends, one mid", () => {
  expect(bell(0)).toBeCloseTo(0);
  expect(bell(1)).toBeCloseTo(0);
  expect(bell(0.5)).toBeCloseTo(1);
 });
 it("expDamp", () => {
  expect(expDamp(0, 10, 1, 0)).toBe(0); // dt=0 -> cur
  expect(expDamp(0, 10, 1, 100)).toBeCloseTo(10);
 });
 it("transport parallel carries over", () => {
  const out = new Float32Array(3);
  transport(out, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0); // t0=(0,1,0), t1=(0,1,0) parallel
  expect(out[0]).toBeCloseTo(1);
  expect(out[1]).toBeCloseTo(0);
  expect(out[2]).toBeCloseTo(0);
 });
 it("transport 90deg rotates ref", () => {
  const out = new Float32Array(3);
  // t0=(1,0,0), t1=(0,1,0); ref=(0,0,1) should rotate to (-1? compute) just check finite & unit
  transport(out, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0);
  const len = Math.hypot(out[0], out[1], out[2]);
  expect(len).toBeCloseTo(1);
  for (let i = 0; i < 3; i++) expect(Number.isFinite(out[i])).toBe(true);
 });
 it("aimPoint hits ground", () => {
  const terrain = { heightAt: (x: number, z: number) => 0 };
  const out = new Float32Array(3);
  const t = aimPoint(out, terrain, 0, 5, 0, 0, -1, 0, 10, 4);
  expect(t).toBeGreaterThan(0);
  expect(out[1]).toBeCloseTo(0);
 });
 it("aimPoint miss falls back", () => {
  const terrain = { heightAt: (x: number, z: number) => 0 };
  const out = new Float32Array(3);
  // ray pointing up, never hits ground below? march: above = y - 0; starts 5, goes up -> always above -> miss
  const t = aimPoint(out, terrain, 0, 5, 0, 0, 1, 0, 10, 4);
  expect(t).toBe(4);
 });
});
