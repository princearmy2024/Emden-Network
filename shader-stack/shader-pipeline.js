/**
 * EMDEN NETWORK SHADER STACK — WebGL2 pipeline engine
 *
 * Chain (all passes run at target render resolution):
 *   source video -> 2D canvas (fixes YUV→RGB green-stripe bug)
 *                -> srcTex upload
 *   1. Bloom threshold  -> bloomA (1/2 res)
 *   2. Blur H           -> bloomB (1/2 res)
 *   3. Blur V           -> bloomA (1/2 res)
 *   4. Bloom combine    -> mainA
 *   5. SSAO-fake        -> mainB
 *   6. ACES tonemap     -> mainA
 *   7. CAS sharpen      -> mainB
 *   8. Final (CA/vignette/grain) -> screen
 *
 * Passes 1-4, 5, 7 are SKIPPED when their intensity is 0 (copy instead).
 *
 * Auto-Atmosphere: every ~500ms downsample to 16x16, readPixels, compute
 * mean luminance + color cast. Smoothly drift effective exposure,
 * saturation, contrast, and a warmth offset toward scene-adaptive targets.
 */
(function (root) {
    'use strict';

    // Three quality tiers — user picks via overlay UI
    const RENDER_RES = {
        performance: 1280, // 720p-ish (capped to capture aspect)
        balanced:    1920, // 1080p
        quality:     0,    // native capture resolution
    };

    class ShaderPipeline {
        constructor(canvas) {
            this.canvas = canvas;
            const gl = canvas.getContext('webgl2', {
                antialias: false,
                preserveDrawingBuffer: false,
                alpha: false,
                premultipliedAlpha: false,
                powerPreference: 'high-performance',
            });
            if (!gl) throw new Error('WebGL2 not supported');
            this.gl = gl;
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);

            this.settings = this.defaultSettings();
            this.renderMode = 'performance';
            this.autoAtmosphere = false;
            // 2D canvas bridge fixes YUV420→RGB green-pixel artifacts from desktopCapturer.
            // desynchronized: low-latency path, drawImage hits GPU when video is accelerated.
            this.safeUpload = true;
            this._bridge = document.createElement('canvas');
            this._bridgeCtx = this._bridge.getContext('2d', {
                alpha: false,
                desynchronized: true,
                willReadFrequently: false,
            });
            this._bridgeCtx.imageSmoothingEnabled = true;
            this._bridgeCtx.imageSmoothingQuality = 'medium';

            // Cached uniform locations per program (key: 'progName:uniformName')
            this._uloc = new Map();

            // Auto-Atmosphere state
            this._autoLuma = 0.5;
            this._autoWarmth = 0.0;  // -1..+1 (cool..warm scene cast)
            this._autoChromaVariance = 0.3;
            this._autoLastSample = 0;
            this._autoSampleBuf = new Uint8Array(16 * 16 * 4);
            this._autoFBO = null;

            // Effective uniforms (user settings + atmosphere delta)
            this._fx = { ...this.settings };

            this._startTime = performance.now();
            this._lastSrc = { w: 0, h: 0 };
            this._lastRender = { w: 0, h: 0 };
            this._frameCount = 0;

            this._initQuad();
            this._initPrograms();
            this._initTextures();
        }

        defaultSettings() {
            return {
                enabled: true,
                exposure: 1.0,
                saturation: 1.02,
                contrast: 1.04,
                bloomThreshold: 0.85,
                bloomKnee: 0.2,
                bloomIntensity: 0.15,
                ssaoIntensity: 0.2,
                ssaoRadius: 1.2,
                sharpness: 0.25,
                chromaticAberration: 0.0005,
                vignette: 0.2,
                grain: 0.01,
            };
        }

        setSettings(next) {
            Object.assign(this.settings, next || {});
        }

        setRenderMode(mode) {
            if (RENDER_RES[mode] !== undefined) this.renderMode = mode;
        }

        setAutoAtmosphere(on) {
            this.autoAtmosphere = !!on;
        }

        _initQuad() {
            const gl = this.gl;
            const vao = gl.createVertexArray();
            gl.bindVertexArray(vao);
            const buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                -1, -1,  1, -1,  -1, 1,
                -1,  1,  1, -1,   1, 1,
            ]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            this._vao = vao;
        }

        _compile(vsSrc, fsSrc) {
            const gl = this.gl;
            const vs = gl.createShader(gl.VERTEX_SHADER);
            gl.shaderSource(vs, vsSrc);
            gl.compileShader(vs);
            if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
                throw new Error('VS compile: ' + gl.getShaderInfoLog(vs));
            }
            const fs = gl.createShader(gl.FRAGMENT_SHADER);
            gl.shaderSource(fs, fsSrc);
            gl.compileShader(fs);
            if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
                throw new Error('FS compile: ' + gl.getShaderInfoLog(fs));
            }
            const prog = gl.createProgram();
            gl.attachShader(prog, vs);
            gl.attachShader(prog, fs);
            gl.bindAttribLocation(prog, 0, 'a_pos');
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                throw new Error('Link: ' + gl.getProgramInfoLog(prog));
            }
            return prog;
        }

        // Cached getUniformLocation — called per program-uniform once, then free.
        _u(prog, name) {
            const key = prog + ':' + name;
            let loc = this._uloc.get(key);
            if (loc === undefined) {
                loc = this.gl.getUniformLocation(prog, name);
                this._uloc.set(key, loc);
            }
            return loc;
        }

        _initPrograms() {
            const S = root.SHADERS;
            this.progCopy = this._compile(S.VS_FULLSCREEN, S.FS_COPY);
            this.progBloomThresh = this._compile(S.VS_FULLSCREEN, S.FS_BLOOM_THRESHOLD);
            this.progBlur = this._compile(S.VS_FULLSCREEN, S.FS_GAUSS_BLUR);
            this.progBloomCombine = this._compile(S.VS_FULLSCREEN, S.FS_BLOOM_COMBINE);
            this.progSSAO = this._compile(S.VS_FULLSCREEN, S.FS_SSAO_FAKE);
            this.progACES = this._compile(S.VS_FULLSCREEN, S.FS_ACES_TONEMAP);
            this.progCAS = this._compile(S.VS_FULLSCREEN, S.FS_CAS_SHARPEN);
            this.progFinal = this._compile(S.VS_FULLSCREEN, S.FS_FINAL);
        }

        _initTextures() {
            this.srcTex = this._makeTex(16, 16);
            this.mainA = this._makeFBO(16, 16);
            this.mainB = this._makeFBO(16, 16);
            this.bloomA = this._makeFBO(16, 16);
            this.bloomB = this._makeFBO(16, 16);
            this._autoFBO = this._makeFBO(16, 16);
        }

        _makeTex(w, h) {
            const gl = this.gl;
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        }

        _makeFBO(w, h) {
            const gl = this.gl;
            const tex = this._makeTex(w, h);
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            return { tex, fbo, w, h };
        }

        _resizeFBO(fbo, w, h) {
            if (fbo.w === w && fbo.h === h) return;
            const gl = this.gl;
            gl.bindTexture(gl.TEXTURE_2D, fbo.tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            fbo.w = w;
            fbo.h = h;
        }

        // Compute target render resolution given source + mode
        _computeRenderRes(srcW, srcH) {
            const cap = RENDER_RES[this.renderMode] || 0;
            if (!cap || srcW <= cap) return { w: srcW, h: srcH };
            const scale = cap / srcW;
            return { w: cap, h: Math.round(srcH * scale) };
        }

        _resize(srcW, srcH) {
            const { w, h } = this._computeRenderRes(srcW, srcH);
            this._lastSrc = { w: srcW, h: srcH };

            if (this._lastRender.w === w && this._lastRender.h === h) return;
            this._lastRender = { w, h };

            this.canvas.width = w;
            this.canvas.height = h;
            if (this._bridge) { this._bridge.width = w; this._bridge.height = h; }

            this._resizeFBO(this.mainA, w, h);
            this._resizeFBO(this.mainB, w, h);
            const bw = Math.max(64, Math.floor(w / 2));
            const bh = Math.max(64, Math.floor(h / 2));
            this._resizeFBO(this.bloomA, bw, bh);
            this._resizeFBO(this.bloomB, bw, bh);
            this._resizeFBO(this._autoFBO, 16, 16);
        }

        setSafeUpload(on) {
            this.safeUpload = !!on;
            if (this.safeUpload && !this._bridge) {
                this._bridge = document.createElement('canvas');
                this._bridgeCtx = this._bridge.getContext('2d', { alpha: false, willReadFrequently: false });
                this._bridge.width = this._lastRender.w || 1280;
                this._bridge.height = this._lastRender.h || 720;
            }
        }

        _uploadSrc(video) {
            const gl = this.gl;
            const w = video.videoWidth;
            const h = video.videoHeight;
            if (!w || !h) return false;
            this._resize(w, h);

            gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

            if (this.safeUpload && this._bridge) {
                // Safe Mode: 2D canvas bridge (only if green stripes return on some drivers)
                this._bridgeCtx.drawImage(video, 0, 0, this._lastRender.w, this._lastRender.h);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._bridge);
            } else {
                // Fast path: direct video → GPU texture (GPU-to-GPU copy if possible)
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
            }
            return true;
        }

        _bindFBO(fbo) {
            const gl = this.gl;
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo ? fbo.fbo : null);
            gl.viewport(0, 0, fbo ? fbo.w : this.canvas.width, fbo ? fbo.h : this.canvas.height);
        }

        _drawWithTex(prog, tex, setUniforms) {
            const gl = this.gl;
            gl.useProgram(prog);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            const loc = this._u(prog, 'u_tex');
            if (loc) gl.uniform1i(loc, 0);
            if (setUniforms) setUniforms(gl, prog, this);
            gl.bindVertexArray(this._vao);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }

        // Sample 16x16 downsample, readPixels, compute scene statistics
        _sampleScene() {
            const gl = this.gl;
            // Downsample current srcTex -> 16x16 FBO
            this._bindFBO(this._autoFBO);
            this._drawWithTex(this.progCopy, this.srcTex);
            gl.readPixels(0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, this._autoSampleBuf);

            let rSum = 0, gSum = 0, bSum = 0, lumaSum = 0;
            const n = 16 * 16;
            for (let i = 0; i < n; i++) {
                const r = this._autoSampleBuf[i * 4] / 255;
                const g = this._autoSampleBuf[i * 4 + 1] / 255;
                const b = this._autoSampleBuf[i * 4 + 2] / 255;
                rSum += r; gSum += g; bSum += b;
                lumaSum += r * 0.2126 + g * 0.7152 + b * 0.0722;
            }
            const rMean = rSum / n;
            const gMean = gSum / n;
            const bMean = bSum / n;
            const lumaMean = lumaSum / n;
            // Warmth: positive if red > blue (sunset/dusk), negative if blue > red (daytime sky)
            const warmth = (rMean - bMean);
            const chromaVariance = Math.abs(rMean - gMean) + Math.abs(gMean - bMean) + Math.abs(rMean - bMean);
            return { luma: lumaMean, warmth, chromaVariance };
        }

        _tickAutoAtmosphere(now) {
            if (!this.autoAtmosphere) return;
            if (now - this._autoLastSample < 500) return;
            this._autoLastSample = now;

            const s = this._sampleScene();
            // EMA smoothing
            const k = 0.35;
            this._autoLuma = this._autoLuma * (1 - k) + s.luma * k;
            this._autoWarmth = this._autoWarmth * (1 - k) + s.warmth * k;
            this._autoChromaVariance = this._autoChromaVariance * (1 - k) + s.chromaVariance * k;
        }

        // Apply atmosphere adjustments on top of user settings -> this._fx
        _computeEffectiveSettings() {
            const s = this.settings;
            const fx = this._fx;
            // Copy user settings first
            fx.enabled = s.enabled;
            fx.exposure = s.exposure;
            fx.saturation = s.saturation;
            fx.contrast = s.contrast;
            fx.bloomThreshold = s.bloomThreshold;
            fx.bloomKnee = s.bloomKnee;
            fx.bloomIntensity = s.bloomIntensity;
            fx.ssaoIntensity = s.ssaoIntensity;
            fx.ssaoRadius = s.ssaoRadius;
            fx.sharpness = s.sharpness;
            fx.chromaticAberration = s.chromaticAberration;
            fx.vignette = s.vignette;
            fx.grain = s.grain;

            if (!this.autoAtmosphere) return;

            // Auto-exposure toward 0.45 mean luma
            const targetLuma = 0.45;
            const exposureCorrect = targetLuma / Math.max(this._autoLuma, 0.05);
            // clamp auto correction to [0.6, 1.6]
            const autoExp = Math.max(0.6, Math.min(1.6, exposureCorrect));
            fx.exposure = Math.max(0.4, Math.min(2.0, s.exposure * autoExp));

            // Auto warmth adjustment via bloom threshold shift (cheap cinematic hint)
            // When scene is dark and blue (night), lift bloom threshold slightly
            if (this._autoLuma < 0.25) {
                fx.bloomThreshold = Math.max(0.6, s.bloomThreshold - 0.1);
                fx.saturation = Math.min(1.3, s.saturation * 1.05);
            } else if (this._autoWarmth > 0.08) {
                // Sunset/warm scene -> boost saturation slightly, more bloom
                fx.saturation = Math.min(1.3, s.saturation * 1.08);
                fx.bloomIntensity = Math.min(0.8, s.bloomIntensity * 1.2);
            } else if (this._autoWarmth < -0.05) {
                // Cool/daytime -> slight desat, higher contrast
                fx.saturation = s.saturation * 0.98;
                fx.contrast = Math.min(1.3, s.contrast * 1.04);
            }
        }

        render(video, nowMs) {
            if (!this._uploadSrc(video)) return;
            this._frameCount++;

            const now = nowMs || performance.now();
            this._tickAutoAtmosphere(now);
            this._computeEffectiveSettings();

            const s = this._fx;
            const gl = this.gl;
            const w = this._lastRender.w;
            const h = this._lastRender.h;

            if (!s.enabled) {
                this._bindFBO(null);
                this._drawWithTex(this.progCopy, this.srcTex);
                return;
            }

            // Pass-skip logic: if intensity is basically 0, just copy
            const doBloom = s.bloomIntensity > 0.01;
            const doSSAO  = s.ssaoIntensity  > 0.01;
            const doCAS   = s.sharpness      > 0.01;
            const doFinal = s.chromaticAberration > 0.0001 || s.vignette > 0.01 || s.grain > 0.001;

            let current; // FBO that currently holds the latest image

            if (doBloom) {
                const bw = this.bloomA.w, bh = this.bloomA.h;
                this._bindFBO(this.bloomA);
                this._drawWithTex(this.progBloomThresh, this.srcTex, (gl, p) => {
                    gl.uniform1f(this._u(p,'u_threshold'), s.bloomThreshold);
                    gl.uniform1f(this._u(p,'u_knee'), s.bloomKnee);
                });
                this._bindFBO(this.bloomB);
                this._drawWithTex(this.progBlur, this.bloomA.tex, (gl, p) => {
                    gl.uniform2f(this._u(p,'u_texel'), 1 / bw, 1 / bh);
                    gl.uniform2f(this._u(p,'u_dir'), 1, 0);
                });
                this._bindFBO(this.bloomA);
                this._drawWithTex(this.progBlur, this.bloomB.tex, (gl, p) => {
                    gl.uniform2f(this._u(p,'u_texel'), 1 / bw, 1 / bh);
                    gl.uniform2f(this._u(p,'u_dir'), 0, 1);
                });
                // Combine
                this._bindFBO(this.mainA);
                gl.useProgram(this.progBloomCombine);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
                gl.uniform1i(this._u(this.progBloomCombine, 'u_base'), 0);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
                gl.uniform1i(this._u(this.progBloomCombine, 'u_bloom'), 1);
                gl.uniform1f(this._u(this.progBloomCombine, 'u_intensity'), s.bloomIntensity);
                gl.bindVertexArray(this._vao);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
                current = this.mainA;
            } else {
                // Skip bloom - copy src to mainA
                this._bindFBO(this.mainA);
                this._drawWithTex(this.progCopy, this.srcTex);
                current = this.mainA;
            }

            if (doSSAO) {
                const next = current === this.mainA ? this.mainB : this.mainA;
                this._bindFBO(next);
                this._drawWithTex(this.progSSAO, current.tex, (gl, p) => {
                    gl.uniform2f(this._u(p,'u_texel'), 1 / w, 1 / h);
                    gl.uniform1f(this._u(p,'u_intensity'), s.ssaoIntensity);
                    gl.uniform1f(this._u(p,'u_radius'), s.ssaoRadius);
                });
                current = next;
            }

            // ACES tonemap (always run — handles exposure/saturation/contrast)
            const next1 = current === this.mainA ? this.mainB : this.mainA;
            this._bindFBO(next1);
            this._drawWithTex(this.progACES, current.tex, (gl, p) => {
                gl.uniform1f(this._u(p,'u_exposure'), s.exposure);
                gl.uniform1f(this._u(p,'u_saturation'), s.saturation);
                gl.uniform1f(this._u(p,'u_contrast'), s.contrast);
            });
            current = next1;

            if (doCAS) {
                const next2 = current === this.mainA ? this.mainB : this.mainA;
                this._bindFBO(next2);
                this._drawWithTex(this.progCAS, current.tex, (gl, p) => {
                    gl.uniform2f(this._u(p,'u_texel'), 1 / w, 1 / h);
                    gl.uniform1f(this._u(p,'u_sharpness'), s.sharpness);
                });
                current = next2;
            }

            if (doFinal) {
                this._bindFBO(null);
                const elapsed = (now - this._startTime) / 1000;
                this._drawWithTex(this.progFinal, current.tex, (gl, p) => {
                    gl.uniform1f(this._u(p,'u_ca'), s.chromaticAberration);
                    gl.uniform1f(this._u(p,'u_vignette'), s.vignette);
                    gl.uniform1f(this._u(p,'u_grain'), s.grain);
                    gl.uniform1f(this._u(p,'u_time'), elapsed);
                    gl.uniform2f(this._u(p,'u_resolution'), w, h);
                });
            } else {
                this._bindFBO(null);
                this._drawWithTex(this.progCopy, current.tex);
            }
        }

        // Diagnostic: report scene stats + rendered resolution
        getStats() {
            return {
                srcW: this._lastSrc.w,
                srcH: this._lastSrc.h,
                renderW: this._lastRender.w,
                renderH: this._lastRender.h,
                autoLuma: this._autoLuma,
                autoWarmth: this._autoWarmth,
            };
        }
    }

    root.ShaderPipeline = ShaderPipeline;
})(typeof window !== 'undefined' ? window : globalThis);
