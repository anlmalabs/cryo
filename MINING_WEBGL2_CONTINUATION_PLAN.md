# Continue mining flow on WebGL2 — close render-pass integration, budget the streaming

## Context

Latest commit `e49fa27` ("Fix mining/excavation integration: recursion + chunk streaming + settings") added the whole mining subsystem: CPU voxel grid (`src/mining/voxelGrid.ts`, 16³ chunks × 0.5 m, IndexedDB `cryo-mining`), CPU greedy mesher (`src/mining/greedyMesher.ts`), orchestrator (`src/mining/excavation.ts`), voxel shaders, settings sliders, KeyX digging in `mainLoop.ts`, and `Terrain.heightAt` min-with-cavity-floor.

**Verdict: viable on WebGL2 — continue.** Nothing in the design needs WebGPU-only features. The grid is CPU `Uint8Array`s, meshing is a CPU pure function, meshes are static world-space geometry through the existing pass runner (`gfx.addMesh(mesh, LAYER.OPAQUE, 12)`), and the token-camera `onBeforeRender` viewProjection binding already follows the sanctioned pattern (character.ts:18-22, jet.ts:77-81). The gaps found in the commit are integration and CPU-budget issues, all fixable on WebGL2:

1. **No depth-prepass registration** — `depthPass.casters` is an explicit list (depthPass.ts:109); voxel meshes aren't in it, so pit pixels read as sky depth (9000) in `scenePrepass` → TAA reprojection, SSR, DoF and light shafts integrate against the wrong surface around every pit.
2. **No shadow casters** — `shadows.registerCaster` (shadows.ts:286) never called for chunk meshes; the voxel fragment shader has no cascade lookup → voxels neither cast nor receive shadows; pits glow flat next to shadowed snow.
3. **Streaming hitches** — no frame budget. Crossing the 96 m load boundary ensures ~25×25×3 = 1875 chunk keys per frame and meshes ~225 new chunks in one frame; each chunk fill calls the bicubic `heightAt` 4096 times. Boot does 867 chunks (INITIAL_RADIUS 64) + full mesh synchronously in `init()`.
4. **`fillChunk` wastes 16×** — calls `heightAt` per voxel (4096) instead of per column (256); height only varies in x/z.
5. **Per-frame garbage (violates G2)** — `update()` rebuilds ~1875 chunk-key strings every frame and runs `key.split(",").map(Number)` per chunk per frame in two loops.
6. **Hardcoded Y band** — chunks created only for cy ∈ {-1,0,1} (world y −8…+23.5 m). If heightfield relief exceeds that, the voxel bed never reaches the surface on high ground.
7. **Lighting dead** — `sunDir` uniform stuck at (0,1,0); PALETTE authored sRGB treated as linear → pits mismatch the scene after AgX.
8. **Persistence flush missing** — no save on pagehide/visibilitychange; last ≤2 s of digging lost on tab close. (`beforeunload` flush was promised in `.omp/plans/MINING_VOXEL_LAYER_PLAN.md` §8 but not implemented.)

Camera binding, identity matrices, layer bits, RawShaderMaterial, settings schema, IndexedDB store shape: all already correct — do not touch.

## Approach

Ordered. Steps 1–2 are prerequisites for 3; 4–8 are independent of 1–3 and of each other. Existing tests must pass after each step.

### 1. Unregister support for streaming casters

- `src/render/depthPass.ts`: add `removeCaster(mesh: THREE.Mesh): void` — drop all `this.casters` entries whose `mesh === mesh`. Leave `materials` alone (shared program stays compiled).
- `src/render/depthPass.ts` `registerCaster`: only `this.materials.push(material)` when `!this.materials.includes(material)` — streaming registers the same shared material per chunk; without the guard, `warmUp()` compiles it N times.
- `src/render/shadows.ts`: add `unregisterCaster(mesh: THREE.Mesh): void` — splice matching entries from every `this._casters[cascade]` list. Apply the same `includes` guard to `this.materials.push(mat)` in `registerCaster` (shadows.ts:296-297).

### 2. Shared caster materials + registration in Excavation

All chunk meshes share one material per role (positions are baked world-space; uniforms identical):

