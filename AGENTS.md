# AGENTS.md — Battle of Hoth Simulator

Real-time, flyable Battle of Hoth recreation. T-47 snowspeeder over procedural snow,
AT-AT/AT-ST models, Imperial Star Destroyers overhead, AI wingman. Pure Three.js
used as a **WebGL2 rasterizer** — every shader is hand-written GLSL ES 3.0, no Three
materials/lights/shadows/tonemapping. Ported from the Babylon.js/WebGPU original
SNOWFLOW (see `port/`). Upstream: `csanz/battle-of-the-hoth-simulator`.

## Stack

- Language: TypeScript (`strict`, `isolatedModules`, ES2022, DOM lib). `npm run typecheck`.
- Runtime dep: `three@^0.182`. Dev: vite 8, vitest 5, tsc 7.
- Build: Vite (`npm run dev`, `npm run build`, `npm run preview`).
- Tests: Vitest, `tests/**/*.test.ts` + `src/**/*.test.ts`, node env. `npm test`.
- CI: `.github/workflows/ci.yml` — typecheck → test → build on Node 22.
- Asset pipeline (Node ESM scripts in `tools/`): `bakeModel.mjs`, `bakeDestroyer.mjs`,
  `combineMixamo.mjs`, `addGun.mjs`. Bake GLB → binary model assets under `public/models/`.

## Repo layout

```
src/
  main.ts, mainInit.ts, mainLoop.ts, mainContracts.ts, mainUi.ts, mainVfx.ts,
  mainBootAssets.ts, mainFlightMode.ts
  core/        engine-replacement + math + settings + input + camera + loading + perf
  render/      sky, shadows (CSM), depthPass
  post/        postChain (TAA/SSR/DoF/AgX)
  terrain/     clipmapMesh, heightfield, deformation, terrain
  character/   controller, figure, cloth, build, snowContact
  player/      speeder, jet, modelAsset
  physics/     colliders, collisionPass, impact
  spells/      spellSystem, waterBody, crystals, bending, sweep, ribbon, bloom, crystallize, vortex
  vfx/         particles, surfWake, smokeTrails, muzzleMarkers
  audio/       engine, manifest
  ui/          overlay, fpsMeter, perfHud, fpsTier, soundButton, touchControls
  shaders/     registry.ts, lib/*.glsl, post/*.glsl, *.glsl (raw)
port/          binding plan + CONTRACTS.md + per-subsystem specs (not shipped)
tests/         vitest tests
public/        static assets (models, audio, textures) — copied verbatim
```

Entry: `src/main.ts` → `mainInit.boot()`. Page `index.html` hosts `<canvas id="view">`.

## Architecture invariants (read `port/CONTRACTS.md` before touching cross-cutting code)

1. **Three is a rasterizer.** No Three built-in materials/lights/shadows/tonemapping.
   Every material is `RawShaderMaterial` with explicit uniforms; every pass is explicit code.
   `renderer.outputColorSpace = LinearSRGBColorSpace`, `toneMapping = NoToneMapping`,
   every texture `NoColorSpace`, `flipY=false`. Only the composite pass does exposure/AgX/sRGB.
2. **Left-handed, +Z-forward world, hand-built matrices.** `core/mat4.ts` provides
   `lookAtLH`, `perspectiveFovLH`, `orthoOffCenterLH`, `mulMat4`, `invertMat4`, `invertRigid`.
   No Three transform math feeds any shader. World forward = `(sin yaw, 0, cos yaw)`.
   Bearings = `atan2(dx, dz)`.
3. **All meshes sit at identity world matrices forever.** `matrixAutoUpdate=false`,
   `frustumCulled=false`. Vertex shaders output world space directly (skinning/procedural);
   no model matrix anywhere.
4. **Matrix storage**: column-major flat `Float32Array(16)`, translation at 12-14.
   Babylon `A.multiplyToRef(B, out)` ≡ `mulMat4(out, B, A)` (i.e. `view.multiplyToRef(proj)`
   → `mulMat4(viewProj, proj, view)`). GL clip z ∈ [-1,+1].
5. **Depth**: main buffer standard GL (near 0 far 1). Shadow cascades store
   `gl_FragCoord.z` (window [0,1]) in R channel of R32F **color** target, cleared to 1.0.
   Shadow lookup: `ndc = clip.xyz/clip.w`, reject `|ndc.xy|>1` or `ndc.z∉[-1,1]`,
   compare `d = ndc.z*0.5+0.5`. Shadow UV = `ndc.xy*0.5 + 0.5`, **no Y flip**.
   View space for post/prepass is LH, +z forward, positive metres; `clip.w == +viewZ`.
6. **Camera state** is a plain object owned by `core/camera.ts`, NOT a THREE camera:
   ```
   rig.camera = { position, fov (radians, vertical), aspect, minZ, maxZ,
     view, projection, viewProjection, invView, invViewProjection }
   ```
   `gfx.threeCamera` is a token synced for Three's internal sort only.
7. **Coordinate rule for GLSL**: WGSL `select(f,t,cond)` → `cond ? t : f` (operand order
   reverses!); `textureLoad` → `texelFetch`; `dpdx/dpdy` → `dFdx/dFdy`; `v * m` stays
   `v * m` (row-vector×matrix), never rewrite to `m * v`.
8. **Shader registration**: `shaders/registry.ts` resolves `#include<name>` from a chunk map
   built from Vite `?raw`/glob imports. Never use Three's ShaderChunk.
9. **Render passes** are an explicit ordered list in the frame function (deform sim →
   cascades ×3 → depth prepass → beauty (sky/opaque/blended, one depth buffer, no clears
   between) → post chain). `renderer.autoClear=false`, one explicit clear at beauty start.
   Layer bits SKY/OPAQUE/BLEND + `renderOrder` table. Pass runner swaps `mesh.material`
   to a registered per-pass material, renders the pass's layer, restores.
