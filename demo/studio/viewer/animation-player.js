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

  get frames() { return this.motion ? this.motion.frames : 0; }
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

  clear() {
    this.motion = null;
    this.playing = false;
    this.group.clear();
    this.view.clear();
    this.joints = [];
    this.skeletonKey = null;
    this.emit();
  }

  setFrame(f) {
    if (!this.motion) return;
    const { root, rotations, joints } = this.motion;
    this.frame = Math.max(0, Math.min(this.frames - 1, Math.round(f)));
    this.time = this.frame / this.fps;
    const r = this.frame * 3;
    this.joints[0].bone.position.set(root[r], root[r + 1], root[r + 2]);
    for (let j = 0; j < joints; j++) {
      const q = (this.frame * joints + j) * 4;
      this.joints[j].bone.quaternion.set(rotations[q], rotations[q + 1], rotations[q + 2], rotations[q + 3]);
    }
    this.group.updateMatrixWorld(true);
    this.view.update();
    this.emit();
  }

  play(on = !this.playing) { this.playing = on && !!this.motion; this.emit(); }

  // Advance by dt seconds (called from the render loop).
  update(dt) {
    if (!this.playing || !this.motion) return;
    let t = this.time + dt;
    if (t > this.duration) {
      if (this.loop && this.duration > 0) t %= this.duration;
      else { t = this.duration; this.playing = false; }
    }
    this.time = t;
    const f = Math.floor(t * this.fps + 1e-6);
    if (f !== this.frame) this.setFrame(f); else this.emit();
  }

  setVisible({ joints, skeleton }) { this.view.setVisible({ joints, skeleton }); }
  onChange(fn) { this.listeners.push(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
}
