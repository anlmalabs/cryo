precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 vDir;

uniform sampler2D skyLUT;

uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float sunIntensity;
uniform float time;
uniform vec2 windDir;
uniform float cloudAmount;
uniform vec3 cameraPosition;
uniform vec3 sunRadiance;
uniform vec4 shR[9];
uniform float ambientIntensity;
uniform float auroraStrength;
uniform float ridgeAmp;

uniform float fogDensity;
uniform float fogHeightFalloff;
uniform float fogStart;
uniform float aerialStrength;

layout(location = 0) out vec4 fragColor;

#include<snowNoise>
#include<snowAtmosphere>
#include<snowShading>
#include<snowRidge>

// ---------------------------------------------------------------------------
// Pulsar skybox: dark deep space, sparse stars, bright compact core, twin
// rotating jets, red-orange nebula filaments, faint all-sky haze.
// Cost: stars ~1 hash/cell (cheap), core/jets are pow() on dot products,
// nebula is one 4-octave fbmd (bounded, ~4 noise evals). No raymarch loop
// beyond the existing ridge march, which only runs near the horizon.
// ---------------------------------------------------------------------------

vec3 shadeRidge(RidgeHit hit, vec3 dir) {
    // (unchanged ridge shading - keep terrain aerial perspective working)
    vec3 N = hit.normal;
    vec3 L = sunDir;

    float steep = 1.0 - N.y;
    float snowMask = clamp(1.0 - smoothstep(0.46, 0.80, steep), 0.0, 1.0);

    vec3 rock = vec3(0.052, 0.055, 0.066);
    vec3 snow = vec3(0.855, 0.885, 0.945);
    vec3 albedo = mix(rock, snow, snowMask);

    float shadow = ridgeShadow(hit.pos, hit.height, L, ridgeAmp);

    const float INV_PI = 0.31830988618;
    float diff = wrapDiffuse(dot(N, L), mix(0.15, 0.62, snowMask));
    vec3 col = albedo * INV_PI * sunRadiance * diff * shadow;
    vec3 V = -dir;
    col += snowSubsurface(N, L, V, sunRadiance, 0.45, snowMask, 1.0)
         * albedo * mix(0.5, 1.0, shadow);

    col += albedo * INV_PI * shIrradiance(N, shR) * ambientIntensity;

    col += albedo * INV_PI * shIrradiance(vec3(0.0, 1.0, 0.0), shR)
         * ambientIntensity * 0.30 * clamp(-N.y * 0.5 + 0.5, 0.0, 1.0)
         * snowMask;

    vec3 hitPos = vec3(hit.pos.x, hit.height, hit.pos.y);
    float t = aerialTransmittance(
        cameraPosition, hitPos,
        fogDensity, fogHeightFalloff, fogStart
    );
    float ext = clamp(1.0 - pow(t, aerialStrength), 0.0, 1.0);

    vec3 inscatter = aerialInscatterSky(
        skyLUT, dir, L, sunRadiance, ext
    );

    return mix(col, inscatter, ext);
}

void main() {
    vec3 dir = normalize(vDir);

    // Deep-space base.
    float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(vec3(0.05, 0.07, 0.12), vec3(0.015, 0.02, 0.04), up);
    col += vec3(0.0, 0.01, 0.03) * (1.0 - up);

    // Sparse starfield.
    vec3 sp = dir * 180.0;
    vec3 cell = floor(sp);
    vec3 f = fract(sp);
    float h = hash33(cell).x;
    if (h > 0.988) {
        vec3 o = hash33(cell + vec3(17.0, 31.0, 53.0));
        float d = length(f - (o * 0.8 + 0.1));
        float star = smoothstep(0.06, 0.0, d);
        float bright = (h - 0.988) * 80.0;
        col += vec3(0.85, 0.9, 1.0) * star * bright;
    }

    // Pulsar core along key-light direction (HDR 8-16). Its expansion and
    // shrinking pulse in step with the actual sunlight intensity: the star
    // swells and brightens when the sun is bright, and contracts and dims
    // when it is not. `sunIntensity` here is the sunScale (slider *
    // SUN_SCALE_BASE), so normalize against its shipped default
    // 4.2 * 5.5 = 23.1 to get a unitless factor.
    const float PULSAR_SUN_REF = 23.1;
    float mu = dot(dir, sunDir);
    float pulse = 0.5 + 0.5 * sin(time * 3.0);
    float sunNorm = clamp(sunIntensity / PULSAR_SUN_REF, 0.05, 4.0);
    float expand = 0.6 + 0.4 * pulse;
    float exponent = 10000.0 / sqrt(sunNorm);
    float brightness = 20.0 * expand * sunNorm;
    float core = pow(max(mu, 0.0), exponent) * brightness;
    col += vec3(0.55, 0.72, 1.0) * core;
    // Nebula filaments (bounded 4-octave fbmd).
    vec2 q = vec2(atan(dir.z, dir.x), dir.y) * 1.6;
    float n = fbmd(q + vec2(time * 0.005, 0.0), 4, 2.0, 0.5).x;
    float fil = smoothstep(0.15, 0.55, n);
    float fil2 = smoothstep(0.35, 0.75, n);
    vec3 filCol = mix(vec3(1.0, 0.416, 0.239), vec3(1.0, 0.541, 0.361), fil2);
    col += filCol * fil * 1.2;

    // Faint all-sky haze.
    col += vec3(0.04, 0.06, 0.10) * 0.35;

    // Far-field range.
    if (ridgeAmp > 1.0 && dir.y < 0.230 && dir.y > -0.050) {
        RidgeHit hit = ridgeMarch(cameraPosition, dir, ridgeAmp);
        if (hit.hit) {
            col = shadeRidge(hit, dir);
        }
    }

    // ---- aurora curtains (sky-only additive emission) --------------------
    if (auroraStrength > 0.001) {
        float phi = atan(dir.z, dir.x);
        // gate to upper sky
        float heightMask = smoothstep(0.05, 0.25, dir.y) * (1.0 - smoothstep(0.75, 0.95, dir.y));
        // low-frequency banding into sheets
        float band = noise3(vec3(phi * 1.6, dir.y * 0.8, time * 0.03));
        band = smoothstep(0.15, 0.75, band * 0.5 + 0.5);
        // fine vertical striation
        float stri = noise3(vec3(phi * 18.0, dir.y * 3.0, time * 0.12));
        stri = stri * 0.5 + 0.5;
        // vertical falloff: bright base, faded top
        float vert = smoothstep(0.0, 0.18, dir.y) * (1.0 - smoothstep(0.45, 0.85, dir.y));
        float intensity = auroraStrength * heightMask * band * (0.55 + 0.45 * stri) * vert;
        // colour: green dominant, upper red/violet edge
        float edge = smoothstep(0.4, 0.8, dir.y);
        vec3 auroraCol = mix(vec3(0.12, 0.95, 0.38), vec3(0.85, 0.25, 0.75), edge);
        col += auroraCol * intensity * 1.6;
    }

    fragColor = vec4(col, 1.0);
}