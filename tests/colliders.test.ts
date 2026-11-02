import { describe, it, expect } from "vitest";
import { makeCapsulePool, sweptSphereVsCapsule, sweptSphereVsSphere } from "../src/physics/colliders.js";
import type { Capsule, SweepHit } from "../src/physics/colliders.js";

describe("makeCapsulePool", () => {
 it("creates n slots, all dead", () => {
  const pool = makeCapsulePool(5);
  expect(pool.length).toBe(5);
  for (const c of pool) expect(c.live).toBe(false);
 });
});

describe("sweptSphereVsSphere", () => {
 it("already overlapping -> t=0 hit", () => {
  const out: SweepHit = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
  const hit = sweptSphereVsSphere(0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, out);
  // distance 0 < R=1 -> overlap
  expect(hit).toBe(true);
  expect(out.t).toBe(0);
  expect(out.cap).toBeNull();
 });
 it("moving toward sphere hits", () => {
  const out: SweepHit = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
  // self at (0,0,0) radius 0.5 moves +x by 10; other at (5,0,0) radius 0.5 -> R=1, hit around t=0.4
  const hit = sweptSphereVsSphere(0, 0, 0, 10, 0, 0, 5, 0, 0, 0.5, 0.5, out);
  expect(hit).toBe(true);
  expect(out.t).toBeGreaterThan(0);
  expect(out.t).toBeLessThan(1);
  expect(out.cap).toBeNull();
 });
 it("moving away misses", () => {
  const out: SweepHit = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
  const hit = sweptSphereVsSphere(0, 0, 0, -10, 0, 0, 5, 0, 0, 0.5, 0.5, out);
  expect(hit).toBe(false);
 });
 it("zero motion, no overlap -> false", () => {
  const out: SweepHit = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
  const hit = sweptSphereVsSphere(0, 0, 0, 0, 0, 0, 5, 0, 0, 0.5, 0.5, out);
  expect(hit).toBe(false);
 });
 it("coincident centres produce non-NaN normal", () => {
  const out: SweepHit = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
  const hit = sweptSphereVsSphere(0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, out);
  expect(hit).toBe(true);
  expect(Number.isFinite(out.nx)).toBe(true);
  expect(Number.isFinite(out.ny)).toBe(true);
  expect(Number.isFinite(out.nz)).toBe(true);
 });
});

describe("sweptSphereVsCapsule", () => {
 it("degenerate capsule (zero-length axis) routes to sphere test", () => {
  const cap: Capsule = { ax: 3, ay: 0, az: 0, bx: 3, by: 0, bz: 0, r: 0.5, kind: "", owner: null, live: true };
  const out: SweepHit = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
  const hit = sweptSphereVsCapsule(0, 0, 0, 10, 0, 0, cap, 0.5, out);
  expect(hit).toBe(true);
  expect(out.cap).toBe(cap);
 });
 it("already overlapping capsule -> t=0", () => {
  const cap: Capsule = { ax: 0, ay: 0, az: 0, bx: 0, by: 10, bz: 0, r: 1, kind: "", owner: null, live: true };
  const out: SweepHit = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
  // sphere at origin radius 0.5 overlaps capsule radius 1 (R=1.5)
  const hit = sweptSphereVsCapsule(0, 0, 0, 0, 0, 0, cap, 0.5, out);
  expect(hit).toBe(true);
  expect(out.t).toBe(0);
  expect(out.cap).toBe(cap);
 });
 it("moving capsule hit", () => {
  const cap: Capsule = { ax: 5, ay: 0, az: 0, bx: 5, by: 1, bz: 0, r: 0.5, kind: "", owner: null, live: true };
  const out: SweepHit = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
  const hit = sweptSphereVsCapsule(0, 0, 0, 10, 0, 0, cap, 0.5, out);
  expect(hit).toBe(true);
  expect(out.t).toBeGreaterThan(0);
  expect(out.t).toBeLessThanOrEqual(1);
  expect(out.cap).toBe(cap);
 });
 it("zero motion, no overlap -> false", () => {
  const cap: Capsule = { ax: 5, ay: 0, az: 0, bx: 5, by: 1, bz: 0, r: 0.5, kind: "", owner: null, live: true };
  const out: SweepHit = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
  const hit = sweptSphereVsCapsule(0, 0, 0, 0, 0, 0, cap, 0.5, out);
  expect(hit).toBe(false);
 });
});
