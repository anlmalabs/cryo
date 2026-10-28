# Porting spec for the `render-post` subsystem

Source files (Babylon.js / WebGPU / WGSL):

| File | Role |
|---|---|
| `src/render/depthPass.ts` | Scene linear-depth and specular-mask prepass |
| `src/render/shadows.ts` | Hand-rolled 3-cascade CSM with PCSS-friendly R32F maps |
| `src/render/sky.ts` | Nishita sky LUT bake, SH ambient, ground-bounce solve, skybox draw |
| `src/post/postChain.ts` | 9-pass post chain (SSR, TAA, shafts, bloom×3, DoF, tonemap composite, sharpen) plus TAA jitter ownership |
| `prepass.fragment.wgsl`, `sky.vertex/fragment.wgsl`, `skyBake.fragment.wgsl` | Prepass fragment, sky vertex/fragment, sky bake |
| `post/*.wgsl` | `taa`, `ssr`, `shafts`, `bloomDown`, `bloomBlur`, `dof`, `tonemap`, `sharpen` |
| `lib/postCommon.wgsl`, `lib/shadowLookup.wgsl`, `lib/atmosphere.wgsl`, `lib/shading.wgsl` | Shared includes |

Target: Three.js `WebGLRenderer` (WebGL2, GLSL ES 3.0, `RawShaderMaterial`/`ShaderMaterial`, `WebGLRenderTarget`-based sims and a manual fullscreen-quad post chain).

---

## 1. Purpose & behavior

This subsystem is the entire camera-facing render infrastructure of the demo. It owns
four things: a linear-depth prepass that every screen-space effect reads, plus the sun shadow
cascades, the procedural sky (baked LUT, SH ambient, skybox mesh, shared sun radiometry),
and the full post-processing chain including the TAA projection jitter that the *whole
scene* renders through.

### 1.1 Depth prepass
Class: `DepthPass`.

A full-resolution RGBA16F render target ("scenePrepass") is rendered before the beauty pass
each frame. Nothing in the scene has CPU-side geometry that matches what is drawn (the
terrain is a GPU clipmap, characters are skinned from transform textures, etc.), so a
generic depth renderer is useless. Instead every drawable subsystem registers a caster:
the mesh plus a dedicated prepass `ShaderMaterial` that runs the same vertex displacement
as its beauty material and writes, via the shared `prepass.fragment.wgsl`, into these
channels:

| Channel | Contents |
|---|---|
| `r` | Linear view-space depth in metres (the clip-space `w`, carried as a varying `vViewZ`, so it is exact and needs no reconstruction from the depth buffer) |
| `g` | Specular mask `vMask`: 0 = matte snow, 1 = mirror ice (only SSR reads it) |
| `ba` | Spare (0, 1) |

Clear color is `(DEPTH_FAR=9000, 0, 0, 1)`, which sits beyond the camera far plane, so sky
pixels read as "background" (`isBackground(z) := z > 4500`) with no separate mask. The
target carries its own depth buffer, uses clamp addressing, is sampled with `NEAREST`
(bilinear sampling across a silhouette invents depths belonging to neither surface), and is
resized with the canvas. It renders with the same jittered view-projection as the beauty
pass (see 1.4), so depth and color align to the subpixel.

Consumers: TAA (reprojection), light shafts (occlusion), DoF (CoC), SSR (ray march and
normal reconstruction).

### 1.2 Shadow cascades
Class: `ShadowSystem`.

Three cascades (`CASCADE_COUNT=3`) exist, each a 2048×2048 R32F color target rather than a
depth texture, because PCSS needs raw depths for its blocker search and a hardware
comparison sampler returns pre-thresholded values. Each map is bilinear-sampled with clamp
addressing, carries a depth buffer, and is cleared to `(1,1,1,1)` (far plane, so nothing
occludes). Splits sit at 26 / 95 / 330 m; slices overlap by starting each next slice at
`prevFar * 0.88` so the shader cross-fade
band has data in both maps.

Per-frame `update(camera, sunDir)` refits each cascade in six steps.

1. Unproject the 8 NDC cube corners through the inverse view-projection. WebGPU NDC z runs
   in [0,1], while the WebGL2 unprojection cube is z ∈ [-1,1] (see risks). Then re-cut each
   near→far edge at the slice distances normalized against `camera.minZ..camera.maxZ`.
2. Fit a bounding sphere. The sphere is rotation-invariant, so there is no edge crawl on
   camera turn, and its radius is quantized *relatively* (`q = 2^(ceil(log2 r) - 8)`,
   `r = ceil(r/q)*q`, min 0.5) so ULP noise in the unprojection can't rescale the map.
3. Build the light basis (`up` = +Y, or +Z when `|lightDir.y| > 0.995`) and texel-snap the
   cascade centre in world space along the light's right/up axes
   (`texelWorld = 2r / 2048`). The snap must happen *before* the view matrix is built;
   snapping afterwards is self-referential and does nothing.
4. Solve the light-volume depth analytically from the world height bounds
   (`minHeight/maxHeight`, set via `setHeightBounds`, defaults -60/60, pad
   `texelWorldPad=2`). With `fy = min(lightDir.y, -0.0349)`, which clamps at 2° elevation,
   evaluate `g = (py - center.y - yRel*lup.y)/fy` at the 4 combinations of
   `yRel = ±(radius+pad)` and `py = minHeight|maxHeight` to get `gMin..gMax`. Then
   `MARGIN=12`, `backoff = MARGIN - gMin`, eye = `center - lightDir*backoff`,
   `near = MARGIN*0.5` and `far = backoff + gMax + MARGIN`. This is what keeps a grazing
   13° sun (cot ≈ 4.3 m depth per lateral metre) inside the volume without a fixed budget.
5. Compose `LookAtLH(eye, center, up)` × `OrthoOffCenterLH(-r, r, -r, r, near, far,
   halfZRange=true)`; the halfZRange maps z into [0,1], and the Babylon default of [-1,1]
   would clip the caster half of the volume on WebGPU. Store to `matrices[c]`, flatten into
   `matrixData` (Float32Array 48), and set `params[c] = (far-near [m], 2r [m], 0, 0)`
   flattened into `paramData` (Float32Array 12). PCSS works in metres and needs both.
6. Push `lightViewProjection` into every registered caster material for that cascade.

Casters register via `registerCaster(mesh, makeMaterial, cascades?)`, which holds one
material instance per cascade; each holds its own `lightViewProjection` uniform and so
avoids mid-frame UBO juggling. `cascades` limits small objects (a 2 m character) to the near
cascades.

The *receiving* side lives in `lib/shadowLookup.wgsl` together with `pcssShadow` in
`lib/shading.wgsl`. Both are compiled into consumer materials (terrain, character, models,
wake and water, all other subsystems), reading the three maps as three separate bindings.

### 1.3 Sky
Class: `Sky`.

No HDRI exists. Instead, a Nishita single-scattering integral is baked into an
equirectangular LUT whenever the sun moves:

| Texture | Format | Notes |
|---|---|---|
| `skyLUT` | 512×256 RGBA16F `ProceduralTexture` | Mipmapped and trilinear, wrap U / clamp V. The runtime aerial-perspective code samples mip 3 (`aerialNearSky`) and mip 0. |
| `skySH` | 64×32 RGBA32F | A copy of the same bake, read back to the CPU and projected into 9 RGB spherical-harmonic coefficients (`sh`: Float32Array 36, laid out as 9 × vec4). |

