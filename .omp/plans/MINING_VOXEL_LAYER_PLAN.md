# Plan: Layered mining — voxel bedrock beneath the snow sim

## Context

The user wants mining combined with the existing snow simulation: a voxel bedrock layer beneath the procedural heightfield snow surface, with area excavation that persists across sessions. The project is a raw-WebGL2 rasterizer (no Three materials/lights) with identity-world-matrix meshes and a hand-built LH camera; the terrain is a clipmap heightfield plus a ping-ponged deformation buffer. The plan adds a new `src/mining/` subsystem that feeds meshes into the existing pass runner, reuses the existing height-query contract (`Terrain.heightAt`), and stores modified chunks in IndexedDB. No third-party voxel engine is adopted (DVE's Three renderer is "in dev" and would violate the raw-shader invariant).

End state: a player can excavate persistent pits/cavities in the snow; the snow surface (heightfield + deformation) remains on top; the speeder/character ground on the excavated floor where a pit exists; meshes render in the beauty/cascade/prepass passes like any other opaque mesh.

## Approach

Ordered. Steps 1–4 are independent of 5–6; 7 depends on 1–6.

### 1. Voxel grid + persistence (`src/mining/voxelGrid.ts`)
- Chunked grid: chunk size 16³ voxels, voxel size 0.5 m (matches heightfield texel). Voxel byte = material id: 0 empty, 1 snow, 2 ice, 3 rock.
- Initial fill: for each chunk intersecting the world, solid voxels from `floor(heightfield.heightAt(x,z) * 2)` down to `baseDepth` (4 m below surface, i.e. 8 voxels), material 1 (snow) above a hard floor at baseDepth (material 3 rock). Surface voxel column stops at the heightfield surface.
- Coordinate helpers: `worldToVoxel(x,y,z)`, `voxelToChunk`, `chunkKey(cx,cy,cz)`.
- `getVoxel(ix,iy,iz)`, `setVoxel(ix,iy,iz,mat)`; setting marks the owning chunk dirty.
- Dirty tracking: `Set<string>` of dirty chunk keys; `flushDirty()` returns changed chunk coords.
- Persistence: IndexedDB database `cryo-mining`, store `chunks`, key = chunk key string, value = `{ key, bytes: Uint8Array(4096), version }`. `saveDirty()` writes dirty chunks (transaction). `loadAll()` reads all on boot. If IndexedDB unavailable (private mode / SSR), fall back to in-memory with a console warning; no crash.
- Memoized excavation floor: `floorAt(x,z)` scans the voxel column (descending from surface) for the topmost solid voxel below an empty voxel; returns its top Y in metres, or `null` if no cavity. Memoized per (ix,iz) with a version counter incremented on any `setVoxel`.

### 2. Greedy mesher (`src/mining/greedyMesher.ts`)
- Input: chunk voxel array + chunk origin (world metres).
- Output: interleaved `Float32Array` positions (x,y,z), `Float32Array` normals, `Uint8Array` colors (RGB per vertex, palette by material), and index `Uint32Array`. Greedy merge along each axis for coplanar same-material faces.
- Pure function (no allocation of intermediate arrays beyond output; pre-size staging). Unit-testable: a single solid voxel yields 6 faces × 2 triangles; two adjacent same-material voxels merge to 1 quad face.

### 3. Excavation orchestrator (`src/mining/excavation.ts`)
- Owns `VoxelGrid`, a `Map<string, THREE.Mesh>` of chunk meshes, and a worker for meshing.
- Constructor: `new Excavation(gfx, terrain)`; registers nothing until `init()` (async) loads persisted chunks, fills initial world in a radius around origin (chunks within 64 m), meshes them, adds meshes to gfx OPAQUE layer at renderOrder 12.
- `excavate(x, z, radius, depth)`: for every voxel within a cylinder of given radius around (x,z) from the surface down `depth` metres, set to 0 (empty); mark chunks dirty; queue mesh rebuild. Also call `terrain.deform.brush(x,z, radius, depth*0.6, 0, 0, 0)` for immediate snow-surface feedback.
- `update(camPos)`: ensure chunks within 96 m are loaded/meshed; unload chunks beyond 128 m (remove mesh, keep persisted); process worker results, swap BufferGeometry.
- `floorAt(x,z)` delegates to grid.
- Expose on `window.SNOWFLOW.excavate`.

### 4. Terrain integration (`src/terrain/terrain.ts`)
- `Terrain.heightAt(x,z)` returns `Math.min(snowHeight, excavation?.floorAt(x,z) ?? Infinity)` when excavation is wired; keeps all existing callers (character, speeder, camera, spells) working unchanged. Wire via optional `excavation` property set in mainInit.

### 5. Worker (`src/mining/meshWorker.ts` + `?worker` import)
- Receives `{ chunkKey, voxels: Uint8Array, origin: [x,y,z] }`, runs greedyMesher, posts back transferable ArrayBuffers. Main thread builds `THREE.BufferGeometry`.

### 6. Material (`src/shaders/voxel.vertex.glsl`, `voxel.fragment.glsl`)
- RawShaderMaterial, identity world matrix: vertex shader applies `viewProjection * vec4(position,1)`. Fragment: vertex color × (sun diffuse via `dot(N,sunDir)*0.5+0.5` + ambient 0.25), fog (linear, 200 m), sRGB-free (composite pass owns tonemap). Uniforms: `viewProjection`, `sunDir`, `cameraPos`, `fogDensity`.

### 7. Input + boot wiring
- `src/mainInit.ts`: construct `Excavation`, `await excavation.init()` after terrain warm-up; set `terrain.excavation = excavation`; set `rig.groundAt` already points at terrain.heightAt (now excavation-aware).
- `src/mainLoop.ts`: call `excavation.update(rig.camera.position)` after `terrain.update`; add `excavation.triangles` to stats sum.
- Input: key 'X' excavates at character position (radius 2 m, depth 3 m) while held, throttled to one call per 0.25 s. Add `S.miningRadius` (default 2) and `S.miningDepth` (default 3) to settings schema.

### 8. Persistence safety
- Save dirty chunks at most once per 2 s (debounced) and on `beforeunload`. Load on boot with a loading phase "loading excavations".

## Critical files & anchors
- `src/terrain/terrain.ts` — `heightAt()` (line ~598) integration point; `excavation` optional field.
- `src/terrain/deformation.ts` — `brush()` reused for snow-surface feedback.
- `src/core/gfx.ts` — `addMesh(mesh, layer, renderOrder)` for chunk meshes; layer OPAQUE.
- `src/mainInit.ts` — boot ordering after `terrain.warmUp()`.
- `src/mainLoop.ts` — `terrain.update(...)` call site (~line 277) and stats sum (~line 330).
- `src/core/settings.ts` — schema additions.

## Verification
- Unit tests: `tests/voxelGrid.test.ts` (set/get roundtrip, chunk dirty flag, floorAt on a carved column), `tests/greedyMesher.test.ts` (1 voxel → 12 triangles; 2 adjacent same-material voxels → 10 triangles).
- Smoke: `npm run typecheck && npm run test && npm run build`. Then `npm run dev`, open, hold X near character, observe pit mesh + snow crater; reload page, pit persists.
- Manual: `window.SNOWFLOW.excavate(0,0,3,4)` from console creates a pit at origin; speeder ground track drops into it.

## Assumptions & contingencies
- If IndexedDB is unavailable, in-memory only (no persistence); logged once.
- If worker creation fails (CSP), fall back to synchronous meshing on main thread with a frame-budget guard (max 2 chunks/frame).
- Excavation floor overrides snow height only where a cavity exists; elsewhere `floorAt` returns null and `Terrain.heightAt` unchanged.
- Voxel world is bounded to ±256 m (chunks within active radius); outside, no excavation possible (brush no-ops).
