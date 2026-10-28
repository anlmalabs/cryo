import { describe, it, expect } from "vitest";
import {
 mul,
 xformPoint,
 setFrameFromDir,
 mulMat4,
 invertMat4,
 lookAtLH,
 perspectiveFovLH,
 orthoOffCenterLH,
 invertRigid,
 setFrame,
} from "../src/core/mat4.js";

const ID = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe("mat4 mul (rigid, offset)", () => {
 it("identity * identity = identity", () => {
  const a = new Float32Array(32), b = new Float32Array(32), out = new Float32Array(32);
  for (let i = 0; i < 16; i++) { a[i] = ID[i]; b[i] = ID[i]; }
  mul(out, 0, a, 0, b, 0);
  expect(Array.from(out.slice(0, 16))).toEqual(Array.from(ID));
 });
 it("translation composes: T(1,2,3) * T(4,5,6) = T(5,7,9)", () => {
  const a = new Float32Array(16), b = new Float32Array(16), out = new Float32Array(16);
  for (let i = 0; i < 16; i++) { a[i] = ID[i]; b[i] = ID[i]; }
  a[12] = 1; a[13] = 2; a[14] = 3;
  b[12] = 4; b[13] = 5; b[14] = 6;
  mul(out, 0, a, 0, b, 0);
  expect(out[12]).toBeCloseTo(5);
  expect(out[13]).toBeCloseTo(7);
  expect(out[14]).toBeCloseTo(9);
 });
 it("offsets select the right matrix in a packed buffer", () => {
  const buf = new Float32Array(32);
  for (let i = 0; i < 16; i++) buf[i] = ID[i];
  for (let i = 0; i < 16; i++) buf[16 + i] = ID[i];
  buf[16 + 12] = 10;
  const out = new Float32Array(32);
  mul(out, 16, buf, 0, buf, 16);
  expect(out[16 + 12]).toBeCloseTo(10);
 });
});

describe("mat4 xformPoint", () => {
 it("identity leaves point unchanged", () => {
  const m = ID, dst = new Float32Array(3);
  xformPoint(m, 0, 7, -3, 2, dst, 0);
  expect(dst[0]).toBeCloseTo(7);
  expect(dst[1]).toBeCloseTo(-3);
  expect(dst[2]).toBeCloseTo(2);
 });
 it("translation applies", () => {
  const m = new Float32Array([...ID]);
  m[12] = 5; m[13] = 6; m[14] = 7;
  const dst = new Float32Array(3);
  xformPoint(m, 0, 1, 2, 3, dst, 0);
  expect(dst[0]).toBeCloseTo(6);
  expect(dst[1]).toBeCloseTo(8);
  expect(dst[2]).toBeCloseTo(10);
 });
 it("writes at offset", () => {
  const m = new Float32Array([...ID]);
  const dst = new Float32Array(6);
  xformPoint(m, 0, 1, 2, 3, dst, 3);
  expect(dst[3]).toBeCloseTo(1);
  expect(dst[4]).toBeCloseTo(2);
  expect(dst[5]).toBeCloseTo(3);
 });
});

