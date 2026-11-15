// Story-style timeline: anim clips on tracks, anim layers (keyframes) below them.
//   drag a clip: move it (drop on another track row to change track) · drag its left / right
//   edge: trim · Ctrl (Cmd, Alt) + drag or Ctrl + wheel: stretch / compress (change speed;
//   body and right edge keep the start, left edge keeps the end) · click a clip or a layer
//   row: select it (the attribute editor shows its settings) · click empty space: seek.
// Overlapping clips on the same track cross-fade over the overlap (shown as a gradient).
// Times snap to frames (Shift: free).
// Scrubbing: drag in the frame ruler (top row) or grab the playhead's handle and drag.
// Keyframes (◆ on anim-layer rows; the selected joint's keys, or every keyed frame when no
// joint is selected): click selects (Shift: add / remove) and seeks, drag moves the
// selected keys in time, Delete removes them.

const EDGE = 6; // px grab zone for trimming

export class Timeline {
  // cb: select(i), seek(seconds), timing(i, patch, final), addClip(), addTrack(), split(),
  //     duplicate(), remove(i), moveKeys(i, frames, delta), deleteKeys(i, frames)
  constructor(container, cb) {
    this.container = container;
    this.cb = cb;
    this.duration = 0;
    this.fps = 30;
    this.layers = [];
    this.playhead = document.createElement('div');
    this.playhead.className = 'tl-playhead';
    const handle = document.createElement('div');
    handle.className = 'tl-playhead-handle';
    handle.title = 'Drag to scrub';
    this.playhead.append(handle);
    this.drag = null;
    container.addEventListener('pointerdown', (e) => this.down(e));
    container.addEventListener('pointermove', (e) => this.move(e));
    container.addEventListener('pointerup', () => this.up());
    container.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    const mod = (e) => this.container.classList.toggle('stretching', e.ctrlKey || e.metaKey || e.altKey);
    window.addEventListener('keydown', mod);
    window.addEventListener('keyup', mod);
    window.addEventListener('blur', () => this.container.classList.remove('stretching'));
    this.keySel = { i: -1, frames: new Set() };
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (!this.keySel.frames.size || this.cb.graphOpen?.()) return;
      e.preventDefault();
      const { i, frames } = this.keySel;
      this.keySel = { i: -1, frames: new Set() };
      this.cb.deleteKeys?.(i, [...frames]);
    });
  }

  // layers: per MotionPanel.layers index {name, kind, track, duration (clip s), enabled, muted,
  // timing, eff (effective timing incl. auto blends), keyTimes}; duration: stack seconds.
  set({ layers, duration, active, contacts = null, fps = 30, tracks = 1, range = null }) {
    this.range = range;
    this.layers = layers;
    this.duration = Math.max(duration, 1e-3);
    this.fps = fps;
    this.active = active;
    this.contacts = contacts;
    this.trackCount = Math.max(tracks, 1 + Math.max(0, ...layers.filter((l) => l && l.kind !== 'keys').map((l) => l.track ?? 0)));
    this.render();
  }

  timingOf(i) {
    return { start: 0, trim_in: 0, trim_out: 0, speed: 1, repeat: 1, extend: 'hold', fade_in: 0, fade_out: 0, align_root: false,
      ...(this.layers[i]?.timing ?? {}) };
  }
  segment(i) {
    const t = this.timingOf(i), d = this.layers[i]?.duration ?? 0;
    const tin = Math.min(t.trim_in, d), tout = t.trim_out > tin ? Math.min(t.trim_out, d) : d;
    return Math.max(tout - tin, 0);
  }
  extent(i) {
    const t = this.timingOf(i);
    if (t.end > t.start) return [t.start, t.end]; // bound to a clip
    if (this.layers[i]?.kind === 'keys') return [t.start, Math.max(this.duration, t.start)]; // the whole scene
    return [t.start, t.start + (this.segment(i) / t.speed) * t.repeat];
  }
  pct(seconds) { return `${(seconds / this.duration) * 100}%`; }
  // Stack time of key frame f of anim layer i (its timing: start, speed).
  keyTime(i, f) { const t = this.timingOf(i); return t.start + f / this.fps / t.speed; }

  render() {
    const c = this.container;
    c.replaceChildren();
    c.hidden = !this.layers.length;
    if (!this.layers.length) return;
    c.append(this.toolbar());
    const labels = document.createElement('div');
    labels.className = 'tl-labels';
    const tracks = document.createElement('div');
    tracks.className = 'tl-tracks';
    this.tracksEl = tracks;
    // Frame ruler: drag in it to scrub.
    const rulerLabel = document.createElement('div');
    rulerLabel.className = 'tl-label ruler';
    rulerLabel.textContent = 'Frames';
    const ruler = document.createElement('div');
    ruler.className = 'tl-track tl-ruler';
    ruler.title = 'Drag to scrub';
    const frames = this.duration * this.fps;
    const step = [1, 2, 5, 10, 15, 30, 60, 150, 300, 600].find((s) => frames / s <= 16) ?? 1200;
    for (let f = 0; f <= frames + 1e-6; f += step) {
      const tick = document.createElement('span');
      tick.className = 'tl-tick';
      tick.style.left = this.pct(f / this.fps);
      tick.textContent = f;
      ruler.append(tick);
    }
    labels.append(rulerLabel);
    tracks.append(ruler);
    // Anim layers (applied last) on top, then tracks from the highest down.
    const keyLayers = [...this.layers.keys()].filter((i) => this.layers[i]?.kind === 'keys').reverse();
    for (const i of keyLayers) {
      const l = this.layers[i];
      const label = document.createElement('button');
      label.type = 'button';
      label.className = `tl-label keys${i === this.active ? ' active' : ''}${l.enabled ? '' : ' disabled'}${l.muted ? ' muted' : ''}`;
      label.textContent = `◆ ${l.name}${l.bound ? ' ⛓' : ''}`;
      label.title = 'Anim layer (keyframes) — click to edit it in the attribute editor';
      label.addEventListener('click', () => this.cb.select(i));
      const track = document.createElement('div');
      track.className = `tl-track keys-row${i === this.active ? ' active' : ''}`;
      track.append(this.bar(i));
      const sel = this.keySel.i === i ? this.keySel.frames : new Set();
      for (const f of l.keyFrames ?? []) {
        const tick = document.createElement('div');
        tick.className = `tl-key${sel.has(f) ? ' selected' : ''}`;
        tick.dataset.layer = i;
        tick.dataset.frame = f;
        tick.style.left = this.pct(this.keyTime(i, f));
        tick.title = `key at frame ${f}${l.bound ? ' of the clip' : ''} · click: select (Shift: add) · drag: move · Delete: remove`;
        track.append(tick);
      }
      labels.append(label);
      tracks.append(track);
    }
    for (let tr = this.trackCount - 1; tr >= 0; tr--) {
      const label = document.createElement('div');
      label.className = 'tl-label track';
      label.textContent = `Track ${tr + 1}`;
      label.title = 'Clips on a track play in sequence and cross-fade where they overlap; higher tracks apply over lower ones';
      const track = document.createElement('div');
      track.className = 'tl-track clip-track';
      track.dataset.track = tr;
      for (const [i, l] of this.layers.entries())
        if (l && l.kind !== 'keys' && (l.track ?? 0) === tr) track.append(this.bar(i));
      labels.append(label);
      tracks.append(track);
    }
    if (this.contacts) {
      for (const foot of ['left', 'right']) {
        const label = document.createElement('div');
        label.className = 'tl-label foot';
        label.textContent = `${foot === 'left' ? 'Left' : 'Right'} foot contacts`;
        const track = document.createElement('div');
        track.className = `tl-track foot ${foot}`;
        for (const ct of this.contacts.filter((x) => x.foot === foot)) {
          const b = document.createElement('div');
          b.className = 'tl-contact';
          b.style.left = this.pct(ct.start);
          b.style.width = this.pct(Math.max(ct.end - ct.start, 0.01));
          track.append(b);
        }
        labels.append(label);
        tracks.append(track);
      }
    }
    if (this.range) { // dim what is outside the playback range
      const [a, b] = this.range;
      for (const [l, w] of [[0, a], [b, this.duration - b]]) {
        if (!(w > 1e-6)) continue;
        const shade = document.createElement('div');
        shade.className = 'tl-out-range';
        shade.style.left = this.pct(l);
        shade.style.width = this.pct(w);
        tracks.append(shade);
      }
    }
    tracks.append(this.playhead);
    c.append(labels, tracks);
    this.update(this.time ?? 0);
  }

  bar(i) {
    const l = this.layers[i], t = this.timingOf(i), eff = { ...t, ...(l.eff ?? {}) };
    const [s, e] = this.extent(i);
    const bar = document.createElement('div');
    bar.className = `tl-bar${l.kind === 'keys' ? ' keys' : ''}${i === this.active ? ' selected' : ''}${l.enabled ? '' : ' disabled'}${l.muted ? ' muted' : ''}`;
    bar.dataset.layer = i;
    bar.style.left = this.pct(s);
    bar.style.width = this.pct(Math.max(e - s, 1 / this.fps));
    bar.title = `${l.name}: ${s.toFixed(2)}–${e.toFixed(2)} s · ${t.speed.toFixed(2)}× · ${t.repeat} cycle(s)` +
      ' · drag: move (also to another track) · edges: trim · Ctrl + drag / Ctrl + wheel: stretch';
    for (let k = 1; k < t.repeat; k++) {
      const sep = document.createElement('div');
      sep.className = 'tl-cycle';
      sep.style.left = `${(k / t.repeat) * 100}%`;
      bar.append(sep);
    }
    for (const [side, len] of [['in', eff.fade_in], ['out', eff.fade_out]]) {
      if (!(len > 0)) continue;
      const f = document.createElement('div');
      f.className = `tl-fade ${side}`;
      f.style.width = `${Math.min(100, (len / Math.max(e - s, 1e-3)) * 100)}%`;
      f.title = side === 'in' ? `blend in ${len.toFixed(2)} s` : `blend out ${len.toFixed(2)} s`;
      bar.append(f);
    }
    const name = document.createElement('span');
    name.className = 'tl-name';
    name.textContent = l.name;
    const tag = document.createElement('span');
    tag.className = 'tl-tag';
    tag.textContent = [t.speed !== 1 ? `${+t.speed.toFixed(2)}×` : '', t.repeat > 1 ? `↻${t.repeat}` : '', t.align_root ? '⇢' : ''].filter(Boolean).join(' ');
    bar.append(name, tag);
    return bar;
  }

  toolbar() {
    const bar = document.createElement('div');
    bar.className = 'tl-toolbar';
    const btn = (text, title, fn, disabled = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-button';
      b.textContent = text;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener('click', fn);
      return b;
    };
    const strong = document.createElement('strong');
    strong.textContent = 'Story';
    const activeIsClip = this.layers[this.active]?.kind !== 'keys';
    bar.append(strong,
      btn('+ Clip', 'Add a clip on the selected clip\'s track, after its last clip (same source)', () => this.cb.addClip()),
      btn('+ Track', 'Add a track above with a new clip at the playhead', () => this.cb.addTrack()),
      btn('Split', 'Split the selected clip at the playhead', () => this.cb.split(), !activeIsClip),
      btn('Duplicate', 'Duplicate the selected clip right after itself (root aligned)', () => this.cb.duplicate(), !activeIsClip),
      btn('Delete', 'Delete the selected clip or anim layer', () => this.cb.remove(this.active)));
    const hint = document.createElement('span');
    hint.className = 'muted small';
    hint.textContent = 'Drag: move · edges: trim · Ctrl+drag / Ctrl+wheel: stretch · overlaps cross-fade';
    bar.append(hint);
    return bar;
  }

  // ---- pointer interaction --------------------------------------------------------------
  timeAt(e) {
    const r = this.tracksEl.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * this.duration;
  }
  snap(t, e) { return e.shiftKey ? t : Math.round(t * this.fps) / this.fps; }
  trackAt(e) {
    const row = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.classList?.contains('clip-track'));
    return row ? Number(row.dataset.track) : null;
  }

  down(e) {
    if (this.tracksEl && e.target.closest('.tl-playhead-handle')) { // grab the playhead: scrub
      this.container.setPointerCapture(e.pointerId);
      this.drag = { seek: true };
      this.container.classList.add('scrubbing');
      return;
    }
    if (!this.tracksEl || !e.target.closest('.tl-track')) return;
    if (e.target.closest('.tl-ruler')) this.container.classList.add('scrubbing');
    const tick = e.target.closest('.tl-key');
    if (tick) {
      this.container.setPointerCapture(e.pointerId);
      const i = Number(tick.dataset.layer), f = Number(tick.dataset.frame);
      if (this.keySel.i !== i) this.keySel = { i, frames: new Set() };
      const frames = this.keySel.frames;
      if (e.shiftKey) { if (frames.has(f)) frames.delete(f); else frames.add(f); }
      else if (!frames.has(f)) { frames.clear(); frames.add(f); }
      if (i !== this.active) this.cb.select(i);
      this.cb.seek(this.keyTime(i, f));
      this.drag = { keys: true, i, f, t0: this.timeAt(e), delta: 0 };
      this.render();
      return;
    }
    const bar = e.target.closest('.tl-bar');
    if (!e.shiftKey && this.keySel.frames.size) { this.keySel = { i: -1, frames: new Set() }; this.render(); }
    this.container.setPointerCapture(e.pointerId);
    if (!bar) {
      this.drag = { seek: true };
      this.cb.seek(this.timeAt(e));
      return;
    }
    const i = Number(bar.dataset.layer);
    const r = bar.getBoundingClientRect();
    let zone = e.clientX - r.left < EDGE ? 'left' : r.right - e.clientX < EDGE ? 'right' : 'body';
    const stretch = e.ctrlKey || e.metaKey || e.altKey;
    if (stretch && zone === 'body') zone = 'right';
    if (i !== this.active) this.cb.select(i);
    this.drag = { i, zone, t0: this.timeAt(e), timing: this.timingOf(i), segment: this.segment(i), stretch,
      track: this.layers[i].track ?? 0 };
  }

  wheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const bar = e.target.closest?.('.tl-bar');
    if (!bar) return;
    e.preventDefault(); // not the browser's page zoom
    const i = Number(bar.dataset.layer);
    if (i !== this.active) this.cb.select(i);
    const speed = Math.min(20, Math.max(0.05, this.timingOf(i).speed * Math.exp(-e.deltaY * 0.0015)));
    this.cb.timing(i, { speed }, false);
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => this.cb.timing(i, { speed: this.timingOf(i).speed }, true), 300);
  }

  move(e) {
    if (!this.drag) {
      const bar = e.target.closest?.('.tl-bar');
      if (bar) {
        const r = bar.getBoundingClientRect();
        const edge = e.clientX - r.left < EDGE || r.right - e.clientX < EDGE;
        bar.style.cursor = e.ctrlKey || e.metaKey || e.altKey ? 'col-resize' : edge ? 'ew-resize' : 'grab';
      }
      return;
    }
    const d = this.drag;
    if (d.seek) { this.cb.seek(this.timeAt(e)); return; }
    if (d.keys) { // live preview: shift the selected ticks by whole frames of the layer's time
      d.delta = Math.round((this.timeAt(e) - d.t0) * this.fps * this.timingOf(d.i).speed);
      for (const tick of this.tracksEl.querySelectorAll('.tl-key.selected'))
        tick.style.left = this.pct(this.keyTime(d.i, Number(tick.dataset.frame) + d.delta));
      return;
    }
    const dt = this.timeAt(e) - d.t0;
    const t = d.timing, len = (d.segment / t.speed) * t.repeat;
    const speedFor = (newLen) => Math.min(20, Math.max(0.05, (d.segment * t.repeat) / Math.max(1 / this.fps, newLen)));
    let patch;
    if (d.stretch && d.zone === 'left') {
      const end = t.start + len;
      const speed = speedFor(len - dt);
      patch = { speed, start: end - (d.segment * t.repeat) / speed };
    } else if (d.stretch) {
      patch = { speed: speedFor(len + dt) };
    } else if (d.zone === 'body') {
      patch = { start: this.snap(t.start + dt, e) };
      const tr = this.layers[d.i].kind === 'keys' ? null : this.trackAt(e);
      if (tr !== null && tr !== d.track) patch.track = tr;
    } else if (d.zone === 'left') {
      const clipDt = Math.max(-t.trim_in, Math.min(dt * t.speed, d.segment - 1 / this.fps));
      patch = { trim_in: t.trim_in + clipDt, start: this.snap(t.start + clipDt / t.speed, e) };
    } else {
      const full = this.layers[d.i].duration ?? 0;
      const tin = t.trim_in, tout = t.trim_out > tin ? t.trim_out : full;
      const nextOut = Math.min(full, Math.max(tin + 1 / this.fps, tout + (dt * t.speed) / t.repeat));
      patch = { trim_out: nextOut >= full - 1e-4 ? 0 : nextOut };
    }
    d.patch = patch;
    this.cb.timing(d.i, patch, false);
  }

  up() {
    const d = this.drag;
    this.drag = null;
    this.container.classList.remove('scrubbing');
    if (d?.keys) {
      if (d.delta) {
        const frames = [...this.keySel.frames];
        this.keySel = { i: d.i, frames: new Set(frames.map((f) => Math.max(0, f + d.delta))) };
        this.cb.moveKeys?.(d.i, frames, d.delta);
        this.cb.seek(this.keyTime(d.i, Math.max(0, d.f + d.delta))); // the playhead follows the dragged key
      }
      return;
    }
    if (d?.patch) this.cb.timing(d.i, d.patch, true);
  }

  update(time) {
    this.time = time;
    const u = this.duration > 0 ? Math.min(1, Math.max(0, time / this.duration)) : 0;
    this.playhead.style.left = `${u * 100}%`;
  }
}
