// Depth-prepass vertex shader for the model. Same skinning path as
// speeder.vertex.glsl and speederDepth.vertex.glsl, from the same include.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowModelSkin>

in vec3 position;
in vec4 boneIdx;
in vec4 boneWt;

uniform mat4 viewProjection;

/// First of this model's four rows in the shared transform texture.
uniform float boneRow;

uniform sampler2D hullTex;

out float vViewZ;
out float vMask;

void main() {
    HullXform m = hullXform(hullTex, int(boneRow), boneIdx, boneWt);
    vec3 world = hullPoint(m, position);
    vec4 clip = viewProjection * vec4(world, 1.0);
    vViewZ = clip.w;
    vMask = 0.0;
    gl_Position = clip;
}
