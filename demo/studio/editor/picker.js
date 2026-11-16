// Picker (Outliner | Picker tab): a picture of the body to pick joints and rig controls
// without hunting for them in the view, as in ActionForge's Setup › Picker.
//   a circle on a joint: that joint (FK: posed with the anim layers' gizmo)
//   a box by a hand or a foot: its IK control · a diamond by an elbow or a knee: its pole
// Joints are the character's, found through the retarget mapping (source joint names).
//   the bar under the hips: the hips control · the ellipse at the feet: the root control
// The figure faces you: the character's left is on the right of the picture.
// Left hand / Right hand: the hand's finger joints (the character's joints under the hand,
// one column per finger, thumb on the side it is on), seen from the back of the hand.

import { sourceName } from './source-names.js';

const NS = 'http://www.w3.org/2000/svg';
// Source joint -> [x, y] on a 200 x 380 figure.
const SPOTS = {
  Head: [100, 34], Neck1: [100, 66], Chest: [100, 98], Spine2: [100, 122], Spine1: [100, 146], Hips: [100, 180],
  LeftShoulder: [118, 84], LeftArm: [136, 90], LeftForeArm: [150, 134], LeftHand: [160, 176],
  RightShoulder: [82, 84], RightArm: [64, 90], RightForeArm: [50, 134], RightHand: [40, 176],
  LeftLeg: [114, 194], LeftShin: [118, 262], LeftFoot: [120, 330], LeftToeBase: [124, 356],
  RightLeg: [86, 194], RightShin: [82, 262], RightFoot: [80, 330], RightToeBase: [76, 356],
};
const BONES = [['Head', 'Neck1'], ['Neck1', 'Chest'], ['Chest', 'Spine2'], ['Spine2', 'Spine1'], ['Spine1', 'Hips'],
  ['Chest', 'LeftShoulder'], ['LeftShoulder', 'LeftArm'], ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'],
  ['Chest', 'RightShoulder'], ['RightShoulder', 'RightArm'], ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand'],
  ['Hips', 'LeftLeg'], ['LeftLeg', 'LeftShin'], ['LeftShin', 'LeftFoot'], ['LeftFoot', 'LeftToeBase'],
  ['Hips', 'RightLeg'], ['RightLeg', 'RightShin'], ['RightShin', 'RightFoot'], ['RightFoot', 'RightToeBase']];
// Controls: [limb, kind, x, y].
const CONTROLS = [
  ['left_arm', 'ik', 172, 192], ['right_arm', 'ik', 28, 192], ['left_leg', 'ik', 140, 334], ['right_leg', 'ik', 60, 334],
  ['left_arm', 'pole', 170, 124], ['right_arm', 'pole', 30, 124], ['left_leg', 'pole', 132, 246], ['right_leg', 'pole', 68, 246],
];

export class Picker {
  constructor({ host, retarget, rig, getCharacter, selectJoint }) {
    Object.assign(this, { host, retarget, rig, getCharacter, selectJoint });
    this.joint = -1;
    this.view = 'body'; // body | LeftHand | RightHand
  }

  setJoint(i) { this.joint = i; this.render(); }

  el(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  }

  render() {
    const character = this.getCharacter(), mapping = this.retarget.mapping;
    if (!character || !mapping) {
      this.host.innerHTML = '<p class="muted pad">Load a character and a motion (retargeted) to pick its joints and controls.</p>';
      return;
    }
    const bySource = new Map(mapping.joints.map((j) => [j.source, j.target]));
    const key = this.retarget.skeletonKey;
    const index = (src) => character.joints.findIndex((j) => j.name === bySource.get(sourceName(key, src)));
    const bar = document.createElement('div');
    bar.className = 'picker-views';
    for (const [v, text] of [['body', 'Body'], ['RightHand', 'R hand'], ['LeftHand', 'L hand']]) {
      const b = document.createElement('button');
      Object.assign(b, { type: 'button', textContent: text, className: this.view === v ? 'on' : '' });
      b.addEventListener('click', () => { this.view = v; this.render(); });
      bar.append(b);
    }
    if (this.view !== 'body') { this.host.replaceChildren(bar, this.hand(character, index(this.view), this.view === 'LeftHand')); return; }
    const svg = this.el('svg', { viewBox: '0 0 200 380', role: 'img', 'aria-label': 'Body picker' });
    for (const [p, q] of BONES) {
      if (!SPOTS[p] || !SPOTS[q] || index(p) < 0 || index(q) < 0) continue;
      svg.append(this.el('line', { class: 'bone', x1: SPOTS[p][0], y1: SPOTS[p][1], x2: SPOTS[q][0], y2: SPOTS[q][1] }));
    }
    for (const [src, [x, y]] of Object.entries(SPOTS)) {
      const i = index(src);
      if (i < 0) continue;
      const c = this.el('circle', { class: `spot${i === this.joint ? ' picked' : ''}`, cx: x, cy: y, r: src === 'Head' ? 14 : src === 'Hips' ? 9 : 6 });
      const t = this.el('title', {});
      t.textContent = `${character.joints[i].name} (FK)`;
      c.append(t);
      c.addEventListener('click', () => this.selectJoint(i));
      svg.append(c);
    }
    const chains = this.rig.chains() ?? {};
    for (const [limb, kind, x, y] of CONTROLS) {
      if (!chains[limb]) continue;
      const on = this.rig.limb(limb).ik;
      const picked = this.rig.picked?.limb === limb && this.rig.picked.kind === kind;
      const cls = `ctl${on ? '' : ' off'}${picked ? ' picked' : ''}`;
      const shape = kind === 'ik'
        ? this.el('rect', { class: cls, x: x - 9, y: y - 7, width: 18, height: 14, rx: 2 })
        : this.el('polygon', { class: cls, points: `${x},${y - 8} ${x + 7},${y} ${x},${y + 8} ${x - 7},${y}` });
      const t = this.el('title', {});
      const label = limb.replace('_', ' ');
      t.textContent = on ? `${label}: ${kind === 'ik' ? 'IK control' : 'pole'}` : `${label}: IK is off (click to turn it on)`;
      shape.append(t);
      shape.addEventListener('click', () => {
        if (!on) this.rig.setIK(limb, true);
        this.rig.pick({ limb, kind });
      });
      svg.append(shape);
    }
    for (const [kind, shape, tip] of [
      ['hips', this.el('rect', { x: 72, y: 196, width: 56, height: 8, rx: 3 }), 'Hips control (offset of the hips)'],
      ['root', this.el('ellipse', { cx: 100, cy: 368, rx: 46, ry: 7 }), 'Root control (offset of the whole character)'],
    ]) {
      const picked = this.rig.picked?.limb === 'body' && this.rig.picked.kind === kind;
      shape.setAttribute('class', `ctl body${picked ? ' picked' : ''}`);
      const t = this.el('title', {});
      t.textContent = tip;
      shape.append(t);
      shape.addEventListener('click', () => this.rig.pick({ limb: 'body', kind }));
      svg.prepend(shape);
    }
    const lr = this.el('text', { class: 'lbl', x: 150, y: 372 }); lr.textContent = 'L';
    const rl = this.el('text', { class: 'lbl', x: 46, y: 372 }); rl.textContent = 'R';
    svg.append(lr, rl);
    this.host.replaceChildren(bar, svg);
  }

