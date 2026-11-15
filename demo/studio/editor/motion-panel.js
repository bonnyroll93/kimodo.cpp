// Story-style scene: anim clips on tracks plus anim layers (keyframes) on top.
// - Anim clips (kind 'clip'): each has its own motion source and root motion (Full / InPlace /
//   CustomPath), blend mode, weight, mask, enable/mute, additive reference, time wrap and clip
//   timing; they sit on tracks in the timeline. Clips on a track play in sequence and, with
//   auto blend, cross-fade over the time they overlap; higher tracks apply over lower ones.
// - Anim layers (kind 'keys'): keyframe offsets, applied after every clip, listed in their panel.
// The selected item's settings are shown in the attribute editor. this.layers holds both kinds;
// the stack sent to kmd-anim is ordered tracks bottom to top (clips by start), then anim layers.
// A single default clip goes through /api/root-motion (or /api/retarget); anything else is
// baked by /api/layers. Results are played back locally.
import { LayerPanel } from './layer-panel.js';
import { MaskEditor } from './animation-mask.js';
import { Timeline } from './timeline.js';
import { emptyTracks, keyFrames } from '../viewer/keyframes.js';

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

// The root-motion part of a config (everything but the source).
const rootOnly = ({ source, ...rest }) => rest;
const defaultConfig = () => ({
  source: '', mode: 'full', lock: 'both', preset: 'scurve', points: presetText(PATH_PRESETS.scurve),
  interp: 'catmull', loop: false, timing: 'distance', timingValue: 0, orient: true,
});
// Where/how a clip plays on the timeline (see ClipTiming in include/kimodo/anim/layers.hpp).
// auto_blend (studio only): cross-fade from the earlier clips of the same track over the overlap.
export const DEFAULT_TIMING = { start: 0, trim_in: 0, trim_out: 0, speed: 1, repeat: 1, extend: 'hold', fade_in: 0, fade_out: 0,
  align_root: false, ease_fades: true, auto_blend: true };
const timingOf = (l) => ({ ...DEFAULT_TIMING, ...(l.timing ?? {}) });
const isDefaultTiming = (l) => Object.entries(DEFAULT_TIMING).every(([k, v]) => timingOf(l)[k] === v);
const isKeys = (l) => l?.kind === 'keys';
const newId = () => Math.random().toString(36).slice(2, 10);

const newLayer = (name, config = defaultConfig()) => ({
  id: newId(), name, kind: 'clip', track: 0, config, blend: 'override', weight: 1, mask: 'full',
  customMask: null, enabled: true, muted: false, reference: 'first', wrap: 'clamp', timing: { ...DEFAULT_TIMING },
});

