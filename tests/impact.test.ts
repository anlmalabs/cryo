import { describe, it, expect } from "vitest";
import { severityFor, speederImpactResponse } from "../src/physics/impact.js";
import type { ImpactParams, ImpactResponse } from "../src/physics/impact.js";

describe("severityFor", () => {
 it("scrape below hitAt", () => {
  expect(severityFor(0, 5, 10)).toBe("scrape");
  expect(severityFor(4.9, 5, 10)).toBe("scrape");
 });
 it("hit at hitAt", () => {
  expect(severityFor(5, 5, 10)).toBe("hit");
  expect(severityFor(9.9, 5, 10)).toBe("hit");
 });
 it("crash above crashAt", () => {
  expect(severityFor(10.1, 5, 10)).toBe("crash");
  expect(severityFor(10, 5, 10)).toBe("hit"); // crashAt exclusive
 });
});

describe("speederImpactResponse", () => {
 const baseParams = (over: Partial<ImpactParams> = {}): ImpactParams => ({
  vx: 0, vz: 0, speed: 0,
  nx: 1, nz: 0,
  ovx: 0, ovz: 0,
  massRatio: Infinity,
  hitSide: 0,
  restitution: 0.5,
  hitAt: 5, crashAt: 10,
  ...over,
 });

 it("separating contact changes nothing, spin 0", () => {
  const out: ImpactResponse = { vx: 0, vz: 0, spin: 0, normalSpeed: 0, severity: "scrape" };
  const p = baseParams({ vx: -3, vz: 0 }); // moving away (vn positive? vx relative = -3, n=+1 => vn=-3 <0 actually closing)
  // make separating: craft moving in +x, normal +x => vn=+3 >=0
  const p2 = baseParams({ vx: 3, vz: 0 });
  const r = speederImpactResponse(out, p2);
  expect(r.vx).toBe(3);
  expect(r.vz).toBe(0);
  expect(r.spin).toBe(0);
  expect(r.normalSpeed).toBe(0);
  expect(r.severity).toBe("scrape");
 });

 it("closing contact reflects normal component", () => {
  const out: ImpactResponse = { vx: 0, vz: 0, spin: 0, normalSpeed: 0, severity: "scrape" };
  const p = baseParams({ vx: -10, vz: 0, massRatio: Infinity, restitution: 0.5 });
  const r = speederImpactResponse(out, p);
  // vn = -10; w=1; dvn = -(1+0.5)*(-10)*1 = 15; new vx = -10 + 15 = 5
  expect(r.vx).toBeCloseTo(5);
  expect(r.vz).toBeCloseTo(0);
  expect(r.normalSpeed).toBeCloseTo(10);
  expect(r.severity).toBe("hit");
 });

 it("tangential velocity untouched", () => {
  const out: ImpactResponse = { vx: 0, vz: 0, spin: 0, normalSpeed: 0, severity: "scrape" };
  const p = baseParams({ vx: -8, vz: 6, massRatio: Infinity, restitution: 0.3 });
  const r = speederImpactResponse(out, p);
  // tangential (z) should remain 6
  expect(r.vz).toBeCloseTo(6);
 });

 it("equal mass halves reversal", () => {
  const out: ImpactResponse = { vx: 0, vz: 0, spin: 0, normalSpeed: 0, severity: "scrape" };
  const p = baseParams({ vx: -10, vz: 0, massRatio: 1, restitution: 0.5 });
  const r = speederImpactResponse(out, p);
  // w=0.5; dvn=-(1.5)*(-10)*0.5=7.5; new vx=-10+7.5=-2.5
  expect(r.vx).toBeCloseTo(-2.5);
 });

 it("degenerate zero normal is no-op", () => {
  const out: ImpactResponse = { vx: 0, vz: 0, spin: 0, normalSpeed: 0, severity: "scrape" };
  const p = baseParams({ vx: -10, vz: 0, nx: 0, nz: 0 });
  const r = speederImpactResponse(out, p);
  expect(r.vx).toBe(-10);
  expect(r.vz).toBe(0);
  expect(r.spin).toBe(0);
  expect(r.normalSpeed).toBe(0);
 });

 it("spin scales with shear and hitSide", () => {
  const out: ImpactResponse = { vx: 0, vz: 0, spin: 0, normalSpeed: 0, severity: "scrape" };
  const p = baseParams({ vx: -5, vz: 4, hitSide: 1, restitution: 0.5, hitAt: 1, crashAt: 100 });
  const r = speederImpactResponse(out, p);
  // shear magnitude = sqrt(tx^2+tz^2); tx = rvx - vn*nx = -5 - (-5)*1 = 0; tz = 4 - (-5)*0? vn=-5; tz = rvz - vn*nz = 4 - (-5)*0 = 4
  // spin = 0.065 * 4 * 1 = 0.26
  expect(r.spin).toBeCloseTo(0.065 * 4 * 1);
 });

 it("obstacle velocity affects relative closing", () => {
  const out: ImpactResponse = { vx: 0, vz: 0, spin: 0, normalSpeed: 0, severity: "scrape" };
  // craft stationary, obstacle moving toward craft (ovx=-5 means obstacle moving -x? relative = 0 - (-5)=5, vn=5 >=0 separating)
  const p = baseParams({ vx: 0, vz: 0, ovx: -5, massRatio: Infinity });
  const r = speederImpactResponse(out, p);
  // relative vn = 5, separating -> no change
  expect(r.vx).toBe(0);
  expect(r.normalSpeed).toBe(0);
 });
});
