import { createContext, GpuTimer } from './gl.js';
import { Automaton } from './automaton.js';
import { Renderer } from './renderer.js';
import { OrbitCamera } from './camera.js';
import {
  PRESETS, parseRule, formatRule, sameRule, randomRule, mutateRule, randomName,
} from './rules.js';
import { PALETTES, THEMES, COLOR_MODES } from './palettes.js';
import { Catalog } from './catalog.js';
import { ICONS } from './icons.js';
import { buildPanel, renderCards, toast, drawSpark, pct } from './ui.js';
import { PresetThumbs } from './thumbs.js';

const SESSION_KEY = 'cellular3d.session.v1';
const GRID_SIZES = [32, 48, 64, 96, 128, 160, 192, 256];
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
function defaults() {
  const p = PRESETS.find((x) => x.name === 'Pyroclastic');
  return {
    name: p.name,
    rule: p.rule,
    smart: true,
    sim: { size: 96, speed: 10, smooth: true, wrap: false, autoReseed: true, binary: false },
    seed: { shape: 'cube', size: 14, density: 0.5, symmetry: 'none', value: 20251013, ...p.seed },
    view: { palette: 'ember', colorMode: 'state', cellSize: 0.9, decayShrink: 0.45, showDying: true, ageScale: 40, theme: 'midnight', ...p.view },
    fx: {
      shadows: true, ao: 0.85, edges: 0.35, glow: 0.18, bloom: 0.55, fog: 0.45, floor: true, frame: true,
      lightAz: 40, lightEl: 52, autoRotate: 0.12, quality: 1, autoQuality: true, fxaa: true,
    },
    slice: { axis: 'none', pos: 0.5, invert: false },
    demo: { enabled: false, interval: 30 },
  };
}

function merge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') merge(base[k], v);
    else if (v !== undefined && k in base) base[k] = v;
  }
  return base;
}

// The parts of the state that travel with a saved rule / share link.
function snapshot(st) {
  const { quality, autoQuality, ...fx } = st.fx;
  return {
    sim: { ...st.sim },
    seed: { ...st.seed },
    view: { ...st.view },
    fx,
    slice: { ...st.slice },
  };
}

const b64url = {
  encode: (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))),
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const canvas = $('view');
const gl = createContext(canvas);

function fatal(msg) {
  const el = $('fatal');
  el.hidden = false;
  el.innerHTML = `<div class="fatal-card glass"><h2>Не удалось запустить</h2><p>${msg}</p></div>`;
  throw new Error(msg);
}

if (!gl) fatal('Браузер не поддерживает WebGL2. Попробуйте свежий Chrome, Edge, Firefox или Safari.');

let sim, renderer;
try {
  sim = new Automaton(gl);
  renderer = new Renderer(gl);
} catch (e) {
  console.error(e);
  fatal(`Ошибка инициализации графики: ${e.message}`);
}
const camera = new OrbitCamera(canvas);

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  fatal('Графический контекст потерян. Перезагрузите страницу.');
});

