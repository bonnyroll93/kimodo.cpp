// Graph editor for keyframe curves of the selected joint in the active keyframe layer.
// x = frame, y = value (degrees for rx/ry/rz, parent units for tx/ty/tz).
//   click a key: select (Shift: add) · drag a key: move it (frames snap; Alt: free)
//   drag a bezier handle: manual tangent (the opposite handle stays aligned; Alt: broken)
//   double-click empty space: add a key on the nearest visible channel · Delete: remove
//   wheel: zoom time (Shift: values) · right/middle drag: pan · click empty: seek
import { CHANNELS, evaluate, handles, sortKeys } from '../viewer/keyframes.js';

const COLORS = { rx: '#ff6b6b', ry: '#5ee6be', rz: '#6ba6ff', tx: '#ffb3b3', ty: '#b3f5e3', tz: '#b3d0ff' };

export class GraphEditor {
  // host: { tracks() -> tracks JSON | null, joint() -> name | null, frame() -> current frame,
  //         frames() -> stack length, seek(frame), changed() }
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.visible = new Set(['rx', 'ry', 'rz']);
    this.selected = []; // [{c, k}] channel + key object
    this.view = null;   // {f0, f1, v0, v1}
    this.drag = null;

    for (const c of CHANNELS) {
      const b = root.querySelector(`[data-channel="${c}"]`);
      b.style.setProperty('--ch', COLORS[c]);
      b.classList.toggle('on', this.visible.has(c));
      b.addEventListener('click', () => {
        if (this.visible.has(c)) this.visible.delete(c); else this.visible.add(c);
        b.classList.toggle('on', this.visible.has(c));
        this.fit();
      });
    }
    root.querySelector('[data-action="fit"]').addEventListener('click', () => this.fit());
    root.querySelector('[data-action="delete"]').addEventListener('click', () => this.deleteSelected());
    root.querySelector('[data-action="auto"]').addEventListener('click', () => this.setSelected((k) => { k.a = true; delete k.l; delete k.r; }));
    for (const i of ['constant', 'linear', 'bezier'])
      root.querySelector(`[data-interp="${i}"]`).addEventListener('click', () => this.setSelected((k) => { k.i = i; }));

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('dblclick', (e) => this.dblclick(e));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    window.addEventListener('keydown', (e) => {
      if (this.root.hidden || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected.length) { e.preventDefault(); this.deleteSelected(); }
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  get open() { return !this.root.hidden; }
  show(on) { this.root.hidden = !on; if (on) { this.fit(); } }

  channels() {
    const t = this.host.tracks(), j = this.host.joint();
    return t && j ? t.tracks[j] ?? null : null;
  }

  // ---- coordinates ---------------------------------------------------------------
  size() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(r.width * dpr) || this.canvas.height !== Math.round(r.height * dpr)) {
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
    }
    return { w: r.width, h: r.height, dpr };
  }
  fx(f) { const { w } = this.size(); return 40 + ((f - this.view.f0) / (this.view.f1 - this.view.f0)) * (w - 50); }
  vy(v) { const { h } = this.size(); return 10 + (1 - (v - this.view.v0) / (this.view.v1 - this.view.v0)) * (h - 30); }
  xf(x) { const { w } = this.size(); return this.view.f0 + ((x - 40) / (w - 50)) * (this.view.f1 - this.view.f0); }
  yv(y) { const { h } = this.size(); return this.view.v0 + (1 - (y - 10) / (h - 30)) * (this.view.v1 - this.view.v0); }

  fit() {
    const ch = this.channels();
    const frames = Math.max(this.host.frames(), 2);
    let lo = Infinity, hi = -Infinity, last = 0;
    for (const c of this.visible)
      for (const k of ch?.[c] ?? []) { lo = Math.min(lo, k.v); hi = Math.max(hi, k.v); last = Math.max(last, k.f); }
    if (!Number.isFinite(lo)) { lo = -10; hi = 10; }
    const pad = Math.max((hi - lo) * 0.15, 1);
    this.view = { f0: -2, f1: Math.max(frames, last + 5), v0: lo - pad, v1: hi + pad };
    this.draw();
  }

