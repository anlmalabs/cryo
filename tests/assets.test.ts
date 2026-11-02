import { describe, it, expect } from "vitest";
import { assetCandidates } from "../src/core/assets.js";

describe("assets", () => {
 it("no base -> single candidate", () => {
  const c = assetCandidates("audio/x.mp3");
  expect(c).toEqual(["audio/x.mp3"]);
 });
 it("strips leading slash", () => {
  const c = assetCandidates("/audio/x.mp3");
  expect(c[0]).toBe("audio/x.mp3");
 });
});
