import { describe, it, expect } from "vitest";
import { createFlightState, CLEAR_COLOR, DEATH_CAM_RATE, DEATH_CAM_DIST, DEATH_CAM_DIST_PILOT, DEATH_CAM_PITCH, DEATH_CAM_PITCH_PILOT } from "../src/mainContracts.js";

describe("mainContracts", () => {
 it("createFlightState", () => {
  expect(createFlightState(true)).toEqual({ flying: true });
  expect(createFlightState(false)).toEqual({ flying: false });
 });
 it("constants sane", () => {
  expect(CLEAR_COLOR.length).toBe(4);
  expect(DEATH_CAM_RATE).toBeGreaterThan(0);
  expect(DEATH_CAM_DIST).toBeGreaterThan(DEATH_CAM_DIST_PILOT);
  expect(DEATH_CAM_PITCH).toBeGreaterThan(DEATH_CAM_PITCH_PILOT);
 });
});
