// Control rig: IK / FK arms and legs on the character (ActionForge-style "simple" workflow:
// a limb is FK until its IK is turned on, for the whole animation).
//   * IK on: the end joint (hand, foot) follows its box control and the middle joint (elbow,
//     knee) points at its pole (diamond). Controls are keyed in their follow space (Root or
//     Hips) at the current frame; without keys a control follows the animation.
//   * FK: bones are posed with the anim layers' gizmo (Animate › Anim layers, + Keys).
// The rig is sent with every stack (control_rig in /api/layers, /api/export) and solved by
// kmd-anim after the layers (include/kimodo/anim/control_rig.hpp), so preview and export
// match; while a control is dragged the chain is solved here for immediate feedback.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { evaluate, setKey, quatEuler, eulerQuat } from '../viewer/keyframes.js';

export const LIMBS = [
  { id: 'left_arm', label: 'Left arm', src: ['LeftArm', 'LeftForeArm', 'LeftHand'] },
  { id: 'right_arm', label: 'Right arm', src: ['RightArm', 'RightForeArm', 'RightHand'] },
  { id: 'left_leg', label: 'Left leg', src: ['LeftLeg', 'LeftShin', 'LeftFoot'] },
  { id: 'right_leg', label: 'Right leg', src: ['RightLeg', 'RightShin', 'RightFoot'] },
];
const POS = ['tx', 'ty', 'tz'], ROT = ['rx', 'ry', 'rz'];
export const emptyRig = () => ({ limbs: Object.fromEntries(LIMBS.map((l) => [l.id, { ik: false, follow: 'root', weight: 1, target: {}, pole: {} }])) });
const hasKeys = (ch, names) => names.some((c) => ch?.[c]?.length);

