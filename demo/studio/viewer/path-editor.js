// In-viewport MotionPath editing: drag waypoint handles on the ground plane, click the
// ground to insert a waypoint, double-click a handle (or press Delete) to remove it.
// Points are stored in the motion's source space (what /api/root-motion expects); when the
// motion is retargeted they are shown through the source->character overlay map.
import * as THREE from 'three';

// Centripetal Catmull-Rom (alpha 0.5), matching src/anim/motion_path.cpp, for the live preview.
function catmull(p0, p1, p2, p3, u) {
  const knot = (t, a, b) => t + Math.sqrt(Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-6));
  const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
  const t = t1 + (t2 - t1) * u;
  const mix = (a, b, ta, tb) => [0, 1].map((i) => a[i] * ((tb - t) / (tb - ta)) + b[i] * ((t - ta) / (tb - ta)));
  const a1 = mix(p0, p1, t0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2), b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

// pts: [[x, z], ...] -> dense [[x, z], ...] along the curve.
export function sampleCurve(pts, interpolation, loop) {
  const k = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6);
  if (k.length < 2) return k;
  const closed = loop && k.length > 2;
  const n = k.length;
  const at = (i) => {
    if (closed) return k[((i % n) + n) % n];
    if (i < 0) return [2 * k[0][0] - k[1][0], 2 * k[0][1] - k[1][1]];
    if (i >= n) return [2 * k[n - 1][0] - k[n - 2][0], 2 * k[n - 1][1] - k[n - 2][1]];
    return k[i];
  };
  const out = [k[0]];
  const segments = closed ? n : n - 1;
  for (let s = 0; s < segments; s++) {
    const steps = interpolation === 'polyline' ? 1 : 24;
    for (let j = 1; j <= steps; j++) {
      const u = j / steps;
      out.push(interpolation === 'polyline'
        ? [at(s)[0] + (at(s + 1)[0] - at(s)[0]) * u, at(s)[1] + (at(s + 1)[1] - at(s)[1]) * u]
        : catmull(at(s - 1), at(s), at(s + 1), at(s + 2), u));
    }
  }
  return out;
}

