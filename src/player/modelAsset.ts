/**
 * Loading the baked model.
 *
 * The file is what `tools/bakeModel.mjs` produced: a magic word, a JSON header,
 * then one contiguous payload of quantised attributes and one cycle of baked
 * skinning matrices. There is no parsing to speak of — every section is a typed
 * view onto the ArrayBuffer the fetch already produced, and the only work done
 * here is widening the quantised attributes into the Float32Arrays the vertex
 * buffers want.
 *
 * That widening is deliberate rather than lazy. WebGPU has no three-component
 * 16-bit vertex format, so a packed layout would have to be padded to vec4 and
 * would save nothing in VRAM; the quantisation is there to make the *download*
 * small, and 75k vertices expand in about a millisecond. What crosses the wire
 * is 2.8 MB where the source glTF was 15.5, and it comes from wherever
 * `core/assets.js` points — by default a public Vercel Blob store, not this
 * origin.
 *
 * Textures arrive as three WebP images per set and are assembled into one
 * four-layer array, so the whole machine draws in a single pass with a single
 * sampler. The fourth layer has no image behind it — the interior material is a
 * flat colour — and is generated white so the per-slot factors decide it.
 */

import { fetchAsset } from "../core/assets.js";

const MAGIC = "SNWK";

/** One section descriptor in the baked file's `header.layout`. */
export interface LayoutEntry {
 name: string;
 offset: number;
 count: number;
 /** Key into `TYPES` below — e.g. `"Int16Array"`. */
 type: string;
}

/** One decoded level of detail, widened into the vertex buffers. */
export interface ModelLOD {
 positions: Float32Array;
 normals: Float32Array;
 uvs: Float32Array;
 /** (material slot, spare) per vertex. */
 aux: Float32Array;
 boneIdx: Float32Array;
 boneWt: Float32Array;
 indices: Uint16Array | Uint32Array;
 triangleCount: number;
 vertexCount: number;
}

/** One material slot in the baked file's header — an image index, or -1. */
export interface ModelMaterial {
 name: string;
 slot: number;
 roughness: number;
 metallic: number;
 albedoImage: number;
 ormImage: number;
}

/** One baked animation clip beyond the locomotion cycle. */
export interface ModelClip {
 anim: Int16Array;
 frameCount: number;
 duration: number;
}

/**
 * The baked file's JSON header — the fixed schema `tools/bakeModel.mjs`
 * writes, whose `version` gates every field below.
 *
 * `layout` is typed precisely because it is what the section views are built
 * from; `posOffset`/`posScale` and the remaining counts are read by exact key.
 */
export interface ModelHeader {
 version: number;
 /** One descriptor per attribute section. */
 layout: LayoutEntry[];
 /** Per level of detail, finest first. */
 lods: { level: number }[];
 /** Translation applied after dequantising positions, metres. */
 posOffset: [number, number, number];
 /** Scale applied after dequantising positions. */
 posScale: [number, number, number];
 /** Extra clips beyond the locomotion cycle. */
 clips?: {
  name: string;
  frame0: number;
  frameCount: number;
  duration: number;
 }[];
 /** Edge length of the model's albedo/ORM textures, texels. */
 textureSize: number;
 materials: ModelMaterial[];
 boneCount: number;
 /** Frames in the runtime's locomotion cycle. */
 frameCount: number;
 /** Seconds the cycle takes. */
 duration: number;
 /**
  * PRE-EXISTING DEFECT — declared optional, and that is the honest truth:
  * `tools/bakeModel.mjs` does not write these three, so every model in the
  * repo loads with them `undefined`. Unread they are merely `undefined`; read,
  * `bounds.max[2]` throws and `a[k] * basisScale` is NaN — which is what the
  * flight model's ground probes and transform texture were feeding on until
  * the header was first typed. The values have to be supplied by the baker or
  * derived from `posScale`/`lods[].positions`; nothing here may fabricate
  * them.
  */
 /** Local-space bounding box, metres. */
 bounds?: { min: number[]; max: number[] };
 /** Multiplier on the baked skinning basis. */
 basisScale?: number;
 /** Multiplier on the baked translation. */
 transScale?: number;
}

/** The fully decoded model, ready to hand to the model. */
export interface ModelAsset {
 header: ModelHeader;
 /** Finest first. */
 lods: ModelLOD[];
 /** Frame-major, 12 quantised floats per bone. */
 anim: Int16Array;
 /** Layer-major RGBA. */
 albedo: Uint8Array | null;
 /** Layer-major RGBA. */
 orm: Uint8Array | null;
 clips: Record<string, ModelClip> | null;
 layers: number;
 albedoSize: number;
 ormSize: number;
}

/**
 * Layers in the texture arrays. Material slots index straight into them, so the
 * count follows the model — the model has four materials and the speeder five,
 * and a fixed four silently dropped the fifth.
 */
