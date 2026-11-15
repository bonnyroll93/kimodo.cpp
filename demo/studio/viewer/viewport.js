// Renderer, camera, orbit controls, grid/axes and the render loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Viewport {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(2.5, 1.8, 3.5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.target.set(0, 1, 0);
    // Left: orbit, middle: zoom (dolly), right: pan, wheel: zoom.
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x1a2228, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 6, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fd9ff, 0.8);
    rim.position.set(-4, 3, -5);
    this.scene.add(rim);

    this.grid = new THREE.GridHelper(10, 20, 0x3bd3d0, 0x25313b);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(0.5);
    this.axes.material.depthTest = false;
    this.axes.renderOrder = 10;
    this.scene.add(this.axes);

    this.onFrame = [];
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  tick() {
    this.controls.update();
    for (const fn of this.onFrame) fn();
    this.renderer.render(this.scene, this.camera);
  }

  // Fit the camera to an object's bounding box, keeping the current viewing direction.
  frame(object) {
    const box = new THREE.Box3().setFromObject(object, true);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.05);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.1;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.set(0.5, 0.35, 0.8).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, distance);
    this.camera.near = distance / 200;
    this.camera.far = distance * 200;
    this.camera.updateProjectionMatrix();
    // Scale helpers to the character so tiny or huge rigs stay readable.
    const unit = Math.pow(10, Math.round(Math.log10(Math.max(size.y, size.x, size.z, 1e-3))));
    this.grid.scale.setScalar(unit);
    this.grid.position.set(center.x, box.min.y, center.z);
    this.axes.scale.setScalar(unit * 0.5);
    return radius;
  }
}
