#include <kimodo/anim/root_motion.hpp>

#include <cmath>

namespace kimodo::anim {

std::expected<void, std::string> validate(const RootMotionSettings &s) {
    const AxisConvention &a = s.axes;
    if (std::fabs(length(a.up) - 1.F) > 1.e-3F || std::fabs(length(a.forward) - 1.F) > 1.e-3F)
        return std::unexpected("up and forward axes must be unit vectors");
    if (std::fabs(dot(a.up, a.forward)) > 1.e-3F) return std::unexpected("up and forward axes must be perpendicular");
    switch (s.mode) {
    case RootMotionMode::Full:
    case RootMotionMode::InPlace:
        if (s.path && !s.path_preview_only)
            return std::unexpected(std::string(s.mode == RootMotionMode::Full ? "Full" : "InPlace") +
                                   " root motion and a custom path are mutually exclusive; use CustomPath, or mark "
                                   "the path as preview only");
        return {};
    case RootMotionMode::CustomPath:
        if (!s.path) return std::unexpected("CustomPath root motion needs a path");
        return {};
    }
    return std::unexpected("unknown root motion mode");
}

std::expected<void, std::string> make_in_place(AnimationClip &clip, const AxisConvention &axes,
                                               const InPlaceOptions &options) {
    if (clip.frames() == 0) return std::unexpected("clip has no frames");
    const Vec3 start = options.at_origin ? Vec3{} : clip.at(0, 0).translation;
    const Vec3 lateral = axes.lateral();
    for (std::size_t f = 0; f < clip.frames(); ++f) {
        Vec3 &t = clip.at(f, 0).translation;
        const Vec3 d = t - start;
        Vec3 remove{};
        if (options.lock_forward) remove = remove + axes.forward * dot(d, axes.forward);
        if (options.lock_lateral) remove = remove + lateral * dot(d, lateral);
        t = t - remove;
    }
    return {};
}

std::expected<void, std::string> apply_root_motion(AnimationClip &clip, const RootMotionSettings &settings) {
    if (auto ok = validate(settings); !ok) return ok;
    switch (settings.mode) {
    case RootMotionMode::Full: return {};
    case RootMotionMode::InPlace: return make_in_place(clip, settings.axes, settings.in_place);
    case RootMotionMode::CustomPath: {
        auto path = MotionPath::build(*settings.path, settings.axes);
        if (!path) return std::unexpected(path.error());
        return follow_path(clip, *path, settings.axes, settings.follow);
    }
    }
    return std::unexpected("unknown root motion mode");
}

} // namespace kimodo::anim
