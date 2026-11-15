#pragma once
// Control rig (Kimodo Extended): IK arms and legs evaluated on a baked clip.
//
// Each limb is a two-bone chain (upper, lower, end: e.g. LeftArm, LeftForeArm, LeftHand).
// While its IK is on (for the whole animation, like ActionForge's "simple" workflow), the
// chain is solved every frame so the end joint reaches the IK control:
//   * the control's position is keyed (tx, ty, tz) and its rotation (rx, ry, rz, Euler XYZ
//     degrees, q = qx*qy*qz) in its follow space: World (skeleton space: nothing moves it),
//     Root (the root control's offset on that frame: the ground circle carries it; World
//     while the root control is not keyed) or Hips (the hips joint's global transform on
//     that frame, without scale). Without position keys the
//     control sits where the animation puts the end joint (IK changes nothing); without
//     rotation keys the end joint keeps its animated global orientation;
//   * the pole (tx, ty, tz in the same follow space) is where the middle joint (elbow,
//     knee) points; without keys the animation's bend plane is kept.
// Body controls (applied first, so IK limbs keyed in Root space stay planted):
//   * root: an offset of the whole character in skeleton space (tx, ty, tz; rx, ry, rz
//     about the hips' ground point of that frame): the ActionForge ground circle;
//   * hips: an offset of the hips joint (translation in skeleton space, rotation about the
//     hips, skeleton-space axes): lower the hips and the IK feet stay on the ground.
// Unkeyed channels are 0 (no offset).
// Curves use the keyframe rules of keyframes.hpp, frames at the rig's fps. weight blends
// the solved chain with the animation (0: untouched); a keyed blend curve (IK/FK blend,
// 1 = IK, 0 = FK, ActionForge's "complex" workflow) replaces weight frame by frame.
//
// Anim layers (Maya-style): the curves above are the base; layers on top hold more curves
// for the same controls (each limb's target / pole / blend, the body offsets), evaluated
// in the layer's own time ((t - start) * speed) with the layer weight (keyable):
//   additive: position / pole / blend / offset += w * layer value; rotation = rotation *
//     slerp(identity, layer rotation, w);
//   override: each keyed group (position, rotation, pole, blend) moves towards the layer
//     value by w (lerp / slerp).
// A group the base does not key starts from the animation (the end joint's position and
// rotation, the current bend plane's pole, the limb weight, a zero offset), so a layer can
// offset a control that follows the animation.

#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/keyframes.hpp>
#include <kimodo/anim/skeleton.hpp>

#include <array>
#include <expected>
#include <filesystem>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace kimodo::anim {

enum class ControlSpace { World, Root, Hips };

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

// The curves an anim layer holds for one limb.
struct LimbLayerCurves {
    std::array<Curve, ChannelCount> target;
    std::array<Curve, 3> pole;
    Curve blend;
};

struct ControlRigLayer {
    std::string name;
    bool additive = true;
    float weight = 1.F;
    Curve weight_curve;          // keyed layer weight (replaces weight when keyed), layer frames
    float start = 0.F, speed = 1.F, end = 0.F; // layer time (seconds); end > start: stops there
    std::map<std::string, LimbLayerCurves, std::less<>> limbs; // by limb name
    std::array<Curve, ChannelCount> root_control, hips_control;
};

struct ControlRig {
    float fps = 30.F;
    std::string hips; // joint used by ControlSpace::Hips (empty: the skeleton root)
    std::vector<IkLimb> limbs;
    std::array<Curve, ChannelCount> root_control; // offset of the whole character
    std::array<Curve, ChannelCount> hips_control; // offset of the hips joint
    std::vector<ControlRigLayer> layers;          // bottom first
};

// JSON: {"version":1,"fps":30,"hips":"Hips","limbs":[{"name":"left_arm",
//   "chain":["LeftArm","LeftForeArm","LeftHand"],"ik":true,"follow":"world"|"root"|"hips","weight":1,"blend":[keys],
//   "target":{"tx":[keys],...,"rz":[keys]},"pole":{"tx":[keys],"ty":[keys],"tz":[keys]}}],
//   "root_control":{"tx":[keys],...},"hips_control":{"tx":[keys],...},
//   "layers":[{"name":"Keys","mode":"additive"|"override","weight":1,"weight_keys":[keys],
//     "start":0,"speed":1,"end":0,"limbs":{"left_arm":{"target":{...},"pole":{...},"blend":[keys]}},
//     "root_control":{...},"hips_control":{...}}]}
// (keys as in keyframes.hpp: {"f","v","i","a","l","r"})
[[nodiscard]] std::expected<ControlRig, std::string> control_rig_from_json(std::string_view json);
[[nodiscard]] std::expected<ControlRig, std::string> load_control_rig(const std::filesystem::path &path);

// Values of every control per frame, for editors (what the controls show and what the base
// layer holds): per limb of rig.limbs, the composed then the base [position 3, rotation xyzw 4,
// pole 3, blend 1] in its follow space; then hips and root, composed then base [offset 3,
// rotation xyzw 4]. stride = 22 * limbs + 28 floats per frame.
inline constexpr std::size_t kControlLimbStride = 22, kControlBodyStride = 28;

struct ControlRigReport {
    std::vector<std::string> solved;   // limbs with IK on that were applied ("root" / "hips": body controls)
    std::vector<std::string> warnings; // missing joints, broken chains
    std::size_t unreachable_frames = 0;
    std::size_t stride = 0;
    std::vector<float> controls;       // frames * stride (see above)
};

// Applies the rig to `clip` (in place; joint order of `skeleton`, as AnimationStack::bake gives).
[[nodiscard]] std::expected<ControlRigReport, std::string> apply_control_rig(AnimationClip &clip, const Skeleton &skeleton,
                                                                              const ControlRig &rig);

} // namespace kimodo::anim
