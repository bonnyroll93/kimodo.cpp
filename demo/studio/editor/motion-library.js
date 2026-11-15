// Motion library: every motion source (samples and generated animations) as a grid of
// animated previews or as a sortable list. Click an item to use it as the active layer's
// source; generated animations can be deleted. The chosen view and sort are remembered in
// this browser (localStorage, optional).
import * as THREE from 'three';

const PREF = 'kimodo.library';
const loadPref = () => { try { return JSON.parse(localStorage.getItem(PREF)) ?? {}; } catch { return {}; } };
const savePref = (p) => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* storage unavailable */ } };

async function f32(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Float32Array(await r.arrayBuffer());
}

export class MotionLibrary {
  constructor({ $, status, motionPanel, onPick }) {
    Object.assign(this, { $, status, motionPanel, onPick });
    const pref = loadPref();
    this.view = pref.view === 'list' ? 'list' : 'grid';
    this.sort = pref.sort === 'newest' ? 'newest' : 'name';
    this.items = [];
    this.data = new Map();      // id -> {root, rotations, frames, joints} (loaded on demand)
    this.skeletons = new Map(); // key -> definition
    this.previews = new Set();  // visible {canvas, id}
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const p = e.target._preview;
        if (!p) continue;
        if (e.isIntersecting) { this.previews.add(p); this.load(p.id).catch(() => { p.failed = true; }); }
        else this.previews.delete(p);
      }
    }, { root: $('library-items') });

    $('open-library').addEventListener('click', () => this.open());
    $('library-close').addEventListener('click', () => this.close());
    $('library-search').addEventListener('input', () => this.render());
    $('library-sort').value = this.sort;
    $('library-sort').addEventListener('change', (e) => { this.sort = e.target.value; this.persist(); this.render(); });
    for (const v of ['grid', 'list'])
      $(`library-${v}`).addEventListener('click', () => { this.view = v; this.persist(); this.render(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.$('library').hidden) this.close(); });
  }

  persist() { savePref({ view: this.view, sort: this.sort }); }

  async open() {
    this.$('library').hidden = false;
    this.items = await this.motionPanel.loadSources();
    this.render();
    this.loop();
  }

  close() {
    this.$('library').hidden = true;
    this.previews.clear();
    cancelAnimationFrame(this.raf);
  }

  sorted() {
    const q = this.$('library-search').value.trim().toLowerCase();
    const list = this.items.filter((m) => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    return this.sort === 'newest'
      ? list.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
      : list.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }

  render() {
    const $ = this.$;
    $('library-grid').classList.toggle('on', this.view === 'grid');
    $('library-list').classList.toggle('on', this.view === 'list');
    const host = $('library-items');
    host.className = `library-items ${this.view}`;
    this.observer.disconnect();
    this.previews.clear();
    host.replaceChildren();
    const current = this.motionPanel.activeLayer?.config?.source;
    const list = this.sorted();
    $('library-count').textContent = `${list.length} motion${list.length === 1 ? '' : 's'}`;
    for (const m of list) host.append(this.view === 'grid' ? this.card(m, current) : this.row(m, current));
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'muted pad';
      p.textContent = 'No motions. Generate one with "Text to motion" (it opens in a new tab).';
      host.append(p);
    }
  }

  meta(m) {
    const secs = ((m.frames - 1) / 30).toFixed(1);
    const date = m.created ? new Date(m.created).toLocaleString() : '';
    return { kind: m.kind === 'sample' ? 'Sample' : 'Generated', info: `${m.skeleton_key} · ${m.frames} f · ${secs} s`, date };
  }

  deleteButton(m) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-button danger';
    b.textContent = 'Delete';
    b.title = 'Delete this generated motion (its files are removed from demo-output)';
    b.addEventListener('click', (e) => { e.stopPropagation(); this.remove(m); });
    return b;
  }

  card(m, current) {
    const el = document.createElement('div');
    el.className = `library-card${m.id === current ? ' current' : ''}`;
    el.title = `${m.label}\nClick to use it as the active layer's source`;
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 150;
    const { kind, info, date } = this.meta(m);
    const name = document.createElement('div');
    name.className = 'library-name';
    name.textContent = m.label;
    const sub = document.createElement('div');
    sub.className = 'library-sub muted';
    sub.textContent = `${kind} · ${info}`;
    const foot = document.createElement('div');
    foot.className = 'library-foot';
    const when = document.createElement('span');
    when.className = 'muted small';
    when.textContent = date;
    foot.append(when);
    if (m.deletable) foot.append(this.deleteButton(m));
    el.append(canvas, name, sub, foot);
    el.addEventListener('click', () => this.pick(m));
    el._preview = { canvas, id: m.id, key: m.skeleton_key };
    this.observer.observe(el);
    return el;
  }

  row(m, current) {
    const el = document.createElement('div');
    el.className = `library-row${m.id === current ? ' current' : ''}`;
    const { kind, info, date } = this.meta(m);
    const name = document.createElement('span');
    name.className = 'library-name';
    name.textContent = m.label;
    const k = document.createElement('span');
    k.className = 'muted small';
    k.textContent = kind;
    const i = document.createElement('span');
    i.className = 'muted small';
    i.textContent = info;
    const d = document.createElement('span');
    d.className = 'muted small';
    d.textContent = date;
    el.append(name, k, i, d);
    el.append(m.deletable ? this.deleteButton(m) : document.createElement('span'));
    el.addEventListener('click', () => this.pick(m));
    return el;
  }

  pick(m) {
    this.onPick(m.id);
    this.close();
  }

  async remove(m) {
    const used = this.motionPanel.layers.some((l) => l.config?.source === m.id);
    if (!window.confirm(`Delete "${m.label}"?\nThe generated motion files are removed from the demo output.${used ? '\nIt is used by a layer of this scene.' : ''}`)) return;
    const r = await fetch(`motions/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      this.status(`Cannot delete: ${body.error || `HTTP ${r.status}`}`, true);
      return;
    }
    this.data.delete(m.id);
    this.items = await this.motionPanel.loadSources();
    this.render();
    this.status(`Deleted "${m.label}"${used ? ' — a layer still refers to it' : ''}`, used);
  }

  // ---- animated previews --------------------------------------------------------------------
  async load(id) {
    if (this.data.has(id)) return;
    this.data.set(id, null); // loading
    const m = this.items.find((x) => x.id === id);
    if (!this.skeletons.has(m.skeleton_key)) {
      const r = await fetch(`/api/skeletons/${encodeURIComponent(m.skeleton_key)}`);
      this.skeletons.set(m.skeleton_key, r.ok ? await r.json() : null);
    }
    const [root, rotations] = await Promise.all([
      f32(`motions/${encodeURIComponent(id)}/root.f32`), f32(`motions/${encodeURIComponent(id)}/rotations.f32`),
    ]);
    const frames = root.length / 3;
    this.data.set(id, { root, rotations, frames, joints: rotations.length / (frames * 4) });
  }

  loop() {
    cancelAnimationFrame(this.raf);
    const q = new THREE.Quaternion(), v = new THREE.Vector3();
    const draw = (now) => {
      if (this.$('library').hidden) return;
      for (const p of this.previews) this.drawPreview(p, now, q, v);
      this.raf = requestAnimationFrame(draw);
    };
    this.raf = requestAnimationFrame(draw);
  }

  drawPreview(p, now, q, v) {
    const g = p.canvas.getContext('2d');
    const w = p.canvas.width, h = p.canvas.height;
    g.fillStyle = '#0b1015';
    g.fillRect(0, 0, w, h);
    const d = this.data.get(p.id), def = this.skeletons.get(p.key);
    if (!d || !def) {
      g.fillStyle = '#5b6b77';
      g.font = '11px system-ui';
      g.fillText(p.failed ? 'preview unavailable' : 'loading…', 10, h - 10);
      return;
    }
    const f = Math.floor((now / 1000) * 30) % d.frames;
    // Forward kinematics of the native skeleton at frame f.
    const J = d.joints, pos = new Array(J), rot = new Array(J);
    for (let j = 0; j < J; j++) {
      const o = (f * J + j) * 4;
      const local = new THREE.Quaternion(d.rotations[o], d.rotations[o + 1], d.rotations[o + 2], d.rotations[o + 3]);
      const parent = def.parents[j];
      if (parent < 0) {
        rot[j] = local;
        pos[j] = new THREE.Vector3(d.root[f * 3], d.root[f * 3 + 1], d.root[f * 3 + 2]);
      } else {
        rot[j] = rot[parent].clone().multiply(local);
        pos[j] = pos[parent].clone().add(v.fromArray(def.offsets[j]).applyQuaternion(rot[parent]));
      }
    }
    // Three-quarter view that follows the root horizontally.
    const r0 = pos[0], s = (h * 0.78) / 1.9;
    const px = (p3) => w / 2 + ((p3.x - r0.x) * 0.8 + (p3.z - r0.z) * 0.6) * s;
    const py = (p3) => h - 12 - p3.y * s - ((p3.z - r0.z) * 0.8 - (p3.x - r0.x) * 0.6) * s * 0.25;
    g.strokeStyle = '#25313b';
    g.beginPath(); g.moveTo(0, h - 12); g.lineTo(w, h - 12); g.stroke();
    g.strokeStyle = '#3bd3d0';
    g.lineWidth = 2;
    g.beginPath();
    for (let j = 0; j < J; j++) {
      const parent = def.parents[j];
      if (parent < 0) continue;
      g.moveTo(px(pos[parent]), py(pos[parent]));
      g.lineTo(px(pos[j]), py(pos[j]));
    }
    g.stroke();
    g.lineWidth = 1;
  }
}
