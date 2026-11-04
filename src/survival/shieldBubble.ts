import * as THREE from "three";
import type { Gfx } from "../core/gfx.js";
import { getShader } from "../shaders/registry.js";

const RADIUS = 8.0;

const _vp = new THREE.Matrix4();

export class ShieldBubble {
  gfx: Gfx;
  mesh: THREE.Mesh;
  material: THREE.RawShaderMaterial;
  uTime: { value: number } = { value: 0 };
  _time = 0;

  constructor(gfx: Gfx) {
    this.gfx = gfx;

    const src = new THREE.IcosahedronGeometry(1, 2);
    const posArr = src.attributes.position.array as Float32Array;
    const nrmArr = src.attributes.normal.array as Float32Array;
    // PolyhedronGeometry is non-indexed (vertices duplicated per face) — build a
    // sequential index when there isn't one, so the draw below is always indexed.
    let idxArr: Uint32Array;
    if (src.index) {
      idxArr = new Uint32Array(src.index.array as ArrayLike<number>);
    } else {
      idxArr = new Uint32Array(posArr.length / 3);
      for (let i = 0; i < idxArr.length; i++) idxArr[i] = i;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(nrmArr, 3));
    geometry.setIndex(new THREE.BufferAttribute(idxArr, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    src.dispose();

    const uniforms = {
      viewProjection: { value: _vp },
      uCenter: { value: new THREE.Vector3() },
      uRadius: { value: RADIUS },
      uCameraPos: { value: new THREE.Vector3() },
      uTime: this.uTime,
      uIntensity: { value: 0 },
      uHitEnergy: { value: 0 },
      uHitDir: { value: new THREE.Vector3(0, 0, 1) },
      uHitTime: { value: 0 },
      uPulsarColor: { value: new THREE.Vector3(0.4, 0.7, 1.0) },
    };

    this.material = new THREE.RawShaderMaterial({
      vertexShader: getShader("shieldBubbleVertexShader"),
      fragmentShader: getShader("shieldBubblePixelShader"),
      uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      if (camera === this.gfx.threeCamera) {
        _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const ucp = this.material.uniforms.uCameraPos.value as THREE.Vector3;
        ucp.setFromMatrixPosition(camera.matrixWorld);
      }
    };
    this.gfx.addMesh(this.mesh, this.gfx.LAYER.BLEND, 55);
  }

  hitFrom(dir: THREE.Vector3): void {
    const uHitDir = this.material.uniforms.uHitDir.value as THREE.Vector3;
    uHitDir.copy(dir);
    const len = uHitDir.length();
    if (len > 1e-6) uHitDir.multiplyScalar(1 / len);
    this.material.uniforms.uHitEnergy.value = 1.0;
    this.material.uniforms.uHitTime.value = this._time;
  }

  update(dt: number, state: {
    active: boolean;
    center: THREE.Vector3;
    shield01: number;
    hitPulse: number;
  }): void {
    this._time += dt;
    this.uTime.value = this._time;

    const uCenter = this.material.uniforms.uCenter.value as THREE.Vector3;
    uCenter.copy(state.center);

    const uIntensity = this.material.uniforms.uIntensity;
    if (state.active) {
      let v = state.shield01;
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      uIntensity.value = v;
    } else {
      uIntensity.value = 0;
    }
    this.mesh.visible = state.active;

    const uHitEnergy = this.material.uniforms.uHitEnergy;
    if (state.hitPulse > uHitEnergy.value) {
      uHitEnergy.value = state.hitPulse > 1 ? 1 : state.hitPulse;
      this.material.uniforms.uHitTime.value = this._time;
    }
    if (uHitEnergy.value > 0) {
      let e = uHitEnergy.value - dt / 0.6;
      if (e < 0) e = 0;
      uHitEnergy.value = e;
    }
  }
}
