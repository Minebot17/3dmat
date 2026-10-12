// GLSL sources. Everything runs in WebGL2 (GLSL ES 3.00).

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;
precision highp sampler3D;
`;

// Single oversized triangle that covers the viewport.
export const VS_FULLSCREEN = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// Simulation step. Each draw writes 4 consecutive z-slices through MRT and
// shares the per-plane neighbour sums between them (6 planes instead of 12).
// Cell texel: r = state, g = previous state, b = age (steps alive).
// ---------------------------------------------------------------------------
export const FS_SIM = HEADER + `
uniform usampler3D uState;
uniform int uN;
uniform int uZ0;
uniform bool uWrap;
uniform uint uBirth;
uniform uint uSurvive;
uniform int uStates;
uniform int uNeigh; // 0 = Moore(26), 1 = von Neumann(6), 2 = edges(18)

layout(location = 0) out uvec4 o0;
layout(location = 1) out uvec4 o1;
layout(location = 2) out uvec4 o2;
layout(location = 3) out uvec4 o3;

uint A(ivec3 q) {
  if (uWrap) {
    q = (q + uN) % uN;
  } else if (any(lessThan(q, ivec3(0))) || any(greaterThanEqual(q, ivec3(uN)))) {
    return 0u;
  }
  return texelFetch(uState, q, 0).r == 1u ? 1u : 0u;
}

// x = centre, y = 4 orthogonal, z = 4 diagonal neighbours within a plane
uvec3 plane(ivec2 p, int z) {
  uint c = A(ivec3(p, z));
  uint o = A(ivec3(p.x + 1, p.y, z)) + A(ivec3(p.x - 1, p.y, z))
         + A(ivec3(p.x, p.y + 1, z)) + A(ivec3(p.x, p.y - 1, z));
  uint d = 0u;
  if (uNeigh != 1) {
    d = A(ivec3(p.x + 1, p.y + 1, z)) + A(ivec3(p.x - 1, p.y + 1, z))
      + A(ivec3(p.x + 1, p.y - 1, z)) + A(ivec3(p.x - 1, p.y - 1, z));
  }
  return uvec3(c, o, d);
}

uint countN(uvec3 lo, uvec3 mid, uvec3 hi) {
  if (uNeigh == 0) return lo.x + lo.y + lo.z + mid.y + mid.z + hi.x + hi.y + hi.z;
  if (uNeigh == 1) return lo.x + mid.y + hi.x;
  return lo.x + lo.y + mid.y + mid.z + hi.x + hi.y;
}

uvec4 nextCell(uvec4 cell, uint n) {
  uint s = cell.r;
  uint age = cell.b;
  uint bit = 1u << n;
  uint ns;
  if (s == 0u) {
    ns = (uBirth & bit) != 0u ? 1u : 0u;
    age = 0u;
  } else if (s == 1u) {
    if ((uSurvive & bit) != 0u) {
      ns = 1u;
      age = min(age + 1u, 255u);
    } else {
      ns = uStates > 2 ? 2u : 0u;
    }
  } else {
    ns = s + 1u;
    if (ns >= uint(uStates)) ns = 0u;
  }
  return uvec4(ns, s, age, 0u);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec3 P0 = plane(p, uZ0 - 1);
  uvec3 P1 = plane(p, uZ0);
  uvec3 P2 = plane(p, uZ0 + 1);
  uvec3 P3 = plane(p, uZ0 + 2);
  uvec3 P4 = plane(p, uZ0 + 3);
  uvec3 P5 = plane(p, uZ0 + 4);
  o0 = nextCell(texelFetch(uState, ivec3(p, uZ0), 0),     countN(P0, P1, P2));
  o1 = nextCell(texelFetch(uState, ivec3(p, uZ0 + 1), 0), countN(P1, P2, P3));
  o2 = nextCell(texelFetch(uState, ivec3(p, uZ0 + 2), 0), countN(P2, P3, P4));
  o3 = nextCell(texelFetch(uState, ivec3(p, uZ0 + 3), 0), countN(P3, P4, P5));
}`;

// ---------------------------------------------------------------------------
// Initial conditions, generated on the GPU from a hash (no uploads).
// ---------------------------------------------------------------------------
export const FS_SEED = HEADER + `
uniform int uN;
uniform int uZ0;
uniform int uShape;
uniform int uSym;
uniform float uSize;
uniform float uDensity;
uniform uint uSeed;

