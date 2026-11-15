// Skeleton overlay: bone lines plus pickable joint markers drawn on top of the mesh.
import * as THREE from 'three';

const COLOR_MUTED = new THREE.Color(0x5b6b77);
const COLOR_SELECTED = new THREE.Color(0xffb547);

export class SkeletonView {
  // color: joints/bones of this overlay; markerScale: relative marker size.
  constructor(scene, { color = 0x3bd3d0, markerScale = 1 } = {}) {
    this.scene = scene;
    this.color = new THREE.Color(color);
    this.markerScale = markerScale;
    this.group = new THREE.Group();
    this.group.name = 'skeleton-overlay';
    scene.add(this.group);
    this.markers = null;
    this.lines = null;
    this.joints = [];
    this.selected = -1;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._c = new THREE.Vector3();
  }

  setCharacter(character, radius) {
    this.clear();
    this.joints = character ? character.joints : [];
    if (!this.joints.length) return;
    const r = Math.max(radius * 0.012 * this.markerScale, 1e-4);

    const sphere = new THREE.SphereGeometry(r, 12, 8);
    const material = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95 });
    this.markers = new THREE.InstancedMesh(sphere, material, this.joints.length);
    this.markers.renderOrder = 20;
    this.markers.frustumCulled = false;
    for (const j of this.joints) this.markers.setColorAt(j.index, this.baseColor(j));
    this.group.add(this.markers);

    const segments = this.joints.filter((j) => j.parent >= 0).length;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(segments, 1) * 6), 3));
    this.lines = new THREE.LineSegments(geometry,
      new THREE.LineBasicMaterial({ color: this.color, depthTest: false, transparent: true, opacity: 0.8 }));
    this.lines.renderOrder = 19;
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
    this.update();
  }

  clear() {
    for (const o of [this.markers, this.lines]) {
      if (!o) continue;
      this.group.remove(o);
      o.geometry.dispose();
      o.material.dispose();
    }
    this.markers = this.lines = null;
    this.joints = [];
    this.selected = -1;
  }

  setVisible({ joints, skeleton }) {
    if (this.markers) this.markers.visible = joints;
    if (this.lines) this.lines.visible = skeleton;
  }

  baseColor(j) {
    if (this.colorOf) return this.colorOf(j) ?? COLOR_MUTED;
    return j.deforming ? this.color : COLOR_MUTED;
  }

  // Optional per-joint colouring (e.g. a mask preview): fn(joint) -> THREE.Color, or null to reset.
  setJointColors(fn) {
    this.colorOf = fn;
    if (!this.markers) return;
    for (const j of this.joints) this.markers.setColorAt(j.index, j.index === this.selected ? COLOR_SELECTED : this.baseColor(j));
    this.markers.instanceColor.needsUpdate = true;
  }

  select(index) {
    if (!this.markers) return;
    if (this.selected >= 0) {
      const j = this.joints[this.selected];
      this.markers.setColorAt(j.index, this.baseColor(j));
    }
    this.selected = index;
    if (index >= 0) this.markers.setColorAt(index, COLOR_SELECTED);
    this.markers.instanceColor.needsUpdate = true;
  }

  // Follow the bones every frame (they will move once animation playback exists).
  update() {
    if (!this.markers) return;
    const pos = this.lines.geometry.getAttribute('position');
    let s = 0;
    for (const j of this.joints) {
      j.bone.getWorldPosition(this._p);
      const scale = j.index === this.selected ? 1.6 : 1;
      this._m.makeScale(scale, scale, scale).setPosition(this._p);
      this.markers.setMatrixAt(j.index, this._m);
      if (j.parent >= 0) {
        this.joints[j.parent].bone.getWorldPosition(this._c);
        pos.setXYZ(s++, this._c.x, this._c.y, this._c.z);
        pos.setXYZ(s++, this._p.x, this._p.y, this._p.z);
      }
    }
    this.markers.instanceMatrix.needsUpdate = true;
    pos.needsUpdate = true;
  }
}
