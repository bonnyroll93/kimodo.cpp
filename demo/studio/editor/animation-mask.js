// Custom per-joint mask editor (weights 0..1 by joint name) with JSON save/load.
// Mask JSON: {"version":1,"name":"...","default":0,"weights":{"Joint":1,...}}

export class MaskEditor {
  constructor({ $, status, onChange }) {
    this.$ = $;
    this.status = status;
    this.onChange = onChange; // (mask) => void
    this.mask = null;
    this.joints = [];
    $('mask-all').addEventListener('click', () => this.fill(1));
    $('mask-none').addEventListener('click', () => this.fill(0));
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
        this.onChange(this.mask);
      } catch (err) {
        this.status(`Cannot load mask: ${err.message || err}`, true);
      }
    });
  }

  // joints: [{name, depth}] of the skeleton the stack is evaluated on.
  show(mask, joints) {
    this.joints = joints;
    // A new mask starts as "everything at 1" (default 1), so it is valid even before the
    // joint list is known; edits then store explicit per-joint weights.
    this.mask = mask || { version: 1, name: 'custom', default: 1, weights: {} };
    this.$('mask-editor').hidden = false;
    this.render();
    return this.mask;
  }

  hide() { this.$('mask-editor').hidden = true; }

  weight(name) { return this.mask.weights[name] ?? this.mask.default ?? 0; }

  fill(v) {
    for (const j of this.joints) this.mask.weights[j.name] = v;
    this.render();
    this.onChange(this.mask);
  }

  render() {
    const host = this.$('mask-rows');
    host.replaceChildren();
    const name = this.$('mask-name');
    name.value = this.mask.name;
    name.onchange = () => { this.mask.name = name.value.trim() || 'custom'; this.onChange(this.mask); };
    for (const j of this.joints) {
      const row = document.createElement('label');
      row.className = 'map-row';
      const label = document.createElement('span');
      label.className = 'map-target';
      label.style.paddingLeft = `${Math.min(j.depth, 8) * 6}px`;
      label.textContent = j.name;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = 0;
      input.max = 1;
      input.step = 0.1;
      input.value = this.weight(j.name);
      input.addEventListener('change', () => {
        const v = Math.min(1, Math.max(0, Number(input.value) || 0));
        input.value = v;
        this.mask.weights[j.name] = v;
        this.onChange(this.mask);
      });
      row.append(label, input);
      host.append(row);
    }
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
