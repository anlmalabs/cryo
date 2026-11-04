#version 300 es
precision highp float;
in vec3 position;
in vec3 normal;
in vec3 color;
uniform mat4 lightViewProjection;
uniform vec3 cameraPos;
void main() {
  gl_Position = lightViewProjection * vec4(position, 1.0);
}