layout(location = 0) out uvec4 o0;
layout(location = 1) out uvec4 o1;
layout(location = 2) out uvec4 o2;
layout(location = 3) out uvec4 o3;

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

float rnd(ivec3 k) {
  uvec3 h = pcg3d(uvec3(k + 2048) ^ (uSeed * uvec3(0x9E3779B9u, 0x85EBCA6Bu, 0xC2B2AE35u)));
  return float(h.x >> 8u) / 16777216.0;
}

uint cell(ivec3 p) {
  ivec3 d = 2 * p + 1 - uN;  // doubled offset from the centre
  ivec3 k = d;
  if (uSym >= 1) k = abs(d);
  if (uSym == 2) {
    int a = min(k.x, min(k.y, k.z));
    int b = max(k.x, max(k.y, k.z));
    k = ivec3(a, k.x + k.y + k.z - a - b, b);
  }
  vec3 c = vec3(d) * 0.5;
  vec3 ac = abs(c);
  float r = uSize * 0.5;
  float dens = uDensity;
  bool inside = false;
  if (uShape == 0) {
    inside = max(ac.x, max(ac.y, ac.z)) < r;
  } else if (uShape == 1) {
    inside = length(c) < r;
  } else if (uShape == 2) {
    inside = abs(length(c) - r) < 0.8;
  } else if (uShape == 3) {
    return all(equal(p, ivec3(uN / 2))) ? 1u : 0u;
  } else if (uShape == 4) {
    inside = max(ac.x, max(ac.y, ac.z)) < r;
    dens *= 0.03;
  } else if (uShape == 5) {
    int thin = int(ac.x < 1.0) + int(ac.y < 1.0) + int(ac.z < 1.0);
    inside = max(ac.x, max(ac.y, ac.z)) < r && thin >= 2;
  } else if (uShape == 6) {
    inside = length(c.xz) < r && ac.y < 1.0;
  }
  return (inside && rnd(k) < dens) ? 1u : 0u;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o0 = uvec4(cell(ivec3(p, uZ0)), 0u, 0u, 0u);
  o1 = uvec4(cell(ivec3(p, uZ0 + 1)), 0u, 0u, 0u);
  o2 = uvec4(cell(ivec3(p, uZ0 + 2)), 0u, 0u, 0u);
  o3 = uvec4(cell(ivec3(p, uZ0 + 3)), 0u, 0u, 0u);
}`;

// ---------------------------------------------------------------------------
// 4x4x4 brick summary: r = visible cells (now or previous step), g = alive,
// b = alive-status changes. Used for empty-space skipping, soft AO and stats.
// ---------------------------------------------------------------------------
export const FS_BRICKS = HEADER + `
uniform usampler3D uState;
uniform int uBz;
uniform bool uShowDying;
out vec4 outColor;

bool vis(uint s) { return s == 1u || (s > 1u && uShowDying); }

void main() {
  ivec3 b = ivec3(ivec2(gl_FragCoord.xy), uBz) * 4;
  float occ = 0.0, alive = 0.0, chg = 0.0;
  for (int z = 0; z < 4; z++)
  for (int y = 0; y < 4; y++)
  for (int x = 0; x < 4; x++) {
    uvec4 c = texelFetch(uState, b + ivec3(x, y, z), 0);
    if (vis(c.r) || vis(c.g)) occ += 1.0;
    if (c.r == 1u) alive += 1.0;
    if ((c.r == 1u) != (c.g == 1u)) chg += 1.0;
  }
  outColor = vec4(occ, alive, chg, 0.0) / 255.0;
}`;

// Column-sum of bricks along z for population statistics (read back async).
export const FS_REDUCE = HEADER + `
uniform sampler3D uBricks;
uniform int uNB;
out uvec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 s = vec3(0.0);
  for (int z = 0; z < 64; z++) {
    if (z >= uNB) break;
    s += texelFetch(uBricks, ivec3(p, z), 0).rgb;
  }
  outColor = uvec4(uvec3(round(s * 255.0)), 0u);
}`;

// ---------------------------------------------------------------------------
// Voxel raymarcher: two-level DDA (bricks -> cells), animated cell sizes,
// voxel AO + density AO, hard shadows, floor, frame, depth fog.
// ---------------------------------------------------------------------------
export const FS_RAYMARCH = HEADER + `
in vec2 vUv;
out vec4 outColor;

uniform usampler3D uState;
uniform sampler3D uBricks;
uniform sampler2D uPalette;

uniform vec2 uRes;
uniform vec2 uShift;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanFov;

