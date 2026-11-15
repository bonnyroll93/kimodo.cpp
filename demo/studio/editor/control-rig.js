// Control rig: IK / FK arms and legs on the character. ActionForge's "simple" workflow: a limb
// is FK until its IK is turned on, for the whole animation; "complex" workflow: the IK/FK blend
// slider of a limb (keyable, 1 = IK, 0 = FK) mixes both, with Match IK to FK / FK to IK snaps.
//   * IK on: the end joint (hand, foot) follows its box control and the middle joint (elbow,
//     knee) points at its pole (diamond). Controls are keyed in their follow space (Root or
//     Hips) at the current frame; without keys a control follows the animation.
//   * FK: bones are posed with the anim layers' gizmo (Animate › Anim layers, + Keys).
//   * Body controls: the hips box (offset of the hips: lower them and the IK feet stay on the
//     ground) and the root circle on the ground (offset of the whole character). Their
//     values are offsets (0 = the animation), keyed like the limb controls.
//   * Channel box: the picked control's values in its follow space; typing one keys it.
//   * Changing a limb's follow space converts its keys (the control stays where it was on
//     every keyed frame).
// The rig is sent with every stack (control_rig in /api/layers, /api/export) and solved by
// kmd-anim after the layers (include/kimodo/anim/control_rig.hpp), so preview and export
// match; while a control is dragged the chain is solved here for immediate feedback.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { evaluate, setKey, quatEuler, eulerQuat, offsetAt, channelsOf, CHANNELS } from '../viewer/keyframes.js';
import { skeletonLocal } from '../viewer/model-loader.js';
import { LABELS } from './channel-box.js';