const MIN_LAYERS = 4;
const layersFor = (materials: unknown[]) => Math.max(MIN_LAYERS, materials.length);

/**
 * sRGB byte -> linear float, as a 256-entry table.
 *
 * Built once and only used when asked for. A colour map authored for a renderer
 * that decodes sRGB, uploaded as raw bytes into a texture array that does not,
 * is read as though its mid-tones were already linear — which lands every one of
 * them in the wrong place and reads, on a dark hull, as black.
 *
 * The constants below are the sRGB electro-optical transfer function's
 * straight-line-to-power split, defined by IEC 61966-2-1 (the sRGB spec):
 * `0.04045` is the threshold where the linear segment gives way to the
 * `2.4`-power curve, `12.92` is the slope of that linear segment, and
 * `0.055`/`1.055` offset and rescale the power curve so it meets that segment
 * continuously. They are fixed by the standard, not tunable.
 */
const SRGB_TO_LINEAR = (() => {
 /** Entries in the table — one per possible sRGB byte value. */
 const TABLE = 256;
 /** The largest value an sRGB byte can hold. */
 const BYTE_MAX = 255;
 const t = new Uint8Array(TABLE);
 for (let i = 0; i < TABLE; i++) {
  const c = i / BYTE_MAX;
  const lin = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  t[i] = Math.round(lin * BYTE_MAX);
 }
 return t;
})();

/**
 * @param {string} base path prefix, without extension
 * @param {{ srgbAlbedo?: boolean }} [opts]
 *   `srgbAlbedo` decodes the colour maps on the way into the array. Off by
 *   default, deliberately: the model's maps have been looked at and tuned as
 *   they are, and silently re-gamma-ing them would change a model nobody asked
 *   to change.
 * @returns {Promise<ModelAsset>}
 */
export async function loadModelAsset(base: string, opts?: { srgbAlbedo?: boolean }) {
 // The store first, this origin second — so a model that has been baked but
 // not yet uploaded loads anyway. See `core/assets.js`.
 const res = await fetchAsset(base + ".bin");
 const buffer = await res.arrayBuffer();

 const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
 if (magic !== MAGIC) throw new Error(`model: bad magic "${magic}"`);
 const headerBytes = new DataView(buffer).getUint32(4, true);
 // Parsed from a file on disk or a blob store, so it is untrusted input:
 // narrowed to `ModelHeader` by the shape guard below, so every read past
 // it is a typed read rather than an `any` read.
 const parsed: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerBytes)));
 if (
  !parsed || typeof parsed !== "object"
  || !Array.isArray((parsed as ModelHeader).layout)
  || !Array.isArray((parsed as ModelHeader).materials)
 ) throw new Error(`model: header is not a v2 header: ${JSON.stringify(parsed)}`);
 const header = parsed as ModelHeader;
 if (header.version !== 2) throw new Error(`model: unsupported version ${header.version}`);

 const payload = 8 + headerBytes;
 /** @type {Record<string, LayoutEntry>} */
 const sections: Record<string, LayoutEntry> = {};
 for (const s of header.layout) sections[s.name] = s;
 // Name -> constructor, so a section's `type` string picks the view class.
 const TYPES = { Int8Array, Uint8Array, Int16Array, Uint16Array, Uint32Array, Float32Array };
 /**
  * A section view. Generic over the view class so a caller that knows its
  * section's `type` gets the exact array; `s.type` is trusted here because it
  * is validated by the assert above and only ever written by the baker.
  */
 function view<T extends Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array | Float32Array>(
  name: string
 ): T {
  const s = sections[name];
  if (!s) throw new Error(`model: section "${name}" missing`);
  return new TYPES[s.type as keyof typeof TYPES](buffer, payload + s.offset, s.count) as T;
 }

 const [ox, oy, oz] = header.posOffset;
 const [sx, sy, sz] = header.posScale;

 /** Widen one level's quantised attributes into the vertex buffers. */
 const readLOD = (level: number) => {
  const qPos = view<Int16Array>(`position${level}`);
  const qNrm = view<Int8Array>(`normal${level}`);
  const qUV = view<Uint16Array>(`texcoord${level}`);
  const qIdx = view<Uint8Array>(`boneIdx${level}`);
  const qWt = view<Uint8Array>(`boneWt${level}`);
  const qSlot = view<Uint8Array>(`slot${level}`);
  const n = qSlot.length;

  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  const aux = new Float32Array(n * 2);
  const boneIdx = new Float32Array(n * 4);
  const boneWt = new Float32Array(n * 4);

  for (let i = 0; i < n; i++) {
   const p = i * 3;
   positions[p] = (qPos[p] + 32768) * sx + ox;
   positions[p + 1] = (qPos[p + 1] + 32768) * sy + oy;
   positions[p + 2] = (qPos[p + 2] + 32768) * sz + oz;
   normals[p] = qNrm[p] / 127;
   normals[p + 1] = qNrm[p + 1] / 127;
   normals[p + 2] = qNrm[p + 2] / 127;

   uvs[i * 2] = qUV[i * 2] / 65535;
   uvs[i * 2 + 1] = qUV[i * 2 + 1] / 65535;
   aux[i * 2] = qSlot[i];

   const b = i * 4;
   for (let k = 0; k < 4; k++) {
    boneIdx[b + k] = qIdx[b + k];
    boneWt[b + k] = qWt[b + k] / 255;
   }
  }

  const indices = view<Uint16Array | Uint32Array>(`indices${level}`);
  return {
   positions, normals, uvs, aux, boneIdx, boneWt, indices,
   vertexCount: n,
   triangleCount: indices.length / 3,
  };
 };

 // Named `out` rather than `asset`: `asset()` is the URL resolver the assets
 // module exports, and a `const asset` anywhere in this function would put it
 // in the temporal dead zone for the whole body — including the fetch on
 // line one.
 const out: ModelAsset = {
  header,
  lods: header.lods.map((l) => readLOD(l.level)),
  anim: view<Int16Array>("anim"),
  albedo: null,
  orm: null,
  clips: null,
  layers: 0,
  albedoSize: 0,
  ormSize: 0,
 };


 // Extra clips, if the bake carried any (hit reactions, deaths). Each is a
 // view into the same anim table; the runtime's cycle stays clip 0, which
 // `header.frameCount`/`duration` still describe, so a model without these
 // loads exactly as before.
 out.clips = null;
 if (header.clips) {
  out.clips = {};
  const stride = header.boneCount * 12;
  for (const c of header.clips) {
   out.clips[c.name] = {
    anim: out.anim.subarray(c.frame0 * stride, (c.frame0 + c.frameCount) * stride),
    frameCount: c.frameCount,
    duration: c.duration,
   };
  }
 }

 const size = header.textureSize;
 out.layers = layersFor(header.materials);

 // Both arrays stay at the model's own texture size, including the ORM of a
 // model that has no ORM maps and gets a plain white one. Shrinking that to a
 // single texel would save VRAM, and was tried; the saving is not free, because
 // a mipmapped, anisotropically-filtered 1x1 array texture behaves differently
 // from a full-size one at grazing angles, and the difference was not checked
 // frame by frame. The full-size array costs memory, and keeps the sampling
 // path identical to a model that does carry ORM maps.
 out.albedoSize = size;
 out.ormSize = size;

 const [albedo, orm] = await Promise.all([
  loadLayers(base, "albedo", header.materials, size, out.layers, !!opts?.srgbAlbedo),
  // Never the ORM: occlusion, roughness and metalness are data, not colour,
  // and are authored linear already.
  loadLayers(base, "orm", header.materials, out.ormSize, out.layers, false),
 ]);
 out.albedo = albedo;
 out.orm = orm;
 return out;
}