- `src/mining/excavation.ts` `init()`: build once — `this.material = this.makeMaterial()` (existing method, now called once); `this.prepassMaterial`; `this._shadowMaterials = [this._makeDepthMaterial(0), this._makeDepthMaterial(1)]`. One `const vp = new THREE.Matrix4()` instance becomes the `viewProjection` uniform `.value` of BOTH the beauty and prepass materials, so one write per frame feeds both.
- `_makeDepthMaterial(cascade: number): THREE.RawShaderMaterial` — copy the shape of `terrain.ts:425 _makeDepthMaterial`: `vertexShader: getShader("voxelDepthVertexShader")`, `fragmentShader: getShader("terrainDepthPixelShader")`, uniforms `{ lightViewProjection: { value: new THREE.Matrix4() }, cameraPos: { value: new THREE.Vector3() } }`.
- New `src/shaders/voxelDepth.vertex.glsl` — inputs/uniforms of voxel.vertex.glsl but `uniform mat4 lightViewProjection; uniform vec3 cameraPos;` and `gl_Position = lightViewProjection * vec4(position, 1.0);`. Geometry is byte-identical to beauty (same vertex array) — the terrainDepth vertex comment (terrainDepth.vertex.glsl:2-6) explains why that matters.
- New `src/shaders/voxelPrepass.vertex.glsl` — `uniform mat4 viewProjection;` + `out float vViewZ; out float vMask;`; `vec4 clip = viewProjection * vec4(position,1.0); vViewZ = clip.w; vMask = 0.0;` (voxel materials are matte; g channel 0). Fragment is the existing shared `prepassPixelShader` (prepass.fragment.glsl), unchanged. Registry keys follow registry.ts convention (`<base>VertexShader` / `<base>PixelShader`) automatically.
- `rebuildChunk`: keep the mesh when one already exists — swap `mesh.geometry` in place and dispose the old geometry — instead of remove+recreate. Create the mesh (identity matrix, `matrixAutoUpdate=false`, `frustumCulled=false`, `gfx.addMesh(mesh, gfx.LAYER.OPAQUE, 12)`, existing onBeforeRender writing `vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)` guarded on `camera === gfx.threeCamera`) only when absent, and then register once: `gfx.depthPass` is not on Gfx — Excavation receives the `DepthPass` and `ShadowSystem` handles (extend the constructor, see step 8): `this.depthPass.registerCaster(mesh, this.prepassMaterial)` and `this.shadows.registerCaster(mesh, (c) => this._shadowMaterials[c], 2)` — 2 cascades: chunk meshes unload at 128 m and cascade 2 covers ~330 m (speeder.ts:515). `shadows.update` sets `lightViewProjection` per caster material each cascade (shadows.ts:501-504) — shared instances get re-set to the same value; harmless.
- Mesh removal paths (unload in `update()`): call `this.depthPass.removeCaster(mesh)` and `this.shadows.unregisterCaster(mesh)` before disposing geometry.
- Delete `makeMaterial()`'s per-chunk invocation; the method stays, called once.

### 3. Frame-budgeted streaming, no per-frame allocation (Excavation.update)

- New state: `_scanCX = Infinity`, `_scanCZ = Infinity`, `_queue: { cx,cy,cz }[]`, `_queued: Set<string>`, `_coords: Map<string, [number, number, number]>` (chunk key → parsed coords, filled when a mesh is created).
- `update(camPos)`: if `Math.floor(camPos.x / 8) !== _scanCX || Math.floor(camPos.z / 8) !== _scanCZ` → rescan: ensure-range scan at LOAD_RADIUS (unchanged constant) pushes missing chunks `{cx, cy, cz}` (Y band from step 5) onto `_queue` when not in `_queued`; then unload pass over `this._coords`: meshes beyond UNLOAD_RADIUS → unregister casters, `gfx.scene.remove`, dispose geometry, `meshes.delete`, `_coords.delete` (grid chunk data retained).
- Drain `_queue` up to `MESH_BUDGET = 4` entries per frame: `grid.ensureChunk(...)` then `rebuildChunk(...)`; delete key from `_queued`.
- `excavate()`: replace the synchronous `this.meshAllDirty()` with pushing `grid.flushDirty()` results onto `_queue` (dedup via `_queued`). A 2 m dig touches ≤12 chunks → lands within ~3 frames; a 10 m blast spreads over ~60 frames instead of hitching.
- Delete `meshAllDirty()`; `init()` replaces its call with a one-time synchronous full drain (`while (this._queue.length) drainOne()`) behind the loading label (step 8).
- Remove every per-frame `key.split(",").map(Number)` — the `_coords` map replaces parsing; queue entries carry coords.

### 4. `fillChunk` per-column height (src/mining/voxelGrid.ts:98-125)

Restructure to `for lz { for lx { const surf = heightQuery.heightAt(wx, wz); ... for ly {...} } }` — compute `surf`/`surfVoxel`/`baseVoxel` once per column, inner ly loop identical semantics (snow above rock floor, empty above surface). 16× fewer bicubic lookups; same material layout.

### 5. Data-driven Y band (Excavation)

In `init()` (runs after `terrain.warmUp()` in mainInit, so the heightfield bake has measured bounds): 
```
const hf = this.terrain.heightfield;
this._cyMin = Math.floor((hf.minHeight - BASE_DEPTH * VOXEL) / CHUNK_WORLD) - 1;
this._cyMax = Math.floor(hf.maxHeight / CHUNK_WORLD) + 1;
```
`ensureChunksAround` loops `cy` from `_cyMin` to `_cyMax` instead of hardcoded `-1..1`. If either bound is not finite (height readback failed, heightfield.ts `_readback`), fall back to the old `-1, 0, 1`. `floorAt`'s 64-voxel scan depth is unchanged (32 m ≫ BASE_DEPTH 4 m).

