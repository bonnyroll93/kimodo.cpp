// Motion library: every motion source (samples, Kimodo generations, published takes) as a grid
// of animated previews or as a sortable list, organised in folders (left pane: Kimodo for
// generated animations, Samples, Published for takes, and your own, nested with "/"). Click an
// item to use it as the active layer's source; drag it onto a folder (or use its menu) to move
// it; published takes can be renamed; generated and published motions can be deleted.
// "Publish take" bakes the current take and adds it to the library (studio_library.go).
// The chosen view, sort and folder are remembered in this browser (localStorage, optional).
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
    this.folder = typeof pref.folder === 'string' ? pref.folder : ''; // '' = every motion
    this.folders = [];
    this.publishBody = null; // () => /api/library/publish body for the current take (studio.js)
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
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.$('library').hidden && !(e.target instanceof HTMLInputElement)) this.close(); });
    $('publish-take').addEventListener('click', () => this.publish());
    $('publish-name').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.publish(); });
  }

  persist() { savePref({ view: this.view, sort: this.sort, folder: this.folder }); }

  async open({ publishName = null } = {}) {
    this.$('library').hidden = false;
    await this.reload();
    this.loop();
    if (publishName !== null) {
      this.$('publish-name').value = publishName;
      this.$('publish-name').focus();
      this.$('publish-name').select();
    }
  }

  async reload() {
    this.items = await this.motionPanel.loadSources();
    try { this.folders = (await (await fetch('/api/library', { cache: 'no-store' })).json()).folders ?? []; } catch { this.folders = []; }
    if (this.folder && !this.folders.includes(this.folder)) this.folder = '';
    const sel = this.$('publish-folder'), keep = sel.value;
    sel.replaceChildren(...this.folders.map((f) => new Option(f, f)));
    sel.value = keep && this.folders.includes(keep) ? keep : (this.folder || 'Published');
    this.render();
  }

  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
    return res;
  }

  // Folder pane: every motion, then the folder tree (counts include subfolders).
  renderFolders() {
    const host = this.$('library-folders');
    host.replaceChildren();
    const inside = (m, f) => m.folder === f || m.folder?.startsWith(`${f}/`);
    const row = (label, folder, depth, count, removable) => {
      const el = document.createElement('div');
      el.className = `library-folder${this.folder === folder ? ' on' : ''}`;
      el.style.paddingLeft = `${8 + depth * 12}px`;
      el.title = folder ? `${folder} — drop a motion here to move it` : 'Every motion';
      const name = document.createElement('span');
      name.textContent = label;
      const n = document.createElement('span');
      n.className = 'muted small';
      n.textContent = count;
      el.append(name, n);
      if (removable) {
        const x = document.createElement('button');
        Object.assign(x, { type: 'button', className: 'icon-button folder-x', textContent: '✕', title: `Delete the folder "${folder}" (its motions go back to their default folder)` });
        x.addEventListener('click', (e) => { e.stopPropagation(); this.removeFolder(folder); });
        el.append(x);
      }
      el.addEventListener('click', () => { this.folder = folder; this.persist(); this.render(); });
      if (folder) {
        el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop'); });
        el.addEventListener('dragleave', () => el.classList.remove('drop'));
        el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop'); const id = e.dataTransfer.getData('text/x-kimodo-motion'); if (id) this.move(id, folder); });
      }
      host.append(el);
    };
    row('All motions', '', 0, this.items.length, false);
    for (const f of this.folders) {
      const depth = f.split('/').length - 1;
      row(f.split('/').pop(), f, depth, this.items.filter((m) => inside(m, f)).length, !['Kimodo', 'Samples', 'Published'].includes(f));
    }
    const add = document.createElement('button');
    Object.assign(add, { type: 'button', className: 'icon-button add-folder', textContent: '+ Folder', title: 'New folder (inside the selected one)' });
    add.addEventListener('click', () => {
      const input = document.createElement('input');
      Object.assign(input, { placeholder: this.folder ? `in ${this.folder}…` : 'Folder name', maxLength: 40, className: 'folder-input' });
      add.replaceWith(input);
      input.focus();
      input.addEventListener('keydown', async (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { this.renderFolders(); return; }
        if (e.key !== 'Enter' || !input.value.trim()) return;
        const name = this.folder ? `${this.folder}/${input.value.trim()}` : input.value.trim();
        try { const res = await this.post('/api/library/folders', { name }); this.folder = res.folder; this.persist(); await this.reload(); }
        catch (err) { this.status(`Cannot create the folder: ${err.message}`, true); }
      });
      input.addEventListener('blur', () => setTimeout(() => { if (input.isConnected) this.renderFolders(); }, 150));
    });
    host.append(add);
  }

  async move(id, folder) {
    try {
      await this.post('/api/library/move', { id, folder });
      this.status(`Moved to ${folder}`);
      await this.reload();
    } catch (err) { this.status(`Cannot move: ${err.message}`, true); }
  }

  async removeFolder(folder) {
    const r = await fetch(`/api/library/folders/${encodeURIComponent(folder)}`, { method: 'DELETE' });
    if (!r.ok) { this.status(`Cannot delete the folder: HTTP ${r.status}`, true); return; }
    if (this.folder === folder || this.folder.startsWith(`${folder}/`)) this.folder = '';
    this.persist();
    await this.reload();
    this.status(`Folder "${folder}" deleted (its motions went back to their default folder)`);
  }

  async rename(m) {
    const name = window.prompt('New name', m.label);
    if (!name?.trim()) return;
    try { await this.post('/api/library/rename', { id: m.id, name: name.trim() }); await this.reload(); }
    catch (err) { this.status(`Cannot rename: ${err.message}`, true); }
  }

  // Bake the current take and add it to the library.
  async publish() {
    const $ = this.$, name = $('publish-name').value.trim();
    if (!name) { this.status('Name the motion to publish', true); $('publish-name').focus(); return; }
    if (!this.publishBody) return;
    $('publish-take').disabled = true;
    this.status(`Publishing "${name}"…`);
    try {
      const body = await this.publishBody();
      const res = await this.post('/api/library/publish', { ...body, name, folder: $('publish-folder').value });
      this.folder = res.folder;
      this.persist();
      await this.reload();
      this.status(`Published "${res.name}" in ${res.folder} (${res.frames} frames, ${res.skeleton_key}): pick it as a clip source in any take`);
    } catch (err) {
      this.status(`Publish failed: ${err.message || err}`, true);
    } finally {
      $('publish-take').disabled = false;
    }
  }

  close() {
    this.$('library').hidden = true;
    this.previews.clear();
    cancelAnimationFrame(this.raf);
  }

  sorted() {
    const q = this.$('library-search').value.trim().toLowerCase();
    const f = this.folder;
    const list = this.items.filter((m) => (!f || m.folder === f || m.folder?.startsWith(`${f}/`)) &&
      (!q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)));
    return this.sort === 'newest'
      ? list.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
      : list.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }

  render() {
    const $ = this.$;
    this.renderFolders();
    $('library-grid').classList.toggle('on', this.view === 'grid');
    $('library-list').classList.toggle('on', this.view === 'list');
    const host = $('library-items');
    host.className = `library-items ${this.view}`;
    this.observer.disconnect();
    this.previews.clear();
    host.replaceChildren();
    const current = this.motionPanel.activeLayer?.config?.source;
    const list = this.sorted();
    $('library-count').textContent = `${list.length} motion${list.length === 1 ? '' : 's'}${this.folder ? ` in ${this.folder}` : ''}`;
    for (const m of list) host.append(this.view === 'grid' ? this.card(m, current) : this.row(m, current));
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'muted pad';
      p.textContent = this.folder ? 'This folder is empty: drag motions onto it, or publish a take into it.' : 'No motions. Generate one with "Text to motion" (it opens in a new tab).';
      host.append(p);
    }
  }

  meta(m) {
    const secs = ((m.frames - 1) / 30).toFixed(1);
    const date = m.created ? new Date(m.created).toLocaleString() : '';
    return { kind: m.kind === 'sample' ? 'Sample' : m.kind === 'library' ? 'Published' : 'Kimodo', info: `${m.skeleton_key} · ${m.frames} f · ${secs} s`, date };
  }

  // Item actions: move to a folder, rename (published), delete (generated / published).
  actions(m) {
    const wrap = document.createElement('span');
    wrap.className = 'library-actions';
    wrap.addEventListener('click', (e) => e.stopPropagation());
    const sel = document.createElement('select');
    sel.title = 'Move to a folder';
    sel.append(new Option(`📁 ${m.folder ?? ''}`, ''));
    for (const f of this.folders) if (f !== m.folder) sel.append(new Option(`→ ${f}`, f));
    sel.addEventListener('change', () => { if (sel.value) this.move(m.id, sel.value); });
    wrap.append(sel);
    if (m.kind === 'library') {
      const b = document.createElement('button');
      Object.assign(b, { type: 'button', className: 'icon-button', textContent: '✎', title: 'Rename' });
      b.addEventListener('click', () => this.rename(m));
      wrap.append(b);
    }
    if (m.deletable) wrap.append(this.deleteButton(m));
    return wrap;
  }

  deleteButton(m) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-button danger';
    b.textContent = 'Delete';
    b.title = 'Delete this motion (its files are removed from demo-output)';
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
    foot.append(when, this.actions(m));
    el.append(canvas, name, sub, foot);
    el.draggable = true;
    el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-kimodo-motion', m.id));
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
    el.append(this.actions(m));
    el.draggable = true;
    el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-kimodo-motion', m.id));
    el.addEventListener('click', () => this.pick(m));
    return el;
  }

  pick(m) {
    this.onPick(m.id);
    this.close();
  }

  async remove(m) {
    const used = this.motionPanel.layers.some((l) => l.config?.source === m.id);
    if (!window.confirm(`Delete "${m.label}"?\nIts motion files are removed from the demo output.${used ? '\nIt is used by a layer of this scene.' : ''}`)) return;
    const r = await fetch(`motions/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      this.status(`Cannot delete: ${body.error || `HTTP ${r.status}`}`, true);
      return;
    }
    this.data.delete(m.id);
    await this.reload();
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