describe("mat4 setFrameFromDir", () => {
 it("dir becomes local +Y axis (column 1)", () => {
  const out = new Float32Array(16);
  setFrameFromDir(out, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1);
  expect(out[4]).toBeCloseTo(0);
  expect(out[5]).toBeCloseTo(1);
  expect(out[6]).toBeCloseTo(0);
 });
 it("parallel ref falls back without NaN", () => {
  const out = new Float32Array(16);
  setFrameFromDir(out, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0);
  for (let i = 0; i < 16; i++) expect(Number.isFinite(out[i])).toBe(true);
 });
 it("frame is orthonormal", () => {
  const out = new Float32Array(16);
  setFrameFromDir(out, 0, 1, 2, 3, 1, 2, 3, 0, 1, 0);
  const col = (off: number) => [out[off], out[off + 1], out[off + 2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a: number[]) => Math.hypot(...a);
  const X = col(0), Y = col(4), Z = col(8);
  expect(len(X)).toBeCloseTo(1); expect(len(Y)).toBeCloseTo(1); expect(len(Z)).toBeCloseTo(1);
  expect(dot(X, Y)).toBeCloseTo(0); expect(dot(X, Z)).toBeCloseTo(0); expect(dot(Y, Z)).toBeCloseTo(0);
 });
 it("origin is written to translation column", () => {
  const out = new Float32Array(16);
  setFrameFromDir(out, 0, 5, 6, 7, 0, 1, 0, 0, 0, 1);
  expect(out[12]).toBeCloseTo(5);
  expect(out[13]).toBeCloseTo(6);
  expect(out[14]).toBeCloseTo(7);
 });
});

describe("mat4 mulMat4", () => {
 it("identity * identity = identity", () => {
  const a = ID, b = ID, out = new Float32Array(16);
  mulMat4(out, a, b);
  expect(Array.from(out)).toEqual(Array.from(ID));
 });
 it("is column-convention", () => {
  const a = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1]);
  const b = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
  const out = new Float32Array(16);
  mulMat4(out, a, b);
  const vx = out[0] * 1 + out[4] * 1 + out[8] * 1 + out[12] * 1;
  const vy = out[1] * 1 + out[5] * 1 + out[9] * 1 + out[13] * 1;
  const vz = out[2] * 1 + out[6] * 1 + out[10] * 1 + out[14] * 1;
  expect(vx).toBeCloseTo(2 * (1 + 1));
  expect(vy).toBeCloseTo(3 * (1 + 2));
  expect(vz).toBeCloseTo(4 * (1 + 3));
 });
 it("aliasing out===a is safe", () => {
  const a = new Float32Array([...ID]), b = ID;
  mulMat4(a, a, b);
  expect(Array.from(a)).toEqual(Array.from(ID));
 });
});

describe("mat4 invertMat4", () => {
 it("round-trips with mulMat4", () => {
  const m = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 1, 2, 3, 1]);
  const inv = new Float32Array(16);
  invertMat4(inv, m);
  const prod = new Float32Array(16);
  mulMat4(prod, m, inv);
  for (let i = 0; i < 16; i++) {
   expect(prod[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 5);
  }
 });
 it("singular matrix leaves out untouched", () => {
  const m = new Float32Array(16);
  const out = new Float32Array(16).fill(7);
  invertMat4(out, m);
  expect(out[0]).toBe(7);
 });
});

describe("mat4 lookAtLH", () => {
 it("camera at origin looking +Z gives identity rotation", () => {
  const out = new Float32Array(16);
  lookAtLH(out, 0, 0, 0, 0, 0, 1, 0, 1, 0);
  expect(out[2]).toBeCloseTo(0);
  expect(out[6]).toBeCloseTo(0);
  expect(out[10]).toBeCloseTo(1);
 });
 it("translation is negated rotated eye", () => {
  const out = new Float32Array(16);
  lookAtLH(out, 0, 0, -5, 0, 0, 0, 0, 1, 0);
  expect(out[14]).toBeCloseTo(5);
 });
});

describe("mat4 perspectiveFovLH", () => {
 it("clip.w = +viewZ invariant", () => {
  const out = new Float32Array(16);
  perspectiveFovLH(out, Math.PI / 3, 16 / 9, 0.1, 4200);
  expect(out[11]).toBe(1);
  expect(out[15]).toBe(0);
 });
 it("focal length = cot(fov/2)", () => {
  const fov = Math.PI / 4;
  const out = new Float32Array(16);
  perspectiveFovLH(out, fov, 1, 0.1, 100);
  expect(out[0]).toBeCloseTo(1 / Math.tan(fov / 2));
 });
 it("NDC z at near maps to -1", () => {
  const out = new Float32Array(16);
  const near = 0.1, far = 100;
  perspectiveFovLH(out, Math.PI / 3, 1, near, far);
  const cz = out[10] * near + out[14];
  const cw = out[11] * near + out[15];
  expect(cz / cw).toBeCloseTo(-1, 5);
 });
});

