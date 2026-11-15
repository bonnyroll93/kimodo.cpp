// Keyframe editing on a keyframe layer: a rotate/translate gizmo on the selected bone of
// the character, Key / Delete key / Auto key, and the graph editor for its curves.
// Additive anim layers: a gizmo edit changes the layer's offset at the current frame: the new
// rotation offset is R_old * D (D = the bone's local change), the translation offset moves by
// the bone's change (in scene space for the skeleton root). This is exact while the layer is
// the top layer at weight 1 (new anim layers are added on top).
// Override anim layers: the key is the bone's pose itself, relative to its rest pose
// (rotation rest^-1 * local, translation local - rest), so keying captures what you see.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CHANNELS, channelsOf, offsetAt, setKey, keyedJoints, keyFrames, quatEuler, eulerQuat } from '../viewer/keyframes.js';
import { GraphEditor } from './graph-editor.js';
import { skeletonLocal } from '../viewer/model-loader.js';
import { channels } from './channel-box.js';

export class KeyPanel {
  constructor({ $, viewport, player, status, motionPanel, retarget, getCharacter, onSelectJoint }) {
    Object.assign(this, { $, viewport, player, status, motionPanel, retarget, getCharacter, onSelectJoint });
    this.jointIndex = -1;
    this.pending = null;
    this.gizmo = new TransformControls(viewport.camera, viewport.renderer.domElement);
    this.gizmo.setMode('rotate');
    this.gizmo.setSpace('local');
    this.gizmo.setSize(0.8);
    viewport.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      viewport.controls.enabled = !e.value;
      viewport.gizmoDragging = e.value;
      if (e.value) this.dragStart(); else this.dragEnd();
    });

    this.graph = new GraphEditor($('graph-editor'), {
      tracks: () => this.tracks(),
      joint: () => this.jointName(),
      frame: () => this.kf(),
      frames: () => Math.max(1, Math.ceil(this.motionPanel.keyFrame(this.player.frames || 90))),
      seek: (f) => { this.player.play(false); this.player.setFrame(this.motionPanel.stackFrame(f)); },
      changed: (final) => { if (final) this.edited(); },
    });
    $('graph-close').addEventListener('click', () => this.toggleGraph(false));
    $('key-graph').addEventListener('click', () => this.toggleGraph(!this.graph.open));
    $('key-rotate').addEventListener('click', () => this.setMode('rotate'));
    $('key-translate').addEventListener('click', () => this.setMode('translate'));
    $('key-set').addEventListener('click', () => this.keyCurrent());
    $('key-delete').addEventListener('click', () => this.deleteKeyAtFrame());
    $('key-auto').addEventListener('change', () => { if ($('key-auto').checked && this.pending) this.keyCurrent(); });
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'e' || e.key === 'E') this.setMode('rotate');
      if (e.key === 'w' || e.key === 'W') this.setMode('translate');
      if (e.key === 'k' || e.key === 'K') this.keyCurrent();
    });
    player.onChange(() => { if (this.graph.open) this.graph.draw(); this.updateInfo(); });
  }

  get active() { return this.motionPanel.activeLayer?.kind === 'keys'; }
  // Current frame in the anim layer's own time (bound layers: the clip's time).
  kf() { return Math.round(this.motionPanel.keyFrame(this.player.frame)); }
  get override() { return this.active && this.motionPanel.activeLayer.blend === 'override'; }
  // Override key values of the joint's current pose (near: the previous Euler, for continuity).
  poseValues(j, near = { rx: 0, ry: 0, rz: 0 }) {
    const character = this.getCharacter();
    character.root.updateMatrixWorld(true);
    const local = skeletonLocal(character, j); // kmd-anim joint space (the root includes its Armature)
    const q = j.rest.q.clone().invert().multiply(local.q);
    const [rx, ry, rz] = quatEuler(q, [near.rx, near.ry, near.rz]);
    const t = local.p.clone().sub(j.rest.p);
    return { rx, ry, rz, tx: t.x, ty: t.y, tz: t.z };
  }
  tracks() { return this.active ? this.motionPanel.activeLayer.keys : null; }
  joint() { return this.getCharacter()?.joints[this.jointIndex] ?? null; }
  jointName() { return this.joint()?.name ?? null; }

  setMode(mode) {
    this.gizmo.setMode(mode);
    this.$('key-rotate').classList.toggle('on', mode === 'rotate');
    this.$('key-translate').classList.toggle('on', mode === 'translate');
  }

  setJoint(index) {
    this.jointIndex = index;
    this.pending = null;
    this.sync();
    this.motionPanel.refreshKeyTicks();
  }

  toggleGraph(on) {
    this.graph.show(on);
    this.$('key-graph').classList.toggle('on', on);
    this.$('stage-root').classList.toggle('graph-open', on);
  }

  // Show/hide the panel and attach the gizmo according to the active layer and selection.
  sync() {
    const on = this.active;
    this.$('key-panel').hidden = !on;
    const canEdit = on && this.retarget.enabled && this.joint() && !this.blocked?.();
    if (canEdit) this.gizmo.attach(this.joint().bone); else this.gizmo.detach();
    if (!on && this.graph.open) this.toggleGraph(false);
    this.updateInfo();
    if (this.graph.open) this.graph.fit();
  }

  updateInfo() {
    if (!this.active) return;
    const $ = this.$;
    const name = this.jointName();
    if (!this.retarget.enabled) $('key-joint').textContent = 'Load a character and enable "Retarget onto character" to pose bones.';
    else $('key-joint').textContent = name ? name : 'Select a joint (viewport or hierarchy).';
    const t = this.tracks();
    const o = name ? offsetAt(t, name, this.kf()) : null;
    $('key-values').textContent = o
      ? `${this.override ? 'pose (override)' : 'offset'} · rot ${o.rx.toFixed(1)}° ${o.ry.toFixed(1)}° ${o.rz.toFixed(1)}° · move ${o.tx.toFixed(3)} ${o.ty.toFixed(3)} ${o.tz.toFixed(3)}` +
        (keyFrames(t, name).includes(this.kf()) ? ' · keyed' : '') + (this.pending ? ' · unkeyed change: press Key' : '')
      : '';
    const list = $('key-joints');
    list.replaceChildren();
    for (const j of keyedJoints(t)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `icon-button${j === name ? ' on' : ''}`;
      b.textContent = `${j} (${keyFrames(t, j).length})`;
      b.addEventListener('click', () => {
        const i = this.getCharacter()?.joints.findIndex((x) => x.name === j) ?? -1;
        if (i >= 0) this.onSelectJoint(i);
      });
      list.append(b);
    }
  }

  // ---- gizmo edits ---------------------------------------------------------------------
  dragStart() {
    this.player.play(false);
    const bone = this.joint().bone;
    this.start = { q: bone.quaternion.clone(), p: bone.position.clone(), world: bone.getWorldPosition(new THREE.Vector3()) };
  }

  dragEnd() {
    const j = this.joint();
    if (!j || !this.start) return;
    const bone = j.bone;
    const D = this.start.q.clone().invert().multiply(bone.quaternion);
    // Translation change in the joint's parent space; for the skeleton root, scene space.
    const delta = j.parent < 0
      ? bone.getWorldPosition(new THREE.Vector3()).sub(this.start.world)
      : bone.position.clone().sub(this.start.p);
    const name = j.name, f = this.kf();
    const o = this.pending?.frame === f ? this.pending.values : offsetAt(this.tracks(), name, f);
    if (this.override) {
      this.pending = { joint: name, frame: f, values: this.poseValues(j, o), translated: delta.lengthSq() > 1e-12 };
      this.start = null;
      if (this.$('key-auto').checked) this.keyCurrent();
      else this.updateInfo();
      return;
    }
    // Additive: the gizmo moved the bone from the pose on screen, so the new offset is the offset
    // that pose was computed with (keys as shown, which may be older than the edited keys while
    // a result is on its way) times the change.
    const shown = this.pending?.frame === f ? null : this.motionPanel.shownKeysOf(this.motionPanel.activeLayer);
    const base = shown ? offsetAt(shown, name, f) : o;
    const rot = eulerQuat(base.rx, base.ry, base.rz).multiply(D);
    const [rx, ry, rz] = quatEuler(rot, [base.rx, base.ry, base.rz]);
    this.pending = { joint: name, frame: f, values: { rx, ry, rz, tx: base.tx + delta.x, ty: base.ty + delta.y, tz: base.tz + delta.z },
      translated: delta.lengthSq() > 1e-12 };
    this.start = null;
    if (this.$('key-auto').checked) this.keyCurrent();
    else this.updateInfo();
  }

  // Channel box: the selected joint's key values at this frame (Additive: offset; Override: the
  // pose); a change keys the joint.
  channelSpec() {
    if (!this.active || !this.retarget.enabled || this.blocked?.()) return null;
    const j = this.joint();
    if (!j) return null;
    const t = this.tracks(), f = this.kf(), name = j.name, frames = keyFrames(t, name);
    const values = this.pending?.joint === name && this.pending.frame === f ? this.pending.values
      : this.override && !frames.length ? this.poseValues(j) : offsetAt(t, name, f);
    return {
      id: `key:${name}`,
      title: name,
      subtitle: `${this.override ? 'pose (override)' : 'offset (additive)'} · ${this.motionPanel.activeLayer.name} · frame ${f + 1}${frames.includes(f) ? ' · keyed' : this.pending ? ' · unkeyed change' : ''}`,
      channels: channels(values, ['tx', 'ty', 'tz', 'rx', 'ry', 'rz']),
      set: (k, v, final) => {
        if (!final) return;
        this.pending = { joint: name, frame: f, values: { ...values, [k]: v }, translated: k[0] === 't' || !!this.pending?.translated };
        this.keyCurrent();
      },
    };
  }

  // Key the selected joint at the current frame (the pending gizmo edit, or the current values).
  keyCurrent() {
    const name = this.jointName(), t = this.tracks();
    if (!name || !t) return;
    const f = this.kf();
    const p = this.pending && this.pending.joint === name && this.pending.frame === f ? this.pending : null;
    // Override: without a gizmo edit, key the pose as shown (what the clips give an unkeyed joint).
    const values = p ? p.values : this.override && this.joint() ? this.poseValues(this.joint(), offsetAt(t, name, f)) : offsetAt(t, name, f);
    const ch = channelsOf(t, name);
    for (const c of ['rx', 'ry', 'rz']) setKey(ch[c], f, values[c]);
    // Translation is keyed once it is used (moved now, or already animated).
    if (p?.translated || ['tx', 'ty', 'tz'].some((c) => ch[c].length))
      for (const c of ['tx', 'ty', 'tz']) setKey(ch[c], f, values[c]);
    for (const c of CHANNELS) if (!ch[c].length) delete ch[c];
    this.pending = null;
    this.edited();
    this.status(`Keyed ${name} at frame ${f + 1}`);
  }

  deleteKeyAtFrame() {
    const name = this.jointName(), t = this.tracks();
    const ch = t?.tracks?.[name];
    if (!ch) return;
    const f = this.kf();
    for (const c of CHANNELS) if (ch[c]) ch[c] = ch[c].filter((k) => Math.round(k.f) !== f);
    for (const c of CHANNELS) if (!ch[c]?.length) delete ch[c];
    if (!Object.keys(ch).length) delete t.tracks[name];
    this.pending = null;
    this.edited();
  }

  edited() {
    this.updateInfo();
    this.motionPanel.refreshKeyTicks();
    if (this.graph.open) this.graph.draw();
    this.motionPanel.schedule();
  }
}
