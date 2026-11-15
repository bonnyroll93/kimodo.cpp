#include <kimodo/anim/loop.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace kimodo::anim {
namespace {

constexpr float kDegrees = 57.29577951308232F;

float smoothstep(float x) {
    x = std::clamp(x, 0.F, 1.F);
    return x * x * (3.F - 2.F * x);
}

// Same hemisphere as `ref` (shortest arc).
Quat near(Quat q, Quat ref) { return dot(q, ref) < 0.F ? Quat{-q.x, -q.y, -q.z, -q.w} : q; }

// Pose difference of frames a and b: squared joint angles plus the root height (in leg-ish
// units: 1 m ~ 1 rad).
float pose_distance(const AnimationClip &c, const Skeleton &s, std::size_t a, std::size_t b) {
    float d = 0.F;
    for (std::size_t j = 0; j < c.joint_count; ++j) {
        const float ang = angle_between(c.at(a, j).rotation, c.at(b, j).rotation);
        d += ang * ang;
        if (s.joints[j].parent < 0) {
            const float h = c.at(a, j).translation.y - c.at(b, j).translation.y;
            d += h * h;
        }
    }
    return d;
}

} // namespace

std::expected<LoopReport, std::string> make_loopable(AnimationClip &clip, const Skeleton &s, const LoopOptions &o) {
    if (clip.joint_count != s.size()) return std::unexpected("loop: the clip does not match the skeleton");
    const std::size_t n = clip.frames();
    if (n < 4) return std::unexpected("loop: the clip is too short (needs at least 4 frames)");
    if (!(o.min_length > 0.F && o.min_length <= 1.F)) return std::unexpected("loop: min_length must be in (0, 1]");
    LoopReport report;
    report.end = n - 1;

    // 1. The best cut: matching poses and matching motion around them.
    if (o.cut) {
        const auto min_len = std::max<std::size_t>(3, static_cast<std::size_t>(std::ceil(o.min_length * static_cast<float>(n - 1))));
        float best = std::numeric_limits<float>::max();
        for (std::size_t a = 0; a + min_len < n; ++a)
            for (std::size_t b = a + min_len; b < n; ++b) {
                float d = pose_distance(clip, s, a, b);
                if (a > 0) d += .5F * pose_distance(clip, s, a - 1, b - 1);
                if (b + 1 < n) d += .5F * pose_distance(clip, s, a + 1, b + 1);
                // Prefer longer loops slightly (fewer frames dropped).
                d *= 1.F + .05F * (1.F - static_cast<float>(b - a) / static_cast<float>(n - 1));
                if (d < best) { best = d; report.start = a; report.end = b; }
            }
        if (report.start > 0 || report.end + 1 < n) {
            std::vector<Transform> kept(clip.locals.begin() + static_cast<std::ptrdiff_t>(report.start * clip.joint_count),
                                        clip.locals.begin() + static_cast<std::ptrdiff_t>((report.end + 1) * clip.joint_count));
            clip.locals = std::move(kept);
        }
    }

    // 2. The blend: first and last frames meet on their average pose.
    const std::size_t T = clip.frames() - 1;
    const std::size_t W = std::clamp<std::size_t>(o.blend ? o.blend : T / 2, 1, T);
    report.blend = W;
    const auto w_start = [&](std::size_t t) { return t >= W ? 0.F : 1.F - smoothstep(static_cast<float>(t) / static_cast<float>(W)); };
    const auto w_end = [&](std::size_t t) { return t + W <= T ? 0.F : smoothstep(static_cast<float>(t + W - T) / static_cast<float>(W)); };
    for (std::size_t j = 0; j < clip.joint_count; ++j) {
        const Quat q0 = normalize(clip.at(0, j).rotation), qT = near(normalize(clip.at(T, j).rotation), q0);
        report.seam_degrees_before = std::max(report.seam_degrees_before, angle_between(q0, qT) * kDegrees);
        const Quat mid = slerp(q0, qT, .5F);
        const Quat c0 = normalize(mid * inverse(q0)), cT = normalize(mid * inverse(qT));
        for (std::size_t t = 0; t <= T; ++t) {
            Quat &q = clip.at(t, j).rotation;
            const float a = w_start(t), b = w_end(t);
            if (a > 0.F) q = normalize(slerp(Quat{}, c0, a) * q);
            if (b > 0.F) q = normalize(slerp(Quat{}, cT, b) * q);
        }
        if (s.joints[j].parent >= 0) continue;
        // Root translation: keep the horizontal travel (the straight line first -> last).
        const Vec3 p0 = clip.at(0, j).translation, pT = clip.at(T, j).translation;
        const Vec3 travel{pT.x - p0.x, 0.F, pT.z - p0.z};
        const Vec3 r0 = p0, rT = pT - travel; // residuals at the ends
        report.seam_root_before = std::max(report.seam_root_before, length(rT - r0));
        const Vec3 m = (r0 + rT) * .5F;
        for (std::size_t t = 0; t <= T; ++t)
            clip.at(t, j).translation = clip.at(t, j).translation + (m - r0) * w_start(t) + (m - rT) * w_end(t);
    }
    for (std::size_t j = 0; j < clip.joint_count; ++j)
        report.seam_degrees_after = std::max(report.seam_degrees_after, angle_between(clip.at(0, j).rotation, clip.at(T, j).rotation) * kDegrees);
    return report;
}

} // namespace kimodo::anim
