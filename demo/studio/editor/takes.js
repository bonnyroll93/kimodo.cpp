// Takes (MotionBuilder-style): the scene holds several takes, each with its own timeline and
// montage: clips and anim layers on their tracks, groups and retiming, the control rig's
// animation, the scene length / animation start, the root-motion scope and the playback
// range. The character, the retargeting and the foot locking are shared by all takes.
// The take bar (Story toolbar) switches take, adds an empty one, duplicates, renames or
// deletes the current one. Export: the current take, or every take (one file each, one file
// with a take per animation, or all takes in sequence: export-panel.js, /api/export/takes).
const FIELDS = ['layers', 'active', 'groups', 'sceneLength', 'animStart', 'rootScope', 'sceneRoot', 'controlRig'];
const newId = () => Math.random().toString(36).slice(2, 10);

export class Takes {
  constructor({ motionPanel, player, status, history, onSwitch }) {
    Object.assign(this, { motionPanel, player, status, history, onSwitch });
    this.takes = [{ id: newId(), name: 'Take 001', state: null }]; // state: null for the current take
    this.current = 0;
  }

  // The motion panel's take state (the live objects: layers keep their cached durations).
  capture() {
    const mp = this.motionPanel, s = {};
    for (const k of FIELDS) s[k] = mp[k];
    s.range = this.player.range ? [...this.player.range] : null;
    return s;
  }
  apply(s) {
    const mp = this.motionPanel;
    for (const k of FIELDS) if (k in s) mp[k] = s[k];
    mp.groups ??= [];
    mp.multi = new Set();
    mp.groupFocus = null;
    this.player.setRange(s.range ?? null);
  }
  stateOf(k) { return k === this.current ? this.capture() : this.takes[k].state; }

  // Run fn with take k's state in the motion panel (nothing is rendered or scheduled).
  withTake(k, fn) {
    if (k === this.current) return fn();
    const keep = this.capture(), mp = this.motionPanel;
    this.apply(this.takes[k].state);
    try { return fn(); } finally {
      for (const f of FIELDS) mp[f] = keep[f];
      this.player.setRange(keep.range);
    }
  }

  switchTo(k) {
    if (k === this.current || !this.takes[k]) return;
    this.takes[this.current].state = this.capture();
    this.current = k;
    this.apply(this.takes[k].state);
    this.takes[k].state = null;
    this.reload();
    this.status(`${this.takes[k].name} (${k + 1} / ${this.takes.length})`);
  }

  // The take now in the motion panel: re-render and re-bake it.
  reload() {
    const mp = this.motionPanel;
    mp.select(Math.min(mp.active ?? 0, mp.layers.length - 1));
    mp.renderLayers();
    mp.schedule();
    this.history?.reset();
    this.onSwitch?.();
  }

  // A new take: empty (one clip without a motion: pick its source) or a copy of the current.
  add(copy) {
    const name = copy ? `${this.takes[this.current].name} copy` : `Take ${String(this.takes.length + 1).padStart(3, '0')}`;
    let state;
    if (copy) {
      const s = this.capture();
      state = structuredClone({ ...s, layers: s.layers.map(({ customMaskFrom, ...l }) => l) });
      const ids = new Map();
      for (const l of state.layers) { const id = newId(); ids.set(l.id, id); l.id = id; } // new identities
      for (const l of state.layers) if (l.bind) l.bind = ids.get(l.bind) ?? null;
      for (const g of state.groups ?? []) { g.id = newId(); g.members = g.members.map((m) => ids.get(m)).filter(Boolean); }
    } else {
      state = this.motionPanel.emptyTakeState();
    }
    this.takes.splice(this.current + 1, 0, { id: newId(), name, state });
    this.switchTo(this.current + 1);
  }

  rename(name) {
    const n = String(name ?? '').trim().slice(0, 60);
    if (n) this.takes[this.current].name = n;
    this.onSwitch?.();
  }

  remove() {
    if (this.takes.length < 2) { this.status('A scene keeps at least one take', true); return; }
    const k = this.current;
    this.takes.splice(k, 1);
    this.current = Math.min(k, this.takes.length - 1);
    this.apply(this.takes[this.current].state);
    this.takes[this.current].state = null;
    this.reload();
  }

  // Take bar for the Story toolbar.
  bar() {
    const wrap = document.createElement('span');
    wrap.className = 'take-bar';
    const label = document.createElement('span');
    label.className = 'take-label';
    label.textContent = 'Take';
    const sel = document.createElement('select');
    sel.title = 'Take: each has its own timeline (clips, layers, retiming, rig animation, length)';
    this.takes.forEach((t, k) => sel.append(new Option(`${k + 1}. ${t.name}`, k)));
    sel.value = this.current;
    sel.addEventListener('change', () => this.switchTo(Number(sel.value)));
    const btn = (text, title, fn) => {
      const b = document.createElement('button');
      Object.assign(b, { type: 'button', className: 'icon-button', textContent: text, title });
      b.addEventListener('click', fn);
      return b;
    };
    wrap.append(label, sel,
      btn('+', 'New empty take (one clip: pick its motion source)', () => this.add(false)),
      btn('⧉', 'Duplicate this take', () => this.add(true)),
      btn('✎', 'Rename this take', () => {
        const input = document.createElement('input');
        Object.assign(input, { value: this.takes[this.current].name, maxLength: 60, className: 'take-rename' });
        sel.replaceWith(input);
        input.focus();
        input.select();
        const done = () => this.rename(input.value);
        input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = ''; input.blur(); } });
        input.addEventListener('blur', done);
      }),
      btn('✕', 'Delete this take', () => this.remove()));
    return wrap;
  }

  // Scene file: every take (the current one captured now) and which is current.
  serialize(serializeState) {
    return { current: this.current, takes: this.takes.map((t, k) => ({ name: t.name, ...serializeState(this.stateOf(k)) })) };
  }
  load(saved, deserializeState) {
    const list = Array.isArray(saved?.takes) && saved.takes.length ? saved.takes : null;
    if (!list) { this.takes = [{ id: newId(), name: 'Take 001', state: null }]; this.current = 0; return false; }
    this.takes = list.map((t, k) => ({ id: newId(), name: String(t.name || `Take ${k + 1}`), state: deserializeState(t) }));
    this.current = Math.min(Math.max(0, saved.current | 0), this.takes.length - 1);
    this.apply(this.takes[this.current].state);
    this.takes[this.current].state = null;
    return true;
  }
}
