// Control rig: IK / FK arms and legs on the character. ActionForge's "simple" workflow: a limb
// is FK until its IK is turned on, for the whole animation; "complex" workflow: the IK/FK blend
// slider of a limb (keyable, 1 = IK, 0 = FK) mixes both, with Match IK to FK / FK to IK snaps.
//   * IK on: the end joint (hand, foot) follows its box control and the middle joint (elbow,
//     knee) points at its pole (diamond). Controls are keyed in their follow space (Root or
//     Hips) at the current frame; without keys a control follows the animation.
//   * FK: bones are posed with the anim layers' gizmo (Animate › Anim layers, + Keys).
//   * Transform: the picked control's values in its follow space; typing one keys it.
//   * Changing a limb's follow space converts its keys (the control stays where it was on
//     every keyed frame).
// The rig is sent with every stack (control_rig in /api/layers, /api/export) and solved by
// kmd-anim after the layers (include/kimodo/anim/control_rig.hpp), so preview and export
// match; while a control is dragged the chain is solved here for immediate feedback.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { evaluate, setKey, quatEuler, eulerQuat, offsetAt, channelsOf, CHANNELS } from '../viewer/keyframes.js';
import { skeletonLocal } from '../viewer/model-loader.js';

export const LIMBS = [
  { id: 'left_arm', label: 'Left arm', src: ['LeftArm', 'LeftForeArm', 'LeftHand'] },
  { id: 'right_arm', label: 'Right arm', src: ['RightArm', 'RightForeArm', 'RightHand'] },
  { id: 'left_leg', label: 'Left leg', src: ['LeftLeg', 'LeftShin', 'LeftFoot'] },
  { id: 'right_leg', label: 'Right leg', src: ['RightLeg', 'RightShin', 'RightFoot'] },
];
const POS = ['tx', 'ty', 'tz'], ROT = ['rx', 'ry', 'rz'];
export const emptyRig = () => ({ limbs: Object.fromEntries(LIMBS.map((l) => [l.id, { ik: false, follow: 'root', weight: 1, target: {}, pole: {} }])) });
const hasKeys = (ch, names) => names.some((c) => ch?.[c]?.length);
const keyedFrames = (curves, names) => [...new Set(names.flatMap((c) => (curves?.[c] ?? []).map((k) => Math.round(k.f))))].sort((a, b) => a - b);