// Module worker that screens random rules; falls back to unscreened rules.
let worker = null;
try {
  worker = new Worker(new URL('./evaluator.worker.js', import.meta.url), { type: 'module' });
  worker.onerror = () => { worker = null; };
} catch {
  worker = null;
}
let searchId = 0;
const searches = new Map();
if (worker) {
  worker.onmessage = ({ data }) => {
    const done = searches.get(data.id);
    if (done) {
      searches.delete(data.id);
      done(data);
    }
  };
}
// Screens candidates against the exact seed the GPU will use (see FS_SEED).
function searchRule(base, seedCfg, binary) {
  if (!worker) return Promise.resolve({ rule: base ? mutateRule(base) : randomRule(), ok: false });
  return new Promise((resolve) => {
    const id = ++searchId;
    searches.set(id, resolve);
    worker.postMessage({ type: 'search', id, base: base ?? null, seedCfg, binary, budget: 1500, seed: (Math.random() * 2 ** 32) >>> 0 });
    setTimeout(() => {
      if (searches.has(id)) {
        searches.delete(id);
        resolve({ rule: base ? mutateRule(base) : randomRule(), ok: false });
      }
    }, 4000);
  });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = {
  state: defaults(),
  rule: null,
  playing: true,
  history: [],
  dirty: true,
  bricksDirty: true,
  transT: 1,
  transDur: 0.1,
  acc: 0,
  busy: false,
  capture: null,
  popHistory: [],
  lastExtinct: 0,
  staticSince: 0,
  demoTimer: 0,

  // Rule the simulation actually runs: binary mode collapses decay states (0/1 only).
  simRule() {
    return this.state.sim.binary ? { ...this.rule, states: 2 } : this.rule;
  },

  onSetting(it) {
    switch (it.effect) {
      case 'binary': refreshUI(); break;
      case 'reseed': this.reseed(); break;
      case 'resize': this.resize(); break;
      case 'bricks': this.bricksDirty = true; break;
      case 'palette': renderer.setPalette(PALETTES[this.state.view.palette].stops); break;
      case 'camera': camera.autoRotate = this.state.fx.autoRotate; break;
      default: break;
    }
    if (it.key === 'fx.quality') renderScale = this.state.fx.quality;
    if (it.key === 'demo.enabled') {
      this.demoTimer = 0;
      if (this.state.demo.enabled) toast('Демо-режим: новое правило каждые ' + this.state.demo.interval + ' с');
    }
    this.dirty = true;
    persist();
  },

  setRule(rule, name, { history = true } = {}) {
    if (history && this.rule && !sameRule(rule, this.rule)) {
      this.history.push({ rule: this.state.rule, name: this.state.name });
      if (this.history.length > 50) this.history.shift();
    }
    this.rule = rule;
    this.state.rule = formatRule(rule);
    if (name) this.state.name = name;
    else {
      const p = PRESETS.find((x) => sameRule(parseRule(x.rule), rule));
      this.state.name = p ? p.name : 'Своё правило';
    }
    refreshUI();
    persist();
  },

  reseed(newValue = false) {
    if (newValue) this.state.seed.value = (Math.random() * 2 ** 32) >>> 0;
    sim.seed(this.state.seed);
    this.popHistory = [];
    this.bricksDirty = true;
    this.transT = 0;
    this.transDur = 0.45;
    this.acc = 0;
    this.lastExtinct = 0;
    this.staticSince = 0;
    refreshUI();
    persist();
  },

  resize() {
    const n = this.state.sim.size;
    sim.allocate(n);
    this.state.seed.size = Math.min(this.state.seed.size, n);
    this.reseed();
  },

  applyConfig(name, ruleText, cfg) {
    let rule;
    try {
      rule = parseRule(ruleText);
    } catch (e) {
      toast(`Не удалось прочитать правило: ${e.message}`, 'error');
      return;
    }
    const prevSize = this.state.sim.size;
    merge(this.state, cfg || {});
    if (!GRID_SIZES.includes(this.state.sim.size)) this.state.sim.size = prevSize;
    if (!PALETTES[this.state.view.palette]) this.state.view.palette = 'aurora';
    if (!THEMES[this.state.view.theme]) this.state.view.theme = 'midnight';
    renderer.setPalette(PALETTES[this.state.view.palette].stops);
    camera.autoRotate = this.state.fx.autoRotate;
    this.playing = true;
    this.setRule(rule, name || 'Своё правило');
    if (this.state.sim.size !== sim.N) this.resize();
    else this.reseed();
  },

  applyPreset(p) {
    this.applyConfig(p.name, p.rule, { seed: p.seed, view: p.view });
  },

  async randomize({ mutate = false, demo = false } = {}) {
    if (this.busy) return;
    if (demo) this.state.seed.value = (Math.random() * 2 ** 32) >>> 0;
    let rule;
    if (this.state.smart) {
      this.busy = true;
      $('busy').classList.add('show');
      const res = await searchRule(mutate ? this.rule : null, { ...this.state.seed, gridSize: this.state.sim.size }, this.state.sim.binary);
      $('busy').classList.remove('show');
      this.busy = false;
      rule = res.rule;
    } else {
      rule = mutate ? mutateRule(this.rule) : randomRule();
    }
    if (this.state.sim.binary) rule = { ...rule, states: 2 };
    if (demo) {
      const keys = Object.keys(PALETTES);
      this.state.view.palette = keys[Math.floor(Math.random() * keys.length)];
      this.state.view.colorMode = rule.states > 3 ? 'state' : ['age', 'radial', 'state'][Math.floor(Math.random() * 3)];
      renderer.setPalette(PALETTES[this.state.view.palette].stops);
    }
    this.playing = true;
    this.demoTimer = 0;
    this.setRule(rule, randomName());
    this.reseed();
  },

  mutate() { return this.randomize({ mutate: true }); },

  undo() {
    const prev = this.history.pop();
    if (!prev) {
      toast('История правил пуста');
      return;
    }
    this.setRule(parseRule(prev.rule), prev.name, { history: false });
    this.reseed();
  },

  togglePlay() {
    this.playing = !this.playing;
    this.acc = 0;
    refreshToolbar();
  },

  stepOnce() {
    this.playing = false;
    sim.step(this.simRule(), this.state.sim.wrap);
    this.bricksDirty = true;
    this.transT = this.state.sim.smooth ? 0 : 1;
    this.transDur = 0.3;
    refreshToolbar();
  },

  requestCapture(full = false) {
    return new Promise((resolve) => {
      this.capture = { full, resolve };
      this.dirty = true;
    });
  },
};

let renderScale = 1;

// ---------------------------------------------------------------------------
// Persistence & share links
// ---------------------------------------------------------------------------
let persistTimer = 0;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(app.state)); } catch { /* storage disabled */ }
  }, 400);
}

