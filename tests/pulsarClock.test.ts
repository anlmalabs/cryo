import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { PULSAR_SPIN_RATE, pulsarClock, PulsarClock } from "../src/render/pulsarClock.js";

describe("pulsarClock beam-2 regression", () => {
  it("phase advances with time", () => {
    pulsarClock.update(10, new THREE.Vector3(0, 0.2, 1));
    expect(pulsarClock.phase).toBeCloseTo(10 * PULSAR_SPIN_RATE);
  });

  it("fires exactly 2 piercing episodes (one per beam) over one half-period pair", () => {
    const pc = new PulsarClock();
    const dt = 1 / 240;
    const total = 14.0;
    let prev = false;
    const edges: number[] = [];
    const dirs: THREE.Vector3[] = [];
    for (let t = 0; t <= total + 1e-9; t += dt) {
      pc.update(t);
      const cur = pc.isPiercing;
      if (cur && !prev) {
        edges.push(t);
        dirs.push(pc.beamDir.clone());
      }
      prev = cur;
    }
    expect(edges.length).toBe(2);
    expect(edges[1] - edges[0]).toBeCloseTo(Math.PI / PULSAR_SPIN_RATE, 0);
    expect(edges[1] - edges[0]).toBeGreaterThan(6.6);
    expect(edges[1] - edges[0]).toBeLessThan(7.7);
    // beamDir flips sign between the two episodes
    const dot = dirs[0].dot(dirs[1]);
    expect(dot).toBeLessThan(0);
  });

  it("midpoint (phase ~ pi/2) is NOT piercing", () => {
    const pc = new PulsarClock();
    const t = (Math.PI / 2) / PULSAR_SPIN_RATE;
    pc.update(t);
    expect(pc.isPiercing).toBe(false);
  });

  it("flash envelopes in [0,1]", () => {
    for (let t = 0; t < 20; t += 0.5) pulsarClock.update(t, new THREE.Vector3(0, 0.2, 1));
    expect(pulsarClock.flash1).toBeGreaterThanOrEqual(0);
    expect(pulsarClock.flash1).toBeLessThanOrEqual(1);
    expect(pulsarClock.flash2).toBeGreaterThanOrEqual(0);
    expect(pulsarClock.flash2).toBeLessThanOrEqual(1);
  });

  it("uniforms updated", () => {
    pulsarClock.update(5, new THREE.Vector3(1, 0, 0));
    expect(pulsarClock.uniforms.uPulsarPhase.value).toBeCloseTo(5 * PULSAR_SPIN_RATE);
    expect(pulsarClock.uniforms.uFlash1.value).toBe(pulsarClock.flash1);
    expect(pulsarClock.uniforms.uFlash2.value).toBe(pulsarClock.flash2);
  });

  it("flash sync: beam1 at t=0, beam2 at half-sweep", () => {
    const pc = new PulsarClock();
    pc.update(0);
    expect(pc.flash1).toBeGreaterThan(0.9);
    expect(pc.flash2).toBeLessThan(0.01);
    expect(pc.isPiercing).toBe(true);
    const pc2 = new PulsarClock();
    const t2 = Math.PI / PULSAR_SPIN_RATE;
    pc2.update(t2);
    expect(pc2.flash2).toBeGreaterThan(0.9);
    expect(pc2.flash1).toBeLessThan(0.01);
    expect(pc2.isPiercing).toBe(true);
  });

  it("beamDir is unit", () => {
    pulsarClock.update(2, new THREE.Vector3(0.3, 0.4, 0.5).normalize());
    const b = pulsarClock.beamDir;
    expect(Math.hypot(b.x, b.y, b.z)).toBeCloseTo(1);
  });
});
