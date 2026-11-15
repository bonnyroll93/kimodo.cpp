// Edit T-pose mode: hand-tune the character's T-pose (the pose that corresponds to the
// source skeleton's rest T-pose) to improve the retargeting.
// The character (mesh + skeleton) is shown in its current T-pose — the saved one, else the
// automatic alignment — with the source skeleton in its T-pose overlaid on it (same hips,
// scaled to the character's hip height, turned to its facing). Select a bone (viewport or
// hierarchy) and rotate it with the gizmo (E). Save stores the pose as the character's
// reference pose (kimodo-reference-pose JSON, kmd-anim --reference-pose): every retarget,
// layer stack and export then uses it. Download / Load exchange the JSON.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { poseCharacter, restoreBindPose } from './bind-pose.js';
import { skeletonLocal } from '../viewer/model-loader.js';

export class TPoseEditor {
  constructor({ $, viewport, player, retarget, status, getCharacter, applyVisibility }) {
    Object.assign(this, { $, viewport, player, retarget, status, getCharacter, applyVisibility });
    this.active = false;
    this.joint = -1;
    this.gizmo = new TransformControls(viewport.camera, viewport.renderer.domElement);
    this.gizmo.setMode('rotate');
    this.gizmo.setSpace('local');
    this.gizmo.setSize(0.8);
    viewport.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      viewport.controls.enabled = !e.value;
      viewport.gizmoDragging = e.value;
      if (!e.value) this.dirty = true;
    });
    $('edit-tpose').addEventListener('click', () => this.enter().catch((e) => { this.exit(false); status(`Edit T-pose: ${e.message || e}`, true); }));
    $('tpose-save').addEventListener('click', () => this.save());
    $('tpose-cancel').addEventListener('click', () => this.exit(false));
    $('tpose-auto').addEventListener('click', () => this.loadPose(null).catch((e) => status(`T-pose: ${e.message || e}`, true)));
    $('tpose-download').addEventListener('click', () => this.download());
    $('tpose-load').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const pose = JSON.parse(await file.text());
        if (!pose || typeof pose.joints !== 'object') throw new Error('not a kimodo reference pose');
        await this.loadPose(pose);
        this.dirty = true;
      } catch (err) { status(`Cannot load the T-pose: ${err.message || err}`, true); }
    });
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Escape') this.exit(false);
    });
  }

  setJoint(i) {
    this.joint = i;
    if (!this.active) return;
    const j = this.getCharacter()?.joints[i];
    if (j) this.gizmo.attach(j.bone); else this.gizmo.detach();
    this.$('tpose-joint').textContent = j ? j.name : 'select a bone (viewport or hierarchy) to rotate it';
  }

  async enter() {
    const character = this.getCharacter(), rt = this.retarget;
    if (!character?.joints.length) throw new Error('load a rigged character first');
    if (!rt.skeletonKey) throw new Error('load a motion first (its skeleton gives the source T-pose)');
    this.player.play(false);
    this.active = true;
    this.$('stage-root').classList.add('tpose-editing');
    this.$('tpose-bar').hidden = false;
    this.player.setTarget(null); // stop driving the character while editing
    await this.loadPose(rt.referencePose ?? null);
    this.dirty = false;
    this.player.setVisible({ joints: true, skeleton: true, source: true });
    this.setJoint(this.joint);
    this.status('Edit T-pose: rotate bones so the character matches the source T-pose (purple), then Save');
  }

  // Shows `pose` (null: the automatic alignment) on the character and the source T-pose over it.
  async loadPose(pose) {
    const rt = this.retarget, character = this.getCharacter();
    const body = { character: await rt.ensureCharacterId(), skeleton: rt.skeletonKey, mapping: await rt.ensureMapping(),
      ...(pose ? { reference_pose: pose } : {}) };
    const r = await fetch('/api/retarget/tpose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
    const rot = new Float32Array(await (await fetch(res.rotations)).arrayBuffer());
    restoreBindPose(character);
    poseCharacter(character, res.meta, rot);
    this.meta = res.meta;
    this.overlaySource(res.meta);
    this.$('tpose-source').textContent = pose ? 'starting from the saved T-pose' : 'starting from the automatic T-pose';
  }

  // The source skeleton at rest (T-pose), on the character's hips, scaled and turned like it.
  overlaySource(meta) {
    const p = this.player, character = this.getCharacter();
    if (!p.joints.length) return;
    const group = p.group;
    group.position.set(0, 0, 0); group.quaternion.identity(); group.scale.setScalar(1);
    for (const j of p.joints) j.bone.quaternion.identity();
    group.updateMatrixWorld(true);
    const height = (bones) => {
      let lo = Infinity;
      for (const b of bones) lo = Math.min(lo, b.getWorldPosition(new THREE.Vector3()).y);
      return lo;
    };
    const srcHips = p.joints[0].bone.getWorldPosition(new THREE.Vector3());
    const srcHip = srcHips.y - height(p.joints.map((j) => j.bone));
    const hipsName = (this.retarget.mapping?.joints ?? []).find((m) => m.source === p.joints[0].name)?.target;
    const hips = character.joints.find((j) => j.name === hipsName) ?? character.joints[0];
    character.root.updateMatrixWorld(true);
    const tgtHips = hips.bone.getWorldPosition(new THREE.Vector3());
    const tgtHip = tgtHips.y - height(character.joints.map((j) => j.bone));
    const k = srcHip > 1e-4 && tgtHip > 1e-4 ? tgtHip / srcHip : 1;
    group.scale.setScalar(k);
    group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ((meta.facing_yaw_degrees ?? 0) * Math.PI) / 180);
    group.updateMatrixWorld(true);
    const now = p.joints[0].bone.getWorldPosition(new THREE.Vector3());
    group.position.copy(tgtHips.sub(now));
    group.updateMatrixWorld(true);
    p.view.update();
  }

  pose() {
    const character = this.getCharacter();
    character.root.updateMatrixWorld(true);
    const joints = {};
    for (const j of character.joints) joints[j.name] = skeletonLocal(character, j).q.toArray().map((v) => Math.round(v * 1e6) / 1e6);
    return { format: 'kimodo-reference-pose', version: 1, name: `${character.name} T-pose`, joints };
  }

  save() {
    if (!this.active) return;
    this.retarget.setReferencePose(this.pose());
    this.exit(true);
    this.status('T-pose saved: retargeting now starts from it (Retarget panel: "Use automatic" to go back)');
  }

  download() {
    const blob = new Blob([JSON.stringify(this.pose(), null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.getCharacter().name.replace(/\.[^.]+$/, '')}.tpose.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  exit(saved) {
    if (!this.active) return;
    if (!saved && this.dirty) this.status('T-pose edits discarded');
    this.active = false;
    this.gizmo.detach();
    this.$('stage-root').classList.remove('tpose-editing');
    this.$('tpose-bar').hidden = true;
    const g = this.player.group;
    g.position.set(0, 0, 0); g.quaternion.identity(); g.scale.setScalar(1);
    const character = this.getCharacter();
    if (character) restoreBindPose(character);
    this.applyVisibility();
    this.onExit?.(saved); // re-apply the motion (the character is driven again)
  }
}