10. **All meshes identity**: see (3). Vertex placement is world-space in shaders.

## Conventions

- **Zero per-frame allocation** (G2): module-scope scratch vectors/arrays, pre-sized staging
  buffers, mutate uniform `.value` in place. Never `new Vector3/Matrix4/arrays` in
  `update`/`sync`.
- **Verbatim numbers** (G3): copy tuned constants digit-for-digit from the source; do not
  simplify/normalize/fix documented oddities.
- **Names are contracts** (G4): module paths, class/method/uniform/attribute/texture/settings
  keys exactly as listed. Consumers bind by name.
- **Stub tolerance** (G1): constructors must not throw when a peer handle is null; `update`/`sync`
  early-out on missing resources; missing peer sampler binds `gfx.blackTex`/`gfx.whiteTex`.
- **No model matrix anywhere.** See invariant (3).
- **sRGB exactly once** — in the composite shader.
- **Deform relaxation time-banking**: dt=0 most frames.
- **One multiplier for model speed+gait.**
- **`wakeEroded` byte-identical across passes.**
- **Jitter frozen mid-frame.**

## Coding rules

- TypeScript `strict`. No `any` escape hatches unless justified. Use `as` casts sparingly.
- Prefer `edit` for surgical changes; `write` for new files. Never create docs unless asked.
- File-local scratch at module scope, not inside hot functions.
- RawShaderMaterial only; uniforms explicit; `viewProjection` bound manually from shared
  frame state.
- Texture loading: `NoColorSpace`, `flipY=false` (set via `gfx` helpers / asset loader).
- `matrixAutoUpdate=false; frustumCulled=false` on every mesh.
- No per-frame `new`. Pre-allocate.
- Settings read directly: `S.foo` (no getters). React to edits via `onChange(key, cb)`.
- Booleans in settings are toggles; never gate heavy work on a setting read every frame
  without caching where it matters.
- Keep shaders in `src/shaders/*.glsl` (and `lib/`, `post/`); register includes via registry.

## Build / run / test

```
npm install
npm run dev          # vite dev server
npm run build        # production build
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run test:watch   # vitest
npm run preview      # preview built bundle
```

WebGL2 + `EXT_color_buffer_float` required; boot fails to `#nogpu` otherwise.
Mobile (coarse pointer) → balanced preset + resolutionScale 0.7, applied before terrain build.

## Testing

- Vitest node env (no DOM). Tests live in `tests/` and `src/**/*.test.ts`.
- Existing tests: `mat4.test.ts` (matrix math), `flightState.test.ts`, `clipmapMorph.test.ts`.
- Test math/utilities, not wiring. Permanent tests must catch consumer-visible bugs.
- Don't test source text, mock echoes, incidental defaults.
- Investigation/feature work: throwaway scripts in eval, not permanent tests unless
  uncertain edge or user request.

## Git / workflow

- Default branch `main`. Remotes: `origin` (anlmalabs/cryo), `upstream` (csanz/battle-of-the-hoth-simulator).
- Uncommitted changes in working tree are the user's — adapt, don't revert.
- No AGENTS.md previously existed; this file is the project's agent guide.
- CI runs typecheck + tests + build; keep all green.

## Key files to read first

- `port/CONTRACTS.md` — binding cross-cutting contracts (coordinate system, matrices,
  depth, camera, gfx API §9, shader rules §6).
- `port/PLAN.md` — port plan + phases.
- `port/specs/*.md` — per-subsystem specs (core-app, render-post, terrain, character,
  player, spells, vfx, audio-ui).
- `src/core/gfx.ts` — engine replacement (renderer, caps, layers, pass runner, RT registry).
- `src/core/mat4.ts` — flat-array matrix math.
- `src/core/settings.ts` — `S` store + schema + presets + `onChange`.
- `src/mainInit.ts` — boot sequence + warm-up.
- `src/mainLoop.ts` — frame orchestration.
- `README.md` — user-facing description.

## Notes / gotchas

- `refs/` and `dist/` are gitignored artifacts; `refs/` holds reference screenshots.
- `repomix-output.xml` is a large bundled dump — don't read wholesale.
- `terrain-seam-note.md` documents an open clipmap seam TODO.
- Shaders use `#include<lib/...>` resolved by registry; GLSL ES 3.0 (`#version 300 es`).
- `EXT_color_buffer_float` is mandatory (fail boot without it); `OES_texture_float_linear`
  optional (warn + degrade).
- Shadow UV has no Y flip (compensates a Babylon RTT quirk that WebGL FBOs lack).
- Never use `BackSide` for default-orientation Babylon meshes; `FrontSide` (CCW) is default,
  `DoubleSide` is safe fallback.
- Babylon comments in code are deliberate notes about what each piece replaced — keep them.
- `window.SNOWFLOW` is the console debug handle; not read by app code.
- Touch controls exist for coarse-pointer devices.

## Performance

- `installDrawCounter` + `renderer.info` with `autoReset=false`, latched in `endFrameDraws()`.
- gpuMs stays 0 → overlay shows dash (timestamp queries not relied on).
- Warm-up: `renderer.compileAsync` + 3 real warm frames + `spells.finishWarmUp()` + 25s watchdog.
- `setRenderScale(s)`: `renderer.setSize(css*s, false)` + resize tracked RTs + `post.resetHistory()`.

## Shader editing

When editing `.glsl`, preserve the mechanical translation rules (§G5). Run
`npm run typecheck` (shaders aren't typechecked but TS imports of registry are) and
`npm run build` to catch compile errors. Test shaders via the debug views:
`S.debugView` (11 modes), `S.speederDebug` (8 modes), `wake.debug` (10 modes).
