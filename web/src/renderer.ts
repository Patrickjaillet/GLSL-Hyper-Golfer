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

  private compile(source: string, type: number): WebGLShader | null {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || "erreur de compilation inconnue";
      gl.deleteShader(shader);
      throw { stage: type === gl.VERTEX_SHADER ? "vertex" : "fragment", log } as RenderError;
    }
    return shader;
  }

  /** Wraps a `mainImage`-shaped fragment body with the uniform header and entry point. */
  private buildFullFsSource(fragmentBody: string): string {
    const precisionHeader = this.isGL2
      ? `#version 300 es\nprecision highp float;\nuniform vec3 iResolution;\nuniform float iTime;\nuniform float iTimeDelta;\nuniform int iFrame;\nuniform vec4 iMouse;\nout vec4 outColor;\n`
      : `precision highp float;\nuniform vec3 iResolution;\nuniform float iTime;\nuniform float iTimeDelta;\nuniform int iFrame;\nuniform vec4 iMouse;\n`;

    const entry = this.isGL2
      ? `\nvoid main(){ vec4 c; mainImage(c, gl_FragCoord.xy); outColor = c; }\n`
      : `\nvoid main(){ vec4 c; mainImage(c, gl_FragCoord.xy); gl_FragColor = c; }\n`;

    return precisionHeader + fragmentBody + entry;
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
    const fullFsSource = this.buildFullFsSource(fragmentBody);
    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    let program: WebGLProgram | null = null;
    try {
      vs = this.compile(this.isGL2 ? VERTEX_SRC : VERTEX_SRC_GL1, gl.VERTEX_SHADER);
      fs = this.compile(fullFsSource, gl.FRAGMENT_SHADER);
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
    const fullFsSource = this.buildFullFsSource(fragmentBody);

    try {
      const vs = this.compile(this.isGL2 ? VERTEX_SRC : VERTEX_SRC_GL1, gl.VERTEX_SHADER);
      const fs = this.compile(fullFsSource, gl.FRAGMENT_SHADER);
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
