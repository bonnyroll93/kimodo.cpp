// Rows for anim clips and anim layers: enable / mute, name, blend mode, weight, mask,
// additive reference and time wrap. Used for the anim-layer list (keyframe layers, with
// reordering) and for the single row of the item shown in the attribute editor. Pure view:
// state lives in MotionPanel.layers and every edit goes through the callbacks.

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
};

export class LayerPanel {
  // callbacks: select(i), change(i, patch), move(i, delta), remove(i), canRemove(i)
  constructor(container, callbacks, { reorder = true, empty = '' } = {}) {
    this.container = container;
    this.cb = callbacks;
    this.reorder = reorder;
    this.empty = empty;
  }

  // items: [{l, i}] (i = index in MotionPanel.layers), bottom of the stack first.
  render(items, active) {
    this.container.replaceChildren();
    if (!items.length && this.empty) {
      this.container.append(el('p', { className: 'note', textContent: this.empty }));
      return;
    }
    items.forEach(({ l, i }, k) => {
      const keys = l.kind === 'keys';
      const noun = keys ? 'anim layer' : 'clip';
      const row = el('div', { className: `layer${i === active ? ' active' : ''}${l.enabled ? '' : ' disabled'}${l.muted ? ' muted' : ''}${keys ? ' keys' : ''}` });
      row.addEventListener('click', (e) => { if (e.target === row || e.target.classList.contains('layer-index')) this.cb.select(i); });

      const enabled = el('input', { type: 'checkbox', checked: l.enabled, title: `Enabled: off removes the ${noun} from the result (and from its duration)` });
      enabled.addEventListener('change', () => this.cb.change(i, { enabled: enabled.checked }));
      const name = el('input', { className: 'layer-name', value: l.name, maxLength: 80, title: `${keys ? 'Anim layer' : 'Clip'} name` });
      name.addEventListener('focus', () => this.cb.select(i));
      name.addEventListener('change', () => this.cb.change(i, { name: name.value.trim() || (keys ? 'Keys' : 'Clip') }));
      const mute = el('button', { type: 'button', className: `icon-button${l.muted ? ' on' : ''}`, textContent: 'M',
        title: `Mute: keeps the ${noun} on the timeline (and in the duration) but silences it` });
      mute.addEventListener('click', () => this.cb.change(i, { muted: !l.muted }));
      const head = el('div', { className: 'layer-head' },
        el('span', { className: 'layer-index', textContent: keys ? 'K' : 'C', title: keys ? 'Anim layer (keyframes)' : 'Anim clip' }), enabled, name, mute);
      if (this.reorder) {
        const up = el('button', { type: 'button', className: 'icon-button', textContent: '↑', title: 'Move up (applied later)', disabled: k === items.length - 1 });
        up.addEventListener('click', () => this.cb.move(i, +1));
        const down = el('button', { type: 'button', className: 'icon-button', textContent: '↓', title: 'Move down (applied earlier)', disabled: k === 0 });
        down.addEventListener('click', () => this.cb.move(i, -1));
        head.append(up, down);
      }
      const del = el('button', { type: 'button', className: 'icon-button', textContent: '✕', title: `Delete this ${noun}`, disabled: !(this.cb.canRemove?.(i) ?? true) });
      del.addEventListener('click', () => this.cb.remove(i));
      head.append(del);

      const blend = el('select', { title: 'Blend mode over what is below (lower tracks / layers)' });
      blend.append(new Option('Override', 'override'), new Option('Additive', 'additive'));
      blend.value = l.blend;
      blend.addEventListener('change', () => this.cb.change(i, { blend: blend.value }));
      if (keys) { // keyframe layers are additive offsets
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
      if (l.blend === 'additive' && !keys) {
        const ref = el('select', { title: 'Additive reference pose' });
        ref.append(new Option('Ref: first frame', 'first'), new Option('Ref: rest pose', 'rest'), new Option('Ref: frame…', 'frame'));
        ref.value = /^\d+$/.test(l.reference) ? 'frame' : l.reference;
        const frame = el('input', { type: 'number', min: 0, step: 1, value: /^\d+$/.test(l.reference) ? l.reference : 0, hidden: ref.value !== 'frame', title: 'Reference frame' });
        ref.addEventListener('change', () => this.cb.change(i, { reference: ref.value === 'frame' ? String(Math.max(0, Math.round(Number(frame.value) || 0))) : ref.value }));
        frame.addEventListener('change', () => this.cb.change(i, { reference: String(Math.max(0, Math.round(Number(frame.value) || 0))) }));
        extra.append(ref, frame);
      }
      const wrap = el('select', { title: 'After its last cycle: hold the last frame or loop forever' });
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