// Scenes saved before tracks existed: each motion layer on its own track, in stack order.
// Every clip and anim layer gets an id (anim layers bound to a clip refer to it).
export function normalizeLayers(layers) {
  let t = 0;
  const seen = new Set();
  for (const l of layers) {
    if (!l.id || seen.has(l.id)) l.id = newId();
    seen.add(l.id);
    if (isKeys(l)) continue;
    l.kind = 'clip';
    if (!Number.isInteger(l.track)) l.track = t;
    t = Math.max(t, l.track + 1);
  }
  return layers;
}

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
    this.layers = [newLayer('Clip 1')];
    this.$('k-scope').addEventListener('change', () => this.setScope(this.$('k-scope').value || null));
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
    for (const id of ['foot-lock', 'hip-adjust', 'foot-height', 'foot-speed', 'foot-blend'])
      $(id).addEventListener('change', () => { $('foot-opts').hidden = !$('foot-lock').checked; this.schedule(); });

    this.durations = new WeakMap(); // layer -> clip seconds from the last result
    this.sceneLength = 0; // seconds, 0 = the stack's own length
    const rowCallbacks = {
      select: (i) => this.select(i),
      change: (i, patch) => {
        // Switching to a custom mask starts from the preset the layer had.
        if (patch.mask === 'custom' && !this.layers[i].customMask) this.layers[i].customMaskFrom = this.layers[i].mask;
        Object.assign(this.layers[i], patch);
        if ('mask' in patch || 'blend' in patch) this.select(i, false);
        this.renderLayers();
        this.schedule();
      },
      move: (i, delta) => { // anim layers only: swap with the next anim layer up / down
        const ks = [...this.layers.keys()].filter((k) => isKeys(this.layers[k]));
        const j = ks[ks.indexOf(i) + delta];
        if (j === undefined) return;
        [this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]];
        if (this.active === i) this.active = j; else if (this.active === j) this.active = i;
        this.renderLayers();
        this.schedule();
      },
      remove: (i) => this.remove(i),
      canRemove: (i) => this.canRemove(i),
    };
    this.layerPanel = new LayerPanel($('layers-list'), rowCallbacks, { empty: 'No anim layers yet.' });
    this.attrPanel = new LayerPanel($('attr-row'), rowCallbacks, { reorder: false });
    this.maskEditor = new MaskEditor({
      $, status,
      onChange: (mask) => { this.layers[this.active].customMask = mask; this.schedule(); },
      onVisual: (weightOf) => this.onMaskVisual?.(weightOf),
      presets: () => this.maskPresets(),
    });
    $('add-key-layer').addEventListener('click', () => this.addKeyLayer());
    this.timeline = new Timeline($('timeline'), {
      select: (i) => this.select(i),
      seek: (t) => onSeek?.(t),
      timing: (i, patch, final) => {
        const l = this.layers[i];
        if (isKeys(l) && this.boundClip(l) >= 0) { if (final) this.status('This anim layer follows its clip: move the clip', true); return; }
        const { track, ...rest } = patch;
        if (track !== undefined && !isKeys(l)) l.track = Math.max(0, track | 0);
        l.timing = { ...timingOf(l), ...rest };
        if (final) this.schedule();
        this.renderTimeline(); // live preview of the bar while dragging
        if (i === this.active) this.renderAttributes();
      },
      addClip: () => this.addClip(),
      addTrack: () => this.addTrack(),
      split: () => this.splitActive(),
      duplicate: () => this.duplicateActive(),
      remove: (i) => this.remove(i),
      moveKeys: (i, frames, delta) => this.moveKeys(i, frames, delta),
      deleteKeys: (i, frames) => this.moveKeys(i, frames, null),
      graphOpen: () => this.graphOpen?.() ?? false,
    });
    this.installTimingForm();
    // Root motion (Full / In place / Path) per clip, or once for the whole scene (the clips
    // composed first, then one root motion on the result: e.g. a single path for a sequence).
    this.rootScope = 'clip';
    this.sceneRoot = rootOnly(defaultConfig());
    $('root-scope').addEventListener('change', () => {
      this.rootScope = $('root-scope').value === 'scene' ? 'scene' : 'clip';
      this.writeClipForm(this.layers[this.activeClip()]);
      this.schedule();
      this.onShown?.();
    });
    this.writeClipForm(this.layers[0]);
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

  // Form -> the selected clip (source) and the root motion it edits (the clip's or the scene's).
  storeForm() {
    const f = this.readForm(), l = this.layers[this.activeClip()];
    if (this.rootScope === 'scene') {
      this.sceneRoot = rootOnly(f);
      l.config = { ...l.config, source: f.source };
    } else {
      l.config = f;
    }
  }
  writeClipForm(l) {
    this.$('root-scope').value = this.rootScope;
    this.$('root-scope-note').textContent = this.rootScope === 'scene'
      ? 'Full / In place / Path apply once to the whole scene (all the clips composed); the clips keep their own motion.'
      : 'Each clip has its own Full / In place / Path.';
    this.writeForm(this.rootScope === 'scene' ? { ...this.sceneRoot, source: l.config.source } : l.config);
  }

  formChanged() {
    this.storeForm();
    this.schedule();
  }

  applyPreset(apply = true) {
    const p = PATH_PRESETS[this.$('path-preset').value];
    if (!p) return;
    this.$('path-points').value = presetText(p);
    this.$('path-interp').value = p.interpolation;
    this.$('path-loop').checked = !!p.loop;
    this.storeForm();
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

  // ----- clips and anim layers ------------------------------------------------------------
  select(i, rerender = true) {
    this.active = Math.max(0, Math.min(i, this.layers.length - 1));
    const l = this.activeLayer;
    if (!isKeys(l)) this.writeClipForm(l);
    this.$('motion-controls').hidden = isKeys(l);
    this.showMaskEditor();
    if (rerender) this.renderLayers();
    else this.renderAttributes();
    this.onShown?.(); // the path editor follows the active clip
  }

  renderLayers() {
    this.layerPanel.render([...this.layers.entries()].filter(([, l]) => isKeys(l)).map(([i, l]) => ({ l, i })), this.active);
    this.renderAttributes();
    this.renderTimeline();
  }

  renderAttributes() {
    const l = this.activeLayer;
    this.$('attr-kind').textContent = isKeys(l) ? `Anim layer · ${l.name}` : `Anim clip · ${l.name} · track ${(l.track ?? 0) + 1}`;
    this.attrPanel.render([{ l, i: this.active }], this.active);
    this.$('attr-timing').hidden = isKeys(l);
    this.renderScope();
    this.writeTiming();
  }

  // Clip timing fields of the attribute editor.
  installTimingForm() {
    const $ = this.$;
    const fields = ['start', 'trim_in', 'trim_out', 'speed', 'repeat', 'fade_in', 'fade_out'];
    const read = () => {
      const n = (id, lo, hi, def) => { const v = Number($(`t-${id}`).value); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
      return {
        start: n('start', -3600, 3600, 0), trim_in: n('trim_in', 0, 3600, 0), trim_out: n('trim_out', 0, 3600, 0),
        speed: n('speed', 0.05, 20, 1), repeat: Math.round(n('repeat', 1, 100, 1)), fade_in: n('fade_in', 0, 60, 0), fade_out: n('fade_out', 0, 60, 0),
        extend: $('t-extend').value, auto_blend: $('t-auto_blend').checked, ease_fades: $('t-ease_fades').checked, align_root: $('t-align_root').checked,
      };
    };
    const changed = () => {
      const l = this.activeLayer;
      if (isKeys(l)) return;
      l.timing = { ...timingOf(l), ...read() };
      this.renderTimeline();
      this.writeTiming();
      this.schedule();
    };
    for (const f of [...fields, 'extend', 'auto_blend', 'ease_fades', 'align_root']) $(`t-${f}`).addEventListener('change', changed);
  }

  writeTiming() {
    const $ = this.$, l = this.activeLayer;
    if (isKeys(l)) return;
    const t = timingOf(l), eff = this.effective().get(this.active) ?? t;
    const r = (v) => String(Math.round(v * 1000) / 1000);
    for (const f of ['start', 'trim_in', 'trim_out', 'speed', 'repeat', 'fade_in', 'fade_out'])
      if (document.activeElement !== $(`t-${f}`)) $(`t-${f}`).value = r(t[f]);
    $('t-extend').value = t.extend;
    $('t-auto_blend').checked = t.auto_blend;
    $('t-ease_fades').checked = t.ease_fades;
    $('t-align_root').checked = t.align_root;
    const [s0, e0] = this.extent(this.active);
    $('t-info').textContent = `On the timeline ${r(s0)}–${r(e0)} s · clip ${r(this.durationOf(this.active))} s` +
      (eff.fade_in > t.fade_in + 1e-4 ? ` · auto blend-in ${r(eff.fade_in)} s` : '');
  }

  // Seconds of a layer's clip (before timing): the last result, else the source length.
  durationOf(i) {
    const l = this.layers[i];
    if (!l) return 0;
    if (this.durations.has(l)) return this.durations.get(l);
    const m = !isKeys(l) && this.sources?.get(l.config.source);
    return m ? Math.max(m.frames - 1, 0) / 30 : 0;
  }
  segment(i) {
    const t = timingOf(this.layers[i]), d = this.durationOf(i);
    const tin = Math.min(t.trim_in, d), tout = t.trim_out > tin ? Math.min(t.trim_out, d) : d;
    return Math.max(tout - tin, 0);
  }
  extent(i) { const t = timingOf(this.layers[i]); return [t.start, t.start + (this.segment(i) / t.speed) * t.repeat]; }

  // [track, clip indices by start time], tracks bottom to top.
  tracks() {
    const byTrack = new Map();
    for (const [i, l] of this.layers.entries()) {
      if (isKeys(l)) continue;
      const tr = l.track ?? 0;
      if (!byTrack.has(tr)) byTrack.set(tr, []);
      byTrack.get(tr).push(i);
    }
    for (const list of byTrack.values()) list.sort((a, b) => timingOf(this.layers[a]).start - timingOf(this.layers[b]).start || a - b);
    return [...byTrack.entries()].sort((a, b) => a[0] - b[0]);
  }
  get trackCount() { return Math.max(1, ...this.layers.filter((l) => !isKeys(l)).map((l) => (l.track ?? 0) + 1)); }

  // Stack order sent to kmd-anim: tracks bottom to top (clips by start), then anim layers.
  stackOrder() {
    return [...this.tracks().flatMap(([, list]) => list), ...[...this.layers.keys()].filter((i) => isKeys(this.layers[i]))];
  }

  // Timing as evaluated (auto blend): a clip that is not the first of its track, or is on an
  // upper track, starts empty (it does not hold its first frame over what plays before it)
  // and fades in over the time it overlaps the earlier clips of its track.
  effective() {
    const eff = new Map();
    for (const [tr, list] of this.tracks()) {
      list.forEach((i, k) => {
        const t = timingOf(this.layers[i]);
        const e = { ...t };
        if (t.auto_blend) {
          if (k > 0 || tr > 0) e.empty_before = true;
          let overlap = 0;
          for (const j of list.slice(0, k)) if (this.layers[j].enabled) overlap = Math.max(overlap, this.extent(j)[1] - t.start);
          const [s0, e0] = this.extent(i);
          e.fade_in = Math.max(t.fade_in, Math.min(Math.max(overlap, 0), e0 - s0));
        }
        eff.set(i, e);
      });
    }
    for (const [i, l] of this.layers.entries()) {
      if (!isKeys(l)) continue;
      const c = this.boundClip(l);
      if (c < 0) { eff.set(i, timingOf(l)); continue; }
      // Bound to a clip: keys in the clip's time (start, speed), active only while the clip
      // plays, blending in / out with it.
      const ce = eff.get(c) ?? timingOf(this.layers[c]), [s0, e0] = this.extent(c);
      eff.set(i, { ...DEFAULT_TIMING, start: s0, speed: ce.speed, extend: 'hold', empty_before: true, end: e0,
        fade_in: ce.fade_in, fade_out: ce.fade_out, ease_fades: ce.ease_fades });
    }
    return eff;
  }

  // ----- anim layer scope: the whole timeline, or bound to a clip -------------------------
  boundClip(l) { return l?.bind ? this.layers.findIndex((c) => !isKeys(c) && c.id === l.bind) : -1; }

  // Key frame (anim layer time) <-> stack frame for the selected anim layer.
  keyFrame(stackFrame, i = this.active) {
    const t = this.effective().get(i) ?? DEFAULT_TIMING, fps = this.player.fps;
    return (stackFrame / fps - t.start) * t.speed * fps;
  }
  stackFrame(keyFrame, i = this.active) {
    const t = this.effective().get(i) ?? DEFAULT_TIMING, fps = this.player.fps;
    return (keyFrame / fps / t.speed + t.start) * fps;
  }

  // Re-time the keys of anim layer i so they stay where they are on the timeline.
  remapKeys(i, map, scale) {
    const tracks = this.layers[i].keys?.tracks ?? {};
    for (const ch of Object.values(tracks))
      for (const keys of Object.values(ch))
        for (const k of keys) {
          k.f = Math.round(map(k.f) * 1000) / 1000;
          if (k.l) k.l = [k.l[0] * scale, k.l[1]];
          if (k.r) k.r = [k.r[0] * scale, k.r[1]];
        }
  }

  setScope(clipId, i = this.active) {
    const l = this.layers[i];
    if (!isKeys(l) || (l.bind ?? null) === clipId) return;
    const fps = this.player.fps;
    const before = this.effective().get(i);
    const toStack = (f) => (f / fps / before.speed + before.start) * fps; // with the old scope
    l.bind = clipId;
    const after = this.effective().get(i);
    this.remapKeys(i, (f) => (toStack(f) / fps - after.start) * after.speed * fps, after.speed / before.speed);
    this.renderLayers();
    this.schedule();
    this.onShown?.();
  }

  renderScope() {
    const $ = this.$, l = this.activeLayer;
    $('attr-scope').hidden = !isKeys(l);
    if (!isKeys(l)) return;
    const sel = $('k-scope');
    sel.replaceChildren(new Option('Whole timeline (scene)', ''));
    for (const [tr, list] of this.tracks())
      for (const c of list) sel.append(new Option(`Clip: ${this.layers[c].name} (track ${tr + 1})`, this.layers[c].id));
    const c = this.boundClip(l);
    sel.value = c >= 0 ? l.bind : '';
    $('k-scope-info').textContent = c >= 0
      ? 'Bound: the keys move and stretch with the clip and only act while it plays (blending in / out with it).'
      : l.bind ? 'The clip this layer was bound to is gone: it now spans the whole timeline.' : 'The keys act on the whole main timeline.';
  }

  renderTimeline() {
    const eff = this.effective(), fps = this.timelineData?.fps ?? this.player.fps;
    const joint = this.keyJoint?.();
    const items = this.layers.map((l, i) => ({
      name: l.name, kind: l.kind ?? 'clip', track: l.track ?? 0, duration: this.durationOf(i), enabled: l.enabled, muted: l.muted,
      timing: isKeys(l) ? eff.get(i) : timingOf(l), eff: eff.get(i), bound: isKeys(l) && this.boundClip(l) >= 0,
      keyFrames: isKeys(l) ? (joint ? keyFrames(l.keys, joint) : this.allKeyFrames(l)) : [],
    }));
    let end = this.player.duration;
    for (const i of this.layers.keys()) if (this.layers[i].enabled) end = Math.max(end, this.extent(i)[1]);
    this.timeline.set({ layers: items, duration: end, active: this.active, fps, tracks: this.trackCount,
      contacts: this.timelineData?.contacts ?? null, range: this.player.range ? this.player.rangeFrames.map((f) => f / fps) : null });
  }

  canRemove(i) { return isKeys(this.layers[i]) || this.layers.filter((l) => !isKeys(l)).length > 1; }

  remove(i) {
    if (!this.layers[i] || !this.canRemove(i)) { this.status('The scene needs at least one anim clip', true); return; }
    const id = this.layers[i].id;
    for (const [k, l] of this.layers.entries()) if (isKeys(l) && l.bind === id) this.setScope(null, k);
    this.layers.splice(i, 1);
    this.select(Math.min(this.active > i ? this.active - 1 : this.active, this.layers.length - 1));
    this.schedule();
  }

  // The selected clip, or the last clip of the scene when an anim layer is selected.
  activeClip() {
    if (!isKeys(this.activeLayer)) return this.active;
    for (let i = this.layers.length - 1; i >= 0; i--) if (!isKeys(this.layers[i])) return i;
    return 0;
  }
  insertClip(l, duration) {
    // Clips go before the anim layers in the array (the stack order is computed anyway).
    const at = this.layers.findIndex(isKeys);
    const i = at < 0 ? this.layers.length : at;
    this.layers.splice(i, 0, l);
    if (duration !== undefined) this.durations.set(l, duration);
    return i;
  }
  clipName() { return `Clip ${this.layers.filter((l) => !isKeys(l)).length + 1}`; }

  // + Clip: same source as the selected clip, after the last clip of its track, root aligned.
  addClip() {
    const ci = this.activeClip(), base = this.layers[ci], tr = base.track ?? 0;
    const list = this.tracks().find(([t]) => t === tr)?.[1] ?? [ci];
    const end = Math.max(...list.map((j) => this.extent(j)[1]));
    const l = newLayer(this.clipName(), { ...base.config });
    l.track = tr;
    l.timing = { ...DEFAULT_TIMING, start: end, align_root: true };
    this.select(this.insertClip(l, this.durationOf(ci)));
    this.schedule();
  }

  // + Track: a new track above with a clip of the selected clip's source at the playhead,
  // blending in and out over a quarter of a second.
  addTrack() {
    const ci = this.activeClip(), base = this.layers[ci];
    const l = newLayer(this.clipName(), { ...base.config });
    l.track = this.trackCount;
    l.timing = { ...DEFAULT_TIMING, start: Math.round(this.player.time * 30) / 30, extend: 'none', fade_in: 0.25, fade_out: 0.25, align_root: true };
    this.select(this.insertClip(l, this.durationOf(ci)));
    this.schedule();
  }

  addKeyLayer() {
    const base = this.layers[this.activeClip()];
    const n = this.layers.filter(isKeys).length;
    const l = { ...newLayer(n ? `Keys ${n + 1}` : 'Keys', { ...base.config }), kind: 'keys', bind: null, keys: emptyTracks(), blend: 'additive', reference: 'rest' };
    delete l.track;
    this.layers.push(l);
    this.select(this.layers.length - 1);
    this.schedule();
  }

  // Joints a custom mask is edited for: the character when retargeting, else the source skeleton.
  maskJoints() {
    const depth = (parents, i) => { let d = 0; for (let p = parents[i]; p >= 0; p = parents[p]) d++; return d; };
    if (this.retarget?.enabled) {
      const js = this.retarget.character.joints;
      const parents = js.map((j) => j.parent);
      return js.map((j, i) => ({ name: j.name, parent: j.parent, depth: depth(parents, i) }));
    }
    const key = this.sources?.get(this.layers[this.baseIndex()].config.source)?.skeleton_key;
    const def = key && this.skeletons.get(key);
    if (!def) return [];
    return def.names.map((name, i) => ({ name, parent: def.parents[i], depth: depth(def.parents, i) }));
  }

  // Preset masks from kmd-anim for the skeleton the stack is evaluated on (cached).
  async maskPresets() {
    let url;
    if (this.retarget?.enabled) url = `/api/masks?character=${encodeURIComponent(await this.retarget.ensureCharacterId())}`;
    else url = `/api/masks?skeleton=${encodeURIComponent(this.sources?.get(this.layers[this.baseIndex()].config.source)?.skeleton_key ?? '')}`;
    this.presetCache ??= new Map();
    if (!this.presetCache.has(url)) {
      const r = await fetch(url);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      this.presetCache.set(url, body);
    }
    return this.presetCache.get(url);
  }

  async showMaskEditor() {
    const l = this.activeLayer;
    if (l.mask !== 'custom') { this.maskEditor.hide(); return; }
    const joints = this.maskJoints();
    if (!l.customMask && joints.length && (l.customMaskFrom === 'upper' || l.customMaskFrom === 'lower')) {
      try {
        const preset = (await this.maskPresets())[l.customMaskFrom];
        l.customMask = { version: 1, name: `custom (${l.customMaskFrom})`, default: 0,
          weights: Object.fromEntries(joints.map((j) => [j.name, preset.weights[j.name] ?? preset.default ?? 0])) };
        this.schedule();
      } catch { /* fall back to "all included" */ }
    }
    if (joints.length) l.customMaskFrom = undefined;
    if (this.activeLayer === l && l.mask === 'custom') l.customMask = this.maskEditor.show(l.customMask, joints);
  }

  // Foot locking applies to the whole result (after the layers are baked).
  footLockRequest() {
    const $ = this.$;
    if (!$('foot-lock').checked) return null;
    return {
      enabled: true, adjust_hips: $('hip-adjust').checked,
      height: Math.max(0, Number($('foot-height').value) || 0), speed: Math.max(0, Number($('foot-speed').value) || 0),
      blend: Math.max(0, Math.round(Number($('foot-blend').value) || 0)),
    };
  }

  // Frames keyed on any joint of anim layer l.
  allKeyFrames(l) {
    const set = new Set();
    for (const name of Object.keys(l.keys?.tracks ?? {})) for (const f of keyFrames(l.keys, name)) set.add(f);
    return [...set].sort((a, b) => a - b);
  }

  // Timeline key edits on anim layer i: the keys at `frames` of the selected joint (every
  // joint when none is selected) move by delta frames (delta null: deleted). A moved key
  // replaces a key already at its destination.
  moveKeys(i, frames, delta) {
    const l = this.layers[i];
    if (!isKeys(l)) return;
    const joint = this.keyJoint?.();
    const sel = new Set(frames.map((f) => Math.round(f)));
    const tracks = l.keys.tracks ?? {};
    for (const [name, ch] of Object.entries(tracks)) {
      if (joint && name !== joint) continue;
      for (const [c, keys] of Object.entries(ch)) {
        const moving = keys.filter((k) => sel.has(Math.round(k.f)));
        if (!moving.length) continue;
        let rest = keys.filter((k) => !sel.has(Math.round(k.f)));
        if (delta !== null) {
          for (const k of moving) k.f = Math.max(0, Math.round(k.f) + delta);
          const dest = new Set(moving.map((k) => k.f));
          rest = rest.filter((k) => !dest.has(Math.round(k.f))).concat(moving);
        }
        rest.sort((a, b) => a.f - b.f);
        if (rest.length) ch[c] = rest; else delete ch[c];
      }
      if (!Object.keys(ch).length) delete tracks[name];
    }
    this.status(`${delta === null ? 'Deleted' : `Moved ${delta > 0 ? '+' : ''}${delta} frame(s):`} ${sel.size} key frame(s)${joint ? ` of ${joint}` : ' (all joints)'}`);
    this.onKeysEdited?.();
    this.renderTimeline();
    this.schedule();
  }

  // Recompute the key ticks shown on anim-layer rows (selected joint changed / keys edited).
  refreshKeyTicks() { this.renderTimeline(); }

  // The first enabled clip in stack order: drives overlays and the source skeleton.
  baseIndex() {
    const order = this.stackOrder().filter((i) => !isKeys(this.layers[i]));
    return order.find((i) => this.layers[i].enabled) ?? order[0] ?? 0;
  }

  // Split the selected clip at the playhead: the first part ends there, the second starts there
  // with the rest of the clip on the same track (same content, so the motion is unchanged).
  splitActive() {
    const i = this.active, l = this.layers[i], t = timingOf(l);
    if (isKeys(l)) return;
    const full = this.durationOf(i);
    const tout = t.trim_out > t.trim_in ? t.trim_out : full;
    const now = this.player.time;
    const cut = t.trim_in + (now - t.start) * t.speed;
    if (t.repeat !== 1 || cut <= t.trim_in + 1e-3 || cut >= tout - 1e-3) {
      this.status('Move the playhead inside the selected clip (single cycle) to split it', true);
      return;
    }
    const second = structuredClone(l);
    second.id = newId();
    second.name = `${l.name} (2)`;
    second.timing = { ...t, trim_in: cut, start: now, fade_in: 0 };
    l.timing = { ...t, trim_out: cut, fade_out: 0 };
    this.durations.set(second, full);
    this.layers.splice(i + 1, 0, second);
    this.select(i + 1);
    this.schedule();
  }

  // Duplicate the selected clip right after itself on its track, continuing the root.
  duplicateActive() {
    const i = this.active, l = this.layers[i], t = timingOf(l);
    if (isKeys(l)) return;
    const copy = structuredClone(l);
    copy.id = newId();
    copy.name = `${l.name} copy`;
    copy.timing = { ...t, start: this.extent(i)[1], align_root: true };
    this.durations.set(copy, this.durationOf(i));
    this.layers.splice(i + 1, 0, copy);
    this.select(i + 1);
    this.schedule();
  }

  isSimple() {
    const l = this.layers[0];
    return this.rootScope === 'clip' && !this.$('foot-lock').checked && !(this.sceneLength > 0) && this.layers.length === 1 && !isKeys(l) && isDefaultTiming(l) &&
      l.blend === 'override' && l.weight === 1 && l.mask === 'full' && l.enabled && !l.muted;
  }

  // ----- sources / requests -----------------------------------------------------------
  async loadSources() {
    const r = await fetch('motions', { cache: 'no-store' });
    const list = r.ok ? await r.json() : [];
    list.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
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

  // The scene as /api/layers or /api/export "layers", in stack order (a single default clip
  // bakes to exactly its motion), plus the scene length override.
  stackRequest() {
    const eff = this.effective();
    return this.stackOrder().map((i) => this.layerRequest(this.layers[i], i, eff.get(i)));
  }
  stackBody() {
    return { layers: this.stackRequest(), ...(this.sceneLength > 0 ? { length: this.sceneLength } : {}),
      ...(this.rootScope === 'scene' ? { scene_root: this.rootMotionRequest({ ...this.sceneRoot, source: '' }) } : {}) };
  }

  layerRequest(l, i, eff = timingOf(l)) {
    const { auto_blend, ...timing } = eff;
    const mask = l.mask === 'custom' ? (l.customMask || { version: 1, name: 'custom', default: 1, weights: {} }) : l.mask;
    if (isKeys(l)) return { name: l.name || `Keys ${i + 1}`, keys: l.keys, mode: l.blend === 'override' ? 'override' : 'additive', weight: l.weight, mask, enabled: l.enabled, muted: l.muted, wrap: l.wrap, timing };
    return {
      name: l.name || `Clip ${i + 1}`, root_motion: this.rootMotionRequest(l.config), mode: l.blend, weight: l.weight,
      mask, enabled: l.enabled, muted: l.muted, reference: l.reference, wrap: l.wrap, timing,
    };
  }

  // Source-space ground points -> character space (see RetargetResult in retarget.hpp), and back.
  overlayMap(meta) {
    if (!meta) return { map: undefined, inverse: (x, z) => [x, z], ground: 0 };
    const yaw = (meta.facing_yaw_degrees * Math.PI) / 180, c = Math.cos(yaw), s = Math.sin(yaw);
    const [sx, , sz] = meta.source_reference, [tx, , tz] = meta.target_reference, k = meta.root_scale || 1;
    return {
      map: (x, z) => [tx + k * (c * (x - sx) + s * (z - sz)), tz + k * (-s * (x - sx) + c * (z - sz))],
      inverse: (x, z) => {
        const ux = (x - tx) / k, uz = (z - tz) / k;
        return [sx + c * ux - s * uz, sz + s * ux + c * uz];
      },
      ground: meta.target_ground,
    };
  }

  // For the in-viewport path editor: the active layer's path and the current display mapping.
  editablePath() {
    const c = this.rootScope === 'scene' ? this.sceneRoot : this.activeLayer.config;
    if (isKeys(this.activeLayer) && this.rootScope !== 'scene') return null;
    if (c.mode !== 'path') return null;
    try {
      return { points: parsePoints(c.points), interpolation: c.interp, loop: c.loop };
    } catch {
      return null;
    }
  }

  displayView() {
    return this.view ?? { map: (x, z) => [x, z], inverse: (x, z) => [x, z], ground: 0 };
  }

  setPathPoints(points) {
    this.$('path-points').value = points.map(([x, z]) => `${x} ${z}`).join('\n');
    this.$('path-preset').value = 'custom';
    this.formChanged();
  }

  async apply() {
    const ticket = ++this.request;
    this.renderTimeline();
    const missing = this.layers.find((l) => !isKeys(l) && !l.config.source);
    if (missing) {
      if (this.layers.length > 1) this.status(`Clip "${missing.name}" has no motion source`, true);
      return;
    }
    const keys = new Set(this.layers.filter((l) => !isKeys(l)).map((l) => this.sources?.get(l.config.source)?.skeleton_key));
    try {
      if (keys.size !== 1) throw new Error('all clips must use motions of the same skeleton');
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
      durations: [[0, (root.length / 3 - 1) / 30]],
      summary: `root ${req.mode}`,
    };
  }

  async applyStack(rt) {
    const foot_lock = this.footLockRequest();
    const order = this.stackOrder(), pos = new Map(order.map((i, k) => [i, k]));
    const body = await postJSON('/api/layers', { ...this.stackBody(), ...(rt || {}), ...(foot_lock ? { foot_lock } : {}) });
    if (body.scene) return this.sceneResult(body, order);
    const base = this.baseIndex();
    // Overlays follow the selected clip, or the base clip when an anim layer is selected.
    const shown = isKeys(this.activeLayer) ? base : this.active;
    const act = body.layers[pos.get(shown)], baseRm = body.layers[pos.get(base)].root_motion;
    const [rotations, translations, stackRoot, baseRoot, baseRot, actRoot, samples, sourceRoot] = await Promise.all([
      f32(body.rotations), f32(body.translations), body.native ? f32(body.root) : null,
      body.native ? null : f32(baseRm.root), body.native ? null : f32(baseRm.rotations),
      f32(act.root_motion.root), act.root_motion.path ? f32(act.root_motion.path) : null,
      this.sourceRoot(this.layers[shown].config.source),
    ]);
    const meta = body.meta;
    const activeReq = this.rootMotionRequest(this.layers[shown].config);
    const clips = this.layers.filter((l) => !isKeys(l)).length, animLayers = this.layers.length - clips;
    return {
      // Native stacks play on the source skeleton; character stacks show the base clip's
      // source motion beside the character.
      motion: body.native ? { root: stackRoot, rotations } : { root: baseRoot, rotations: baseRot },
      target: body.native ? null : { meta, rotations, translations },
      overlay: {
        samples, waypoints: activeReq.path?.points ?? [], sourceRoot, resultRoot: actRoot,
        meta: body.native ? null : JSON.parse(JSON.stringify(body.layers[pos.get(base)].retarget)),
      },
      durations: meta.layers.map((l, k) => [order[k], l.duration]),
      footLock: meta.foot_lock ?? null,
      fps: meta.fps,
      summary: `${clips} clip${clips === 1 ? '' : 's'} on ${this.trackCount} track${this.trackCount === 1 ? '' : 's'}` +
        `${animLayers ? `, ${animLayers} anim layer${animLayers === 1 ? '' : 's'}` : ''}, ${meta.frames} frames${meta.foot_lock ? ', feet locked' : ''}`,
    };
  }

  // Scene root motion: body.layers = [the scene (clips composed, then root motion), ...anim layers];
  // body.scene = the composed clips before the root motion (durations, source root trail).
  async sceneResult(body, order) {
    const rm = body.layers[0].root_motion;
    const [rotations, translations, stackRoot, sceneRoot, sceneRot, samples, sourceRoot] = await Promise.all([
      f32(body.rotations), f32(body.translations), body.native ? f32(body.root) : null,
      f32(rm.root), body.native ? null : f32(rm.rotations), rm.path ? f32(rm.path) : null, f32(body.scene.root),
    ]);
    const meta = body.meta, clipOrder = order.filter((i) => !isKeys(this.layers[i])), keyOrder = order.filter((i) => isKeys(this.layers[i]));
    const req = this.rootMotionRequest({ ...this.sceneRoot, source: '' });
    const clips = clipOrder.length;
    return {
      motion: body.native ? { root: stackRoot, rotations } : { root: sceneRoot, rotations: sceneRot },
      target: body.native ? null : { meta, rotations, translations },
      overlay: { samples, waypoints: req.path?.points ?? [], sourceRoot, resultRoot: sceneRoot,
        meta: body.native ? null : JSON.parse(JSON.stringify(body.layers[0].retarget)) },
      durations: [...body.scene.meta.layers.map((l, k) => [clipOrder[k], l.duration]),
        ...meta.layers.slice(1).map((l, k) => [keyOrder[k], l.duration])],
      footLock: meta.foot_lock ?? null,
      fps: meta.fps,
      summary: `${clips} clip${clips === 1 ? '' : 's'}, scene root ${req.mode}${keyOrder.length ? `, ${keyOrder.length} anim layer(s)` : ''}, ${meta.frames} frames${meta.foot_lock ? ', feet locked' : ''}`,
    };
  }

  show(def, rt, r) {
    const first = !this.shownOnce;
    this.shownOnce = true;
    if (this.player.embedded) { // a Motion/Layers result replaces an embedded animation preview
      this.player.setEmbedded(null);
      this.$('embedded-anim').value = '';
    }
    this.player.setSkeleton(def);
    this.player.setMotion(r.motion);
    if (r.target) {
      this.player.setTarget({ character: this.retarget.character, ...r.target });
      this.retarget.diagnostics(r.overlay.meta ?? r.target.meta);
    } else {
      this.player.setTarget(null);
    }
    const { map, inverse, ground } = this.overlayMap(r.overlay.meta);
    this.view = { map: map ?? ((x, z) => [x, z]), inverse, ground };
    this.sourceRootShown = r.overlay.sourceRoot;
    this.samples = r.overlay.samples;
    this.pathView.show({ ...r.overlay, map, ground });
    const fl = r.footLock;
    this.pathView.showContacts(fl?.contacts, fl?.ground ?? 0);
    // The joint list for a custom mask is known now (character or source skeleton).
    if (this.activeLayer.mask === 'custom') this.showMaskEditor();
    const fps = r.fps || this.player.fps;
    for (const [i, d] of r.durations) if (this.layers[i]) this.durations.set(this.layers[i], d);
    this.timelineData = {
      fps, contacts: fl ? fl.contacts.map((c) => ({ foot: c.foot, start: c.start / fps, end: c.end / fps })) : null,
    };
    this.renderTimeline();
    this.writeTiming();
    const travel = (a) => Math.hypot(a[a.length - 3] - a[0], a[a.length - 1] - a[2]);
    this.$('motion-info').textContent =
      `${def.key} · ${this.player.frames} frames @ ${this.player.fps} fps · ${this.player.duration.toFixed(2)} s · ` +
      `${this.rootScope === 'scene' ? 'scene' : 'selected clip'} root travel ${travel(r.overlay.sourceRoot).toFixed(2)} m → ${travel(r.overlay.resultRoot).toFixed(2)} m` +
      (fl ? ` · foot lock: ${fl.contacts.length} contacts, slide ${(fl.slide_before * 1000).toFixed(1)} → ${(fl.slide_after * 1000).toFixed(1)} mm` +
            `, hips −${(fl.max_hip_drop * 100).toFixed(1)} cm${fl.unreachable_frames ? `, ${fl.unreachable_frames} frames out of reach` : ''}` : '');
    this.status(`Motion: ${r.summary}${rt ? ' · retargeted' : ''}`);
    this.onLoaded?.(first);
    this.onShown?.();
  }
}
