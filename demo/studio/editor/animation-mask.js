// Per-layer joint mask editor: choose which joints a layer affects.
// Each joint has an include checkbox and a weight (0..1); the subtree button applies the
// same choice to the joint and all its descendants. Starting points: all, none, the
// Upper / Lower presets (computed by kmd-anim, identical to the preset masks) and invert.
// With "Pick joints" on, clicking a joint in the viewport or the hierarchy toggles it
// (Shift: the whole subtree). Mask JSON: {"version":1,"name":..,"default":0,"weights":{..}}

export class MaskEditor {
  // onChange(mask): the mask was edited; onVisual(weightOf | null): recolour the skeleton.
  constructor({ $, status, onChange, onVisual, presets }) {
    this.$ = $;
    this.status = status;
    this.onChange = onChange;
    this.onVisual = onVisual;
    this.presets = presets; // async () => {upper, lower} masks for the current skeleton
    this.mask = null;
    this.joints = [];
    this.rows = new Map();
    this.picking = false;
    $('mask-all').addEventListener('click', () => this.fill(() => 1));
    $('mask-none').addEventListener('click', () => this.fill(() => 0));
    $('mask-invert').addEventListener('click', () => this.fill((n) => 1 - this.weight(n)));
    for (const which of ['upper', 'lower'])
      $(`mask-${which}`).addEventListener('click', async () => {
        try {
          const preset = (await this.presets())[which];
          this.fill((n) => preset.weights[n] ?? preset.default ?? 0);
        } catch (err) {
          this.status(`Cannot load the ${which} preset: ${err.message || err}`, true);
        }
      });
    $('mask-pick').addEventListener('click', () => this.setPicking(!this.picking));
    $('mask-save').addEventListener('click', () => this.download());
    $('mask-load').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const m = JSON.parse(await file.text());
        if (typeof m !== 'object' || m === null || (m.weights && typeof m.weights !== 'object')) throw new Error('not a mask');
        this.mask = { version: 1, name: m.name || file.name.replace(/\.json$/i, ''), default: Number(m.default) || 0, weights: { ...(m.weights || {}) } };
        this.render();
        this.changed();
      } catch (err) {
        this.status(`Cannot load mask: ${err.message || err}`, true);
      }
    });
  }

  get visible() { return !this.$('mask-editor').hidden; }

  // joints: [{name, depth, parent}] of the skeleton the stack is evaluated on.
  show(mask, joints) {
    this.joints = joints;
    // A new mask starts as "everything at 1"; edits store explicit per-joint weights.
    this.mask = mask || { version: 1, name: 'custom', default: 1, weights: {} };
    this.$('mask-editor').hidden = false;
    this.render();
    this.onVisual?.((n) => this.weight(n));
    return this.mask;
  }

  hide() {
    this.$('mask-editor').hidden = true;
    this.setPicking(false);
    this.onVisual?.(null);
  }

  setPicking(on) {
    this.picking = on;
    const b = this.$('mask-pick');
    b.classList.toggle('on', on);
    b.textContent = on ? 'Picking… (click joints)' : 'Pick joints';
    if (on) this.status('Mask: click joints in the viewport or the hierarchy to include/exclude them (Shift: whole subtree)');
  }

  weight(name) { return this.mask?.weights[name] ?? this.mask?.default ?? 0; }

  // Every joint gets an explicit weight, so the mask means the same on any skeleton order.
  fill(fn) {
    for (const j of this.joints) this.mask.weights[j.name] = Math.min(1, Math.max(0, fn(j.name)));
    this.mask.default = 0;
    this.render();
    this.changed();
  }

  descendants(index) {
    const out = [index];
    for (let i = 0; i < this.joints.length; i++)
      for (let p = this.joints[i].parent; p >= 0; p = this.joints[p].parent)
        if (p === index) { out.push(i); break; }
    return out;
  }

  set(indices, w) {
    for (const i of indices) this.mask.weights[this.joints[i].name] = w;
    for (const i of indices) this.updateRow(this.joints[i].name);
    this.changed();
  }

  // Toggle a joint (or its subtree) by name: excluded -> 1, included -> 0.
  toggleJoint(name, subtree = false) {
    const i = this.joints.findIndex((j) => j.name === name);
    if (i < 0) return;
    const w = this.weight(name) > 0 ? 0 : 1;
    this.set(subtree ? this.descendants(i) : [i], w);
    this.highlight(name);
  }

  highlight(name) {
    for (const [n, row] of this.rows) row.el.classList.toggle('highlight', n === name);
    this.rows.get(name)?.el.scrollIntoView({ block: 'nearest' });
  }

  changed() {
    this.updateSummary();
    this.onChange(this.mask);
    this.onVisual?.((n) => this.weight(n));
  }

  updateSummary() {
    const included = this.joints.filter((j) => this.weight(j.name) > 0).length;
    this.$('mask-summary').textContent = `${included} / ${this.joints.length} joints included`;
  }

  updateRow(name) {
    const row = this.rows.get(name);
    if (!row) return;
    const w = this.weight(name);
    row.check.checked = w > 0;
    row.check.indeterminate = w > 0 && w < 1;
    row.input.value = Math.round(w * 100) / 100;
    row.el.classList.toggle('excluded', w <= 0);
  }

  render() {
    const host = this.$('mask-rows');
    host.replaceChildren();
    this.rows.clear();
    const name = this.$('mask-name');
    name.value = this.mask.name;
    name.onchange = () => { this.mask.name = name.value.trim() || 'custom'; this.onChange(this.mask); };
    this.joints.forEach((j, i) => {
      const el = document.createElement('div');
      el.className = 'mask-row';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.title = 'Include this joint';
      check.addEventListener('change', () => this.set([i], check.checked ? 1 : 0));
      const label = document.createElement('span');
      label.className = 'map-target';
      label.style.paddingLeft = `${Math.min(j.depth, 10) * 6}px`;
      label.textContent = j.name;
      label.title = j.name;
      label.addEventListener('click', () => this.set([i], this.weight(j.name) > 0 ? 0 : 1));
      const sub = document.createElement('button');
      sub.type = 'button';
      sub.className = 'icon-button';
      sub.textContent = '⤵';
      sub.title = 'Apply to this joint and everything below it';
      sub.disabled = this.descendants(i).length === 1;
      sub.addEventListener('click', () => this.set(this.descendants(i), this.weight(j.name) > 0 ? 0 : 1));
      const input = document.createElement('input');
      input.type = 'number';
      input.min = 0;
      input.max = 1;
      input.step = 0.1;
      input.title = 'Weight (0 = excluded, 1 = full)';
      input.addEventListener('change', () => {
        const v = Math.min(1, Math.max(0, Number(input.value) || 0));
        this.mask.weights[j.name] = v;
        this.updateRow(j.name);
        this.changed();
      });
      el.append(check, label, sub, input);
      host.append(el);
      this.rows.set(j.name, { el, check, input });
      this.updateRow(j.name);
    });
    this.updateSummary();
  }

  download() {
    if (!this.mask) return;
    const blob = new Blob([JSON.stringify(this.mask, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.mask.name || 'mask'}.mask.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
