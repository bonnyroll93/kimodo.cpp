// Ground overlays: the evaluated MotionPath (as computed by kmd-anim), its waypoints, and
// the root trajectory of the source and of the processed motion.
import * as THREE from 'three';

const LIFT = 0.003; // keep lines just above the grid

function line(points, color, opacity, dashed = false) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = dashed
    ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.06, gapSize: 0.05, depthWrite: false })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const l = new THREE.Line(geometry, material);
  if (dashed) l.computeLineDistances();
  l.renderOrder = 5;
  return l;
}

// map: (x, z) in source space -> [x, z] in display space (identity, or into a retargeted
// character's space); ground: display height of the floor.
function groundPoints(arr, map, ground, lift = LIFT) {
  const pts = [];
  for (let i = 0; i < arr.length; i += 3) {
    const [x, z] = map(arr[i], arr[i + 2]);
    pts.push(new THREE.Vector3(x, ground + lift, z));
  }
  return pts;
}

export class MotionPathView {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'motion-path';
    scene.add(this.group);
  }

  clear() {
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.group.clear();
    this.contacts = null;
  }

  // samples: Float32Array [N,3] or null; waypoints: [[x,y,z]]; sourceRoot/resultRoot: Float32Array [T,3].
  show({ samples = null, waypoints = [], sourceRoot = null, resultRoot = null, map = (x, z) => [x, z], ground = 0 }) {
    this.clear();
    if (sourceRoot) this.group.add(line(groundPoints(sourceRoot, map, ground), 0x8b9aa5, 0.55, true));
    if (samples && samples.length >= 6) this.group.add(line(groundPoints(samples, map, ground, LIFT * 2), 0x3bd3d0, 0.95));
    if (resultRoot) this.group.add(line(groundPoints(resultRoot, map, ground), 0x9f7aea, 0.9));
    if (waypoints.length) {
      const geo = new THREE.CylinderGeometry(0.04, 0.04, 0.01, 20);
      const mat = new THREE.MeshBasicMaterial({ color: 0x3bd3d0 });
      const first = new THREE.MeshBasicMaterial({ color: 0x5ee6be });
      waypoints.forEach((p, i) => {
        const m = new THREE.Mesh(geo, i === 0 ? first : mat);
        const [x, z] = map(p[0], p[2]);
        m.position.set(x, ground + LIFT * 3, z);
        this.group.add(m);
      });
    }
  }

  // Foot contacts: a small print at each pinned ankle position (left green, right amber).
  showContacts(contacts, ground = 0) {
    if (this.contacts) {
      this.contacts.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      this.group.remove(this.contacts);
    }
    this.contacts = new THREE.Group();
    this.contacts.name = 'foot-contacts';
    if (contacts?.length) {
      const geo = new THREE.BoxGeometry(0.07, 0.006, 0.16);
      const mats = { left: new THREE.MeshBasicMaterial({ color: 0x5ee6be }), right: new THREE.MeshBasicMaterial({ color: 0xffb547 }) };
      for (const c of contacts) {
        const m = new THREE.Mesh(geo, mats[c.foot]);
        m.position.set(c.position[0], ground + LIFT * 4, c.position[2]);
        this.contacts.add(m);
      }
    }
    this.group.add(this.contacts);
  }

  set visible(v) { this.group.visible = v; }
}