uniform int uN;
uniform int uNB;
uniform vec3 uClipMin;
uniform vec3 uClipMax;
uniform ivec3 uClipMinI;
uniform ivec3 uClipMaxI;

uniform float uT;
uniform int uStates;
uniform float uCellSize;
uniform float uDecayShrink;
uniform bool uShowDying;
uniform int uColorMode;
uniform float uAgeScale;
uniform float uGlow;

uniform vec3 uLightDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform bool uShadows;
uniform float uAO;
uniform float uEdges;
uniform float uFog;
uniform bool uFloor;
uniform bool uFrame;
uniform vec3 uBgTop;
uniform vec3 uBgBottom;
uniform vec3 uBgGlow;
uniform vec3 uFloorColor;
uniform vec3 uFrameColor;

const float BS = 4.0;

struct Hit {
  float t;
  vec3 n;
  ivec3 v;
  uvec4 c;
  float s;
};

float sizeOf(uint s) {
  if (s == 0u) return 0.0;
  if (s == 1u) return 1.0;
  if (!uShowDying) return 0.0;
  float d = float(s - 1u) / float(max(uStates - 1, 1));
  return 1.0 - uDecayShrink * d;
}

float easeOutBack(float x) {
  float a = x - 1.0;
  return 1.0 + 2.70158 * a * a * a + 1.70158 * a * a;
}

float visualSize(uvec4 c) {
  float a = sizeOf(c.g);
  float b = sizeOf(c.r);
  if (a == b) return b;
  if (a == 0.0) return b * easeOutBack(uT);
  return mix(a, b, uT * uT * (3.0 - 2.0 * uT));
}

bool inClip(ivec3 v) {
  return all(greaterThanEqual(v, uClipMinI)) && all(lessThan(v, uClipMaxI));
}

bool testVoxel(ivec3 v, vec3 ro, vec3 rd, vec3 inv, inout Hit h) {
  if (!inClip(v)) return false;
  uvec4 c = texelFetch(uState, v, 0);
  if ((c.r | c.g) == 0u) return false;
  float s = visualSize(c) * uCellSize;
  if (s < 0.02) return false;
  vec3 ctr = vec3(v) + 0.5;
  vec3 t0 = (ctr - 0.5 * s - ro) * inv;
  vec3 t1 = (ctr + 0.5 * s - ro) * inv;
  vec3 tmn = min(t0, t1);
  vec3 tmx = max(t0, t1);
  float tn = max(max(tmn.x, tmn.y), tmn.z);
  float tf = min(min(tmx.x, tmx.y), tmx.z);
  if (tn > tf || tf <= 0.0) return false;
  h.t = max(tn, 0.0);
  h.v = v;
  h.c = c;
  h.s = s;
  if (tn == tmn.x) h.n = vec3(-sign(rd.x), 0.0, 0.0);
  else if (tn == tmn.y) h.n = vec3(0.0, -sign(rd.y), 0.0);
  else h.n = vec3(0.0, 0.0, -sign(rd.z));
  return true;
}

bool trace(vec3 ro, vec3 rd, out Hit h) {
  h.t = 1e30; h.n = vec3(0.0); h.v = ivec3(0); h.c = uvec4(0u); h.s = 0.0;
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uClipMin - ro) * inv;
  vec3 t1 = (uClipMax - ro) * inv;
  vec3 tmn = min(t0, t1);
  vec3 tmx = max(t0, t1);
  float tEnter = max(max(max(tmn.x, tmn.y), tmn.z), 0.0);
  float tExit = min(min(tmx.x, tmx.y), tmx.z);
  if (tEnter >= tExit) return false;

  ivec3 stp = ivec3(sign(rd));
  vec3 up = step(vec3(0.0), rd);
  vec3 p = ro + rd * (tEnter + 1e-3);
  ivec3 b = clamp(ivec3(floor(p / BS)), ivec3(0), ivec3(uNB - 1));
  vec3 tDB = abs(inv) * BS;
  vec3 tNB = ((vec3(b) + up) * BS - ro) * inv;
  vec3 tDV = abs(inv);
  float t = tEnter;

  for (int i = 0; i < 256; i++) {
    float tbx = min(min(tNB.x, tNB.y), tNB.z);
    if (texelFetch(uBricks, b, 0).r > 0.0) {
      float tEnd = min(tbx, tExit);
      vec3 q = ro + rd * (t + 1e-4);
      ivec3 lo = b * 4;
      ivec3 v = clamp(ivec3(floor(q)), lo, lo + 3);
      vec3 tNV = (vec3(v) + up - ro) * inv;
      for (int j = 0; j < 12; j++) {
        if (testVoxel(v, ro, rd, inv, h)) return true;
        float tv = min(min(tNV.x, tNV.y), tNV.z);
        if (tv >= tEnd) break;
        if (tNV.x < tNV.y) {
          if (tNV.x < tNV.z) { v.x += stp.x; tNV.x += tDV.x; }
          else { v.z += stp.z; tNV.z += tDV.z; }
        } else {
          if (tNV.y < tNV.z) { v.y += stp.y; tNV.y += tDV.y; }
          else { v.z += stp.z; tNV.z += tDV.z; }
        }
      }
    }
    if (tbx >= tExit) break;
    t = tbx;
    if (tNB.x < tNB.y) {
      if (tNB.x < tNB.z) { b.x += stp.x; tNB.x += tDB.x; }
      else { b.z += stp.z; tNB.z += tDB.z; }
    } else {
      if (tNB.y < tNB.z) { b.y += stp.y; tNB.y += tDB.y; }
      else { b.z += stp.z; tNB.z += tDB.z; }
    }
    if (any(lessThan(b, ivec3(0))) || any(greaterThanEqual(b, ivec3(uNB)))) break;
  }
  return false;
}

