import { describe, it, expect } from "vitest";
import { createFlightState } from "../src/mainContracts.js";

describe("FlightState", () => {
  it("createFlightState(true) yields expected initial shape", () => {
    expect(createFlightState(true)).toEqual({
      flying: true,
    });
  });

  it("mutating state.flying is visible via shared reference", () => {
    const s = createFlightState(false);
    s.flying = true;
    expect(s.flying).toBe(true);
  });
});
