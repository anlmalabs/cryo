# Porting spec: `character` subsystem
Babylon.js/WebGPU → Three.js/WebGL2.

Source files (do not modify): `build.ts` (procedural geometry for body, fur shells and
the cloth render mesh), `character.ts` (orchestrator owning meshes, materials, the
transform texture and uniforms), `cloth.ts` (verlet garment sim on the CPU),
`controller.ts` (locomotion physics for walk and surf plus gait events), `figure.ts`
(skeleton, bind pose and procedural locomotion/IK posing on the CPU), and
`snowContact.ts` (writes deformation brushes and spray from locomotion state).

Shaders: `src/shaders/char.vertex.wgsl`, `char.fragment.wgsl`, `charDepth.vertex.wgsl`,
  `charPrepass.vertex.wgsl`, `cloth.vertex.wgsl`, `clothDepth.vertex.wgsl`,
  `clothPrepass.vertex.wgsl`, `fur.vertex.wgsl`, `fur.fragment.wgsl`,
  `src/shaders/lib/charSkin.wgsl` (shared include `snowCharSkin`)

---

## 1. Purpose & behavior

The character subsystem is the playable figure: a ~1.79 m hooded, robed
snow-bender that walks, runs, and snow-surfs across the procedural terrain.
There are no authored assets here, which counts as a central constraint: no rig
file, no animation clips, no meshes and no textures. Everything is procedural.

### 1.1 Locomotion

`CharacterController` integrates a 2D velocity on the terrain heightfield with two
blended modes.

Locomotion modes

| Mode | Behaviour |
|---|---|
| WALK | Camera-relative WASD. Walk 2.5 m/s, sprint 5.4 m/s, accel 26 m/s², decel 30 m/s², facing eased toward travel direction (`angleDamp` rate 11). |
| SURF | Momentum-carrying board mode (toggled by `input.surf`). Thrust 11 m/s² along facing, top speed 19.5 m/s (×1.95 boost while sprint held), turn rate 2.35 rad/s, lateral grip 7.5/s with residual drift, quadratic drag, slope assist `-(n·fwd) * 26`. When `S.speeder !== false` the surf step becomes the flying-speeder variant: A/D steers outright, camera yaw is dragged along, W gives throttle-gated thrust, S reverse-brakes. |

Blending and derived state:

- `surf` blend eased via `expDamp` (in-rate 2.6, out-rate 3.4). Position `y`
  snapped softly to `terrain.heightAt` (rate 26).
- Derived signals: `speed`, `speed01` (clamped speed/19.5), `speedRaw`,
  `acceleration`, `lean` (lateral accel / 26 clamped, ×(0.35+0.65·surf), damped
  6.5), `carve` (same target, damped 9),
  `streak01 = surf * clamp((speed-7)/11, 0, 1)`.
- Distance-driven gait: `gaitPhase` advances by
  `dist / (1.55 * (0.72 + 0.28 * min(1, speed/5.4)))` per frame, so stride
  length equals ground speed by construction and there is no foot sliding.
  Footfall events fire at phase 0.0 (left) and 0.5 (right). `stepping` is false
  while surfing or above 1.2× run speed (glide). `footfall/footIndex/footPos/
  footImpact` are one-frame event outputs.

### 1.2 Figure posing
Entry point: `Figure.update(dt, controller)`.

The figure poses an 18-bone skeleton every frame entirely from controller state.

- Foot planting is exact: on entering stance a foot's world position is
  recorded in `plant` and held fixed; the leg reaches it with analytic
  two-bone IK (thigh 0.44 m, shin 0.37 m; reach clamped to 99.5% to avoid
  knee lock). Swing interpolates plant→next-plant on a smoothstepped arc
  with a sine lift (0.055 + 0.12·run). Duty factor `0.66 - 0.20*run`.
  Surf blends both feet onto board positions (lateral ±0.17, along ±0.11).
- Body attitude: pitch into acceleration (clamped fwdAcc −9..22, ×0.012,
  plus 0.10·run, plus surf crouch terms), roll from `lean`, pelvis bob at
  2× stride frequency, crouch, snow `sink` (damped toward 0.045+0.055·surf).
  Pelvis yaw counter-twists ±0.13·run·sin(2π·phase) against the chest
  (chest twist = −1.5×). Head counter-pitches −0.62× chest pitch (head
  stabilisation); the hood is a lagged copy of the head (yaw damp 11,
  pitch damp 9).
- Arms: two-bone IK (upper 0.28 m, fore 0.26 m) to a target blending walk
  swing (counter-phase to legs), a cast pose (reads `ch.cast`,
  `ch.castAim{X,Y,Z}` written by the spell system; right hand leads), and a
  surf pose (arms out/forward, trailing arm rises with carve). Elbow pole
  back-and-out.
- Output per bone: `world` (4×4), `skin = world * invBind` (what geometry is
  skinned by), `joint` (world joint positions, which cloth collision reads).
  Bone local +Y runs joint→child; frames built by `setFrameFromDir` from
  position + Y axis + Z (front) reference; X = Y×Z.
- `handPosition(which, out, od)` returns the hand world position (offset
  (0, 0.09, 0) through the hand bone) for spell emitters.
