#pragma once
// Two-bone IK and foot locking (Kimodo Extended backlog F5).
//
// Foot locking removes foot sliding from a baked clip: foot contacts are detected from the
// ankle/toe height above the ground and the ankle's horizontal speed; during each contact
// the ankle is pinned (horizontally) at its mean contact position and both legs are solved
// with analytic two-bone IK, blending in and out over a few frames. When a pinned foot is
// out of reach (stance legs are often nearly straight), the root may be lowered along up by
// the smallest smoothed amount that makes it reachable (adjust_hips). Every other joint
// (spine, arms, head) is untouched, as are the legs outside contacts and blends.

#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/skeleton.hpp>

#include <array>
#include <cstddef>
#include <expected>
#include <span>
#include <string>
#include <vector>

namespace kimodo::anim {

// Solves the chain a -> b -> c (e.g. thigh, calf, foot; b child of a, c child of b) so that
// joint c reaches `target` (skeleton space). `local` is one frame of local transforms in
// skeleton order and is modified in place: a and b get new rotations, and c keeps its
// previous global orientation when keep_end_orientation is set. The bend plane (knee
// direction) of the current pose is preserved. Unreachable targets are clamped to the
// chain's reach; returns false in that case.
bool solve_two_bone_ik(const Skeleton &skeleton, std::span<Transform> local, int a, int b, int c, Vec3 target,
                       bool keep_end_orientation = true);

// Same, with a pole: the middle joint (elbow, knee) points towards `pole` (skeleton space),
// and with end_rotation the end joint (hand, foot) takes that global rotation.
bool solve_two_bone_ik_pole(const Skeleton &skeleton, std::span<Transform> local, int a, int b, int c, Vec3 target,
                            Vec3 pole, const Quat *end_rotation = nullptr);

struct LegChain {
    int thigh = -1, calf = -1, foot = -1, toe = -1;
};
// Left and right legs from role detection (detect_roles); fails without both thigh/calf/foot.
[[nodiscard]] std::expected<std::array<LegChain, 2>, std::string> find_legs(const Skeleton &skeleton);

struct FootLockOptions {
    Vec3 up{0.F, 1.F, 0.F};
    float height_threshold = 0.F; // metres above the ground; 0 = 8% of the leg length
    float speed_threshold = 0.F;  // horizontal ankle speed, m/s; 0 = 40% of the leg length per second
    std::size_t min_contact_frames = 3;
    std::size_t fill_gap_frames = 2;   // merge contacts separated by short gaps
    std::size_t blend_frames = 4;      // ramp in/out around each contact
    bool keep_foot_orientation = true; // the foot keeps its animated global orientation
    bool adjust_hips = true;           // lower the root when a pinned foot is out of reach
    float max_hip_drop = 0.F;          // limit for adjust_hips, metres; 0 = 10% of the leg length
};

struct FootContact {
    int foot = 0;                 // 0 left, 1 right
    std::size_t start = 0, end = 0; // inclusive frame range
    Vec3 position{};              // pinned ankle position: mean over the contact (skeleton space)
};

struct FootLockResult {
    AnimationClip clip;
    std::vector<FootContact> contacts;
    float ground = 0.F;           // estimated ground height along up (see detect_foot_contacts)
    float leg_length = 0.F;
    float height_threshold = 0.F, speed_threshold = 0.F;
    float slide_before = 0.F;     // max horizontal ankle drift inside contacts, before / after
    float slide_after = 0.F;
    std::size_t unreachable_frames = 0;
    float max_hip_drop = 0.F;     // largest root lowering applied by adjust_hips
};

// Contacts only (no modification). The ground is the median foot height (lower of ankle and
// toe) over frames where the ankle is slower than the speed threshold (the clip's lowest
// point if no such frame exists).
[[nodiscard]] std::expected<std::vector<FootContact>, std::string> detect_foot_contacts(
    const AnimationClip &clip, const Skeleton &skeleton, const FootLockOptions &options = {});

[[nodiscard]] std::expected<FootLockResult, std::string> foot_lock(const AnimationClip &clip, const Skeleton &skeleton,
                                                                   const FootLockOptions &options = {});

} // namespace kimodo::anim
