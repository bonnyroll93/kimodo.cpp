// Layer timeline as a clip editor (non-linear editing). Each layer is a clip bar placed at
// its start, as long as its trimmed segment / speed x repeat:
//   drag the bar: move it in time · drag the left edge: trim the start · drag the right
//   edge: trim the end (Alt: stretch, i.e. change the speed) · click a label: make the
//   layer active · click/drag empty track space: seek.
// Ctrl (or Alt) + drag stretches / compresses a clip (changes its speed): body or right edge
// keep the start, the left edge keeps the end; Ctrl + wheel over a clip does the same in steps.
// The toolbar edits the active clip: split at the playhead, duplicate after it, speed,
// repeat (cycles continue the root), fades, outside-range behaviour and root alignment.
// Times snap to frames (Shift: free).

const EDGE = 6; // px grab zone for trimming

export class Timeline {
  // cb: select(i), seek(seconds), timing(i, patch, final), split(), duplicate()
  constructor(container, cb) {
    this.container = container;
    this.cb = cb;
    this.duration = 0;
    this.fps = 30;
    this.layers = [];
    this.playhead = document.createElement('div');
    this.playhead.className = 'tl-playhead';
    this.drag = null;
    container.addEventListener('pointerdown', (e) => this.down(e));
    container.addEventListener('pointermove', (e) => this.move(e));
    container.addEventListener('pointerup', () => this.up());
    container.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    // Holding Ctrl / Cmd / Alt shows the stretch cursor on the clips.
    const mod = (e) => this.setStretchCursor(e.ctrlKey || e.metaKey || e.altKey);
    window.addEventListener('keydown', mod);
    window.addEventListener('keyup', mod);
    window.addEventListener('blur', () => this.setStretchCursor(false));
  }

  // layers: [{name, duration (clip seconds), enabled, muted, timing, keyTimes, kind}],
  // duration: stack seconds, active: index, contacts: optional foot contacts in seconds.
  set({ layers, duration, active, contacts = null, fps = 30 }) {
    this.layers = layers;
    this.duration = Math.max(duration, 1e-3);
    this.fps = fps;
    this.active = active;
    this.contacts = contacts;
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
  extent(i) { const t = this.timingOf(i); return [t.start, t.start + (this.segment(i) / t.speed) * t.repeat]; }

  pct(seconds) { return `${(seconds / this.duration) * 100}%`; }

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
    // Top row = top of the stack, like the layer list.
    [...this.layers.keys()].reverse().forEach((i) => {
      const l = this.layers[i];
      const state = `${i === this.active ? ' active' : ''}${l.enabled ? '' : ' disabled'}${l.muted ? ' muted' : ''}`;
      const label = document.createElement('button');
      label.type = 'button';
      label.className = `tl-label${state}`;
      label.textContent = `${i + 1}. ${l.name}${l.muted ? ' (muted)' : ''}${l.enabled ? '' : ' (off)'}`;
      label.title = 'Select layer';
      label.addEventListener('click', () => this.cb.select(i));
      const track = document.createElement('div');
      track.className = `tl-track${state}`;
      const t = this.timingOf(i);
      const [s, e] = this.extent(i);
      const bar = document.createElement('div');
      bar.className = `tl-bar${l.kind === 'keys' ? ' keys' : ''}`;
      bar.dataset.layer = i;
      bar.style.left = this.pct(s);
      bar.style.width = this.pct(Math.max(e - s, 1 / this.fps));
      bar.title = `${l.name}: ${s.toFixed(2)}–${e.toFixed(2)} s · speed ${t.speed.toFixed(2)}× · ${t.repeat} cycle(s)` +
        ' · drag: move · edges: trim · Ctrl + drag or Ctrl + wheel: stretch / compress';
      for (let k = 1; k < t.repeat; k++) {
        const sep = document.createElement('div');
        sep.className = 'tl-cycle';
        sep.style.left = `${(k / t.repeat) * 100}%`;
        bar.append(sep);
      }
      for (const [side, len] of [['in', t.fade_in], ['out', t.fade_out]]) {
        if (!(len > 0)) continue;
        const f = document.createElement('div');
        f.className = `tl-fade ${side}`;
        f.style.width = `${Math.min(100, (len / Math.max(e - s, 1e-3)) * 100)}%`;
        bar.append(f);
      }
      const tag = document.createElement('span');
      tag.className = 'tl-tag';
      tag.textContent = [t.speed !== 1 ? `${+t.speed.toFixed(2)}×` : '', t.repeat > 1 ? `↻${t.repeat}` : '', t.align_root ? '⇢' : ''].filter(Boolean).join(' ');
      bar.append(tag);
      track.append(bar);
      for (const k of l.keyTimes ?? []) { // keys of the selected joint on keyframe layers
        const tick = document.createElement('div');
        tick.className = 'tl-key';
        tick.style.left = this.pct(t.start + k / t.speed);
        track.append(tick);
      }
      labels.append(label);
      tracks.append(track);
    });
    if (this.contacts) {
      for (const foot of ['left', 'right']) {
        const label = document.createElement('div');
        label.className = 'tl-label foot';
        label.textContent = `${foot === 'left' ? 'Left' : 'Right'} foot contacts`;
        const track = document.createElement('div');
        track.className = `tl-track foot ${foot}`;
        for (const ct of this.contacts.filter((x) => x.foot === foot)) {
          const bar = document.createElement('div');
          bar.className = 'tl-contact';
          bar.style.left = this.pct(ct.start);
          bar.style.width = this.pct(Math.max(ct.end - ct.start, 0.01));
          bar.title = `${foot} foot pinned ${ct.start.toFixed(2)}–${ct.end.toFixed(2)} s`;
          track.append(bar);
        }
        labels.append(label);
        tracks.append(track);
      }
    }
    tracks.append(this.playhead);
    c.append(labels, tracks);
    this.update(this.time ?? 0);
  }

