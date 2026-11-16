// Source joints by role across the native skeletons. The studio's rig tools (control rig,
// picker, bind-pose check) name source joints the SOMA way (LeftArm, LeftForeArm, ...);
// sourceName() gives the joint of the same role on the clip's skeleton (SMPL-X 22, Unitree
// G1 34), so they work whatever skeleton the motion comes from.
const ALIASES = {
  smplx22: {
    Hips: 'pelvis', Spine1: 'spine1', Spine2: 'spine2', Chest: 'spine3', Neck1: 'neck', Head: 'head',
    LeftShoulder: 'left_collar', LeftArm: 'left_shoulder', LeftForeArm: 'left_elbow', LeftHand: 'left_wrist',
    RightShoulder: 'right_collar', RightArm: 'right_shoulder', RightForeArm: 'right_elbow', RightHand: 'right_wrist',
    LeftLeg: 'left_hip', LeftShin: 'left_knee', LeftFoot: 'left_ankle', LeftToeBase: 'left_foot',
    RightLeg: 'right_hip', RightShin: 'right_knee', RightFoot: 'right_ankle', RightToeBase: 'right_foot',
  },
  g1skel34: { // a robot: waist joints, no neck / head; each limb joint is the last of its axis group
    Hips: 'pelvis_skel', Spine1: 'waist_yaw_skel', Spine2: 'waist_roll_skel', Chest: 'waist_pitch_skel',
    LeftShoulder: 'left_shoulder_roll_skel', LeftArm: 'left_shoulder_yaw_skel', LeftForeArm: 'left_elbow_skel', LeftHand: 'left_wrist_roll_skel',
    RightShoulder: 'right_shoulder_roll_skel', RightArm: 'right_shoulder_yaw_skel', RightForeArm: 'right_elbow_skel', RightHand: 'right_wrist_roll_skel',
    LeftLeg: 'left_hip_yaw_skel', LeftShin: 'left_knee_skel', LeftFoot: 'left_ankle_pitch_skel', LeftToeBase: 'left_ankle_roll_skel',
    RightLeg: 'right_hip_yaw_skel', RightShin: 'right_knee_skel', RightFoot: 'right_ankle_pitch_skel', RightToeBase: 'right_ankle_roll_skel',
  },
};

// The source skeleton's joint for a SOMA-style role name (the name itself for SOMA / unknown).
export function sourceName(skeletonKey, somaName) {
  return ALIASES[skeletonKey]?.[somaName] ?? somaName;
}
