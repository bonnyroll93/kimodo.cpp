// Pose tools (Animate › Rig › Pose): copy the character's pose on the frame shown, paste it on
// another frame, paste it mirrored, or mirror the pose in place. Pasting keys the joints on the
// selected anim layer (Override: the pose itself; Additive: the offset that turns the pose
// shown into the pasted one, exact for the top layer at weight 1), so it is FK posing like the
// gizmo: IK limbs (control rig) still follow their controls.
//   * Scope: every joint, or the selected joint's branch (copy a left arm, paste it mirrored
//     onto the right one).
//   * Mirror: left and right joints are paired by name (Left/Right, L/R, l/r prefixes and
//     suffixes); the pose is reflected across the character's YZ plane (skeleton space x -> -x),
//     as rotations from the rest pose, so the rest pose must be symmetric (a T- or A-pose).
//   * The skeleton root keeps its place on the destination frame: only its height is pasted.
import * as THREE from 'three';
import { offsetAt, channelsOf, setKey, quatEuler, eulerQuat, CHANNELS } from '../viewer/keyframes.js';
import { skeletonLocal } from '../viewer/model-loader.js';

const PAIRS = [[/Left/g, 'Right'], [/Right/g, 'Left'], [/left/g, 'right'], [/right/g, 'left'], [/LEFT/g, 'RIGHT'], [/RIGHT/g, 'LEFT'],
  [/^L(?=[_.\-A-Z])/, 'R'], [/^R(?=[_.\-A-Z])/, 'L'], [/^l(?=[_.\-])/, 'r'], [/^r(?=[_.\-])/, 'l'],
  [/([_.\-])L$/, '$1R'], [/([_.\-])R$/, '$1L'], [/([_.\-])l$/, '$1r'], [/([_.\-])r$/, '$1l'],
  [/([_.\-])L([_.\-])/, '$1R$2'], [/([_.\-])R([_.\-])/, '$1L$2']];

// The joint mirroring `name` (itself for a centre joint).
export function mirrorName(name, names) {
  for (const [re, to] of PAIRS) {
    re.lastIndex = 0;
    if (!re.test(name)) continue;
    re.lastIndex = 0;
    const m = name.replace(re, to);
    if (m !== name && names.has(m)) return m;
  }
  return name;
}

// Reflection across the YZ plane of a rotation: (x, y, z, w) -> (x, -y, -z, w).
const mirrorQ = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);

export class PoseTools {
  constructor({ $, player, motionPanel, status, getCharacter, selectedJoint }) {
    Object.assign(this, { $, player, motionPanel, status, getCharacter, selectedJoint });
    this.clip = null; // copied pose
    $('pose-copy').addEventListener('click', () => this.copy());
    $('pose-paste').addEventListener('click', () => this.paste(false));
    $('pose-paste-mirror').addEventListener('click', () => this.paste(true));
    $('pose-mirror').addEventListener('click', () => { if (this.copy(true)) this.paste(true); });
  }

  // Joints in scope: all, or the selected joint and its descendants.
  scope(character) {
    if (this.$('pose-scope').value !== 'branch') return character.joints;
    const sel = this.selectedJoint();
    if (sel < 0) return null;
    const inBranch = (j) => { for (let k = j.index; k >= 0; k = character.joints[k].parent) if (k === sel) return true; return false; };
    return character.joints.filter(inBranch);
  }

  // Rest globals (rotation) in skeleton space, from the rest locals.
  restGlobals(character) {
    const g = [];
    const of = (j) => (g[j.index] ??= j.parent < 0 ? j.rest.q.clone() : of(character.joints[j.parent]).clone().multiply(j.rest.q));
    for (const j of character.joints) of(j);
    return g;
  }

  shownLocals(character) {
    character.root.updateMatrixWorld(true);
    return character.joints.map((j) => skeletonLocal(character, j));
  }