- One-frame flags `touchdown[2]` fire on plant; `snowContact` consumes them.

### 1.3 Cloth simulation

The solver (`ClothSolver`, CPU, zero-alloc) carries four garment panels, each a closed tube of verlet particles:
robe (36×12 grid), mantle (28×7) and two sleeves (10×8). Every particle stores a
bind position, one bone, and a `pinRate` measured in 1/second, where `Infinity`
means welded to the skinned target and small values act as shape memory.

Each step runs in this order:

1. Kinematic targets: bind position pushed through the bone's skin matrix.
2. Verlet integration with gravity (−9.81) and apparent wind, meaning field
   wind minus character velocity, with a wandering bearing of ±11°, a 4-octave
   gust envelope from 0.2× to 1.8×, and a vertical updraught term. The wind term
   uses quadratic drag `0.085*|w|`. Per-particle hashed turbulence adds a floor of
   `(0.18 + drag*0.25) * S.windStrength`, and velocity is damped by `0.90^(60h)`.
3. 6 Gauss–Seidel iterations of anchor pull (`(1-exp(-rate*h))/6` per
   iteration) plus distance constraints (ring, vertical, and soft bending two
   rows apart, with stiffness 0.22 applied on the last 3 iterations only).
4. Capsule collision against 9 body capsules (masked per panel) and, for panels
   with `groundRows`, a terrain clamp at `heightAt + 0.012`.

Sub-steps are 2 when dt > 1/55, and the step is capped at 1/30. Rest lengths are
measured from the bind pose, which contains authored pleats (3 incommensurate
sine frequencies) and an asymmetric hem that runs high in front and trails
behind. On the very first update, `Character._settleCloth()` teleports all
particles to their skinned targets so no visible settling from the origin occurs.

### 1.4 Rendering: three meshes, seven pipelines, one texture

Mesh inventory

| Mesh | Shape | Notable attributes |
|---|---|---|
| `charBody` | ~lofted tubes: torso, belt, neck, head, scarf, Bezier-swept hood, arms, mitt hands, legs, boots | `position` (bind-pose world), `normal` (area-weighted smooth), `uv` (metres of surface, not normalized), `aux` = (materialSlot, bakedAO), `boneIdx` (vec4, only .xy used), `boneWt` (vec4, only .xy used, so a 2-influence LBS) |
| `charCloth` | garment surface | `position` = (u, v, panelIndex) with *no actual positions*; `uv` = weave metres; `aux` = (matId, ao lerped aoTop→aoBottom) |
| `charFur` | shell fur for hood rim (26 cols × 22 shells) and two cuffs (12 cols × 18 shells) | Each shell is an independent sheet with the offset baked into positions; `normal` = shell direction, `aux` = (shellParam t∈[0,1], ao), single-bone rigid |

Cloth render tessellation (72×32 robe, 64×22 mantle, 26×20 sleeves) is decoupled
from the sim grids; the vertex shader reconstructs the surface with bicubic
Catmull-Rom over the panel's node rectangle in `charTex`, deriving position,
normal and tangent from the same 16 taps. The fur fragment shader alpha-tests a
hashed strand field (discard), producing tapering strands of varying length.

Transform texture (`charTex`): a 48×64 RGBA32F, NEAREST, CLAMP raw texture,
staged in one `Float32Array(48*64*4)` and uploaded once per frame. Rows 0–3
hold bone skin matrices (texel (b, c) = column c of bone b's `world*invBind`;
18 bones used of 48 columns). Rows 4+ hold cloth node world positions, one
rectangle per panel (robe rows 4–15, mantle 16–22, sleeve0 23–30, sleeve1
31–38; w component = 1). This texture is the ONLY per-frame GPU data path, so
there are no matrix uniforms and no vertex uploads.

Shared mesh flags for all three meshes: `renderingGroupId = 1` (opaque scene), an
identity world matrix forever (`freezeWorldMatrix`), and
`alwaysSelectAsActiveMesh = true` because the bounding info is meaningless and
frustum culling must be disabled. Back-face culling is off on all of them;
the fragment shader flips N toward the viewer instead.

Casters: body and cloth render into shadow cascades 0 and 1 only
(`CHAR_CASCADES = 2`) with dedicated depth vertex shaders that share the same
skinning / Catmull-Rom include, and into the camera depth prepass. Fur casts
nothing and is absent from the prepass (deliberate).

Material palette: 8 slots × (rgb albedo, roughness) plus 8 slots × (sheen,
anisotropy, transmission, weaveDepth), uploaded as two `vec4[8]` uniform arrays.
The values live in `character.ts` PALETTE/PARAMS and must be copied verbatim;
they are tuned against the AgX tonemap (the `S.tonemap` default in
`src/core/settings.ts`) and the warm sun at the `S.sunElevation` default of 13
degrees.


### 1.5 Snow contact
Entry point: `SnowContact.update(dt)`.

`SnowContact` translates locomotion into `terrain.deform.brush(...)` calls and
spray particle emission.

Brush recipes

