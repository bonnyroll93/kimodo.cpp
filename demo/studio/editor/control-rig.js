// Control rig: IK / FK arms and legs on the character. ActionForge's "simple" workflow: a limb
// is FK until its IK is turned on, for the whole animation; "complex" workflow: the IK/FK blend
// slider of a limb (keyable, 1 = IK, 0 = FK) mixes both, with Match IK to FK / FK to IK snaps.
//   * IK on: the end joint (hand, foot) follows its box control and the middle joint (elbow,
//     knee) points at its pole (diamond). Controls are keyed in their follow space at the
//     current frame; without keys a control follows the animation. Follow spaces: World
//     (nothing moves the control: a planted foot stays put whatever the hips or the root do),
//     Root (the root control carries it) or Hips (it moves with the hips).
//   * FK: bones are posed with the anim layers' gizmo (Animate › Anim layers, + Keys).
//   * Body controls: the hips box (offset of the hips: lower them and the IK feet stay on the
//     ground) and the root circle on the ground (offset of the whole character). Their
//     values are offsets (0 = the animation).
//   * Anim layers (Maya-style): keys go to the selected anim layer (BaseAnimation selected: to
//     the rig's own curves). A key is computed so the control ends where you put it: on an
//     additive layer as an offset (divided by the layer weight), on an override layer as the
//     value (Maya does the same). kmd-anim composes base + layers (control_rig.hpp) and returns
//     every control's value per frame (control_rig.f32), which is what the controls show.
//   * Channel box: the picked control's values (composed) in its follow space; typing keys it.
//   * Changing a limb's follow space converts its keys (base and layers).
// The rig is sent with every stack (control_rig in /api/layers, /api/export) and solved by
// kmd-anim after the layers, so preview and export match; while a control is dragged the
// chain is solved here for immediate feedback.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { evaluate, setKey, quatEuler, eulerQuat, offsetAt, channelsOf, CHANNELS } from '../viewer/keyframes.js';
import { skeletonLocal } from '../viewer/model-loader.js';
import { LABELS } from './channel-box.js';
import { sourceName } from './source-names.js';

export const LIMBS = [
  { id: 'left_arm', label: 'Left arm', src: ['LeftArm', 'LeftForeArm', 'LeftHand'] },
  { id: 'right_arm', label: 'Right arm', src: ['RightArm', 'RightForeArm', 'RightHand'] },
  { id: 'left_leg', label: 'Left leg', src: ['LeftLeg', 'LeftShin', 'LeftFoot'] },
  { id: 'right_leg', label: 'Right leg', src: ['RightLeg', 'RightShin', 'RightFoot'] },
];
const POS = ['tx', 'ty', 'tz'], ROT = ['rx', 'ry', 'rz'];
const newLimb = () => ({ ik: false, follow: 'world', weight: 1, target: {}, pole: {} });
export const emptyRig = () => ({ limbs: Object.fromEntries(LIMBS.map((l) => [l.id, newLimb()])) });
const hasKeys = (ch, names) => names.some((c) => ch?.[c]?.length);
const ALL = [...POS, ...ROT];
const isBody = (p) => p?.limb === 'body';
const keyedFrames = (curves, names) => [...new Set(names.flatMap((c) => (curves?.[c] ?? []).map((k) => Math.round(k.f))))].sort((a, b) => a - b);
const V3 = (d, p) => new THREE.Vector3(d[p], d[p + 1], d[p + 2]);
const Q4 = (d, p) => new THREE.Quaternion(d[p], d[p + 1], d[p + 2], d[p + 3]);
const evalV = (curves, f) => new THREE.Vector3(...POS.map((k) => (curves[k]?.length ? evaluate(curves[k], f) : 0)));
const evalE = (curves, f) => ROT.map((k) => (curves[k]?.length ? evaluate(curves[k], f) : 0));
const anyKeys = (c) => Object.values(c ?? {}).some((k) => Array.isArray(k) && k.length);
const rotOf = (M) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(M));
export const FOLLOWS = [['world', 'World'], ['root', 'Root'], ['hips', 'Hips']];

async function f32(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Float32Array(await r.arrayBuffer());
}

