// Picker (Outliner | Picker tab): a picture of the body to pick joints and rig controls
// without hunting for them in the view, as in ActionForge's Setup › Picker.
//   a circle on a joint: that joint (FK: posed with the anim layers' gizmo)
//   a box by a hand or a foot: its IK control · a diamond by an elbow or a knee: its pole
// Joints are the character's, found through the retarget mapping (source joint names).
// The figure faces you: the character's left is on the right of the picture.

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
    const index = (src) => character.joints.findIndex((j) => j.name === bySource.get(src));
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
    const lr = this.el('text', { class: 'lbl', x: 150, y: 372 }); lr.textContent = 'L';
    const rl = this.el('text', { class: 'lbl', x: 46, y: 372 }); rl.textContent = 'R';
    svg.append(lr, rl);
    this.host.replaceChildren(svg);
  }
}