float occAt(ivec3 v) {
  if (any(lessThan(v, ivec3(0))) || any(greaterThanEqual(v, ivec3(uN))) || !inClip(v)) return 0.0;
  uvec4 c = texelFetch(uState, v, 0);
  if ((c.r | c.g) == 0u) return 0.0;
  return visualSize(c) * uCellSize;
}

float cornerAO(float s1, float s2, float c) {
  return 1.0 - (s1 + s2 + max(c, s1 * s2)) / 3.0;
}

float voxelAO(ivec3 v, vec3 n, vec3 hp) {
  ivec3 a, b;
  vec3 lp = hp - vec3(v);
  vec2 uv;
  if (abs(n.x) > 0.5) { a = ivec3(0, 1, 0); b = ivec3(0, 0, 1); uv = lp.yz; }
  else if (abs(n.y) > 0.5) { a = ivec3(1, 0, 0); b = ivec3(0, 0, 1); uv = lp.xz; }
  else { a = ivec3(1, 0, 0); b = ivec3(0, 1, 0); uv = lp.xy; }
  ivec3 o = v + ivec3(n);
  float sa0 = occAt(o - a), sa1 = occAt(o + a);
  float sb0 = occAt(o - b), sb1 = occAt(o + b);
  float c00 = cornerAO(sa0, sb0, occAt(o - a - b));
  float c10 = cornerAO(sa1, sb0, occAt(o + a - b));
  float c01 = cornerAO(sa0, sb1, occAt(o - a + b));
  float c11 = cornerAO(sa1, sb1, occAt(o + a + b));
  uv = clamp(uv, 0.0, 1.0);
  float ao = mix(mix(c00, c10, uv.x), mix(c01, c11, uv.x), uv.y);
  return ao * (1.0 - 0.6 * occAt(o));
}

float density(vec3 g) {
  vec3 q = g / float(uN);
  if (any(lessThan(q, vec3(0.0))) || any(greaterThan(q, vec3(1.0)))) return 0.0;
  return textureLod(uBricks, q, 0.0).r * (255.0 / 64.0);
}

float densityAO(vec3 hp, vec3 n) {
  float s = density(hp + n * 2.5) * 0.9 + density(hp + n * 6.0) * 0.7 + density(hp + n * 12.0) * 0.45;
  return clamp(1.0 - s * 0.6, 0.12, 1.0);
}

vec3 palette(float f) {
  return textureLod(uPalette, vec2(clamp(f, 0.0, 1.0) * 0.996 + 0.002, 0.5), 0.0).rgb;
}

vec3 stateColor(uint s, uint age, ivec3 v) {
  vec3 pc = (vec3(v) + 0.5) / float(uN);
  float f;
  if (uColorMode == 0) {
    if (uStates <= 2) f = clamp(float(age) / uAgeScale, 0.0, 1.0) * 0.75;
    else f = s <= 1u ? 0.0 : float(s - 1u) / float(uStates - 1);
  } else if (uColorMode == 1) {
    f = clamp(float(age) / uAgeScale, 0.0, 1.0);
  } else if (uColorMode == 2) {
    f = clamp(length(pc - 0.5) * 1.8, 0.0, 1.0);
  } else if (uColorMode == 3) {
    f = 1.0 - pc.y;
  } else {
    vec3 c = mix(vec3(0.12), vec3(1.0), pc);
    return c * c;
  }
  return palette(f);
}

