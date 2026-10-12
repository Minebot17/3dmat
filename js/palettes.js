// Colour palettes (index 0 = freshly alive, 1 = fully decayed) and scene themes.

export const PALETTES = {
  aurora: { name: 'Аврора', stops: ['#62f4ff', '#4d8dff', '#8b5cff', '#ff4fd8', '#ffa45a'] },
  ember: { name: 'Угли', stops: ['#ffc457', '#ff8a3c', '#ff5a2b', '#c71f37', '#4a0f1f'] },
  magma: { name: 'Магма', stops: ['#ffcf70', '#fe8f6d', '#de4968', '#8c2981', '#3b0f70'] },
  ice: { name: 'Лёд', stops: ['#bff4ff', '#5cc8ff', '#3d7bff', '#5a3fe0', '#24125e'] },
  neon: { name: 'Неон', stops: ['#c4ff3b', '#21f5c5', '#22a6ff', '#a347ff', '#ff2e97'] },
  sunset: { name: 'Закат', stops: ['#ffc46b', '#ff8f5b', '#ff5f8a', '#c34a99', '#4b3a9c'] },
  viridis: { name: 'Виридис', stops: ['#fde725', '#7ad151', '#22a884', '#2a788e', '#414487'] },
  forest: { name: 'Лес', stops: ['#c8f56e', '#7ed957', '#3fa34d', '#1f6f5c', '#123c48'] },
  candy: { name: 'Карамель', stops: ['#ff9ccf', '#d4a6ff', '#9ec5ff', '#8fe8ff', '#b4ffd6'] },
  gold: { name: 'Золото', stops: ['#ffd76b', '#f2ac2c', '#cc7a1a', '#8a4a10', '#3d2108'] },
  mono: { name: 'Графит', stops: ['#ffffff', '#dfe3ea', '#aab2bf', '#6c7685', '#363c47'] },
};

export const COLOR_MODES = [
  ['state', 'Состояние'],
  ['age', 'Возраст'],
  ['radial', 'Расстояние от центра'],
  ['height', 'Высота'],
  ['rgb', 'RGB-куб'],
];
export const COLOR_MODE_INDEX = { state: 0, age: 1, radial: 2, height: 3, rgb: 4 };

export const THEMES = {
  midnight: {
    name: 'Полночь', top: '#141a35', bottom: '#04050a', glow: '#2b3c80', floor: '#1b2140',
    frame: '#9fb0ff', sky: '#a9b8ff', ground: '#3a2f4c', sun: '#fff0dc', exposure: 1.0,
  },
  dusk: {
    name: 'Сумерки', top: '#2c1745', bottom: '#0b0512', glow: '#73318a', floor: '#251630',
    frame: '#ffa6d8', sky: '#cdb0ff', ground: '#4a2440', sun: '#ffdcbc', exposure: 1.0,
  },
  void: {
    name: 'Бездна', top: '#060609', bottom: '#000000', glow: '#13131c', floor: '#0c0c11',
    frame: '#6d7383', sky: '#8a93a8', ground: '#211f27', sun: '#ffffff', exposure: 1.0,
  },
  studio: {
    name: 'Студия', top: '#f5f6f9', bottom: '#d6dae2', glow: '#ffffff', floor: '#eef0f4',
    frame: '#4c5566', sky: '#e9eef8', ground: '#b7aea4', sun: '#fff5e8', exposure: 1.05,
  },
};

export function paletteBytes(stops, width = 256) {
  const cols = stops.map((h) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
  const out = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const f = (i / (width - 1)) * (cols.length - 1);
    const a = Math.min(cols.length - 2, Math.floor(f));
    const t = f - a;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(cols[a][c] + (cols[a + 1][c] - cols[a][c]) * t);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function paletteCSS(stops, angle = 90) {
  return `linear-gradient(${angle}deg, ${stops.join(', ')})`;
}
