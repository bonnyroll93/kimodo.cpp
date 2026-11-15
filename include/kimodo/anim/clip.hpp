#pragma once
// Baked animation clip: one local Transform per joint per frame, at a fixed frame rate.

#include <kimodo/anim/skeleton.hpp>

#include <cstddef>
#include <expected>
#include <filesystem>
#include <span>
#include <string>
#include <vector>

namespace kimodo::anim {

struct AnimationClip {
    std::string name;
    float fps = 30.F;
    std::size_t joint_count = 0;
    std::vector<Transform> locals; // frame-major: locals[frame * joint_count + joint]

    [[nodiscard]] std::size_t frames() const noexcept { return joint_count ? locals.size() / joint_count : 0; }
    [[nodiscard]] float duration() const noexcept { return frames() > 1 ? static_cast<float>(frames() - 1) / fps : 0.F; }
    [[nodiscard]] Transform &at(std::size_t frame, std::size_t joint) { return locals[frame * joint_count + joint]; }
    [[nodiscard]] const Transform &at(std::size_t frame, std::size_t joint) const { return locals[frame * joint_count + joint]; }
    [[nodiscard]] std::span<const Transform> frame(std::size_t f) const {
        return std::span<const Transform>(locals).subspan(f * joint_count, joint_count);
    }
};

// Kimodo's native motion layout (kimodo::motion_data, kmd-generate output):
// root_positions [frames, 3] (root joint translation, skeleton space) and
// rotations_xyzw [frames, joints, 4] (parent-local). Non-root translations come from
// the skeleton's rest offsets. Values are copied without normalisation, so
// clip_to_motion(clip_from_motion(x)) reproduces x bit for bit.
struct MotionArrays {
    std::size_t frames = 0;
    std::size_t joints = 0;
    std::vector<float> root_positions;
    std::vector<float> rotations_xyzw;
};

[[nodiscard]] std::expected<AnimationClip, std::string> clip_from_motion(const Skeleton &skeleton,
                                                                         const MotionArrays &motion,
                                                                         float fps = 30.F);
[[nodiscard]] MotionArrays clip_to_motion(const AnimationClip &clip);

// Reads/writes root_positions.f32 and local_rotations_xyzw.f32 in a directory
// (the format written by kmd-generate). The joint count is inferred from the sizes.
[[nodiscard]] std::expected<MotionArrays, std::string> read_motion_dir(const std::filesystem::path &dir);
[[nodiscard]] std::expected<void, std::string> write_motion_dir(const std::filesystem::path &dir,
                                                                const MotionArrays &motion);

} // namespace kimodo::anim
