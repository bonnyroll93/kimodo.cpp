// Click-to-select joints in the viewport. A drag (orbit/pan) is not a click.
import * as THREE from 'three';

export function installJointPicking(viewport, skeletonView, onSelect) {
  const canvas = viewport.renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down = null;

  canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || e.button !== 0) return;
    if (viewport.editingPath) { down = null; return; } // clicks belong to the path editor
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 4) return;
    const markers = skeletonView.markers;
    if (!markers || !markers.visible) return;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, viewport.camera);
    const hits = raycaster.intersectObject(markers, false);
    // Markers draw on top of everything, so prefer the hit closest to the ray, not to the camera.
    if (hits.length) {
      hits.sort((a, b) => a.distance - b.distance);
      onSelect(hits[0].instanceId);
    } else {
      onSelect(-1);
    }
  });
}
