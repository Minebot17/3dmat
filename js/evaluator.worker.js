// Screens random rules on a small CPU simulation so the "random" button lands
// on something alive: rejects rules that die, flood the volume, or freeze.

import { randomRule, mutateRule, mulberry32 } from './rules.js';

export const G = 36;          // interior grid size
const STEPS = 36;

const P = G + 2;
const P2 = P * P;
const V = P * P * P;
const cur0 = new Uint8Array(V);
const nxt0 = new Uint8Array(V);
const alive = new Uint8Array(V);
const sx = new Uint8Array(V);
const sy = new Uint8Array(V);
const cr = new Uint8Array(V);
const cnt = new Uint8Array(V);

// JS port of the GPU seed shader (shaders.js FS_SEED) so the screening run
// starts from exactly the cells the GPU will create, cropped to G^3.
function pcg3dx(x, y, z) {
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y, 1664525) + 1013904223) >>> 0;
  z = (Math.imul(z, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0; y = (y + Math.imul(z, x)) >>> 0; z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0; y = (y ^ (y >>> 16)) >>> 0; z = (z ^ (z >>> 16)) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  return x;
}

const SHAPES = ['cube', 'sphere', 'shell', 'point', 'scatter', 'cross', 'disc'];
const SYM = { none: 0, mirror: 1, cubic: 2 };

export function seedCell(px, py, pz, cfg, s1, s2, s3) {
  const dx = 2 * px + 1 - G, dy = 2 * py + 1 - G, dz = 2 * pz + 1 - G;
  let kx = dx, ky = dy, kz = dz;
  const sym = SYM[cfg.symmetry] ?? 0;
  if (sym >= 1) { kx = Math.abs(dx); ky = Math.abs(dy); kz = Math.abs(dz); }
  if (sym === 2) {
    const a = Math.min(kx, ky, kz), b = Math.max(kx, ky, kz);
    ky = kx + ky + kz - a - b; kx = a; kz = b;
  }
  const ax = Math.abs(dx) * 0.5, ay = Math.abs(dy) * 0.5, az = Math.abs(dz) * 0.5;
  const r = cfg.sizeN * 0.5;
  const shape = Math.max(0, SHAPES.indexOf(cfg.shape));
  let dens = cfg.density;
  let inside = false;
  if (shape === 0) inside = Math.max(ax, ay, az) < r;
  else if (shape === 1) inside = Math.hypot(ax, ay, az) < r;
  else if (shape === 2) inside = Math.abs(Math.hypot(ax, ay, az) - r) < 0.8;
  else if (shape === 3) return px === G / 2 && py === G / 2 && pz === G / 2 ? 1 : 0;
  else if (shape === 4) { inside = Math.max(ax, ay, az) < r; dens *= 0.03; }
  else if (shape === 5) inside = Math.max(ax, ay, az) < r && (ax < 1) + (ay < 1) + (az < 1) >= 2;
  else if (shape === 6) inside = Math.hypot(ax, az) < r && ay < 1;
  if (!inside) return 0;
  const h = pcg3dx(((kx + 2048) ^ s1) >>> 0, ((ky + 2048) ^ s2) >>> 0, ((kz + 2048) ^ s3) >>> 0);
  return (h >>> 8) / 16777216 < dens ? 1 : 0;
}

const DEFAULT_SEED = { shape: 'cube', size: 8, density: 0.5, symmetry: 'none', value: 1, gridSize: 96 };

export function evaluate(rule, seedCfg = DEFAULT_SEED) {
  let cur = cur0, nxt = nxt0;
  cur.fill(0);
  nxt.fill(0);
  const cfg = { ...DEFAULT_SEED, ...seedCfg };
  cfg.sizeN = Math.min(cfg.size, cfg.gridSize);
  const sv = cfg.value >>> 0;
  const s1 = Math.imul(sv, 0x9e3779b9) >>> 0, s2 = Math.imul(sv, 0x85ebca6b) >>> 0, s3 = Math.imul(sv, 0xc2b2ae35) >>> 0;
  let seedExtent = 0;
  let pop0 = 0;
  for (let z = 0; z < G; z++)
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++)
        if (seedCell(x, y, z, cfg, s1, s2, s3)) {
          cur[(z + 1) * P2 + (y + 1) * P + x + 1] = 1;
          pop0++;
          seedExtent = Math.max(seedExtent, Math.abs(2 * x + 1 - G), Math.abs(2 * y + 1 - G), Math.abs(2 * z + 1 - G));
        }
  if (!seedExtent) return { ok: false, score: -3, reason: 'empty' };
  seedExtent = seedExtent + 1; // doubled half-extent + 1 = full extent in cells
  // A seed that fills the test box (e.g. full-volume noise) can't "grow" or be
  // told apart from flooding, so it is judged on reorganisation instead.
  const big = seedExtent >= G - 2;

  const { birth, survive, states: S, neighborhood: nb } = rule;
  const total = G * G * G;
  const hist = [];
  let bbox = null;

  for (let step = 0; step < STEPS; step++) {
    for (let i = 0; i < V; i++) alive[i] = cur[i] === 1 ? 1 : 0;

    if (nb === 'VN') {
      for (let z = 1; z <= G; z++) for (let y = 1; y <= G; y++) {
        const base = z * P2 + y * P;
        for (let x = 1; x <= G; x++) {
          const i = base + x;
          cnt[i] = alive[i - 1] + alive[i + 1] + alive[i - P] + alive[i + P] + alive[i - P2] + alive[i + P2];
        }
      }
    } else {
      for (let z = 1; z <= G; z++) for (let y = 0; y <= G + 1; y++) {
        const base = z * P2 + y * P;
        for (let x = 1; x <= G; x++) { const i = base + x; sx[i] = alive[i - 1] + alive[i] + alive[i + 1]; }
      }
      for (let z = 1; z <= G; z++) for (let y = 1; y <= G; y++) {
        const base = z * P2 + y * P;
        for (let x = 1; x <= G; x++) { const i = base + x; sy[i] = sx[i - P] + sx[i] + sx[i + P]; }
      }
      if (nb === 'M') {
        for (let z = 1; z <= G; z++) for (let y = 1; y <= G; y++) {
          const base = z * P2 + y * P;
          for (let x = 1; x <= G; x++) { const i = base + x; cnt[i] = sy[i - P2] + sy[i] + sy[i + P2] - alive[i]; }
        }
      } else {
        for (let z = 1; z <= G; z++) for (let y = 1; y <= G; y++) {
          const base = z * P2 + y * P;
          for (let x = 1; x <= G; x++) { const i = base + x; cr[i] = alive[i] + alive[i - 1] + alive[i + 1] + alive[i - P] + alive[i + P]; }
        }
        for (let z = 1; z <= G; z++) for (let y = 1; y <= G; y++) {
          const base = z * P2 + y * P;
          for (let x = 1; x <= G; x++) { const i = base + x; cnt[i] = sy[i] - alive[i] + cr[i - P2] + cr[i + P2]; }
        }
      }
    }

    const last = step === STEPS - 1;
    let a = 0, vis = 0, changes = 0;
    let x0 = G, x1 = 0, y0 = G, y1 = 0, z0 = G, z1 = 0;
    for (let z = 1; z <= G; z++) for (let y = 1; y <= G; y++) {
      const base = z * P2 + y * P;
      for (let x = 1; x <= G; x++) {
        const i = base + x;
        const c = cur[i];
        let ns;
        if (c === 0) ns = (birth >>> cnt[i]) & 1;
        else if (c === 1) ns = (survive >>> cnt[i]) & 1 ? 1 : S > 2 ? 2 : 0;
        else { ns = c + 1; if (ns >= S) ns = 0; }
        nxt[i] = ns;
        if ((ns === 1) !== (c === 1)) changes++;
        if (ns === 1) a++;
        if (ns) {
          vis++;
          if (last) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            if (z < z0) z0 = z; if (z > z1) z1 = z;
          }
        }
      }
    }
    const t = cur; cur = nxt; nxt = t;
    hist.push({ a, vis, changes });
    if (vis === 0 || (a === 0 && S <= 2)) return { ok: false, score: -2, reason: 'dead' };
    if (a > total * (big ? 0.75 : 0.5) || vis > total * 0.9) return { ok: false, score: -1 + step / STEPS, reason: 'flood' };
    if (last) bbox = { ex: x1 - x0 + 1, ey: y1 - y0 + 1, ez: z1 - z0 + 1 };
  }

  const end = hist[hist.length - 1];
  if (end.a === 0) return { ok: false, score: -1.5, reason: 'fading' };

  // Solidity: share of visible cells buried on all six sides. Solid blobs score high.
  let buried = 0;
  for (let z = 1; z <= G; z++) for (let y = 1; y <= G; y++) {
    const base = z * P2 + y * P;
    for (let x = 1; x <= G; x++) {
      const i = base + x;
      if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - P] && cur[i + P] && cur[i - P2] && cur[i + P2]) buried++;
    }
  }
  const solidity = buried / end.vis;
  const extent = Math.max(bbox.ex, bbox.ey, bbox.ez);
  const bboxVol = bbox.ex * bbox.ey * bbox.ez;
  const bboxDensity = end.vis / bboxVol;
  const aliveDensity = end.a / bboxVol;
  const fill = end.vis / total;
  const recent = hist.slice(-8);
  const activity = recent.reduce((s, h) => s + h.changes, 0) / recent.length / Math.max(1, end.a);
  const frozen = recent.every((h) => h.changes === 0);
  const grew = extent - Math.min(seedExtent, G);

  let score = 0;
  score += Math.min(grew, 14) / 14;                  // growth from the seed is interesting
  score += Math.min(activity * 8, 1) * 0.6;          // ongoing motion
  score -= Math.max(0, bboxDensity - 0.45) * 2.5;    // solid blobs are dull
  score -= Math.max(0, fill - 0.3) * 3;
  score -= Math.max(0, solidity - 0.35) * 2;

  if (big) {
    const reorganised = hist.reduce((sum, h) => sum + h.changes, 0) > pop0 * 0.3;
    const okBig = fill <= 0.75 && solidity <= 0.75 && end.vis >= 12 && reorganised;
    return { ok: okBig, score: score + (reorganised ? 1 : 0), reason: okBig ? 'ok' : 'dull', solidity, activity, grew, bboxDensity };
  }

  let ok = true;
  if (fill > 0.7 || end.a > total * 0.4) ok = false;   // floods the box
  if (solidity > 0.5) ok = false;                       // solid blob
  if (extent >= G - 1 && bboxDensity > 0.55 && solidity > 0.25) ok = false; // dense noise
  if (extent >= G - 1 && aliveDensity > 0.33) ok = false;  // dense mass pushing into the walls
  if (grew < 3) ok = false;                             // never left the seed
  if (frozen && grew < 6) ok = false;
  if (end.vis < 12) ok = false;
  return { ok, score, reason: ok ? 'ok' : 'dull', solidity, activity, grew, bboxDensity, aliveDensity, extent };
}

self.onmessage = ({ data }) => {
  if (data.type !== 'search') return;
  const rng = mulberry32(data.seed >>> 0);
  const t0 = performance.now();
  let best = null;
  let tries = 0;
  while (tries < 600 && performance.now() - t0 < data.budget) {
    const rule = data.base ? mutateRule(data.base, rng) : randomRule(rng);
    tries++;
    const res = evaluate(data.binary ? { ...rule, states: 2 } : rule, data.seedCfg);
    if (!best || res.score > best.score) best = { rule, ...res };
    if (res.ok) {
      self.postMessage({ type: 'result', id: data.id, rule, tries, ok: true });
      return;
    }
  }
  self.postMessage({ type: 'result', id: data.id, rule: best.rule, tries, ok: false });
};
