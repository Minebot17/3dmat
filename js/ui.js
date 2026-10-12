// DOM helpers, settings panel builder, rule editor, catalogue cards, toasts.

import { PALETTES, paletteCSS } from './palettes.js';
import { NEIGHBORHOODS, PRESETS, maxNeighbors, formatRule, parseRule, sameRule, clampToNeighborhood } from './rules.js';
import { ICONS } from './icons.js';

export function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

export const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
export function setPath(o, path, v) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((a, k) => a[k], o)[last] = v;
}

export const pct = (v) => `${Math.round(v * 100)}%`;

// ---------------------------------------------------------------------------
// Generic controls. Each returns { el, refresh } and calls app.onSetting(item).
// ---------------------------------------------------------------------------
function rangeCtl(app, it) {
  const out = h('output');
  const input = h('input', { type: 'range', min: it.min, step: it.step ?? 1, 'aria-label': it.label });
  const maxOf = () => (typeof it.max === 'function' ? it.max() : it.max);
  const paint = () => {
    const v = +input.value;
    out.textContent = it.fmt ? it.fmt(v) : String(v);
    input.style.setProperty('--p', `${((v - it.min) / (maxOf() - it.min)) * 100}%`);
  };
  input.addEventListener('input', () => {
    setPath(app.state, it.key, +input.value);
    paint();
    app.onSetting(it);
  });
  const el = h('div', { class: 'ctl ctl-range' }, h('div', { class: 'ctl-head' }, h('label', null, it.label), out), input);
  return {
    el,
    refresh() {
      input.max = maxOf();
      input.value = getPath(app.state, it.key);
      paint();
    },
  };
}

function toggleCtl(app, it) {
  const input = h('input', { type: 'checkbox' });
  input.addEventListener('change', () => {
    setPath(app.state, it.key, input.checked);
    app.onSetting(it);
  });
  const el = h('label', { class: 'ctl ctl-toggle' }, h('span', null, it.label), input, h('i', { class: 'switch' }));
  return { el, refresh: () => { input.checked = !!getPath(app.state, it.key); } };
}

function selectCtl(app, it) {
  const sel = h('select', { 'aria-label': it.label }, it.options.map(([v, l]) => h('option', { value: v }, l)));
  sel.addEventListener('change', () => {
    setPath(app.state, it.key, it.num ? +sel.value : sel.value);
    app.onSetting(it);
  });
  const el = h('label', { class: 'ctl ctl-select' }, h('span', null, it.label), h('div', { class: 'select-wrap' }, sel));
  return { el, refresh: () => { sel.value = String(getPath(app.state, it.key)); } };
}

function segCtl(app, it) {
  const btns = it.options.map(([v, l]) =>
    h('button', {
      type: 'button',
      'data-v': v,
      onclick: () => {
        setPath(app.state, it.key, v);
        refresh();
        app.onSetting(it);
      },
    }, l));
  const refresh = () => {
    const cur = String(getPath(app.state, it.key));
    btns.forEach((b) => b.classList.toggle('active', b.dataset.v === cur));
  };
  const el = h('div', { class: 'ctl ctl-seg' }, it.label && h('span', { class: 'ctl-label' }, it.label), h('div', { class: 'seg' }, btns));
  return { el, refresh };
}

function paletteCtl(app, it) {
  const name = h('output');
  const items = Object.entries(PALETTES).map(([k, p]) =>
    h('button', {
      type: 'button',
      class: 'swatch',
      title: p.name,
      'data-v': k,
      style: { background: paletteCSS(p.stops, 135) },
      onclick: () => {
        setPath(app.state, it.key, k);
        refresh();
        app.onSetting(it);
      },
    }));
  const refresh = () => {
    const cur = getPath(app.state, it.key);
    items.forEach((b) => b.classList.toggle('active', b.dataset.v === cur));
    name.textContent = PALETTES[cur]?.name ?? '';
  };
  const el = h('div', { class: 'ctl ctl-palette' },
    h('div', { class: 'ctl-head' }, h('label', null, 'Палитра'), name),
    h('div', { class: 'swatches' }, items));
  return { el, refresh };
}

