// Rule model, notation "S/B/C/N" (survive / birth / states / neighbourhood),
// presets, random generation and mutation.

export const NEIGHBORHOODS = {
  M: { id: 'M', label: 'Мур', max: 26 },
  E: { id: 'E', label: 'Рёбра', max: 18 },
  VN: { id: 'VN', label: 'Фон Нейман', max: 6 },
};
export const NEIGH_INDEX = { M: 0, VN: 1, E: 2 };

export function maxNeighbors(nb) {
  return NEIGHBORHOODS[nb]?.max ?? 26;
}

export function listFromMask(mask, max = 26) {
  const out = [];
  for (let i = 0; i <= max; i++) if (mask & (1 << i)) out.push(i);
  return out;
}

export function maskFromList(list) {
  let m = 0;
  for (const n of list) m |= 1 << n;
  return m >>> 0;
}

function formatSet(mask, max) {
  const l = listFromMask(mask, max);
  const parts = [];
  for (let i = 0; i < l.length; ) {
    let j = i;
    while (j + 1 < l.length && l[j + 1] === l[j] + 1) j++;
    if (j - i >= 2) parts.push(`${l[i]}-${l[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(l[k]));
    i = j + 1;
  }
  return parts.join(',');
}

function parseSet(str, max) {
  str = str.trim().replace(/^[sb]/i, '');
  let mask = 0;
  if (!str) return 0;
  for (const part of str.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`Не понимаю «${p}»`);
    const a = +m[1];
    const b = m[2] !== undefined ? +m[2] : a;
    if (a > b) throw new Error(`Диапазон «${p}» перевёрнут`);
    if (b > max) throw new Error(`${b} больше максимума соседей (${max})`);
    for (let i = a; i <= b; i++) mask |= 1 << i;
  }
  return mask >>> 0;
}

export function parseRule(text) {
  const parts = String(text).trim().split('/');
  if (parts.length < 3 || parts.length > 4) throw new Error('Формат: выживание/рождение/состояния/окрестность');
  let nb = (parts[3] ?? 'M').trim().toUpperCase();
  if (nb === 'N' || nb === 'V') nb = 'VN';
  if (!NEIGHBORHOODS[nb]) throw new Error('Окрестность: M, E или VN');
  const max = maxNeighbors(nb);
  const states = parseInt(parts[2], 10);
  if (!Number.isFinite(states) || states < 2 || states > 64) throw new Error('Состояний: от 2 до 64');
  return {
    survive: parseSet(parts[0], max),
    birth: parseSet(parts[1], max),
    states,
    neighborhood: nb,
  };
}

export function formatRule(r) {
  const max = maxNeighbors(r.neighborhood);
  return `${formatSet(r.survive, max)}/${formatSet(r.birth, max)}/${r.states}/${r.neighborhood}`;
}

export function sameRule(a, b) {
  return a && b && a.survive === b.survive && a.birth === b.birth && a.states === b.states && a.neighborhood === b.neighborhood;
}

export function clampToNeighborhood(r) {
  const max = maxNeighbors(r.neighborhood);
  const keep = (2 ** (max + 1) - 1) >>> 0;
  return { ...r, survive: (r.survive & keep) >>> 0, birth: (r.birth & keep) >>> 0 };
}

// ---------------------------------------------------------------------------
// Presets. Classic 3D rules (largely from Jason Rampe / Softology's catalogue).
// ---------------------------------------------------------------------------
const cube = (size, density = 0.5, extra = {}) => ({ shape: 'cube', size, density, symmetry: 'none', ...extra });

export const PRESETS = [
  { name: '445', rule: '4/4/5/M', seed: cube(24, 0.5, { value: 5 }), view: { palette: 'aurora', colorMode: 'state' } },
  { name: 'Pyroclastic', rule: '4-7/6-8/10/M', seed: cube(14, 0.5), view: { palette: 'ember', colorMode: 'state' } },
  { name: 'Amoeba', rule: '9-26/5-7,12,13,15/5/M', seed: cube(18, 0.5), view: { palette: 'candy', colorMode: 'state' } },
  { name: 'Coral', rule: '5-8/6,7,9,12/4/M', seed: cube(14, 0.5), view: { palette: 'sunset', colorMode: 'state' } },
  { name: 'Builder', rule: '2,6,9/4,6,8,9/10/M', seed: cube(8, 0.5, { symmetry: 'mirror' }), view: { palette: 'gold', colorMode: 'state' } },
  { name: 'Clouds', rule: '13-26/13,14,17-19/2/M', seed: cube(256, 0.5), view: { palette: 'ice', colorMode: 'radial' } },
  { name: 'Crystal Growth', rule: '0-6/1,3/2/VN', seed: { shape: 'point', size: 1, density: 1, symmetry: 'none' }, view: { palette: 'ice', colorMode: 'age' } },
  { name: 'Crystal Growth II', rule: '1,2/1,3/5/VN', seed: { shape: 'point', size: 1, density: 1, symmetry: 'none' }, view: { palette: 'neon', colorMode: 'state' } },
  { name: 'Diamond Growth', rule: '5,6/1-3/7/VN', seed: { shape: 'point', size: 1, density: 1, symmetry: 'none' }, view: { palette: 'aurora', colorMode: 'state' } },
  { name: 'Expanding Shell', rule: '6-9,11,13,15,16,18/6-10,13,14,16,18-26/2/M', seed: cube(6, 0.6, { symmetry: 'cubic' }), view: { palette: 'magma', colorMode: 'age' } },
  { name: 'Pulse Waves', rule: '3/1-3/10/M', seed: cube(6, 0.5, { symmetry: 'mirror' }), view: { palette: 'neon', colorMode: 'state' } },
  { name: 'Shells', rule: '3,5,7,9,11,15,17,19,21,23,24,26/3,6,8,9,11,14-17,19,24/7/M', seed: cube(10, 0.5), view: { palette: 'viridis', colorMode: 'state' } },
  { name: 'Single Point', rule: '/1/2/M', seed: { shape: 'point', size: 1, density: 1, symmetry: 'none' }, view: { palette: 'aurora', colorMode: 'radial' } },
  { name: 'Stable Structures', rule: '13-26/14-19/2/M', seed: cube(256, 0.5), view: { palette: 'mono', colorMode: 'radial' } },
  { name: 'More Structures', rule: '7-26/4/4/M', seed: cube(16, 0.5), view: { palette: 'sunset', colorMode: 'state' } },
  { name: 'Construction', rule: '0-2,4,6-11,13-17,21-26/9,10,16,23,24/2/M', seed: cube(22, 0.5), view: { palette: 'gold', colorMode: 'age' } },
  { name: 'Symmetry', rule: '/2/10/M', seed: cube(4, 0.5, { symmetry: 'cubic' }), view: { palette: 'aurora', colorMode: 'state' } },
  { name: 'Von Neumann Builder', rule: '1-3/1,4,5/5/VN', seed: cube(4, 0.5, { symmetry: 'mirror' }), view: { palette: 'ember', colorMode: 'state' } },
  { name: 'Architecture', rule: '4-6/3/2/M', seed: cube(10, 0.45), view: { palette: 'mono', colorMode: 'age' } },
];

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------
export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickWeighted = (rng, items) => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = rng() * total;
  for (const [v, w] of items) if ((x -= w) <= 0) return v;
  return items[items.length - 1][0];
};

const randInt = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));

// 1..3 random intervals; `lo`/`hi` bound where intervals start.
function randomSet(rng, max, lo, hi, maxLen) {
  let mask = 0;
  const parts = pickWeighted(rng, [[1, 4], [2, 4], [3, 2]]);
  for (let p = 0; p < parts; p++) {
    const start = randInt(rng, lo, hi);
    const len = 1 + Math.floor(Math.pow(rng(), 1.6) * maxLen);
    for (let i = start; i < Math.min(max + 1, start + len); i++) mask |= 1 << i;
  }
  return mask >>> 0;
}

export function randomRule(rng = Math.random) {
  const neighborhood = pickWeighted(rng, [['M', 70], ['E', 18], ['VN', 12]]);
  const max = maxNeighbors(neighborhood);
  const states = pickWeighted(rng, [
    [2, 14], [3, 10], [4, 12], [5, 12], [6, 9], [7, 7], [8, 7], [10, 6], [12, 5], [16, 3], [20, 2],
  ]);
  const birth = randomSet(rng, max, 1, Math.max(2, Math.round(max * 0.55)), Math.max(2, Math.round(max * 0.25)));
  const survive = randomSet(rng, max, 0, max, Math.max(2, Math.round(max * 0.45)));
  return { survive, birth: birth || 1 << randInt(rng, 1, 4), states, neighborhood };
}

export function mutateRule(rule, rng = Math.random) {
  let r = { ...rule };
  const max = maxNeighbors(r.neighborhood);
  const ops = 1 + Math.floor(rng() * 2.2);
  for (let k = 0; k < ops; k++) {
    const op = pickWeighted(rng, [['birth', 35], ['survive', 40], ['states', 18], ['nb', 7]]);
    if (op === 'birth') {
      r.birth = (r.birth ^ (1 << randInt(rng, 1, Math.max(1, Math.round(max * 0.7))))) >>> 0;
    } else if (op === 'survive') {
      r.survive = (r.survive ^ (1 << randInt(rng, 0, max))) >>> 0;
    } else if (op === 'states') {
      r.states = Math.max(2, Math.min(24, r.states + (rng() < 0.5 ? -1 : 1) * randInt(rng, 1, 3)));
    } else {
      const options = Object.keys(NEIGHBORHOODS).filter((n) => n !== r.neighborhood);
      r.neighborhood = options[Math.floor(rng() * options.length)];
      r = clampToNeighborhood(r);
    }
  }
  if (!r.birth) r.birth = (1 << randInt(rng, 1, Math.min(4, maxNeighbors(r.neighborhood)))) >>> 0;
  return r;
}

const ADJ = ['Тихий', 'Звёздный', 'Хрустальный', 'Живой', 'Спящий', 'Огненный', 'Ледяной', 'Бархатный', 'Странный',
  'Неоновый', 'Древний', 'Призрачный', 'Медовый', 'Изумрудный', 'Солнечный', 'Глубокий', 'Дикий', 'Лунный',
  'Шёлковый', 'Янтарный', 'Пульсирующий', 'Туманный', 'Кварцевый', 'Северный'];
const NOUN = ['коралл', 'кристалл', 'рой', 'улей', 'лабиринт', 'фрактал', 'кокон', 'узор', 'собор', 'вихрь', 'риф',
  'город', 'организм', 'мицелий', 'каркас', 'пульсар', 'туман', 'грот', 'купол', 'сад', 'атолл', 'шпиль', 'остов', 'бутон'];

export function randomName(rng = Math.random) {
  return `${ADJ[Math.floor(rng() * ADJ.length)]} ${NOUN[Math.floor(rng() * NOUN.length)]}`;
}