  toolbar() {
    const i = this.active, t = this.timingOf(i);
    const bar = document.createElement('div');
    bar.className = 'tl-toolbar';
    const btn = (text, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-button';
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    const field = (label, key, step, min, max, title) => {
      const wrap = document.createElement('label');
      wrap.className = 'tl-field';
      wrap.title = title;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = step;
      input.min = min;
      input.max = max;
      input.value = +(+t[key]).toFixed(3);
      input.addEventListener('change', () => {
        let v = Number(input.value);
        if (!Number.isFinite(v)) return;
        v = Math.min(max, Math.max(min, key === 'repeat' ? Math.round(v) : v));
        this.cb.timing(i, { [key]: v }, true);
      });
      wrap.append(label, input);
      return wrap;
    };
    const strong = document.createElement('strong');
    strong.textContent = `Clip ${i + 1}`;
    const extend = document.createElement('select');
    extend.title = 'Outside its range the clip holds its end poses, or contributes nothing';
    extend.append(new Option('Hold ends', 'hold'), new Option('Empty outside', 'none'));
    extend.value = t.extend;
    extend.addEventListener('change', () => this.cb.timing(i, { extend: extend.value }, true));
    const align = document.createElement('label');
    align.className = 'toggle';
    align.title = 'Start the clip where the layers below put the root (position and facing): sequences continue instead of jumping back';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !!t.align_root;
    check.addEventListener('change', () => this.cb.timing(i, { align_root: check.checked }, true));
    align.append(check, ' Align root');
    bar.append(strong,
      btn('Split', 'Split the active clip at the playhead into two clips', () => this.cb.split()),
      btn('Duplicate', 'Duplicate the active clip right after itself (root aligned)', () => this.cb.duplicate()),
      field('Start', 'start', 1 / this.fps, -3600, 3600, 'Start on the timeline (s)'),
      field('Speed', 'speed', 0.05, 0.05, 20, 'Playback speed: 2 = twice as fast, 0.5 = stretched to twice as long'),
      field('Repeat', 'repeat', 1, 1, 100, 'Cycles of the trimmed segment (the root continues)'),
      field('Fade in', 'fade_in', 0.05, 0, 60, 'Fade-in (s)'),
      field('Fade out', 'fade_out', 0.05, 0, 60, 'Fade-out (s)'),
      extend, align);
    return bar;
  }

  // ---- pointer interaction --------------------------------------------------------------
  timeAt(e) {
    const r = this.tracksEl.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * this.duration;
  }
  snap(t, e) { return e.shiftKey ? t : Math.round(t * this.fps) / this.fps; }

  down(e) {
    if (!this.tracksEl || !e.target.closest('.tl-track')) return;
    const bar = e.target.closest('.tl-bar');
    this.container.setPointerCapture(e.pointerId);
    if (!bar) {
      this.drag = { seek: true };
      this.cb.seek(this.timeAt(e));
      return;
    }
    const i = Number(bar.dataset.layer);
    const r = bar.getBoundingClientRect();
    let zone = e.clientX - r.left < EDGE ? 'left' : r.right - e.clientX < EDGE ? 'right' : 'body';
    // Ctrl (Cmd on macOS) or Alt: stretch / compress instead of moving or trimming. On the
    // body and the right edge the start stays put; on the left edge the end stays put.
    const stretch = e.ctrlKey || e.metaKey || e.altKey;
    if (stretch && zone === 'body') zone = 'right';
    if (i !== this.active) this.cb.select(i);
    this.drag = { i, zone, t0: this.timeAt(e), timing: this.timingOf(i), segment: this.segment(i), stretch };
  }

  // Ctrl + wheel over a clip: compress (wheel up) / stretch (wheel down) around its start.
  wheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const bar = e.target.closest?.('.tl-bar');
    if (!bar) return;
    e.preventDefault(); // not the browser's page zoom
    const i = Number(bar.dataset.layer);
    if (i !== this.active) this.cb.select(i);
    const t = this.timingOf(i);
    const speed = Math.min(20, Math.max(0.05, t.speed * Math.exp(-e.deltaY * 0.0015)));
    this.cb.timing(i, { speed }, false);
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => this.cb.timing(i, { speed: this.timingOf(i).speed }, true), 300);
  }

  setStretchCursor(on) { this.container.classList.toggle('stretching', on); }

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
    const dt = this.timeAt(e) - d.t0;
    const t = d.timing, len = (d.segment / t.speed) * t.repeat;
    const speedFor = (newLen) => Math.min(20, Math.max(0.05, (d.segment * t.repeat) / Math.max(1 / this.fps, newLen)));
    let patch;
    if (d.stretch && d.zone === 'left') {
      // Stretch keeping the end: the start follows the pointer.
      const end = t.start + len;
      const speed = speedFor(len - dt);
      patch = { speed, start: end - (d.segment * t.repeat) / speed };
    } else if (d.stretch) {
      // Stretch keeping the start: the end follows the pointer.
      patch = { speed: speedFor(len + dt) };
    } else if (d.zone === 'body') {
      patch = { start: this.snap(t.start + dt, e) };
    } else if (d.zone === 'left') {
      // Trim the start: the content stays in place, the clip begins later/earlier.
      const clipDt = Math.max(-t.trim_in, Math.min(dt * t.speed, d.segment - 1 / this.fps));
      patch = { trim_in: t.trim_in + clipDt, start: this.snap(t.start + clipDt / t.speed, e) };
    } else {
      // Trim the end (of each cycle).
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
    if (d?.patch) this.cb.timing(d.i, d.patch, true);
  }

  update(time) {
    this.time = time;
    const u = this.duration > 0 ? Math.min(1, Math.max(0, time / this.duration)) : 0;
    this.playhead.style.left = `${u * 100}%`;
  }
}
