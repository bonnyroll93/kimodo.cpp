#pragma once
// Root motion modes applied to a baked clip (root = joint 0).

#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/motion_path.hpp>

#include <expected>
#include <optional>
#include <string>

namespace kimodo::anim {

enum class RootMotionMode {
    Full,       // keep the generated root motion untouched
    InPlace,    // remove horizontal root translation
    CustomPath, // replace the root trajectory with a MotionPath
};

struct InPlaceOptions {
    bool lock_forward = true; // remove travel along AxisConvention::forward
    bool lock_lateral = true; // remove travel along AxisConvention::lateral()
    bool at_origin = true;    // the locked components are 0 (the character stays on the origin);
                              // false: they keep frame 0's value (it stays where it starts)
};

struct RootMotionSettings {
    RootMotionMode mode = RootMotionMode::Full;
    AxisConvention axes{};
    InPlaceOptions in_place{};
    std::optional<MotionPathSpec> path;
    PathFollowOptions follow{};
    // A path combined with Full/InPlace is an error unless it is only shown as a preview.
    bool path_preview_only = false;
};

// Mode/path consistency and axis sanity (unit, perpendicular).
[[nodiscard]] std::expected<void, std::string> validate(const RootMotionSettings &settings);

// InPlace: the locked horizontal components of the root translation become 0 on every frame
// (at_origin: the character walks on the spot at the origin), or keep frame 0's value
// (at_origin = false); height and every rotation are untouched.
[[nodiscard]] std::expected<void, std::string> make_in_place(AnimationClip &clip, const AxisConvention &axes = {},
                                                             const InPlaceOptions &options = {});

// Validates, then applies the selected mode. Full leaves the clip bit-identical.
[[nodiscard]] std::expected<void, std::string> apply_root_motion(AnimationClip &clip,
                                                                 const RootMotionSettings &settings);

} // namespace kimodo::anim
