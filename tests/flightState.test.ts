import { describe, it, expect } from "vitest";
import { createFlightState } from "../src/mainContracts.js";
import type { IntroFly } from "../src/mainContracts.js";

describe("FlightState", () => {
  it("createFlightState(true) yields expected initial shape", () => {
    expect(createFlightState(true)).toEqual({
      flying: true,
      storyMode: false,
      introHold: 0,
      introFly: null,
    });
  });

  it("mutating state.flying is visible via shared reference", () => {
    const s = createFlightState(false);
    s.flying = true;
    expect(s.flying).toBe(true);
  });

  it("introFly can be set to an IntroFly object and read back", () => {
    const s = createFlightState(false);
    const fly: IntroFly = { toX: 1, toZ: 2, heading: 3 };
    s.introFly = fly;
    expect(s.introFly).toEqual(fly);
  });
});