export class ControlRig {
  constructor({ $, viewport, player, motionPanel, retarget, status, getCharacter, onPick }) {
    Object.assign(this, { $, viewport, player, motionPanel, retarget, status, getCharacter, onPick });
    this.picked = null; // {limb, kind: 'ik' | 'pole'}
    this.group = new THREE.Group();
    this.group.name = 'control-rig';
    viewport.scene.add(this.group);
    this.controls = new Map(); // `${limb}:${kind}` -> mesh
    this.gizmo = new TransformControls(viewport.camera, viewport.renderer.domElement);
    this.gizmo.setSize(0.7);
    this.gizmo.setSpace('world');
    viewport.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      viewport.controls.enabled = !e.value;
      viewport.gizmoDragging = e.value;
      if (e.value) { player.play(false); this.dragging = true; } else { this.dragging = false; this.dragEnd(); }
    });
    this.gizmo.addEventListener('objectChange', () => this.preview());
    viewport.onFrame.push(() => this.update());
    $('show-controls').addEventListener('change', () => this.update());
    $('rig-move').addEventListener('click', () => this.setMode('translate'));
    $('rig-rotate').addEventListener('click', () => this.setMode('rotate'));
    $('rig-key').addEventListener('click', () => this.keyPicked());
    $('rig-delete-key').addEventListener('click', () => this.deleteKeyAtFrame());
    $('rig-reset').addEventListener('click', () => this.resetLimb());
    window.addEventListener('keydown', (e) => {
      if (!this.picked || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      if (k === 'w') { this.setMode('translate'); e.stopImmediatePropagation(); }
      if (k === 'e' && this.picked.kind === 'ik') { this.setMode('rotate'); e.stopImmediatePropagation(); }
      if (k === 'k') { this.keyPicked(); e.stopImmediatePropagation(); }
      if (k === 'escape') this.pick(null);
    }, true);
    // Controls are picked before joints (joint-selection.js asks this first).
    viewport.pickControls = (raycaster) => this.hit(raycaster);
  }

  get data() { return (this.motionPanel.controlRig ??= emptyRig()); }
  limb(id) { return (this.data.limbs[id] ??= { ik: false, follow: 'root', weight: 1, target: {}, pole: {} }); }

  // Character joints of each limb (via the retarget mapping: source joint -> character joint).
  chains() {
    const character = this.getCharacter();
    if (!character || !this.retarget.enabled || !this.retarget.mapping) return null;
    const bySource = new Map(this.retarget.mapping.joints.map((j) => [j.source, j.target]));
    const joint = (src) => character.joints.find((j) => j.name === bySource.get(src));
    const out = {};
    for (const L of LIMBS) {
      const js = L.src.map(joint);
      if (js.every(Boolean) && js[1].parent === js[0].index && js[2].parent === js[1].index) out[L.id] = js;
    }
    out.hips = joint('Hips') ?? character.joints[0];
    return out;
  }

  // /api/layers "control_rig" (null when no limb has IK on).
  request() {
    const ch = this.chains();
    if (!ch) return null;
    const limbs = [];
    for (const L of LIMBS) {
      const l = this.limb(L.id);
      if (!l.ik || !ch[L.id]) continue;
      limbs.push({ name: L.id, chain: ch[L.id].map((j) => j.name), ik: true, follow: l.follow, weight: l.weight, target: l.target, pole: l.pole });
    }
    return limbs.length ? { version: 1, fps: 30, hips: ch.hips.name, limbs } : null;
  }
  active() { return !!this.request(); }

  // ---- spaces ----------------------------------------------------------------------------
  // Follow space -> world matrix on the frame shown (Root: the character's skeleton space,
  // Hips: the hips' world position and rotation, no scale).
  spaceMatrix(follow, ch) {
    const character = this.getCharacter();
    character.root.updateMatrixWorld(true);
    if (follow !== 'hips') return character.root.matrixWorld.clone();
    const hips = ch.hips.bone;
    return new THREE.Matrix4().compose(hips.getWorldPosition(new THREE.Vector3()), hips.getWorldQuaternion(new THREE.Quaternion()), new THREE.Vector3(1, 1, 1));
  }

  // World transform of a control on the current frame.
  controlWorld(id, kind, ch) {
    const l = this.limb(id), [a, b, c] = ch[id], f = this.player.frame;
    const M = this.spaceMatrix(l.follow, ch);
    const curves = kind === 'ik' ? l.target : l.pole;
    const pos = hasKeys(curves, POS)
      ? new THREE.Vector3(...POS.map((k) => evaluate(curves[k] ?? [], f))).applyMatrix4(M)
      : kind === 'ik' ? c.bone.getWorldPosition(new THREE.Vector3()) : this.defaultPole(a, b, c);
    let rot = c.bone.getWorldQuaternion(new THREE.Quaternion());
    if (kind === 'ik' && hasKeys(curves, ROT)) {
      const mq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(M));
      rot = mq.multiply(eulerQuat(...ROT.map((k) => evaluate(curves[k] ?? [], f))));
    }
    return { pos, rot };
  }

  // Where the elbow / knee points now: out from the shoulder-hand line, one upper-bone away.
  defaultPole(a, b, c) {
    const A = a.bone.getWorldPosition(new THREE.Vector3()), B = b.bone.getWorldPosition(new THREE.Vector3()), C = c.bone.getWorldPosition(new THREE.Vector3());
    const u = C.clone().sub(A).normalize();
    const off = B.clone().sub(A);
    off.sub(u.clone().multiplyScalar(off.dot(u)));
    if (off.lengthSq() < 1e-10) off.set(0, 0, 1);
    return B.clone().add(off.normalize().multiplyScalar(A.distanceTo(B)));
  }

  // ---- drawing ---------------------------------------------------------------------------
  ensureMeshes(size) {
    if (this.size === size) return;
    this.size = size;
    this.group.clear();
    this.controls.clear();
    for (const L of LIMBS) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(size, size, size),
        new THREE.MeshBasicMaterial({ color: 0xffb547, wireframe: true, depthTest: false, transparent: true, opacity: 0.95 }));
      const pole = new THREE.Mesh(new THREE.OctahedronGeometry(size * 0.35),
        new THREE.MeshBasicMaterial({ color: 0xc4b5fd, wireframe: true, depthTest: false, transparent: true, opacity: 0.95 }));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineDashedMaterial({ color: 0xc4b5fd, dashSize: size * 0.2, gapSize: size * 0.15, depthTest: false, transparent: true }));
      for (const [m, kind] of [[box, 'ik'], [pole, 'pole']]) {
        m.renderOrder = 999;
        m.userData = { limb: L.id, kind };
        this.controls.set(`${L.id}:${kind}`, m);
      }
      line.renderOrder = 998;
      line.userData = { limb: L.id, kind: 'line' };
      this.controls.set(`${L.id}:line`, line);
      this.group.add(box, pole, line);
    }
  }

  update() {
    const ch = this.chains();
    const show = !!ch && this.$('show-controls').checked && !this.motionPanel.tposeActive?.();
    this.group.visible = show;
    if (!show) { if (this.picked && !ch) this.pick(null); return; }
    const character = this.getCharacter();
    const box = new THREE.Box3().setFromObject(character.root);
    this.ensureMeshes(Math.max(0.02, (box.max.y - box.min.y) * 0.06));
    for (const L of LIMBS) {
      const on = !!ch[L.id] && this.limb(L.id).ik;
      for (const kind of ['ik', 'pole', 'line']) this.controls.get(`${L.id}:${kind}`).visible = on;
      if (!on) continue;
      const ik = this.controls.get(`${L.id}:ik`), pole = this.controls.get(`${L.id}:pole`), line = this.controls.get(`${L.id}:line`);
      const dragged = this.dragging && this.picked?.limb === L.id;
      if (!(dragged && this.picked.kind === 'ik')) { const w = this.controlWorld(L.id, 'ik', ch); ik.position.copy(w.pos); ik.quaternion.copy(w.rot); }
      if (!(dragged && this.picked.kind === 'pole')) pole.position.copy(this.controlWorld(L.id, 'pole', ch).pos);
      const picked = (k) => this.picked?.limb === L.id && this.picked.kind === k;
      ik.material.color.set(picked('ik') ? 0xffffff : 0xffb547);
      pole.material.color.set(picked('pole') ? 0xffffff : 0xc4b5fd);
      const B = ch[L.id][1].bone.getWorldPosition(new THREE.Vector3());
      line.geometry.setFromPoints([B, pole.position.clone()]);
      line.computeLineDistances();
    }
  }

  hit(raycaster) {
    if (!this.group.visible) return false;
    const meshes = [...this.controls.values()].filter((m) => m.visible && m.userData.kind !== 'line');
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return false;
    this.pick({ limb: hits[0].object.userData.limb, kind: hits[0].object.userData.kind });
    return true;
  }

  // ---- picking / gizmo -------------------------------------------------------------------
  pick(p) {
    this.picked = p;
    this.gizmo.detach();
    if (p) {
      this.update();
      const m = this.controls.get(`${p.limb}:${p.kind}`);
      if (m) this.gizmo.attach(m);
      if (p.kind === 'pole') this.setMode('translate');
    }
    this.renderPanel();
    this.onPick?.(p);
  }

  setMode(mode) {
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(mode === 'rotate' ? 'local' : 'world');
    this.$('rig-move').classList.toggle('on', mode === 'translate');
    this.$('rig-rotate').classList.toggle('on', mode === 'rotate');
  }

  // Live feedback while dragging: solve the chain here on the character's bones.
  preview() {
    if (!this.dragging || !this.picked) return;
    const ch = this.chains();
    if (!ch?.[this.picked.limb]) return;
    const ik = this.controls.get(`${this.picked.limb}:ik`), pole = this.controls.get(`${this.picked.limb}:pole`);
    solveTwoBone(ch[this.picked.limb], ik.position, pole.position, ik.quaternion);
    this.update();
  }

  dragEnd() {
    if (!this.picked) return;
    this.key(this.picked.limb, this.picked.kind);
  }

  // Key a control where it is now, in its follow space, at the current frame.
  key(id, kind) {
    const ch = this.chains();
    if (!ch?.[id]) return;
    const l = this.limb(id), f = this.player.frame;
    const m = this.controls.get(`${id}:${kind}`);
    const inv = this.spaceMatrix(l.follow, ch).invert();
    const p = m.position.clone().applyMatrix4(inv);
    const curves = kind === 'ik' ? l.target : l.pole;
    POS.forEach((k, n) => setKey((curves[k] ??= []), f, p.getComponent(n)));
    if (kind === 'ik') {
      const mq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(inv));
      const near = ROT.map((k) => (curves[k]?.length ? evaluate(curves[k], f) : 0));
      const e = quatEuler(mq.multiply(m.quaternion), near);
      ROT.forEach((k, n) => setKey((curves[k] ??= []), f, e[n]));
    }
    this.status(`Keyed ${LIMBS.find((L) => L.id === id).label} ${kind === 'ik' ? 'IK control' : 'pole'} at frame ${f}`);
    this.changed();
  }

  keyPicked() { if (this.picked) this.key(this.picked.limb, this.picked.kind); }

  deleteKeyAtFrame() {
    if (!this.picked) return;
    const l = this.limb(this.picked.limb), f = this.player.frame;
    const curves = this.picked.kind === 'ik' ? l.target : l.pole;
    for (const k of Object.keys(curves)) curves[k] = curves[k].filter((x) => Math.round(x.f) !== f);
    this.changed();
  }

  resetLimb() {
    const id = this.picked?.limb;
    if (!id) { this.status('Pick a control first (viewport or Picker)', true); return; }
    const l = this.limb(id);
    l.target = {};
    l.pole = {};
    this.status(`${LIMBS.find((L) => L.id === id).label}: IK control and pole follow the animation again`);
    this.changed();
  }

  setIK(id, on) {
    this.limb(id).ik = on;
    if (on) this.pick({ limb: id, kind: 'ik' });
    else if (this.picked?.limb === id) this.pick(null);
    this.changed();
  }

  changed() {
    this.renderPanel();
    this.motionPanel.renderTimeline();
    this.motionPanel.schedule();
  }

  // Frames keyed on the picked control (timeline row).
  pickedKeyFrames() {
    if (!this.picked) return null;
    const l = this.limb(this.picked.limb);
    const curves = this.picked.kind === 'ik' ? l.target : l.pole;
    const set = new Set();
    for (const keys of Object.values(curves)) for (const k of keys) set.add(Math.round(k.f));
    return { label: `${LIMBS.find((L) => L.id === this.picked.limb).label} ${this.picked.kind === 'ik' ? 'IK' : 'pole'}`, frames: [...set].sort((a, b) => a - b) };
  }

  // ---- Animate › Rig panel ---------------------------------------------------------------
  renderPanel() {
    const host = this.$('rig-limbs'), ch = this.chains();
    host.replaceChildren();
    if (!ch) {
      host.innerHTML = '<p class="note">Load a character and retarget a motion onto it to use the control rig.</p>';
      this.$('rig-selected').textContent = '';
      return;
    }
    for (const L of LIMBS) {
      const l = this.limb(L.id);
      const row = document.createElement('div');
      row.className = `rig-limb${this.picked?.limb === L.id ? ' picked' : ''}`;
      const name = document.createElement('span');
      name.textContent = L.label;
      const seg = document.createElement('span');
      seg.className = 'seg';
      for (const [label, on] of [['FK', false], ['IK', true]]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.className = l.ik === on ? 'on' : '';
        b.disabled = !ch[L.id];
        b.title = on ? 'IK for the whole animation: the hand / foot follows its control' : 'FK: the bones are posed directly (anim layers)';
        b.addEventListener('click', () => this.setIK(L.id, on));
        seg.append(b);
      }
      const follow = document.createElement('select');
      follow.title = 'What the IK control and the pole follow';
      follow.append(new Option('follows Root', 'root'), new Option('follows Hips', 'hips'));
      follow.value = l.follow;
      follow.disabled = !l.ik;
      follow.addEventListener('change', () => { l.follow = follow.value; this.status('Follow space changed: existing keys are read in the new space'); this.changed(); });
      const keys = document.createElement('span');
      keys.className = 'keys';
      const nT = new Set(Object.values(l.target).flat().map((k) => Math.round(k.f))).size;
      const nP = new Set(Object.values(l.pole).flat().map((k) => Math.round(k.f))).size;
      keys.textContent = !ch[L.id] ? 'chain not found in the mapping' : l.ik ? `IK control: ${nT ? `${nT} key(s)` : 'follows the animation'} · pole: ${nP ? `${nP} key(s)` : 'follows the animation'}` : 'FK';
      row.addEventListener('click', (e) => { if (e.target === row || e.target === name || e.target === keys) { if (l.ik) this.pick({ limb: L.id, kind: 'ik' }); } });
      row.append(name, seg, follow, keys);
      host.append(row);
    }
    this.$('rig-selected').textContent = this.picked
      ? `Picked: ${LIMBS.find((L) => L.id === this.picked.limb).label} ${this.picked.kind === 'ik' ? 'IK control' : 'pole'}`
      : '';
  }
}

