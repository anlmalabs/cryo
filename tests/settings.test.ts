import { describe, it, expect } from "vitest";
import { S, onChange, set, applyPreset } from "../src/core/settings.js";

describe("settings", () => {
 it("set updates value", () => {
  const before = S.freezeTime;
  set("freezeTime", !before);
  expect(S.freezeTime).toBe(!before);
  set("freezeTime", before);
 });
 it("onChange fires", () => {
  let fired = 0;
  const unsub = onChange("freezeTime", (v, k) => { fired++; expect(k).toBe("freezeTime"); });
  set("freezeTime", !S.freezeTime);
  set("freezeTime", S.freezeTime); // no-op since equal? set no-ops if equal
  // toggle twice to ensure fire on change
  const cur = S.freezeTime;
  set("freezeTime", !cur);
  expect(fired).toBeGreaterThanOrEqual(1);
  unsub();
  set("freezeTime", cur);
 });
 it("applyPreset runs", () => {
  const prev = S.preset;
  applyPreset("balanced");
  expect(S.preset).toBe("balanced");
  applyPreset(prev as any);
 });
});
