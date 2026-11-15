#pragma once
// Control rig (Kimodo Extended): IK arms and legs evaluated on a baked clip.
//
// Each limb is a two-bone chain (upper, lower, end: e.g. LeftArm, LeftForeArm, LeftHand).
// While its IK is on (for the whole animation, like ActionForge's "simple" workflow), the
// chain is solved every frame so the end joint reaches the IK control:
//   * the control's position is keyed (tx, ty, tz) and its rotation (rx, ry, rz, Euler XYZ
//     degrees, q = qx*qy*qz) in its follow space: Root (skeleton space) or Hips (the hips
//     joint's global transform on that frame, without scale). Without position keys the
//     control sits where the animation puts the end joint (IK changes nothing); without
//     rotation keys the end joint keeps its animated global orientation;
//   * the pole (tx, ty, tz in the same follow space) is where the middle joint (elbow,
//     knee) points; without keys the animation's bend plane is kept.
// Curves use the keyframe rules of keyframes.hpp, frames at the rig's fps. weight blends
// the solved chain with the animation (0: untouched); a keyed blend curve (IK/FK blend,
// 1 = IK, 0 = FK, ActionForge's "complex" workflow) replaces weight frame by frame.

#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/keyframes.hpp>
#include <kimodo/anim/skeleton.hpp>

#include <array>
#include <expected>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace kimodo::anim {

enum class ControlSpace { Root, Hips };

struct IkLimb {
    std::string name;                  // "left_arm"...
    std::array<std::string, 3> chain;  // upper, lower, end joint names
    bool ik = false;
    ControlSpace follow = ControlSpace::Root;
    float weight = 1.F;
    Curve blend;                            // keyed IK/FK blend (overrides weight when keyed)
    std::array<Curve, ChannelCount> target; // tx ty tz (position), rx ry rz (rotation)
    std::array<Curve, 3> pole;              // tx ty tz
};

struct ControlRig {
    float fps = 30.F;
    std::string hips; // joint used by ControlSpace::Hips (empty: the skeleton root)
    std::vector<IkLimb> limbs;
};

// JSON: {"version":1,"fps":30,"hips":"Hips","limbs":[{"name":"left_arm",
//   "chain":["LeftArm","LeftForeArm","LeftHand"],"ik":true,"follow":"root"|"hips","weight":1,"blend":[keys],
//   "target":{"tx":[keys],...,"rz":[keys]},"pole":{"tx":[keys],"ty":[keys],"tz":[keys]}}]}
// (keys as in keyframes.hpp: {"f","v","i","a","l","r"})
[[nodiscard]] std::expected<ControlRig, std::string> control_rig_from_json(std::string_view json);
[[nodiscard]] std::expected<ControlRig, std::string> load_control_rig(const std::filesystem::path &path);

struct ControlRigReport {
    std::vector<std::string> solved;   // limbs with IK on that were applied
    std::vector<std::string> warnings; // missing joints, broken chains
    std::size_t unreachable_frames = 0;
};

// Applies the rig to `clip` (in place; joint order of `skeleton`, as AnimationStack::bake gives).
[[nodiscard]] std::expected<ControlRigReport, std::string> apply_control_rig(AnimationClip &clip, const Skeleton &skeleton,
                                                                              const ControlRig &rig);

} // namespace kimodo::anim
