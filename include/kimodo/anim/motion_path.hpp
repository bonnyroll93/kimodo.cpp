#pragma once
// User-defined root trajectory, applied after generation (procedural post-processing;
// it does not condition the diffusion model and does not fix stride/speed mismatches).

#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/types.hpp>

#include <expected>
#include <string>
#include <vector>

namespace kimodo::anim {

enum class PathInterpolation { Polyline, CatmullRom };

struct MotionPathSpec {
    std::vector<Vec3> points;                                  // waypoints, projected onto the ground plane
    PathInterpolation interpolation = PathInterpolation::CatmullRom; // centripetal Catmull-Rom
    bool loop = false;                                         // closes the curve back to the first point
};

// Arc-length parameterised curve on the ground plane (perpendicular to AxisConvention::up).
class MotionPath {
public:
    // Fails on an empty point list. Consecutive coincident points are merged; a single
    // (distinct) point yields a zero-length path that holds the root in place.
    [[nodiscard]] static std::expected<MotionPath, std::string> build(const MotionPathSpec &spec,
                                                                      const AxisConvention &axes = {});

    [[nodiscard]] float length() const noexcept { return total_; }
    [[nodiscard]] bool loop() const noexcept { return loop_; }
    // Position at arc length s: clamped to [0, length], or wrapped when looping.
    [[nodiscard]] Vec3 position(float s) const noexcept;
    // Unit tangent at s. Where the curve has no direction (zero-length path) returns {0,0,0}.
    [[nodiscard]] Vec3 tangent(float s) const noexcept;
    // Arc length at which the curve passes waypoint i (after merging duplicates).
    [[nodiscard]] float waypoint_distance(std::size_t i) const noexcept;
    [[nodiscard]] std::size_t waypoints() const noexcept { return knots_.size(); }
    // n evenly spaced points along the curve (n >= 2), for display.
    [[nodiscard]] std::vector<Vec3> sample(std::size_t n) const;

private:
    std::vector<Vec3> knots_;   // de-duplicated waypoints
    std::vector<Vec3> dense_;   // densely sampled curve
    std::vector<float> cumulative_; // arc length at each dense sample
    std::vector<float> knot_s_;     // arc length at each knot
    float total_ = 0.F;
    bool loop_ = false;
    [[nodiscard]] float wrap(float s) const noexcept;
};

// How elapsed time maps to distance along the path.
enum class PathTiming {
    MotionDistance, // the generated motion's own horizontal travel (keeps stride speed); default
    Duration,       // traverse the whole path in `duration` seconds (0: clip duration)
    Speed,          // constant `speed` metres per second
};

struct PathFollowOptions {
    PathTiming timing = PathTiming::MotionDistance;
    float duration = 0.F;
    float speed = 1.F;
    bool orient_to_path = true; // turn the root so its initial facing follows the tangent
};

// Replaces the root's horizontal translation with the path; keeps the root's height
// (component along up) and every joint rotation. With orient_to_path the root rotation
// is pre-multiplied by a yaw about up that aligns frame 0's facing with the tangent.
// MotionDistance falls back to Duration when the motion barely travels (in-place input).
[[nodiscard]] std::expected<void, std::string> follow_path(AnimationClip &clip, const MotionPath &path,
                                                           const AxisConvention &axes = {},
                                                           const PathFollowOptions &options = {});

} // namespace kimodo::anim
