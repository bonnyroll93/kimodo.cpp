// Animation layer list: order, active layer, enable / mute, blend mode, weight, mask,
// additive reference and time wrap. Pure view: state lives in MotionPanel.layers and every
// edit goes through the callbacks.

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
};

export class LayerPanel {
  // callbacks: select(i), change(i, patch), move(i, delta), remove(i), add()
  constructor(container, addButton, callbacks) {
    this.container = container;
    this.cb = callbacks;
    addButton.addEventListener('click', () => this.cb.add());
  }

  render(layers, active) {
    this.container.replaceChildren();
    layers.forEach((l, i) => {
      const row = el('div', { className: `layer${i === active ? ' active' : ''}${l.enabled ? '' : ' disabled'}${l.muted ? ' muted' : ''}${l.kind === 'keys' ? ' keys' : ''}` });
      row.addEventListener('click', (e) => { if (e.target === row || e.target.classList.contains('layer-index')) this.cb.select(i); });

      const enabled = el('input', { type: 'checkbox', checked: l.enabled, title: 'Enabled: off removes the layer from the stack (and from its duration)' });
      enabled.addEventListener('change', () => this.cb.change(i, { enabled: enabled.checked }));
      const name = el('input', { className: 'layer-name', value: l.name, maxLength: 80, title: 'Layer name' });
      name.addEventListener('focus', () => this.cb.select(i));
      name.addEventListener('change', () => this.cb.change(i, { name: name.value.trim() || `Layer ${i + 1}` }));
      const mute = el('button', { type: 'button', className: `icon-button${l.muted ? ' on' : ''}`, textContent: 'M',
        title: 'Mute: keeps the layer on the timeline (and in the duration) but silences it' });
      mute.addEventListener('click', () => this.cb.change(i, { muted: !l.muted }));
      const up = el('button', { type: 'button', className: 'icon-button', textContent: '↑', title: 'Move up (applied later)', disabled: i === layers.length - 1 });
      up.addEventListener('click', () => this.cb.move(i, +1));
      const down = el('button', { type: 'button', className: 'icon-button', textContent: '↓', title: 'Move down (applied earlier)', disabled: i === 0 });
      down.addEventListener('click', () => this.cb.move(i, -1));
      const del = el('button', { type: 'button', className: 'icon-button', textContent: '✕', title: 'Remove layer', disabled: layers.length === 1 });
      del.addEventListener('click', () => this.cb.remove(i));
      const head = el('div', { className: 'layer-head' },
        el('span', { className: 'layer-index', textContent: String(i + 1), title: 'Select layer' }), enabled, name, mute, up, down, del);

      const blend = el('select', { title: 'Blend mode' });
      blend.append(new Option('Override', 'override'), new Option('Additive', 'additive'));
      blend.value = l.blend;
      blend.addEventListener('change', () => this.cb.change(i, { blend: blend.value }));
      if (l.kind === 'keys') { // keyframe layers are additive offsets
        blend.replaceChildren(new Option('Keyframes (additive)', 'additive'));
        blend.disabled = true;
      }
      const weight = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: l.weight, title: 'Weight' });
      const weightText = el('span', { className: 'weight-text', textContent: l.weight.toFixed(2) });
      weight.addEventListener('input', () => { weightText.textContent = Number(weight.value).toFixed(2); });
      weight.addEventListener('change', () => this.cb.change(i, { weight: Number(weight.value) }));
      const mask = el('select', { title: 'Joint mask' });
      mask.append(new Option('Full body', 'full'), new Option('Upper body', 'upper'), new Option('Lower body', 'lower'), new Option('Custom…', 'custom'));
      mask.value = l.mask;
      mask.addEventListener('change', () => this.cb.change(i, { mask: mask.value }));
      const controls = el('div', { className: 'layer-controls' }, blend, weight, weightText, mask);

      const extra = el('div', { className: 'layer-controls' });
      if (l.blend === 'additive' && l.kind !== 'keys') {
        const ref = el('select', { title: 'Additive reference pose' });
        ref.append(new Option('Ref: first frame', 'first'), new Option('Ref: rest pose', 'rest'), new Option('Ref: frame…', 'frame'));
        ref.value = /^\d+$/.test(l.reference) ? 'frame' : l.reference;
        const frame = el('input', { type: 'number', min: 0, step: 1, value: /^\d+$/.test(l.reference) ? l.reference : 0, hidden: ref.value !== 'frame', title: 'Reference frame' });
        ref.addEventListener('change', () => this.cb.change(i, { reference: ref.value === 'frame' ? String(Math.max(0, Math.round(Number(frame.value) || 0))) : ref.value }));
        frame.addEventListener('change', () => this.cb.change(i, { reference: String(Math.max(0, Math.round(Number(frame.value) || 0))) }));
        extra.append(ref, frame);
      }
      const wrap = el('select', { title: 'Outside the clip: hold the last frame or loop' });
      wrap.append(new Option('Hold end', 'clamp'), new Option('Loop', 'loop'));
      wrap.value = l.wrap;
      wrap.addEventListener('change', () => this.cb.change(i, { wrap: wrap.value }));
      extra.append(wrap);
      row.append(head, controls, extra);
      this.container.append(row);
    });
    // Top of the list is the top of the stack (applied last).
    this.container.append(...[...this.container.children].reverse());
  }
}
