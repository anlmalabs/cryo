import { describe, it, expect } from "vitest";
import { registerShaders, getShader, composeShader } from "../src/shaders/registry.js";

describe("shaders registry", () => {
 it("registers idempotently", () => {
  registerShaders();
  registerShaders();
  expect(() => getShader("skyVertexShader")).not.toThrow();
 });
 it("unknown shader throws", () => {
  expect(() => getShader("nopeVertexShader")).toThrow();
 });
 it("compose resolves includes", () => {
  const out = composeShader("#include<snowNoise>\nvoid main(){}");
  expect(out).toContain("void main(){}");
  expect(out.length).toBeGreaterThan(20);
 });
 it("compose throws on unknown include", () => {
  expect(() => composeShader("#include<nope>\nvoid main(){}")).toThrow();
 });
});