vec3 cellColor(uvec4 c, ivec3 v) {
  if (c.g == 0u || c.g == c.r) return stateColor(c.r, c.b, v);
  if (c.r == 0u) return stateColor(c.g, c.b, v);
  return mix(stateColor(c.g, c.b, v), stateColor(c.r, c.b, v), uT);
}

vec3 background(vec3 rd) {
  float h = rd.y * 0.5 + 0.5;
  vec3 col = mix(uBgBottom, uBgTop, smoothstep(0.1, 0.9, h));
  float g = max(dot(rd, normalize(-uCamPos)), 0.0);
  col += uBgGlow * (pow(g, 10.0) * 0.5 + pow(g, 3.0) * 0.12);
  return col;
}

vec3 shadeCell(Hit h, vec3 hp, vec3 rd, float pix) {
  vec3 n = h.n;
  vec3 base = cellColor(h.c, h.v);
  float ao = 1.0;
  if (uAO > 0.0) ao = mix(1.0, voxelAO(h.v, n, hp) * densityAO(hp, n), uAO);
  float ndl = max(dot(n, uLightDir), 0.0);
  float sh = 1.0;
  if (uShadows && ndl > 0.0) {
    Hit hs;
    if (trace(hp + n * 2e-3, uLightDir, hs)) sh = 0.0;
  }
  vec3 V = -rd;
  vec3 H = normalize(uLightDir + V);
  float spec = pow(max(dot(n, H), 0.0), 40.0) * 0.28;
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  vec3 amb = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
  vec3 col = base * (amb * ao + uSunColor * ndl * sh) + uSunColor * spec * sh;
  col += amb * fres * 0.18 * ao;
  if (uEdges > 0.0) {
    vec3 lp = (hp - vec3(h.v) - 0.5) / h.s + 0.5;
    vec2 uv = abs(n.x) > 0.5 ? lp.yz : (abs(n.y) > 0.5 ? lp.xz : lp.xy);
    vec2 e2 = min(uv, 1.0 - uv) * h.s;
    float e = min(e2.x, e2.y);
    float w = pix * h.t;
    float line = 1.0 - smoothstep(w * 0.5, w * 1.5, e);
    float vis = smoothstep(2.5, 7.0, h.s / w);
    col *= 1.0 - uEdges * line * vis * 0.6;
  }
  float aliveF = h.c.r == 1u ? 1.0 : 0.35;
  col += base * uGlow * aliveF * 1.2;
  return col;
}

vec3 shadeFloor(vec3 pw, vec3 bg, float k) {
  vec3 pg = (pw + 1.0) * k;
  float sh = 1.0;
  if (uShadows) {
    Hit hs;
    if (trace(pg + vec3(0.0, 1e-3, 0.0), uLightDir, hs)) sh = 0.0;
  }
  float occ = 0.0;
  if (pg.x > 0.0 && pg.z > 0.0 && pg.x < float(uN) && pg.z < float(uN)) {
    occ = density(vec3(pg.x, 2.0, pg.z)) * 0.9 + density(vec3(pg.x, 7.0, pg.z)) * 0.6
        + density(vec3(pg.x, 16.0, pg.z)) * 0.35;
  }
  float ao = clamp(1.0 - occ, 0.35, 1.0);
  vec3 c = uFloorColor * (uSkyColor * 0.9 * ao + uSunColor * max(uLightDir.y, 0.0) * mix(0.38, 1.0, sh) * mix(1.0, ao, 0.5));
  float r = length(pw.xz);
  float fade = exp(-r * r * 0.07);
  return mix(bg, c, fade);
}

float edgeLine(vec3 p, float w) {
  vec3 d = min(abs(p), abs(p - float(uN)));
  float a = min(d.x, min(d.y, d.z));
  float b = max(d.x, max(d.y, d.z));
  float m = d.x + d.y + d.z - a - b;
  return 1.0 - smoothstep(w * 0.4, w * 1.4, m);
}