function seedValueCtl(app) {
  const input = h('input', { type: 'number', min: 0, max: 4294967295, class: 'mono', 'aria-label': 'Зерно' });
  input.addEventListener('change', () => {
    app.state.seed.value = Math.max(0, Math.floor(+input.value || 0)) >>> 0;
    app.reseed();
  });
  const el = h('div', { class: 'ctl ctl-inline' },
    h('span', null, 'Зерно генератора'),
    h('div', { class: 'inline-group' },
      input,
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Новое зерно (Shift+R)', html: ICONS.dice, onclick: () => app.reseed(true) })));
  return { el, refresh: () => { input.value = app.state.seed.value; } };
}

function ruleEditor(app) {
  const presetSel = h('select', { 'aria-label': 'Пресет' },
    h('option', { value: '' }, '— своё правило —'),
    PRESETS.map((p, i) => h('option', { value: i }, p.name)));
  presetSel.addEventListener('change', () => {
    if (presetSel.value !== '') app.applyPreset(PRESETS[+presetSel.value]);
  });

  const input = h('input', { class: 'rule-input mono', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Нотация правила' });
  const err = h('div', { class: 'rule-error' });
  const commit = () => {
    try {
      const r = parseRule(input.value);
      err.textContent = '';
      input.classList.remove('bad');
      if (!sameRule(r, app.rule)) app.setRule(r, null);
    } catch (e) {
      err.textContent = e.message;
      input.classList.add('bad');
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      input.blur();
    }
  });
  input.addEventListener('change', commit);

  const nbBtns = Object.values(NEIGHBORHOODS).map((n) =>
    h('button', {
      type: 'button',
      'data-v': n.id,
      title: `${n.max} соседей`,
      onclick: () => app.setRule(clampToNeighborhood({ ...app.rule, neighborhood: n.id }), null),
    }, n.label, h('small', null, n.max)));

  const statesOut = h('output');
  const statesInput = h('input', { type: 'range', min: 2, max: 24, step: 1, 'aria-label': 'Число состояний' });
  statesInput.addEventListener('input', () => app.setRule({ ...app.rule, states: +statesInput.value }, null));

  const chipRow = (title, hint, field) => {
    const chips = Array.from({ length: 27 }, (_, n) =>
      h('button', {
        type: 'button',
        class: 'chip',
        onclick: () => app.setRule({ ...app.rule, [field]: (app.rule[field] ^ (1 << n)) >>> 0 }, null),
      }, n));
    const el = h('div', { class: 'chip-block' },
      h('div', { class: 'chip-title' }, title, h('span', null, hint)),
      h('div', { class: 'chips' }, chips));
    const refresh = () => {
      const max = maxNeighbors(app.rule.neighborhood);
      chips.forEach((c, n) => {
        c.hidden = n > max;
        c.classList.toggle('on', !!(app.rule[field] & (1 << n)));
      });
    };
    return { el, refresh };
  };
  const survive = chipRow('Выживание', 'живая клетка остаётся при N соседях', 'survive');
  const birth = chipRow('Рождение', 'пустая клетка оживает при N соседях', 'birth');
  const smart = toggleCtl(app, { key: 'smart', label: 'Отсеивать скучные правила' });

  const el = h('div', { class: 'rule-editor' },
    h('label', { class: 'ctl ctl-select' }, h('span', null, 'Пресет'), h('div', { class: 'select-wrap' }, presetSel)),
    h('div', { class: 'ctl' },
      h('div', { class: 'ctl-head' }, h('label', null, 'Нотация'), h('span', { class: 'muted' }, 'выжив. / рожд. / сост. / окр.')),
      input, err),
    h('div', { class: 'ctl ctl-seg' }, h('span', { class: 'ctl-label' }, 'Окрестность'), h('div', { class: 'seg' }, nbBtns)),
    h('div', { class: 'ctl ctl-range' },
      h('div', { class: 'ctl-head' }, h('label', null, 'Состояний'), statesOut),
      statesInput),
    survive.el,
    birth.el,
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn accent', html: `${ICONS.dice}<span>Случайное</span>`, onclick: () => app.randomize() }),
      h('button', { type: 'button', class: 'btn', html: `${ICONS.mutate}<span>Мутация</span>`, onclick: () => app.mutate() })),
    smart.el);

  const refresh = () => {
    if (document.activeElement !== input) {
      input.value = formatRule(app.rule);
      input.classList.remove('bad');
      err.textContent = '';
    }
    const idx = PRESETS.findIndex((p) => sameRule(parseRule(p.rule), app.rule));
    presetSel.value = idx >= 0 ? String(idx) : '';
    nbBtns.forEach((b) => b.classList.toggle('active', b.dataset.v === app.rule.neighborhood));
    const binary = app.state.sim.binary;
    statesInput.value = app.rule.states;
    statesInput.disabled = binary;
    statesOut.textContent = binary
      ? '0/1 · двоичный режим'
      : app.rule.states === 2 ? '2 · без угасания' : `${app.rule.states} · угасание ${app.rule.states - 2}`;
    statesInput.style.setProperty('--p', `${((app.rule.states - 2) / 22) * 100}%`);
    survive.refresh();
    birth.refresh();
    smart.refresh();
  };
  return { el, refresh };
}

const BUILDERS = {
  range: rangeCtl,
  toggle: toggleCtl,
  select: selectCtl,
  seg: segCtl,
  palette: paletteCtl,
  seedValue: seedValueCtl,
  rule: ruleEditor,
};

const OPEN_KEY = 'cellular3d.sections';

export function buildPanel(root, app, sections) {
  let open;
  try { open = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null'); } catch { open = null; }
  const ctls = [];
  for (const sec of sections) {
    const body = h('div', { class: 'sec-body' });
    for (const it of sec.items) {
      const c = BUILDERS[it.type](app, it);
      body.append(c.el);
      ctls.push(c);
    }
    const isOpen = open ? open.includes(sec.id) : sec.open;
    const det = h('details', { class: 'sec', 'data-id': sec.id, open: isOpen || null },
      h('summary', null, h('span', null, sec.title), h('i', { class: 'chev', html: ICONS.chevron })),
      body);
    det.addEventListener('toggle', () => {
      const ids = [...root.querySelectorAll('details.sec[open]')].map((d) => d.dataset.id);
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
    });
    root.append(det);
  }
  return { refresh: () => ctls.forEach((c) => c.refresh()) };
}

// ---------------------------------------------------------------------------
// Catalogue cards
// ---------------------------------------------------------------------------
const fmtDate = (t) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

export function renderCards(container, items, opts) {
  container.replaceChildren();
  if (!items.length) {
    container.append(h('div', { class: 'empty' },
      h('div', { class: 'empty-icon', html: ICONS.cube }),
      h('p', null, opts.emptyText)));
    return;
  }
  for (const it of items) {
    const stops = PALETTES[it.config?.view?.palette ?? 'aurora']?.stops ?? PALETTES.aurora.stops;
    const thumb = it.thumb
      ? h('img', { src: it.thumb, alt: '', loading: 'lazy' })
      : h('div', { class: 'thumb-ph', 'data-thumb': it.name, style: { background: paletteCSS(stops, 135) } },
        h('span', { class: opts.preset ? 'ph-icon loading' : 'ph-icon', html: ICONS.cube }));
    const title = h('div', { class: 'card-title', title: it.name }, it.name);
    const meta = [];
    if (it.config?.sim?.size) meta.push(`${it.config.sim.size}³`);
    if (it.created) meta.push(fmtDate(it.created));
    if (opts.preset) meta.push('встроенное');

    const actions = [
      h('button', { type: 'button', class: 'btn sm accent', html: `${ICONS.load}<span>Открыть</span>`, onclick: () => opts.onLoad(it) }),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Скопировать ссылку', html: ICONS.link, onclick: () => opts.onShare(it) }),
    ];
    if (!opts.preset) {
      actions.push(h('button', {
        type: 'button', class: 'icon-btn sm', title: 'Переименовать', html: ICONS.edit,
        onclick: () => {
          const input = h('input', { class: 'rename', value: it.name, maxlength: 60 });
          const done = (save) => {
            if (save && input.value.trim()) opts.onRename(it, input.value.trim());
            else input.replaceWith(title);
          };
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') done(true);
            if (e.key === 'Escape') { e.stopPropagation(); done(false); }
          });
          input.addEventListener('blur', () => done(true));
          title.replaceWith(input);
          input.focus();
          input.select();
        },
      }));
      const del = h('button', { type: 'button', class: 'icon-btn sm danger', title: 'Удалить', html: ICONS.trash });
      let armed = 0;
      del.addEventListener('click', () => {
        if (Date.now() - armed < 2500) return opts.onDelete(it);
        armed = Date.now();
        del.classList.add('armed');
        del.title = 'Нажмите ещё раз для удаления';
        setTimeout(() => { del.classList.remove('armed'); del.title = 'Удалить'; }, 2500);
      });
      actions.push(del);
    }

    container.append(h('article', { class: 'card' },
      h('button', { type: 'button', class: 'thumb', title: 'Открыть', onclick: () => opts.onLoad(it) }, thumb),
      h('div', { class: 'card-body' },
        title,
        h('code', { class: 'card-rule' }, it.rule),
        h('div', { class: 'card-meta' }, meta.join(' · '))),
      h('div', { class: 'card-actions' }, actions)));
  }
}

// ---------------------------------------------------------------------------
// Toasts & sparkline
// ---------------------------------------------------------------------------
export function toast(msg, kind = 'info') {
  const host = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}` }, msg);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 350);
  }, 2600);
}

export function drawSpark(canvas, values) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const hh = canvas.clientHeight;
  if (!w || !hh) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hh);
  if (values.length < 2) return;
  let max = 1;
  for (const v of values) if (v > max) max = v;
  const n = values.length;
  const x = (i) => (i / (n - 1)) * (w - 4) + 2;
  const y = (v) => hh - 3 - (v / max) * (hh - 8);
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  const line = ctx.createLinearGradient(0, 0, w, 0);
  line.addColorStop(0, 'rgba(98,244,255,0.9)');
  line.addColorStop(1, 'rgba(160,110,255,1)');
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.lineTo(x(n - 1), hh);
  ctx.lineTo(x(0), hh);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, 0, 0, hh);
  fill.addColorStop(0, 'rgba(130,120,255,0.28)');
  fill.addColorStop(1, 'rgba(130,120,255,0)');
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x(n - 1), y(values[n - 1]), 2.4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
}
