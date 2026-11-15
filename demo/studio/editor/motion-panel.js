// Motion layers + root motion controls. Each layer has its own motion source and root
// motion settings (Full / InPlace / CustomPath, edited in the Motion form for the active
// layer) plus blend mode, weight, mask, enable/mute, additive reference and time wrap.
// A single default layer goes through /api/root-motion (or /api/retarget); a real stack
// is baked by /api/layers. Results are played back locally.
import { LayerPanel } from './layer-panel.js';
import { MaskEditor } from './animation-mask.js';
import { Timeline } from './timeline.js';

// Preset paths on the ground plane (x, z in metres), starting at the origin and heading +Z.
const circle = Array.from({ length: 8 }, (_, k) => {
  const a = (k / 8) * 2 * Math.PI;
  const round = (v) => Math.round(v * 1000) / 1000;
  return [round(1.5 - 1.5 * Math.cos(a)), round(1.5 * Math.sin(a))];
});
export const PATH_PRESETS = {
  straight: { label: 'Straight 4 m', points: [[0, 0], [0, 4]], interpolation: 'polyline' },
  scurve: { label: 'S-curve', points: [[0, 0], [1, 1.5], [-1, 3], [0, 4.5]], interpolation: 'catmull' },
  corner: { label: 'Right-angle corner', points: [[0, 0], [0, 2], [2, 2]], interpolation: 'polyline' },
  zigzag: { label: 'Zig-zag', points: [[0, 0], [1, 1], [-1, 2], [1, 3], [0, 4]], interpolation: 'polyline' },
  circle: { label: 'Circle (loop)', points: circle, interpolation: 'catmull', loop: true },
};
const presetText = (p) => p.points.map(([x, z]) => `${x} ${z}`).join('\n');

async function f32(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Float32Array(await r.arrayBuffer());
}

async function postJSON(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

export function parsePoints(text) {
  const points = [];
  text.split(/\n|;/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const n = t.split(/[\s,]+/).map(Number);
    if (!(n.length === 2 || n.length === 3) || n.some((v) => !Number.isFinite(v)))
      throw new Error(`line ${i + 1}: expected "x z" or "x y z"`);
    points.push(n.length === 2 ? [n[0], 0, n[1]] : n);
  });
  if (!points.length) throw new Error('enter at least one waypoint');
  return points;
}

const defaultConfig = () => ({
  source: '', mode: 'full', lock: 'both', preset: 'scurve', points: presetText(PATH_PRESETS.scurve),
  interp: 'catmull', loop: false, timing: 'distance', timingValue: 0, orient: true,
});
const newLayer = (i, config = defaultConfig()) => ({
  name: i === 0 ? 'Base' : `Layer ${i + 1}`, config, blend: 'override', weight: 1, mask: 'full',
  customMask: null, enabled: true, muted: false, reference: 'first', wrap: 'clamp',
});

