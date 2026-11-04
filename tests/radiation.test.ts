import { describe, it, expect } from "vitest";
import { RadiationSystem } from "../src/survival/radiation.js";

function mk() {
  const c = { shieldHit: 0, broken: 0, radFlash: 0, death: 0 };
  const r = new RadiationSystem({
    onShieldHit: () => { c.shieldHit++; },
    onShieldBroken: () => { c.broken++; },
    onRadFlash: () => { c.radFlash++; },
    onDeath: () => { c.death++; },
  });
  return { r, c };
}
function flash(r: RadiationSystem, flying: boolean) {
  r.update(0, { flying, piercing: false });
  r.update(0, { flying, piercing: true });
}
describe("radiation", () => {
  it("shield absorbs 20", () => {
    const { r, c } = mk();
    r.setShield(20, 1); r.setRadBudget(20);
    for (let i = 0; i < 20; i++) flash(r, true);
    expect(c.broken).toBe(1); expect(c.radFlash).toBe(0); expect(c.death).toBe(0); expect(r.shieldHP).toBe(0);
  });
  it("rad fills after break, death at 20th", () => {
    const { r, c } = mk();
    r.setShield(20, 1); r.setRadBudget(20);
    for (let i = 0; i < 20; i++) flash(r, true);
    for (let i = 0; i < 20; i++) flash(r, true);
    expect(c.death).toBe(1); expect(c.radFlash).toBe(20);
  });
  it("on foot death at 20", () => {
    const { r, c } = mk();
    r.setShield(20, 1); r.setRadBudget(20);
    for (let i = 0; i < 20; i++) flash(r, false);
    expect(c.death).toBe(1); expect(c.radFlash).toBe(20);
  });
  it("rising edge only", () => {
    const { r, c } = mk();
    r.setShield(100, 1); r.setRadBudget(20);
    r.update(0, { flying: true, piercing: true });
    r.update(0, { flying: true, piercing: true });
    r.update(0, { flying: true, piercing: true });
    expect(c.shieldHit).toBe(1);
    r.update(0, { flying: true, piercing: false });
    r.update(0, { flying: true, piercing: true });
    expect(c.shieldHit).toBe(2);
  });
  it("reset + budget 10", () => {
    const { r } = mk();
    r.setShield(20, 1); r.setRadBudget(10);
    for (let i = 0; i < 20; i++) flash(r, true);
    r.reset();
    expect(r.shieldHP).toBe(20); expect(r.rad01).toBe(0);
    for (let i = 0; i < 10; i++) flash(r, false);
    expect(r.rad01).toBeGreaterThanOrEqual(1);
  });
});