describe("mat4 orthoOffCenterLH", () => {
 it("maps clip z near->-1, far->1", () => {
  const out = new Float32Array(16);
  orthoOffCenterLH(out, -1, 1, -1, 1, 0.1, 100);
  const zn = out[10] * 0.1 + out[14];
  const wn = out[11] * 0.1 + out[15];
  const zf = out[10] * 100 + out[14];
  const wf = out[11] * 100 + out[15];
  expect(zn / wn).toBeCloseTo(-1, 5);
  expect(zf / wf).toBeCloseTo(1, 5);
 });
});

describe("mat4 invertRigid", () => {
 it("inverts identity", () => {
  const m = new Float32Array(ID);
  const out = new Float32Array(16);
  invertRigid(out, 0, m, 0);
  for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(ID[i]);
 });
 it("transposes rotation and negates rotated translation", () => {
  const m = new Float32Array(16);
  setFrame(m, 0, 3, 4, 5, 0, 0, 1, 0, 1, 0, 1, 0, 0);
  const out = new Float32Array(16);
  invertRigid(out, 0, m, 0);
  expect(out[0]).toBeCloseTo(0); expect(out[1]).toBeCloseTo(0); expect(out[2]).toBeCloseTo(1);
  expect(out[4]).toBeCloseTo(0); expect(out[5]).toBeCloseTo(1); expect(out[6]).toBeCloseTo(0);
  expect(out[8]).toBeCloseTo(1); expect(out[9]).toBeCloseTo(0); expect(out[10]).toBeCloseTo(0);
  expect(out[12]).toBeCloseTo(-5); expect(out[13]).toBeCloseTo(-4); expect(out[14]).toBeCloseTo(-3);
 });
 it("aliasing out with m is safe", () => {
  const m = new Float32Array(16);
  setFrame(m, 0, 1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1);
  invertRigid(m, 0, m, 0);
  expect(m[0]).toBeCloseTo(1); expect(m[5]).toBeCloseTo(1); expect(m[10]).toBeCloseTo(1);
  expect(m[12]).toBeCloseTo(-1); expect(m[13]).toBeCloseTo(-2); expect(m[14]).toBeCloseTo(-3);
 });
 it("works with offsets and packed buffers", () => {
  const buf = new Float32Array(32);
  setFrame(buf, 16, 7, 8, 9, 1, 0, 0, 0, 1, 0, 0, 0, 1);
  const out = new Float32Array(32);
  invertRigid(out, 0, buf, 16);
  expect(out[12]).toBeCloseTo(-7); expect(out[13]).toBeCloseTo(-8); expect(out[14]).toBeCloseTo(-9);
 });
});

describe("mat4 setFrame", () => {
 it("writes axes and origin column-major", () => {
  const out = new Float32Array(16);
  setFrame(out, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
  expect(out[0]).toBeCloseTo(4); expect(out[1]).toBeCloseTo(5); expect(out[2]).toBeCloseTo(6);
  expect(out[4]).toBeCloseTo(7); expect(out[5]).toBeCloseTo(8); expect(out[6]).toBeCloseTo(9);
  expect(out[8]).toBeCloseTo(10); expect(out[9]).toBeCloseTo(11); expect(out[10]).toBeCloseTo(12);
  expect(out[12]).toBeCloseTo(1); expect(out[13]).toBeCloseTo(2); expect(out[14]).toBeCloseTo(3);
  expect(out[3]).toBeCloseTo(0); expect(out[7]).toBeCloseTo(0); expect(out[11]).toBeCloseTo(0); expect(out[15]).toBeCloseTo(1);
 });
 it("writes at offset", () => {
  const out = new Float32Array(32);
  setFrame(out, 16, 5, 6, 7, 1, 0, 0, 0, 1, 0, 0, 0, 1);
  for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(0);
  expect(out[16]).toBeCloseTo(1); expect(out[28]).toBeCloseTo(5);
 });
});