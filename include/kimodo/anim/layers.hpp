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
enum class Extend { Hold, None };    // outside the layer's time range: hold the end poses, or contribute nothing

// Where and how a layer's clip plays on the stack timeline (non-linear editing). The clip
// segment [trim_in, trim_out) plays from `start`, `speed` times faster, `repeat` times.
// Repeats continue the root: each cycle adds the segment's horizontal root travel (along
// the skeleton root, joint 0). With align_root, the clip is moved and turned about up so
// its first frame starts where the layers below put the root at `start` (sequencing two
// generated walks). fade_in / fade_out ramp the layer weight at the ends of the range.
struct ClipTiming {
    float start = 0.F;     // seconds on the stack timeline
    float trim_in = 0.F;   // seconds into the clip
    float trim_out = 0.F;  // seconds into the clip; <= trim_in means "to the end of the clip"
    float speed = 1.F;     // playback rate (2 = twice as fast, 0.5 = stretched to twice as long)
    int repeat = 1;        // cycles of the trimmed segment (with TimeWrap::Loop: unbounded)
    Extend extend = Extend::Hold;
    float fade_in = 0.F, fade_out = 0.F; // seconds
    bool align_root = false;
};

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
    ClipTiming timing{};
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

    // End of the latest enabled layer on the timeline (start + trimmed, retimed and repeated
    // length; muted layers included).
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
        float segment = 0.F;          // trimmed segment length in clip seconds
        float trim_in = 0.F;          // effective trim in (clip seconds)
        Vec3 cycle_travel{};          // horizontal root travel of one segment (root continuation)
    };
    // Layer-local sample at stack time t: false when the layer does not contribute (Extend::None).
    bool sample_layer(std::size_t index, float t, std::vector<Transform> &out, float &weight) const;
    [[nodiscard]] float layer_end(const Resolved &r) const;
    // Root alignment (align_root) per layer: rotation about up and translation, computed lazily.
    struct Alignment { bool ready = false; Quat yaw{}; Vec3 from{}, to{}; };
    mutable std::vector<Alignment> alignment_;
    [[nodiscard]] std::vector<Transform> evaluate_below(std::size_t index, float t) const;
    [[nodiscard]] std::expected<Resolved, std::string> resolve(AnimationLayer layer) const;
    Skeleton skeleton_;
    std::vector<Resolved> layers_;
};

} // namespace kimodo::anim
