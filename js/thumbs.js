// Renders real previews for built-in presets on a small offscreen automaton,
// one preset per animation frame, and caches them in localStorage.

import { Automaton } from './automaton.js';
import { Renderer } from './renderer.js';
import { texture2D, framebuffer2D } from './gl.js';
import { orbitState } from './camera.js';
import { parseRule, PRESETS } from './rules.js';
import { PALETTES } from './palettes.js';

const SIZE = 288;
const GRID = 64;
const STEPS = 56;
// Cache key changes whenever presets or palettes change, so stale previews are dropped.
const CACHE_KEY = (() => {
  const src = JSON.stringify([PRESETS, PALETTES, GRID, STEPS]);
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 16777619);
  return `cellular3d.presetThumbs.${(h >>> 0).toString(36)}`;
})();

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export class PresetThumbs {
  constructor(gl, mainSim, mainRenderer) {
    this.gl = gl;
    this.mainSim = mainSim;
    this.mainRenderer = mainRenderer;
    this.cache = {};
    try {
      this.cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('cellular3d.presetThumbs.') && k !== CACHE_KEY) localStorage.removeItem(k);
      }
    } catch { this.cache = {}; }
    this.running = null;
  }

  get(name) {
    return this.cache[name] ?? null;
  }

  _init() {
    if (this.sim) return;
    const gl = this.gl;
    this.sim = new Automaton(gl, this.mainSim);
    this.sim.allocate(GRID);
    this.renderer = new Renderer(gl, this.mainRenderer);
    this.renderer.resize(SIZE, SIZE);
    this.outTex = texture2D(gl, SIZE, SIZE, gl.RGBA8);
    this.outFbo = framebuffer2D(gl, this.outTex);
    this.pixels = new Uint8Array(SIZE * SIZE * 4);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(SIZE, SIZE);
  }

  _render(p) {
    const gl = this.gl;
    const rule = parseRule(p.rule);
    const view = { palette: 'aurora', colorMode: 'state', ...p.view };
    this.renderer.setPalette((PALETTES[view.palette] ?? PALETTES.aurora).stops);
    this.sim.seed({ shape: 'cube', size: 12, density: 0.5, symmetry: 'none', value: 20251013, ...p.seed });
    for (let i = 0; i < STEPS; i++) this.sim.step(rule, false);
    this.sim.updateBricks(true);
    this.renderer.render(this.sim, {
      camera: orbitState(0.75, 0.42, 4.9, (36 * Math.PI) / 180),
      shift: 0, clipMin: [0, 0, 0], clipMax: [GRID, GRID, GRID], t: 1,
      states: rule.states, cellSize: 0.9, decayShrink: 0.45, showDying: true,
      colorMode: view.colorMode, ageScale: 40, glow: 0.18, theme: 'midnight',
      lightAz: 40, lightEl: 52, shadows: true, ao: 0.85, edges: 0.3, fog: 0.45,
      floor: true, frame: true, bloom: 0.55, fxaa: true,
      outW: SIZE, outH: SIZE, outFbo: this.outFbo, time: 0,
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFbo);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GL rows run bottom-up; flip while copying into the 2D canvas.
    const row = SIZE * 4;
    for (let y = 0; y < SIZE; y++) {
      this.image.data.set(this.pixels.subarray((SIZE - 1 - y) * row, (SIZE - y) * row), y * row);
    }
    this.ctx.putImageData(this.image, 0, 0);
    return this.canvas.toDataURL('image/jpeg', 0.85);
  }

  // Calls onThumb(name, url) for each preset as soon as its preview exists.
  generate(presets, onThumb) {
    for (const p of presets) if (this.cache[p.name]) onThumb(p.name, this.cache[p.name]);
    const missing = presets.filter((p) => !this.cache[p.name]);
    if (!missing.length || this.running) return this.running;
    this.running = (async () => {
      this._init();
      for (const p of missing) {
        await nextFrame();
        try {
          const url = this._render(p);
          this.cache[p.name] = url;
          onThumb(p.name, url);
        } catch (e) {
          console.warn('preset thumbnail failed', p.name, e);
        }
      }
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(this.cache)); } catch { /* storage full */ }
      this.running = null;
    })();
    return this.running;
  }
}