Radiometry, all on one shared scale (`sunScale = S.sunIntensity * 5.5`):

- `sunDir` is the unit vector toward the sun, derived from `S.sunAzimuth`/`S.sunElevation`
  as `dir = (sin(az)·cos(el), sin(el), cos(az)·cos(el))`.
- `sunRadiance` (Color3) is the direct solar irradiance. It uses Kasten–Young air mass
  `1/(cos z + 0.50572·(96.07995 − zdeg)^-1.6364)` (clamped ≤ 40), with per-channel
  Beer–Lambert attenuation `tauR = [0.0464, 0.108, 0.265] * S.sunTempWarm`,
  `tauM = 0.0252`, times `sunScale`.
- `sunColor` is `sunRadiance` normalized so that its max channel is 1.
- `groundBounce` (Color3) is the radiance leaving the snow field, solved by iteration
  (`solve()`): 3× {bake LUT, project SH, recompute bounce}, then a final bake and
  projection. Bounce = `SNOW_ALBEDO * E / π`, where
  `E = sunRadiance·max(0,sunDir.y) + SH up-irradiance` (bands surviving n=(0,1,0):
  `sh0·0.886227 + sh1·2·0.511664 + sh6·(−0.247708) + sh8·(−0.429043)`),
  with `SNOW_ALBEDO = [0.83, 0.86, 0.91]`.

`update()` runs every frame. It re-derives sun params from settings and only rebakes (via
async `solve()`) when the sun direction has changed by more than 1e-6 per component, and
only once the bake shaders have compiled. The SH readback (`readPixels`) is async, so a
slider drag settles over a few frames.

The skybox is a unit cube (`size: 2`) scaled by `skyScale = camera.maxZ * 0.5` and pinned
to the camera in the vertex shader via `clip.z = clip.w * 0.999999`, which forces it to the
far plane (the demo does not use reversed-Z). It writes no depth, does not cull backfaces,
and renders in group 0, drawn first, so that the terrain covers everything below its
silhouette. The fragment shader runs four stages:

1. Sample `skyLUT` via lat-long (`dirToLatLong`: `u = atan2(x,z)/2π + 0.5`, `v = acos(y)/π`).
2. Draw the far mountain range. When `ridgeAmp > 1` and `-0.05 < dir.y < 0.23`, ray-march a
   procedural ridge heightfield (`ridgeMarch`/`ridgeShadow` from `lib/ridge.wgsl`, a shared
   include owned elsewhere but compiled into this shader) and shade the hit with the *snow
   field's own* material logic: wrapped diffuse, `snowSubsurface`, `shIrradiance` ambient
   (from `shR`) and self-bounce, then the scene's own aerial perspective
   (`aerialTransmittance` + `aerialInscatterSky`) so that a fully hazed massif equals the
   sky pixel beside it exactly.
3. Draw the solar disc (~0.53°, using a `cos(0.0046)` cutoff) with limb darkening
   (`pow(max(0,1−r²·0.72), 0.42)`, ×42 intensity) plus aureole
   (`pow(mu,1400)·5.5 + pow(mu,64)·0.28`, ×0.5).
4. Draw cirrus. fbm noise (`fbmd`, 4 octaves, lacunarity 2.13, gain 0.52, from
   `lib/noise.wgsl`) is evaluated on a high plane `1/max(0.06, dir.y)`, advected by
   `windDir · time · 0.004`, rotated and stretched along the wind (×0.28 across), faded at
   horizon and zenith, and lit warm from below (`cloudAmount` fixed at 0.55).

`lib/atmosphere.wgsl` details that must be preserved exactly, because they encode fixed
bugs:

- `nishitaSky` starts at `EARTH_R + 800` and takes 32 view steps distributed by `t^2.5`.
  The power-law step distribution is load-bearing: uniform steps carve a 1-stop dark notch
  around the horizon. There are 8 light steps, `BETA_R = (5.8e-6, 13.5e-6, 33.1e-6)`,
  `BETA_M = 21e-6` (×1.1 in extinction), `MIE_G = 0.76`, `H_R = 8000`, `H_M = 1200`.
- Samples whose light path hits the planet are not discarded. They accumulate into
  `shadR/shadM`, attenuated along the view path only, and then enter the isotropic
  multiple-scattering pass at `SHADOW_FILL = 0.5`, which kills the dark anti-sun band.
- Multiple scattering is `+ sunIntensity·((sumR + shadR·0.5)·BETA_R·1.5 +
  (sumM + shadM·0.5)·BETA_M·0.4)/(4π)`.
- Below the horizon, hand over to `groundBounce` across `rayDir.y ∈ [-0.030, -0.005]`.
- Grazing desaturation pulls the last ~15° toward the luminance
  `dot(col,(0.30,0.42,0.28))`, tinted `(0.97,1.0,1.06)`, with weight
  `(1 − smoothstep(0, 0.26, |y|)) · 0.82`.
- Runtime aerial perspective (used by 7 materials in other subsystems *and* by the sky's
  ridge shading) consists of `aerialTransmittance` (closed-form height-falloff fog
  integral), `aerialNearSky` (LUT tilted up +0.42, mip 3), `aerialInscatterSky` (crossfade
  from near to exact-sky-sample over `ext ∈ smoothstep(0.55, 0.995)`, with a forward Mie
  lobe `phaseMie(mu, 0.62)·5.5·0.16` on the near half only) and `applyAerial` (the public
  entry).

### 1.4 Post chain
Class: `PostChain`.

Nine passes exist, and all stay attached. A disabled effect early-outs in its own shader to
a copy rather than detaching, since detaching reshuffles Babylon's texture chain. Under
Babylon semantics, pass *i* renders into pass i+1's input texture, so the size a pass runs
at is declared on the *next* pass. The authoritative table:

```
pass        renders at   reads                          writes into
ssr          full        scene color, depth             taa's input texture
taa          full        ssr result, history[1-k], depth   history[k]      (forced output)
shafts       1/4         depth                          bloomA's input
bloomA       1/4         history[k] (bright pass)       bloomB's input
bloomB       1/16        bloomA result                  bloomC's input
bloomC       1/16        bloomB result (tent blur)      dof's input
dof          full        history[k], depth              composite's input
composite    full        dof result, bloomA, bloomC, shafts   sharpen's input
sharpen      full        composite result               swapchain (UNSIGNED_BYTE)
```

All intermediate targets are RGBA16F and bilinear; only sharpen's output is 8-bit. TAA's
output is forced into one of two persistent full-res RGBA16F history textures (ping-pong
`k = 1-k` per frame, since a pass cannot sample its own output). That is what lets bloomA
and dof read the *resolved full-res scene* after the chain has moved on to 1/16-res
textures. In Babylon this is done by hijacking `shafts._forcedOutputTexture =
history[k].renderTarget`, because shafts is the pass *after* TAA, so TAA renders into it.
In Three.js, render the TAA quad into `history[k]` directly and give shafts its own 1/4-res
target: the indirection is a Babylon-ism, not a design requirement.

`update(dt, streak, focus)` must run after the camera rig moves and before the scene
renders, because the depth prepass and beauty pass read the same scene matrix:

1. Accumulate `time`; latch `speedStreak` (0..1 from the surf state); ease `focusDist`
   toward `focus` (`+= (focus−f)·min(1, dt·4)`) starting from an initial 6.2 m.
