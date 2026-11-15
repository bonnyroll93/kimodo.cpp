// Plays a Kimodo native motion (root_positions [T,3] + local rotations xyzw [T,J,4]) on a
// bone hierarchy built from the native skeleton definition. Playback runs locally from the
// arrays already received; nothing is requested per frame.
import * as THREE from 'three';
import { SkeletonView } from './skeleton-view.js';

export class AnimationPlayer {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'kimodo-motion';
    scene.add(this.group);
    this.view = new SkeletonView(scene, { color: 0x9f7aea, markerScale: 0.8 });
    this.joints = [];
    this.motion = null;
    this.frame = 0;
    this.time = 0;
    this.playing = false;
    this.loop = true;
    this.listeners = [];
  }

  // Timeline length: the source motion, the character track (a layer stack may be longer)
  // or an animation embedded in the loaded GLB.
  get frames() { return Math.max(this.motion?.frames ?? 0, this.motion ? this.target?.frames ?? 0 : 0, this.embedded?.frames ?? 0); }
  get fps() { return this.motion ? this.motion.fps : 30; }
  get duration() { return this.frames > 1 ? (this.frames - 1) / this.fps : 0; }

  // def: { key, names, parents, offsets } from /api/skeletons/<key>.
  setSkeleton(def) {
    if (this.skeletonKey === def.key) return;
    this.group.clear();
    this.joints = def.names.map((name, index) => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.position.fromArray(def.offsets[index]);
      return { bone, index, parent: def.parents[index], name, deforming: true, children: [] };
    });
    for (const j of this.joints) {
      if (j.parent >= 0) {
        this.joints[j.parent].bone.add(j.bone);
        this.joints[j.parent].children.push(j.index);
      } else {
        this.group.add(j.bone);
      }
    }
    this.skeletonKey = def.key;
    this.view.setCharacter(this, 1.8);
  }

  setMotion({ root, rotations, fps = 30 }) {
    const frames = root.length / 3;
    const joints = rotations.length / (frames * 4);
    if (!Number.isInteger(frames) || joints !== this.joints.length)
      throw new Error(`motion has ${joints} joints, skeleton has ${this.joints.length}`);
    this.motion = { root, rotations, frames, joints, fps };
    this.setFrame(Math.min(this.frame, frames - 1));
  }

  // Plays an animation stored in the character's GLB (e.g. a reopened export) with
  // three.js' AnimationMixer, driven by the same timeline (sampled at 30 fps).
  setEmbedded(embedded) {
    if (this.embedded) {
      this.embedded.mixer.stopAllAction();
      this.embedded.mixer.uncacheRoot(this.embedded.character.root);
      this.embedded.character.root.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.pose(); });
    }
    this.embedded = null;
    if (embedded) {
      const mixer = new THREE.AnimationMixer(embedded.character.root);
      const action = mixer.clipAction(embedded.clip);
      action.play();
      this.embedded = { ...embedded, mixer, action, frames: Math.round(embedded.clip.duration * 30) + 1 };
    }
    this.frame = 0;
    this.setFrame(0);
    this.emit();
  }

  clear() {
    this.setEmbedded(null);
    this.setTarget(null);
    this.motion = null;
    this.playing = false;
    this.group.clear();
    this.view.clear();
    this.joints = [];
    this.skeletonKey = null;
    this.emit();
  }

  // Retargeted clip for a loaded character: meta from retarget.json, rotations [T,J,4] and
  // translations [T,J,3] in the target skeleton's order. Joints are matched to the
  // character's bones by glTF node index. Pass null to stop driving the character.
  setTarget(target) {
    if (this.target) this.restoreTarget();
    this.target = null;
    if (target) {
      const byNode = new Map(target.character.joints.map((j) => [j.nodeIndex, j]));
      const joints = target.meta.joints.map((mj, i) => {
        const cj = byNode.get(mj.source_node);
        return { bone: cj?.bone ?? null, parent: mj.parent, scale: new THREE.Vector3().fromArray(mj.scale ?? [1, 1, 1]), index: i };
      });
      for (const j of joints) {
        // Bones whose three.js parent is the parent joint's bone take local values directly;
        // others (the root under an Armature node) are solved from the global transform.
        j.direct = !!j.bone && j.parent >= 0 && joints[j.parent].bone === j.bone.parent;
      }
      const rest = joints.map((j) => j.bone && { p: j.bone.position.clone(), q: j.bone.quaternion.clone(), s: j.bone.scale.clone() });
      this.target = { ...target, joints, rest, frames: target.meta.frames };
      this._local = joints.map(() => new THREE.Matrix4());
      this._global = joints.map(() => new THREE.Matrix4());
    }
    this.setFrame(this.frame);
  }

  restoreTarget() {
    const t = this.target;
    if (!t) return;
    t.joints.forEach((j, i) => {
      if (!j.bone) return;
      j.bone.position.copy(t.rest[i].p);
      j.bone.quaternion.copy(t.rest[i].q);
      j.bone.scale.copy(t.rest[i].s);
    });
    t.character.root.updateMatrixWorld(true);
  }

  applyTarget(frame) {
    const t = this.target;
    if (!t || frame >= t.frames) return;
    const n = t.joints.length;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
    const sceneWorld = t.character.root.matrixWorld;
    const inv = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const j = t.joints[i];
      const r = (frame * n + i) * 4, p = (frame * n + i) * 3;
      quat.set(t.rotations[r], t.rotations[r + 1], t.rotations[r + 2], t.rotations[r + 3]);
      pos.set(t.translations[p], t.translations[p + 1], t.translations[p + 2]);
      this._local[i].compose(pos, quat, j.scale);
      if (j.parent >= 0) this._global[i].multiplyMatrices(this._global[j.parent], this._local[i]);
      else this._global[i].multiplyMatrices(sceneWorld, this._local[i]); // skeleton space = scene space
      if (!j.bone) continue;
      if (j.direct) {
        j.bone.position.copy(pos);
        j.bone.quaternion.copy(quat);
        j.bone.scale.copy(j.scale);
      } else {
        j.bone.parent.updateWorldMatrix(true, false);
        inv.copy(j.bone.parent.matrixWorld).invert().multiply(this._global[i]);
        inv.decompose(j.bone.position, j.bone.quaternion, j.bone.scale);
      }
    }
    t.character.root.updateMatrixWorld(true);
  }

  setFrame(f) {
    if (!this.frames) return;
    this.frame = Math.max(0, Math.min(this.frames - 1, Math.round(f)));
    this.time = this.frame / this.fps;
    if (this.embedded) {
      this.embedded.mixer.setTime(this.time);
      this.embedded.character.root.updateMatrixWorld(true);
    }
    if (!this.motion) { this.emit(); return; }
    const { root, rotations, joints } = this.motion;
    const mf = Math.min(this.frame, this.motion.frames - 1); // source motion holds its last frame
    const r = mf * 3;
    this.joints[0].bone.position.set(root[r], root[r + 1], root[r + 2]);
    for (let j = 0; j < joints; j++) {
      const q = (mf * joints + j) * 4;
      this.joints[j].bone.quaternion.set(rotations[q], rotations[q + 1], rotations[q + 2], rotations[q + 3]);
    }
    this.group.updateMatrixWorld(true);
    this.view.update();
    this.applyTarget(this.frame);
    this.emit();
  }

  play(on = !this.playing) { this.playing = on && this.frames > 0; this.emit(); }

  // Advance by dt seconds (called from the render loop).
  update(dt) {
    if (!this.playing || !this.frames) return;
    let t = this.time + dt;
    if (t > this.duration) {
      if (this.loop && this.duration > 0) t %= this.duration;
      else { t = this.duration; this.playing = false; }
    }
    this.time = t;
    const f = Math.floor(t * this.fps + 1e-6);
    if (f !== this.frame) this.setFrame(f); else this.emit();
  }

  setVisible({ joints, skeleton, source = true }) {
    this.view.setVisible({ joints: joints && source, skeleton: skeleton && source });
  }
  onChange(fn) { this.listeners.push(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
}
