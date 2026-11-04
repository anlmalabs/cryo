#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;

uniform mat4 viewProjection;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uTime;
uniform float uHitEnergy;
uniform vec3 uHitDir;
uniform float uHitTime;

out vec3 vNormal;
out vec3 vWorldPos;

void main() {
    vec3 n = normalize(normal);
    float dt = uTime - uHitTime;
    float ripple = 0.0;
    if (uHitEnergy > 0.0 && dt >= 0.0 && dt < 0.6) {
        ripple = uHitEnergy * 0.15 * uRadius * sin(10.0 * dot(n, uHitDir) - 12.0 * dt);
    }
    vec3 worldPos = uCenter + position * uRadius + n * ripple;
    vNormal = n;
    vWorldPos = worldPos;
    gl_Position = viewProjection * vec4(worldPos, 1.0);
}