export class PathEditor {
  // host: { getPath() -> {points:[[x,y,z]], interpolation, loop} | null, setPoints(points),
  //         view() -> {map, inverse, ground}, onToggle(active) }
  constructor(viewport, host) {
    this.viewport = viewport;
    this.host = host;
    this.active = false;
    this.group = new THREE.Group();
    this.group.name = 'path-editor';
    this.group.visible = false;
    viewport.scene.add(this.group);
    this.handles = [];
    this.points = [];
    this.selected = -1;
    this.drag = null;
    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.handleGeo = new THREE.SphereGeometry(1, 20, 12);
    this.matIdle = new THREE.MeshBasicMaterial({ color: 0x3bd3d0, depthTest: false, transparent: true, opacity: 0.95 });
    this.matFirst = new THREE.MeshBasicMaterial({ color: 0x5ee6be, depthTest: false, transparent: true, opacity: 0.95 });
    this.matSel = new THREE.MeshBasicMaterial({ color: 0xffb547, depthTest: false });
    this.preview = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffb547, depthTest: false, transparent: true, opacity: 0.9 }));
    this.preview.renderOrder = 30;
    this.preview.frustumCulled = false;
    this.group.add(this.preview);

    const canvas = viewport.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => this.down(e), true); // capture: before OrbitControls
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('dblclick', (e) => this.dblclick(e));
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected >= 0) { e.preventDefault(); this.remove(this.selected); }
      if (e.key === 'Escape') this.toggle(false);
    });
  }

  toggle(on = !this.active) {
    this.active = on;
    this.group.visible = on;
    this.viewport.editingPath = on;
    this.viewport.renderer.domElement.style.cursor = on ? 'crosshair' : '';
    this.selected = -1;
    this.refresh();
    this.host.onToggle?.(on);
  }

  // Rebuild handles from the current path (call after every applied change).
  refresh() {
    for (const h of this.handles) this.group.remove(h);
    this.handles = [];
    const path = this.active ? this.host.getPath() : null;
    this.points = path ? path.points.map((p) => [p[0], p[2]]) : [];
    this.path = path;
    const { map, ground } = this.host.view();
    this.plane.constant = -ground;
    const size = this.handleSize();
    this.points.forEach((p, i) => {
      const m = new THREE.Mesh(this.handleGeo, i === this.selected ? this.matSel : i === 0 ? this.matFirst : this.matIdle);
      const [x, z] = map(p[0], p[1]);
      m.position.set(x, ground + 0.01, z);
      m.scale.setScalar(size);
      m.renderOrder = 31;
      m.userData.index = i;
      this.handles.push(m);
      this.group.add(m);
    });
    this.updatePreview();
  }

  handleSize() {
    const d = this.viewport.camera.position.distanceTo(this.viewport.controls.target);
    return Math.max(0.02, d * 0.012);
  }

  updatePreview() {
    if (!this.path || this.points.length < 2) { this.preview.visible = false; return; }
    const { map, ground } = this.host.view();
    const dense = sampleCurve(this.points, this.path.interpolation, this.path.loop);
    const pts = dense.map(([x, z]) => { const [dx, dz] = map(x, z); return new THREE.Vector3(dx, ground + 0.012, dz); });
    if (this.path.loop && this.points.length > 2) pts.push(pts[0].clone());
    this.preview.geometry.dispose();
    this.preview.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.preview.visible = true;
  }

  ray(e) {
    const rect = this.viewport.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.viewport.camera);
  }

  groundPoint(e) {
    this.ray(e);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, hit)) return null;
    return this.host.view().inverse(hit.x, hit.z); // back to source space
  }

  hitHandle(e) {
    this.ray(e);
    const hits = this.raycaster.intersectObjects(this.handles, false);
    return hits.length ? hits[0].object.userData.index : -1;
  }

  down(e) {
    if (!this.active || e.button !== 0) return;
    const i = this.hitHandle(e);
    this.downAt = { x: e.clientX, y: e.clientY, handle: i };
    if (i < 0) return; // let OrbitControls orbit; a click without drag inserts a point on release
    e.stopImmediatePropagation(); // the handle is grabbed: OrbitControls must not orbit
    this.viewport.controls.enabled = false;
    this.drag = { index: i };
    this.select(i);
    this.viewport.renderer.domElement.setPointerCapture(e.pointerId);
  }

  move(e) {
    if (!this.active) return;
    if (!this.drag) {
      this.viewport.renderer.domElement.style.cursor = this.hitHandle(e) >= 0 ? 'grab' : 'crosshair';
      return;
    }
    const p = this.groundPoint(e);
    if (!p) return;
    this.points[this.drag.index] = p;
    const { map, ground } = this.host.view();
    const [x, z] = map(p[0], p[1]);
    this.handles[this.drag.index].position.set(x, ground + 0.01, z);
    this.updatePreview();
  }

  up(e) {
    if (!this.active || e.button !== 0) return;
    const start = this.downAt;
    this.downAt = null;
    if (this.drag) {
      this.drag = null;
      this.viewport.controls.enabled = true;
      // A click on a handle only selects it; a real drag re-computes the path.
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 2) this.commit();
      return;
    }
    // A click (no drag) on empty ground inserts a waypoint.
    if (!start || start.handle >= 0 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
    const p = this.groundPoint(e);
    if (p) this.insert(p);
  }

  dblclick(e) {
    if (!this.active) return;
    const i = this.hitHandle(e);
    if (i >= 0) this.remove(i);
  }

  select(i) {
    this.selected = i;
    this.handles.forEach((h, k) => { h.material = k === i ? this.matSel : k === 0 ? this.matFirst : this.matIdle; });
  }

  // Insert into the nearest segment (or append after the last point if that is closer).
  insert(p) {
    const pts = this.points;
    if (!this.path) return;
    let at = pts.length;
    if (pts.length >= 2) {
      let best = Infinity;
      const segs = this.path.loop && pts.length > 2 ? pts.length : pts.length - 1;
      for (let s = 0; s < segs; s++) {
        const a = pts[s], b = pts[(s + 1) % pts.length];
        const abx = b[0] - a[0], abz = b[1] - a[1];
        const len2 = abx * abx + abz * abz || 1e-9;
        const u = Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / len2));
        const d = Math.hypot(p[0] - (a[0] + abx * u), p[1] - (a[1] + abz * u));
        if (d < best) { best = d; at = s + 1; }
      }
      const last = pts[pts.length - 1];
      if (!this.path.loop && Math.hypot(p[0] - last[0], p[1] - last[1]) < best) at = pts.length;
    }
    pts.splice(at, 0, p);
    this.selected = at;
    this.commit();
  }

  remove(i) {
    if (this.points.length <= 1) return;
    this.points.splice(i, 1);
    this.selected = -1;
    this.commit();
  }

  commit() {
    const r = (v) => Math.round(v * 1000) / 1000;
    this.host.setPoints(this.points.map(([x, z]) => [r(x), r(z)]));
    this.refresh();
  }
}
