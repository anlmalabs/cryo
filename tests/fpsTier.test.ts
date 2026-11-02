import { describe, it, expect } from "vitest";
import { fpsTierSuffix } from "../src/ui/fpsTier.js";

describe("fpsTierSuffix", () => {
 it("suffixes", () => {
  expect(fpsTierSuffix("bad")).toBe(" bad");
  expect(fpsTierSuffix("warn")).toBe(" warn");
  expect(fpsTierSuffix("good")).toBe("");
 });
});
