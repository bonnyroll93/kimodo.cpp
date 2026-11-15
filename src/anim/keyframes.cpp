#include <kimodo/anim/keyframes.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <numbers>
#include <sstream>

namespace kimodo::anim {
namespace {
constexpr std::array<std::string_view, ChannelCount> channel_names{"rx", "ry", "rz", "tx", "ty", "tz"};
constexpr float deg = std::numbers::pi_v<float> / 180.F;

float bezier1(float a, float b, float c, float d, float u) {
    const float m = 1.F - u;
    return m * m * m * a + 3.F * m * m * u * b + 3.F * m * u * u * c + u * u * u * d;
}
} // namespace

std::string_view channel_name(int channel) noexcept {
    return channel >= 0 && channel < ChannelCount ? channel_names[static_cast<std::size_t>(channel)] : "?";
}

void Curve::sort() {
    std::ranges::stable_sort(keys, {}, &Keyframe::frame);
}

std::array<std::array<float, 2>, 2> Curve::handles(std::size_t i) const {
    const Keyframe &k = keys[i];
    if (!k.auto_tangent) return {k.left, k.right};
    const bool has_prev = i > 0, has_next = i + 1 < keys.size();
    const float dl = has_prev ? k.frame - keys[i - 1].frame : 1.F;
    const float dr = has_next ? keys[i + 1].frame - k.frame : 1.F;
    float slope = 0.F;
    if (has_prev && has_next) {
        const float vp = keys[i - 1].value, vn = keys[i + 1].value;
        const bool extremum = (k.value >= vp && k.value >= vn) || (k.value <= vp && k.value <= vn);
        const float span = keys[i + 1].frame - keys[i - 1].frame;
        slope = extremum || span <= 0.F ? 0.F : (vn - vp) / span;
    }
    return {std::array<float, 2>{-dl / 3.F, -slope * dl / 3.F}, std::array<float, 2>{dr / 3.F, slope * dr / 3.F}};
}

float Curve::evaluate(float frame) const {
    if (keys.empty()) return 0.F;
    if (frame <= keys.front().frame) return keys.front().value;
    if (frame >= keys.back().frame) return keys.back().value;
    const auto it = std::ranges::upper_bound(keys, frame, {}, &Keyframe::frame);
    const auto i1 = static_cast<std::size_t>(it - keys.begin()), i0 = i1 - 1;
    const Keyframe &a = keys[i0], &b = keys[i1];
    const float span = b.frame - a.frame;
    if (span <= 0.F) return b.value;
    switch (a.interpolation) {
    case KeyInterpolation::Constant: return a.value;
    case KeyInterpolation::Linear: return a.value + (b.value - a.value) * (frame - a.frame) / span;
    case KeyInterpolation::Bezier: break;
    }
    const auto ha = handles(i0), hb = handles(i1);
    const float x1 = a.frame + std::clamp(ha[1][0], 0.F, span), y1 = a.value + ha[1][1];
    const float x2 = b.frame + std::clamp(hb[0][0], -span, 0.F), y2 = b.value + hb[0][1];
    // x(u) is monotonic with the clamped handles: bisection for u.
    float lo = 0.F, hi = 1.F;
    for (int it2 = 0; it2 < 40; ++it2) {
        const float mid = .5F * (lo + hi);
        if (bezier1(a.frame, x1, x2, b.frame, mid) < frame) lo = mid;
        else hi = mid;
    }
    return bezier1(a.value, y1, y2, b.value, .5F * (lo + hi));
}

float KeyframeTracks::last_frame() const {
    float last = 0.F;
    for (const auto &[name, curves] : joints)
        for (const Curve &c : curves)
            if (!c.keys.empty()) last = std::max(last, c.keys.back().frame);
    return last;
}

Quat euler_xyz_degrees(float x, float y, float z) noexcept {
    return normalize(Quat::from_axis_angle({1, 0, 0}, x * deg) * Quat::from_axis_angle({0, 1, 0}, y * deg) *
                     Quat::from_axis_angle({0, 0, 1}, z * deg));
}

std::expected<KeyframeTracks, std::string> keyframes_from_json(std::string_view text) {
    try {
        const auto j = nlohmann::json::parse(text);
        if (!j.is_object() || j.value("version", 1) != 1) return std::unexpected("keyframes JSON must be a version 1 object");
        KeyframeTracks t;
        t.fps = j.value("fps", 30.F);
        if (!(t.fps > 0.F) || !std::isfinite(t.fps)) return std::unexpected("keyframes fps must be positive");
        if (!j.contains("tracks")) return t;
        if (!j["tracks"].is_object()) return std::unexpected("\"tracks\" must be an object");
        for (const auto &[joint, channels] : j["tracks"].items()) {
            if (!channels.is_object()) return std::unexpected("tracks of '" + joint + "' must be an object");
            auto &curves = t.joints[joint];
            for (int c = 0; c < ChannelCount; ++c) {
                const std::string name(channel_names[static_cast<std::size_t>(c)]);
                if (!channels.contains(name)) continue;
                for (const auto &k : channels[name]) {
                    Keyframe key;
                    key.frame = k.at("f").get<float>();
                    key.value = k.at("v").get<float>();
                    if (!std::isfinite(key.frame) || !std::isfinite(key.value) || key.frame < 0.F)
                        return std::unexpected("invalid key in " + joint + "." + name);
                    const std::string interp = k.value("i", std::string("bezier"));
                    if (interp == "constant") key.interpolation = KeyInterpolation::Constant;
                    else if (interp == "linear") key.interpolation = KeyInterpolation::Linear;
                    else if (interp == "bezier") key.interpolation = KeyInterpolation::Bezier;
                    else return std::unexpected("unknown interpolation '" + interp + "'");
                    key.auto_tangent = k.value("a", true);
                    if (k.contains("l")) key.left = {k["l"][0].get<float>(), k["l"][1].get<float>()};
                    if (k.contains("r")) key.right = {k["r"][0].get<float>(), k["r"][1].get<float>()};
                    curves[static_cast<std::size_t>(c)].keys.push_back(key);
                }
                curves[static_cast<std::size_t>(c)].sort();
            }
        }
        return t;
    } catch (const nlohmann::json::exception &e) {
        return std::unexpected(std::string("invalid keyframes JSON: ") + e.what());
    }
}

std::string keyframes_to_json(const KeyframeTracks &t) {
    nlohmann::ordered_json j{{"version", 1}, {"fps", t.fps}, {"tracks", nlohmann::ordered_json::object()}};
    for (const auto &[joint, curves] : t.joints) {
        nlohmann::ordered_json channels = nlohmann::ordered_json::object();
        for (int c = 0; c < ChannelCount; ++c) {
            const Curve &curve = curves[static_cast<std::size_t>(c)];
            if (curve.keys.empty()) continue;
            auto &arr = channels[std::string(channel_names[static_cast<std::size_t>(c)])] = nlohmann::ordered_json::array();
            for (const Keyframe &k : curve.keys) {
                nlohmann::ordered_json o{{"f", k.frame}, {"v", k.value},
                                         {"i", k.interpolation == KeyInterpolation::Constant ? "constant"
                                               : k.interpolation == KeyInterpolation::Linear ? "linear" : "bezier"},
                                         {"a", k.auto_tangent}};
                if (!k.auto_tangent) {
                    o["l"] = {k.left[0], k.left[1]};
                    o["r"] = {k.right[0], k.right[1]};
                }
                arr.push_back(std::move(o));
            }
        }
        j["tracks"][joint] = std::move(channels);
    }
    return j.dump(2) + "\n";
}

std::expected<KeyframeTracks, std::string> load_keyframes(const std::filesystem::path &path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return std::unexpected("cannot open " + path.string());
    std::stringstream ss;
    ss << in.rdbuf();
    return keyframes_from_json(ss.str());
}

std::expected<KeyframeClip, std::string> keyframe_clip(const KeyframeTracks &tracks, const Skeleton &skeleton,
                                                       std::size_t frames) {
    KeyframeClip out;
    AnimationClip &c = out.clip;
    c.name = "keyframes";
    c.fps = tracks.fps;
    std::vector<std::pair<std::size_t, const std::array<Curve, ChannelCount> *>> keyed;
    for (const auto &[name, curves] : tracks.joints) {
        const int j = skeleton.find(name);
        if (j < 0) {
            out.warnings.push_back("keyed joint '" + name + "' is not in the skeleton");
            continue;
        }
        if (std::ranges::all_of(curves, [](const Curve &cv) { return cv.keys.empty(); })) continue;
        keyed.emplace_back(static_cast<std::size_t>(j), &curves);
        c.joint_names.push_back(name);
    }
    c.joint_count = keyed.size();
    if (keyed.empty()) {
        // Nothing keyed: a single identity track keeps the layer valid and inert.
        c.joint_count = 1;
        c.joint_names = {skeleton.joints.front().name};
        c.locals = {skeleton.joints.front().rest_local};
        return out;
    }
    if (frames == 0) frames = static_cast<std::size_t>(std::ceil(tracks.last_frame())) + 1;
    c.locals.reserve(frames * keyed.size());
    for (std::size_t f = 0; f < frames; ++f)
        for (const auto &[j, curves] : keyed) {
            const auto ev = [&](int ch) { return (*curves)[static_cast<std::size_t>(ch)].evaluate(static_cast<float>(f)); };
            Transform t = skeleton.joints[j].rest_local;
            t.rotation = normalize(t.rotation * euler_xyz_degrees(ev(RotX), ev(RotY), ev(RotZ)));
            t.translation = t.translation + Vec3{ev(PosX), ev(PosY), ev(PosZ)};
            c.locals.push_back(t);
        }
    return out;
}

} // namespace kimodo::anim
