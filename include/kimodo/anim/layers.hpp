#pragma once
// Animation layers: an ordered stack of clips composed per joint on one skeleton.
//
// Evaluation at time t starts from the skeleton's rest pose and applies the layers in
// order. For each joint driven by a layer, the effective weight is
// clamp(layer.weight * mask(joint), 0, 1):
//   * Override: rotation = slerp(current, layer, w) (shortest arc), translation and scale
//     are lerped. With w == 1 the layer value is copied exactly.
//   * Additive: the layer's change from its reference pose, delta = ref^-1 * layer (local,
//     rotation) and layer - ref (translation), is scaled by w (slerp from identity / lerp
//     from zero) and applied on top: rotation = current * delta_w, translation += delta_w.
//
// Enabled vs muted (both silence the layer's pose contribution, but differently):
//   * enabled == false: the layer is bypassed entirely, as if it were not in the stack; it
//     does not count towards the stack's duration.
//   * muted == true: the layer stays in the stack and keeps its place on the timeline (it
//     counts towards the duration), but contributes nothing to the pose.
// weight == 0 is equivalent to muted for the pose.
//
// Layers address joints by name (AnimationClip::joint_names), so a clip can drive a
// subset of the stack's skeleton; joints it does not have are left untouched by it.

#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/skeleton.hpp>

#include <expected>
#include <filesystem>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace kimodo::anim {

enum class BlendMode { Override, Additive };
enum class AdditiveReference { FirstFrame, RestPose, Frame };
enum class TimeWrap { Clamp, Loop }; // outside a clip's duration: hold the last frame, or loop

// Per-joint weights by joint name; joints not listed get default_weight.
struct AnimationMask {
    std::string name = "full";
    std::map<std::string, float, std::less<>> weights;
    float default_weight = 1.F;
    [[nodiscard]] float weight(std::string_view joint) const;
};

[[nodiscard]] AnimationMask full_body_mask();
// Upper body: the first spine joint (or, without a spine, the neck/head chain and the arms)
// and everything below it. Lower body: everything else (hips and legs).
[[nodiscard]] AnimationMask upper_body_mask(const Skeleton &skeleton);
[[nodiscard]] AnimationMask lower_body_mask(const Skeleton &skeleton);

// JSON: {"version":1,"name":"...","default":0,"weights":{"Joint":1.0,...}}
[[nodiscard]] std::expected<AnimationMask, std::string> mask_from_json(std::string_view json);
[[nodiscard]] std::string mask_to_json(const AnimationMask &mask);
[[nodiscard]] std::expected<AnimationMask, std::string> load_mask(const std::filesystem::path &path);
[[nodiscard]] std::expected<void, std::string> save_mask(const std::filesystem::path &path, const AnimationMask &mask);

struct AnimationLayer {
    std::string name;
    AnimationClip clip;
    BlendMode mode = BlendMode::Override;
    float weight = 1.F;
    bool enabled = true;
    bool muted = false;
    AnimationMask mask = full_body_mask();
    AdditiveReference reference = AdditiveReference::FirstFrame;
    std::size_t reference_frame = 0; // used with AdditiveReference::Frame
    TimeWrap wrap = TimeWrap::Clamp;
};

// Samples a clip at time t (seconds): linear/slerp interpolation between frames.
[[nodiscard]] std::vector<Transform> sample_clip(const AnimationClip &clip, float t, TimeWrap wrap = TimeWrap::Clamp);

class AnimationStack {
public:
    explicit AnimationStack(Skeleton skeleton);

    // Validates the layer (finite weight in [0,1], a clip whose joints can be resolved by
    // name, a valid reference frame) and appends it on top of the stack.
    [[nodiscard]] std::expected<void, std::string> add_layer(AnimationLayer layer);

    [[nodiscard]] const Skeleton &skeleton() const noexcept { return skeleton_; }
    [[nodiscard]] std::size_t size() const noexcept { return layers_.size(); }
    // Mutable access for enable/mute/weight/mode/order changes; clip and mask edits must go
    // through replace_layer so the joint resolution is refreshed.
    [[nodiscard]] AnimationLayer &layer(std::size_t i) { return layers_[i].layer; }
    [[nodiscard]] const AnimationLayer &layer(std::size_t i) const { return layers_[i].layer; }
    [[nodiscard]] std::expected<void, std::string> replace_layer(std::size_t i, AnimationLayer layer);
    void move_layer(std::size_t from, std::size_t to);
    void remove_layer(std::size_t i);

    // Longest clip duration among enabled layers (muted ones included).
    [[nodiscard]] float duration() const;
    // Local pose at time t, skeleton joint order.
    [[nodiscard]] std::vector<Transform> evaluate(float t) const;
    // Bakes [0, duration] at fps (0: the fps of the first enabled layer, else 30).
    [[nodiscard]] AnimationClip bake(float fps = 0.F) const;

private:
    struct Resolved {
        AnimationLayer layer;
        std::vector<int> track;       // stack joint -> clip track (-1: not driven)
        std::vector<float> mask;      // stack joint -> mask weight
        std::vector<Transform> reference; // stack joint order (additive reference pose)
    };
    [[nodiscard]] std::expected<Resolved, std::string> resolve(AnimationLayer layer) const;
    Skeleton skeleton_;
    std::vector<Resolved> layers_;
};

} // namespace kimodo::anim
