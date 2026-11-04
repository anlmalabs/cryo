// ---------------------------------------------------------------------------
// PulsarClock — tidal-locked pulsar flash source of truth.
//
// LORE (authoritative, do not change the visual model):
// The planet is TIDALLY LOCKED to a pulsar it orbits. There is NO day/night
// cycle and never will be: `sunDir` is the fixed mean direction to the pulsar
// (driven by sunAzimuth/sunElevation settings), and the "sun" visual simulates
// the pulsar. The pulsar's DOUBLE BEAM sweeps around that locked mean direction
// at PULSAR_SPIN_RATE 0.4398 rad/s (full sweep ~14.3 s; two beams spaced
// phase and phase+pi => a gamma flash strikes the ground every ~7.15 s).
// quarticMask fires for x > 0.85 (remaps [0.85,1.0] to [0,1] then t^4); the
// visual mask is sunDir-aligned only (single beam), but each beam has a
// symmetric piercing gate (beam 1: cos φ, beam 2: -cos φ).
//
// isPiercing is DERIVED from the per-beam flash envelopes (flash1/flash2 >= 0.95):
// the gamma ray striking the ground. It is the SOURCE OF TRUTH consumed by the
// EXISTING src/survival/ radiation/shield system — visuals and radiation share
// one clock, so they can never desync.
//
// Palette/geometry/static terms are FROZEN. The pulse SOURCE was refactored
// (owner-directed) to per-beam flash envelopes so lighting and radiation share
// one clock (uniforms uPulsarPhase/uPulsarBeamDir/uFlash1/uFlash2).
// ---------------------------------------------------------------------------
import * as THREE from "three";

// 0.4398 rad/s -> 2pi/0.4398 = 14.28 s full sweep. Two beams (phase and
// phase+pi) => gamma flash every ~7.14 s. Tuned constant, do not normalize.
export const PULSAR_SPIN_RATE = 0.4398;

const _up = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _lastSunDir = new THREE.Vector3(0, 0.2, 1);

// quartic falloff: fires for x > 0.85 (remaps [0.85,1.0] to [0,1]); t^4
// gives a sharp spike. Quartic (not linear)
// so the flash is a brief, hard-edged gamma pulse rather than a broad wash.
function quarticMask(x: number): number {
  const t = Math.max(0, Math.min(1, (x - 0.85) / 0.15));
  return t * t * t * t;
}

export class PulsarClock {
  private _phase = 0;
  private _flash1 = 0;
  private _flash2 = 0;
  private _isPiercing = false;
  private readonly _beamDir = new THREE.Vector3(1, 0, 0);

  // Uniform contract consumed by the sky material (sky.ts ~188-191) and
  // sky.fragment.glsl ~17-20: uPulsarPhase (sweep phase), uPulsarBeamDir (beam
  // direction), uFlash1/uFlash2 (per-beam flash envelopes; flashTotal = max).
  readonly uniforms = {
    uPulsarPhase: { value: 0 },
    uPulsarBeamDir: { value: new THREE.Vector3(1, 0, 0) },
    uFlash1: { value: 0 },
    uFlash2: { value: 0 },
  };

  get phase(): number { return this._phase; }
  get flash1(): number { return this._flash1; }
  get flash2(): number { return this._flash2; }
  get flashTotal(): number { return Math.max(this._flash1, this._flash2); }
  // CORE GAME MECHANIC banner: isPiercing is the SOURCE OF TRUTH for "the pulsar
  // ray is hitting the ground" (the gamma flash). Consumed by src/survival/
  // radiation/shield system. DO NOT change semantics; threshold 0.95 is the
  // contract.
  get isPiercing(): boolean { return this._isPiercing; }
  get beamDir(): THREE.Vector3 { return this._beamDir; }

  update(time = 0, sunDir?: THREE.Vector3): void {
    if (sunDir) _lastSunDir.copy(sunDir);

    this._phase = time * PULSAR_SPIN_RATE;

    _up.set(0, 1, 0.001);
    // _perp is perpendicular to the locked mean sunDir, giving the rotation axis
    // plane: the beam rotates around the locked mean direction (tidal lock).
    _perp.crossVectors(_lastSunDir, _up).normalize();

    const c = Math.cos(this._phase);
    const s = Math.sin(this._phase);
    // _beamDir = sunDir*cos(phase) + perp*sin(phase): rotation of the beam
    // around the locked mean direction. Two beams via phase and phase+pi below.
    this._beamDir.copy(_lastSunDir).multiplyScalar(c).addScaledVector(_perp, s);

    const alignment = Math.max(-1, Math.min(1, c));
    const mask1 = quarticMask(c);
    const mask2 = quarticMask(Math.cos(this._phase + Math.PI));
    // PER-BEAM FLASH ENVELOPES — the single source of truth. The sky shader
    // (cone brightness, core/ring expansion) and the radiation/shield mechanic
    // both consume these: the flashing cone IS the piercing beam.
    // flash1 peaks when the beam aligns with the locked pulsar direction
    // (cos φ = 1); flash2 when the opposite beam strikes (cos φ = -1).
    const flash1 = mask1 * (0.5 + 0.5 * alignment);
    const flash2 = mask2 * (0.5 - 0.5 * alignment);
    // CORE GAME MECHANIC: gamma ray striking the ground. Derived from the SAME
    // envelopes the sky renders — visuals and radiation can never desync.
    // Window ~0.25 s per beam; beams alternate every ~7.15 s.
    this._flash1 = Math.max(0, Math.min(1, flash1));
    this._flash2 = Math.max(0, Math.min(1, flash2));
    this._isPiercing = this._flash1 >= 0.95 || this._flash2 >= 0.95;

    this.uniforms.uFlash1.value = this._flash1;
    this.uniforms.uFlash2.value = this._flash2;

    this.uniforms.uPulsarPhase.value = this._phase;
    this.uniforms.uPulsarBeamDir.value.copy(this._beamDir);
  }
}

export const pulsarClock = new PulsarClock();