function shareURL(name, rule, cfg) {
  const payload = b64url.encode(JSON.stringify({ n: name, r: rule, c: cfg }));
  return `${location.origin}${location.pathname}#c=${payload}`;
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, 'ok');
  } catch {
    prompt('Скопируйте:', text);
  }
}

function readHash() {
  const m = location.hash.match(/#c=([\w-]+)/);
  if (!m) return null;
  try {
    const d = JSON.parse(b64url.decode(m[1]));
    return { name: d.n, rule: d.r, cfg: d.c };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settings panel schema
// ---------------------------------------------------------------------------
const SECTIONS = [
  { id: 'rule', title: 'Правило', open: true, items: [{ type: 'rule' }] },
  {
    id: 'sim', title: 'Симуляция', open: true, items: [
      { type: 'select', key: 'sim.size', label: 'Размер сетки', num: true, effect: 'resize', options: GRID_SIZES.map((n) => [n, `${n}³ · ${(n ** 3 / 1e6).toFixed(n < 100 ? 2 : 1)} млн клеток`]) },
      { type: 'range', key: 'sim.speed', label: 'Скорость', min: 1, max: 60, fmt: (v) => `${v} шаг/с` },
      { type: 'toggle', key: 'sim.smooth', label: 'Плавные переходы' },
      { type: 'toggle', key: 'sim.binary', label: 'Двоичный режим (только 0 и 1)', effect: 'binary' },
      { type: 'toggle', key: 'sim.wrap', label: 'Замкнутые границы (тор)' },
      { type: 'toggle', key: 'sim.autoReseed', label: 'Перезапуск при вымирании' },
      { type: 'toggle', key: 'demo.enabled', label: 'Демо-режим (автосмена правил)' },
      { type: 'range', key: 'demo.interval', label: 'Интервал демо', min: 8, max: 120, fmt: (v) => `${v} с` },
    ],
  },
  {
    id: 'seed', title: 'Затравка', open: false, items: [
      { type: 'select', key: 'seed.shape', label: 'Форма', effect: 'reseed', options: [['cube', 'Куб шума'], ['sphere', 'Шар шума'], ['shell', 'Сфера-оболочка'], ['point', 'Одна клетка'], ['scatter', 'Редкие точки'], ['cross', 'Крест осей'], ['disc', 'Диск']] },
      { type: 'range', key: 'seed.size', label: 'Размер', min: 1, max: () => app.state.sim.size, effect: 'reseed', fmt: (v) => `${v} кл.` },
      { type: 'range', key: 'seed.density', label: 'Плотность', min: 0.02, max: 1, step: 0.01, effect: 'reseed', fmt: pct },
      { type: 'seg', key: 'seed.symmetry', label: 'Симметрия', effect: 'reseed', options: [['none', 'Нет'], ['mirror', 'Зеркальная'], ['cubic', 'Кубическая']] },
      { type: 'seedValue' },
    ],
  },
  {
    id: 'look', title: 'Цвет и форма', open: true, items: [
      { type: 'palette', key: 'view.palette', effect: 'palette' },
      { type: 'select', key: 'view.colorMode', label: 'Раскраска', options: COLOR_MODES },
      { type: 'select', key: 'view.theme', label: 'Сцена', options: Object.entries(THEMES).map(([k, t]) => [k, t.name]) },
      { type: 'range', key: 'view.cellSize', label: 'Размер клетки', min: 0.3, max: 1, step: 0.01, fmt: pct },
      { type: 'range', key: 'view.decayShrink', label: 'Сжатие при угасании', min: 0, max: 1, step: 0.01, fmt: pct },
      { type: 'toggle', key: 'view.showDying', label: 'Показывать угасающие клетки', effect: 'bricks' },
      { type: 'range', key: 'view.ageScale', label: 'Шкала возраста', min: 4, max: 200, fmt: (v) => `${v} шагов` },
    ],
  },
  {
    id: 'fx', title: 'Свет и эффекты', open: false, items: [
      { type: 'toggle', key: 'fx.shadows', label: 'Тени' },
      { type: 'range', key: 'fx.ao', label: 'Объёмное затенение', min: 0, max: 1, step: 0.01, fmt: pct },
      { type: 'range', key: 'fx.edges', label: 'Контуры граней', min: 0, max: 1, step: 0.01, fmt: pct },
      { type: 'range', key: 'fx.glow', label: 'Свечение клеток', min: 0, max: 1.5, step: 0.01, fmt: pct },
      { type: 'range', key: 'fx.bloom', label: 'Ореол', min: 0, max: 1.5, step: 0.01, fmt: pct },
      { type: 'range', key: 'fx.fog', label: 'Туман глубины', min: 0, max: 1, step: 0.01, fmt: pct },
      { type: 'range', key: 'fx.lightAz', label: 'Азимут света', min: 0, max: 360, fmt: (v) => `${v}°` },
      { type: 'range', key: 'fx.lightEl', label: 'Высота света', min: 5, max: 90, fmt: (v) => `${v}°` },
      { type: 'range', key: 'fx.autoRotate', label: 'Автовращение', min: -0.6, max: 0.6, step: 0.01, effect: 'camera', fmt: (v) => (Math.abs(v) < 0.005 ? 'выкл' : `${v > 0 ? '↻' : '↺'} ${Math.abs(v).toFixed(2)}`) },
      { type: 'toggle', key: 'fx.floor', label: 'Пол с тенями' },
      { type: 'toggle', key: 'fx.frame', label: 'Рамка границ' },
    ],
  },
  {
    id: 'slice', title: 'Срез', open: false, items: [
      { type: 'seg', key: 'slice.axis', label: 'Ось', options: [['none', 'Нет'], ['x', 'X'], ['y', 'Y'], ['z', 'Z']] },
      { type: 'range', key: 'slice.pos', label: 'Положение', min: 0, max: 1, step: 0.005, fmt: pct },
      { type: 'toggle', key: 'slice.invert', label: 'Показать другую половину' },
    ],
  },
  {
    id: 'quality', title: 'Качество', open: false, items: [
      { type: 'toggle', key: 'fx.autoQuality', label: 'Адаптивное разрешение' },
      { type: 'range', key: 'fx.quality', label: 'Макс. разрешение', min: 0.35, max: 1, step: 0.05, fmt: pct },
      { type: 'toggle', key: 'fx.fxaa', label: 'Сглаживание (FXAA)' },
    ],
  },
];

// ---------------------------------------------------------------------------
// DOM wiring
// ---------------------------------------------------------------------------
const panel = buildPanel($('panelBody'), app, SECTIONS);

document.querySelectorAll('[data-icon]').forEach((el) => {
  el.insertAdjacentHTML('afterbegin', ICONS[el.dataset.icon] ?? '');
});
document.querySelectorAll('[data-tip]').forEach((el) => el.setAttribute('aria-label', el.dataset.tip.split(' · ')[0]));

function refreshToolbar() {
  const play = document.querySelector('[data-act="play"]');
  play.innerHTML = app.playing ? ICONS.pause : ICONS.play;
  play.dataset.tip = app.playing ? 'Пауза · Пробел' : 'Пуск · Пробел';
  play.setAttribute('aria-label', app.playing ? 'Пауза' : 'Пуск');
  document.querySelector('[data-act="undo"]').disabled = app.history.length === 0;
}

function refreshUI() {
  panel.refresh();
  $('ruleName').textContent = app.state.name;
  $('ruleCode').textContent = app.state.rule + (app.state.sim.binary && app.rule.states > 2 ? ' · 0/1' : '');
  refreshToolbar();
}

const actions = {
  play: () => app.togglePlay(),
  step: () => app.stepOnce(),
  reset: () => app.reseed(),
  undo: () => app.undo(),
  random: () => app.randomize(),
  mutate: () => app.mutate(),
  save: () => openSave(),
  catalog: () => openCatalog(),
  shot: () => screenshot(),
  panel: () => togglePanel(),
  fullscreen: () => toggleFullscreen(),
};
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.act]?.()));

