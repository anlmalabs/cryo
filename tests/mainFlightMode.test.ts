import { describe, it, expect } from "vitest";
import { buildFlightMode } from "../src/mainFlightMode.js";
import type { FlightState } from "../src/mainContracts.js";

function makeController() {
 const c: any = {};
 c.position = { x: 1, y: 2, z: 3, copy: (o: any) => { c.position.x = o.x; c.position.y = o.y; c.position.z = o.z; }, set: () => {} };
 c.velocity = { x: 0, y: 0, z: 0, copy: (o: any) => { c.velocity.x = o.x; c.velocity.y = o.y; c.velocity.z = o.z; }, set: () => {} };
 c.prevVelocity = { x: 0, y: 0, z: 0, copy: (o: any) => { c.prevVelocity.x = o.x; c.prevVelocity.y = o.y; c.prevVelocity.z = o.z; } };
 c.acceleration = { x: 0, y: 0, z: 0, set: () => {} };
 c.facing = 1.2;
 c.speed = 5; c.speed01 = 0.5; c.speedRaw = 5;
 c.lean = 0.3; c.carve = 0.1; c.streak01 = 0.2;
 c.groundY = 2;
 c.groundNormal = { x: 0, y: 1, z: 0, copy: () => {} };
 c.surf = 0.4; c.surfActive = true;
 c.crashing = true; c.crashLanded = true; c.crashDown = true; c._crashT = 3;
 c.terrainSlam = { a: 1 };
 c.pathY = 1; c.lift01 = 0.5; c.impactSpin = 0.1;
 c.stepping = false; c.gaitPhase = 0.7;
 c.footfall = true; c.footIndex = 1;
 c.footPos = { x: 0, y: 0, z: 0, copy: () => {} };
 c.footImpact = 0.9;
 c._prevSpeed = 1; c._drive = 2; c._boost = 3; c._climb = 4; c._climbWant = 5; c._vertEase = 6;
 c.climb = 7; c.climbRate = 8; c._cruiseGround = 9; c.steer = 10; c.steerRate = 11;
 c.controlScramble = 12; c._scrambleMax = 13; c._scrambleT = 14;
 c.fireHeld = 1; c.driveHeld = 2; c.boostHeld = 3;
 c._prevTargetY = 15; c._slam = { closing: 1 };
 c.cast = 2; c.castAimX = 3; c.castAimY = 4; c.castAimZ = 5;
 c.setVisible = () => {};
 return c;
}

function makeSpeeder() {
 const s: any = { grounded: false, setVisible: () => {} };
 return s;
}
function makeTerrain() {
 return { heightfield: { clampToPlayArea: () => {} }, heightAt: () => 0 };
}
function makeFigure() { return { setVisible: () => {} }; }

describe("buildFlightMode", () => {
 it("toggleMode no-ops without speeder", () => {
  const state: FlightState = { flying: true };
  const ctx: any = { speeder: null, shipController: null, character: makeController(), terrain: makeTerrain(), figure: makeFigure(), state };
  const { toggleMode } = buildFlightMode(ctx);
  toggleMode();
  expect(state.flying).toBe(true);
 });

 it("exits flight mode sets state.flying false", () => {
  const state: FlightState = { flying: true };
  const ship = makeController();
  const character = makeController();
  const speeder = makeSpeeder();
  const figure = makeFigure();
  const terrain = makeTerrain();
  const ctx: any = { speeder, shipController: ship, character, terrain, figure, state };
  const { toggleMode } = buildFlightMode(ctx);
  toggleMode();
  expect(state.flying).toBe(false);
 });

 it("enters flight mode sets state.flying true", () => {
  const state: FlightState = { flying: false };
  const ship = makeController();
  const character = makeController();
  const speeder = makeSpeeder();
  const figure = makeFigure();
  const terrain = makeTerrain();
  const ctx: any = { speeder, shipController: ship, character, terrain, figure, state };
  const { toggleMode } = buildFlightMode(ctx);
  toggleMode();
  expect(state.flying).toBe(true);
 });

 it("round-trip restores toggling", () => {
  const state: FlightState = { flying: false };
  const ship = makeController();
  const character = makeController();
  const speeder = makeSpeeder();
  const figure = makeFigure();
  const terrain = makeTerrain();
  const ctx: any = { speeder, shipController: ship, character, terrain, figure, state };
  const { toggleMode } = buildFlightMode(ctx);
  toggleMode();
  expect(state.flying).toBe(true);
  toggleMode();
  expect(state.flying).toBe(false);
 });
});
