// Motion source + root motion controls (Full / InPlace / CustomPath). Every change is sent
// to the backend (kmd-anim via /api/root-motion); the result is played back locally.

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

async function f32(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Float32Array(await r.arrayBuffer());
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

export class MotionPanel {
  constructor({ $, player, pathView, status, onLoaded }) {
    this.$ = $;
    this.player = player;
    this.pathView = pathView;
    this.status = status;
    this.onLoaded = onLoaded;
    this.skeletons = new Map();
    this.sourceRoot = null;
    this.request = 0;
    this.timer = 0;

    for (const [key, p] of Object.entries(PATH_PRESETS)) $('path-preset').append(new Option(p.label, key));
    $('path-preset').append(new Option('Custom', 'custom'));
    $('path-preset').addEventListener('change', () => this.applyPreset());
    for (const id of ['motion-source', 'lock', 'path-points', 'path-interp', 'path-loop', 'timing', 'timing-value', 'orient'])
      $(id).addEventListener(id === 'path-points' || id === 'timing-value' ? 'input' : 'change', () => {
        if (id === 'path-points' || id === 'path-interp' || id === 'path-loop') $('path-preset').value = 'custom';
        this.schedule();
      });
    for (const r of document.querySelectorAll('input[name="root-mode"]')) r.addEventListener('change', () => this.schedule());
    this.applyPreset(false);
    this.syncVisibility();
  }

  get mode() { return document.querySelector('input[name="root-mode"]:checked').value; }

  applyPreset(apply = true) {
    const p = PATH_PRESETS[this.$('path-preset').value];
    if (!p) return;
    this.$('path-points').value = p.points.map(([x, z]) => `${x} ${z}`).join('\n');
    this.$('path-interp').value = p.interpolation;
    this.$('path-loop').checked = !!p.loop;
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

  buildRequest(source) {
    const req = { source, mode: this.mode };
    if (req.mode === 'inplace') req.lock = this.$('lock').value;
    if (req.mode === 'path') {
      req.path = {
        points: parsePoints(this.$('path-points').value),
        interpolation: this.$('path-interp').value,
        loop: this.$('path-loop').checked,
      };
      req.timing = this.$('timing').value;
      const v = Number(this.$('timing-value').value);
      if (req.timing === 'duration') req.duration = v;
      if (req.timing === 'speed') req.speed = v;
      req.orient = this.$('orient').checked;
    }
    return req;
  }

  async apply() {
    const id = this.$('motion-source').value;
    const ticket = ++this.request;
    if (!id) return;
    const source = this.sources?.get(id);
    try {
      const req = this.buildRequest(id);
      this.$('motion-info').textContent = 'Processing…';
      const [def, sourceRoot] = await Promise.all([
        this.skeleton(source.skeleton_key),
        this.sourceId === id ? this.sourceRoot : f32(`motions/${encodeURIComponent(id)}/root.f32`),
      ]);
      const res = await fetch('/api/root-motion', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
      const [root, rotations, samples] = await Promise.all([
        f32(result.root), f32(result.rotations), result.path ? f32(result.path) : null,
      ]);
      if (ticket !== this.request) return; // a newer request superseded this one
      const first = this.sourceId !== id;
      this.sourceId = id;
      this.sourceRoot = sourceRoot;
      this.samples = samples;
      this.player.setSkeleton(def);
      this.player.setMotion({ root, rotations });
      this.pathView.show({ samples, waypoints: req.path ? req.path.points : [], sourceRoot, resultRoot: root });
      const travel = (r) => Math.hypot(r[r.length - 3] - r[0], r[r.length - 1] - r[2]);
      this.$('motion-info').textContent =
        `${source.skeleton_key} · ${this.player.frames} frames · ${this.player.duration.toFixed(2)} s · ` +
        `root travel ${travel(sourceRoot).toFixed(2)} m → ${travel(root).toFixed(2)} m`;
      this.status(`Root motion: ${req.mode}${req.mode === 'path' ? ` (${req.path.points.length} waypoints, ${req.timing})` : ''}`);
      this.onLoaded?.(first);
    } catch (err) {
      if (ticket !== this.request) return;
      this.$('motion-info').textContent = '';
      this.status(`Root motion failed: ${err.message || err}`, true);
    }
  }
}
