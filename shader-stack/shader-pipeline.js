/**
 * EMDEN NETWORK SHADER STACK — WebGL2 pipeline engine
 *
 * Chain (all passes run at capture resolution unless noted):
 *   0. Upload capture <video> to u_srcTex  (via texImage2D every frame)
 *   1. Bloom threshold  -> pingPong[0] at 1/2 res
 *   2. Gauss blur H     -> pingPong[1] at 1/2 res
 *   3. Gauss blur V     -> pingPong[0] at 1/2 res
 *   4. Bloom combine    -> main[1]
 *   5. SSAO-fake        -> main[0]
 *   6. ACES tonemap     -> main[1]
 *   7. CAS sharpen      -> main[0]
 *   8. Final (CA/vignette/grain) -> screen (no FBO)
 *
 * Expects `window.SHADERS` to be loaded first.
 */
(function (root) {
    'use strict';

    class ShaderPipeline {
        constructor(canvas) {
            this.canvas = canvas;
            const gl = canvas.getContext('webgl2', {
                antialias: false,
                preserveDrawingBuffer: false,
                alpha: false,
            });
            if (!gl) throw new Error('WebGL2 not supported');
            this.gl = gl;

            // Default settings — Realism preset
            this.settings = this.defaultSettings();

            this._startTime = performance.now();
            this._lastSrc = { w: 0, h: 0 };

            this._initQuad();
            this._initPrograms();
            this._initTextures();
        }

        defaultSettings() {
            return {
                enabled: true,
                exposure: 1.0,
                saturation: 1.05,
                contrast: 1.08,
                bloomThreshold: 0.85,
                bloomKnee: 0.2,
                bloomIntensity: 0.45,
                ssaoIntensity: 0.35,
                ssaoRadius: 1.5,
                sharpness: 0.4,
                chromaticAberration: 0.0025,
                vignette: 0.35,
                grain: 0.025,
            };
        }

        setSettings(next) {
            Object.assign(this.settings, next || {});
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
            const gl = this.gl;
            // Source texture (video upload target)
            this.srcTex = this._makeTex(16, 16);
            // Main ping-pong FBOs (full res)
            this.mainA = this._makeFBO(16, 16);
            this.mainB = this._makeFBO(16, 16);
            // Bloom ping-pong FBOs (half res)
            this.bloomA = this._makeFBO(16, 16);
            this.bloomB = this._makeFBO(16, 16);
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

        _resize(w, h) {
            if (this._lastSrc.w === w && this._lastSrc.h === h) return;
            this._lastSrc = { w, h };
            this.canvas.width = w;
            this.canvas.height = h;
            this._resizeFBO(this.mainA, w, h);
            this._resizeFBO(this.mainB, w, h);
            const bw = Math.max(64, Math.floor(w / 2));
            const bh = Math.max(64, Math.floor(h / 2));
            this._resizeFBO(this.bloomA, bw, bh);
            this._resizeFBO(this.bloomB, bw, bh);
        }

        _uploadSrc(video) {
            const gl = this.gl;
            const w = video.videoWidth;
            const h = video.videoHeight;
            if (!w || !h) return false;
            this._resize(w, h);
            gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
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
            const loc = gl.getUniformLocation(prog, 'u_tex');
            if (loc) gl.uniform1i(loc, 0);
            if (setUniforms) setUniforms(gl, prog);
            gl.bindVertexArray(this._vao);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }

        render(video) {
            if (!this._uploadSrc(video)) return;
            const s = this.settings;
            const gl = this.gl;
            const w = this._lastSrc.w;
            const h = this._lastSrc.h;
            const bw = this.bloomA.w;
            const bh = this.bloomA.h;

            if (!s.enabled) {
                // Passthrough to canvas
                this._bindFBO(null);
                this._drawWithTex(this.progCopy, this.srcTex);
                return;
            }

            // 1. Bloom threshold (src -> bloomA)
            this._bindFBO(this.bloomA);
            this._drawWithTex(this.progBloomThresh, this.srcTex, (gl, p) => {
                gl.uniform1f(gl.getUniformLocation(p, 'u_threshold'), s.bloomThreshold);
                gl.uniform1f(gl.getUniformLocation(p, 'u_knee'), s.bloomKnee);
            });

            // 2. Blur horizontal (bloomA -> bloomB)
            this._bindFBO(this.bloomB);
            this._drawWithTex(this.progBlur, this.bloomA.tex, (gl, p) => {
                gl.uniform2f(gl.getUniformLocation(p, 'u_texel'), 1 / bw, 1 / bh);
                gl.uniform2f(gl.getUniformLocation(p, 'u_dir'), 1, 0);
            });

            // 3. Blur vertical (bloomB -> bloomA)
            this._bindFBO(this.bloomA);
            this._drawWithTex(this.progBlur, this.bloomB.tex, (gl, p) => {
                gl.uniform2f(gl.getUniformLocation(p, 'u_texel'), 1 / bw, 1 / bh);
                gl.uniform2f(gl.getUniformLocation(p, 'u_dir'), 0, 1);
            });

            // 4. Bloom combine (src + bloomA -> mainA)
            this._bindFBO(this.mainA);
            gl.useProgram(this.progBloomCombine);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
            gl.uniform1i(gl.getUniformLocation(this.progBloomCombine, 'u_base'), 0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
            gl.uniform1i(gl.getUniformLocation(this.progBloomCombine, 'u_bloom'), 1);
            gl.uniform1f(gl.getUniformLocation(this.progBloomCombine, 'u_intensity'), s.bloomIntensity);
            gl.bindVertexArray(this._vao);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            // 5. SSAO-fake (mainA -> mainB)
            this._bindFBO(this.mainB);
            this._drawWithTex(this.progSSAO, this.mainA.tex, (gl, p) => {
                gl.uniform2f(gl.getUniformLocation(p, 'u_texel'), 1 / w, 1 / h);
                gl.uniform1f(gl.getUniformLocation(p, 'u_intensity'), s.ssaoIntensity);
                gl.uniform1f(gl.getUniformLocation(p, 'u_radius'), s.ssaoRadius);
            });

            // 6. ACES tonemap (mainB -> mainA)
            this._bindFBO(this.mainA);
            this._drawWithTex(this.progACES, this.mainB.tex, (gl, p) => {
                gl.uniform1f(gl.getUniformLocation(p, 'u_exposure'), s.exposure);
                gl.uniform1f(gl.getUniformLocation(p, 'u_saturation'), s.saturation);
                gl.uniform1f(gl.getUniformLocation(p, 'u_contrast'), s.contrast);
            });

            // 7. CAS sharpen (mainA -> mainB)
            this._bindFBO(this.mainB);
            this._drawWithTex(this.progCAS, this.mainA.tex, (gl, p) => {
                gl.uniform2f(gl.getUniformLocation(p, 'u_texel'), 1 / w, 1 / h);
                gl.uniform1f(gl.getUniformLocation(p, 'u_sharpness'), s.sharpness);
            });

            // 8. Final to screen
            this._bindFBO(null);
            const elapsed = (performance.now() - this._startTime) / 1000;
            this._drawWithTex(this.progFinal, this.mainB.tex, (gl, p) => {
                gl.uniform1f(gl.getUniformLocation(p, 'u_ca'), s.chromaticAberration);
                gl.uniform1f(gl.getUniformLocation(p, 'u_vignette'), s.vignette);
                gl.uniform1f(gl.getUniformLocation(p, 'u_grain'), s.grain);
                gl.uniform1f(gl.getUniformLocation(p, 'u_time'), elapsed);
                gl.uniform2f(gl.getUniformLocation(p, 'u_resolution'), w, h);
            });
        }
    }

    root.ShaderPipeline = ShaderPipeline;
})(typeof window !== 'undefined' ? window : globalThis);