export class MotionPanel {
  constructor({ $, player, pathView, status, onLoaded, retarget, onSeek }) {
    this.$ = $;
    this.retarget = retarget;
    this.player = player;
    this.pathView = pathView;
    this.status = status;
    this.onLoaded = onLoaded;
    this.skeletons = new Map();
    this.sourceRoots = new Map();
    this.request = 0;
    this.timer = 0;
    this.layers = [newLayer(0)];
    this.active = 0;

    for (const [key, p] of Object.entries(PATH_PRESETS)) $('path-preset').append(new Option(p.label, key));
    $('path-preset').append(new Option('Custom', 'custom'));
    $('path-preset').addEventListener('change', () => this.applyPreset());
    for (const id of ['motion-source', 'lock', 'path-points', 'path-interp', 'path-loop', 'timing', 'timing-value', 'orient'])
      $(id).addEventListener(id === 'path-points' || id === 'timing-value' ? 'input' : 'change', () => {
        if (id === 'path-points' || id === 'path-interp' || id === 'path-loop') $('path-preset').value = 'custom';
        this.formChanged();
      });
    for (const r of document.querySelectorAll('input[name="root-mode"]')) r.addEventListener('change', () => this.formChanged());

    this.layerPanel = new LayerPanel($('layers-list'), $('add-layer'), {
      select: (i) => this.select(i),
      change: (i, patch) => {
        Object.assign(this.layers[i], patch);
        if ('mask' in patch || 'blend' in patch) this.select(i, false);
        this.renderLayers();
        this.schedule();
      },
      move: (i, delta) => {
        const j = i + delta;
        if (j < 0 || j >= this.layers.length) return;
        [this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]];
        if (this.active === i) this.active = j; else if (this.active === j) this.active = i;
        this.renderLayers();
        this.schedule();
      },
      remove: (i) => {
        if (this.layers.length === 1) return;
        this.layers.splice(i, 1);
        this.select(Math.min(this.active, this.layers.length - 1));
        this.schedule();
      },
      add: () => {
        const base = this.layers[this.active];
        const l = newLayer(this.layers.length, { ...base.config });
        l.mask = 'upper';
        l.blend = 'additive';
        l.weight = 0.5;
        this.layers.push(l);
        this.select(this.layers.length - 1);
        this.schedule();
      },
    });
    this.maskEditor = new MaskEditor({
      $, status,
      onChange: (mask) => { this.layers[this.active].customMask = mask; this.schedule(); },
    });
    this.timeline = new Timeline($('timeline'), { select: (i) => this.select(i), seek: (t) => onSeek?.(t) });
    this.writeForm(this.layers[0].config);
    this.renderLayers();
  }

  get mode() { return document.querySelector('input[name="root-mode"]:checked').value; }
  get activeLayer() { return this.layers[this.active]; }

  // ----- form <-> active layer config -------------------------------------------------
  readForm() {
    const $ = this.$;
    return {
      source: $('motion-source').value, mode: this.mode, lock: $('lock').value, preset: $('path-preset').value,
      points: $('path-points').value, interp: $('path-interp').value, loop: $('path-loop').checked,
      timing: $('timing').value, timingValue: Number($('timing-value').value) || 0, orient: $('orient').checked,
    };
  }

  writeForm(c) {
    const $ = this.$;
    if (c.source && [...$('motion-source').options].some((o) => o.value === c.source)) $('motion-source').value = c.source;
    const radio = document.querySelector(`input[name="root-mode"][value="${c.mode}"]`);
    if (radio) radio.checked = true;
    $('lock').value = c.lock;
    $('path-preset').value = c.preset;
    $('path-points').value = c.points;
    $('path-interp').value = c.interp;
    $('path-loop').checked = c.loop;
    $('timing').value = c.timing;
    $('timing-value').value = c.timingValue;
    $('orient').checked = c.orient;
    this.syncVisibility();
  }

  formChanged() {
    this.activeLayer.config = this.readForm();
    this.schedule();
  }

  applyPreset(apply = true) {
    const p = PATH_PRESETS[this.$('path-preset').value];
    if (!p) return;
    this.$('path-points').value = presetText(p);
    this.$('path-interp').value = p.interpolation;
    this.$('path-loop').checked = !!p.loop;
    this.activeLayer.config = this.readForm();
    if (apply) this.schedule();
  }

  syncVisibility() {
    const mode = this.mode;
    this.$('inplace-opts').hidden = mode !== 'inplace';
    this.$('path-opts').hidden = mode !== 'path';
    const timing = this.$('timing').value;
    this.$('timing-value-row').hidden = timing === 'distance';
    this.$('timing-unit').textContent = timing === 'speed' ? 'm/s' : 's (0 = clip length)';
  }

  // ----- layers ---------------------------------------------------------------------
  select(i, rerender = true) {
    this.active = i;
    this.writeForm(this.activeLayer.config);
    this.$('motion-layer-name').textContent = `${i + 1}. ${this.activeLayer.name}`;
    const l = this.activeLayer;
    if (l.mask === 'custom') l.customMask = this.maskEditor.show(l.customMask, this.maskJoints());
    else this.maskEditor.hide();
    if (rerender) this.renderLayers();
    else if (this.timelineData) this.timeline.set({ ...this.timelineData, active: i });
  }

  renderLayers() {
    this.layerPanel.render(this.layers, this.active);
    this.$('motion-layer-name').textContent = `${this.active + 1}. ${this.activeLayer.name}`;
    if (this.timelineData) this.timeline.set({ ...this.timelineData, active: this.active });
  }

  // Joints a custom mask is edited for: the character when retargeting, else the source skeleton.
  maskJoints() {
    const depthOf = (joints, j) => { let d = 0; for (let p = j.parent; p >= 0; p = joints[p].parent) d++; return d; };
    if (this.retarget?.enabled) {
      const js = this.retarget.character.joints;
      return js.map((j) => ({ name: j.name, depth: depthOf(js, j) }));
    }
    const key = this.sources?.get(this.layers[0].config.source)?.skeleton_key;
    const def = key && this.skeletons.get(key);
    if (!def) return [];
    return def.names.map((name, i) => ({ name, depth: (() => { let d = 0; for (let p = def.parents[i]; p >= 0; p = def.parents[p]) d++; return d; })() }));
  }

  isSimple() {
    const l = this.layers[0];
    return this.layers.length === 1 && l.blend === 'override' && l.weight === 1 && l.mask === 'full' && l.enabled && !l.muted;
  }

  // ----- sources / requests -----------------------------------------------------------
  async loadSources() {
    const r = await fetch('motions', { cache: 'no-store' });
    const list = r.ok ? await r.json() : [];
    const select = this.$('motion-source');
    const current = select.value;
    select.replaceChildren(new Option(list.length ? 'Choose a motion…' : 'No motions available', ''));
    for (const m of list) select.append(new Option(`${m.kind === 'sample' ? 'Sample' : 'Generated'} · ${m.label} · ${m.skeleton_key}, ${m.frames} f`, m.id));
    if (list.some((m) => m.id === current)) select.value = current;
    this.sources = new Map(list.map((m) => [m.id, m]));
    return list;
  }

  schedule() {
    this.syncVisibility();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.apply(), 200);
  }

  async skeleton(key) {
    if (!this.skeletons.has(key)) {
      const r = await fetch(`/api/skeletons/${encodeURIComponent(key)}`);
      if (!r.ok) throw new Error(`unknown skeleton ${key}`);
      this.skeletons.set(key, await r.json());
    }
    return this.skeletons.get(key);
  }

  async sourceRoot(id) {
    if (!this.sourceRoots.has(id)) this.sourceRoots.set(id, await f32(`motions/${encodeURIComponent(id)}/root.f32`));
    return this.sourceRoots.get(id);
  }

  rootMotionRequest(c) {
    const req = { source: c.source, mode: c.mode };
    if (c.mode === 'inplace') req.lock = c.lock;
    if (c.mode === 'path') {
      req.path = { points: parsePoints(c.points), interpolation: c.interp, loop: c.loop };
      req.timing = c.timing;
      if (c.timing === 'duration') req.duration = c.timingValue;
      if (c.timing === 'speed') req.speed = c.timingValue;
      req.orient = c.orient;
    }
    return req;
  }

  layerRequest(l, i) {
    const mask = l.mask === 'custom' ? (l.customMask || { version: 1, name: 'custom', default: 1, weights: {} }) : l.mask;
    return {
      name: l.name || `Layer ${i + 1}`, root_motion: this.rootMotionRequest(l.config), mode: l.blend, weight: l.weight,
      mask, enabled: l.enabled, muted: l.muted, reference: l.reference, wrap: l.wrap,
    };
  }

  // Source-space ground points -> character space (see RetargetResult in retarget.hpp).
  overlayMap(meta) {
    if (!meta) return { map: undefined, ground: 0 };
    const yaw = (meta.facing_yaw_degrees * Math.PI) / 180, c = Math.cos(yaw), s = Math.sin(yaw);
    const [sx, , sz] = meta.source_reference, [tx, , tz] = meta.target_reference, k = meta.root_scale;
    return { map: (x, z) => [tx + k * (c * (x - sx) + s * (z - sz)), tz + k * (-s * (x - sx) + c * (z - sz))], ground: meta.target_ground };
  }

  async apply() {
    const ticket = ++this.request;
    const missing = this.layers.findIndex((l) => !l.config.source);
    if (missing >= 0) {
      if (this.layers.length > 1) this.status(`Layer ${missing + 1} has no motion source`, true);
      return;
    }
    const keys = new Set(this.layers.map((l) => this.sources?.get(l.config.source)?.skeleton_key));
    try {
      if (keys.size !== 1) throw new Error('all layers must use motions of the same skeleton');
      const [key] = keys;
      this.$('motion-info').textContent = 'Processing…';
      const [def] = await Promise.all([this.skeleton(key), this.retarget?.setSource(key)]);
      const rt = this.retarget ? await this.retarget.request() : null;
      const result = this.isSimple() ? await this.applySimple(rt) : await this.applyStack(rt);
      if (ticket !== this.request) return; // a newer request superseded this one
      this.show(def, rt, result);
    } catch (err) {
      if (ticket !== this.request) return;
      this.$('motion-info').textContent = '';
      this.status(`Motion failed: ${err.message || err}`, true);
    }
  }

  async applySimple(rt) {
    const l = this.layers[0];
    const req = this.rootMotionRequest(l.config);
    const body = await postJSON(rt ? '/api/retarget' : '/api/root-motion', rt ? { root_motion: req, ...rt } : req);
    const rm = rt ? body.root_motion : body;
    const [root, rotations, samples, tRot, tTrans, sourceRoot] = await Promise.all([
      f32(rm.root), f32(rm.rotations), rm.path ? f32(rm.path) : null,
      rt ? f32(body.rotations) : null, rt ? f32(body.translations) : null, this.sourceRoot(l.config.source),
    ]);
    return {
      motion: { root, rotations }, target: rt ? { meta: body.meta, rotations: tRot, translations: tTrans } : null,
      overlay: { samples, waypoints: req.path?.points ?? [], sourceRoot, resultRoot: root, meta: rt ? body.meta : null },
      layers: [{ name: l.name, duration: (root.length / 3 - 1) / 30, enabled: true, muted: false }],
      summary: `root ${req.mode}`,
    };
  }

  async applyStack(rt) {
    const body = await postJSON('/api/layers', { layers: this.layers.map((l, i) => this.layerRequest(l, i)), ...(rt || {}) });
    const base = Math.max(0, this.layers.findIndex((l) => l.enabled));
    const act = body.layers[this.active], baseRm = body.layers[base].root_motion;
    const [rotations, translations, stackRoot, baseRoot, baseRot, actRoot, samples, sourceRoot] = await Promise.all([
      f32(body.rotations), f32(body.translations), body.native ? f32(body.root) : null,
      body.native ? null : f32(baseRm.root), body.native ? null : f32(baseRm.rotations),
      f32(act.root_motion.root), act.root_motion.path ? f32(act.root_motion.path) : null,
      this.sourceRoot(this.activeLayer.config.source),
    ]);
    const meta = body.meta;
    const activeReq = this.rootMotionRequest(this.activeLayer.config);
    return {
      // Native stacks play on the source skeleton; character stacks show the base layer's
      // source motion beside the character.
      motion: body.native ? { root: stackRoot, rotations } : { root: baseRoot, rotations: baseRot },
      target: body.native ? null : { meta, rotations, translations },
      overlay: {
        samples, waypoints: activeReq.path?.points ?? [], sourceRoot, resultRoot: actRoot,
        meta: body.native ? null : JSON.parse(JSON.stringify(body.layers[base].retarget)),
      },
      layers: meta.layers.map((l, i) => ({ name: l.name, duration: l.duration, enabled: l.enabled, muted: l.muted, index: i })),
      summary: `${this.layers.length} layers, ${meta.frames} frames`,
    };
  }

  show(def, rt, r) {
    const first = !this.shownOnce;
    this.shownOnce = true;
    this.player.setSkeleton(def);
    this.player.setMotion(r.motion);
    if (r.target) {
      this.player.setTarget({ character: this.retarget.character, ...r.target });
      this.retarget.diagnostics(r.overlay.meta ?? r.target.meta);
    } else {
      this.player.setTarget(null);
    }
    const { map, ground } = this.overlayMap(r.overlay.meta);
    this.sourceRootShown = r.overlay.sourceRoot;
    this.samples = r.overlay.samples;
    this.pathView.show({ ...r.overlay, map, ground });
    // The joint list for a custom mask is known now (character or source skeleton).
    if (this.activeLayer.mask === 'custom') this.activeLayer.customMask = this.maskEditor.show(this.activeLayer.customMask, this.maskJoints());
    this.timelineData = { layers: r.layers, duration: this.player.duration };
    this.timeline.set({ ...this.timelineData, active: this.active });
    const travel = (a) => Math.hypot(a[a.length - 3] - a[0], a[a.length - 1] - a[2]);
    this.$('motion-info').textContent =
      `${def.key} · ${this.player.frames} frames @ ${this.player.fps} fps · ${this.player.duration.toFixed(2)} s · ` +
      `active layer root travel ${travel(r.overlay.sourceRoot).toFixed(2)} m → ${travel(r.overlay.resultRoot).toFixed(2)} m`;
    this.status(`Motion: ${r.summary}${rt ? ' · retargeted' : ''}`);
    this.onLoaded?.(first);
  }
}
