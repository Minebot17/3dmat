// GPU cellular automaton: ping-pong RGBA8UI 3D textures, brick summary for
// empty-space skipping, and fenced population readback that never stalls on
// the frame being rendered.

import { Program, texture3D, texture2D, framebufferLayers, framebuffer2D } from './gl.js';
import { VS_FULLSCREEN, FS_SIM, FS_SEED, FS_BRICKS, FS_REDUCE } from './shaders.js';
import { NEIGH_INDEX } from './rules.js';

export const SEED_SHAPES = ['cube', 'sphere', 'shell', 'point', 'scatter', 'cross', 'disc'];
const SYMMETRY = { none: 0, mirror: 1, cubic: 2 };

export class Automaton {
  // `shared`: another Automaton whose compiled programs are reused.
  constructor(gl, shared = null) {
    this.gl = gl;
    this.simProg = shared?.simProg ?? new Program(gl, VS_FULLSCREEN, FS_SIM, 'sim');
    this.seedProg = shared?.seedProg ?? new Program(gl, VS_FULLSCREEN, FS_SEED, 'seed');
    this.brickProg = shared?.brickProg ?? new Program(gl, VS_FULLSCREEN, FS_BRICKS, 'bricks');
    this.reduceProg = shared?.reduceProg ?? new Program(gl, VS_FULLSCREEN, FS_REDUCE, 'reduce');
    this.vao = gl.createVertexArray();
    this.N = 0;
    this.NB = 0;
    this.generation = 0;
    this.stats = { alive: 0, visible: 0, changed: 0, generation: 0 };
    this.pending = null;
  }

  get stateTex() { return this.tex[this.cur]; }

  allocate(N) {
    if (N === this.N) return;
    this.dispose();
    const gl = this.gl;
    this.N = N;
    this.NB = N / 4;
    this.tex = [texture3D(gl, N, gl.RGBA8UI), texture3D(gl, N, gl.RGBA8UI)];
    this.fbos = this.tex.map((t) => {
      const list = [];
      for (let z = 0; z < N; z += 4) list.push(framebufferLayers(gl, t, z, 4));
      return list;
    });
    this.cur = 0;
    this.brickTex = texture3D(gl, this.NB, gl.RGBA8, gl.LINEAR);
    this.brickFbos = [];
    for (let z = 0; z < this.NB; z++) this.brickFbos.push(framebufferLayers(gl, this.brickTex, z, 1));
    this.reduceTex = texture2D(gl, this.NB, this.NB, gl.RGBA32UI);
    this.reduceFbo = framebuffer2D(gl, this.reduceTex);
    this.readback = new Uint32Array(this.NB * this.NB * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose() {
    const gl = this.gl;
    if (!this.N) return;
    this.tex.forEach((t) => gl.deleteTexture(t));
    this.fbos.flat().forEach((f) => gl.deleteFramebuffer(f));
    gl.deleteTexture(this.brickTex);
    this.brickFbos.forEach((f) => gl.deleteFramebuffer(f));
    gl.deleteTexture(this.reduceTex);
    gl.deleteFramebuffer(this.reduceFbo);
    if (this.pending) gl.deleteSync(this.pending.sync);
    this.pending = null;
    this.N = 0;
  }

  _begin(prog) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    prog.use();
    return prog;
  }

  seed(cfg) {
    const gl = this.gl;
    const p = this._begin(this.seedProg);
    p.i('uN', this.N)
      .i('uShape', Math.max(0, SEED_SHAPES.indexOf(cfg.shape)))
      .i('uSym', SYMMETRY[cfg.symmetry] ?? 0)
      .f('uSize', Math.min(cfg.size, this.N))
      .f('uDensity', cfg.density)
      .u('uSeed', cfg.value);
    gl.viewport(0, 0, this.N, this.N);
    const fbos = this.fbos[this.cur];
    for (let i = 0; i < fbos.length; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[i]);
      p.i('uZ0', i * 4);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.generation = 0;
  }

  step(rule, wrap) {
    const gl = this.gl;
    const p = this._begin(this.simProg);
    const dst = 1 - this.cur;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.tex[this.cur]);
    p.i('uState', 0)
      .i('uN', this.N)
      .b('uWrap', wrap)
      .u('uBirth', rule.birth)
      .u('uSurvive', rule.survive)
      .i('uStates', rule.states)
      .i('uNeigh', NEIGH_INDEX[rule.neighborhood]);
    gl.viewport(0, 0, this.N, this.N);
    const fbos = this.fbos[dst];
    for (let i = 0; i < fbos.length; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[i]);
      p.i('uZ0', i * 4);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cur = dst;
    this.generation++;
  }

  updateBricks(showDying) {
    const gl = this.gl;
    const p = this._begin(this.brickProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.tex[this.cur]);
    p.i('uState', 0).b('uShowDying', showDying);
    gl.viewport(0, 0, this.NB, this.NB);
    for (let z = 0; z < this.NB; z++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.brickFbos[z]);
      p.i('uBz', z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Kick off an async population count for the current generation.
  requestStats() {
    if (this.pending) return false;
    const gl = this.gl;
    const p = this._begin(this.reduceProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.brickTex);
    p.i('uBricks', 0).i('uNB', this.NB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.reduceFbo);
    gl.viewport(0, 0, this.NB, this.NB);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.pending = { sync, generation: this.generation };
    return true;
  }

  // Returns fresh stats once the GPU has finished the reduction, otherwise
  // null. Call before queuing the frame's render so the read waits on nothing.
  pollStats() {
    if (!this.pending) return null;
    const gl = this.gl;
    if (gl.getSyncParameter(this.pending.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return null;
    gl.deleteSync(this.pending.sync);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.reduceFbo);
    gl.readPixels(0, 0, this.NB, this.NB, gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.readback);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let visible = 0, alive = 0, changed = 0;
    const r = this.readback;
    for (let i = 0; i < r.length; i += 4) {
      visible += r[i];
      alive += r[i + 1];
      changed += r[i + 2];
    }
    this.stats = { visible, alive, changed, generation: this.pending.generation };
    this.pending = null;
    return this.stats;
  }
}
