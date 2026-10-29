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


layout(location = 0) out vec4 fragColor;

#include<snowNoise>
#include<snowAtmosphere>
#include<snowShading>

// ---------------------------------------------------------------------------
// Pulsar skybox: dark deep space, sparse stars, bright compact core, twin
// rotating jets, red-orange nebula filaments, faint all-sky haze.
// Cost: stars ~1 hash/cell (cheap), core/jets are pow() on dot products,
// nebula is one 4-octave fbmd (bounded, ~4 noise evals). No raymarch loop
// beyond the existing ridge march, which only runs near the horizon.
// ---------------------------------------------------------------------------


void main() {
    vec3 dir = normalize(vDir);

    // Deep-space base.
    float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(vec3(0.02, 0.01, 0.06), vec3(0.005, 0.002, 0.02), up);
    col += vec3(0.0, 0.005, 0.015) * (1.0 - up);

    // Sparse starfield: pure continuous 3D hash of dir — no floor/fract
    // grid, so placement is seamless across the sphere (no phi-wrap seam).
    float h = hash33(dir * 180.0 + vec3(17.0, 31.0, 53.0)).x;
    if (h > 0.988) {
        // Star point size shrinks with hash magnitude; brightness from hash.
        float bright = (h - 0.988) * 80.0;
        // Smooth circular falloff around the direction itself (continuous).
        vec3 o = hash33(dir * 180.0 + vec3(97.0, 131.0, 173.0));
        float ang = acos(clamp(dot(dir, normalize(o * 2.0 - 1.0)), -1.0, 1.0));
        float star = smoothstep(0.003, 0.0, ang);
        col += vec3(0.85, 0.9, 1.0) * star * bright;
    }

    vec3 L = sunDir;

    // Pulsar core along key-light direction (HDR 8-16). Its expansion and
    // shrinking pulse in step with the actual sunlight intensity: the star
    // swells and brightens when the sun is bright, and contracts and dims
    // when it is not. `sunIntensity` here is the sunScale (slider *
    // SUN_SCALE_BASE), so normalize against its shipped default
    // 4.2 * 5.5 = 23.1 to get a unitless factor.
    const float PULSAR_SUN_REF = 23.1;
    float mu = dot(dir, sunDir);
    float pulse = 0.5 + 0.5 * sin(time * 4.4);
    float sunNorm = clamp(sunIntensity / PULSAR_SUN_REF, 0.05, 4.0);
    float expand = 0.6 + 0.4 * pulse;
    // Intense white center (pinprick star).
    float exponent = 10000.0 / sqrt(sunNorm);
    float brightness = 20.0 * expand * sunNorm;
    float core = pow(max(mu, 0.0), exponent) * brightness;
    col += vec3(1.0, 0.95, 1.0) * core;
    // Blue nitrogen bloom ring (N2+ emission ~427.8 nm).
    float ringExp = (400.0 / sqrt(sunNorm)) / mix(1.0, 1.6, pulse);
    float ringBright = 6.0 * expand * sunNorm;
    float ring = pow(max(mu, 0.0), ringExp) * ringBright;
    col += vec3(0.15, 0.35, 0.95) * ring;

    // Spinning cones (jets) around the pulsar, rotating in sync with
    // the pulse. Two opposing beams sweep around the star.
    vec3 perp = normalize(cross(sunDir, vec3(0.0, 1.0, 0.001)));
    vec3 perp2 = cross(sunDir, perp);
    float coneAngle = atan(dot(dir, perp2), dot(dir, perp));
    float coneSpin = time * 4.4;
    float cone1 = cos(coneAngle - coneSpin);
    float cone2 = cos(coneAngle - coneSpin + PI);
    float coneMask1 = smoothstep(0.92, 1.0, cone1) * smoothstep(0.0, 0.3, mu);
    float coneMask2 = smoothstep(0.92, 1.0, cone2) * smoothstep(0.0, 0.3, mu);
    float conePulse = 0.5 + 0.5 * pulse;
    col += vec3(0.6, 0.7, 1.0) * (coneMask1 + coneMask2) * conePulse * 2.0;
    // Nebula filaments (bounded 4-octave fbmd). Sampled in 3D from dir so
    // the phi wrap seam is invisible (same fix as the aurora layer).
    vec3 qn = dir * 1.6;
    // Project onto a seamless 2D domain: (azimuth via xz plane is not needed;
    // use 3D noise directly for seamlessness).
    float n = noise3(qn + vec3(time * 0.06, 0.0, 0.0)) * 0.5 + 0.5;
    // Add a second octave for filament detail.
    n = n * 0.6 + (noise3(qn * 2.3 + vec3(0.0, time * 0.09, 4.7)) * 0.5 + 0.5) * 0.4;
    float fil = smoothstep(0.15, 0.55, n);
    float fil2 = smoothstep(0.35, 0.75, n);
    vec3 filCol = mix(vec3(0.15, 0.10, 0.55), vec3(0.25, 0.15, 0.70), fil2);
    col += filCol * fil * 0.6;

    // Deep indigo-purple all-sky haze, matching the night sky.
    col += vec3(0.008, 0.004, 0.025) * 0.25;

    // ---- aurora curtains (sky-only additive emission) --------------------
    if (auroraStrength > 0.001) {
        // Uniform magenta-purple ion cloud: a seamless, fluid gradient
        // driven by low-frequency noise so the emission is evenly
        // distributed across the sky (no isolated pink-spot artifacts).
        // Seamless on the sphere: sample noise in 3D using dir directly so
        // the phi=+pi / phi=-pi wrap is invisible (no vertical seam).
        float heightMask = smoothstep(0.02, 0.20, dir.y) * (1.0 - smoothstep(0.80, 0.98, dir.y));
        vec3 p0 = dir * 1.6;
        // Domain warping in 3D space (seamless).
        float w1 = noise3(p0 * 0.8 + vec3(0.0, 0.0, time * 0.12)) * 0.5 + 0.5;
        float w2 = noise3(p0 * 0.8 + vec3(4.7, 3.1, time * 0.17)) * 0.5 + 0.5;
        vec3 pw = p0 + vec3((w1 - 0.5) * 2.5, (w2 - 0.5) * 0.9, 0.0);
        
        // High-frequency noise for X-ray/gamma ray particle streams (rays).
        float rayNoise = noise3(pw * 8.0 + vec3(0.0, time * 0.40, 0.0)) * 0.5 + 0.5;
        rayNoise = smoothstep(0.4, 0.8, rayNoise);
        
        float n1 = noise3(pw * 1.1 + vec3(0.0, 0.0, time * 0.14));
        float n2 = noise3(pw * 0.6 + vec3(9.2, 1.7, time * 0.20));
        float n3 = noise3(pw * 1.5 + vec3(2.3, 7.4, time * 0.11));
        float flow = (n1 * 0.5 + n2 * 0.3 + n3 * 0.2) * 0.5 + 0.5;
        flow = smoothstep(0.18, 0.82, flow);
        float vert = smoothstep(0.0, 0.15, dir.y) * (1.0 - smoothstep(0.70, 0.95, dir.y));
        float intensity = auroraStrength * heightMask * flow * vert * 1.5; // Boosted for high-energy
        float phase = 0.5 + 0.5 * sin(time * 0.145 + dir.x * 0.5 + dir.z * 0.3);
        
        // Colors: deep blue -> violet -> bright white-blue (high energy N2+)
        vec3 c0 = vec3(0.05, 0.10, 0.50);   // deep blue
        vec3 c1 = vec3(0.20, 0.05, 0.70);   // violet
        vec3 c2 = vec3(0.40, 0.20, 0.95);   // bright violet/blue-white
        
        float t = clamp(dir.y * 1.4 + flow * 0.4 + phase * 0.3, 0.0, 1.0);
        vec3 auroraCol = mix(c0, c1, smoothstep(0.0, 0.5, t));
        auroraCol = mix(auroraCol, c2, smoothstep(0.5, 1.0, t));
        
        // Blend in the high-energy particle streams
        auroraCol = mix(auroraCol, vec3(0.6, 0.7, 1.0), rayNoise * 0.4);
        
        float breath = 0.7 + 0.3 * (0.5 + 0.5 * sin(time * 0.10));
        col += auroraCol * intensity * 0.9 * breath;
    }

    fragColor = vec4(col, 1.0);
}