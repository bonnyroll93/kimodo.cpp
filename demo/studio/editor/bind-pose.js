// Bind pose check and T-pose preview for the retargeting.
// The native source skeletons rest in a T-pose. A character bound in another pose (A-pose,
// arms down...) is retargeted from its T-pose: "Align rest pose" rotates every mapped bone
// of the character's rest onto the source's rest direction before the motion is transferred.
// checkBindPose measures the upper arms' elevation in the character's rest (via the
// mapping: the joints mapped to LeftArm / RightArm and their forearms); poseCharacter shows
// the character in a retargeted pose (here: the T-pose from /api/retarget/tpose).
import * as THREE from 'three';

const TPOSE_TOLERANCE = 12; // degrees from horizontal still counted as a T-pose

import { sourceName } from './source-names.js';

export function checkBindPose(character, mapping, skeletonKey = 'soma30') {
  const bySource = new Map((mapping?.joints ?? []).map((j) => [j.source, j.target]));
  const joint = (source) => character.joints.find((j) => j.name === bySource.get(sourceName(skeletonKey, source)));
  const arms = [];
  for (const side of ['Left', 'Right']) {
    const arm = joint(`${side}Arm`), fore = joint(`${side}ForeArm`);
    if (!arm?.restPos || !fore?.restPos) continue;
    const d = fore.restPos.clone().sub(arm.restPos);
    arms.push({ side, degrees: (Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180) / Math.PI });
  }
  if (!arms.length) return null;
  const worst = arms.reduce((a, b) => (Math.abs(b.degrees) > Math.abs(a.degrees) ? b : a));
  const tpose = Math.abs(worst.degrees) <= TPOSE_TOLERANCE;
  const label = tpose ? 'T-pose' : worst.degrees < 0 ? 'A-pose' : 'arms raised';
  return { tpose, label, arms };
}

// Poses the character's bones from retarget output (meta, rotations [T,J,4], frame 0) with
// the rest translations, the same way AnimationPlayer.applyTarget does.
export function poseCharacter(character, meta, rotations) {
  const byNode = new Map(character.joints.map((j) => [j.nodeIndex, j]));
  const n = meta.joints.length;
  const global = [], local = new THREE.Matrix4(), inv = new THREE.Matrix4();
  character.root.updateMatrixWorld(true);
  for (let i = 0; i < n; i++) {
    const mj = meta.joints[i], cj = byNode.get(mj.source_node);
    const q = new THREE.Quaternion(rotations[i * 4], rotations[i * 4 + 1], rotations[i * 4 + 2], rotations[i * 4 + 3]);
    const p = cj?.rest.p ?? new THREE.Vector3();
    local.compose(p, q, new THREE.Vector3().fromArray(mj.scale ?? [1, 1, 1]));
    global[i] = new THREE.Matrix4().multiplyMatrices(mj.parent >= 0 ? global[mj.parent] : character.root.matrixWorld, local);
    if (!cj) continue;
    cj.bone.parent.updateWorldMatrix(true, false);
    inv.copy(cj.bone.parent.matrixWorld).invert().multiply(global[i]);
    inv.decompose(cj.bone.position, cj.bone.quaternion, cj.bone.scale);
    cj.bone.updateMatrixWorld(true);
  }
}

// Back to the bind pose (the glTF node transforms read at load).
export function restoreBindPose(character) {
  for (const j of character.joints) {
    j.bone.position.copy(j.bind.p);
    j.bone.quaternion.copy(j.bind.q);
    j.bone.scale.copy(j.bind.s);
  }
  character.root.updateMatrixWorld(true);
}