export class ControlRig {
  constructor({ $, viewport, player, motionPanel, retarget, status, getCharacter, onPick }) {
    Object.assign(this, { $, viewport, player, motionPanel, retarget, status, getCharacter, onPick });
    this.picked = null; // {limb, kind: 'ik' | 'pole'} or {limb: 'body', kind: 'hips' | 'root'}
    this.stale = false; // edited since the last result (the server's control values are old)
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
    // Controls visibility: the viewport bar's "Rig" and the Rig panel's "Controls" (kept in step,
    // remembered in this browser).
    const showBoxes = [$('show-controls'), $('show-rig')].filter(Boolean);
    let shown = true;
    try { shown = localStorage.getItem('kimodo-show-rig') !== 'off'; } catch { /* storage unavailable */ }
    for (const b of showBoxes) {
      b.checked = shown;
      b.addEventListener('change', () => {
        for (const o of showBoxes) o.checked = b.checked;
        try { localStorage.setItem('kimodo-show-rig', b.checked ? 'on' : 'off'); } catch { /* storage unavailable */ }
        if (!b.checked && this.picked) this.pick(null); // no gizmo on hidden controls
        this.update();
      });
    }
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
  limb(id) { return (this.data.limbs[id] ??= newLimb()); }
  body() { return (this.data.body ??= { hips: {}, root: {} }); }
  // Base (BaseAnimation) key curves of a control.
  curvesOf(p) {
    if (isBody(p)) return (this.body()[p.kind] ??= {});
    const l = this.limb(p.limb);
    return p.kind === 'ik' ? l.target : l.pole;
  }
  // Base body offsets on a frame ({tx..rz}, 0 where not keyed).
  offsetsAt(kind, f = this.player.frame) {
    const c = this.body()[kind] ?? {};
    return Object.fromEntries(ALL.map((k) => [k, c[k]?.length ? evaluate(c[k], f) : 0]));
  }

  // ---- where keys go: the selected anim layer, else the base -------------------------------
  store() {
    const mp = this.motionPanel, i = mp.active, l = mp.layers[i];
    if (l?.kind !== 'keys') return { layer: null, f: this.player.frame, w: 1, name: 'BaseAnimation' };
    return { layer: l, i, f: Math.round(mp.keyFrame(this.player.frame, i)), w: mp.weightAt(i), name: l.name, additive: l.blend !== 'override' };
  }
  layerRig(layer) { return (layer.rig ??= { limbs: {}, body: {} }); }
  curvesFor(st, p) {
    if (!st.layer) return this.curvesOf(p);
    const rig = this.layerRig(st.layer);
    if (isBody(p)) return ((rig.body ??= {})[p.kind] ??= {});
    const l = ((rig.limbs ??= {})[p.limb] ??= {});
    return p.kind === 'ik' ? (l.target ??= {}) : (l.pole ??= {});
  }
  // Store frame <-> stack frame (anim layers have their own time).
  toStack(st, f) { return st.layer ? Math.round(this.motionPanel.stackFrame(f, st.i)) : f; }
  toStore(st, f) { return st.layer ? Math.round(this.motionPanel.keyFrame(f, st.i)) : f; }

  // Character joints of each limb (via the retarget mapping: source joint -> character joint).
  chains() {
    const character = this.getCharacter();
    if (!character || !this.retarget.enabled || !this.retarget.mapping) return null;
    const bySource = new Map(this.retarget.mapping.joints.map((j) => [j.source, j.target]));
    const key = this.retarget.skeletonKey;
    const joint = (src) => character.joints.find((j) => j.name === bySource.get(sourceName(key, src)));
    const out = {};
    for (const L of LIMBS) {
      const js = L.src.map(joint);
      if (js.every(Boolean) && js[1].parent === js[0].index && js[2].parent === js[1].index) out[L.id] = js;
    }
    out.hips = joint('Hips') ?? character.joints[0];
    return out;
  }

  // /api/layers "control_rig" (null when nothing is on or keyed).
  request() {
    const ch = this.chains();
    if (!ch) return null;
    const limbs = [];
    for (const L of LIMBS) {
      const l = this.limb(L.id);
      if (!l.ik || !ch[L.id]) continue;
      limbs.push({ name: L.id, chain: ch[L.id].map((j) => j.name), ik: true, follow: l.follow ?? 'world', weight: l.weight, target: l.target, pole: l.pole,
        ...(l.blend?.length ? { blend: l.blend } : {}) });
    }
    const body = this.body(), rootOn = hasKeys(body.root, ALL), hipsOn = hasKeys(body.hips, ALL);
    const mp = this.motionPanel, eff = mp.effective(), layers = [];
    for (const i of mp.stackOrder()) {
      const l = mp.layers[i];
      if (l.kind !== 'keys' || !l.enabled || l.muted || !l.rig) continue;
      const lr = l.rig, rl = {};
      for (const [id, c] of Object.entries(lr.limbs ?? {})) if (anyKeys(c.target) || anyKeys(c.pole) || c.blend?.length) rl[id] = c;
      const hk = anyKeys(lr.body?.hips), rk = anyKeys(lr.body?.root);
      if (!Object.keys(rl).length && !hk && !rk) continue;
      const t = eff.get(i) ?? {};
      layers.push({ name: l.name, mode: l.blend === 'override' ? 'override' : 'additive', weight: l.weight,
        ...(l.weightKeys?.length ? { weight_keys: l.weightKeys } : {}), start: t.start ?? 0, speed: t.speed ?? 1, ...(t.end > (t.start ?? 0) ? { end: t.end } : {}), ...(t.warp?.length ? { warp: t.warp } : {}),
        limbs: rl, ...(hk ? { hips_control: lr.body.hips } : {}), ...(rk ? { root_control: lr.body.root } : {}) });
    }
    return limbs.length || rootOn || hipsOn || layers.length ? { version: 1, fps: 30, hips: ch.hips.name, limbs,
      ...(rootOn ? { root_control: body.root } : {}), ...(hipsOn ? { hips_control: body.hips } : {}), ...(layers.length ? { layers } : {}) } : null;
  }
  active() { return !!this.request(); }
  // IK/FK blend of a limb on a frame (base: the keyed curve, else its weight).
  blendAt(l, f = this.player.frame) { return l.blend?.length ? THREE.MathUtils.clamp(evaluate(l.blend, f), 0, 1) : l.weight ?? 1; }
  label(id, kind) {
    if (id === 'body') return kind === 'hips' ? 'Hips control' : 'Root control';
    return `${LIMBS.find((L) => L.id === id).label}${kind ? ` ${kind === 'ik' ? 'IK control' : 'pole'}` : ''}`;
  }
  memberLabel(mid) {
    if (mid.startsWith('joint:')) return mid.slice(6);
    const [, limb, kind] = mid.split(':');
    return limb === 'body' ? this.label('body', kind) : LIMBS.some((L) => L.id === limb) ? this.label(limb, kind) : mid;
  }
  // A new result arrived (its control values are current).
  onResult() { this.stale = false; clearTimeout(this.staleTimer); }

  // ---- control values from the last result (control_rig.f32) -------------------------------
  srv(f = this.player.frame) {
    const c = this.motionPanel.controlsData;
    if (!c || this.stale) return null;
    const frames = Math.floor(c.data.length / c.stride);
    if (!frames) return null;
    const d = c.data, o = Math.min(frames - 1, Math.max(0, f)) * c.stride;
    const read = (p) => ({ pos: V3(d, p), rot: Q4(d, p + 3), pole: V3(d, p + 7), blend: d[p + 10] });
    const limbs = {};
    c.limbs.forEach((name, n) => { const p = o + n * 22; limbs[name] = { ...read(p), base: read(p + 11) }; });
    const b = o + c.limbs.length * 22, body = (p) => ({ t: V3(d, p), q: Q4(d, p + 3) });
    return { limbs, hips: { ...body(b), base: body(b + 7) }, root: { ...body(b + 14), base: body(b + 21) } };
  }

  // Body offsets (composed and base) on the frame shown.
  bodyComposed(kind) {
    const s = this.srv()?.[kind];
    if (s) return s;
    const o = this.offsetsAt(kind), v = { t: new THREE.Vector3(o.tx, o.ty, o.tz), q: eulerQuat(o.rx, o.ry, o.rz) };
    return { ...v, base: v };
  }

  // ---- spaces ----------------------------------------------------------------------------
  // Follow space -> world matrix on the frame shown. World: the character's skeleton space;
  // Root: that, moved by the root control (about the hips' ground point); Hips: the hips'
  // world position and rotation, no scale.
  spaceMatrix(follow, ch) {
    const character = this.getCharacter();
    character.root.updateMatrixWorld(true);
    const S = character.root.matrixWorld.clone();
    if (follow === 'hips') {
      const hips = ch.hips.bone;
      return new THREE.Matrix4().compose(hips.getWorldPosition(new THREE.Vector3()), hips.getWorldQuaternion(new THREE.Quaternion()), new THREE.Vector3(1, 1, 1));
    }
    if (follow !== 'root') return S;
    const r = this.bodyComposed('root');
    if (r.t.lengthSq() < 1e-12 && Math.abs(r.q.w) > 1 - 1e-9) return S;
    const ground = ch.hips.bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(S.clone().invert());
    const pivot = new THREE.Vector3(ground.x - r.t.x, 0, ground.z - r.t.z);
    const t = pivot.clone().add(r.t).sub(pivot.clone().applyQuaternion(r.q));
    return S.multiply(new THREE.Matrix4().compose(t, r.q, new THREE.Vector3(1, 1, 1)));
  }
  toSpace(follow, ch, pos, rot = null) {
    const inv = this.spaceMatrix(follow, ch).invert();
    return { pos: pos.clone().applyMatrix4(inv), rot: rot ? rotOf(inv).multiply(rot) : null };
  }
  fromSpace(follow, ch, pos, rot = null) {
    const M = this.spaceMatrix(follow, ch);
    return { pos: pos.clone().applyMatrix4(M), rot: rot ? rotOf(M).multiply(rot) : null };
  }

  // A limb control's values in its follow space on the frame shown: composed and base.
  limbValues(id, kind, ch) {
    const s = this.srv()?.limbs[id];
    if (s) return kind === 'ik' ? { pos: s.pos, rot: s.rot, base: { pos: s.base.pos, rot: s.base.rot } } : { pos: s.pole, rot: null, base: { pos: s.base.pole, rot: null } };
    const w = this.localWorld(id, kind, ch), v = this.toSpace(this.limb(id).follow, ch, w.pos, w.rot);
    return { ...v, base: v };
  }
  // Without a result: the base curves, else the animation (the bones).
  localWorld(id, kind, ch, f = this.player.frame, follow = this.limb(id).follow) {
    const l = this.limb(id), [a, b, c] = ch[id];
    const curves = kind === 'ik' ? l.target : l.pole;
    let pos = kind === 'ik' ? c.bone.getWorldPosition(new THREE.Vector3()) : this.defaultPole(a, b, c);
    let rot = kind === 'ik' ? c.bone.getWorldQuaternion(new THREE.Quaternion()) : null;
    if (hasKeys(curves, POS)) pos = this.fromSpace(follow, ch, evalV(curves, f)).pos;
    if (kind === 'ik' && hasKeys(curves, ROT)) rot = this.fromSpace(follow, ch, new THREE.Vector3(), eulerQuat(...evalE(curves, f))).rot;
    return { pos, rot };
  }
  // World transform of a control on the frame shown (what the controls draw).
  controlWorld(id, kind, ch) {
    const v = this.limbValues(id, kind, ch);
    return this.fromSpace(this.limb(id).follow, ch, v.pos, v.rot ?? new THREE.Quaternion());
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
  rootRotation() { return rotOf(this.getCharacter().root.matrixWorld); }

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
    const hold = this.stale; // edited: keep the controls where they were put until the result is back
    for (const L of LIMBS) {
      const on = !!ch[L.id] && this.limb(L.id).ik;
      for (const kind of ['ik', 'pole', 'line']) this.controls.get(`${L.id}:${kind}`).visible = on;
      if (!on) continue;
      const ik = this.controls.get(`${L.id}:ik`), pole = this.controls.get(`${L.id}:pole`), line = this.controls.get(`${L.id}:line`);
      const dragged = this.dragging && this.picked?.limb === L.id;
      if (!hold || !this.placed) {
        if (!(dragged && this.picked.kind === 'ik')) { const w = this.controlWorld(L.id, 'ik', ch); ik.position.copy(w.pos); ik.quaternion.copy(w.rot); }
        if (!(dragged && this.picked.kind === 'pole')) pole.position.copy(this.controlWorld(L.id, 'pole', ch).pos);
      }
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
    if (!(draggedBody && this.picked.kind === 'hips') && (!hold || !this.placed)) {
      ch.hips.bone.getWorldPosition(hips.position);
      ch.hips.bone.getWorldQuaternion(hips.quaternion);
    }
    if (!(draggedBody && this.picked.kind === 'root') && (!hold || !this.placed)) {
      ring.position.copy(this.groundUnderHips(ch));
      ring.quaternion.copy(this.rootRotation().multiply(this.bodyComposed('root').q));
    }
    if (!hold) this.placed = true;
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
  // The picked control as a layer member id.
  memberId() { return this.picked ? `ctl:${this.picked.limb}:${this.picked.kind}` : null; }

  setMode(mode) {
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(mode === 'rotate' ? 'local' : 'world');
    this.$('rig-move').classList.toggle('on', mode === 'translate');
    this.$('rig-rotate').classList.toggle('on', mode === 'rotate');
  }

  dragStart() {
    const p = this.picked, ch = this.chains();
    if (!isBody(p) || !ch) { this.start = null; return; }
    const m = this.controls.get(`body:${p.kind}`), character = this.getCharacter();
    const bones = p.kind === 'hips' ? [ch.hips.bone] : character.joints.filter((j) => j.parent < 0).map((j) => j.bone);
    this.start = { pos: m.position.clone(), quat: m.quaternion.clone(), composed: this.bodyComposed(p.kind),
      bones: bones.map((b) => ({ b, p: b.getWorldPosition(new THREE.Vector3()), q: b.getWorldQuaternion(new THREE.Quaternion()) })) };
  }

  // World change of the dragged body control since the drag started.
  bodyDelta() {
    const m = this.controls.get(`body:${this.picked.kind}`), s = this.start;
    return { dp: m.position.clone().sub(s.pos), dq: m.quaternion.clone().multiply(s.quat.clone().invert()) };
  }

  // Live feedback while dragging: solve the chain here on the character's bones.
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
    if (isBody(this.picked)) {
      if (this.start) { const w = this.bodyWanted(); this.commitBody(this.picked.kind, w.t, w.q); }
      this.start = null;
      return;
    }
    this.key(this.picked.limb, this.picked.kind);
  }

  // Composed body offset wanted after the drag: the change (world) in skeleton space, on top.
  bodyWanted() {
    const c = this.start?.composed ?? this.bodyComposed(this.picked.kind);
    if (!this.start) return { t: c.t.clone(), q: c.q.clone() };
    const { dp, dq } = this.bodyDelta();
    const inv = this.getCharacter().root.matrixWorld.clone().invert();
    const t = this.start.pos.clone().add(dp).applyMatrix4(inv).sub(this.start.pos.clone().applyMatrix4(inv));
    const mq = this.rootRotation();
    const dqs = mq.clone().invert().multiply(dq).multiply(mq);
    return { t: c.t.clone().add(t), q: dqs.multiply(c.q) };
  }
  bodyEuler(q, near = [0, 0, 0]) { return quatEuler(q, near); }

  // ---- keying (Maya-style: the control ends where it is put) -------------------------------
  // Key a limb control so its composed value becomes wantPos / wantRot (follow space; null:
  // leave that group alone) on the selected layer (or the base).
  commitLimb(id, kind, wantPos, wantRot = null, quiet = false) {
    const ch = this.chains();
    if (!ch?.[id]) return;
    const st = this.store();
    if (st.layer && st.w < 1e-3) { this.status(`"${st.name}" has weight 0 here: raise it to key on it`, true); return; }
    const cur = this.limbValues(id, kind, ch), curves = this.curvesFor(st, { limb: id, kind }), f = st.f;
    if (wantPos) {
      const d = wantPos.clone().sub(cur.pos);
      let p;
      if (!st.layer) p = cur.base.pos.clone().add(d);
      else p = (hasKeys(curves, POS) ? evalV(curves, f) : st.additive ? new THREE.Vector3() : cur.pos.clone()).add(d.multiplyScalar(1 / st.w));
      POS.forEach((k, n) => setKey((curves[k] ??= []), f, p.getComponent(n)));
    }
    if (wantRot && kind === 'ik') {
      const C = cur.rot, D = wantRot, near = evalE(curves, f);
      let q;
      if (!st.layer) q = D.clone().multiply(C.clone().invert()).multiply(cur.base.rot);
      else if (hasKeys(curves, ROT)) q = eulerQuat(...near).multiply(C.clone().invert()).multiply(D);
      else q = st.additive ? C.clone().invert().multiply(D) : D.clone();
      const e = quatEuler(q, near);
      ROT.forEach((k, n) => setKey((curves[k] ??= []), f, e[n]));
    }
    if (!quiet) this.status(`Keyed ${this.label(id, kind)} on ${st.name} at frame ${this.player.frame}`);
    this.changed();
  }

  // Key a body control so its composed offset becomes wantT / wantQ (null: leave alone).
  commitBody(kind, wantT, wantQ, quiet = false) {
    const st = this.store();
    if (st.layer && st.w < 1e-3) { this.status(`"${st.name}" has weight 0 here: raise it to key on it`, true); return; }
    const cur = this.bodyComposed(kind), curves = this.curvesFor(st, { limb: 'body', kind }), f = st.f;
    const t = wantT ?? cur.t, q = wantQ ?? cur.q;
    const d = t.clone().sub(cur.t);
    let p;
    if (!st.layer) p = cur.base.t.clone().add(d);
    else p = (hasKeys(curves, POS) ? evalV(curves, f) : st.additive ? new THREE.Vector3() : cur.t.clone()).add(d.multiplyScalar(1 / st.w));
    const near = evalE(curves, f);
    let r;
    if (!st.layer) r = q.clone().multiply(cur.q.clone().invert()).multiply(cur.base.q);
    else if (hasKeys(curves, ROT)) r = eulerQuat(...near).multiply(cur.q.clone().invert()).multiply(q);
    else r = st.additive ? cur.q.clone().invert().multiply(q) : q.clone();
    const e = quatEuler(r, near);
    POS.forEach((k, n) => setKey((curves[k] ??= []), f, p.getComponent(n)));
    ROT.forEach((k, n) => setKey((curves[k] ??= []), f, e[n]));
    if (!quiet) this.status(`Keyed ${this.label('body', kind)} on ${st.name} at frame ${this.player.frame}`);
    this.changed();
  }

  // Key the IK/FK blend so the composed blend becomes v.
  commitBlend(id, v) {
    const st = this.store(), l = this.limb(id);
    const cur = this.srv()?.limbs[id]?.blend ?? this.blendAt(l);
    if (!st.layer) {
      if (l.blend?.length) setKey(l.blend, st.f, v); else l.weight = v;
    } else {
      if (st.w < 1e-3) { this.status(`"${st.name}" has weight 0 here: raise it to key on it`, true); return; }
      const lc = ((this.layerRig(st.layer).limbs ??= {})[id] ??= {});
      const old = lc.blend?.length ? evaluate(lc.blend, st.f) : st.additive ? 0 : cur;
      setKey((lc.blend ??= []), st.f, old + (v - cur) / st.w);
    }
    this.changed();
  }

  // Timeline: move the picked control's key at frame f by delta frames (replacing a key there).
  moveKey(f, delta) {
    if (!this.picked || !delta) return;
    const st = this.store(), curves = this.curvesFor(st, this.picked);
    const from = this.toStore(st, f), to = Math.max(0, this.toStore(st, f + delta));
    if (from === to) return;
    for (const k of Object.keys(curves)) {
      const keys = curves[k].filter((x) => Math.round(x.f) !== to);
      for (const x of keys) if (Math.round(x.f) === from) x.f = to;
      keys.sort((a, b) => a.f - b.f);
      curves[k] = keys;
    }
    this.player.setFrame(this.toStack(st, to));
    this.status(`Moved the ${this.label(this.picked.limb, this.picked.kind)} key (${st.name}) to frame ${this.player.frame}`);
    this.changed();
  }

  // Key a control where its mesh is now.
  key(id, kind, quiet = false) {
    const ch = this.chains();
    if (!ch?.[id]) return;
    const m = this.controls.get(`${id}:${kind}`);
    const v = this.toSpace(this.limb(id).follow, ch, m.position, kind === 'ik' ? m.quaternion : null);
    this.commitLimb(id, kind, v.pos, v.rot, quiet);
  }

  // ---- follow space conversion -----------------------------------------------------------
  // Re-key a limb's controls in another follow space: on every keyed frame the control stays
  // where it was (between keys it now interpolates in the new space). Base and override layer
  // values are positions; additive layer offsets are turned with the space.
  setFollow(id, follow) {
    const ch = this.chains(), l = this.limb(id), old = l.follow ?? 'world';
    if (old === follow) return;
    if (!ch?.[id]) { l.follow = follow; this.changed(); return; }
    const mp = this.motionPanel, f0 = this.player.frame;
    const sets = [{ st: { layer: null }, target: l.target, pole: l.pole, additive: false }];
    for (const [i, layer] of mp.layers.entries()) {
      const c = layer.kind === 'keys' ? layer.rig?.limbs?.[id] : null;
      if (c) sets.push({ st: { layer, i }, target: c.target ?? {}, pole: c.pole ?? {}, additive: layer.blend !== 'override' });
    }
    // Space change at a stack frame: new <- old (a matrix in world terms).
    const change = (f) => {
      this.player.setFrame(f);
      return this.spaceMatrix(follow, ch).invert().multiply(this.spaceMatrix(old, ch));
    };
    let frames = 0;
    for (const s of sets) {
      for (const [curves, kind] of [[s.target, 'ik'], [s.pole, 'pole']]) {
        const pf = keyedFrames(curves, POS), rf = kind === 'ik' ? keyedFrames(curves, ROT) : [];
        const pos = pf.map((f) => { const M = change(this.toStack(s.st, f)), v = evalV(curves, f);
          return s.additive ? v.applyQuaternion(rotOf(M)) : v.applyMatrix4(M); });
        let near = null;
        const rot = rf.map((f) => { const M = change(this.toStack(s.st, f));
          const q = eulerQuat(...evalE(curves, f));
          const e = quatEuler(s.additive ? q : rotOf(M).multiply(q), near ?? evalE(curves, f));
          near = e;
          return e; });
        pf.forEach((f, n) => POS.forEach((k, c) => setKey(curves[k], f, pos[n].getComponent(c))));
        rf.forEach((f, n) => ROT.forEach((k, c) => setKey(curves[k], f, rot[n][c])));
        frames += pf.length + rf.length;
      }
    }
    l.follow = follow;
    this.player.setFrame(f0);
    this.status(`${this.label(id)}: controls now follow ${follow === 'hips' ? 'the hips' : follow === 'root' ? 'the root control' : 'the world'} (${frames} key(s) converted)`);
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

  // Run fn with the character showing the FK pose (of `frames`, or the current frame).
  withFK(arrays, fn, frames = null) {
    const t = this.player.target;
    if (!t || arrays.rotations.length !== t.rotations.length) throw new Error('the FK pose does not match the shown animation (wait for it to update)');
    const keep = [t.rotations, t.translations];
    t.rotations = arrays.rotations;
    t.translations = arrays.translations;
    try {
      if (!frames) { this.player.applyTarget(this.player.frame); return fn(); }
      return frames.map((f) => { this.player.applyTarget(f); return fn(f); });
    } finally {
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
      const fk = await this.fkWorld(id, ch);
      const l = this.limb(id), ik = this.toSpace(l.follow, ch, fk.pos, fk.rot), pole = this.toSpace(l.follow, ch, fk.pole);
      this.commitLimb(id, 'ik', ik.pos, ik.rot, true);
      this.commitLimb(id, 'pole', pole.pos, null, true);
      this.status(`${this.label(id)}: IK control and pole matched to the FK pose at frame ${this.player.frame}`);
    } catch (err) { this.status(`Match IK to FK failed: ${err.message || err}`, true); }
  }

  // FK end joint (position, rotation) and pole of a limb on the current frame (world).
  async fkWorld(id, ch) {
    const arrays = await this.fkArrays();
    return this.withFK(arrays, () => {
      const [a, b, c] = ch[id];
      return { pos: c.bone.getWorldPosition(new THREE.Vector3()), rot: c.bone.getWorldQuaternion(new THREE.Quaternion()), pole: this.defaultPole(a, b, c) };
    });
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
    const p = this.picked, ch = this.chains();
    if (!p || !ch) return;
    if (isBody(p)) { const c = this.bodyComposed(p.kind); this.commitBody(p.kind, c.t, c.q); return; }
    if (!ch[p.limb]) return;
    const v = this.limbValues(p.limb, p.kind, ch);
    this.commitLimb(p.limb, p.kind, v.pos, v.rot);
  }

  deleteKeyAtFrame() {
    if (!this.picked) return;
    const st = this.store(), curves = this.curvesFor(st, this.picked);
    for (const k of Object.keys(curves)) curves[k] = curves[k].filter((x) => Math.round(x.f) !== st.f);
    this.status(`Deleted the ${this.label(this.picked.limb, this.picked.kind)} key at frame ${this.player.frame} (${st.name})`);
    this.changed();
  }

  // Delete every key of the picked control (its limb's IK control and pole) on the selected
  // layer / the base.
  resetLimb() {
    const id = this.picked?.limb;
    if (!id) { this.status('Pick a control first (viewport or Picker)', true); return; }
    const st = this.store();
    if (id === 'body') {
      if (st.layer) delete this.layerRig(st.layer).body?.[this.picked.kind]; else this.body()[this.picked.kind] = {};
      this.status(`${this.label('body', this.picked.kind)}: its keys on ${st.name} are deleted`);
      this.changed();
      return;
    }
    if (st.layer) delete this.layerRig(st.layer).limbs?.[id];
    else { const l = this.limb(id); l.target = {}; l.pole = {}; }
    this.status(`${LIMBS.find((L) => L.id === id).label}: IK control and pole keys on ${st.name} are deleted`);
    this.changed();
  }

  setIK(id, on) {
    this.limb(id).ik = on;
    if (on) this.pick({ limb: id, kind: 'ik' });
    else if (this.picked?.limb === id) this.pick(null);
    this.changed();
  }

  changed() {
    this.stale = true;
    clearTimeout(this.staleTimer); // a failed request must not freeze the controls
    this.staleTimer = setTimeout(() => { this.stale = false; }, 10000);
    this.renderPanel();
    this.motionPanel.renderLayers();
    this.motionPanel.schedule();
  }

  // Frames keyed on the picked control on the selected layer / the base (timeline row).
  pickedKeyFrames() {
    if (!this.picked) return null;
    const st = this.store(), curves = this.curvesFor(st, this.picked);
    const set = new Set();
    for (const keys of Object.values(curves)) for (const k of keys) set.add(this.toStack(st, Math.round(k.f)));
    return { label: `${this.label(this.picked.limb, this.picked.kind)} · ${st.name}`, frames: [...set].sort((a, b) => a - b) };
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
      follow.title = 'What the IK control and the pole follow: World (nothing: planted), Root (the root control) or Hips';
      for (const [v, t] of FOLLOWS) follow.append(new Option(`follows ${t}`, v));
      follow.value = l.follow ?? 'world';
      follow.disabled = !l.ik;
      follow.addEventListener('change', () => this.setFollow(L.id, follow.value));
      const keys = document.createElement('span');
      keys.className = 'keys';
      const nT = new Set(Object.values(l.target).flat().map((k) => Math.round(k.f))).size;
      const nP = new Set(Object.values(l.pole).flat().map((k) => Math.round(k.f))).size;
      const onLayers = this.motionPanel.layers.filter((x) => x.kind === 'keys' && x.rig?.limbs?.[L.id] &&
        (anyKeys(x.rig.limbs[L.id].target) || anyKeys(x.rig.limbs[L.id].pole) || x.rig.limbs[L.id].blend?.length)).map((x) => x.name);
      keys.textContent = !ch[L.id] ? 'chain not found in the mapping' : l.ik ? `base: IK ${nT ? `${nT} key(s)` : 'follows the animation'} · pole ${nP ? `${nP} key(s)` : 'follows'}` +
        (l.blend?.length ? ` · blend ${l.blend.length} key(s)` : '') + (onLayers.length ? ` · layers: ${onLayers.join(', ')}` : '') : 'FK';
      row.addEventListener('click', (e) => { if (e.target === row || e.target === name || e.target === keys) { if (l.ik) this.pick({ limb: L.id, kind: 'ik' }); } });
      const blend = document.createElement('div');
      blend.className = 'rig-blend';
      blend.hidden = !l.ik;
      const fkL = document.createElement('span'); fkL.textContent = 'FK';
      const bv = this.srv()?.limbs[L.id]?.blend ?? this.blendAt(l);
      const slider = document.createElement('input');
      Object.assign(slider, { type: 'range', min: 0, max: 1, step: 0.05, value: bv, title: 'IK/FK blend on this frame (keyed on the selected layer, or the whole animation when the base has no blend keys)' });
      slider.dataset.blend = L.id;
      const ikL = document.createElement('span'); ikL.textContent = 'IK';
      const val = document.createElement('span'); val.className = 'blend-val'; val.textContent = bv.toFixed(2);
      slider.addEventListener('input', () => { val.textContent = Number(slider.value).toFixed(2); });
      slider.addEventListener('change', () => this.commitBlend(L.id, Number(slider.value)));
      const kb = document.createElement('button');
      Object.assign(kb, { type: 'button', className: 'icon-button', textContent: '◆', title: 'Key the IK/FK blend at the current frame (on the selected layer / the base)' });
      kb.addEventListener('click', () => {
        const st = this.store(), v = Number(slider.value);
        if (st.layer) this.commitBlend(L.id, v);
        else { setKey((l.blend ??= []), st.f, v); this.changed(); }
        this.status(`${L.label}: IK/FK blend keyed at frame ${this.player.frame} (${st.name})`);
      });
      const xb = document.createElement('button');
      Object.assign(xb, { type: 'button', className: 'icon-button', textContent: '✕', title: 'Delete the base blend key at the current frame', hidden: !l.blend?.length });
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
    for (const [kind, text, tip] of [['hips', 'Hips', 'Hips box: offset of the hips (IK feet in World stay planted)'], ['root', 'Root', 'Ground circle: offset of the whole character']]) {
      const b = document.createElement('button');
      Object.assign(b, { type: 'button', textContent: text, title: tip, className: isBody(this.picked) && this.picked.kind === kind ? 'on' : '' });
      b.addEventListener('click', () => this.pick({ limb: 'body', kind }));
      bseg.append(b);
    }
    const bkeys = document.createElement('span');
    bkeys.className = 'keys';
    const nk = (c) => new Set(Object.values(c ?? {}).flat().map((k) => Math.round(k.f))).size;
    bkeys.textContent = `base: hips ${nk(this.body().hips) ? `${nk(this.body().hips)} key(s)` : 'no offset'} · root ${nk(this.body().root) ? `${nk(this.body().root)} key(s)` : 'no offset'}`;
    body.append(bname, bseg, document.createElement('span'), bkeys);
    host.prepend(body);
    const st = this.store();
    this.$('rig-selected').textContent = !this.picked ? `Keys go to: ${st.name}`
      : isBody(this.picked) ? `Picked: ${this.label('body', this.picked.kind)} (offset) · keys go to ${st.name}`
      : `Picked: ${this.label(this.picked.limb, this.picked.kind)} (follows ${this.limb(this.picked.limb).follow ?? 'world'}) · keys go to ${st.name}`;
  }

  // Channel box: the picked control's composed values (live while it is dragged); a change keys it.
  channelSpec() {
    const p = this.picked, ch = this.chains();
    if (!p || !(isBody(p) ? ch : ch?.[p.limb])) return null;
    const v = this.currentValues(true);
    if (!v) return null;
    const keys = p.kind === 'pole' ? POS : ALL, st = this.store();
    const keyed = keyedFrames(this.curvesFor(st, p), keys).includes(st.f);
    return {
      id: `rig:${p.limb}:${p.kind}`,
      title: this.label(p.limb, p.kind),
      subtitle: `${isBody(p) ? 'offset' : `follows ${this.limb(p.limb).follow ?? 'world'}`} · keys → ${st.name} · frame ${this.player.frame}${keyed ? ' · keyed' : ''}`,
      channels: keys.map((k) => ({ k, label: LABELS[k], value: v[k] })),
      set: (k, value, final) => {
        if (!final) return;
        const now = this.currentValues();
        if (!now) return;
        now[k] = value;
        this.commitValues(p, now);
      },
      reset: (group) => this.resetChannels(group),
    };
  }

  // Key the picked control at channel values {tx..rz} (composed, follow space / offset).
  commitValues(p, v) {
    const ch = this.chains();
    if (isBody(p)) { this.commitBody(p.kind, new THREE.Vector3(v.tx, v.ty, v.tz), eulerQuat(v.rx, v.ry, v.rz)); return; }
    this.commitLimb(p.limb, p.kind, new THREE.Vector3(v.tx, v.ty, v.tz), p.kind === 'ik' ? eulerQuat(v.rx, v.ry, v.rz) : null);
    if (!ch) return;
  }

  // Channel box Reset: body offsets to 0; limb controls back onto the animation (FK).
  async resetChannels(group) {
    const p = this.picked, ch = this.chains();
    if (!p || !ch) return;
    if (isBody(p)) {
      this.commitBody(p.kind, group === 't' ? new THREE.Vector3() : null, group === 'r' ? new THREE.Quaternion() : null);
      return;
    }
    if (group === 'r' && p.kind === 'pole') return;
    try {
      const fk = await this.fkWorld(p.limb, ch), l = this.limb(p.limb);
      if (p.kind === 'pole') { this.commitLimb(p.limb, 'pole', this.toSpace(l.follow, ch, fk.pole).pos); return; }
      const v = this.toSpace(l.follow, ch, fk.pos, fk.rot);
      this.commitLimb(p.limb, 'ik', group === 't' ? v.pos : null, group === 'r' ? v.rot : null);
      this.status(`${this.label(p.limb, p.kind)}: ${group === 't' ? 'position' : 'rotation'} back on the animation at frame ${this.player.frame}`);
    } catch (err) { this.status(`Reset failed: ${err.message || err}`, true); }
  }

  // Composed values of the picked control on the frame shown, as channels {tx..rz}.
  currentValues(live = false) {
    const p = this.picked, ch = this.chains();
    if (!p || !ch) return null;
    if (isBody(p)) {
      const c = live && this.dragging && this.start ? this.bodyWanted() : this.bodyComposed(p.kind);
      const e = quatEuler(c.q, evalE(this.curvesOf(p), this.player.frame));
      return { tx: c.t.x, ty: c.t.y, tz: c.t.z, rx: e[0], ry: e[1], rz: e[2] };
    }
    if (!ch[p.limb]) return null;
    let v;
    if (live && this.dragging) {
      const m = this.controls.get(`${p.limb}:${p.kind}`);
      v = this.toSpace(this.limb(p.limb).follow, ch, m.position, p.kind === 'ik' ? m.quaternion : null);
    } else v = this.limbValues(p.limb, p.kind, ch);
    const out = { tx: v.pos.x, ty: v.pos.y, tz: v.pos.z };
    if (p.kind === 'ik') { const e = quatEuler(v.rot, evalE(this.curvesOf(p), this.player.frame)); ROT.forEach((k, n) => { out[k] = e[n]; }); }
    return out;
  }

  // Refresh the frame-dependent widgets (blend sliders) when the frame changes.
  syncValues() {
    for (const s of this.$('rig-limbs').querySelectorAll('input[data-blend]')) {
      if (document.activeElement === s) continue;
      const v = this.srv()?.limbs[s.dataset.blend]?.blend ?? this.blendAt(this.limb(s.dataset.blend));
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
