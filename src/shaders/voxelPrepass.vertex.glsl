#version 300 es
precision highp float;
in vec3 position;
in vec3 normal;
in vec3 color;
uniform mat4 viewProjection;
out float vViewZ;
out float vMask;
void main() {
  vec4 clip = viewProjection * vec4(position, 1.0);
  vViewZ = clip.w;
  vMask = 0.0;
  gl_Position = clip;
}
