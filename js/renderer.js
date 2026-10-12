// Scene renderer: voxel raymarch into an HDR target, dual-filter bloom,
// then composite (FXAA + ACES + vignette) to the canvas.

import { Program, texture2D, framebuffer2D, srgbToLinear } from './gl.js';
import {
  VS_FULLSCREEN, FS_RAYMARCH, FS_BLOOM_DOWN, FS_BLOOM_UP, FS_COMPOSITE,
} from './shaders.js';
import { paletteBytes, THEMES, COLOR_MODE_INDEX } from './palettes.js';

const BLOOM_LEVELS = 5;

export class Renderer {
  // `shared`: another Renderer whose compiled programs are reused.
  constructor(gl, shared = null) {
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    this.rayProg = shared?.rayProg ?? new Program(gl, VS_FULLSCREEN, FS_RAYMARCH, 'raymarch');
    this.downProg = shared?.downProg ?? new Program(gl, VS_FULLSCREEN, FS_BLOOM_DOWN, 'bloom-down');
    this.upProg = shared?.upProg ?? new Program(gl, VS_FULLSCREEN, FS_BLOOM_UP, 'bloom-up');
    this.compProg = shared?.compProg ?? new Program(gl, VS_FULLSCREEN, FS_COMPOSITE, 'composite');
    this.vao = gl.createVertexArray();
    this.paletteTex = texture2D(gl, 256, 1, gl.SRGB8_ALPHA8, gl.LINEAR);
    this.w = 0;
    this.h = 0;
    this.scene = null;
    this.mips = [];
  }

  setPalette(stops) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, paletteBytes(stops));
  }

  _target(w, h) {
    const gl = this.gl;
    const tex = texture2D(gl, w, h, this.hdr ? gl.RGBA16F : gl.RGBA8, gl.LINEAR);
    return { tex, fbo: framebuffer2D(gl, tex), w, h };
  }

  _free(t) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  resize(w, h) {
    w = Math.max(16, Math.round(w));
    h = Math.max(16, Math.round(h));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this._free(this.scene);
    this.mips.forEach((m) => this._free(m));
    this.scene = this._target(w, h);
    this.mips = [];
    let mw = w, mh = h;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      this.mips.push(this._target(mw, mh));
      if (mw <= 4 || mh <= 4) break;
    }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  render(sim, P) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    const theme = THEMES[P.theme] ?? THEMES.midnight;
    const N = sim.N;

    // --- 1. raymarch -------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, sim.stateTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, sim.brickTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);

    const cam = P.camera;
    const sun = srgbToLinear(theme.sun).map((c) => c * 1.55);
    const sky = srgbToLinear(theme.sky).map((c) => c * 0.5);
    const ground = srgbToLinear(theme.ground).map((c) => c * 0.4);
    const az = (P.lightAz * Math.PI) / 180;
    const el = (P.lightEl * Math.PI) / 180;
    const light = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];

    const r = this.rayProg.use();
    r.i('uState', 0).i('uBricks', 1).i('uPalette', 2)
      .v2('uRes', this.w, this.h)
      .v2('uShift', P.shift, 0)
      .v3('uCamPos', cam.pos).v3('uCamRight', cam.right).v3('uCamUp', cam.up).v3('uCamFwd', cam.fwd)
      // Portrait screens keep the horizontal field of view instead of the vertical one.
      .f('uTanFov', Math.tan(cam.fov / 2) / Math.min(1, this.w / this.h))
      .i('uN', N).i('uNB', sim.NB)
      .v3('uClipMin', P.clipMin).v3('uClipMax', P.clipMax)
      .iv3('uClipMinI', P.clipMin).iv3('uClipMaxI', P.clipMax)
      .f('uT', P.t)
      .i('uStates', P.states)
      .f('uCellSize', P.cellSize)
      .f('uDecayShrink', P.decayShrink)
      .b('uShowDying', P.showDying)
      .i('uColorMode', COLOR_MODE_INDEX[P.colorMode] ?? 0)
      .f('uAgeScale', P.ageScale)
      .f('uGlow', P.glow)
      .v3('uLightDir', light).v3('uSunColor', sun).v3('uSkyColor', sky).v3('uGroundColor', ground)
      .b('uShadows', P.shadows)
      .f('uAO', P.ao)
      .f('uEdges', P.edges)
      .f('uFog', P.fog)
      .b('uFloor', P.floor)
      .b('uFrame', P.frame)
      .v3('uBgTop', srgbToLinear(theme.top))
      .v3('uBgBottom', srgbToLinear(theme.bottom))
      .v3('uBgGlow', srgbToLinear(theme.glow))
      .v3('uFloorColor', srgbToLinear(theme.floor))
      .v3('uFrameColor', srgbToLinear(theme.frame));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // --- 2. bloom ------------------------------------------------------------
    const useBloom = P.bloom > 0.001 && this.mips.length > 1;
    if (useBloom) {
      const d = this.downProg.use();
      d.i('uTex', 0).f('uThreshold', theme === THEMES.studio ? 1.4 : 0.85);
      gl.activeTexture(gl.TEXTURE0);
      let src = this.scene;
      for (let i = 0; i < this.mips.length; i++) {
        const dst = this.mips[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        d.v2('uHalf', 0.5 / src.w, 0.5 / src.h).b('uPrefilter', i === 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = dst;
      }
      const u = this.upProg.use();
      u.i('uTex', 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = this.mips.length - 1; i > 0; i--) {
        const s = this.mips[i];
        const dst = this.mips[i - 1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        u.v2('uHalf', 0.5 / s.w, 0.5 / s.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);
    }

    // --- 3. composite ---------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, P.outFbo ?? null);
    gl.viewport(0, 0, P.outW, P.outH);
    const c = this.compProg.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, useBloom ? this.mips[0].tex : this.scene.tex);
    c.i('uScene', 0).i('uBloom', 1)
      .v2('uTexel', 1 / this.w, 1 / this.h)
      .f('uBloomStrength', P.bloom * 0.9)
      .b('uUseBloom', useBloom)
      .b('uFxaa', P.fxaa)
      .f('uExposure', theme.exposure)
      .f('uVignette', theme === THEMES.studio ? 0.25 : 0.55)
      .f('uTime', P.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
