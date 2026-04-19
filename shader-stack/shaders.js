/**
 * EMDEN NETWORK SHADER STACK — Shader definitions
 *
 * Realism-focused post-processing chain:
 *   capture -> [Bloom threshold -> blur H -> blur V] -> composite
 *            -> SSAO-fake -> ACES tonemap -> CAS sharpen
 *            -> chromatic aberration + film grain + vignette -> output
 *
 * Exposed as `window.SHADERS` for the shader-window browser context.
 */
(function (root) {
    'use strict';

    const VS_FULLSCREEN = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

    const FS_COPY = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
    outColor = texture(u_tex, v_uv);
}`;

    const FS_BLOOM_THRESHOLD = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_threshold;
uniform float u_knee;
out vec4 outColor;
void main() {
    vec3 c = texture(u_tex, v_uv).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float soft = clamp(lum - u_threshold + u_knee, 0.0, u_knee * 2.0);
    soft = soft * soft / max(4.0 * u_knee, 0.0001);
    float contribution = max(soft, lum - u_threshold);
    contribution /= max(lum, 0.0001);
    outColor = vec4(c * contribution, 1.0);
}`;

    const FS_GAUSS_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform vec2 u_dir;
out vec4 outColor;
void main() {
    float w[5];
    w[0] = 0.227027;
    w[1] = 0.1945946;
    w[2] = 0.1216216;
    w[3] = 0.054054;
    w[4] = 0.016216;
    vec3 acc = texture(u_tex, v_uv).rgb * w[0];
    for (int i = 1; i < 5; i++) {
        vec2 off = u_dir * u_texel * float(i);
        acc += texture(u_tex, v_uv + off).rgb * w[i];
        acc += texture(u_tex, v_uv - off).rgb * w[i];
    }
    outColor = vec4(acc, 1.0);
}`;

    const FS_BLOOM_COMBINE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_base;
uniform sampler2D u_bloom;
uniform float u_intensity;
out vec4 outColor;
void main() {
    vec3 base = texture(u_base, v_uv).rgb;
    vec3 bloom = texture(u_bloom, v_uv).rgb;
    outColor = vec4(base + bloom * u_intensity, 1.0);
}`;

    const FS_SSAO_FAKE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_intensity;
uniform float u_radius;
out vec4 outColor;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
    vec3 center = texture(u_tex, v_uv).rgb;
    float cl = luma(center);
    float darker = 0.0;
    for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.78539816;
        vec2 off = vec2(cos(a), sin(a)) * u_texel * u_radius;
        float nl = luma(texture(u_tex, v_uv + off).rgb);
        darker += max(0.0, cl - nl - 0.04);
    }
    float ao = clamp(darker * 0.5, 0.0, 1.0);
    vec3 outCol = center * (1.0 - ao * u_intensity);
    outColor = vec4(outCol, 1.0);
}`;

    const FS_ACES_TONEMAP = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_exposure;
uniform float u_saturation;
uniform float u_contrast;
out vec4 outColor;

vec3 acesTonemap(vec3 c) {
    const float a = 2.51;
    const float b = 0.03;
    const float c_ = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((c * (a * c + b)) / (c * (c_ * c + d) + e), 0.0, 1.0);
}

void main() {
    vec3 col = texture(u_tex, v_uv).rgb;
    col *= u_exposure;
    col = acesTonemap(col);
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(lum), col, u_saturation);
    col = (col - 0.5) * u_contrast + 0.5;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    const FS_CAS_SHARPEN = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_sharpness;
out vec4 outColor;

void main() {
    vec3 c  = texture(u_tex, v_uv).rgb;
    vec3 n  = texture(u_tex, v_uv + vec2(0.0, -u_texel.y)).rgb;
    vec3 s  = texture(u_tex, v_uv + vec2(0.0,  u_texel.y)).rgb;
    vec3 e  = texture(u_tex, v_uv + vec2( u_texel.x, 0.0)).rgb;
    vec3 w  = texture(u_tex, v_uv + vec2(-u_texel.x, 0.0)).rgb;

    vec3 mn = min(min(min(min(n, s), e), w), c);
    vec3 mx = max(max(max(max(n, s), e), w), c);
    vec3 rcp = 1.0 / max(mx, vec3(0.0001));
    vec3 amp = clamp(min(mn, 2.0 - mx) * rcp, 0.0, 1.0);
    amp = sqrt(amp);
    float peak = -3.0 * mix(0.125, 0.2, u_sharpness);
    vec3 weight = amp / peak;
    vec3 result = (n + s + e + w) * weight + c;
    result /= (4.0 * weight + 1.0);
    outColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}`;

    const FS_FINAL = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_ca;
uniform float u_vignette;
uniform float u_grain;
uniform float u_time;
uniform vec2 u_resolution;
out vec4 outColor;

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

void main() {
    vec2 uv = v_uv;
    vec2 center = uv - 0.5;
    float dist = length(center);

    vec2 caOff = center * u_ca * (0.5 + dist);
    float r = texture(u_tex, uv + caOff).r;
    float g = texture(u_tex, uv).g;
    float b = texture(u_tex, uv - caOff).b;
    vec3 col = vec3(r, g, b);

    float vig = smoothstep(0.4, 0.95, dist);
    col *= 1.0 - vig * u_vignette;

    float n = hash(uv * u_resolution + u_time * 7.3) - 0.5;
    col += n * u_grain;

    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    root.SHADERS = {
        VS_FULLSCREEN,
        FS_COPY,
        FS_BLOOM_THRESHOLD,
        FS_GAUSS_BLUR,
        FS_BLOOM_COMBINE,
        FS_SSAO_FAKE,
        FS_ACES_TONEMAP,
        FS_CAS_SHARPEN,
        FS_FINAL,
    };
})(typeof window !== 'undefined' ? window : globalThis);
