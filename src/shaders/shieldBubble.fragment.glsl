#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorldPos;

uniform vec3 uCameraPos;
uniform float uIntensity;
uniform float uHitEnergy;
uniform vec3 uPulsarColor;
uniform float uTime;

out vec4 fragColor;

void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCameraPos - vWorldPos);
    float ndotv = abs(dot(N, V));
    float fresnel = pow(1.0 - ndotv, 2.5);
    float bands = 0.5 + 0.5 * sin(vWorldPos.y * 24.0 + uTime * 3.0);
    bands *= 0.15;
    float rim = fresnel;
    vec3 color = uPulsarColor * rim + vec3(1.0) * fresnel * 0.25;
    float alpha = uIntensity * (rim + bands) + uHitEnergy * rim * 1.5;
    alpha = clamp(alpha, 0.0, 1.0);
    fragColor = vec4(color, alpha);
}
