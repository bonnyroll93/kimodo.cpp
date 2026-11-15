#include <kimodo/anim/motion_path.hpp>

#include <algorithm>
#include <cmath>

namespace kimodo::anim {
namespace {

constexpr std::size_t samples_per_segment = 64;
constexpr float merge_epsilon = 1.e-6F;

// Centripetal Catmull-Rom (alpha = 0.5) through p1..p2 (Barry-Goldman pyramid), t in [0, 1].
Vec3 catmull_rom(Vec3 p0, Vec3 p1, Vec3 p2, Vec3 p3, float u) {
    auto knot = [](float ti, Vec3 a, Vec3 b) { return ti + std::sqrt(std::max(anim::length(b - a), 1.e-6F)); };
    const float t0 = 0.F, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
    const float t = t1 + (t2 - t1) * u;
    auto mix = [](Vec3 a, Vec3 b, float ta, float tb, float tt) {
        return a * ((tb - tt) / (tb - ta)) + b * ((tt - ta) / (tb - ta));
    };
    const Vec3 a1 = mix(p0, p1, t0, t1, t), a2 = mix(p1, p2, t1, t2, t), a3 = mix(p2, p3, t2, t3, t);
    const Vec3 b1 = mix(a1, a2, t0, t2, t), b2 = mix(a2, a3, t1, t3, t);
    return mix(b1, b2, t1, t2, t);
}

} // namespace

std::expected<MotionPath, std::string> MotionPath::build(const MotionPathSpec &spec, const AxisConvention &axes) {
    if (spec.points.empty()) return std::unexpected("motion path has no points");
    MotionPath path;
    path.loop_ = spec.loop;
    for (const Vec3 &raw : spec.points) {
        if (!std::isfinite(raw.x) || !std::isfinite(raw.y) || !std::isfinite(raw.z))
            return std::unexpected("motion path has a non-finite point");
        const Vec3 p = axes.horizontal(raw);
        if (path.knots_.empty() || anim::length(p - path.knots_.back()) > merge_epsilon) path.knots_.push_back(p);
    }
    if (path.loop_ && path.knots_.size() > 1 && anim::length(path.knots_.front() - path.knots_.back()) <= merge_epsilon)
        path.knots_.pop_back();

    const std::size_t n = path.knots_.size();
    path.dense_.push_back(path.knots_[0]);
    path.cumulative_.push_back(0.F);
    path.knot_s_.push_back(0.F);
    if (n == 1) return path;
    if (n == 2) path.loop_ = false; // a two-point loop would only retrace itself; treat it as open

    const std::size_t segments = path.loop_ ? n : n - 1;
    auto knot = [&](long i) -> Vec3 {
        if (path.loop_) return path.knots_[static_cast<std::size_t>((i % static_cast<long>(n) + static_cast<long>(n)) % static_cast<long>(n))];
        if (i < 0) return path.knots_[0] * 2.F - path.knots_[1];                  // reflected phantom start
        if (i >= static_cast<long>(n)) return path.knots_[n - 1] * 2.F - path.knots_[n - 2]; // phantom end
        return path.knots_[static_cast<std::size_t>(i)];
    };
    for (std::size_t seg = 0; seg < segments; ++seg) {
        const long i = static_cast<long>(seg);
        const Vec3 p1 = knot(i), p2 = knot(i + 1);
        const std::size_t steps = spec.interpolation == PathInterpolation::Polyline ? 1 : samples_per_segment;
        for (std::size_t k = 1; k <= steps; ++k) {
            const float u = static_cast<float>(k) / static_cast<float>(steps);
            const Vec3 p = spec.interpolation == PathInterpolation::Polyline ? lerp(p1, p2, u)
                                                                            : catmull_rom(knot(i - 1), p1, p2, knot(i + 2), u);
            path.cumulative_.push_back(path.cumulative_.back() + anim::length(p - path.dense_.back()));
            path.dense_.push_back(p);
        }
        if (seg + 1 < n) path.knot_s_.push_back(path.cumulative_.back());
    }
    path.total_ = path.cumulative_.back();
    return path;
}

float MotionPath::wrap(float s) const noexcept {
    if (!(total_ > 0.F)) return 0.F;
    if (loop_) {
        s = std::fmod(s, total_);
        return s < 0.F ? s + total_ : s;
    }
    return std::clamp(s, 0.F, total_);
}

Vec3 MotionPath::position(float s) const noexcept {
    if (dense_.size() < 2) return dense_.empty() ? Vec3{} : dense_.front();
    s = wrap(s);
    const auto it = std::upper_bound(cumulative_.begin(), cumulative_.end(), s);
    if (it == cumulative_.end()) return dense_.back();
    const auto k = static_cast<std::size_t>(it - cumulative_.begin()); // cumulative_[k-1] <= s < cumulative_[k]
    const float span = cumulative_[k] - cumulative_[k - 1];
    return span > 0.F ? lerp(dense_[k - 1], dense_[k], (s - cumulative_[k - 1]) / span) : dense_[k];
}

Vec3 MotionPath::tangent(float s) const noexcept {
    if (!(total_ > 0.F)) return {};
    s = wrap(s);
    auto k = static_cast<std::size_t>(std::upper_bound(cumulative_.begin(), cumulative_.end(), s) - cumulative_.begin());
    k = std::clamp<std::size_t>(k, 1, dense_.size() - 1);
    // Skip zero-length steps forward, then backward.
    for (std::size_t j = k; j < dense_.size(); ++j)
        if (const Vec3 d = dense_[j] - dense_[j - 1]; anim::length(d) > 0.F) return normalize(d);
    for (std::size_t j = k; j >= 1; --j)
        if (const Vec3 d = dense_[j] - dense_[j - 1]; anim::length(d) > 0.F) return normalize(d);
    return {};
}

float MotionPath::waypoint_distance(std::size_t i) const noexcept {
    return i < knot_s_.size() ? knot_s_[i] : total_;
}

std::vector<Vec3> MotionPath::sample(std::size_t n) const {
    n = std::max<std::size_t>(n, 2);
    std::vector<Vec3> out;
    out.reserve(n);
    for (std::size_t i = 0; i < n; ++i) {
        const float s = total_ * static_cast<float>(i) / static_cast<float>(n - 1);
        out.push_back(loop_ && i + 1 == n ? dense_.front() : position(s));
    }
    return out;
}

std::expected<void, std::string> follow_path(AnimationClip &clip, const MotionPath &path, const AxisConvention &axes,
                                             const PathFollowOptions &options) {
    const std::size_t frames = clip.frames();
    if (frames == 0) return std::unexpected("clip has no frames");
    if (!std::isfinite(options.duration) || options.duration < 0.F)
        return std::unexpected("path duration must be >= 0");
    if (!std::isfinite(options.speed) || options.speed < 0.F) return std::unexpected("path speed must be >= 0");

    std::vector<float> distance(frames, 0.F);
    PathTiming timing = options.timing;
    if (timing == PathTiming::MotionDistance) {
        for (std::size_t f = 1; f < frames; ++f)
            distance[f] = distance[f - 1] +
                          anim::length(axes.horizontal(clip.at(f, 0).translation - clip.at(f - 1, 0).translation));
        if (distance.back() < 1.e-3F) timing = PathTiming::Duration; // in-place input: nothing to follow
    }
    if (timing == PathTiming::Duration) {
        const float duration = options.duration > 0.F ? options.duration : clip.duration();
        for (std::size_t f = 0; f < frames; ++f)
            distance[f] = duration > 0.F ? path.length() * (static_cast<float>(f) / clip.fps) / duration : 0.F;
    } else if (timing == PathTiming::Speed) {
        for (std::size_t f = 0; f < frames; ++f) distance[f] = options.speed * static_cast<float>(f) / clip.fps;
    }

    const float heading0 = axes.heading(rotate(clip.at(0, 0).rotation, axes.forward));
    Vec3 last_tangent{};
    for (std::size_t f = 0; f < frames; ++f) {
        Transform &root = clip.at(f, 0);
        const float height = dot(root.translation, axes.up);
        root.translation = path.position(distance[f]) + axes.up * height;
        if (!options.orient_to_path) continue;
        if (const Vec3 t = path.tangent(distance[f]); anim::length(t) > 0.F) last_tangent = t;
        if (anim::length(last_tangent) == 0.F) continue; // zero-length path: keep the generated facing
        const float yaw = axes.heading(last_tangent) - heading0;
        root.rotation = normalize(Quat::from_axis_angle(axes.up, yaw) * root.rotation);
    }
    return {};
}

} // namespace kimodo::anim
