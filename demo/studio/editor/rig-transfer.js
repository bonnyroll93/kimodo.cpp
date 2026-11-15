// Changing the character (model / rig) keeps the scene: clips, tracks, timing, root motion
// and paths are rig independent, while anim layers (keys) and custom masks address the
// character's joints by name. They are moved onto the new rig here:
//   * joint names: old joint -> source joint (old mapping) -> new joint (new mapping); else
//     the same name, else the same name without namespace / case / punctuation;
//   * rotations (offsets and override poses alike, both are relative to the joint's rest):
//     re-expressed in the new joint's frame through the rest world rotations,
//     d' = (G_new^-1 G_old) d (G_old^-1 G_new) — the same global-delta rule the retargeter
//     uses — so a bend that looked a certain way on the old rig looks the same on the new one;
//   * translations: through the parents' rest world rotation and scale, scaled by the ratio
//     of the rigs' heights (root offsets of additive layers are in scene space).
// When a joint's frames match (same rig family) its curves are copied unchanged; otherwise
// rotation / translation curves are re-keyed at their key frames with auto tangents.
// Joints without a match keep their keys under the old name (ignored by the new rig, used
// again if you switch back).
import * as THREE from 'three';
import { evaluate, quatEuler, eulerQuat } from '../viewer/keyframes.js';

const ROT = ['rx', 'ry', 'rz'], POS = ['tx', 'ty', 'tz'];
const loose = (n) => n.replace(/^.*[:|]/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Rest-pose frames of a freshly loaded character (bones still at their glTF TRS).
export function rigSnapshot(character) {
  character.root.updateMatrixWorld(true);
  const joints = new Map();
  let lo = Infinity, hi = -Infinity;
  for (const j of character.joints) {
    const parent = j.bone.parent;
    const pos = j.bone.getWorldPosition(new THREE.Vector3());
    lo = Math.min(lo, pos.y);
    hi = Math.max(hi, pos.y);
    joints.set(j.name, {
      root: j.parent < 0,
      q: j.bone.getWorldQuaternion(new THREE.Quaternion()),
      pq: parent ? parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion(),
      ps: parent ? parent.getWorldScale(new THREE.Vector3()).x : 1,
    });
  }
  return { joints, height: Math.max(hi - lo, 1e-6) };
}

// old joint name -> new joint name.
export function jointNameMap(oldRig, newRig, oldMapping, newMapping) {
  const map = new Map();
  const toSource = new Map((oldMapping?.joints ?? []).map((j) => [j.target, j.source]));
  const fromSource = new Map((newMapping?.joints ?? []).map((j) => [j.source, j.target]));
  const byLoose = new Map([...newRig.joints.keys()].map((n) => [loose(n), n]));
  for (const name of oldRig.joints.keys()) {
    const viaSource = fromSource.get(toSource.get(name));
    const m = (viaSource && newRig.joints.has(viaSource) && viaSource) || (newRig.joints.has(name) && name) || byLoose.get(loose(name));
    if (m) map.set(name, m);
  }
  return map;
}

const framesOf = (ch, names) => [...new Set(names.flatMap((c) => (ch[c] ?? []).map((k) => k.f)))].sort((a, b) => a - b);
const interpAt = (ch, names, f) => {
  for (const c of names) { const k = ch[c]?.find((x) => x.f === f); if (k) return k.i ?? 'bezier'; }
  return 'bezier';
};

function convertJoint(ch, from, to, k, additiveRoot) {
  const out = {};
  const C = to.q.clone().invert().multiply(from.q); // G_new^-1 G_old
  const Ci = C.clone().invert();
  const rotSame = C.angleTo(new THREE.Quaternion()) < 1e-4;
  // translation: t_new = R * t, R = P_new^-1 P_old * (s_old / s_new) * k  (root additive: scene space, * k)
  const R = additiveRoot ? new THREE.Quaternion() : to.pq.clone().invert().multiply(from.pq);
  const scale = additiveRoot ? k : (from.ps / to.ps) * k;
  const posSame = R.angleTo(new THREE.Quaternion()) < 1e-4 && Math.abs(scale - 1) < 1e-4;

  if (ROT.some((c) => ch[c]?.length)) {
    if (rotSame) for (const c of ROT) { if (ch[c]) out[c] = structuredClone(ch[c]); }
    else {
      const keys = { rx: [], ry: [], rz: [] };
      let near = [0, 0, 0];
      for (const f of framesOf(ch, ROT)) {
        const q = eulerQuat(...ROT.map((c) => evaluate(ch[c] ?? [], f)));
        const e = quatEuler(C.clone().multiply(q).multiply(Ci), near);
        near = e;
        const i = interpAt(ch, ROT, f);
        ROT.forEach((c, n) => keys[c].push({ f, v: e[n], i, a: true }));
      }
      Object.assign(out, keys);
    }
  }
  if (POS.some((c) => ch[c]?.length)) {
    if (posSame) for (const c of POS) { if (ch[c]) out[c] = structuredClone(ch[c]); }
    else {
      const keys = { tx: [], ty: [], tz: [] };
      for (const f of framesOf(ch, POS)) {
        const v = new THREE.Vector3(...POS.map((c) => evaluate(ch[c] ?? [], f))).applyQuaternion(R).multiplyScalar(scale);
        const i = interpAt(ch, POS, f);
        POS.forEach((c, n) => keys[c].push({ f, v: v.getComponent(n), i, a: true }));
      }
      Object.assign(out, keys);
    }
  }
  return { channels: out, exact: rotSame && posSame };
}

// Moves the anim layers' keys and the custom masks of `layers` (in place) from oldRig to newRig.
export function transferScene(layers, oldRig, newRig, names) {
  const k = newRig.height / oldRig.height;
  const report = { joints: 0, rekeyed: 0, unmapped: new Set(), masks: 0 };
  for (const l of layers) {
    if (l.kind === 'keys' && l.keys?.tracks) {
      const tracks = {};
      for (const [name, ch] of Object.entries(l.keys.tracks)) {
        const target = names.get(name);
        const from = oldRig.joints.get(name), to = target && newRig.joints.get(target);
        if (!from || !to) {
          if (!newRig.joints.has(name)) report.unmapped.add(name);
          tracks[name] ??= ch;
          continue;
        }
        const { channels, exact } = convertJoint(ch, from, to, k, from.root && l.blend !== 'override');
        tracks[target] = channels;
        report.joints++;
        if (!exact) report.rekeyed++;
      }
      l.keys = { ...l.keys, tracks };
    }
    if (l.customMask?.weights) {
      const weights = {};
      for (const [name, w] of Object.entries(l.customMask.weights)) weights[names.get(name) ?? name] = w;
      l.customMask = { ...l.customMask, weights };
      report.masks++;
    }
  }
  return report;
}
