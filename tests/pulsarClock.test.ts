import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { PULSAR_SPIN_RATE, pulsarClock } from "../src/render/pulsarClock.js";

describe("pulsarClock", () => {
 it("phase advances with time", () => {
  pulsarClock.update(10, new THREE.Vector3(0, 0.2, 1));
  expect(pulsarClock.phase).toBeCloseTo(10 * PULSAR_SPIN_RATE);
 });
 it("intensity in [0,1]", () => {
  for (let t = 0; t < 20; t += 0.5) pulsarClock.update(t, new THREE.Vector3(0, 0.2, 1));
  expect(pulsarClock.pulsarIntensity).toBeGreaterThanOrEqual(0);
  expect(pulsarClock.pulsarIntensity).toBeLessThanOrEqual(1);
 });
 it("uniforms updated", () => {
  pulsarClock.update(5, new THREE.Vector3(1, 0, 0));
  expect(pulsarClock.uniforms.uPulsarPhase.value).toBeCloseTo(5 * PULSAR_SPIN_RATE);
  expect(pulsarClock.uniforms.uPulsarIntensity.value).toBe(pulsarClock.pulsarIntensity);
 });
 it("beamDir is unit", () => {
  pulsarClock.update(2, new THREE.Vector3(0.3, 0.4, 0.5).normalize());
  const b = pulsarClock.beamDir;
  expect(Math.hypot(b.x, b.y, b.z)).toBeCloseTo(1);
 });
});