// Two-bone IK on three.js bones (world space): c reaches target, b points at pole, c takes endRot.
export function solveTwoBone([a, b, c], target, pole, endRot) {
  const wp = (o) => o.bone.getWorldPosition(new THREE.Vector3());
  const wq = (o) => o.bone.getWorldQuaternion(new THREE.Quaternion());
  const A = wp(a), B = wp(b), C = wp(c);
  const la = A.distanceTo(B), lb = B.distanceTo(C);
  if (la < 1e-6 || lb < 1e-6) return;
  const at = target.clone().sub(A);
  const d = THREE.MathUtils.clamp(at.length(), Math.abs(la - lb) + 1e-4 * (la + lb), la + lb - 1e-4 * (la + lb));
  let n = new THREE.Vector3().crossVectors(A.clone().sub(B), C.clone().sub(B));
  if (n.lengthSq() < 1e-12) n = new THREE.Vector3().crossVectors(A.clone().sub(B), new THREE.Vector3(0, 0, 1));
  n.normalize();
  const angle = (u, v) => Math.acos(THREE.MathUtils.clamp(u.clone().normalize().dot(v.clone().normalize()), -1, 1));
  const bNow = angle(A.clone().sub(B), C.clone().sub(B));
  const bWant = Math.acos(THREE.MathUtils.clamp((la * la + lb * lb - d * d) / (2 * la * lb), -1, 1));
  const W1 = new THREE.Quaternion().setFromAxisAngle(n, bWant - bNow);
  const C1 = C.clone().sub(B).applyQuaternion(W1).add(B);
  let W2 = new THREE.Quaternion().setFromUnitVectors(C1.clone().sub(A).normalize(), at.clone().normalize());
  if (pole) {
    const u = at.clone().normalize();
    const b2 = B.clone().sub(A).applyQuaternion(W2), pp = pole.clone().sub(A);
    const bp = b2.sub(u.clone().multiplyScalar(b2.dot(u))), ppp = pp.sub(u.clone().multiplyScalar(pp.dot(u)));
    if (bp.lengthSq() > 1e-12 && ppp.lengthSq() > 1e-12) {
      const ang = Math.atan2(new THREE.Vector3().crossVectors(bp, ppp).dot(u), bp.dot(ppp));
      W2 = new THREE.Quaternion().setFromAxisAngle(u, ang).multiply(W2);
    }
  }
  const Ra = W2.clone().multiply(wq(a)), Rb = W2.clone().multiply(W1).multiply(wq(b));
  const setWorld = (o, q) => {
    const parent = o.bone.parent.getWorldQuaternion(new THREE.Quaternion());
    o.bone.quaternion.copy(parent.invert().multiply(q));
    o.bone.updateMatrixWorld(true);
  };
  setWorld(a, Ra);
  setWorld(b, Rb);
  if (endRot) setWorld(c, endRot.clone());
}
