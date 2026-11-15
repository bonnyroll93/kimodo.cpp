#pragma once
// Keyframe animation curves and keyframe layers (Kimodo Extended backlog F4/F6).
//
// A keyframe layer stores, per joint, six curves of *offsets* applied on top of the layers
// below it: rotation about the local X, Y, Z axes in degrees (Euler order XYZ, i.e.
// q = qx * qy * qz, the same as three.js Euler 'XYZ') and translation along the local
// X, Y, Z axes (parent units). It becomes an Additive layer with a rest-pose reference, so
// a joint without keys is untouched and a zero offset changes nothing.
//
// Curve evaluation is shared with the studio's graph editor (viewer/keyframes.js), which
// implements the same rules:
//   * before the first / after the last key the curve is constant;
//   * a segment uses the interpolation of its left key: constant, linear or bezier;
//   * bezier segments are cubic curves in (frame, value) through the two keys with the
//     left key's right handle and the right key's left handle (relative offsets); handle
//     frame offsets are clamped into the segment so the curve stays a function of time;
//   * keys with auto tangents get "auto-clamped" handles: slope (v_next - v_prev) /
//     (f_next - f_prev), flattened at local extrema and at the ends, handle length one
//     third of the neighbouring interval.

#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/skeleton.hpp>

#include <array>
#include <expected>
#include <filesystem>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace kimodo::anim {

enum class KeyInterpolation { Constant, Linear, Bezier };

struct Keyframe {
    float frame = 0.F;
    float value = 0.F;
    KeyInterpolation interpolation = KeyInterpolation::Bezier;
    bool auto_tangent = true;
    std::array<float, 2> left{-1.F, 0.F};  // handle offset (frames, value) towards the previous key
    std::array<float, 2> right{1.F, 0.F};  // handle offset towards the next key
};

struct Curve {
    std::vector<Keyframe> keys; // sorted by frame (from_json and sort() enforce it)
    void sort();
    [[nodiscard]] float evaluate(float frame) const;
    // Effective handles of key i (auto-clamped when auto_tangent is set).
    [[nodiscard]] std::array<std::array<float, 2>, 2> handles(std::size_t i) const;
};

enum Channel { RotX, RotY, RotZ, PosX, PosY, PosZ, ChannelCount };
[[nodiscard]] std::string_view channel_name(int channel) noexcept; // "rx" ... "tz"

struct KeyframeTracks {
    float fps = 30.F;
    std::map<std::string, std::array<Curve, ChannelCount>, std::less<>> joints; // by joint name
    Curve weight; // keyed layer weight (0..1, layer frames); empty: the layer's own weight
    [[nodiscard]] float last_frame() const;
};

// JSON: {"version":1,"fps":30,"tracks":{"Joint":{"rx":[{"f":0,"v":12.5,"i":"bezier","a":true,
//        "l":[-2,0],"r":[2,0]}], "ry":[...], ...}}, "weight":[keys]}   ("i": constant|linear|bezier, "a": auto;
//        weight: optional animated layer weight)
[[nodiscard]] std::expected<KeyframeTracks, std::string> keyframes_from_json(std::string_view json);
[[nodiscard]] std::string keyframes_to_json(const KeyframeTracks &tracks);
[[nodiscard]] std::expected<KeyframeTracks, std::string> load_keyframes(const std::filesystem::path &path);

// Rotation offset of the Euler angles in degrees (q = qx * qy * qz).
[[nodiscard]] Quat euler_xyz_degrees(float x, float y, float z) noexcept;

struct KeyframeClip {
    AnimationClip clip;                 // tracks only for keyed joints that exist in the skeleton
    std::vector<std::string> warnings;  // e.g. keyed joints missing from the skeleton
    std::map<std::string, unsigned, std::less<>> channels; // keyed joint -> ChannelRotation/ChannelTranslation bits
};
// Samples the curves into a clip of local transforms: rest rotation * offset rotation and
// rest translation + offset translation, `frames` long (0: up to the last key).
[[nodiscard]] std::expected<KeyframeClip, std::string> keyframe_clip(const KeyframeTracks &tracks,
                                                                     const Skeleton &skeleton,
                                                                     std::size_t frames = 0);

} // namespace kimodo::anim
