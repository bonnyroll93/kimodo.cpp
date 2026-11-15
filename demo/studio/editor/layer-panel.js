// Rows for anim clips and anim layers: enable / mute, name, blend mode, weight, mask,
// additive reference and time wrap. Used for the anim-layer list (keyframe layers, with
// reordering) and for the single row of the item shown in the attribute editor. Pure view:
// state lives in MotionPanel.layers and every edit goes through the callbacks.
// Anim layers (Maya-style): the members (joints and rig controls; + Sel / − Sel add or remove
// the selected object, − also deletes its keys on the layer) and a keyable weight (◆ keys it
// at the current frame, ✕ deletes that key; once keyed the slider edits the key there).
// The list ends with BaseAnimation: the clips and the rig's own keys (keys go there when it is
// selected).

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
};

export class LayerPanel {
  // callbacks: select(i), change(i, patch), move(i, delta), remove(i), canRemove(i),
  //   weightAt(i), weightKeyed(i) -> 'none' | 'animated' | 'here', setWeight(i, v, final), keyWeight(i), unkeyWeight(i),
  //   members(i) -> [{id, label}], addSelected(i), removeSelected(i), removeMember(i, id), pickMember(id),
  //   selectBase(), baseActive()
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
      if (keys) { // anim layers: offsets added on top, or keyed channels replacing the pose
        blend.replaceChildren(new Option('Additive (offsets)', 'additive'), new Option('Override (replace)', 'override'));
        blend.value = l.blend === 'override' ? 'override' : 'additive';
        blend.title = 'Additive: keys are offsets added to the clips. Override: keyed joints take the keyed pose ' +
          '(only the keyed channels; switching mode reinterprets existing keys)';
      }
      const w0 = keys && this.cb.weightAt ? this.cb.weightAt(i) : l.weight;
      const weight = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: w0, title: 'Weight (animated: the value at this frame)' });
      weight.dataset.weightOf = i;
      const weightText = el('span', { className: 'weight-text', textContent: w0.toFixed(2) });
      if (keys && this.cb.setWeight) {
        weight.addEventListener('input', () => { weightText.textContent = Number(weight.value).toFixed(2); this.cb.setWeight(i, Number(weight.value), false); });
        weight.addEventListener('change', () => this.cb.setWeight(i, Number(weight.value), true));
      } else {
        weight.addEventListener('input', () => { weightText.textContent = Number(weight.value).toFixed(2); });
        weight.addEventListener('change', () => this.cb.change(i, { weight: Number(weight.value) }));
      }
      const mask = el('select', { title: 'Joint mask' });
      mask.append(new Option('Full body', 'full'), new Option('Upper body', 'upper'), new Option('Lower body', 'lower'), new Option('Custom…', 'custom'));
      mask.value = l.mask;
      mask.addEventListener('change', () => this.cb.change(i, { mask: mask.value }));
      const controls = el('div', { className: 'layer-controls' }, blend, weight, weightText);
      if (keys && this.cb.keyWeight) {
        const state = this.cb.weightKeyed(i);
        const kw = el('button', { type: 'button', className: `icon-button weight-key${state === 'here' ? ' on' : state === 'animated' ? ' animated' : ''}`, textContent: '◆',
          title: 'Key the layer weight at the current frame (an animated weight)' });
        kw.dataset.weightKey = i;
        kw.addEventListener('click', () => this.cb.keyWeight(i));
        const uw = el('button', { type: 'button', className: 'icon-button', textContent: '✕', title: 'Delete the weight key at the current frame', hidden: state === 'none' });
        uw.addEventListener('click', () => this.cb.unkeyWeight(i));
        controls.append(kw, uw);
      }
      controls.append(mask);

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
      if (keys && this.cb.members) {
        const members = el('div', { className: 'layer-members' });
        const list = this.cb.members(i);
        members.append(el('span', { className: 'members-label', textContent: list.length ? 'Members' : 'No members yet' }));
        for (const m of list) {
          const chip = el('span', { className: 'member', title: `${m.label}: click to select it` },
            el('span', { textContent: m.label }));
          chip.addEventListener('click', () => this.cb.pickMember(m.id));
          const x = el('button', { type: 'button', className: 'member-x', textContent: '×', title: `Remove ${m.label} from this layer (deletes its keys here)` });
          x.addEventListener('click', (e) => { e.stopPropagation(); this.cb.removeMember(i, m.id); });
          chip.append(x);
          members.append(chip);
        }
        const add = el('button', { type: 'button', className: 'icon-button', textContent: '+ Sel', title: 'Add the selected joint or rig control to this layer' });
        add.addEventListener('click', () => this.cb.addSelected(i));
        const rem = el('button', { type: 'button', className: 'icon-button', textContent: '− Sel', title: 'Remove the selected joint or rig control from this layer (deletes its keys here)' });
        rem.addEventListener('click', () => this.cb.removeSelected(i));
        members.append(add, rem);
        row.append(members);
      }
      this.container.append(row);
    });
    if (this.reorder && this.cb.selectBase) { // BaseAnimation (bottom of the stack)
      const base = el('div', { className: `layer base-layer${this.cb.baseActive() ? ' active' : ''}` },
        el('div', { className: 'layer-head' }, el('span', { className: 'layer-index', textContent: 'B' }),
          el('span', { className: 'base-name', textContent: 'BaseAnimation' }),
          el('span', { className: 'note', textContent: 'clips + rig keys' })));
      base.title = 'The clips and the control rig\'s own keys: select it to key controls on the base';
      base.addEventListener('click', () => this.cb.selectBase());
      this.container.prepend(base);
    }
    // Top of the list is the top of the stack (applied last).
    this.container.append(...[...this.container.children].reverse());
  }

  // Weight sliders follow the current frame (animated weights).
  syncWeights() {
    if (!this.cb.weightAt) return;
    for (const s of this.container.querySelectorAll('input[data-weight-of]')) {
      if (document.activeElement === s) continue;
      const i = Number(s.dataset.weightOf), v = this.cb.weightAt(i);
      s.value = v;
      if (s.nextElementSibling) s.nextElementSibling.textContent = v.toFixed(2);
    }
    for (const b of this.container.querySelectorAll('button[data-weight-key]')) {
      const state = this.cb.weightKeyed(Number(b.dataset.weightKey));
      b.classList.toggle('on', state === 'here');
      b.classList.toggle('animated', state === 'animated');
      if (b.nextElementSibling) b.nextElementSibling.hidden = state === 'none';
    }
  }
}
