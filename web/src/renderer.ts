/**
 * Minimal ShaderToy-style runner: wraps a `mainImage` fragment shader
 * body with the standard uniforms and a full-screen triangle, with
 * defensive compile/link error reporting (the original app swallowed
 * shader errors into the console only).
 */

const VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const VERTEX_SRC_GL1 = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

export interface RenderError {
  stage: "vertex" | "fragment" | "link";
  log: string;
  /**
   * 1-indexed line, within the *wrapped* fragment source, where the
   * caller's own `fragmentBody` begins — lets a consumer translate a
   * driver's `ERROR: 0:N: ...` line number (which counts from the top
   * of the wrapped source, header included) back to a line within the
   * code the user actually sees in an editor. Only set for fragment
   * compile errors; link errors don't reliably reference a single line.
   */
  bodyStartLine?: number;
}

export class ShaderRunner {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | WebGLRenderingContext;
  private isGL2: boolean;
  private program: WebGLProgram | null = null;
  private rafId = 0;
  private startTime = performance.now();
  private paused = false;
  private mouse = { x: 0, y: 0, downX: 0, downY: 0, down: false };
  private frame = 0;
  private lastFpsSample = performance.now();
  private fpsAccum = 0;
  public onFps: ((fps: number) => void) | null = null;
  public onError: ((err: RenderError | null) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl2 = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (gl2) {
      this.gl = gl2;
      this.isGL2 = true;
    } else {
      const gl1 =
        (canvas.getContext("webgl", { antialias: true, alpha: false }) as WebGLRenderingContext | null) ||
        (canvas.getContext("experimental-webgl", { antialias: true, alpha: false }) as WebGLRenderingContext | null);
      if (!gl1) throw new Error("WebGL non disponible sur ce navigateur.");
      this.gl = gl1;
      this.isGL2 = false;
    }

    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );

    canvas.addEventListener("pointerdown", (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.down = true;
      this.mouse.downX = ((e.clientX - r.left) / r.width) * canvas.width;
      this.mouse.downY = (1 - (e.clientY - r.top) / r.height) * canvas.height;
    });
    window.addEventListener("pointerup", () => {
      this.mouse.down = false;
    });
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - r.left) / r.width) * canvas.width;
      this.mouse.y = (1 - (e.clientY - r.top) / r.height) * canvas.height;
    });
  }

  private compile(source: string, type: number, bodyStartLine?: number): WebGLShader | null {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || "erreur de compilation inconnue";
      gl.deleteShader(shader);
      throw { stage: type === gl.VERTEX_SHADER ? "vertex" : "fragment", log, bodyStartLine } as RenderError;
    }
    return shader;
  }

  /** Wraps a `mainImage`-shaped fragment body with the uniform header and entry point. */
  private buildFullFsSource(fragmentBody: string): { source: string; bodyStartLine: number } {
    // iChannel0-3 are declared even though this single-pass runner never
    // binds anything to them — lets a shader written for Shadertoy (which
    // very commonly samples iChannel0 for noise/textures even outside
    // multi-buffer projects) at least *compile* here instead of failing
    // on an undeclared identifier. Unbound samplers read as black, which
    // beats an outright compile error for a shader this runner was never
    // going to texture correctly anyway. See `MultiPassRunner` below for
    // the real multi-buffer/channel-wiring renderer.
    const precisionHeader = this.isGL2
      ? `#version 300 es\nprecision highp float;\nuniform vec3 iResolution;\nuniform float iTime;\nuniform float iTimeDelta;\nuniform int iFrame;\nuniform vec4 iMouse;\nuniform sampler2D iChannel0;\nuniform sampler2D iChannel1;\nuniform sampler2D iChannel2;\nuniform sampler2D iChannel3;\nout vec4 outColor;\n`
      : `precision highp float;\nuniform vec3 iResolution;\nuniform float iTime;\nuniform float iTimeDelta;\nuniform int iFrame;\nuniform vec4 iMouse;\nuniform sampler2D iChannel0;\nuniform sampler2D iChannel1;\nuniform sampler2D iChannel2;\nuniform sampler2D iChannel3;\n`;

    const entry = this.isGL2
      ? `\nvoid main(){ vec4 c; mainImage(c, gl_FragCoord.xy); outColor = c; }\n`
      : `\nvoid main(){ vec4 c; mainImage(c, gl_FragCoord.xy); gl_FragColor = c; }\n`;

    // A header ending in "...;\n" followed immediately by `fragmentBody`
    // means the body's own first line is the line right after the last
    // header newline — i.e. the header's newline count, 1-indexed.
    const bodyStartLine = precisionHeader.split("\n").length;
    return { source: precisionHeader + fragmentBody + entry, bodyStartLine };
  }

  /**
   * Compiles and links `fragmentBody` as a throwaway check — never
   * installs it as the active program, never touches viewport state.
   * Used to tell "this shader was already broken before golfing" apart
   * from "golfing broke this shader", by compiling both the original
   * and golfed source and comparing which one(s) fail.
   */
  tryCompile(fragmentBody: string): RenderError | null {
    const gl = this.gl;
    const { source: fullFsSource, bodyStartLine } = this.buildFullFsSource(fragmentBody);
    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    let program: WebGLProgram | null = null;
    try {
      vs = this.compile(this.isGL2 ? VERTEX_SRC : VERTEX_SRC_GL1, gl.VERTEX_SHADER);
      fs = this.compile(fullFsSource, gl.FRAGMENT_SHADER, bodyStartLine);
      program = gl.createProgram()!;
      gl.attachShader(program, vs!);
      gl.attachShader(program, fs!);
      if (!this.isGL2) {
        gl.bindAttribLocation(program, 0, "position");
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) || "erreur de link inconnue";
        throw { stage: "link", log } as RenderError;
      }
      return null;
    } catch (err) {
      return err as RenderError;
    } finally {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      if (program) gl.deleteProgram(program);
    }
  }

  /** (Re)compiles and links the given `mainImage`-shaped fragment body. */
  load(fragmentBody: string): boolean {
    const gl = this.gl;
    const { source: fullFsSource, bodyStartLine } = this.buildFullFsSource(fragmentBody);

    try {
      const vs = this.compile(this.isGL2 ? VERTEX_SRC : VERTEX_SRC_GL1, gl.VERTEX_SHADER);
      const fs = this.compile(fullFsSource, gl.FRAGMENT_SHADER, bodyStartLine);
      const program = gl.createProgram()!;
      gl.attachShader(program, vs!);
      gl.attachShader(program, fs!);
      if (!this.isGL2) {
        gl.bindAttribLocation(program, 0, "position");
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) || "erreur de link inconnue";
        throw { stage: "link", log } as RenderError;
      }

      if (this.program) gl.deleteProgram(this.program);
      this.program = program;
      gl.useProgram(program);
      const posAttr = gl.getAttribLocation(program, "position");
      gl.enableVertexAttribArray(posAttr);
      gl.vertexAttribPointer(posAttr, 2, gl.FLOAT, false, 0, 0);

      this.startTime = performance.now();
      this.frame = 0;
      this.onError?.(null);
      return true;
    } catch (err) {
      this.onError?.(err as RenderError);
      return false;
    }
  }

  resize(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  start(): void {
    const gl = this.gl;
    let lastTime = performance.now();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      if (!this.program) return;
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      if (this.paused) return;

      const elapsed = (now - this.startTime) / 1000;
      gl.useProgram(this.program);
      gl.uniform3f(
        gl.getUniformLocation(this.program, "iResolution"),
        this.canvas.width,
        this.canvas.height,
        1,
      );
      gl.uniform1f(gl.getUniformLocation(this.program, "iTime"), elapsed);
      gl.uniform1f(gl.getUniformLocation(this.program, "iTimeDelta"), dt);
      gl.uniform1i(gl.getUniformLocation(this.program, "iFrame"), this.frame);
      gl.uniform4f(
        gl.getUniformLocation(this.program, "iMouse"),
        this.mouse.x,
        this.mouse.y,
        this.mouse.down ? this.mouse.downX : -Math.abs(this.mouse.downX),
        this.mouse.down ? this.mouse.downY : -Math.abs(this.mouse.downY),
      );

      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.frame++;

      this.fpsAccum++;
      if (now - this.lastFpsSample >= 500) {
        const fps = (this.fpsAccum * 1000) / (now - this.lastFpsSample);
        this.onFps?.(fps);
        this.fpsAccum = 0;
        this.lastFpsSample = now;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
  }
}

// -----------------------------------------------------------------------
// Multi-pass (Shadertoy "Buffer A-D + Image") rendering.
//
// Semantics: buffers render in order A, B, C, D, then Image, every
// frame. A channel wired to buffer X always samples X's *most recently
// completed* texture — for a buffer later in the order referencing one
// earlier (e.g. B reading A), that's this frame's fresh output (A has
// already rendered and swapped by the time B runs); for a buffer
// referencing *itself* (feedback) or one later in the order (e.g. A
// reading D), that's necessarily last frame's output, since the target
// hasn't rendered yet this frame. This one-rule-fits-all approach avoids
// ever sampling a texture that's simultaneously bound as a render
// target (a WebGL feedback-loop hazard) without needing special-case
// logic for self-reference vs forward-reference.
// -----------------------------------------------------------------------

export type BufferSlot = "bufferA" | "bufferB" | "bufferC" | "bufferD";
export type PassId = BufferSlot | "image";

export type ChannelWiring = { kind: "none" } | { kind: "buffer"; id: BufferSlot };

export interface PassSource {
  id: PassId;
  /** This pass's own code, *not* including the shared "Common" prefix. */
  code: string;
  /** iChannel0..3, length 4. */
  channels: ChannelWiring[];
}

export interface MultiPassError extends RenderError {
  passId: PassId;
}

interface CompiledPass {
  id: PassId;
  program: WebGLProgram;
  channels: ChannelWiring[];
  uniforms: {
    iResolution: WebGLUniformLocation | null;
    iTime: WebGLUniformLocation | null;
    iTimeDelta: WebGLUniformLocation | null;
    iFrame: WebGLUniformLocation | null;
    iMouse: WebGLUniformLocation | null;
    iChannel: (WebGLUniformLocation | null)[];
  };
}

interface BufferTarget {
  front: WebGLTexture;
  back: WebGLTexture;
  frontFbo: WebGLFramebuffer;
  backFbo: WebGLFramebuffer;
}

const MULTIPASS_VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

export class MultiPassRunner {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private passes: CompiledPass[] = [];
  private buffers = new Map<BufferSlot, BufferTarget>();
  private placeholderTex: WebGLTexture;
  private width = 1;
  private height = 1;
  private rafId = 0;
  private startTime = performance.now();
  private paused = false;
  private mouse = { x: 0, y: 0, downX: 0, downY: 0, down: false };
  private frame = 0;
  private lastFpsSample = performance.now();
  private fpsAccum = 0;
  public onFps: ((fps: number) => void) | null = null;
  public onError: ((err: MultiPassError | null) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL2 non disponible sur ce navigateur (requis pour le multi-buffer).");
    this.gl = gl;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.placeholderTex = this.createTexture(1, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.placeholderTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    canvas.addEventListener("pointerdown", (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.down = true;
      this.mouse.downX = ((e.clientX - r.left) / r.width) * canvas.width;
      this.mouse.downY = (1 - (e.clientY - r.top) / r.height) * canvas.height;
    });
    window.addEventListener("pointerup", () => {
      this.mouse.down = false;
    });
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - r.left) / r.width) * canvas.width;
      this.mouse.y = (1 - (e.clientY - r.top) / r.height) * canvas.height;
    });
  }

  private createTexture(w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private createTarget(w: number, h: number): BufferTarget {
    const gl = this.gl;
    const front = this.createTexture(w, h);
    const back = this.createTexture(w, h);
    const frontFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, frontFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, front, 0);
    const backFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, backFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, back, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { front, back, frontFbo, backFbo };
  }

  private destroyTarget(t: BufferTarget): void {
    const gl = this.gl;
    gl.deleteTexture(t.front);
    gl.deleteTexture(t.back);
    gl.deleteFramebuffer(t.frontFbo);
    gl.deleteFramebuffer(t.backFbo);
  }

  private compileOne(
    source: string,
    type: number,
    passId: PassId,
    stage: "vertex" | "fragment",
    bodyStartLine?: number,
  ): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || "erreur de compilation inconnue";
      gl.deleteShader(shader);
      throw { passId, stage, log, bodyStartLine } as MultiPassError;
    }
    return shader;
  }

  private buildFsSource(fragmentBody: string): { source: string; bodyStartLine: number } {
    const header = `#version 300 es\nprecision highp float;\nuniform vec3 iResolution;\nuniform float iTime;\nuniform float iTimeDelta;\nuniform int iFrame;\nuniform vec4 iMouse;\nuniform sampler2D iChannel0;\nuniform sampler2D iChannel1;\nuniform sampler2D iChannel2;\nuniform sampler2D iChannel3;\nout vec4 outColor;\n`;
    const entry = `\nvoid main(){ vec4 c; mainImage(c, gl_FragCoord.xy); outColor = c; }\n`;
    return { source: header + fragmentBody + entry, bodyStartLine: header.split("\n").length };
  }

  private compilePass(passId: PassId, fragmentBody: string, channels: ChannelWiring[]): CompiledPass {
    const gl = this.gl;
    const vs = this.compileOne(MULTIPASS_VERTEX_SRC, gl.VERTEX_SHADER, passId, "vertex");
    let fs: WebGLShader;
    try {
      const { source, bodyStartLine } = this.buildFsSource(fragmentBody);
      fs = this.compileOne(source, gl.FRAGMENT_SHADER, passId, "fragment", bodyStartLine);
    } catch (e) {
      gl.deleteShader(vs);
      throw e;
    }
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || "erreur de link inconnue";
      gl.deleteProgram(program);
      throw { passId, stage: "link", log } as MultiPassError;
    }
    return {
      id: passId,
      program,
      channels,
      uniforms: {
        iResolution: gl.getUniformLocation(program, "iResolution"),
        iTime: gl.getUniformLocation(program, "iTime"),
        iTimeDelta: gl.getUniformLocation(program, "iTimeDelta"),
        iFrame: gl.getUniformLocation(program, "iFrame"),
        iMouse: gl.getUniformLocation(program, "iMouse"),
        iChannel: [0, 1, 2, 3].map((i) => gl.getUniformLocation(program, `iChannel${i}`)),
      },
    };
  }

  /**
   * Compiles/links every pass and (re)allocates buffer targets. All-or-
   * nothing: if any pass fails, nothing about the currently running
   * project is touched (mirrors `ShaderRunner.load`'s failure contract),
   * and the first failing pass's error is reported.
   *
   * `p.code` must already be the *complete* fragment body for that pass
   * — including "Common", if any. This runner doesn't know about Common
   * as a concept: whoever builds `passSources` (raw source preview, or
   * the golfer's per-pass output, which already has Common merged in
   * before golfing) is responsible for the concatenation. Keeping that
   * out of the renderer means the golfed and un-golfed code paths share
   * one code path here instead of two slightly-different ones.
   */
  load(passSources: PassSource[]): boolean {
    const gl = this.gl;
    const compiled: CompiledPass[] = [];
    try {
      for (const p of passSources) {
        compiled.push(this.compilePass(p.id, p.code, p.channels));
      }
    } catch (err) {
      compiled.forEach((c) => gl.deleteProgram(c.program));
      this.onError?.(err as MultiPassError);
      return false;
    }

    // Compile succeeded for every pass — now safe to replace live state.
    this.passes.forEach((p) => gl.deleteProgram(p.program));
    this.buffers.forEach((t) => this.destroyTarget(t));
    this.buffers.clear();

    const bufferIds = passSources
      .map((p) => p.id)
      .filter((id): id is BufferSlot => id !== "image");
    for (const id of bufferIds) {
      this.buffers.set(id, this.createTarget(this.width, this.height));
    }

    this.passes = compiled;
    this.startTime = performance.now();
    this.frame = 0;
    this.onError?.(null);
    return true;
  }

  /** Compiles every pass without installing them (used to distinguish "source already broken" from "golf broke it"). Same full-body-per-pass contract as `load`. */
  tryCompile(passSources: PassSource[]): MultiPassError | null {
    const gl = this.gl;
    const compiled: WebGLProgram[] = [];
    try {
      for (const p of passSources) {
        compiled.push(this.compilePass(p.id, p.code, p.channels).program);
      }
      return null;
    } catch (err) {
      return err as MultiPassError;
    } finally {
      compiled.forEach((prog) => gl.deleteProgram(prog));
    }
  }

  resize(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.round(width * dpr));
    this.height = Math.max(1, Math.round(height * dpr));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    for (const [id, target] of this.buffers) {
      this.destroyTarget(target);
      this.buffers.set(id, this.createTarget(this.width, this.height));
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  private resolveChannelTexture(wiring: ChannelWiring): WebGLTexture {
    if (wiring.kind === "none") return this.placeholderTex;
    return this.buffers.get(wiring.id)?.front ?? this.placeholderTex;
  }

  private setPassUniforms(pass: CompiledPass, elapsed: number, dt: number): void {
    const gl = this.gl;
    gl.useProgram(pass.program);
    gl.uniform3f(pass.uniforms.iResolution, this.width, this.height, 1);
    gl.uniform1f(pass.uniforms.iTime, elapsed);
    gl.uniform1f(pass.uniforms.iTimeDelta, dt);
    gl.uniform1i(pass.uniforms.iFrame, this.frame);
    gl.uniform4f(
      pass.uniforms.iMouse,
      this.mouse.x,
      this.mouse.y,
      this.mouse.down ? this.mouse.downX : -Math.abs(this.mouse.downX),
      this.mouse.down ? this.mouse.downY : -Math.abs(this.mouse.downY),
    );
    for (let ch = 0; ch < 4; ch++) {
      gl.activeTexture(gl.TEXTURE0 + ch);
      gl.bindTexture(gl.TEXTURE_2D, this.resolveChannelTexture(pass.channels[ch]));
      gl.uniform1i(pass.uniforms.iChannel[ch], ch);
    }
  }

  start(): void {
    const gl = this.gl;
    let lastTime = performance.now();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      if (this.passes.length === 0) return;
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      if (this.paused) return;

      const elapsed = (now - this.startTime) / 1000;
      gl.viewport(0, 0, this.width, this.height);

      for (const pass of this.passes) {
        if (pass.id === "image") continue;
        const target = this.buffers.get(pass.id);
        if (!target) continue;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.backFbo);
        this.setPassUniforms(pass, elapsed, dt);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        const tmp = target.front;
        target.front = target.back;
        target.back = tmp;
        const tmpFbo = target.frontFbo;
        target.frontFbo = target.backFbo;
        target.backFbo = tmpFbo;
      }

      const imagePass = this.passes.find((p) => p.id === "image");
      if (imagePass) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.setPassUniforms(imagePass, elapsed, dt);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      this.frame++;
      this.fpsAccum++;
      if (now - this.lastFpsSample >= 500) {
        const fps = (this.fpsAccum * 1000) / (now - this.lastFpsSample);
        this.onFps?.(fps);
        this.fpsAccum = 0;
        this.lastFpsSample = now;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    const gl = this.gl;
    this.passes.forEach((p) => gl.deleteProgram(p.program));
    this.buffers.forEach((t) => this.destroyTarget(t));
  }
}
