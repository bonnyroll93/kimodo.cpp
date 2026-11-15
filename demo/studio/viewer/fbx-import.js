// FBX import: a rigged FBX becomes a GLB, which the studio and kmd-anim then use like any
// other character. First in the browser (three.js FBXLoader, GLTFExporter: the FBX's own
// bone transforms, no extra tool); if that fails, on the server through Blender
// (/api/convert/fbx). The FBX's animations are kept (the studio lists embedded animations).
import * as THREE from 'three';

const isFBX = (buffer) => {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096));
  const text = new TextDecoder('latin1').decode(head);
  return text.startsWith('Kaydara FBX Binary') || text.includes('FBXHeaderExtension');
};

async function inBrowser(buffer) {
  const [{ FBXLoader }, { GLTFExporter }] = await Promise.all([
    import('three/addons/loaders/FBXLoader.js'), import('three/addons/exporters/GLTFExporter.js')]);
  const group = new FBXLoader().parse(buffer, '');
  let skinned = 0;
  group.traverse((o) => { if (o.isSkinnedMesh) skinned++; });
  if (!skinned) throw new Error('no skinned mesh in the FBX');
  group.updateMatrixWorld(true);
  // FBXLoader keeps the file's units; Maya / Mixamo / Blender FBX are in centimetres. A rig
  // taller than 10 units is taken as centimetres and brought to metres (Kimodo's unit).
  const bones = new THREE.Box3();
  group.traverse((o) => { if (o.isBone) bones.expandByPoint(o.getWorldPosition(new THREE.Vector3())); });
  if (!bones.isEmpty() && bones.max.y - bones.min.y > 10) {
    group.scale.multiplyScalar(0.01);
    group.updateMatrixWorld(true);
  }
  return new GLTFExporter().parseAsync(group, { binary: true, animations: group.animations ?? [], onlyVisible: false });
}

async function onServer(buffer) {
  const r = await fetch('/api/convert/fbx', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return r.arrayBuffer();
}

// FBX ArrayBuffer -> {glb: ArrayBuffer, via: 'browser' | 'blender'}.
export async function fbxToGlb(buffer) {
  if (!isFBX(buffer)) throw new Error('not an FBX file');
  try {
    return { glb: await inBrowser(buffer), via: 'browser' };
  } catch (browserErr) {
    try {
      return { glb: await onServer(buffer), via: 'blender' };
    } catch (serverErr) {
      throw new Error(`browser: ${browserErr.message || browserErr}; Blender: ${serverErr.message || serverErr}`);
    }
  }
}