async function f32(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Float32Array(await r.arrayBuffer());
}

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
    $('rig-match-ik').addEventListener('click', () => this.matchIKtoFK());
    $('rig-match-fk').addEventListener('click', () => this.matchFKtoIK());
    player.onChange(() => this.syncValues());
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
      limbs.push({ name: L.id, chain: ch[L.id].map((j) => j.name), ik: true, follow: l.follow, weight: l.weight, target: l.target, pole: l.pole,
        ...(l.blend?.length ? { blend: l.blend } : {}) });
    }
    return limbs.length ? { version: 1, fps: 30, hips: ch.hips.name, limbs } : null;
  }
  active() { return !!this.request(); }
  // IK/FK blend of a limb on a frame (the keyed curve, else its weight).
  blendAt(l, f = this.player.frame) { return l.blend?.length ? THREE.MathUtils.clamp(evaluate(l.blend, f), 0, 1) : l.weight ?? 1; }
  label(id, kind) { return `${LIMBS.find((L) => L.id === id).label}${kind ? ` ${kind === 'ik' ? 'IK control' : 'pole'}` : ''}`; }

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
  controlWorld(id, kind, ch, f = this.player.frame, follow = this.limb(id).follow) {
    const l = this.limb(id), [a, b, c] = ch[id];
    const M = this.spaceMatrix(follow, ch);
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
    const l = this.limb(this.picked.limb), m = this.controls.get(`${this.picked.limb}:${this.picked.kind}`);
    const v = this.spaceValues(l, this.picked.kind, m.position, m.quaternion, ch, this.player.frame);
    for (const input of this.$('rig-xform').querySelectorAll('input[data-c]')) {
      const k = input.dataset.c;
      input.value = (k.startsWith('t') ? v[k].toFixed(3) : v[k].toFixed(1));
    }
  }

  dragEnd() {
    if (!this.picked) return;
    this.key(this.picked.limb, this.picked.kind);
  }

  // Key a control where it is now, in its follow space, at the current frame.
  key(id, kind, quiet = false) {
    const ch = this.chains();
    if (!ch?.[id]) return;
    const l = this.limb(id), f = this.player.frame;
    const m = this.controls.get(`${id}:${kind}`);
    const v = this.spaceValues(l, kind, m.position, m.quaternion, ch, f);
    const curves = kind === 'ik' ? l.target : l.pole;
    for (const k of kind === 'ik' ? [...POS, ...ROT] : POS) setKey((curves[k] ??= []), f, v[k]);
    if (!quiet) this.status(`Keyed ${this.label(id, kind)} at frame ${f}`);
    this.changed();
  }

  // World position / rotation -> {tx..rz} in the limb's follow space (rotation: Euler near the keys).
  spaceValues(l, kind, pos, rot, ch, f, follow = l.follow, near = null) {
    const inv = this.spaceMatrix(follow, ch).invert();
    const p = pos.clone().applyMatrix4(inv);
    const out = { tx: p.x, ty: p.y, tz: p.z };
    if (kind === 'ik') {
      const curves = l.target;
      const mq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(inv));
      const e = quatEuler(mq.multiply(rot), near ?? ROT.map((k) => (curves[k]?.length ? evaluate(curves[k], f) : 0)));
      ROT.forEach((k, n) => { out[k] = e[n]; });
    }
    return out;
  }

  // {tx..rz} in the follow space -> the control mesh (world).
  placeControl(id, kind, v, ch) {
    const M = this.spaceMatrix(this.limb(id).follow, ch), m = this.controls.get(`${id}:${kind}`);
    m.position.set(v.tx, v.ty, v.tz).applyMatrix4(M);
    if (kind === 'ik') {
      const mq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(M));
      m.quaternion.copy(mq.multiply(eulerQuat(v.rx, v.ry, v.rz)));
    }
  }

  // ---- follow space conversion -----------------------------------------------------------
  // Re-key a limb's controls in another follow space: on every keyed frame the control stays
  // where it was (between keys it now interpolates in the new space).
  setFollow(id, follow) {
    const ch = this.chains(), l = this.limb(id);
    if (l.follow === follow) return;
    if (!ch?.[id]) { l.follow = follow; this.changed(); return; }
    const f0 = this.player.frame, out = [];
    for (const kind of ['ik', 'pole']) {
      const curves = kind === 'ik' ? l.target : l.pole;
      for (const names of kind === 'ik' ? [POS, ROT] : [POS]) {
        let near = null;
        for (const f of keyedFrames(curves, names)) {
          this.player.setFrame(f); // the follow space (hips) on that frame
          const w = this.controlWorld(id, kind, ch, f);
          const v = this.spaceValues(l, kind, w.pos, w.rot, ch, f, follow, near);
          if (names === ROT) near = ROT.map((k) => v[k]);
          out.push({ curves, names, f, v });
        }
      }
    }
    for (const { curves, names } of out) for (const k of names) curves[k] = [];
    for (const { curves, names, f, v } of out) for (const k of names) setKey(curves[k], f, v[k]);
    for (const curves of [l.target, l.pole]) for (const k of Object.keys(curves)) if (!curves[k].length) delete curves[k];
    l.follow = follow;
    this.player.setFrame(f0);
    this.status(`${this.label(id)}: controls now follow ${follow === 'hips' ? 'the hips' : 'the root'} (${new Set(out.map((o) => o.f)).size} keyed frame(s) converted)`);
    this.changed();
  }

  // ---- IK <-> FK snaps -------------------------------------------------------------------
  // The character's pose without the control rig (the stack as FK), as target arrays.
  async fkArrays() {
    const mp = this.motionPanel, body = mp.stackBody();
    delete body.control_rig;
    const rt = await this.retarget.request(), fl = mp.footLockRequest();
    const req = JSON.stringify({ ...body, ...(rt || {}), ...(fl ? { foot_lock: fl } : {}) });
    if (this.fkCache?.req === req) return this.fkCache.arrays;
    const r = await fetch('/api/layers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: req });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
    const [rotations, translations] = await Promise.all([f32(json.rotations), f32(json.translations)]);
    const arrays = { rotations, translations };
    this.fkCache = { req, arrays };
    return arrays;
  }

  // Run fn with the character showing the FK pose of the current frame.
  withFK(arrays, fn) {
    const t = this.player.target;
    if (!t || arrays.rotations.length !== t.rotations.length) throw new Error('the FK pose does not match the shown animation (wait for it to update)');
    const keep = [t.rotations, t.translations];
    t.rotations = arrays.rotations;
    t.translations = arrays.translations;
    this.player.applyTarget(this.player.frame);
    try { return fn(); } finally {
      [t.rotations, t.translations] = keep;
      this.player.applyTarget(this.player.frame);
    }
  }

  pickedLimb() {
    const id = this.picked?.limb;
    if (!id) this.status('Pick a control first (viewport or Picker)', true);
    return id ?? null;
  }

  // Match IK to FK: key the IK control and the pole where the FK (animated) hand / foot and
  // elbow / knee are on this frame, so switching to IK does not move the limb.
  async matchIKtoFK() {
    const id = this.pickedLimb(), ch = this.chains();
    if (!id || !ch?.[id]) return;
    this.player.play(false);
    try {
      const arrays = await this.fkArrays();
      this.withFK(arrays, () => {
        const [a, b, c] = ch[id];
        this.placeWorld(id, 'ik', c.bone.getWorldPosition(new THREE.Vector3()), c.bone.getWorldQuaternion(new THREE.Quaternion()));
        this.placeWorld(id, 'pole', this.defaultPole(a, b, c));
        this.key(id, 'ik', true);
        this.key(id, 'pole', true);
      });
      this.status(`${this.label(id)}: IK control and pole matched to the FK pose at frame ${this.player.frame}`);
    } catch (err) { this.status(`Match IK to FK failed: ${err.message || err}`, true); }
  }

  placeWorld(id, kind, pos, rot = null) {
    const m = this.controls.get(`${id}:${kind}`);
    m.position.copy(pos);
    if (rot) m.quaternion.copy(rot);
  }

  // Match FK to IK: key the limb's bones on the selected anim layer (at this frame) so the FK
  // pose is the IK pose shown now; then lowering the blend to FK does not move the limb.
  async matchFKtoIK() {
    const id = this.pickedLimb(), ch = this.chains(), mp = this.motionPanel, layer = mp.activeLayer;
    if (!id || !ch?.[id]) return;
    if (layer?.kind !== 'keys') { this.status('Select an anim layer (Anim layers › + Keys) to key the FK bones on', true); return; }
    this.player.play(false);
    try {
      const character = this.getCharacter(), chain = ch[id];
      character.root.updateMatrixWorld(true);
      const ik = chain.map((j) => skeletonLocal(character, j).q.clone());
      const override = layer.blend === 'override', kf = Math.round(mp.keyFrame(this.player.frame)), t = layer.keys;
      const fk = override ? null : this.withFK(await this.fkArrays(), () => {
        character.root.updateMatrixWorld(true);
        return chain.map((j) => skeletonLocal(character, j).q.clone());
      });
      chain.forEach((j, n) => {
        const base = offsetAt(t, j.name, kf);
        // Override: the pose itself (relative to rest). Additive: the offset times the change
        // from the FK pose to the IK pose (exact for the top layer at weight 1).
        const q = override ? j.rest.q.clone().invert().multiply(ik[n]) : eulerQuat(base.rx, base.ry, base.rz).multiply(fk[n].clone().invert().multiply(ik[n]));
        const e = quatEuler(q, [base.rx, base.ry, base.rz]);
        const c = channelsOf(t, j.name);
        ['rx', 'ry', 'rz'].forEach((k, i) => setKey(c[k], kf, e[i]));
        for (const k of CHANNELS) if (!c[k].length) delete c[k];
      });
      mp.refreshKeyTicks();
      mp.schedule();
      this.status(`${this.label(id)}: FK keys on "${layer.name}" at frame ${kf + 1} match the IK pose (lower the IK/FK blend to use them)`);
    } catch (err) { this.status(`Match FK to IK failed: ${err.message || err}`, true); }
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
      follow.addEventListener('change', () => this.setFollow(L.id, follow.value));
      const keys = document.createElement('span');
      keys.className = 'keys';
      const nT = new Set(Object.values(l.target).flat().map((k) => Math.round(k.f))).size;
      const nP = new Set(Object.values(l.pole).flat().map((k) => Math.round(k.f))).size;
      keys.textContent = !ch[L.id] ? 'chain not found in the mapping' : l.ik ? `IK control: ${nT ? `${nT} key(s)` : 'follows the animation'} · pole: ${nP ? `${nP} key(s)` : 'follows the animation'}` +
        (l.blend?.length ? ` · blend: ${l.blend.length} key(s)` : '') : 'FK';
      row.addEventListener('click', (e) => { if (e.target === row || e.target === name || e.target === keys) { if (l.ik) this.pick({ limb: L.id, kind: 'ik' }); } });
      const blend = document.createElement('div');
      blend.className = 'rig-blend';
      blend.hidden = !l.ik;
      const fkL = document.createElement('span'); fkL.textContent = 'FK';
      const slider = document.createElement('input');
      Object.assign(slider, { type: 'range', min: 0, max: 1, step: 0.05, value: this.blendAt(l), title: 'IK/FK blend on this frame (keyed: Key blend; not keyed: the whole animation)' });
      slider.dataset.blend = L.id;
      const ikL = document.createElement('span'); ikL.textContent = 'IK';
      const val = document.createElement('span'); val.className = 'blend-val'; val.textContent = this.blendAt(l).toFixed(2);
      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        if (l.blend?.length) setKey(l.blend, this.player.frame, v); else l.weight = v;
        val.textContent = v.toFixed(2);
      });
      slider.addEventListener('change', () => this.changed());
      const kb = document.createElement('button');
      Object.assign(kb, { type: 'button', className: 'icon-button', textContent: '◆', title: 'Key the IK/FK blend at the current frame (then it is animated)' });
      kb.addEventListener('click', () => { setKey((l.blend ??= []), this.player.frame, Number(slider.value)); this.status(`${L.label}: IK/FK blend keyed at frame ${this.player.frame}`); this.changed(); });
      const xb = document.createElement('button');
      Object.assign(xb, { type: 'button', className: 'icon-button', textContent: '✕', title: 'Delete the blend key at the current frame', hidden: !l.blend?.length });
      xb.addEventListener('click', () => { l.blend = (l.blend ?? []).filter((k) => Math.round(k.f) !== this.player.frame); this.changed(); });
      blend.append(fkL, slider, ikL, val, kb, xb);
      row.append(name, seg, follow, blend, keys);
      host.append(row);
    }
    this.$('rig-selected').textContent = this.picked ? `Picked: ${this.label(this.picked.limb, this.picked.kind)} (follows ${this.limb(this.picked.limb).follow})` : '';
    this.renderTransform();
  }

  // Transform: the picked control's values at the current frame (follow space); typing keys it.
  renderTransform() {
    const host = this.$('rig-xform'), p = this.picked, ch = this.chains();
    host.replaceChildren();
    host.hidden = !p || !ch?.[p.limb];
    if (host.hidden) return;
    const names = p.kind === 'ik' ? [...POS, ...ROT] : POS;
    for (const k of names) {
      const lab = document.createElement('label');
      lab.textContent = k.startsWith('t') ? `Move ${k[1].toUpperCase()}` : `Rot ${k[1].toUpperCase()}°`;
      const input = document.createElement('input');
      Object.assign(input, { type: 'number', step: k.startsWith('t') ? 0.01 : 1 });
      input.dataset.c = k;
      input.addEventListener('change', () => {
        const v = this.currentValues();
        if (!v || !Number.isFinite(Number(input.value))) return;
        v[k] = Number(input.value);
        this.placeControl(p.limb, p.kind, v, ch);
        this.key(p.limb, p.kind);
      });
      lab.append(input);
      host.append(lab);
    }
    this.syncValues();
  }

  // Values of the picked control on the frame shown, in its follow space.
  currentValues() {
    const p = this.picked, ch = this.chains();
    if (!p || !ch?.[p.limb]) return null;
    const l = this.limb(p.limb), w = this.controlWorld(p.limb, p.kind, ch);
    return this.spaceValues(l, p.kind, w.pos, w.rot, ch, this.player.frame);
  }

  // Refresh the frame-dependent widgets (blend sliders, Transform) when the frame changes.
  syncValues() {
    for (const s of this.$('rig-limbs').querySelectorAll('input[data-blend]')) {
      if (document.activeElement === s) continue;
      const v = this.blendAt(this.limb(s.dataset.blend));
      s.value = v;
      s.nextElementSibling.nextElementSibling.textContent = v.toFixed(2);
    }
    const host = this.$('rig-xform');
    if (host.hidden || this.dragging) return;
    const v = this.currentValues();
    if (!v) return;
    for (const input of host.querySelectorAll('input[data-c]')) {
      if (document.activeElement === input) continue;
      const k = input.dataset.c;
      input.value = (k.startsWith('t') ? v[k].toFixed(3) : v[k].toFixed(1));
    }
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