/**
 * Decode one image per material into a single layer-major RGBA buffer.
 *
 * Materials with no map of this kind get a white layer, which the per-slot
 * factor uniforms then scale — so the shader never has to branch on whether a
 * slot is textured.
 */
async function loadLayers(
 base: string, kind: "albedo" | "orm", materials: ModelMaterial[], size: number, layers: number, srgb: boolean
) {
 const stride = size * size * 4;
 const out = new Uint8Array(stride * layers);
 out.fill(255);

 const canvas = new OffscreenCanvas(size, size);
 const ctx = canvas.getContext("2d", { willReadFrequently: true });
 if (!ctx) throw new Error(`no 2D context on the OffscreenCanvas (${size}×${size}) — cannot decode model textures; this environment does not support OffscreenCanvas 2D, so use a browser that does (or serve the asset as pre-decoded image bitmaps).`);

 await Promise.all(materials.map(async (m: ModelMaterial) => {
  const key = kind === "albedo" ? "albedoImage" : "ormImage";
  if (m[key] < 0 || m.slot >= layers) return;
  const res = await fetchAsset(`${base}_${kind}_${m.slot}.webp`);
  const bitmap = await createImageBitmap(await res.blob());
  // Drawn rather than copied: it costs nothing and it means a texture that
  // came out of the bake at some other size still lands in the array.
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(bitmap, 0, 0, size, size);
  bitmap.close();
  const px = new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer);
  if (srgb) {
   // RGB through the curve; alpha is coverage, not colour.
   for (let i = 0; i < px.length; i += 4) {
    px[i] = SRGB_TO_LINEAR[px[i]];
    px[i + 1] = SRGB_TO_LINEAR[px[i + 1]];
    px[i + 2] = SRGB_TO_LINEAR[px[i + 2]];
   }
  }
  out.set(px, m.slot * stride);
 }));

 return out;
}

