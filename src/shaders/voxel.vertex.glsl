#version 300 es
precision highp float;
in vec3 position;
in vec3 normal;
in vec3 color;
uniform mat4 viewProjection;
out vec3 vNormal;
out vec3 vColor;
out vec3 vWorldPos;
void main() {
  vNormal = normal;
  vColor = color;
  vWorldPos = position;
  gl_Position = viewProjection * vec4(position, 1.0);
}