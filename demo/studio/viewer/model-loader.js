// Loads a glTF/GLB character and extracts its bone hierarchy.
// Mirrors kimodo::anim::load_gltf_character: the skeleton is the joint set of one skin,
// parents come from the nearest ancestor that is also a joint.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

export async function loadCharacter(source, name) {
  const gltf = source instanceof ArrayBuffer
    ? await loader.parseAsync(source, '')
    : await loader.loadAsync(source);
  const root = gltf.scene;
  root.name ||= name;

  const skinned = [];
  root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });

  // Bones: joints of every skeleton bound in the scene (normally one skin).
  const boneSet = new Set();
  for (const mesh of skinned) for (const bone of mesh.skeleton.bones) boneSet.add(bone);
  const boneParent = (bone) => {
    for (let p = bone.parent; p; p = p.parent) if (boneSet.has(p)) return p;
    return null;
  };

  // Deforming joints: referenced by a vertex with non-zero weight.
  const deforming = new Set();
  for (const mesh of skinned) {
    const idx = mesh.geometry.getAttribute('skinIndex');
    const w = mesh.geometry.getAttribute('skinWeight');
    if (!idx || !w) continue;
    for (let v = 0; v < idx.count; v++)
      for (let k = 0; k < idx.itemSize; k++)
        if (w.getComponent(v, k) > 0) deforming.add(mesh.skeleton.bones[idx.getComponent(v, k)]);
  }

  // Depth-first order with parents first, like the C++ importer.
  const children = new Map([...boneSet].map((b) => [b, []]));
  const roots = [];
  for (const bone of boneSet) {
    const p = boneParent(bone);
    if (p) children.get(p).push(bone); else roots.push(bone);
  }
  // GLTFLoader sanitises object names ("mixamorig:Hips" -> "mixamorigHips"); keep the glTF
  // node index and the original node name, which is what the C++ importer and mappings use.
  const nodeDefs = gltf.parser.json.nodes || [];
  const nodeIndexOf = (bone) => gltf.parser.associations.get(bone)?.nodes;
  const joints = [];
  const walk = (bone, parentIndex) => {
    const index = joints.length;
    const nodeIndex = nodeIndexOf(bone) ?? -1;
    const name = nodeDefs[nodeIndex]?.name || bone.name || `node_${nodeIndex}`;
    joints.push({ bone, index, parent: parentIndex, name, nodeIndex,
                  deforming: deforming.has(bone), children: [],
                  rest: { q: bone.quaternion.clone(), p: bone.position.clone() } }); // glTF node TRS = kmd-anim rest_local
    if (parentIndex >= 0) joints[parentIndex].children.push(index);
    for (const c of children.get(bone)) walk(c, index);
  };
  for (const r of roots) walk(r, -1);

  let triangles = 0;
  for (const m of meshes) {
    const g = m.geometry;
    triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  }
  const materials = new Set();
  for (const m of meshes) for (const mat of [].concat(m.material)) materials.add(mat);

  const warnings = [];
  const notes = [];
  if (skinned.length === 0) warnings.push('No skinned mesh: Kimodo Extended needs a rigged character.');
  // Several root joints (e.g. Blender rig helpers next to Hips): like the C++ importer, the
  // skeleton is the root subtree with the most deforming joints; the others stay at rest.
  let mainRoot = -1;
  if (roots.length) {
    const stats = roots.map((r) => {
      let deform = 0, count = 0;
      const visit = (bone) => { count++; if (deforming.has(bone)) deform++; for (const c of children.get(bone)) visit(c); };
      visit(r);
      return { r, deform, count };
    });
    const best = stats.reduce((a, b) => (b.deform > a.deform || (b.deform === a.deform && b.count > a.count) ? b : a));
    mainRoot = joints.findIndex((j) => j.bone === best.r);
    if (roots.length > 1) {
      const others = stats.filter((s) => s !== best);
      const ignoredDeform = others.reduce((n, s) => n + s.deform, 0);
      notes.push(`${roots.length} root joints: using "${joints[mainRoot].name}"; ` +
        `${others.map((s) => joints.find((j) => j.bone === s.r).name).join(', ')} (${others.reduce((n, s) => n + s.count, 0)} joints) stay at rest.`);
      if (ignoredDeform) warnings.push(`${ignoredDeform} deforming joints outside "${joints[mainRoot].name}" will not be animated.`);
    }
  }
  const names = new Set();
  for (const j of joints) {
    if (names.has(j.name)) { warnings.push(`Duplicate joint name "${j.name}".`); break; }
    names.add(j.name);
  }

  return {
    name, gltf, root, joints, roots: roots.map((r) => joints.findIndex((j) => j.bone === r)),
    mainRoot, warnings, notes,
    stats: {
      meshes: meshes.length,
      skinnedMeshes: skinned.length,
      joints: joints.length,
      deforming: deforming.size,
      materials: materials.size,
      triangles: Math.round(triangles),
      animations: gltf.animations.map((a) => a.name || 'unnamed'),
    },
  };
}

export function disposeCharacter(character) {
  character.root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}