### 6. Sun wiring + palette linearization

- `mainInit.ts`: `new Excavation(gfx, terrain, depthPass, shadows, sky)` — sole callsite (grep `new Excavation` = 1). Constructor stores all five handles.
- `Excavation.update`: `this.material.uniforms.sunDir.value.copy(this.sky.sunDir)` (sky.ts:399 confirms `sky.sunDir` is the live Vector3).
- `src/mining/greedyMesher.ts` PALETTE: linearize once at module scope — each channel `Math.round(255 * Math.pow(v / 255, 2.2))` — so `vColor/255.0` in voxel.fragment.glsl feeds the linear pipeline that the AgX composite expects. Shader text unchanged. Fog constants in voxel.fragment.glsl stay as committed.

### 7. Persistence flush on page hide

In `init()`: `window.addEventListener("pagehide", () => { void this.grid.saveDirty(); })` and `document.addEventListener("visibilitychange", () => { if (document.hidden) void this.grid.saveDirty(); })`.

### 8. Boot ordering (src/mainInit.ts:174-178)

Before `await excavation.init()`: `await loading.phase("loading excavations", <next fraction>)` — pick the progress fraction consistent with the neighboring `loading.phase` calls (loading.phase only labels + yields to the compositor, loading.ts:31). Change INITIAL_RADIUS 64 → 48 (boot meshes ~445 chunks instead of 867; LOAD_RADIUS 96 streams the rest through the budget).

### Tests (permanent, pure logic, node-safe)

- `tests/voxelGrid.test.ts`: add a fill-layering test using a fake `HeightQuery` (constant height): voxels above `floor(h/VOXEL)` empty; at the surface band snow; at `baseVoxel` and below rock — pins the per-column rewrite's consumer-visible semantics.
- New `tests/greedyMesher.test.ts`: single solid voxel → 12 indices/3 quads... exactly: 6 faces → 12 triangles; two adjacent same-material voxels → 10 triangles. These were promised by `.omp/plans/MINING_VOXEL_LAYER_PLAN.md` §Verification and are missing.

## Critical files & anchors

- `src/mining/excavation.ts` — most changes: constructor signature, init, rebuildChunk in-place geometry, update budget loop, excavate queueing, `_coords`.
- `src/render/shadows.ts:286-298` — `registerCaster` guard + new `unregisterCaster`; per-cascade uniform loop at :501-504 (why shared materials are safe).
- `src/render/depthPass.ts:109-113` — `registerCaster` materials guard + new `removeCaster`; prepass contract comment :99-104 (jittered viewProjection, vViewZ/vMask).
- `src/mining/voxelGrid.ts:98-125` — `fillChunk` per-column rewrite.
- `src/shaders/voxelPrepass.vertex.glsl`, `src/shaders/voxelDepth.vertex.glsl` — new; reuse `prepassPixelShader` and `terrainDepthPixelShader` fragments unchanged.

## Verification

1. `npm run typecheck && npm run test && npm run build` — all green (CI parity).
2. `npm run dev`, hold KeyX beside the character: pit renders; wall faces facing away from the low sun are darker than snow (sunDir live, not (0,1,0)); the figure casts a shadow onto pit walls; pit walls shadow the snow rim (caster registration proof). TAA must not ghost along pit edges.
3. Depth prepass proof: toggle the debug view that shows the prepass (`S.debugView` modes — find the prepass/depth mode in `src/core/settings.ts` SCHEMA) and confirm the pit silhouette appears in it (before this change it would show sky-clear 9000).
4. Streaming budget: fly >96 m in one direction, then reverse; perfHud frame-time rows stay flat — no multi-hundred-ms hitch on the turn (pre-change code loads ~225 chunks in a single frame there).
5. `window.SNOWFLOW.excavate(0, 0, 3, 4)` in the console, then reload the page: pit persists via IndexedDB and still casts/receives shadows after reload (registration happens for loaded chunks too).
6. Console shows no per-frame garbage growth: devtools allocation sampling on the idle camera shows no string churn from chunk keys (step 3's `_coords`/queue).

## Assumptions & contingencies

- Heightfield relief is covered by the measured `minHeight`/`maxHeight` band (computed, not assumed; fallback to cy −1..1 if the readback failed).
- If `shadows.unregisterCaster` turns out to be needed during an active `shadows.update` iteration (it isn't — removal happens in `excavation.update`, which runs before the render section of the frame), splice-while-iterating would be the symptom; the ordering above avoids it.
- refillRate > 0 heals the visible snow surface over time while the voxel floor persists; `Terrain.heightAt`'s `min()` keeps grounding on the pit floor. Existing intended behavior — unchanged here, flag to the user if it reads wrong in practice.
- IndexedDB unavailable → existing `memOnly` path; no new handling.