vec3 drawFrame(vec3 col, vec3 ro, vec3 rd, float pix, float tHit) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = -ro * inv;
  vec3 t1 = (vec3(float(uN)) - ro) * inv;
  vec3 tmn = min(t0, t1);
  vec3 tmx = max(t0, t1);
  float tn = max(max(tmn.x, tmn.y), tmn.z);
  float tf = min(min(tmx.x, tmx.y), tmx.z);
  if (tn > tf || tf < 0.0) return col;
  float a = 0.0;
  if (tn > 0.0) a = max(a, edgeLine(ro + rd * tn, pix * tn));
  if (tf < tHit) a = max(a, edgeLine(ro + rd * tf, pix * tf) * 0.55);
  return mix(col, uFrameColor, a * 0.32);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0 - uShift;
  float aspect = uRes.x / uRes.y;
  vec3 rd = normalize(uCamFwd + uCamRight * ndc.x * aspect * uTanFov + uCamUp * ndc.y * uTanFov);
  rd += vec3(equal(rd, vec3(0.0))) * 1e-7;
  vec3 bg = background(rd);
  float k = float(uN) * 0.5;
  vec3 ro = (uCamPos + 1.0) * k;
  float pix = 2.0 * uTanFov / uRes.y;

  Hit h;
  vec3 col = bg;
  bool hit = trace(ro, rd, h);
  if (hit) {
    vec3 hp = ro + rd * h.t;
    col = shadeCell(h, hp, rd, pix);
    float dw = h.t / k;
    float camDist = length(uCamPos);
    float f = clamp((dw - camDist + 1.0) / 2.6, 0.0, 1.0);
    col = mix(col, bg, uFog * f * f * 0.85);
  } else if (uFloor && rd.y < 0.0) {
    float tw = (-1.0 - uCamPos.y) / rd.y;
    col = shadeFloor(uCamPos + rd * tw, bg, k);
  }
  if (uFrame) col = drawFrame(col, ro, rd, pix, hit ? h.t : 1e30);
  outColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// Post-processing: dual-filter bloom + composite (FXAA, ACES, vignette).
// ---------------------------------------------------------------------------
export const FS_BLOOM_DOWN = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uHalf;
uniform float uThreshold;
uniform bool uPrefilter;

vec3 pre(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float knee = 0.5 * uThreshold + 1e-4;
  float rq = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  rq = rq * rq / (4.0 * knee);
  return c * max(rq, br - uThreshold) / max(br, 1e-4);
}

void main() {
  vec3 s = texture(uTex, vUv).rgb * 4.0;
  s += texture(uTex, vUv - uHalf).rgb;
  s += texture(uTex, vUv + uHalf).rgb;
  s += texture(uTex, vUv + vec2(uHalf.x, -uHalf.y)).rgb;
  s += texture(uTex, vUv - vec2(uHalf.x, -uHalf.y)).rgb;
  s /= 8.0;
  if (uPrefilter) s = pre(s);
  outColor = vec4(s, 1.0);
}`;

export const FS_BLOOM_UP = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uHalf;
void main() {
  vec2 h = uHalf;
  vec3 s = texture(uTex, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture(uTex, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(0.0, h.y * 2.0)).rgb;
  s += texture(uTex, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture(uTex, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture(uTex, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  outColor = vec4(s / 12.0, 1.0);
}`;

export const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uTexel;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uVignette;
uniform float uTime;
uniform bool uUseBloom;
uniform bool uFxaa;

float luma(vec3 c) { c = c / (1.0 + c); return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 fxaa(vec2 uv) {
  vec3 nw = texture(uScene, uv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 ne = texture(uScene, uv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 sw = texture(uScene, uv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 se = texture(uScene, uv + vec2( 1.0,  1.0) * uTexel).rgb;
  vec3 m  = texture(uScene, uv).rgb;
  float lNW = luma(nw), lNE = luma(ne), lSW = luma(sw), lSE = luma(se), lM = luma(m);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0312, lMax * 0.125)) return m;
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 a = 0.5 * (texture(uScene, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uScene, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(uScene, uv - dir * 0.5).rgb + texture(uScene, uv + dir * 0.5).rgb);
  float lB = luma(b);
  return (lB < lMin || lB > lMax) ? a : b;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main() {
  vec3 c = uFxaa ? fxaa(vUv) : texture(uScene, vUv).rgb;
  if (uUseBloom) c += texture(uBloom, vUv).rgb * uBloomStrength;
  c = aces(c * uExposure);
  vec2 q = vUv - 0.5;
  c *= 1.0 - uVignette * dot(q, q) * 1.5;
  c = pow(c, vec3(1.0 / 2.2));
  c += (hash(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) / 255.0;
  outColor = vec4(c, 1.0);
}`;
