precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 vDir;

uniform sampler2D skyLUT;

uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float sunIntensity;
uniform float time;
// Pulsar pulsing flow contract (PulsarClock is the single source of truth):
// uPulsarPhase drives coneSpin (beam rotation); uFlash1/uFlash2 are the
// per-beam gamma envelopes from PulsarClock; flashTotal = max(f1,f2) drives
// core/ring/jet glow; uPulsarBeamDir is current beam direction.
// Palette + geometry frozen.
uniform float uPulsarPhase;
uniform float uFlash1;
uniform float uFlash2;
uniform vec3 uPulsarBeamDir;
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

// Layered pulsar jet beam. `cone`/`scone` are cos/sin of the azimuthal
// deviation from the beam centre; `mu`/`theta` describe the polar angle from
// the pulsar (theta=0 = throat). Returns an additive HDR colour.
vec3 jetBeam(float cone, float scone, float mu, float theta, float time, float pulse, float conePulse) {
    float coneMask = smoothstep(0.93, 1.0, cone) * smoothstep(-0.95, 0.10, mu);
    if (coneMask <= 0.0001) return vec3(0.0);
    float rho = abs(scone); // 0 at axis, ~0.5 at beam edge
    // Longitudinal profile: energetic throat near pulsar, dissipating outward
    // (extended reach toward the far side of the sky).
    float profile = smoothstep(-0.98, 0.10, mu) * pow(clamp((mu + 1.0) * 0.5, 0.0001, 1.0), 0.35);
    // Corkscrew: twist the plasma domain with longitude.
    float L = theta * 3.0;
    float A = scone * 4.0;
    float Atw = A + 1.3 * L;
    // Broad turbulent structure.
    float nBroad = noise2(vec2(Atw * 0.55, L * 0.75 - time * 1.35)) * 0.5 + 0.5;
    // Finer filaments.
    float nFine = noise2(vec2(Atw * 2.4 + 17.3, L * 2.1 - time * 2.9)) * 0.5 + 0.5;
    // Secondary counter-moving drift.
    float nDrift = noise2(vec2(A * 1.1 - 5.7, L * 1.05 + time * 0.55)) * 0.5 + 0.5;
    float turb = nBroad * 0.55 + nFine * 0.30 + nDrift * 0.15;
    turb = smoothstep(0.32, 0.72, turb);
    float filMask = smoothstep(0.62, 0.88, nFine);

    // Radial sheath: soft inner falloff whose edge breathes with turbulence.
    float sheathEdge = 0.26 + 0.10 * turb;
    float sheathRadial = 1.0 - smoothstep(0.0, sheathEdge, rho);
    // Soft atmospheric outer sheath.
    float outerHalo = (1.0 - smoothstep(0.22, 0.62, rho)) * 0.12;
    // Narrow axial spine.
    float spine = exp(-rho * rho * 140.0);

    float sheathDens = sheathRadial * (0.45 + 0.75 * turb) * profile;
    float filamentDens = sheathRadial * filMask * 0.85 * profile;
    float haloDens = outerHalo * (0.75 + 0.35 * nBroad) * profile;

    vec3 colOuter = vec3(0.30, 0.36, 0.82); // blue-violet
    vec3 colInner = vec3(0.22, 0.62, 1.00); // blue-cyan
    vec3 colSpine = vec3(0.85, 0.95, 1.00); // icy white-cyan
    vec3 colHalo = vec3(0.18, 0.28, 0.72); // atmospheric sheath

    vec3 jetColor = mix(colOuter, colInner, smoothstep(0.45, 0.0, rho));
    jetColor = mix(jetColor, colSpine, spine);
    jetColor = mix(jetColor, colHalo, outerHalo * (1.0 - spine));

    float dens = spine * 2.0 + sheathDens * 0.9 + filamentDens * 1.1 + haloDens * 0.5;
    float intensity = coneMask * dens * conePulse * 2.4;
    return jetColor * intensity;
}
void main() {
    vec3 dir = normalize(vDir);

    // Deep-space base.
    float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(vec3(0.02, 0.01, 0.06), vec3(0.005, 0.002, 0.02), up);
    col += vec3(0.0, 0.005, 0.015) * (1.0 - up);

    // Sparse starfield: 3D hash (screen-stable, no crawling). Hyper-bright
    // intensity with color temperature variation for lensing contrast.
    float h = hash33(dir * 180.0 + vec3(17.0, 31.0, 53.0)).x;
    if (h > 0.98) {
        vec3 o = hash33(dir * 180.0 + vec3(97.0, 131.0, 173.0));
        vec3 starDir = normalize(o * 2.0 - 1.0);
        float ang = acos(clamp(dot(dir, starDir), -1.0, 1.0));
        float star = smoothstep(0.004, 0.0, ang);
        float bright = (h - 0.98) * 50.0 + 1.0;
        vec3 starColor = vec3(0.85, 0.9, 1.0);
        if (h < 0.985) starColor = vec3(1.0, 0.5, 0.3);
        else if (h > 0.995) starColor = vec3(0.6, 0.8, 1.0);
        col += starColor * star * bright * 3.0;
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
    float flashTotal = max(uFlash1, uFlash2);
    // Keep a 10% baseline glow even when the beam is away (sunIntensity=0).
    float sunNorm = clamp(sunIntensity / PULSAR_SUN_REF, 0.1, 4.0);
    float expand = 0.6 + 0.4 * flashTotal;
    // Intense white center (pinprick star).
    float exponent = 10000.0 / sqrt(sunNorm);
    float brightness = 20.0 * expand * sunNorm;
    float core = pow(max(mu, 0.0), exponent) * brightness;
    // Synchrotron radiation: bluish-white/UV at core.
    col += vec3(0.7, 0.85, 1.0) * core;
    // Blue nitrogen bloom ring (N2+ emission ~427.8 nm).
    float ringExp = (400.0 / sqrt(sunNorm)) / mix(1.0, 1.6, flashTotal);
    float ringBright = 6.0 * expand * sunNorm;
    float ring = pow(max(mu, 0.0), ringExp) * ringBright;
    col += vec3(0.15, 0.35, 0.95) * ring;

    // Faint accretion disk around the pulsar: flattened ring of
    // interstellar matter, hot inner edge (UV/blue-white) fading to
    // cooler orange at the outer edge. Slight rotational shimmer.
    vec3 diskUp = abs(sunDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 diskX = normalize(cross(sunDir, diskUp));
    vec3 diskY = cross(sunDir, diskX);
    float diskU = dot(dir, diskX);
    float diskV = dot(dir, diskY);
    float diskR = sqrt(diskU * diskU + diskV * diskV);
    float diskAz = atan(diskV, diskU);
    // Disk spans 0.08..0.35 rad from the pulsar core.
    float diskMask = smoothstep(0.06, 0.09, diskR) * (1.0 - smoothstep(0.30, 0.38, diskR));
    // Thin vertical extent: only near the equatorial plane.
    float diskVert = 1.0 - smoothstep(0.0, 0.12, abs(dot(dir, sunDir)));
    diskMask *= diskVert;
    // Temperature gradient: hot inner (UV/blue-white) -> cool outer (orange).
    float tempT = clamp((diskR - 0.08) / 0.27, 0.0, 1.0);
    vec3 diskHot = vec3(0.7, 0.85, 1.0);
    vec3 diskCool = vec3(1.0, 0.55, 0.25);
    vec3 diskCol = mix(diskHot, diskCool, tempT);
    // Rotational shimmer.
    float shimmer = 0.85 + 0.15 * sin(diskAz * 6.0 + time * 1.5);
    float diskAlpha = diskMask * 0.12 * sunNorm * shimmer;
    col += diskCol * diskAlpha;

    // Spinning cones (jets) around the pulsar. Two opposing beams; geometry
    // (cone angle + rotation) is unchanged. The interior is now built from
    // layered plasma: narrow bright spine, broader turbulent sheath, fine
    // filaments, and a subtle corkscrew, all advected along the beam.
    vec3 worldUp = vec3(0.0, 1.0, 0.0);
    vec3 rotAxis = normalize(cross(sunDir, worldUp));
    vec3 perp = normalize(cross(rotAxis, sunDir));
    vec3 perp2 = cross(sunDir, perp);
    float coneAngle = atan(dot(dir, perp2), dot(dir, perp));
    // Retain existing spin rate baseline.
    float coneSpin = uPulsarPhase;
    float cone1 = cos(coneAngle - coneSpin);
    float cone2 = cos(coneAngle - coneSpin + PI);
    float sin1 = sin(coneAngle - coneSpin);
    float sin2 = sin(coneAngle - coneSpin + PI);
    float conePulse1 = 0.5 + 0.5 * uFlash1;
    float conePulse2 = 0.5 + 0.5 * uFlash2;
    float theta = acos(clamp(mu, -1.0, 1.0));
    col += jetBeam(cone1, sin1, mu, theta, time, flashTotal, conePulse1);
    col += jetBeam(cone2, sin2, mu, theta, time, flashTotal, conePulse2);
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