  // ---- drawing ---------------------------------------------------------------------
  draw() {
    if (!this.open) return;
    if (!this.view) this.fit();
    const { w, h, dpr } = this.size();
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#0b1015';
    g.fillRect(0, 0, w, h);
    const ch = this.channels();
    const label = this.root.querySelector('.graph-joint');
    label.textContent = this.host.joint() ? `${this.host.joint()}${ch ? '' : ' (no keys yet)'}` : 'Select a joint';
    // Grid: frames every 5/10/30, values with ~6 lines.
    g.font = '10px ui-monospace, monospace';
    const fStep = [1, 5, 10, 30, 60, 150].find((s) => (this.fx(s) - this.fx(0)) > 40) ?? 300;
    g.strokeStyle = '#1b242c';
    g.fillStyle = '#5b6b77';
    for (let f = Math.ceil(this.view.f0 / fStep) * fStep; f <= this.view.f1; f += fStep) {
      const x = this.fx(f);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h - 18); g.stroke();
      g.fillText(String(f), x + 2, h - 6);
    }
    const range = this.view.v1 - this.view.v0;
    const vStep = Math.pow(10, Math.floor(Math.log10(range / 4)));
    const step = range / vStep > 20 ? vStep * 5 : range / vStep > 8 ? vStep * 2 : vStep;
    for (let v = Math.ceil(this.view.v0 / step) * step; v <= this.view.v1; v += step) {
      const y = this.vy(v);
      g.strokeStyle = Math.abs(v) < step / 2 ? '#2b3a46' : '#1b242c';
      g.beginPath(); g.moveTo(40, y); g.lineTo(w, y); g.stroke();
      g.fillText(Math.abs(v) < 1e-9 ? '0' : Number(v.toPrecision(3)).toString(), 2, y + 3);
    }
    // Current frame.
    const cx = this.fx(this.host.frame());
    g.strokeStyle = '#ffb547';
    g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h - 18); g.stroke();
    if (!ch) return;
    for (const c of CHANNELS) {
      if (!this.visible.has(c) || !ch[c]?.length) continue;
      const keys = ch[c];
      g.strokeStyle = COLORS[c];
      g.lineWidth = 1.5;
      g.beginPath();
      for (let x = 40; x <= w; x += 2) {
        const y = this.vy(evaluate(keys, this.xf(x)));
        if (x === 40) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      g.lineWidth = 1;
      keys.forEach((k, i) => {
        const sel = this.selected.some((s) => s.k === k);
        const x = this.fx(k.f), y = this.vy(k.v);
        if (sel && (k.i ?? 'bezier') === 'bezier') {
          const [l, r] = handles(keys, i);
          for (const hnd of [l, r]) {
            const hx = this.fx(k.f + hnd[0]), hy = this.vy(k.v + hnd[1]);
            g.strokeStyle = '#8b9aa5';
            g.beginPath(); g.moveTo(x, y); g.lineTo(hx, hy); g.stroke();
            g.fillStyle = k.a === false ? '#ffb547' : '#8b9aa5';
            g.beginPath(); g.arc(hx, hy, 3.5, 0, Math.PI * 2); g.fill();
          }
        }
        g.fillStyle = sel ? '#ffb547' : COLORS[c];
        g.strokeStyle = '#0b1015';
        g.beginPath();
        if ((k.i ?? 'bezier') === 'constant') g.rect(x - 4, y - 4, 8, 8);
        else if (k.i === 'linear') { g.moveTo(x, y - 5); g.lineTo(x + 5, y + 4); g.lineTo(x - 5, y + 4); g.closePath(); }
        else { g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath(); }
        g.fill(); g.stroke();
      });
    }
  }

  // ---- hit testing -------------------------------------------------------------------
  pos(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  hitKey(p) {
    const ch = this.channels();
    if (!ch) return null;
    for (const c of CHANNELS) {
      if (!this.visible.has(c)) continue;
      for (const k of ch[c] ?? [])
        if (Math.hypot(this.fx(k.f) - p.x, this.vy(k.v) - p.y) < 7) return { c, k };
    }
    return null;
  }

  hitHandle(p) {
    const ch = this.channels();
    for (const s of this.selected) {
      const keys = ch?.[s.c];
      const i = keys?.indexOf(s.k) ?? -1;
      if (i < 0 || (s.k.i ?? 'bezier') !== 'bezier') continue;
      const [l, r] = handles(keys, i);
      for (const [side, hnd] of [['l', l], ['r', r]])
        if (Math.hypot(this.fx(s.k.f + hnd[0]) - p.x, this.vy(s.k.v + hnd[1]) - p.y) < 6) return { ...s, side, keys, i };
    }
    return null;
  }

  // ---- interaction -------------------------------------------------------------------
  down(e) {
    const p = this.pos(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2) { this.drag = { pan: true, p, view: { ...this.view } }; return; }
    const hnd = this.hitHandle(p);
    if (hnd) {
      const [l, r] = handles(hnd.keys, hnd.i);
      hnd.k.a = false; hnd.k.l = [...l]; hnd.k.r = [...r];
      this.drag = { handle: hnd };
      return;
    }
    const hit = this.hitKey(p);
    if (hit) {
      if (e.shiftKey) {
        if (!this.selected.some((s) => s.k === hit.k)) this.selected.push(hit);
      } else if (!this.selected.some((s) => s.k === hit.k)) this.selected = [hit];
      this.drag = { keys: this.selected.map((s) => ({ ...s, f: s.k.f, v: s.k.v })), p, moved: false };
      this.draw();
      return;
    }
    this.drag = { seek: true, p };
  }

  move(e) {
    if (!this.drag) return;
    const p = this.pos(e);
    const d = this.drag;
    if (d.pan) {
      const df = this.xf(d.p.x) - this.xf(p.x), dv = this.yv(d.p.y) - this.yv(p.y);
      this.view = { f0: d.view.f0 + df, f1: d.view.f1 + df, v0: d.view.v0 + dv, v1: d.view.v1 + dv };
      d.p = p; d.view = { ...this.view };
    } else if (d.handle) {
      const { k, side } = d.handle;
      const off = [this.xf(p.x) - k.f, this.yv(p.y) - k.v];
      if (side === 'l') off[0] = Math.min(off[0], -0.01); else off[0] = Math.max(off[0], 0.01);
      k[side] = off;
      if (!e.altKey) { // keep the opposite handle aligned (same slope, its own length)
        const other = side === 'l' ? 'r' : 'l';
        const len = Math.abs(k[other][0]) || 1;
        const slope = off[1] / off[0];
        k[other] = [Math.sign(-off[0]) * len, slope * Math.sign(-off[0]) * len];
      }
      this.changed(false);
    } else if (d.keys) {
      d.moved = true;
      const df = this.xf(p.x) - this.xf(d.p.x), dv = this.yv(p.y) - this.yv(d.p.y);
      for (const s of d.keys) {
        s.k.f = Math.max(0, e.altKey ? s.f + df : Math.round(s.f + df));
        s.k.v = s.v + dv;
      }
      for (const c of new Set(d.keys.map((s) => s.c))) sortKeys(this.channels()[c]);
      this.changed(false);
    }
    this.draw();
  }

  up(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.seek && Math.hypot(this.pos(e).x - d.p.x, this.pos(e).y - d.p.y) < 4) {
      this.selected = [];
      this.host.seek(Math.max(0, Math.round(this.xf(d.p.x))));
      this.draw();
    }
    if ((d.keys && d.moved) || d.handle) this.changed(true);
  }

  dblclick(e) {
    const p = this.pos(e);
    if (this.hitKey(p) || !this.host.joint()) return;
    const tracks = this.host.tracks();
    if (!tracks) return;
    tracks.tracks[this.host.joint()] ??= {};
    const ch = tracks.tracks[this.host.joint()];
    const f = Math.max(0, Math.round(this.xf(p.x)));
    // Nearest visible channel at that frame (by curve value), else the first visible one.
    let best = null, dist = Infinity;
    for (const c of this.visible) {
      const y = this.vy(evaluate(ch[c], f));
      if (Math.abs(y - p.y) < dist) { dist = Math.abs(y - p.y); best = c; }
    }
    if (!best) return;
    ch[best] ??= [];
    const v = ch[best].length ? evaluate(ch[best], f) : this.yv(p.y);
    const k = { f, v, i: 'bezier', a: true };
    ch[best].push(k);
    sortKeys(ch[best]);
    this.selected = [{ c: best, k }];
    this.changed(true);
  }

  wheel(e) {
    e.preventDefault();
    const p = this.pos(e);
    const z = Math.exp(e.deltaY * 0.0015);
    if (e.shiftKey) {
      const v = this.yv(p.y);
      this.view.v0 = v + (this.view.v0 - v) * z;
      this.view.v1 = v + (this.view.v1 - v) * z;
    } else {
      const f = this.xf(p.x);
      this.view.f0 = f + (this.view.f0 - f) * z;
      this.view.f1 = f + (this.view.f1 - f) * z;
    }
    this.draw();
  }

  setSelected(fn) {
    if (!this.selected.length) return;
    for (const s of this.selected) fn(s.k);
    this.changed(true);
  }

  deleteSelected() {
    const ch = this.channels();
    if (!ch || !this.selected.length) return;
    for (const s of this.selected) {
      const keys = ch[s.c];
      const i = keys.indexOf(s.k);
      if (i >= 0) keys.splice(i, 1);
    }
    this.selected = [];
    this.changed(true);
  }

  // final: the edit is complete (re-bake); otherwise a live update (redraw, preview only).
  changed(final) {
    this.draw();
    this.host.changed(final);
  }
}