| Brush | Trigger | Parameters |
|---|---|---|
| Footfall splat | `figure.touchdown[i] && ch.stepping` | Elongated (1.7×) yawed boot brush at the *planted* position: width 0.10, depth `0.17 + 0.14*impact`, berm `0.10 + 0.08*impact`, compression 0.9, rim roughness 1.0, with `impact = min(1.3, 0.35 + speed/5.4)` |
| Footfall `_kick` | same | 6+⌊impact·14⌋ spray grains thrown up-and-backward, 22% of them heavier "clods" |
| Walk scuff | `surf < 0.98` and speed > 0.25 | Shallow brush at the body position scaled by *distance moved* (k = min(moved, 0.35)): radius 0.22, depth 0.20k·w, berm 0.22k·w, compression 0.8k·w, elong 1.5 |
| Surf wake | `surf > 0.02` | Three brushes per frame: a deep groove of width 0.30·(1+0.35·fast), depth 1.20k, compression 4.0k, elong 2.6, offset toward the lean ×0.12; plus two berm-only brushes offset ±SURF_WIDTH·(1.5+0.5·fast) laterally and weighted `0.5 ± lean*0.5` |

The surf-wake weighting matters because it makes the outside of a turn throw more,
with the left berm getting `sideL = 0.5 + lean*0.5`.

### Per-frame order
From `main.ts`; the order must be preserved.

```
controller.update(dt, rig)          // physics first
heightfield.clampToPlayArea(pos)
character.update(dt):               //  = Character.update
    figure.update(dt, controller)   //  pose skeleton
    [first frame: settleCloth]
    solver.update(dt, figure, ch)   //  cloth after skeleton
    uploadTransforms → charTex      //  ONE texture upload
contact.update(dt)                  // reads figure.touchdown + plant
... rig.update, post.update, sky, shadows.update (cascade refit) ...
character.sync(cameraPos)           //  = Character.sync → _pushUniforms
                                    //  AFTER shadow refit (fresh cascade
                                    //  matrices) and camera move
scene.render()
```

`update` and `sync` are deliberately split. Transforms must exist before the
contact system reads the feet, and uniforms must be pushed after the cascades
refit, or shadows lag the figure by one frame during fast carves.

When `S.speeder === true` ("FLYING"), the figure is hidden via
`figure.setVisible(false)` but still simulated every frame, since the speeder
reads the same controller. Spells and wake are disabled in that mode.

---

## 2. Public API

### 2.1 `CharacterController`
Source: `controller.ts`.

| Member | Contract |
|---|---|
| `new CharacterController(terrain)` | terrain must expose `heightAt(x,z):number` and `normalAt(x,z,outVec3)` |
| `update(dt, rig)` | rig must expose `getFlatForward(v)`, `getFlatRight(v)`, `yaw` (read/write in speeder mode), `addTrauma(x)` |
| Read state | `position:Vector3`, `velocity`, `prevVelocity`, `acceleration`, `facing` (yaw rad), `speed`, `speed01`, `speedRaw`, `surf` (0..1), `surfActive`, `lean`, `carve`, `streak01`, `gaitPhase`, `stepping`, `footfall`, `footIndex`, `footPos:Vector3`, `footImpact`, `groundY`, `groundNormal:Vector3` |
| Written by spell system | `cast` (0..1), `castAimX/Y/Z` |
| Module exports | `angleDelta(a,b)`, `angleDamp(cur,target,rate,dt)` |
| Settings read | `S.speeder`, plus `input.moveX/moveZ/sprint/surf` from `core/input.ts` |

### 2.2 `Figure`
Source: `figure.ts`.

| Member | Contract |
|---|---|
| Exported constants | bone index constants `B_ROOT..B_FOOT_R`, `BONE_COUNT` (18), `HIP_HEIGHT` (0.95) |
| `new Figure(terrain)` | construct against the terrain heightfield |
| `update(dt, controller)` | poses everything; caps h at 1/30 |
| State read by others | `skin:Float32Array(18*16)` (column-major, translation at indices 12–14), `world`, `joint:Float32Array(18*3)`, `plant:Float32Array(6)`, `footPos`, `footWeight:Float32Array(2)`, `touchdown:[bool,bool]`, `sink` |
| `handPosition(which, out, offset)` | used by the spell system |

### 2.3 `cloth.ts`

`ClothPanel` is spec-constructed with the fields `name, cols, rows, matId,
renderCols, renderRows, weaveU, weaveV, aoTop, aoBottom, collide, groundRows,
nodeRow, count, bindPos, pos, prev, target, bone, pinRate, restU, restV, restB`,
and a `finalise()` method.

| Member | Contract |
|---|---|
| `makePanels()` | returns `[robe, mantle, sleeve0, sleeve1]` |
| `new ClothSolver(panels, terrain)` | construct, then `update(dt, figure, controller)` |
| Settings read | `S.windDirection` (degrees), `S.windStrength` |

### 2.4 `build.ts`

Exports the material slot constants `M_ROBE=0, M_MANTLE=1, M_TUNIC=2,
M_LEATHER=3, M_SKIN=4, M_TRIM=5, M_FUR=6`, plus:

| Member | Contract |
|---|---|
| `buildBody(scene)` | body mesh with `metadata.triangles/vertices` |
| `buildFur(scene)` | shell-fur mesh with `metadata.triangles/vertices` |
| `buildClothMesh(scene, panels)` | cloth mesh with `metadata.triangles/vertices` |
| `hoodRimPoint(s, out)` | exported curve sample; fur reuses the hood rim curve |