export const LIMBS = [
  { id: 'left_arm', label: 'Left arm', src: ['LeftArm', 'LeftForeArm', 'LeftHand'] },
  { id: 'right_arm', label: 'Right arm', src: ['RightArm', 'RightForeArm', 'RightHand'] },
  { id: 'left_leg', label: 'Left leg', src: ['LeftLeg', 'LeftShin', 'LeftFoot'] },
  { id: 'right_leg', label: 'Right leg', src: ['RightLeg', 'RightShin', 'RightFoot'] },
];
const POS = ['tx', 'ty', 'tz'], ROT = ['rx', 'ry', 'rz'];
export const emptyRig = () => ({ limbs: Object.fromEntries(LIMBS.map((l) => [l.id, { ik: false, follow: 'root', weight: 1, target: {}, pole: {} }])) });
const hasKeys = (ch, names) => names.some((c) => ch?.[c]?.length);
const ALL = [...POS, ...ROT];
const isBody = (p) => p?.limb === 'body';
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
      if (e.value) { player.play(false); this.dragging = true; this.dragStart(); } else { this.dragging = false; this.dragEnd(); }
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
      if (k === 'e' && this.picked.kind !== 'pole') { this.setMode('rotate'); e.stopImmediatePropagation(); }
      if (k === 'k') { this.keyPicked(); e.stopImmediatePropagation(); }
      if (k === 'escape') this.pick(null);
    }, true);
    // Controls are picked before joints (joint-selection.js asks this first).
    viewport.pickControls = (raycaster) => this.hit(raycaster);
  }

  get data() { return (this.motionPanel.controlRig ??= emptyRig()); }
  limb(id) { return (this.data.limbs[id] ??= { ik: false, follow: 'root', weight: 1, target: {}, pole: {} }); }
  body() { return (this.data.body ??= { hips: {}, root: {} }); }
  // Key curves of a control ({limb, kind}).
  curvesOf(p) {
    if (isBody(p)) return (this.body()[p.kind] ??= {});
    const l = this.limb(p.limb);
    return p.kind === 'ik' ? l.target : l.pole;
  }
  // Body control offsets on a frame ({tx..rz}, 0 where not keyed).
  offsetsAt(kind, f = this.player.frame) {
    const c = this.body()[kind] ?? {};
    return Object.fromEntries(ALL.map((k) => [k, c[k]?.length ? evaluate(c[k], f) : 0]));
  }

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
    const body = this.body(), rootOn = hasKeys(body.root, ALL), hipsOn = hasKeys(body.hips, ALL);
    return limbs.length || rootOn || hipsOn ? { version: 1, fps: 30, hips: ch.hips.name, limbs,
      ...(rootOn ? { root_control: body.root } : {}), ...(hipsOn ? { hips_control: body.hips } : {}) } : null;
  }
  active() { return !!this.request(); }
  // IK/FK blend of a limb on a frame (the keyed curve, else its weight).
  blendAt(l, f = this.player.frame) { return l.blend?.length ? THREE.MathUtils.clamp(evaluate(l.blend, f), 0, 1) : l.weight ?? 1; }
  label(id, kind) {
    if (id === 'body') return kind === 'hips' ? 'Hips control' : 'Root control';
    return `${LIMBS.find((L) => L.id === id).label}${kind ? ` ${kind === 'ik' ? 'IK control' : 'pole'}` : ''}`;
  }

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
    const hips = new THREE.Mesh(new THREE.BoxGeometry(size * 3.2, size * 1.2, size * 2.2),
      new THREE.MeshBasicMaterial({ color: 0x5eead4, wireframe: true, depthTest: false, transparent: true, opacity: 0.9 }));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(size * 4, size * 0.1, 6, 64).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x5eead4, depthTest: false, transparent: true, opacity: 0.9 }));
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(size * 0.5, size * 1.2, 4).rotateX(Math.PI / 2).translate(0, 0, size * 4.6),
      ring.material);
    ring.add(arrow); // points where the character faces (+Z)
    for (const [m, kind] of [[hips, 'hips'], [ring, 'root']]) {
      m.renderOrder = 999;
      m.userData = { limb: 'body', kind };
      this.controls.set(`body:${kind}`, m);
      this.group.add(m);
    }
  }

  // Ground point under the hips (skeleton space y = 0), in world space.
  groundUnderHips(ch) {
    const character = this.getCharacter(), M = character.root.matrixWorld;
    const p = ch.hips.bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(M.clone().invert());
    p.y = 0;
    return p.applyMatrix4(M);
  }
  rootRotation() {
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(this.getCharacter().root.matrixWorld));
  }

  update() {
    const ch = this.chains();
    const show = !!ch && this.$('show-controls').checked && !this.motionPanel.tposeActive?.();
    this.group.visible = show;
    if (!show) { if (this.picked && !ch) this.pick(null); return; }
    const character = this.getCharacter();
    if (this.sizedFor !== character) { // control size from the character's height (once: not every frame)
      const box = new THREE.Box3().setFromObject(character.root);
      this.sizedFor = character;
      this.controlSize = Math.max(0.02, (box.max.y - box.min.y) * 0.06);
    }
    this.ensureMeshes(this.controlSize);
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
    const hips = this.controls.get('body:hips'), ring = this.controls.get('body:root');
    hips.visible = ring.visible = true;
    const draggedBody = this.dragging && isBody(this.picked);
    if (!(draggedBody && this.picked.kind === 'hips')) {
      ch.hips.bone.getWorldPosition(hips.position);
      ch.hips.bone.getWorldQuaternion(hips.quaternion);
    }
    if (!(draggedBody && this.picked.kind === 'root')) {
      ring.position.copy(this.groundUnderHips(ch));
      const o = this.offsetsAt('root');
      ring.quaternion.copy(this.rootRotation().multiply(eulerQuat(o.rx, o.ry, o.rz)));
    }
    hips.material.color.set(this.picked?.limb === 'body' && this.picked.kind === 'hips' ? 0xffffff : 0x5eead4);
    ring.material.color.set(this.picked?.limb === 'body' && this.picked.kind === 'root' ? 0xffffff : 0x5eead4);
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
  dragStart() {
    const p = this.picked, ch = this.chains();
    if (!isBody(p) || !ch) { this.start = null; return; }
    const m = this.controls.get(`body:${p.kind}`), character = this.getCharacter();
    const bones = p.kind === 'hips' ? [ch.hips.bone] : character.joints.filter((j) => j.parent < 0).map((j) => j.bone);
    this.start = { pos: m.position.clone(), quat: m.quaternion.clone(),
      bones: bones.map((b) => ({ b, p: b.getWorldPosition(new THREE.Vector3()), q: b.getWorldQuaternion(new THREE.Quaternion()) })) };
  }

  // World change of the dragged body control since the drag started.
  bodyDelta() {
    const m = this.controls.get(`body:${this.picked.kind}`), s = this.start;
    return { dp: m.position.clone().sub(s.pos), dq: m.quaternion.clone().multiply(s.quat.clone().invert()) };
  }

  preview() {
    if (!this.dragging || !this.picked) return;
    if (isBody(this.picked)) {
      if (!this.start) return;
      const { dp, dq } = this.bodyDelta(), pivot = this.start.pos;
      for (const { b, p, q } of this.start.bones) {
        const pos = this.picked.kind === 'hips' ? p.clone().add(dp) : p.clone().sub(pivot).applyQuaternion(dq).add(pivot).add(dp);
        setBoneWorld(b, pos, dq.clone().multiply(q));
      }
      return;
    }
    const ch = this.chains();
    if (!ch?.[this.picked.limb]) return;
    const ik = this.controls.get(`${this.picked.limb}:ik`), pole = this.controls.get(`${this.picked.limb}:pole`);
    solveTwoBone(ch[this.picked.limb], ik.position, pole.position, ik.quaternion);
    this.update();
  }

  dragEnd() {
    if (!this.picked) return;
    if (isBody(this.picked)) { if (this.start) this.keyBody(this.picked.kind, this.bodyValues()); this.start = null; return; }
    this.key(this.picked.limb, this.picked.kind);
  }

  // Offsets after the drag: the change (world) brought to skeleton space, on top of the keyed offset.
  bodyValues() {
    const o = this.offsetsAt(this.picked.kind);
    if (!this.start) return o;
    const { dp, dq } = this.bodyDelta();
    const inv = this.getCharacter().root.matrixWorld.clone().invert();
    const t = this.start.pos.clone().add(dp).applyMatrix4(inv).sub(this.start.pos.clone().applyMatrix4(inv));
    const mq = this.rootRotation();
    const dqs = mq.clone().invert().multiply(dq).multiply(mq);
    const e = quatEuler(dqs.multiply(eulerQuat(o.rx, o.ry, o.rz)), [o.rx, o.ry, o.rz]);
    return { tx: o.tx + t.x, ty: o.ty + t.y, tz: o.tz + t.z, rx: e[0], ry: e[1], rz: e[2] };
  }

  keyBody(kind, v, quiet = false) {
    const c = this.curvesOf({ limb: 'body', kind }), f = this.player.frame;
    for (const k of ALL) setKey((c[k] ??= []), f, v[k]);
    if (!quiet) this.status(`Keyed ${this.label('body', kind)} at frame ${f}`);
    this.changed();
  }

  // Timeline: move the picked control's key at frame f by delta frames (replacing a key there).
  moveKey(f, delta) {
    if (!this.picked || !delta) return;
    const curves = this.curvesOf(this.picked), to = Math.max(0, f + delta);
    for (const k of Object.keys(curves)) {
      const keys = curves[k].filter((x) => Math.round(x.f) !== to || to === f);
      for (const x of keys) if (Math.round(x.f) === f) x.f = to;
      keys.sort((a, b) => a.f - b.f);
      curves[k] = keys;
    }
    this.player.setFrame(to);
    this.status(`Moved the ${this.label(this.picked.limb, this.picked.kind)} key from frame ${f} to ${to}`);
    this.changed();
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
    if (!id || id === 'body') this.status('Pick an arm or leg control first (viewport or Picker)', true);
    return id && id !== 'body' ? id : null;
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

  keyPicked() {
    if (!this.picked) return;
    if (isBody(this.picked)) this.keyBody(this.picked.kind, this.offsetsAt(this.picked.kind));
    else this.key(this.picked.limb, this.picked.kind);
  }

  deleteKeyAtFrame() {
    if (!this.picked) return;
    const f = this.player.frame, curves = this.curvesOf(this.picked);
    for (const k of Object.keys(curves)) curves[k] = curves[k].filter((x) => Math.round(x.f) !== f);
    this.changed();
  }

  resetLimb() {
    const id = this.picked?.limb;
    if (!id) { this.status('Pick a control first (viewport or Picker)', true); return; }
    if (id === 'body') {
      this.body()[this.picked.kind] = {};
      this.status(`${this.label('body', this.picked.kind)}: no offset (back to the animation)`);
      this.changed();
      return;
    }
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
    const curves = this.curvesOf(this.picked);
    const set = new Set();
    for (const keys of Object.values(curves)) for (const k of keys) set.add(Math.round(k.f));
    return { label: this.label(this.picked.limb, this.picked.kind), frames: [...set].sort((a, b) => a - b) };
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
    const body = document.createElement('div');
    body.className = `rig-limb rig-body${isBody(this.picked) ? ' picked' : ''}`;
    const bname = document.createElement('span');
    bname.textContent = 'Body';
    const bseg = document.createElement('span');
    bseg.className = 'seg';
    for (const [kind, text, tip] of [['hips', 'Hips', 'Hips box: offset of the hips (IK feet stay planted)'], ['root', 'Root', 'Ground circle: offset of the whole character']]) {
      const b = document.createElement('button');
      Object.assign(b, { type: 'button', textContent: text, title: tip, className: isBody(this.picked) && this.picked.kind === kind ? 'on' : '' });
      b.addEventListener('click', () => this.pick({ limb: 'body', kind }));
      bseg.append(b);
    }
    const bkeys = document.createElement('span');
    bkeys.className = 'keys';
    const nk = (c) => new Set(Object.values(c ?? {}).flat().map((k) => Math.round(k.f))).size;
    bkeys.textContent = `hips: ${nk(this.body().hips) ? `${nk(this.body().hips)} key(s)` : 'no offset'} · root: ${nk(this.body().root) ? `${nk(this.body().root)} key(s)` : 'no offset'}`;
    body.append(bname, bseg, document.createElement('span'), bkeys);
    host.prepend(body);
    this.$('rig-selected').textContent = !this.picked ? ''
      : isBody(this.picked) ? `Picked: ${this.label('body', this.picked.kind)} (offset from the animation)`
      : `Picked: ${this.label(this.picked.limb, this.picked.kind)} (follows ${this.limb(this.picked.limb).follow})`;
  }

  // Channel box: the picked control's values (live while it is dragged); a change keys it.
  channelSpec() {
    const p = this.picked, ch = this.chains();
    if (!p || !(isBody(p) ? ch : ch?.[p.limb])) return null;
    let v;
    if (this.dragging && isBody(p)) v = this.bodyValues();
    else if (this.dragging) {
      const m = this.controls.get(`${p.limb}:${p.kind}`);
      v = this.spaceValues(this.limb(p.limb), p.kind, m.position, m.quaternion, ch, this.player.frame);
    } else v = this.currentValues();
    if (!v) return null;
    const keys = p.kind === 'pole' ? POS : ALL;
    const keyed = keyedFrames(this.curvesOf(p), keys).includes(this.player.frame);
    return {
      id: `rig:${p.limb}:${p.kind}`,
      title: this.label(p.limb, p.kind),
      subtitle: `${isBody(p) ? 'offset from the animation' : `follows ${this.limb(p.limb).follow}`} · frame ${this.player.frame}${keyed ? ' · keyed' : ''}`,
      channels: keys.map((k) => ({ k, label: LABELS[k], value: v[k] })),
      set: (k, value, final) => {
        if (!final) return;
        const now = this.currentValues();
        if (!now) return;
        now[k] = value;
        if (isBody(p)) { this.keyBody(p.kind, now); return; }
        this.placeControl(p.limb, p.kind, now, ch);
        this.key(p.limb, p.kind);
      },
    };
  }

  // Values of the picked control on the frame shown, in its follow space.
  currentValues() {
    const p = this.picked, ch = this.chains();
    if (isBody(p)) return ch ? this.offsetsAt(p.kind) : null;
    if (!p || !ch?.[p.limb]) return null;
    const l = this.limb(p.limb), w = this.controlWorld(p.limb, p.kind, ch);
    return this.spaceValues(l, p.kind, w.pos, w.rot, ch, this.player.frame);
  }

  // Refresh the frame-dependent widgets (blend sliders) when the frame changes.
  syncValues() {
    for (const s of this.$('rig-limbs').querySelectorAll('input[data-blend]')) {
      if (document.activeElement === s) continue;
      const v = this.blendAt(this.limb(s.dataset.blend));
      s.value = v;
      s.nextElementSibling.nextElementSibling.textContent = v.toFixed(2);
    }
  }
}

// Sets a bone's world position / rotation (keeping its scale).
function setBoneWorld(bone, pos, quat) {
  bone.parent.updateWorldMatrix(true, false);
  const inv = bone.parent.matrixWorld.clone().invert();
  const m = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1)).premultiply(inv);
  const s = bone.scale.clone();
  m.decompose(bone.position, bone.quaternion, new THREE.Vector3());
  bone.scale.copy(s);
  bone.updateMatrixWorld(true);
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
