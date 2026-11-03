# Fix mining/excavation integration defects

## Context

Review of uncommitted mining/excavation integration found two infinite-recursion bugs and a missing streaming call. The feature hangs on first carve/floor query and never streams chunks beyond the initial 64 m radius.

## Approach

1. `src/mining/excavation.ts`: construct `VoxelGrid` with a height query bound to the base heightfield, not the excavation-aware `Terrain`, to break recursion in `fillChunk`/`floorAt`. Change `new VoxelGrid(terrain)` to `new VoxelGrid({ heightAt: (x, z) => terrain.heightfield.heightAt(x, z) })`.
2. `src/mining/excavation.ts` `excavate`: read surface from `this.terrain.heightfield.heightAt(x, z)` instead of `this.terrain.heightAt(x, z)` to avoid recursion and use the original surface.
3. `src/mainLoop.ts`: after `terrain.update(...)`, call `excavation.update(rig.camera.position)` to stream/unload chunks.
4. `src/core/settings.ts`: add SCHEMA entries for `miningRadius` and `miningDepth` (Mining or Deformation group), matching slider convention.

## Critical files & anchors

- `src/mining/excavation.ts:21-24` — VoxelGrid construction (heightQuery).
- `src/mining/excavation.ts:140-144` — excavate surface read.
- `src/mainLoop.ts:278-280` — terrain.update site.
- `src/core/settings.ts:450-451` — S entries; SCHEMA around line 510.

## Verification

- `npm run typecheck` passes.
- `npm test` passes.
- Manual: carve with KeyX; no hang; chunks stream as camera moves; settings overlay shows mining sliders.

## Assumptions

- `Terrain.heightfield` exposes `heightAt(x,z)` (confirmed in terrain.ts).
- `VoxelGrid` constructor accepts a `HeightQuery`-shaped object (confirmed).