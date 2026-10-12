// Orbit camera with inertia, wheel / pinch zoom and idle auto-rotation.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class OrbitCamera {
  constructor(el) {
    this.el = el;
    this.fov = (36 * Math.PI) / 180;
    this.reset(true);
    this.autoRotate = 0.12;
    this.pointers = new Map();
    this.lastInteraction = -1e9;
    this.rotateBlend = 1;
    this._bind();
  }

  reset(instant = false) {
    this.az = 0.75;
    this.elev = 0.42;
    this.dist = 5.4;
    this.targetDist = this.dist;
    this.vAz = 0;
    this.vEl = 0;
    if (!instant) this.lastInteraction = performance.now();
    this.changed = true;
  }

  _bind() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.vAz = this.vEl = 0;
      this.lastInteraction = performance.now();
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const prev = [...this.pointers.values()].map((q) => ({ ...q }));
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 1) {
        const k = 4.2 / Math.max(400, el.clientHeight);
        this.vAz = -dx * k;
        this.vEl = dy * k;
        this.az += this.vAz;
        this.elev = clamp(this.elev + this.vEl, -1.45, 1.45);
      } else if (this.pointers.size === 2) {
        const pts = [...this.pointers.values()];
        const d1 = Math.hypot(prev[0].x - prev[1].x, prev[0].y - prev[1].y);
        const d2 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (d1 > 0 && d2 > 0) this.targetDist = clamp(this.targetDist * (d1 / d2), 1.2, 9);
      }
      this.lastInteraction = performance.now();
      this.changed = true;
    });
    const up = (e) => {
      this.pointers.delete(e.pointerId);
      this.lastInteraction = performance.now();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 0.05 : 0.0015;
      this.targetDist = clamp(this.targetDist * Math.exp(e.deltaY * scale), 1.2, 9);
      this.lastInteraction = performance.now();
    }, { passive: false });
    el.addEventListener('dblclick', () => this.reset());
  }

  // Advances inertia / auto-rotation; returns true when the view moved.
  update(dt, now) {
    let moved = this.changed;
    this.changed = false;
    const dragging = this.pointers.size > 0;
    if (!dragging && (Math.abs(this.vAz) > 1e-5 || Math.abs(this.vEl) > 1e-5)) {
      const decay = Math.exp(-dt * 5);
      this.vAz *= decay;
      this.vEl *= decay;
      this.az += this.vAz;
      this.elev = clamp(this.elev + this.vEl, -1.45, 1.45);
      moved = true;
    }
    if (Math.abs(this.targetDist - this.dist) > 1e-4) {
      this.dist += (this.targetDist - this.dist) * (1 - Math.exp(-dt * 12));
      moved = true;
    }
    const idle = now - this.lastInteraction > 2500 && !dragging;
    this.rotateBlend = clamp(this.rotateBlend + (idle ? dt : -dt * 4), 0, 1);
    if (this.autoRotate !== 0 && this.rotateBlend > 0) {
      this.az += this.autoRotate * dt * this.rotateBlend * this.rotateBlend;
      moved = true;
    }
    return moved;
  }

  state() {
    return orbitState(this.az, this.elev, this.dist, this.fov);
  }
}

// Camera basis for an orbit around the origin.
export function orbitState(az, elev, dist, fov) {
  const ce = Math.cos(elev);
  const pos = [dist * ce * Math.sin(az), dist * Math.sin(elev), dist * ce * Math.cos(az)];
  const len = Math.hypot(...pos);
  const fwd = pos.map((v) => -v / len);
  // right = normalize(cross(fwd, worldUp)), up = cross(right, fwd)
  let right = [-fwd[2], 0, fwd[0]];
  const rl = Math.hypot(...right) || 1;
  right = right.map((v) => v / rl);
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  return { pos, fwd, right, up, fov };
}
