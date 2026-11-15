// Read-only joint inspector and character statistics.
import * as THREE from 'three';

const fmt = (v, d = 4) => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(d);
const vec = (v, d) => `${fmt(v.x, d)}  ${fmt(v.y, d)}  ${fmt(v.z, d)}`;

function kv(rows) {
  const dl = document.createElement('dl');
  dl.className = 'kv';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    dl.append(dt, dd);
  }
  return dl;
}

function section(label) {
  const div = document.createElement('div');
  div.className = 'section-label';
  div.textContent = label;
  return div;
}

export class Inspector {
  constructor(container, statsList, onSelect) {
    this.container = container;
    this.statsList = statsList;
    this.onSelect = onSelect;
  }

  showJoint(character, index) {
    this.container.replaceChildren();
    const j = character?.joints[index];
    if (!j) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Select a joint in the hierarchy or the viewport.';
      this.container.append(p);
      return;
    }
    const b = j.bone;
    const link = (i) => {
      if (i < 0) return '— (root)';
      const a = document.createElement('a');
      a.textContent = character.joints[i].name;
      a.addEventListener('click', () => this.onSelect(i));
      return a;
    };
    const euler = new THREE.Euler().setFromQuaternion(b.quaternion, 'XYZ');
    const toDeg = THREE.MathUtils.radToDeg;
    const world = b.getWorldPosition(new THREE.Vector3());

    const h3 = document.createElement('h3');
    h3.textContent = j.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `index ${j.index} · ${j.children.length} child${j.children.length === 1 ? '' : 'ren'} · ${j.deforming ? 'deforming' : 'non-deforming'}`;
    this.container.append(
      h3, sub,
      kv([['Parent', link(j.parent)]]),
      section('Local transform'),
      kv([
        ['Position', vec(b.position)],
        ['Quat xyzw', `${fmt(b.quaternion.x)}  ${fmt(b.quaternion.y)}  ${fmt(b.quaternion.z)}  ${fmt(b.quaternion.w)}`],
        ['Euler °', `${fmt(toDeg(euler.x), 2)}  ${fmt(toDeg(euler.y), 2)}  ${fmt(toDeg(euler.z), 2)}  (XYZ)`],
        ['Scale', vec(b.scale)],
      ]),
      section('World'),
      kv([['Position', vec(world)]]),
    );
    if (j.children.length) {
      const span = document.createElement('span');
      j.children.forEach((c, n) => { if (n) span.append(', '); span.append(link(c)); });
      this.container.append(section('Children'), kv([['Joints', span]]));
    }
  }

  showStats(character) {
    this.statsList.replaceChildren();
    if (!character) return;
    const s = character.stats;
    const rows = [
      ['File', character.name],
      ['Meshes', s.meshes],
      ['Skinned meshes', s.skinnedMeshes],
      ['Joints', s.joints],
      ['Deforming joints', s.deforming],
      ['Materials', s.materials],
      ['Triangles', s.triangles.toLocaleString()],
      ['Animations', s.animations.length ? s.animations.join(', ') : 'none'],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = String(v);
      this.statsList.append(dt, dd);
    }
  }
}