2. Recompute the unjittered view and projection; store `curViewProj` (for `endFrame` to
   hand to next frame's `prevViewProj`), `invView`,
   `projInfo = (tan(fov/2)·aspect, tan(fov/2))` and `invRes = (1/w, 1/h)`.
3. Project the sun for shafts: `sunWorld = camPos + sunDir·2000` through `curViewProj`,
   then `sunUV = ndc·0.5+0.5` and
   `sunOnScreen = dot(sunDir, camForward) > 0.05 ? 1 : 0`. The forward vector is the third
   column of the view matrix, and since the transform mirrors points behind the camera, a
   dot test is required. `sunColor` is set to `sky.sunRadiance`.
4. Use a bloom knee in exposed units: `th=3.0, knee=1.4`,
   `curve = (th, th−knee, 2·knee, 0.25/knee)`.
5. Apply TAA jitter: an 8-point Halton(2,3) sequence on [-0.5, 0.5] px, zero when `S.taa`
   is off, giving `jitterNdc = (2jx/w, 2jy/h)`. Add it to projection matrix elements
   m[8] and m[9], the elements that shear clip x,y by w. In Three.js this is
   `projectionMatrix.elements[8] += jx` and `[9] += jy`. Then freeze the projection so that
   nothing recomputes it mid-frame.
6. Flip the history index and repoint the forced output.

`endFrame()` runs after `scene.render()`. It copies `curViewProj → prevViewProj` and ramps
`historyValid` 0 → 0.5 → 1 over two frames, giving two frames of grace to fill both history
buffers before anything reads `1-k`. `resetHistory()` zeroes the ramp on teleport; resize
also zeroes it and reallocates both histories.

Per-frame call order (from `main.ts` run loop):

```
character/terrain-sim updates …
rig.update(...)                         // camera moved, FOV set
post.update(dt, character.streak01, rig.distance)
sky.update()                            // rebake if sun moved
sky.render(rig, time)                   // push skybox uniforms
shadows.update(rig.camera, sky.sunDir)  // refit cascades
… other subsystem sync (they consume shadows.matrixData etc.) …
scene.render()                          // cascades → prepass → beauty → post chain
post.endFrame()
```

At startup: `new Sky` → `await sky.solve()` → `new ShadowSystem` → `new DepthPass` →
(scene objects register casters into both) → `new PostChain(scene, rig.camera, depthPass, sky)`
→ warm-up compiles everything behind the loading screen (`depthPass.warmUp()`,
`whenReady` on the sky material and each post pass), then 3 real frames to allocate targets.

---

## 2. Public API

### `src/render/depthPass.ts`

- `export const DEPTH_FAR = 9000` (clear depth), which must equal `POST_FAR` in postCommon.
- `export class DepthPass`, whose members are:

| Member | Behavior |
|---|---|
| `constructor(scene)` | Creates the RGBA16F full-res RTT (`scenePrepass`) and pushes it onto `scene.customRenderTargets`, so it renders after the cascades and before the main pass in registration order. Hooks engine resize. |
| `.rtt` | The RenderTargetTexture, bound as `depthTex` by post passes. |
| `.size: Vector2` | Current pixel size, republished for shaders. |
| `.registerCaster(mesh, material)` | Appends to the render list and overrides the mesh's material for this target (`setMaterialForRendering`). The material must declare `viewProjection`, bound to the active jittered camera at RTT render time, and output via `prepass.fragment.wgsl`'s varyings (`vViewZ`, `vMask`). |
| `async warmUp()` | Compiles all registered prepass pipelines. |
| `.dispose()` | Releases the target. |

### `src/render/shadows.ts`

- `export const CASCADE_COUNT = 3`; internal `RESOLUTION = 2048`, `SPLITS = [26, 95, 330]`.
- `export class ShadowSystem`, whose members are:

| Member | Behavior |
|---|---|
| `constructor(scene)` | Creates the 3 R32F RTTs on `scene.customRenderTargets`. |
| `.maps: RenderTargetTexture[3]` | Bound as the `cascade0/1/2` samplers. |
| `.matrices: Matrix[3]`, `.matrixData: Float32Array(48)` | The `cascadeMatrices` data. |
| `.splits: Float32Array(4)` | `[26, 95, 330, 330]`, bound as `cascadeSplits`. |
| `.params: Vector4[3]` / `.paramData: Float32Array(12)` | Bound as `cascadeParams`, per-cascade `(depthRange m, orthoWidth m, 0, 0)`. |
| `.texelSize = 1/2048` | Bound as `shadowTexel`. |
| `.resolution = 2048` | Map resolution. |
| `.lightDir: Vector3` | The direction light *travels*, equal to −sunDir. |
| `.setHeightBounds(min, max)` | World height range of casters; the terrain bake calls it. |
| `.registerCaster(mesh, makeMaterial: (cascade)=>ShaderMaterial, cascades?)` | Creates per-cascade material instances. Each must declare `lightViewProjection`, set inside `_fitCascade` every frame. |
| `.update(camera, sunDir)` | Refits and flattens. Call once per frame after the camera moves. |
| `.dispose()` | Releases the targets. |

The published state in that table is consumed by other subsystems' materials.

### `src/render/sky.ts`

- `export class Sky`, whose members are:

| Member | Behavior |
|---|---|
| `constructor(scene)` | Builds `skyLUT` (512×256 RGBA16F, mips, trilinear, wrapU/clampV), `skySH` (64×32 RGBA32F), the skybox cube and `ShaderMaterial("sky")`. |
| `.sunDir: Vector3` | Toward the sun. |
| `.sunColor: Color3` | Normalized hue. |
| `.sunRadiance: Color3` | Irradiance on the LUT's scale. |
| `.sunScale: number` | Shared radiometry scale. |
| `.groundBounce: Color3` | Radiance leaving the snow field. |
| `.sh: Float32Array(36)` | 9 × vec4 RGB SH. |
| `.lut` | The LUT texture, sampled by terrain/character/etc. as `skyLUT`. |
| `.mesh`, `.material` | The skybox drawables. |
| `.syncFromSettings()` | Recomputes sun vector and radiance from `S.sunAzimuth`, `S.sunElevation`, `S.sunIntensity`, `S.sunTempWarm`, and sets `_dirty` if the sun moved. |
| `.update() → bool` | Per frame. Rebakes via `solve()` only when dirty and compiled. |
| `async solve()` | Runs 3 iterations of {`bake()`, `await projectSH()`, `_updateGroundBounce()`} plus a final bake and projection. Called at load and on sun change. |
| `.bake()` | Sets `sunDir`, `sunIntensity` (=sunScale) and `groundBounce` on both procedural textures, and renders them. |
| `async projectSH()` | Reads back `skySH` (Float32) and integrates 9 real SH bands with solid-angle weights `dω = sinθ·(2π/64)·(π/32)`. |
| `.render(rig, time)` | Pushes all skybox uniforms (see the §4 sky.fragment list). Reads settings `S.windDirection`, `S.ambientIntensity`, `S.showMountains`, `S.mountainHeight`, `S.fogDensity`, `S.fogHeightFalloff`, `S.fogStart`, `S.aerialStrength`. `cloudAmount` is hard-coded to 0.55 and `skyScale = camera.maxZ * 0.5`. |
| `.dispose()` | Releases the sky resources. |

### `src/post/postChain.ts`

- `export class PostChain`, whose members are:

| Member | Behavior |
|---|---|
| `constructor(scene, camera, depthPass, sky)` | Registers the 8 WGSL post shaders, builds 2 history RTTs and 9 `PostProcess` instances in chain order, wires `onApply` bindings, and hooks resize (reallocate history, invalidate). |
| `.speedStreak: number` (0..1) | Public, and also settable via the update args. |
| `.focusDist: number` (m) | Public, and also settable via the update args. |
| `.passes: PostProcess[9]` | For warm-up iteration. |
| `.update(dt, streak?, focus?)` | See §1.4. Consumes `S.taa` (jitter on/off). |
| `.endFrame()` | Latches prevViewProj and ramps historyValid. |
| `.resetHistory()` | Clears the history ramp. |
| `.dispose()` | Releases the chain. |

The per-pass settings consumed in `onApply`, using exact keys from `src/core/settings.ts`:

| Pass | Settings consumed |
|---|---|
| ssr | `S.ssr` (bool), strength fixed 1.0 |
| taa | `S.taa` (bool), feedback fixed 0.90 |
| shafts | `S.showLightShafts` (bool), `S.shaftStrength` (default 0.30) |
| dof | `S.dof` (bool), `maxCoc = renderHeight * 0.0024` px |
| composite | `S.exposure` (0.105), `S.contrast` (1.14), `S.tonemap` ("agx"|"aces"|"none" → mode 0|1|2), `S.grain` && `S.grainStrength` (0.022), vignette fixed 0.22, `S.windStreaks` && `S.streakStrength` (1.0), `S.bloom` && `S.bloomStrength` (0.22), `S.showLightShafts` → shaftAmount 1|0 |
| sharpen | `S.sharpen` && `S.sharpenStrength` (0.55) |

Also relevant: `S.resolutionScale` (0.5–1.5) drives `engine.setHardwareScalingLevel(1/scale)`
in main.ts, so every "full res" above means the scaled render size, and the quality presets
flip `ssr`, `dof` and `resolutionScale`.

---

## 3. Data flow
Cross-subsystem contracts.

Produced by this subsystem, consumed elsewhere:

| Resource | Format / size | Owner | Update | Consumers |
|---|---|---|---|---|
| `depthPass.rtt` ("scenePrepass") | RGBA16F, render size, NEAREST, clamp, own depth buffer | DepthPass | every frame, before beauty pass, jittered camera | post passes (ssr/taa/shafts/dof as `depthTex`); cleared `r=9000` |
| `shadows.maps[0..2]` | R32F color, 2048², bilinear, clamp | ShadowSystem | every frame (custom RTs before prepass) | terrain/character/models/wake/water materials as `cascade0/1/2` via `lib/shadowLookup.wgsl` |
| `shadows.matrixData` | 48 floats (3 mat4, column-major Babylon layout) | ShadowSystem | every `update()` | consumer material UBOs as `cascadeMatrices` |
| `shadows.paramData` | 12 floats (3 vec4: depthRange, orthoWidth, 0, 0) | ShadowSystem | every `update()` | `cascadeParams` |
| `shadows.splits` | 4 floats `[26,95,330,330]` | ShadowSystem | static | `cascadeSplits` |
| `shadows.texelSize` | scalar 1/2048 | ShadowSystem | static | `shadowTexel` |
| `sky.lut` ("skyLUT") | RGBA16F 512×256 equirect, mips, trilinear, wrapU/clampV | Sky | on sun change only | sky material; terrain/character/wake/water/spray via `applyAerial`/ice reflections (`skyLUT` sampler) |
| `sky.sh` | 36 floats (9 vec4 RGB SH) | Sky | on sun change (async readback) | every lit material (`shR` uniform) + sky ridge shading |
| `sky.sunDir` | Vector3 toward sun | Sky | per frame from settings | ShadowSystem.update, PostChain (sun UV), all lit materials (`sunDir`) |
| `sky.sunRadiance` / `sunColor` / `sunScale` | Color3 / Color3 / float | Sky | per frame | all lit materials, shafts tint, sky shader |
| `sky.groundBounce` | Color3 | Sky | on solve | LUT bake input (internal), available to others |
| TAA history[k] | RGBA16F ×2, render size, bilinear | PostChain | TAA writes one per frame | internal (bloomA + dof read the resolved frame) |
| jittered projection | camera projection matrix m[8],m[9] | PostChain | per frame, frozen until frame end | *everything* that renders (prepass + beauty read the same scene transform) |

Consumed by this subsystem from others:

- The camera rig: `rig.camera` (position, fov, minZ, maxZ, view/proj), `rig.distance`
  (spring-arm length, which feeds the DoF focus) and `rig.camera.maxZ` (which sets
  skyScale).
- `character.streak01` (0..1 surf speed), which becomes the `post.update` streak arg.
- The terrain bake, which calls `shadows.setHeightBounds(min, max)`.
- Every drawable subsystem, which supplies prepass materials into
  `depthPass.registerCaster` and shadow materials into `shadows.registerCaster`. Those are
  their vertex programs, not this subsystem's.
- Shared shader includes that this subsystem's shaders pull in but do not own:
  `snowNoise` (`fbmd`, `hash22`, `rot2`, `PI`) and `snowRidge` (`ridgeMarch`,
  `ridgeShadow`, `RidgeHit`).
- The settings singleton `S` and `onChange` from `src/core/settings.ts`.

---

## 4. Shader inventory

General WGSL-to-GLSL notes apply to every file here. There are no storage textures, no
textureLoad, no textureGather and no integer bit-tricks anywhere in this subsystem.
Everything is `textureSampleLevel` (which becomes `textureLod`), plain float math and
compile-time-constant loops. The recurring translation points are: `select(f, t, cond)`
becomes `mix` or a ternary, keeping the argument order
select(falseVal, trueVal, cond); vector comparisons `any(v < w)` become
`any(lessThan(v, w))`; `mat3x3f`/`mat2x2f` constructors are column-major in both languages,
so the AgX matrices below are written as columns; `uniforms.x` blocks become plain
uniforms; Babylon's `FragmentInputs.position.xy` becomes `gl_FragCoord.xy`; `f32(i)` becomes
`float(i)`; `array<vec2f,12>` constants become `const vec2[12]`, which is fine in GLSL ES
3.0; and the NaN self-test `any(raw != raw)` becomes `any(isnan(raw))`, because GLSL `!=`
on vectors is an aggregate comparison, so the literal translation is wrong.

### `prepass.fragment.wgsl`
Writes `vec4(vViewZ, vMask, 0, 1)`. Varyings supplied by each caster's own prepass vertex
shader (owned by other subsystems). Trivial.

### `sky.vertex.wgsl`
Unit cube. `world = position * skyScale + cameraPosition`, and `clip.z = clip.w * 0.999999`
pins it to the far plane (the demo does not use reversed-Z). Varying `vDir = position`
carries the object-space direction. In Three.js, use `depthWrite:false`, `side:DoubleSide`,
and render first (via renderOrder or an explicit pass); equivalently,
`clip.z = clip.w * (1-ε)` still works in WebGL2 clip space.

### `sky.fragment.wgsl`
See §1.3. Uniforms: `sunDir, sunColor, sunIntensity(=sunScale), time, windDir(vec2),
cloudAmount, cameraPosition, sunRadiance, shR: array<vec4,9>, ambientIntensity, ridgeAmp,
fogDensity, fogHeightFalloff, fogStart, aerialStrength`. The sampler `skyLUT` must be
mipmapped and trilinear, and the ridge path samples mip 3 via `aerialNearSky`. GLSL care:
the uniform `array<vec4f,9>` becomes `uniform vec4 shR[9];`, and can be set with `.value =
array of Vector4` or a flat `Float32Array(36)` in `uniformMatrix` style, since Three
supports vec4 arrays with flat arrays. The shader uses `#include`s for noise, atmosphere,
shading and ridge, which port as a string-concat/include preprocessor, matching Babylon's
approach.

### `skyBake.fragment.wgsl`
Fullscreen quad over the LUT: `dir = latLongToDir(vUV)`, `color = nishitaSky(dir, sunDir,
sunIntensity, groundBounce)`. The solar disc is deliberately excluded, since it would blow
out the SH fit. Uniforms: `sunDir: vec3, sunIntensity: f32, groundBounce: vec3`. The same
shader renders both the 512×256 LUT and the 64×32 SH source. In Three.js, use one
`ShaderMaterial` plus a fullscreen triangle into two `WebGLRenderTarget`s (`HalfFloatType`
mipmapped / `FloatType` no-mips). Cost warning: 32×8 nested loop per texel, which is fine
at this resolution and bake-only. The vUV orientation must match `latLongToDir`'s
assumption that v=0 is the zenith (`theta = v·π`, `dy = cos θ`), so check the quad's UV
convention against Babylon's ProceduralTexture (v=0 at bottom in GL). The CPU `projectSH`
uses `theta = ((y+0.5)/H)·π` with row y=0 as the zenith, and `readPixels` row order must
agree or the SH hemisphere flips, with the symptom of ambient lit from below.

### `lib/postCommon.wgsl`
Include: `snowPostCommon`.
- `POST_FAR = 9000` (equal to DEPTH_FAR), `isBackground(z) = z > 4500`.
- `viewFromDepth(uv, z, projInfo)`: `ndc = uv·2−1`; view pos =
  `(ndc.x·projInfo.x, ndc.y·projInfo.y, 1)·z`. View space is left-handed, with +z forward.
- `uvFromView` is the inverse of `viewFromDepth`.
- `ignPost(pix)` is interleaved gradient noise from `gl_FragCoord.xy`.
- `lumaPost` (Rec.709), `tonemapWeight(c) = c/(1+luma)` and
  `tonemapUnweight(c) = c/max(1e-4, 1−luma)` are the Karis average, used by TAA and the
  bloom prefilter.
- The Y-convention comment in the original is Babylon-specific: in Babylon-WGSL, `vUV` and
  `fragCoord/res` agree and both run bottom-up, and a world point projected with the scene
  matrix lands at `ndc·0.5+0.5` with no flip. In Three.js/WebGL2 rendering to an FBO, UV
  v=0 is the bottom and projected NDC also maps with `ndc·0.5+0.5` unflipped, so the
  convention transfers cleanly. Verify once with the shafts sun UV, because a vertically
  mirrored lookup still looks plausible.

### `post/taa.fragment.wgsl`
Technique: depth-reprojection TAA without motion vectors (a deliberate choice), variance
clipping, Catmull-Rom history fetch, Karis-weighted blend.
- Inputs: `textureSampler` (SSR output, this frame's scene), `historyTex` (history[1-k])
  and `depthTex`. Uniforms: `prevViewProj` (mat4, unjittered), `invView` (mat4),
  `projInfo`, `invRes`, `jitterNdc`, `historyValid`, `enabled`, `feedback` (0.90).
- Reconstruction: `ndc = uv·2 − 1 − jitterNdc` (un-jitter before reconstructing), then
  `view = (ndc·projInfo, 1)·min(z, POST_FAR)`, `world = invView·vec4(view,1)` and
  `prevClip = prevViewProj·world`. Reject `w ≤ 1e-4` or a prevUV outside [0,1].
- A 3×3 neighborhood mean and σ in Karis space is computed, and the history is clipped to
  `μ ± 1.35σ`.
- History fetch is a 5-tap bilinear-folded Catmull-Rom (weights `w0..w3` as written),
  clamped at ≥ 0, since negative lobes undershoot and produce a black fringe through the
  clip. The NaN guard is `raw = μ`.
- Feedback is `k = clamp(feedback · motionFade · clipFade, 0, 0.97)` with
  `motionFade = 1 − clamp(px/64, 0, 1)·0.35` and
  `clipFade = 1 − clamp(|hist−raw|·4, 0,1)·0.45`, and the output is
  `tonemapUnweight(mix(curW, histClipped, k))`.
- GLSL: all `textureSampleLevel(..., 0.0)` becomes `textureLod(..., 0.0)`. The early-out
  structure (a helper returning a value) can become a plain `return` in GLSL main, or the
  helper can be kept. Matrix multiply order `M * v` is the same in both languages, and
  Babylon matrices are row-major-stored and left-handed, so see §5/§7.

### `post/ssr.fragment.wgsl`
Technique: SSR on ice only, gated on the prepass `g` channel (`mask ≥ 0.02`), full-res.
- Normal from depth uses forward differences of `viewFromDepth` at the `+x`/`+y` texels,
  giving `N = normalize(cross(dx, dy))`; reject if either neighbor is background.
  Cross-product handedness ties to the LH view space, so if the port flips view Z, the
  cross order flips.
- March: `V = normalize(P)` (the camera is at origin), `R = reflect(V, N)`, reject
  `R.z < 0.02`; stride is `max(0.06, z·0.035)`, the start is jittered by `ignPost`, and
  there are 28 steps with geometric growth `t += stride·(1 + i·0.16)`. A hit occurs when
  `0 < Q.z − depth(sUV) < THICKNESS=0.55` m, then a 5-step binary refine follows.
- Composite: Schlick `f = 0.045 + 0.955·(1−dot(−V,N))^5`, edge fade
  `smoothstep(0, 0.10, distToEdge)`, blend `mix(src, refl, mask·f·edgeFade·strength)`.
- A miss is encoded as `w = −1`.

### `post/shafts.fragment.wgsl`
Role: quarter res.
Radial sky-visibility march toward `sunUV`: 24 steps over `REACH=0.82` of the ray, with
per-step decay 0.955 and a start dithered by `ignPost` (a fixed hash, which is fine because
this pass runs *after* TAA, so the dithering is spatial rather than temporal). Accumulate
`illum` where `isBackground(depth)`, giving a result of `(acc/24)² · radial · strength`,
where `radial = 1 − smoothstep(0.03, 0.68, length((uv−sunUV)·(aspect,1)))`. The output is
`sunColor · v`, in radiance, and the composite adds it pre-exposure. Uniforms: `sunUV,
sunOnScreen, sunColor, enabled, strength, aspect`.

### `post/bloomDown.fragment.wgsl`
Role: bloomA: full→1/4 with prefilter; bloomB: 1/4→1/16.
Jimenez 13-tap downsample (center 2×2 box at weight 0.5 plus four overlapping outer boxes
at 0.125 each), with tap spacing of 2× source texel, and the `srcTexel` uniform is
pre-doubled on the CPU. The prefilter level (`prefilter=1`) Karis-weights each of the 5 tap
groups by `1/(1+luma)` before combining, then applies the soft-knee bright pass
`brightPass(c, curve)`: `br = maxc`, `rq = clamp(br − curve.y, 0, curve.z)`,
`soft = rq²·curve.w`, `c·max(soft, br−curve.x)/max(br,1e-5)`, with
`curve = (3.0, 1.6, 2.8, 0.25/1.4)` computed on the CPU. A non-prefilter level is a plain
weighted sum.
Uniforms: `srcTexel, prefilter, curve`; sampler `sourceTex` bound explicitly
(history[k] for A, bloomA's output for B).

### `post/bloomBlur.fragment.wgsl`
Role: bloomC: 1/16→1/16 tent.
9-tap 1-2-1 tent, `srcTexel` = bloomB texel ×2.0 spread, ÷16. Reads the chain input
(bloomB output).

### `post/dof.fragment.wgsl`
Role: full res.
Signed CoC: a background maps to +1, `far = smoothstep(130, 620, z)` in absolute metres
rather than focus-relative ones (a deliberate bug-fix, keep it), and
`near = smoothstep(focus·0.55, focus·0.16, z)`, giving `coc = far − near`. The radius is
`r = |coc| · maxCoc` px, with an early out below 1.5 px (the dominant branch). The gather
uses 16 taps in a golden-angle spiral (`GOLDEN = 2.39996323`,
`rr = r·sqrt((i+0.5)/16)`) with rotation from `ignPost·2π`, and each tap is weighted by its
own CoC reach: `w = clamp(|sCoc|·maxCoc − rr + 1, 0, 1)`, which prevents background bleeding
onto sharp foreground. The pass reads `sceneTex` (history[k], full res, bound explicitly)
and `depthTex`, with uniforms `invRes, enabled, focusDist, maxCoc`.

### `post/tonemap.fragment.wgsl`
Role: "composite", full res.
Order inside the pass, which is load-bearing:

1. Radial smear: 6 taps toward screen centre, gated on
   `streak = speedStreak·smoothstep(0.34, 1.05, radius)` (> 0.002), `mix(c, avg7, 0.88)`.
   Taps use explicit LOD, because a non-uniform branch forbids implicit derivatives, and
   the same rule applies in GLSL.
2. `+ shafts · shaftAmount` (radiance, additive).
3. `× exposure`.
4. `+ (bloomNear·0.35 + bloomFar·0.65) · bloomAmount`. The bloom levels are already exposed,
   which `src/shaders/post/tonemap.fragment.glsl` states directly: the prefilter applies the
   same value before thresholding, so both levels arrive in exposed units. The
   bloom-knee calibration in `src/post/postChain.ts` measures sunlit snow at ~1.26 and notes
   that at th=3.0 the field sits a stop and a half below it, which is what keeps the lit
   half of the frame under the knee.
5. Spindrift strands: angular cells (96/2π), 34% occupancy, radial dashes phase-advanced by
   time, `+ vec3(0.88,0.94,1.06)·s·streak·0.16`.
6. Contrast about middle grey in linear: `0.18·pow(c/0.18, contrast)`.
7. Tone map by `mode`. AgX uses the inset matrix `AGX_IN`, a log2 encode over EV
   −12.47393..+4.026069, the 6th-order sigmoid `agxContrast`, saturation `agxLook(v, 1.14)`
   and the outset `AGX_OUT`, then `pow(…, 2.2)` to return to display-linear; skipping the
   2.2 double-encodes and the frame goes milky. ACES uses the Narkowicz fit. Otherwise,
   clamp.
8. Vignette: `mapped *= mix(1, smoothstep(1.05, 0.35, d·1.414), 0.22)`.
9. `linearToSrgb` (exact piecewise sRGB, threshold 0.0031308).
10. Grain goes in after the encode: a hash on `uv·(1920,1080) + time·(91.7,43.3)`, giving
    `±0.5·grainAmount`.

Samplers: the chain input (dof result), `bloomNear` (bloomA output), `bloomFar` (bloomC
output) and `shaftsTex` (shafts output). Uniforms: `exposure, contrast, mode, grainAmount,
time, vignette, speedStreak, bloomAmount, shaftAmount`. GLSL care: WGSL `mat3x3f(...)`
constants list columns, and GLSL `mat3(...)` is also column-major, so copy the digits
verbatim. The per-component `select(hi, lo, c <= thresh)` becomes
`mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))))`. The output target is UNSIGNED_BYTE
and the shader does its own sRGB encode, so the Three.js renderer must NOT add another one
(`renderer.outputColorSpace = LinearSRGBColorSpace`, or render to an 8-bit RT and blit, and
keep tone mapping off via `renderer.toneMapping = NoToneMapping`).

### `post/sharpen.fragment.wgsl`
Role: full res, display-encoded 8-bit.
Contrast-adaptive sharpen: 5-tap cross, `out = clamp(c·(1+4k) − (l+r+d+u)·k, lo, hi)`
with `k = amount·0.32`, lo/hi = local min/max. Runs after the display transform on purpose.

### `lib/shadowLookup.wgsl`
Include: `snowShadowLookup`. Receiver side, compiled into consumer materials.
Every including material must declare these uniforms: `sunDir`, `cascadeMatrices: mat4[3]`,
`cascadeSplits: vec4`, `cascadeParams: vec4[3]`, `shadowTexel: f32`, `shadowSoftness: f32`,
`shadowBias: f32`, and samplers `cascade0/1/2`. It must also include `snowShading` first,
for `pcssShadow`.
- `sunShadow(world, geoN, viewDist, noiseRot)` selects a cascade by view distance with 12%
  cross-fade bands (`blendStart = split·0.88`). The last cascade fades to lit over
  `smoothstep(0.85·split2, split2, dist)`, and anything at or beyond split2 is 1.0.
- `sampleCascadeTex` rebuilds the light basis from `sunDir` and must mirror `LookAtLH`
  exactly: `lf = −sunDir`, `lr = normalize(cross(up, lf))`, `lu = cross(lf, lr)`. The
  receiver-plane gradient is `grad = clamp(−nl.xy/nl.z, ±6)`, which gives
  `planeNdcPerUV = grad·orthoWidth/depthRange`. The normal-offset bias is
  `world + geoN·texelWorld·1.5·max(sin∠, 0.2)`. Project the point and reject anything
  outside NDC or the [0,1] z range. The lookup is
  `UV = (ndc.x·0.5+0.5, 0.5 + ndc.y·0.5)`; the unflipped Y sign is a measured Babylon RTT
  artifact, since Babylon negates clip Y when rendering to RTTs. In Three.js
  render-to-texture there is no such flip, so the first-principles mapping
  `uv.y = ndc.y·0.5+0.5` (v=0 bottom) applies instead. Re-derive this once against a CPU
  readback, because this exact line cost the original a day; the symptom of getting it wrong
  is shadows sliding with camera angle and mirroring about the cascade centre.
- `pcssShadow` (in shading.wgsl) is world-unit PCSS. It runs an 8-tap blocker search over
  `maxPenumbraUV = min(24·texel, 1.8/orthoWidth)`, with the comparison depth extrapolated
  along the receiver plane (`cmp = receiverDepth + dot(off, planeNdcPerUV) − bias`, where
  `bias = biasWorld/depthRange`). The penumbra is
  `blockerDistMetres · 0.0093 · softness`, and the filter radius is clamped to
  [texel, maxPenumbra]. A 12-tap Poisson PCF is rotated by `noiseRot` per pixel, and all
  taps use `textureLod(..., 0)` against the R32F map with a regular sampler and a manual
  compare, not `sampler2DShadow`.

### `lib/atmosphere.wgsl`
Include: `snowAtmosphere`.
Covered in §1.3. The constants, the `t^2.5` distribution, `SHADOW_FILL`, grazing
desaturation, below-horizon handover, the `aerialInscatterSky` crossfade `smoothstep(0.55,
0.995, ext)`, the mip-3 near lookup and the mie g 0.62 lobe ×5.5×0.16 must all be copied
digit-for-digit. GLSL care: nothing structural, since it is pure float math plus
`textureLod`, and it needs `PI` from the noise lib.

### `lib/shading.wgsl`
Include: `snowShading`.
Mostly consumed by other subsystems' materials, but `sky.fragment` uses `wrapDiffuse`,
`snowSubsurface` and `shIrradiance`, and shadowLookup uses `pcssShadow` and the Poisson
array.
Contents: GGX D/V, Schlick F (plain + roughness-aware), `wrapDiffuse(NdotL, w)`,
`backScatter` / `snowSubsurface` (thin-edge-bright transmission, blue deep tint
`(0.55,0.72,1.0)`), `glintOctave`/`snowGlints` (world-space hashed facet sparkle),
POISSON[12], `pcssShadow`, `shIrradiance` (Ramamoorthi constants as written),
`blendNormalRNM`, `normalFromGradient`, `luma`. No WGSL-specific constructs beyond
`select` and `array<vec2f,12>`.

---

## 5. Babylon machinery → Three.js equivalents

| Babylon | Used for | Three.js WebGL2 equivalent |
|---|---|---|
| `RenderTargetTexture` on `scene.customRenderTargets` | cascades + prepass rendered automatically before the main pass, in registration order | Explicit render passes: each frame `renderer.setRenderTarget(rt); renderer.render(shadowScene_c, lightCam_c)` ×3, then prepass, then beauty. Order is just code order — simpler than Babylon. |
| `rtt.setMaterialForRendering(mesh, mat)` | per-target material override | `scene.overrideMaterial` won't work (per-mesh materials differ) — either maintain parallel `Scene`/`Group` objects sharing geometry with the depth/prepass materials, or swap `mesh.material` around the pass, or use `mesh.onBeforeRender`. Parallel groups sharing `BufferGeometry` is the clean port. |
| `rtt.renderList` | which meshes render into a target | membership of the parallel group / layer masks (`camera.layers`). |
| `Constants.TEXTURETYPE_HALF_FLOAT/FLOAT + TEXTUREFORMAT_RGBA/RED` | target formats | `WebGLRenderTarget` with `type: HalfFloatType/FloatType`, `format: RGBAFormat/RedFormat`, `internalFormat` `RGBA16F`/`R32F`. R32F needs `EXT_color_buffer_float` (WebGL2 core-ish, always request); **bilinear filtering of R32F needs `OES_texture_float_linear`** — check it, else emulate with manual 4-tap (see risks). RGBA16F is color-renderable and linear-filterable everywhere WebGL2 runs. |
| `ProceduralTexture` (+ `refreshRate = 0`, manual `.render()`, `readPixels`) | sky LUT / SH bake | Fullscreen-triangle `ShaderMaterial` → `WebGLRenderTarget`; mips via `generateMipmaps: true` + `minFilter: LinearMipmapLinearFilter` (512×256 NPOT is fine in WebGL2); readback via `renderer.readRenderTargetPixels` (Float32 from a FloatType RT). `readRenderTargetPixels` is synchronous — 64×32×4 floats is tiny, or use `readRenderTargetPixelsAsync`. |
| `PostProcess` chain (pass i renders into pass i+1's texture; `size` ratio; `_forcedOutputTexture`) | the 9-pass chain | Hand-rolled: one fullscreen triangle, one `RawShaderMaterial` per pass, explicit `WebGLRenderTarget`s sized as the table in §1.4 (allocate: sceneColor full, taa→history[2] full, shafts 1/4, bloomA 1/4, bloomB 1/16, bloomC 1/16, dof full, composite full; sharpen → canvas). Do **not** reproduce the "next pass declares my size" inversion — allocate directly. `setTextureFromPostProcessOutput` → just bind the RT's `.texture`. |
| `onApply` per-frame uniform binding | uniforms | set `material.uniforms.*.value` before each quad draw. |
| `ShaderMaterial` (WGSL, `uniforms`/`samplers` lists) | sky material, prepass/shadow caster materials | `RawShaderMaterial` (GLSL ES 3.0, `glslVersion: GLSL3`). Babylon auto-binds `viewProjection`/`cameraPosition`; in Three bind them manually (note Three's built-ins are view/projection separate; supply a `viewProjection` mat4 uniform yourself for exactness, computed from the **jittered** projection). |
| `ShaderStore` / `IncludesShadersStoreWGSL` / `#include<...>` | shader includes | your own registry: string map + `#include<name>` regex expansion before compile (Three's `ShaderChunk` can be abused, but a 20-line custom preprocessor matching `registry.ts` is cleaner). |
| Babylon **left-handed** coords, view +z forward, `LookAtLH`, `OrthoOffCenterLH(halfZRange=true)` | everything | Settled: option (a), and no conversion anywhere. The port builds the LH view and projection by hand (`src/core/mat4.ts`: `lookAtLH`, `perspectiveFovLH`, `orthoOffCenterLH`, GL clip z ∈ [-1,1]) and Three is a rasterizer only, so every `+z forward` assumption (`postCommon.viewFromDepth` builds `(…, …, 1)·z`; SSR's `R.z < 0.02`; sky vertex; shadow basis; TAA reconstruction) was ported verbatim, with `viewZ` stored as positive metres and no negation anywhere. |
| Babylon `Matrix` storage (row-vector convention: `v * M`, translation in m[12..14]) vs WGSL `uniforms.M * vec4` | matrix uploads | Babylon uploads its matrices such that WGSL `M * v` works — i.e. the GPU-side layout is column-major with translation in the 4th column, same as Three's `Matrix4.elements`. When porting `view.multiplyToRef(proj, viewProj)` note Babylon's `A.multiplyToRef(B)` = row-convention "A then B" = column-convention `B * A`; in Three: `viewProj.multiplyMatrices(proj, view)`. Same for `_lightView.multiplyToRef(_lightProj, out)` → `out = proj * view`. Jitter elements m[8], m[9] are the same slots in both (`elements[8] += jx; elements[9] += jy`). |
| NDC z ∈ [0,1] (WebGPU) | cascade fit unprojection cube, ortho `halfZRange` | WebGL2 NDC z ∈ [-1,1]: the NDC corner cube in `shadows.ts` becomes z = −1/+1, and the ortho projection should be a standard GL ortho (maps to [-1,1]) **with the shadowLookup's `ndc.z < 0 || > 1` test changed to the [0,1] remap `z·0.5+0.5`, or store depth as `gl_FragCoord.z` equivalents consistently**. Simplest: keep writing *linear or NDC* depth into the R32F color channel from the caster fragment shaders (owned by other subsystems — coordinate the convention: the maps store the same value `pcssShadow` compares against `ndc.z` after your chosen remap). Also the cascade caster fragment writes NDC z — verify against the terrainDepth shader spec (other subsystem). |
| `engine.onResizeObservable`, `setHardwareScalingLevel(1/S.resolutionScale)` | resize + render scale | `renderer.setSize`/`setPixelRatio`; resize handler must resize prepass RT + both histories and call `resetHistory()`. |
| `cam.freezeProjectionMatrix()` / `unfreeze` | jitter stability within the frame | Three doesn't auto-recompute projection unless you call `updateProjectionMatrix()` — just don't; set jitter after any FOV update in the rig and before rendering. |
| `whenReady` (pipeline pre-compile) | loading-screen warm-up | `renderer.compile(scene, camera)` / `compileAsync`, plus one warm render per RT. |
| `scene.setRenderingAutoClearDepthStencil`, renderingGroupId | sky (group 0) before terrain (group 1), transparent group 2 shares depth | Three: `renderOrder` + `renderer.autoClear` management, or explicit multi-pass render with `autoClearDepth=false`. |

---

## 6. Assets

None. This subsystem consumes no binary/texture/audio assets. Everything is
procedural (sky LUT baked at runtime; shadow maps and prepass rendered per frame; post
chain is pure math). The `.bin`/`.webp` assets in the repo belong to the model/speeder
subsystems.

---

## 7. Porting risks & gotchas
The risks are listed in ranked order:

1. Handedness / view-space convention drift (LH, +z forward, everywhere). The prepass
   stores positive view-metres; `postCommon.viewFromDepth` reconstructs with `+z=1`
   forward; SSR's `R.z < 0.02` test, its normal cross-product order, TAA's world
   reconstruction, the sky vertex trick, and the cascade fit all assume Babylon LH. Three
   is RH with −z forward. Settled: the shaders were kept verbatim. The port's view space is
   the Babylon one, `(x_right, y_up, z_forward)`, built by the hand-rolled LH matrices in
   `src/core/mat4.ts`, and `viewZ` is stored as positive metres, so there is no negation
   boundary and nothing to audit per consumer. Getting it almost right
   produces plausible-looking wrong occlusion, which is the class of bug that costs days.

2. Matrix multiplication order and layout. Babylon's `A.multiplyToRef(B, out)` is
   `out = B·A` in column-vector terms. `viewProj`, `lightView·lightProj`, and
   `invViewProj` in `shadows.ts`/`postChain.ts` all flip order under Three's
   `multiplyMatrices`. A wrong order still renders *something* (often a recognizable but
   swimming image). Also, WebGPU NDC z∈[0,1] versus WebGL z∈[-1,1] affects the cascade-fit
   corner cube, the ortho matrix (`halfZRange`) and shadowLookup's `ndc.z` range test, and
   all three must change together.

3. Shadow-map Y orientation. The `uv.y = 0.5 + ndc.y·0.5` line in `shadowLookup.wgsl`
   compensates a Babylon-specific RTT clip-Y flip that Three does not have. Blind copying
   mirrors every lookup about the cascade centre; symptom is shadows sliding with camera
   angle/zoom. Re-derive with a CPU readback of cascade 0 exactly as the original did
   (the comment documents the measurement method). Same class of check for post-pass
   `vUV` vs `sunUV` orientation in shafts.

4. R32F linear filtering for PCSS. Cascades are FloatType and bilinear. In WebGL2 that
   requires `OES_texture_float_linear`, which is widely available on desktop but not
   guaranteed, and is absent on some mobile GPUs. The fallbacks are half-float maps,
   where precision is fine because depth is 0..1 NDC over a few hundred metres, or NEAREST
   sampling with slightly noisier PCSS accepted, since the 12-tap rotated Poisson already
   dithers. Settled: the port probes `OES_texture_float_linear` once at boot and warns
   ("[snowflow] float32-filterable unavailable; height will step") rather than failing, and
   `EXT_color_buffer_float` is a hard boot requirement (`src/core/gfx.ts`): the prepass
   RGBA16F, LUT RGBA16F mipped, SH RGBA32F readback and all post RTs RGBA16F need it.

5. TAA jitter must reach every pass identically. The jitter is written into the
   projection matrix that the depth prepass, shadow-consumer beauty materials and the
   composite all render through, and then frozen. In Three, any code path that calls
   `camera.updateProjectionMatrix()` mid-frame (the rig FOV-with-speed does!) silently
   removes the jitter for later draws, and the resolve then integrates two samplings, which
   is visible as permanent 1px shimmer. Apply the jitter in `post.update` after the rig
   writes FOV, ensure nothing touches the projection until frame end, and feed the
   unjittered `prevViewProj` and reconstruction (`ndc − jitterNdc`) exactly as written.

6. Double sRGB / tonemap interference. `tonemap.fragment` outputs already-sRGB-encoded
   8-bit values, and AgX needs its internal `pow(2.2)`. Three's default
   `outputColorSpace = SRGBColorSpace` on the canvas, plus any `renderer.toneMapping` other
   than `NoToneMapping`, will double-transform. Render the composite to a plain 8-bit RT
   (or to the canvas with LinearSRGB output and NoToneMapping) and keep sharpen operating on
   encoded values.

7. Sky bake orientation and SH readback row order. `latLongToDir` puts the zenith at
   v=0, and `projectSH` assumes readback row 0 is the zenith. Babylon's ProceduralTexture UV
   and `readPixels` row order differ from a naive Three fullscreen quad plus
   `readRenderTargetPixels`, which is bottom-up. A flipped hemisphere gives subtly wrong
   ambient (ground-colored sky light) that still appears to work, so validate
   `_irradianceUp()` against a hand-computed value after the first bake, and validate the
   LUT with the horizon at v≈0.5. Also keep the async multi-pass `solve()` loop (3
   iterations plus a final bake) and only rebake on actual sun movement, since the bake is
   512×256×(32×8) samples and must never run per frame.

8. The forced-output and history ping-pong. Reproduce the effect rather than the Babylon
   mechanism: TAA writes a persistent full-res history[k]; bloomA and dof sample
   history[k]; TAA samples history[1−k]; the `historyValid` ramp is two frames 0→0.5→1; and
   the buffers reset on resize and teleport. Sampling a texture that is bound as the current
   framebuffer is UB in WebGL2, so the ping-pong is mandatory rather than stylistic.

9. Pass early-outs and loop hygiene. Every pass stays attached and early-outs in shader
   when disabled (`enabled < 0.5` becomes a copy). Keep that behavior, because it means
   toggling settings never reallocates the chain. Keep `textureLod` (explicit LOD) inside
   non-uniformly branched loops such as the streak smear and SSR march, since
   implicit-derivative sampling there is UB in GLSL too. Keep the NaN guard as `isnan()`,
   not `raw != raw`, because a vector `!=` in GLSL is a scalar aggregate comparison.

10. Prepass NEAREST plus a separate depth buffer. The prepass needs its own depth
    attachment, because it is a beauty-parallel rasterization rather than a copy, and it must
    be sampled NEAREST. In Three, use a `WebGLRenderTarget` with `depthBuffer: true` and
    `min/magFilter: NearestFilter`, cleared to `(9000, 0, 0, 1)` via
    `renderer.setClearColor` with a float clear on the half-float target (which works in
    WebGL2). Remember that `POST_FAR` must stay 9000 in GLSL.

11. Uniform array plumbing. `shR: vec4[9]`, `cascadeMatrices: mat4[3]` and
    `cascadeParams: vec4[3]` are plain uniform arrays in consumer materials. Three supports
    these, but `uniforms.shR = { value: Float32Array(36) }` will not auto-map to vec4[];
    use arrays of `Vector4`/`Matrix4`, or a UBO via `UniformsGroup`. Settled: plain uniform
    arrays, shared across the terrain, character and post materials; no `UniformsGroup`.