$('ruleCode').addEventListener('click', () => copyText(app.state.rule, 'Правило скопировано'));
$('panelClose').addEventListener('click', () => togglePanel(false));

function togglePanel(force) {
  const open = force ?? document.body.classList.contains('panel-closed');
  document.body.classList.toggle('panel-closed', !open);
  app.dirty = true;
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

// Modals ---------------------------------------------------------------------
function openModal(id) {
  const m = $(id);
  m.hidden = false;
  requestAnimationFrame(() => m.classList.add('show'));
}
function closeModal(id) {
  const m = $(id);
  m.classList.remove('show');
  setTimeout(() => { m.hidden = true; }, 220);
}
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('pointerdown', (e) => { if (e.target === m) closeModal(m.id); });
  m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(m.id)));
});

// Save -------------------------------------------------------------------------
let pendingThumb = null;
async function openSave() {
  pendingThumb = await app.requestCapture(false);
  $('savePreview').src = pendingThumb;
  $('saveName').value = app.state.name === 'Своё правило' ? randomName() : app.state.name;
  $('saveRule').textContent = app.state.rule;
  openModal('saveModal');
  setTimeout(() => { $('saveName').focus(); $('saveName').select(); }, 50);
}
function confirmSave() {
  const name = $('saveName').value.trim() || randomName();
  try {
    Catalog.add({ name, rule: app.state.rule, config: snapshot(app.state), thumb: pendingThumb });
    app.state.name = name;
    refreshUI();
    persist();
    closeModal('saveModal');
    toast(`«${name}» сохранено в каталог`, 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}
$('saveConfirm').addEventListener('click', confirmSave);
$('saveName').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmSave(); });

