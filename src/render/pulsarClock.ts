import * as THREE from "three";

export const PULSAR_SPIN_RATE = 0.4398;

const _up = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _lastSunDir = new THREE.Vector3(0, 0.2, 1);

function quarticMask(x: number): number {
  const t = Math.max(0, Math.min(1, (x - 0.85) / 0.15));
  return t * t * t * t;
}

export class PulsarClock {
  private _phase = 0;
  private _pulsarIntensity = 0;
  private _isPiercing = false;
  private readonly _beamDir = new THREE.Vector3(1, 0, 0);

  readonly uniforms = {
    uPulsarIntensity: { value: 0 },
    uPulsarPhase: { value: 0 },
    uPulsarBeamDir: { value: new THREE.Vector3(1, 0, 0) },
  };

  get phase(): number { return this._phase; }
  get pulsarIntensity(): number { return this._pulsarIntensity; }
  get isPiercing(): boolean { return this._isPiercing; }
  get beamDir(): THREE.Vector3 { return this._beamDir; }

  update(time = 0, sunDir?: THREE.Vector3): void {
    if (sunDir) _lastSunDir.copy(sunDir);

    this._phase = time * PULSAR_SPIN_RATE;

    _up.set(0, 1, 0.001);
    _perp.crossVectors(_lastSunDir, _up).normalize();

    const c = Math.cos(this._phase);
    const s = Math.sin(this._phase);
    this._beamDir.copy(_lastSunDir).multiplyScalar(c).addScaledVector(_perp, s);

    const alignment = Math.max(-1, Math.min(1, this._beamDir.dot(_lastSunDir)));
    const mask1 = quarticMask(Math.cos(this._phase));
    const mask2 = quarticMask(Math.cos(this._phase + Math.PI));
    this._pulsarIntensity = Math.max(mask1, mask2, 0) * (0.5 + 0.5 * alignment);
    if (this._pulsarIntensity > 1) this._pulsarIntensity = 1;
    if (this._pulsarIntensity < 0) this._pulsarIntensity = 0;

    this._isPiercing = this._pulsarIntensity >= 0.95;

    this.uniforms.uPulsarIntensity.value = this._pulsarIntensity;
    this.uniforms.uPulsarPhase.value = this._phase;
    this.uniforms.uPulsarBeamDir.value.copy(this._beamDir);
  }
}

export const pulsarClock = new PulsarClock();