  // Finger joints of a hand: one chain per child of the hand joint, fanned out above the palm.
  hand(character, h, left) {
    const wrap = document.createElement('div');
    if (h < 0) { wrap.innerHTML = '<p class="muted pad">This hand is not in the retarget mapping.</p>'; return wrap; }
    const kids = (i) => character.joints.filter((j) => j.parent === i);
    const chains = kids(h).map((root) => {
      const chain = [root];
      for (let c = kids(root.index); c.length; c = kids(c[0].index)) chain.push(c[0]);
      return chain;
    });
    if (!chains.length) { wrap.innerHTML = `<p class="muted pad">${character.joints[h].name} has no finger joints.</p>`; return wrap; }
    const ORDER = ['thumb', 'index', 'middle', 'ring', 'pinky|little'];
    const rank = (c) => { const n = c[0].name.toLowerCase(); const r = ORDER.findIndex((o) => new RegExp(o).test(n)); return r < 0 ? 2.5 : r; };
    chains.sort((a, b) => rank(a) - rank(b));
    const svg = this.el('svg', { viewBox: '0 0 200 300', role: 'img', 'aria-label': `${left ? 'Left' : 'Right'} hand picker` });
    const palm = [100, 250], n = chains.length;
    // Back of the hand, figure facing you: the left hand's thumb is on the right.
    const side = left ? 1 : -1;
    svg.append(this.el('ellipse', { class: 'palm', cx: palm[0], cy: palm[1] - 18, rx: 42, ry: 34 }));
    const spot = (j, x, y, r) => {
      const c = this.el('circle', { class: `spot${j.index === this.joint ? ' picked' : ''}`, cx: x, cy: y, r });
      const t = this.el('title', {});
      t.textContent = `${j.name} (FK)`;
      c.append(t);
      c.addEventListener('click', () => this.selectJoint(j.index));
      return c;
    };
    chains.forEach((chain, k) => {
      const thumb = rank(chain) === 0 && n > 1;
      const u = n === 1 ? 0 : (k / (n - 1)) * 2 - 1; // -1 (thumb side) .. 1
      const out = -side * u; // > 0: towards the right of the picture
      const tilt = thumb ? side * 1.0 : out * 0.32; // radians from vertical, fanned out
      const base = thumb ? [palm[0] + side * 40, palm[1] - 14] : [palm[0] + out * 30, palm[1] - 50];
      const step = thumb ? 28 : 34;
      const at = (s) => [base[0] + Math.sin(tilt) * step * s, base[1] - Math.cos(tilt) * step * s];
      for (let s = 1; s < chain.length; s++) {
        const [a, b] = [at(s - 1), at(s)];
        svg.append(this.el('line', { class: 'bone', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }));
      }
      chain.forEach((j, s) => svg.append(spot(j, ...at(s), 7)));
    });
    svg.append(spot(character.joints[h], palm[0], palm[1], 11));
    const lbl = this.el('text', { class: 'lbl', x: 100, y: 296 });
    lbl.textContent = `${left ? 'Left' : 'Right'} hand · ${chains.length} finger(s)`;
    lbl.setAttribute('text-anchor', 'middle');
    svg.append(lbl);
    wrap.append(svg);
    return wrap;
  }
}
