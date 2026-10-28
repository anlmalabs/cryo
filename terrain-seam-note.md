# Terrain chunk border seams — TODO

## Problem
Clipmap rings (CDLOD-style) at different LOD levels produce visible elevation
steps at ring boundaries when the morph factor between adjacent rings is
insufficient or the height sampling doesn't match exactly across the overlap
band. Result: horizontal "terraces"/ridges at fixed radii from the camera.

## Where to look
- `src/terrain/clipmapMesh.ts` — ring geometry, `HOLE_SHRINK`, morph overlap band
- `src/shaders/snow.vertex.glsl` (or terrain vertex) — morph factor computation, `spacing` lerp
- `src/terrain/heightfield.ts` — height sampling (`sampleHeightBicubic`)
- `port/specs/terrain.md` — CDLOD morph spec (`clamp((cheb - 0.70)/0.16, 0, 1)`)

## Goal
Make adjacent rings always agree on the same final height in the overlap band:
- morph factor must reach 1.0 before ring boundary exits overlap
- height sampling must use identical bicubic filter across rings
- no visible elevation delta at any ring transition

## Status
Not yet implemented. Needs investigation of the morph factor and height sampling
consistency. Tag `pulsar-jets-anchored` and commits up to `040fe6c` are stable.