// Thin WebGL2 helpers: programs with cached uniform locations, textures, FBOs.

export function createContext(canvas) {
  return canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
}

function compile(gl, type, src, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
    console.error(`[${name}] shader compile error\n${log}\n${numbered}`);
    throw new Error(`Shader "${name}" failed to compile: ${log}`);
  }
  return sh;
}

export class Program {
  constructor(gl, vsSrc, fsSrc, name = 'program') {
    this.gl = gl;
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, name + ':vs');
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, name + ':fs');
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`Program "${name}" failed to link: ${gl.getProgramInfoLog(p)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = p;
    this.loc = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      this.loc[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
  }
  use() { this.gl.useProgram(this.program); return this; }
  i(name, v) { const l = this.loc[name]; if (l) this.gl.uniform1i(l, v | 0); return this; }
  b(name, v) { return this.i(name, v ? 1 : 0); }
  u(name, v) { const l = this.loc[name]; if (l) this.gl.uniform1ui(l, v >>> 0); return this; }
  f(name, v) { const l = this.loc[name]; if (l) this.gl.uniform1f(l, v); return this; }
  v2(name, x, y) { const l = this.loc[name]; if (l) this.gl.uniform2f(l, x, y); return this; }
  v3(name, a) { const l = this.loc[name]; if (l) this.gl.uniform3f(l, a[0], a[1], a[2]); return this; }
  iv3(name, a) { const l = this.loc[name]; if (l) this.gl.uniform3i(l, a[0] | 0, a[1] | 0, a[2] | 0); return this; }
}

function params(gl, target, filter) {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
}

export function texture3D(gl, size, internalFormat, filter) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, t);
  gl.texStorage3D(gl.TEXTURE_3D, 1, internalFormat, size, size, size);
  params(gl, gl.TEXTURE_3D, filter ?? gl.NEAREST);
  return t;
}

export function texture2D(gl, w, h, internalFormat, filter) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, w, h);
  params(gl, gl.TEXTURE_2D, filter ?? gl.NEAREST);
  return t;
}

function checkFbo(gl, what) {
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer ${what} incomplete: 0x${status.toString(16)}`);
}

export function framebuffer2D(gl, tex) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  checkFbo(gl, '2D');
  return fb;
}

// Framebuffer that targets `count` consecutive layers of a 3D texture via MRT.
export function framebufferLayers(gl, tex, z0, count) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const bufs = [];
  for (let i = 0; i < count; i++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, tex, 0, z0 + i);
    bufs.push(gl.COLOR_ATTACHMENT0 + i);
  }
  gl.drawBuffers(bufs);
  checkFbo(gl, `layers ${z0}..${z0 + count - 1}`);
  return fb;
}

// Asynchronous GPU timer (EXT_disjoint_timer_query_webgl2); poll() yields ms.
export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.free = [];
    this.active = null;
  }
  get available() { return !!this.ext; }
  begin() {
    if (!this.ext || this.active || this.pending.length > 3) return;
    this.active = this.free.pop() || this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.active);
  }
  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }
  poll() {
    const gl = this.gl;
    let ms = null;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      this.free.push(this.pending.shift());
      if (!disjoint) ms = ns / 1e6;
    }
    return ms;
  }
}

export function srgbToLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
}
