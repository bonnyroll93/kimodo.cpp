// Channel box (Maya-style, top right of the viewport): the transform channels of what is being
// edited, in every mode. The first provider that answers wins:
//   Edit T-pose: the selected bone's rotation from the T-pose (0 = the automatic T-pose)
//   Rig: the picked control (follow space; body controls: their offset)
//   Anim layer: the selected joint's key values (Additive: offset; Override: the pose)
//   otherwise: the selected joint's local transform (read only)
// Type a value (Enter) or drag a channel's name left / right to change it; a change keys
// (or, in Edit T-pose, poses) the object.
// A provider returns null or {id, title, subtitle, channels: [{k, label, value, readOnly}], set(k, v, final)}.
const STEP = { t: 0.002, r: 0.5, s: 0.005 }; // per pixel of label drag
const fmt = (k, v) => (k[0] === 'r' ? v.toFixed(2) : v.toFixed(3));

export class ChannelBox {
  constructor({ host, viewport }) {
    this.host = host;
    this.providers = [];
    this.key = null;
    this.inputs = new Map();
    try { this.collapsed = localStorage.getItem('kimodo-channel-box') === 'collapsed'; } catch { this.collapsed = false; }
    viewport.onFrame.push(() => this.refresh());
  }

  add(provider) { this.providers.push(provider); }

  spec() {
    for (const p of this.providers) {
      const s = p();
      if (s) return s;
    }
    return null;
  }

  refresh() {
    const spec = this.spec();
    this.host.hidden = !spec;
    if (!spec) { this.key = null; return; }
    const key = `${spec.id}|${spec.channels.map((c) => `${c.k}${c.readOnly ? 'r' : ''}`).join(',')}`;
    if (key !== this.key) this.build(spec, key);
    this.current = spec;
    this.title.textContent = spec.title;
    this.sub.textContent = spec.subtitle ?? '';
    for (const c of spec.channels) {
      const input = this.inputs.get(c.k);
      if (!input || document.activeElement === input || this.drag?.k === c.k) continue;
      const s = fmt(c.k, c.value);
      if (input.value !== s) input.value = s;
    }
  }

  build(spec, key) {
    this.key = key;
    this.inputs.clear();
    const head = document.createElement('div');
    head.className = 'cb-head';
    this.title = document.createElement('strong');
    const toggle = document.createElement('button');
    Object.assign(toggle, { type: 'button', className: 'icon-button', textContent: this.collapsed ? '▸' : '▾', title: 'Show / hide the channels' });
    toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      try { localStorage.setItem('kimodo-channel-box', this.collapsed ? 'collapsed' : 'open'); } catch { /* storage unavailable */ }
      this.key = null;
      this.refresh();
    });
    const label = document.createElement('span');
    label.className = 'cb-label';
    label.textContent = 'Channels';
    head.append(label, toggle);
    this.sub = document.createElement('div');
    this.sub.className = 'cb-sub';
    const rows = document.createElement('div');
    rows.className = 'cb-rows';
    rows.hidden = this.collapsed;
    for (const c of spec.channels) {
      const row = document.createElement('div');
      row.className = `cb-row${c.readOnly ? ' ro' : ''}`;
      const name = document.createElement('span');
      name.className = 'cb-name';
      name.textContent = c.label;
      name.title = c.readOnly ? 'Read only here' : 'Drag left / right to change the value';
      const input = document.createElement('input');
      Object.assign(input, { type: 'text', inputMode: 'decimal', spellcheck: false, readOnly: !!c.readOnly });
      input.dataset.k = c.k;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = ''; input.blur(); }
        e.stopPropagation(); // W / E / K are not shortcuts while typing
      });
      input.addEventListener('change', () => {
        const v = Number(input.value.replace(',', '.'));
        if (input.value.trim() === '' || !Number.isFinite(v)) { this.key = null; return; }
        this.current?.set?.(c.k, v, true);
      });
      if (!c.readOnly) this.dragLabel(name, input, c.k);
      row.append(name, input);
      rows.append(row);
      this.inputs.set(c.k, input);
    }
    this.host.replaceChildren(head, this.title, this.sub, rows);
  }

  // Virtual slider: drag a channel's name; live where the provider allows it, set on release.
  dragLabel(name, input, k) {
    name.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      name.setPointerCapture(e.pointerId);
      const start = Number(input.value) || 0;
      this.drag = { k, x: e.clientX, start, v: start };
    });
    name.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.k !== k) return;
      d.v = d.start + (e.clientX - d.x) * STEP[k[0]] * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
      input.value = fmt(k, d.v);
      this.current?.set?.(k, d.v, false);
    });
    const end = () => {
      const d = this.drag;
      if (!d || d.k !== k) return;
      this.drag = null;
      if (d.v !== d.start) this.current?.set?.(k, d.v, true);
    };
    name.addEventListener('pointerup', end);
    name.addEventListener('pointercancel', end);
  }
}

// Channel list helpers.
export const LABELS = { tx: 'Translate X', ty: 'Translate Y', tz: 'Translate Z', rx: 'Rotate X', ry: 'Rotate Y', rz: 'Rotate Z', sx: 'Scale X', sy: 'Scale Y', sz: 'Scale Z' };
export const channels = (values, keys, readOnly = false) => keys.map((k) => ({ k, label: LABELS[k], value: values[k] ?? 0, readOnly }));
