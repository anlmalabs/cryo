#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
in vec3 vWorldPos;
uniform vec3 sunDir;
uniform vec3 cameraPos;
uniform float fogDensity;
out vec4 fragColor;
void main() {
  float ndotl = dot(normalize(vNormal), normalize(sunDir)) * 0.5 + 0.5;
  vec3 col = vColor / 255.0 * (ndotl + 0.25);
  float d = length(vWorldPos - cameraPos);
  float fog = 1.0 - exp(-fogDensity * d);
  col = mix(col, vec3(0.7, 0.75, 0.8), fog);
  fragColor = vec4(col, 1.0);
}