### 2.5 `Character`
Source: `character.ts`.

| Member | Contract |
|---|---|
| `new Character(scene, terrain, sky, shadows, controller)` | top-level orchestrator |
| `registerPrepass(depthPass)` | registers body and cloth into the depth prepass |
| `update(dt)` | runs figure, settle-once, cloth, then the charTex upload |
| `sync(cameraPos)` | per-frame uniform push (see §3 for exact uniforms) |
| `setVisible(bool)`, `warmUp()`, `dispose()` | visibility, async pipeline compilation, teardown |
| Public fields | `triangles` (number, for the stats overlay), `figure`, `charTex`, `bodyMat/clothMat/furMat`, `bodyMesh/clothMesh/furMesh` |

Settings read, with defaults from `src/core/settings.ts`: `S.showCharacter` (bool,
default true), `S.windDirection`, `S.windStrength`, `S.fogDensity` (0.0072),
`S.fogHeightFalloff` (0.045), `S.fogStart` (24), `S.aerialStrength` (1.0),
`S.ambientIntensity` (1.0), `S.sssStrength` (1.0).

Constants pushed in `sync`: `shadowSoftness=1.4`, `shadowBias=0.012` (tighter
than terrain's so the boots carry a contact shadow), `weaveDensity=210`
(threads/m), `furDensity=250`, `furColor=(0.74,0.755,0.795)`, `furDroop` = wind
plus gravity plus a reversed accel vector (see `_pushUniforms`), and `screenSize`
= render size.

### 2.6 `SnowContact`
Source: `snowContact.ts`.

| Member | Contract |
|---|---|
| `new SnowContact(controller, deformField, figure?, sprayField?)` | `deformField` must expose `brush(x, z, radius, depth, berm, compression, ice, yaw, elongation, rimRoughness)`; `sprayField` must expose `emit(x,y,z, vx,vy,vz, size, life, clod)` |
| `update(dt)` | per-frame brush and spray emission |

### Construction/wiring
From `main.ts`.
```js
const character = new CharacterController(terrain);
const figure = new Character(scene, terrain, sky, shadows, character); // "figure" var
figure.registerPrepass(depthPass);
const contact = new SnowContact(character, terrain.deform, figure.figure, spray);
spells.addConsumers(figure.bodyMat, figure.clothMat);  // spell lights
// warm-up: figure.update(0); figure.sync(camPos); await figure.warmUp();
```

---

## 3. Data flow
Cross-subsystem.

Produced by this subsystem:

| Thing | Format / shape | Consumers | Updates |
|---|---|---|---|
| `charTex` | 48×64 RGBA32F texture, NEAREST/CLAMP | all 7 character pipelines only (internal), but is *the* CPU→GPU path | 1 full upload per frame in `Character.update` |
| `controller` state (`position, velocity, speed01, speedRaw, surf, carve, lean, streak01, facing`, …) | JS object | camera rig, post chain (streaks/FOV), surf wake, spray, spells, speeder, overlay | `controller.update` each frame |
| `figure.joint`, `figure.skin` | Float32Arrays | cloth solver (internal), spell system (`handPosition`) | `figure.update` |
| `figure.touchdown` + `figure.plant` | one-frame flags + positions | `SnowContact` → deformation field + spray | `figure.update` |
| deformation brushes | calls to `terrain.deform.brush(...)` | terrain deformation sim | `contact.update` each frame |
| spray emissions | calls to `spray.emit(...)` | vfx particle field | on footfalls |
| depth-prepass draws (body, cloth) | writes (viewZ, mask=0) into DepthPass RTT (RGBA16F) | post chain (TAA/DoF/etc.), reflections | every frame via depthPass render list |
| shadow-cascade draws (body, cloth) | NDC depth as R32F color into cascades 0,1 | every shadow-receiving material | every frame |

Consumed from other subsystems:

| Thing | Source | Used as |
|---|---|---|
| `terrain.heightAt(x,z)`, `normalAt(x,z,out)` | terrain | ground snap, foot plants, cloth ground clamp, slope assist |
| `terrain.deform` | terrain | brush target |
| `sky.lut` | Sky | sampler `skyLUT` (lat-long radiance LUT, mipmapped; sampled at `sqrt(rough)*6` mip) |
| `sky.sunDir:Vector3`, `sky.sunRadiance:Color3`, `sky.sh` (Float32Array 9×vec4) | Sky | uniforms `sunDir`, `sunRadiance`, `shR[9]` |
| `shadows.maps[0..2]` | ShadowSystem | samplers `cascade0/1/2` (2048² R32F color RTTs) |
| `shadows.matrixData` (48 floats), `splits` (4), `paramData` (12), `texelSize` | ShadowSystem | `cascadeMatrices[3]`, `cascadeSplits`, `cascadeParams[3]`, `shadowTexel` |
| `shadows.registerCaster(mesh, makeMaterial(cascade), 2)` | ShadowSystem | per-cascade depth material factory; each cascade gets its own material instance holding its own `lightViewProjection` |
| `depthPass.registerCaster(mesh, material)` | DepthPass | prepass registration |
| spell lights: uniforms `spellLightPos[4]` (xyz+radius), `spellLightCol[4]` (rgb+intensity), `spellLightCount` (float) | SpellSystem via `addConsumers(bodyMat, clothMat)` | additive lighting in char fragment |
| `ch.cast`, `ch.castAimX/Y/Z` | SpellSystem writes onto controller | arm posing |
| `input` struct (`moveX, moveZ, sprint, surf`) | core/input | controller |
| `rig` (camera) | core/camera | flat fwd/right, yaw, trauma |
| Settings `S.*` keys listed in §2 | core/settings | live-tunable |

---

## 4. Shader inventory

All character WGSL uses Babylon's WGSL ShaderMaterial conventions:
`attribute/varying/uniform` declarations are preprocessed into structs;
uniforms live in a generated UBO addressed as `uniforms.<name>`;
`vertexInputs/vertexOutputs/fragmentOutputs`; `#include<name>` pulls from
`ShaderStore` (registered in `src/shaders/registry.ts`, key `snowCharSkin` →
`lib/charSkin.wgsl`). Port all of this to raw GLSL ES 3.0 with explicit
`in/out/uniform` and manual includes (string concat).

### 4.1 `lib/charSkin.wgsl`
Role: include, vertex-stage library.

| Function | Behaviour |
|---|---|
| `skinPoint1/skinDir1` | Fetch bone matrix columns with `textureLoad(tex, vec2i(bone, row), 0)`, an integer texel fetch; in GLSL this is `texelFetch(charTex, ivec2(b, row), 0)`. The texture must be float-sampleable and un-filtered, which RGBA32F plus NEAREST satisfies in WebGL2 without `OES_texture_float_linear`. |
| `skinPoint(idx, wt, p)` | 2-influence LBS, normalized by `wt.x+wt.y`; `skinNormal` does the same for directions plus normalize. `boneIdx` arrives as vec4f and is cast `i32(idx.x)`, so keep attributes float in GLSL and cast with `int()`. |
| `clothNode(rowBase, cols, rows, i, j)` | Texel fetch with wrapped u (`(i % cols + cols) % cols`) and clamped v. GLSL `%` on negative ints is implementation-consistent in ES 3.0 for int ops, but keep the double-mod exactly as written. |
| `crBasis/crDeriv` | Catmull-Rom weights and derivative. |
| `sampleCloth(rowBase, cols, rows, u, v)` | 16 texel fetches give position, d/du and d/dv; `nrm = normalize(cross(pv, pu))` and `tanU = normalize(pu)`. Returns a struct, which GLSL ES 3.0 supports directly, or return via out params. |

### 4.2 `char.vertex.wgsl`
Role: body beauty pass.

Skins position and normal from `charTex`. Varyings are `vWorld, vNormal, vUV,
vAux, vViewDist` (the last equals `distance(world, cameraPos)`), and
clip = `viewProjection * world`. Uniforms: `viewProjection: mat4`,
`cameraPos: vec3`.

### 4.3 `cloth.vertex.wgsl`
Role: garment beauty pass.

`position.xyz = (u, v, panelIndex)`, and the shader looks up
`panelParams[i32(position.z)]` (a uniform `vec4[6]` holding rowBase, cols, rows,
0) before calling `sampleCloth`. It emits the same varyings as `char.vertex`, so
both share one fragment shader (`char.fragment`). Dynamic uniform-array
indexing by a value derived from an attribute is legal in GLSL ES 3.0 for
uniform arrays, since a constant index is not required, but keep the index
clamped 0–5 for safety.

### 4.4 `char.fragment.wgsl`
Role: shared body and cloth fabric BRDF.

Technique per fragment:

Surface normalisation and slot lookup

1. Two-sided normal: flip N if `dot(N,V)<0`, since winding is not trusted. Keep
   `geoN` (the pre-weave flipped normal) for the shadow lookup.
2. Material slot `clamp(i32(vAux.x + 0.5), 0, 7)` indexes `matAlbedo[8]`
   (rgb+roughness) and `matParams[8]` (sheen, aniso, transmission, weaveDepth).

Procedural surface detail

3. Procedural weave: a screen-space cotangent frame from `dpdx/dpdy` of
   world pos and of `wuv = vUV * weaveDensity` (GLSL: `dFdx/dFdy`, requiring
   `precision highp`). The weave normal is crossed cosine ridges with over/under
   alternation (`smoothstep(-0.35,0.35, warp*weft)`) and a cavity term, faded by
   pixel footprint `1 - smoothstep(0.10, 0.45, max(len(duv1),len(duv2)))`.
4. Slub: `noise2(vUV * vec2(9, 26))` modulates albedo ±10% and roughness.
5. AO equals baked vertex AO × weave cavity.

Direct lighting

6. Sun: shadow via
   `sunShadow(world, geoN, vViewDist, ign(fragCoord)*2π)` (a shared PCSS
   cascade lookup include, gated `NdotL > -0.4`); diffuse =
   `wrapDiffuse(NdotL, 0.18) * albedo/π * sunRadiance * shadow`.
7. Transmission (if the slot has it):
   `backScatter(N,L,V, 0.4, 4.0, 1.0) * albedo * transmit * sssStrength *
   mix(0.35, 1.0, shadow)`.
8. Anisotropic GGX spec: Burley remap `ax = a(1+aniso), ay = a/(1+aniso)`
   with `a = max(0.04, rough²)`, T and B taken from the cotangent frame,
   `visSmithGGXCorrelated`, F0 = 0.035.
9. Charlie sheen: `dCharlie(NdotH, 0.42)` × `vAshikhmin`, with the lobe
   clamped to 0.25, gated by grazing factor `0.16 + 0.84*(1-NdotV)²`, and tint =
   `mix(white, normalize(albedo), 0.35)`.

Ambient, spells and output

10. Ambient: SH irradiance (`shIrradiance(N, shR)`, 9 vec4 coefficients) ×
    `ambientIntensity`, plus a snow-bounce term (0.40 × the up-facing-down
    factor of horizontal SH), plus rim ambient sheen `(1-NdotV)^4 * sheen * 0.55`,
    plus ambient specular = `textureSampleLevel(skyLUT, dirToLatLong(R),
    sqrt(rough)*6)` × Karis `envBRDFApprox(0.035, rough, NdotV)`. In GLSL that
    sample becomes `textureLod`, which requires the LUT to be mipmapped.
11. Spell lights: `spellLightingSurface(...)` over up to 4 point lights, ×ao.
12. `applyAerial(...)` for fog and aerial perspective (a shared include that
    samples skyLUT).
13. Output opaque `vec4(color, 1)` to the HDR scene target. Blend is none
    (opaque) and depth test/write stay standard.

Notes on this stage:

- `screenSize` uniform is declared but unused in the fragment body; keep it or
  drop it, noting that dropping changes the UBO layout only.
- WGSL→GLSL conversions: `inverseSqrt` becomes `inversesqrt`;
  `mat3x3f(c0,c1,c2)` becomes `mat3`; array uniforms (`array<vec4f,8>`,
  `array<mat4x4f,3>`) become `uniform vec4 matAlbedo[8]` and so on. With
  RawShaderMaterial these are plain uniform arrays, so no UBO is needed (or use
  a UBO to match the original layout). `let/var` becomes `const` and mutable
  declarations respectively; `select` and `if` port directly; `const INV_PI`
  inside a function moves to a global `#define`.

### 4.5 `fur.vertex.wgsl`

Single-bone skin (`skinPoint1/skinDir1` on `boneIdx.x`), with the shell offset
already baked into position. It adds `furDroop * t²` in world space, where
t = `aux.x` is the shell parameter, and the quadratic makes strands curve rather
than shear. Varyings match those of `char.vertex`.

### 4.6 `fur.fragment.wgsl`

Alpha-tested shell fur on an opaque pipeline, using `discard`.

Strand field

Strand field: `g = vUV * furDensity` and `cell = floor(g)`. Hashes `hash21` and
`hash22` give the per-cell strand length `0.30 + 0.70*h` (discard when
`t > strandLen`), a jittered axis, and radius `0.46 * (0.55 + 0.45*hash) *
sqrt(taper)` where `taper = 1 - t/strandLen` (discard when outside).

Shading and cost

- Two-sided N, PCSS shadow, self-AO down the stack `0.16 + 0.84* depth²`
  (where depth = t/strandLen), `wrapDiffuse(NdotL, 0.65)`, strong transmission
  `backScatter(N,L,V, 0.5, 3.0, 1.0) * 0.85`, a dim wide GGX
  (`distributionGGX(NdotH, 0.75) * 0.05`), SH ambient × `vAux.y * 1.4`, and
  aerial perspective. Uniforms are `furColor` (vec3) and `furDensity` (float).
- 22 shells × discard: in WebGL2 `discard` disables early-Z on those draws, and
  the fur is drawn in the beauty pass only (no prepass, no shadow), so the cost
  stays contained. Keep it that way.

### 4.7 `charDepth.vertex.wgsl` / `clothDepth.vertex.wgsl`
Role: shadow casters.

These use the same skinning and Catmull-Rom reconstruction as the beauty path,
through the shared include, which must stay shared in the port since
divergence causes peter-panning. Uniform `lightViewProjection: mat4` is per
cascade; Babylon forces distinct Effects via `defines: ["CHAR_CASCADE n"]`, while
in Three.js you create one material instance per cascade, or one material whose
uniform you rewrite between cascade renders. The fragment stage is
`terrainDepth.fragment.wgsl`, which writes `gl_FragCoord.z` (WGSL
`input.position.z`) into an R32F color attachment, because cascades are
color targets so PCSS blocker search can filter; port it as a
`WebGLRenderTarget` with `RedFormat`/`FloatType` and a depth renderbuffer.

Note WebGPU NDC z is [0,1] while Three/WebGL is [-1,1]. The shadow system
already accounts for this on the matrix side (see its own spec), so keep the
convention consistent with the ported ShadowSystem.

### 4.8 `charPrepass.vertex.wgsl` / `clothPrepass.vertex.wgsl`
Role: depth prepass.

Same skinning and reconstruction, with varyings `vViewZ = clip.w` (linear view
depth) and `vMask = 0.0`. The fragment stage is the shared
`prepass.fragment.wgsl`, which writes `vec4(viewZ, mask, 0, 1)` into the
DepthPass RTT (RGBA16F).

### 4.9 WGSL constructs needing care
Summary.

| Construct | Port |
|---|---|
| `textureLoad` | `texelFetch` (int coords, explicit lod 0). All charTex reads are unfiltered fetches, and the sampler declared alongside (`charTexSampler`) is never used. Do not bind a filtering sampler to an RGBA32F texture in WebGL2, since it is unfilterable without an extension; use NEAREST. |
| Integer ops | Bone index and panel index arrive as floats and are cast; the double-mod for wrap must survive; `i32()` becomes `int()`. |
| Textures and compute | No storage textures, no textureGather and no compute; everything is vertex-fetch plus fragment. |
| Derivatives | `dpdx/dpdy` becomes `dFdx/dFdy`, standard in ES 3.0. |
| Struct returns | Struct-returning functions (`ClothSample`) are fine in ES 3.0. |
| Loops | Loops in `sampleCloth` are fixed-count (4×4), which is fine. |
| Discard | Used in fur only. |
    `panelParams[6]`, `spellLightPos[4]` and `spellLightCol[4]`. |

---

## 5. Babylon-specific machinery → Three.js equivalents

| Babylon | Used for | Three.js WebGL2 equivalent |
|---|---|---|
| `ShaderMaterial` with `shaderLanguage: WGSL`, named attribute/uniform/sampler lists | all 7 pipelines | `THREE.RawShaderMaterial` (GLSL ES 3.0, `#version 300 es` via `glslVersion: THREE.GLSL3`) with explicit `uniforms` dict; custom attributes on `BufferGeometry` |
| `ShaderStore` `#include<snowCharSkin>` etc. | shared skinning code | JS template-string include (prepend lib source), keep ONE source of truth shared by beauty/depth/prepass shaders |
| `RawTexture.CreateRGBATexture(..., TEXTURE_NEAREST, TEXTURETYPE_FLOAT)` + `charTex.update(data)` | transform texture | `THREE.DataTexture(data, 48, 64, RGBAFormat, FloatType)`; `magFilter=minFilter=NearestFilter`, `wrapS/T=ClampToEdgeWrapping`, `generateMipmaps=false`; per frame mutate the backing array and set `needsUpdate = true` (uploads via texSubImage2D) |
| `mesh.setVerticesData("aux", data, false, 2)` etc. | custom attributes | `geometry.setAttribute("aux", new BufferAttribute(f32, 2))`, same for `boneIdx`(4), `boneWt`(4); indices `Uint32Array` → `geometry.setIndex` (WebGL2 supports uint32 natively) |
| `mesh.alwaysSelectAsActiveMesh`, `freezeWorldMatrix`, `doNotSyncBoundingInfo` | GPU-placed geometry, identity world | `mesh.frustumCulled = false`, `mesh.matrixAutoUpdate = false` (identity) |
| `renderingGroupId = 1` + `setRenderingAutoClearDepthStencil(1,false)` | draw ordering | render-order / layer discipline in the ported frame loop (opaque group after sky, before transparents; never clear depth between) |
| `mat.backFaceCulling = false` | two-sided sheets | `material.side = THREE.DoubleSide` |
| `shadows.registerCaster(mesh, makeMat, 2)` + `RenderTargetTexture.setMaterialForRendering` + `defines: CHAR_CASCADE n` | per-cascade depth materials | ported ShadowSystem: per cascade, render the caster list into a `WebGLRenderTarget` (R32F color + depth), overriding `mesh.material` with the cascade's depth material (or `scene.overrideMaterial` per-mesh swap). One material *instance* per cascade so each holds its own `lightViewProjection` |
| `depthPass.registerCaster(mesh, mat)` | camera prepass | same pattern into the ported DepthPass RGBA16F target |
| `mat.setTexture/setFloat/setVector3/setColor3/setArray4/setVector2` | uniform pushes | write into `material.uniforms.X.value` (pre-allocate Vector3/arrays; mutate, don't re-create) |
| `bindMatrixArray(mat, "cascadeMatrices", flat48)` | zero-alloc mat4 array | keep one shared `Float32Array(48)`; Three accepts `uniforms.cascadeMatrices.value = [m0,m1,m2]` of Matrix4 — cheaper: declare `mat4 cascadeMatrices[3]` and supply the flat array via a `uniforms` value of three Matrix4s that alias the shadow system's data (copy once per frame; 48 floats is negligible) |
| `whenReady(mat, ...)` warm-up | pre-compile behind loading screen | `renderer.compile(scene, camera)` / `renderer.compileAsync` after constructing everything, plus render 2–3 warm frames offscreen |
| `Constants.TEXTURE_CLAMP_ADDRESSMODE` etc. | sampler state | Three texture properties as above |
| Left/right-handedness | Babylon default scene is **left-handed** (+Z forward); all character math is authored in that world space (facing: `x=sin(yaw), z=cos(yaw)`) | Settled, and no flip at all: the port keeps the LH world-space convention verbatim and hand-builds the LH view and projection (`src/core/mat4.ts`), so the character JS math is byte-identical and nothing is mirrored per-subsystem. Winding: irrelevant here (culling off, N flipped toward V) — this subsystem is unusually handedness-tolerant |
| `Vector3/Vector2/Color3/Vector4` (Babylon math) | controller/character state | `THREE.Vector3/Vector2/Color/Vector4`; `Scalar.Clamp` → `THREE.MathUtils.clamp`; `expDamp` from core/camera port |
| WGSL NDC z ∈ [0,1] | depth writes | GL NDC z ∈ [-1,1]; handled inside the ported shadow/prepass math, not here — but re-verify `shadowBias=0.012` after the port (bias is in the cascades' depth units) |

---

## 6. Assets

None. No binary files, no textures, no audio. All geometry is built in JS
at boot (`buildBody`/`buildFur`/`buildClothMesh`); the palette is two 8-entry
constant tables in `character.ts`; `charTex` is CPU-generated per frame.
(`models/model`/`models/speeder` .bin assets belong to the models/speeder
subsystems, not this one.)

---

## 7. Porting risks & gotchas
The risks are listed in ranked order:

1. RGBA32F texture sampling in WebGL2. `charTex` must be created as
   `RGBAFormat`/`FloatType` with NEAREST filtering; float-linear filtering is
   an optional extension and must not be relied on. All reads are
   `texelFetch`, which is filter-independent, but Three.js will warn/misbehave
   if the texture is left with default LinearFilter. Also confirm
   `texSubImage2D` upload path fires every frame (`needsUpdate = true` after
   mutating the same backing array; Three caches by version counter, not by
   array identity).

2. Depth-convention drift between beauty, shadow and prepass paths. The
   original guarantees one surface across passes by sharing `charSkin.wgsl`
   between all 7 shaders. If the GLSL port copy-pastes instead of sharing the
   include string, any later fix diverges and you get peter-panning /
   self-shadow acne / TAA ghosting. Also WGSL z∈[0,1] vs GL z∈[-1,1] changes
   what `gl_FragCoord.z` means in the cascade R32F write, which is why the cascade
   PCSS lookup (shared shadow include) and `shadowBias=0.012` must be re-validated
   against the ported ShadowSystem's matrix convention.

3. Uniform-array indexing and layout. `matAlbedo[slot]` (slot from a
   varying), `panelParams[int(position.z)]` (from an attribute),
   `cascadeMatrices[i]`, all of which is dynamic indexing of uniform arrays. Legal in
   ES 3.0 GLSL, but some ANGLE/driver combos are picky about non-constant
   indexing of *sampler* arrays (not used here, since cascades are 3 separate
   samplers; keep them separate, do NOT fold into an array or a 2D-array
   texture without also porting the shadow include).

4. Per-cascade depth-material plumbing. Babylon's
   `setMaterialForRendering` + a define per cascade gives each cascade its own
   effect holding its own `lightViewProjection`. In Three you must replicate
   this: either one depth-material instance per (mesh, cascade) with its own
   uniforms object (recommended, since it matches the original), or rewrite one
   material's uniform between cascade passes (fragile with async uploads).
   The body registers into cascades 0–1 only (`CHAR_CASCADES=2`); fur into
   none. Preserve both exclusions or pay for a 22-shell alpha depth pass.

5. Frame-order coupling. `Character.update` (transforms) and
   `Character.sync` (uniforms) are split around the shadow refit and camera
   move. Merging them, or calling sync before the ported ShadowSystem refits,
   reproduces the exact bug the comment warns about: shadows/cloth lag the
   figure by one frame during fast carves. Similarly `figure.update` must
   precede `contact.update` (footprints need the planted boot), and cloth
   must be solved before the texture upload.

6. `discard`-based fur cost. 22 shells of double-sided alpha-tested
   geometry in the beauty pass; WebGL2 loses early-Z under discard and Three
   won't sort these shells specially. If fill-rate becomes a problem on the
   GL port, draw fur last within the opaque group (it self-sorts adequately
   since shells are inside-out agnostic; it was fine on WebGPU but GL drivers
   differ). Do not enable alpha blending, because the original is test-only.

7. Derivative-based cotangent frame precision. `dFdx/dFdy` of world
   position at 2 m scale in `highp` is fine, but the weave UVs are multiplied
   by `weaveDensity=210` before derivative, which is why `highp float` must stay
   everywhere in the fragment shader, or else the weave fade term (`uvFoot`) gets
   noisy on mobile GPUs.

8. Zero-allocation discipline. Controller/figure/cloth/upload paths
   allocate nothing per frame in the original (module-scope scratch vectors).
   The Three port should keep this, which means avoiding re-creation of uniform
   values (Vector3/arrays) in `sync`, and avoiding `setMatrices`-style copies
   (the original even bypasses Babylon's copy via `bindMatrixArray`).

9. `S.speeder` coupling. Controller behavior branches on `S.speeder`
   (flying steer/thrust model, rig.yaw writes) and `main.ts` hides the figure
   when flying while still updating it. Port the branch faithfully or the
   speeder subsystem breaks even though this subsystem "looks" fine.

10. Settle-on-first-update. `_needSettle` teleports cloth to skinned
    targets on the first `update`. If the port's boot order calls `sync`
    or renders before the first `update`, the robe renders at the world
    origin for a frame. Keep warm-up order: `figure.update(0)` →
    `figure.sync(camPos)` → compile → warm frames.