  copy(quiet = false) {
    const character = this.getCharacter();
    if (!character) { this.status('Load a character first', true); return false; }
    const joints = this.scope(character);
    if (!joints) { this.status('Select a joint for the "Selected branch" scope', true); return false; }
    const locals = this.shownLocals(character);
    const globals = [];
    const of = (j) => (globals[j.index] ??= j.parent < 0 ? locals[j.index].q.clone() : of(character.joints[j.parent]).clone().multiply(locals[j.index].q));
    for (const j of character.joints) of(j);
    const rest = this.restGlobals(character);
    this.clip = {
      frame: this.player.frame,
      joints: joints.map((j) => ({ name: j.name, index: j.index, local: locals[j.index].q.clone(), p: locals[j.index].p.clone(),
        delta: globals[j.index].clone().multiply(rest[j.index].clone().invert()) })), // world-space change from rest
    };
    if (!quiet) this.status(`Copied the pose of ${joints.length} joint(s) at frame ${this.player.frame}`);
    this.$('pose-paste').disabled = this.$('pose-paste-mirror').disabled = false;
    return true;
  }

  paste(mirror) {
    const character = this.getCharacter(), mp = this.motionPanel, layer = mp.activeLayer;
    if (!character || !this.clip) { this.status('Copy a pose first', true); return; }
    if (layer?.kind !== 'keys') { this.status('Select an anim layer (Anim layers › + Keys) to paste the pose on', true); return; }
    this.player.play(false);
    const names = new Set(character.joints.map((j) => j.name));
    const byName = new Map(character.joints.map((j) => [j.name, j]));
    const shown = this.shownLocals(character);
    // Wanted local rotations (and root heights) of the destination joints.
    const want = new Map();
    if (!mirror) {
      for (const c of this.clip.joints) if (byName.has(c.name)) want.set(c.name, { q: c.local.clone(), p: c.p.clone() });
    } else {
      const rest = this.restGlobals(character), wantG = new Map();
      for (const c of this.clip.joints) {
        const m = byName.get(mirrorName(c.name, names));
        if (m) wantG.set(m.index, { g: mirrorQ(c.delta).multiply(rest[m.index]), p: c.p.clone() });
      }
      // Locals from globals, parents first (joints outside the paste keep their shown local).
      const G = [];
      const of = (j) => {
        if (G[j.index]) return G[j.index];
        const w = wantG.get(j.index);
        return (G[j.index] = w ? w.g.clone() : j.parent < 0 ? shown[j.index].q.clone() : of(character.joints[j.parent]).clone().multiply(shown[j.index].q));
      };
      for (const j of character.joints) of(j);
      for (const [i, w] of wantG) {
        const j = character.joints[i];
        const parentG = j.parent < 0 ? new THREE.Quaternion() : G[j.parent];
        want.set(j.name, { q: parentG.clone().invert().multiply(G[i]), p: w.p });
      }
    }
    const override = layer.blend === 'override', kf = Math.round(mp.keyFrame(this.player.frame));
    const t = layer.keys, base = mp.shownKeysOf?.(layer) ?? t;
    let n = 0;
    for (const [name, w] of want) {
      const j = byName.get(name), s = shown[j.index], o = offsetAt(base, name, kf);
      const q = override ? j.rest.q.clone().invert().multiply(w.q) : eulerQuat(o.rx, o.ry, o.rz).multiply(s.q.clone().invert().multiply(w.q));
      const e = quatEuler(q, [o.rx, o.ry, o.rz]);
      const ch = channelsOf(t, name);
      ['rx', 'ry', 'rz'].forEach((k, i) => setKey(ch[k], kf, e[i]));
      if (j.parent < 0) { // the root: only its height (it keeps its place on this frame)
        const p = new THREE.Vector3(s.p.x, w.p.y, s.p.z);
        const v = override ? p.sub(j.rest.p) : new THREE.Vector3(o.tx, o.ty + (w.p.y - s.p.y), o.tz);
        if (override || Math.abs(w.p.y - s.p.y) > 1e-6 || ch.tx.length) { setKey(ch.tx, kf, v.x); setKey(ch.ty, kf, v.y); setKey(ch.tz, kf, v.z); }
      }
      for (const c of CHANNELS) if (!ch[c].length) delete ch[c];
      n++;
    }
    mp.refreshKeyTicks();
    mp.schedule();
    this.onKeyed?.();
    this.status(`${mirror ? 'Pasted mirrored' : 'Pasted'}: ${n} joint(s) keyed on "${layer.name}" at frame ${kf + 1}`);
  }
}
