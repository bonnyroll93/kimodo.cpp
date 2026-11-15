#pragma once
// Seamless loops (Kimodo Extended): make a clip start and end on the same pose without a
// pop. Two steps:
//   1. optional cut: search the frame pair (a, b), b - a >= min_length of the clip, whose
//      poses and motions match best (joint rotations of a and b, of a-1 / b-1 and a+1 / b+1,
//      root height), and trim the clip to [a, b];
//   2. blend: the first and last frames are moved onto their average pose, and the change
//      fades out into the clip over `blend` frames from each end (smoothstep: no velocity
//      jump where it ends). Each joint's local rotation is corrected with a slerp from the
//      identity, so the whole difference is spread smoothly instead of the last frame being
//      replaced (which would pop against the frame before it).
// The root keeps its travel: its translation is corrected around the straight line from the
// first to the last frame's horizontal position (the vertical position is matched too), so a
// walk still moves forward and loops with the stack's root continuation (TimeWrap::Loop).
// After it, the last frame equals the first one (loop period = frames - 1).

#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/skeleton.hpp>

#include <cstddef>
#include <expected>
#include <string>

namespace kimodo::anim {

struct LoopOptions {
    std::size_t blend = 0;   // frames from each end over which the seam is spread (0: half the clip)
    bool cut = false;        // search the best loop and trim the clip first
    float min_length = 0.5F; // the cut keeps at least this fraction of the clip
};

struct LoopReport {
    std::size_t start = 0, end = 0;  // frames of the original clip kept ([start, end])
    std::size_t blend = 0;           // blend frames used
    float seam_degrees_before = 0.F; // largest joint rotation difference first vs last frame
    float seam_root_before = 0.F;    // root offset first vs last (after removing the travel), metres
    float seam_degrees_after = 0.F;
};

[[nodiscard]] std::expected<LoopReport, std::string> make_loopable(AnimationClip &clip, const Skeleton &skeleton,
                                                                   const LoopOptions &options = {});

} // namespace kimodo::anim