// Catalogue --------------------------------------------------------------------
let catTab = 'mine';
const presetThumbs = new PresetThumbs(gl, sim, renderer);
function renderCatalog() {
  const q = $('catSearch').value.trim().toLowerCase();
  const match = (it) => !q || it.name.toLowerCase().includes(q) || it.rule.toLowerCase().includes(q);
  const mine = Catalog.list();
  $('mineCount').textContent = mine.length || '';
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === catTab));
  const common = {
    onLoad: (it) => {
      app.applyConfig(it.name, it.rule, it.config);
      closeModal('catalogModal');
      toast(`Открыто: ${it.name}`);
    },
    onShare: (it) => copyText(shareURL(it.name, it.rule, it.config), 'Ссылка скопирована'),
  };
  if (catTab === 'mine') {
    renderCards($('cards'), mine.filter(match), {
      ...common,
      emptyText: q ? 'Ничего не найдено' : 'Каталог пуст. Нажмите ★ или S, чтобы сохранить текущее правило.',
      onRename: (it, name) => { Catalog.update(it.id, { name }); renderCatalog(); },
      onDelete: (it) => { Catalog.remove(it.id); renderCatalog(); toast(`«${it.name}» удалено`); },
    });
  } else {
    const presets = PRESETS.map((p) => ({ name: p.name, rule: p.rule, config: { seed: p.seed, view: p.view }, thumb: presetThumbs.get(p.name) }));
    renderCards($('cards'), presets.filter(match), { ...common, preset: true, emptyText: 'Ничего не найдено' });
    presetThumbs.generate(PRESETS, (name, url) => {
      const ph = [...document.querySelectorAll('#cards [data-thumb]')].find((el) => el.dataset.thumb === name);
      if (!ph) return;
      const img = new Image();
      img.alt = '';
      img.src = url;
      img.className = 'fade-in';
      ph.replaceWith(img);
    });
  }
}
function openCatalog() {
  renderCatalog();
  openModal('catalogModal');
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { catTab = b.dataset.tab; renderCatalog(); }));
$('catSearch').addEventListener('input', renderCatalog);
$('catExport').addEventListener('click', () => {
  const blob = new Blob([Catalog.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cellular3d-catalog-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('catImport').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const n = Catalog.importJSON(await file.text());
    catTab = 'mine';
    renderCatalog();
    toast(`Импортировано правил: ${n}`, 'ok');
  } catch (err) {
    toast(`Ошибка импорта: ${err.message}`, 'error');
  }
});

// Screenshot -------------------------------------------------------------------
async function screenshot() {
  const url = await app.requestCapture(true);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cellular3d-${app.state.rule.replace(/[/,]/g, '_')}.png`;
  a.click();
}

// Keyboard -------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const modalOpen = !$('catalogModal').hidden || !$('saveModal').hidden;
  if (e.key === 'Escape') {
    if (!$('saveModal').hidden) closeModal('saveModal');
    else if (!$('catalogModal').hidden) closeModal('catalogModal');
    return;
  }
  if (modalOpen) return;
  const k = e.code;
  const map = {
    Space: () => app.togglePlay(),
    ArrowRight: () => app.stepOnce(),
    Period: () => app.stepOnce(),
    KeyR: () => app.reseed(e.shiftKey),
    KeyN: () => app.randomize(),
    KeyM: () => app.mutate(),
    KeyZ: () => app.undo(),
    Backspace: () => app.undo(),
    KeyS: () => openSave(),
    KeyC: () => openCatalog(),
    KeyP: () => togglePanel(),
    KeyF: () => toggleFullscreen(),
    KeyH: () => document.body.classList.toggle('ui-hidden'),
  };
  if (map[k]) {
    e.preventDefault();
    map[k]();
  }
});

// ---------------------------------------------------------------------------
// Initial state: share link > last session > default preset
// ---------------------------------------------------------------------------
(function init() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { stored = null; }
  if (stored) merge(app.state, stored);
  if (!GRID_SIZES.includes(app.state.sim.size)) app.state.sim.size = 96;
  if (!PALETTES[app.state.view.palette]) app.state.view.palette = 'aurora';
  if (!THEMES[app.state.view.theme]) app.state.view.theme = 'midnight';
  let rule;
  try { rule = parseRule(app.state.rule); } catch { rule = parseRule('4/4/5/M'); }
  app.rule = rule;
  app.state.rule = formatRule(rule);
  renderScale = app.state.fx.quality;
  camera.autoRotate = app.state.fx.autoRotate;
  renderer.setPalette(PALETTES[app.state.view.palette].stops);
  sim.allocate(app.state.sim.size);

  const shared = readHash();
  if (shared) {
    app.applyConfig(shared.name, shared.rule, shared.cfg);
    history.replaceState(null, '', location.pathname + location.search);
    toast(`Открыто по ссылке: ${shared.name || shared.rule}`);
  } else {
    app.reseed();
  }
  refreshUI();
})();

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
let last = performance.now();
let fpsFrames = 0;
let fpsTime = 0;
let frameEMA = 1 / 60;
let gpuEMA = null;
let qualityTimer = 0;
const RENDER_BUDGET_MS = 9;
const gpuTimer = new GpuTimer(gl);
let lensShift = 0;
let statsWanted = true;
let lastStatsReq = 0;
let lastHudGen = -1;

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    app.dirty = true;
  }
  renderer.resize(w * renderScale, h * renderScale);
}

function clipBox() {
  const N = sim.N;
  const { axis, pos, invert } = app.state.slice;
  const lo = [0, 0, 0];
  const hi = [N, N, N];
  const i = { x: 0, y: 1, z: 2 }[axis];
  if (i !== undefined) {
    const c = Math.round(pos * N);
    if (invert) lo[i] = c;
    else hi[i] = Math.max(c, 0);
  }
  return { lo, hi };
}

function onStats(s) {
  const st = app.state;
  if (s.generation !== lastHudGen) {
    lastHudGen = s.generation;
    app.popHistory.push(s.alive);
    if (app.popHistory.length > 240) app.popHistory.shift();
    drawSpark($('spark'), app.popHistory);
  }
  $('stPop').textContent = s.alive.toLocaleString('ru-RU');
  const now = performance.now();
  if (s.visible === 0 && s.generation > 0 && app.playing) {
    if (!app.lastExtinct) app.lastExtinct = now;
    if (now - app.lastExtinct > 900) {
      app.lastExtinct = 0;
      if (st.demo.enabled) app.randomize({ demo: true });
      else if (st.sim.autoReseed) {
        toast('Всё вымерло — перезапуск с новым зерном');
        app.reseed(true);
      }
    }
  } else {
    app.lastExtinct = 0;
  }
  if (st.demo.enabled && app.playing) {
    if (s.changed === 0) {
      if (!app.staticSince) app.staticSince = now;
      if (now - app.staticSince > 5000) app.randomize({ demo: true });
    } else {
      app.staticSince = 0;
    }
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  tick(now);
}

function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const st = app.state;

  // FPS counter
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    $('stFps').textContent = Math.round(fpsFrames / fpsTime);
    fpsFrames = 0;
    fpsTime = 0;
  }

  // Read finished stats before queuing this frame's GPU work, so it waits on nothing.
  const stats = sim.pollStats();
  if (stats) onStats(stats);

  if (camera.update(dt, now)) app.dirty = true;

  // Keep the structure centred in the area not covered by the settings panel.
  const panelOpen = !document.body.classList.contains('panel-closed') && !document.body.classList.contains('ui-hidden');
  const wide = canvas.clientWidth > 900;
  const targetShift = panelOpen && wide ? -($('panel').offsetWidth + 24) / canvas.clientWidth : 0;
  if (Math.abs(targetShift - lensShift) > 1e-4) {
    lensShift += (targetShift - lensShift) * (1 - Math.exp(-dt * 10));
    app.dirty = true;
  }

  // Simulation
  const smooth = st.sim.smooth && st.sim.speed <= 30;
  if (app.playing && !app.busy) {
    app.acc += dt * st.sim.speed;
    const maxSteps = Math.max(1, Math.ceil(st.sim.speed / 30));
    let steps = 0;
    while (app.acc >= 1 && steps < maxSteps) {
      sim.step(app.simRule(), st.sim.wrap);
      app.acc -= 1;
      steps++;
    }
    if (app.acc >= 1) app.acc = 0;
    if (steps) {
      app.bricksDirty = true;
      app.transT = steps > 1 || !smooth ? 1 : 0;
      app.transDur = 0.85 / st.sim.speed;
    }
    if (st.demo.enabled) {
      app.demoTimer += dt;
      if (app.demoTimer > st.demo.interval) app.randomize({ demo: true });
    }
  }
  if (app.transT < 1) {
    app.transT = Math.min(1, app.transT + dt / Math.max(0.016, app.transDur));
    app.dirty = true;
  }
  if (app.bricksDirty) {
    sim.updateBricks(st.view.showDying);
    app.bricksDirty = false;
    app.dirty = true;
    statsWanted = true;
  }

  if (statsWanted && now - lastStatsReq > 150 && sim.requestStats()) {
    statsWanted = false;
    lastStatsReq = now;
  }
  $('stGen').textContent = sim.generation.toLocaleString('ru-RU');

  // Adaptive resolution. Prefer real GPU time of the render pass (immune to
  // background-tab throttling); otherwise fall back to frame time.
  const gpuMs = gpuTimer.poll();
  if (gpuMs != null) gpuEMA = gpuEMA == null ? gpuMs : gpuEMA + (gpuMs - gpuEMA) * 0.2;
  if (!st.fx.autoQuality) {
    renderScale = st.fx.quality;
  } else if (app.dirty) {
    if (dt < 1 / 15) frameEMA += (dt - frameEMA) * 0.08;
    qualityTimer += dt;
    if (qualityTimer > 0.6) {
      qualityTimer = 0;
      let target = renderScale;
      if (gpuEMA != null) target = renderScale * Math.sqrt(RENDER_BUDGET_MS / Math.max(gpuEMA, 0.05));
      else if (frameEMA > 1 / 48) target = renderScale * 0.86;
      else if (frameEMA < 1 / 57) target = renderScale * 1.07;
      target = Math.min(st.fx.quality, Math.max(0.35, target));
      // Move halfway, in 5% steps, so render targets are not reallocated constantly.
      const next = Math.round((renderScale + (target - renderScale) * 0.5) * 20) / 20;
      if (Math.abs(next - renderScale) >= 0.05 || target === st.fx.quality) renderScale = Math.min(st.fx.quality, next);
    }
  }

  resizeCanvas();
  if (!app.dirty && !app.capture) return;
  app.dirty = false;

  const { lo, hi } = clipBox();
  gpuTimer.begin();
  renderer.render(sim, {
    camera: camera.state(),
    shift: lensShift,
    clipMin: lo,
    clipMax: hi,
    t: smooth || app.transDur >= 0.3 ? app.transT : 1,
    states: app.simRule().states,
    cellSize: st.view.cellSize,
    decayShrink: st.view.decayShrink,
    showDying: st.view.showDying,
    colorMode: st.view.colorMode,
    ageScale: st.view.ageScale,
    glow: st.fx.glow,
    theme: st.view.theme,
    lightAz: st.fx.lightAz,
    lightEl: st.fx.lightEl,
    shadows: st.fx.shadows,
    ao: st.fx.ao,
    edges: st.fx.edges,
    fog: st.fx.fog,
    floor: st.fx.floor,
    frame: st.fx.frame,
    bloom: st.fx.bloom,
    fxaa: st.fx.fxaa,
    outW: canvas.width,
    outH: canvas.height,
    time: now / 1000,
  });
  gpuTimer.end();
  $('stMeta').textContent = `${sim.N}³ · ${renderer.w}×${renderer.h}`;

  if (app.capture) {
    const { full, resolve } = app.capture;
    app.capture = null;
    if (full) {
      resolve(canvas.toDataURL('image/png'));
    } else {
      // Square crop around where the structure is drawn (accounts for lens shift).
      const c = document.createElement('canvas');
      c.width = c.height = 320;
      const side = Math.min(canvas.width, canvas.height) * 0.92;
      const cx = (lensShift * 0.5 + 0.5) * canvas.width;
      const sx = Math.max(0, Math.min(canvas.width - side, cx - side / 2));
      c.getContext('2d').drawImage(canvas, sx, (canvas.height - side) / 2, side, side, 0, 0, 320, 320);
      resolve(c.toDataURL('image/jpeg', 0.86));
    }
  }
}
requestAnimationFrame(frame);

// Console access for tinkering: cellular.app.state, cellular.sim, …
window.cellular = { app, sim, renderer, camera, Catalog, tick: () => tick(performance.now()) };
