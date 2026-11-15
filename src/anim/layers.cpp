#include <kimodo/anim/layers.hpp>
#include <kimodo/anim/retarget.hpp> // detect_roles for the body-part presets

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>
#include <unordered_map>

namespace kimodo::anim {
namespace {

Transform interpolate(const Transform &a, const Transform &b, float w) {
    if (w <= 0.F) return a;
    if (w >= 1.F) return b;
    return {lerp(a.translation, b.translation, w), slerp(a.rotation, b.rotation, w), lerp(a.scale, b.scale, w)};
}

// Joints in the subtree of `root` (including it).
std::vector<bool> subtree(const Skeleton &s, int root) {
    std::vector<bool> in(s.size(), false);
    if (root < 0) return in;
    in[static_cast<std::size_t>(root)] = true;
    for (std::size_t j = static_cast<std::size_t>(root) + 1; j < s.size(); ++j) // parents precede children
        if (const int p = s.joints[j].parent; p >= 0 && in[static_cast<std::size_t>(p)]) in[j] = true;
    return in;
}

std::vector<bool> upper_body(const Skeleton &s) {
    const SkeletonRoles r = detect_roles(s);
    const int start = !r.spine.empty() ? r.spine.front() : !r.neck.empty() ? r.neck.front() : -1;
    if (start >= 0) return subtree(s, start);
    // No spine: neck/head and the arms, each as a subtree.
    std::vector<bool> in(s.size(), false);
    for (const Role role : {Role::Head, Role::LeftClavicle, Role::RightClavicle, Role::LeftUpperArm, Role::RightUpperArm}) {
        const auto part = subtree(s, r[role]);
        for (std::size_t j = 0; j < s.size(); ++j) in[j] = in[j] || part[j];
    }
    return in;
}

AnimationMask mask_of(const Skeleton &s, const std::vector<bool> &upper, bool want_upper, std::string name) {
    AnimationMask m;
    m.name = std::move(name);
    m.default_weight = 0.F;
    for (std::size_t j = 0; j < s.size(); ++j) m.weights[s.joints[j].name] = upper[j] == want_upper ? 1.F : 0.F;
    return m;
}

} // namespace

float AnimationMask::weight(std::string_view joint) const {
    const auto it = weights.find(joint);
    return it != weights.end() ? it->second : default_weight;
}

AnimationMask full_body_mask() { return {}; }
AnimationMask upper_body_mask(const Skeleton &s) { return mask_of(s, upper_body(s), true, "upper"); }
AnimationMask lower_body_mask(const Skeleton &s) { return mask_of(s, upper_body(s), false, "lower"); }

std::expected<AnimationMask, std::string> mask_from_json(std::string_view text) {
    try {
        const auto j = nlohmann::json::parse(text);
        if (!j.is_object() || j.value("version", 1) != 1) return std::unexpected("mask JSON must be a version 1 object");
        AnimationMask m;
        m.name = j.value("name", "custom");
        m.default_weight = j.value("default", 0.F);
        if (j.contains("weights")) {
            if (!j["weights"].is_object()) return std::unexpected("mask \"weights\" must be an object");
            for (const auto &[name, w] : j["weights"].items()) {
                const float v = w.get<float>();
                if (!std::isfinite(v) || v < 0.F || v > 1.F) return std::unexpected("mask weight of '" + name + "' must be in [0, 1]");
                m.weights[name] = v;
            }
        }
        if (!std::isfinite(m.default_weight) || m.default_weight < 0.F || m.default_weight > 1.F)
            return std::unexpected("mask default weight must be in [0, 1]");
        return m;
    } catch (const nlohmann::json::exception &e) {
        return std::unexpected(std::string("invalid mask JSON: ") + e.what());
    }
}

std::string mask_to_json(const AnimationMask &m) {
    nlohmann::ordered_json j{{"version", 1}, {"name", m.name}, {"default", m.default_weight}};
    j["weights"] = nlohmann::ordered_json::object();
    for (const auto &[name, w] : m.weights) j["weights"][name] = w;
    return j.dump(2) + "\n";
}

std::expected<AnimationMask, std::string> load_mask(const std::filesystem::path &path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return std::unexpected("cannot open " + path.string());
    std::stringstream ss;
    ss << in.rdbuf();
    return mask_from_json(ss.str());
}

std::expected<void, std::string> save_mask(const std::filesystem::path &path, const AnimationMask &mask) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out << mask_to_json(mask);
    if (!out) return std::unexpected("cannot write " + path.string());
    return {};
}

std::vector<Transform> sample_clip(const AnimationClip &clip, float t, TimeWrap wrap) {
    const std::size_t n = clip.frames();
    if (n == 0) return {};
    const auto frame = [&](std::size_t f) { return clip.frame(f); };
    if (n == 1 || !std::isfinite(t)) return {frame(0).begin(), frame(0).end()};
    const float duration = clip.duration();
    if (wrap == TimeWrap::Loop && duration > 0.F) {
        t = std::fmod(t, duration);
        if (t < 0.F) t += duration;
    }
    float f = std::clamp(t * clip.fps, 0.F, static_cast<float>(n - 1));
    // t = k / fps comes back as k +- rounding noise: snap so exact frames are copied exactly.
    if (const float k = std::round(f); std::fabs(f - k) < 1.e-4F) f = k;
    const auto i0 = static_cast<std::size_t>(std::floor(f));
    const std::size_t i1 = std::min(i0 + 1, n - 1);
    const float a = f - static_cast<float>(i0);
    const auto f0 = frame(i0), f1 = frame(i1);
    std::vector<Transform> out(f0.begin(), f0.end());
    if (a > 0.F && i1 != i0)
        for (std::size_t j = 0; j < out.size(); ++j) out[j] = interpolate(f0[j], f1[j], a);
    return out;
}

AnimationStack::AnimationStack(Skeleton skeleton) : skeleton_(std::move(skeleton)) {}

std::expected<AnimationStack::Resolved, std::string> AnimationStack::resolve(AnimationLayer layer) const {
    const std::string label = "layer '" + layer.name + "': ";
    if (!std::isfinite(layer.weight) || layer.weight < 0.F || layer.weight > 1.F)
        return std::unexpected(label + "weight must be in [0, 1]");
    const AnimationClip &c = layer.clip;
    if (c.frames() == 0) return std::unexpected(label + "clip has no frames");
    if (!(c.fps > 0.F)) return std::unexpected(label + "clip fps must be positive");
    Resolved r;
    r.track.assign(skeleton_.size(), -1);
    if (c.joint_names.empty()) {
        if (c.joint_count != skeleton_.size())
            return std::unexpected(label + "unnamed clip tracks need exactly one track per skeleton joint");
        for (std::size_t j = 0; j < skeleton_.size(); ++j) r.track[j] = static_cast<int>(j);
    } else {
        if (c.joint_names.size() != c.joint_count) return std::unexpected(label + "clip joint names do not match its tracks");
        std::unordered_map<std::string_view, int> by_name;
        for (std::size_t i = 0; i < c.joint_names.size(); ++i) by_name.emplace(c.joint_names[i], static_cast<int>(i));
        for (std::size_t j = 0; j < skeleton_.size(); ++j)
            if (const auto it = by_name.find(skeleton_.joints[j].name); it != by_name.end()) r.track[j] = it->second;
    }
    if (std::ranges::all_of(r.track, [](int t) { return t < 0; }))
        return std::unexpected(label + "clip shares no joint names with the skeleton");
    r.mask.resize(skeleton_.size());
    for (std::size_t j = 0; j < skeleton_.size(); ++j) r.mask[j] = std::clamp(layer.mask.weight(skeleton_.joints[j].name), 0.F, 1.F);

    r.reference.resize(skeleton_.size());
    std::vector<Transform> ref_tracks;
    switch (layer.reference) {
    case AdditiveReference::FirstFrame: ref_tracks.assign(c.frame(0).begin(), c.frame(0).end()); break;
    case AdditiveReference::Frame:
        if (layer.reference_frame >= c.frames())
            return std::unexpected(label + "reference frame " + std::to_string(layer.reference_frame) + " is out of range");
        ref_tracks.assign(c.frame(layer.reference_frame).begin(), c.frame(layer.reference_frame).end());
        break;
    case AdditiveReference::RestPose: break;
    }
    for (std::size_t j = 0; j < skeleton_.size(); ++j)
        r.reference[j] = layer.reference == AdditiveReference::RestPose || r.track[j] < 0
                             ? skeleton_.joints[j].rest_local
                             : ref_tracks[static_cast<std::size_t>(r.track[j])];
    // Clip timing.
    const ClipTiming &tm = layer.timing;
    if (!std::isfinite(tm.start) || !std::isfinite(tm.trim_in) || !std::isfinite(tm.trim_out) || !std::isfinite(tm.speed) ||
        !std::isfinite(tm.fade_in) || !std::isfinite(tm.fade_out))
        return std::unexpected(label + "timing values must be finite");
    if (!(tm.speed > 0.F)) return std::unexpected(label + "speed must be positive");
    if (tm.repeat < 1) return std::unexpected(label + "repeat must be at least 1");
    if (tm.trim_in < 0.F || tm.fade_in < 0.F || tm.fade_out < 0.F) return std::unexpected(label + "trim and fades must be >= 0");
    const float length = c.duration();
    r.trim_in = std::min(tm.trim_in, length);
    const float out = tm.trim_out > r.trim_in ? std::min(tm.trim_out, length) : length;
    r.segment = std::max(out - r.trim_in, 0.F);
    if (const int root_track = r.track.empty() ? -1 : r.track[0]; root_track >= 0 && r.segment > 0.F) {
        const Vec3 a = sample_clip(c, r.trim_in)[static_cast<std::size_t>(root_track)].translation;
        const Vec3 b = sample_clip(c, r.trim_in + r.segment)[static_cast<std::size_t>(root_track)].translation;
        r.cycle_travel = {b.x - a.x, 0.F, b.z - a.z}; // horizontal (Y up)
    }
    r.layer = std::move(layer);
    return r;
}

float AnimationStack::layer_end(const Resolved &r) const {
    const ClipTiming &tm = r.layer.timing;
    return tm.start + r.segment / tm.speed * static_cast<float>(tm.repeat);
}

bool AnimationStack::sample_layer(std::size_t index, float t, std::vector<Transform> &out, float &weight) const {
    const Resolved &r = layers_[index];
    const AnimationLayer &l = r.layer;
    const ClipTiming &tm = l.timing;
    const float local = (t - tm.start) * tm.speed;      // clip seconds since the layer started
    const float span = r.segment * static_cast<float>(tm.repeat);
    const bool loop = l.wrap == TimeWrap::Loop && r.segment > 0.F;
    weight = 1.F;
    float u;          // clip seconds within the segment
    float cycle = 0.F; // completed cycles (root continuation)
    if (local < 0.F) {
        if (tm.extend == Extend::None) return false;
        u = 0.F;
    } else if (!loop && local > span) {
        if (tm.extend == Extend::None) return false;
        u = r.segment;
        cycle = static_cast<float>(tm.repeat - 1);
    } else if (r.segment > 0.F) {
        cycle = std::floor(local / r.segment);
        if (!loop) cycle = std::min(cycle, static_cast<float>(tm.repeat - 1));
        u = local - cycle * r.segment;
    } else {
        u = 0.F;
    }
    // Fades on the timeline range [start, end].
    const float tl = t - tm.start, end = span / tm.speed;
    if (tm.fade_in > 0.F && tl < tm.fade_in) weight *= std::clamp(tl / tm.fade_in, 0.F, 1.F);
    if (tm.fade_out > 0.F && !loop && tl > end - tm.fade_out) weight *= std::clamp((end - tl) / tm.fade_out, 0.F, 1.F);
    out = sample_clip(l.clip, r.trim_in + u, TimeWrap::Clamp);
    if (r.track.empty() || r.track[0] < 0) return true;
    Transform &root = out[static_cast<std::size_t>(r.track[0])];
    if (cycle > 0.F) root.translation = root.translation + r.cycle_travel * cycle;
    if (tm.align_root) {
        Alignment &al = alignment_[index];
        if (!al.ready) {
            const auto below = evaluate_below(index, tm.start);
            const Transform first = sample_clip(l.clip, r.trim_in)[static_cast<std::size_t>(r.track[0])];
            const AxisConvention axes;
            const float yaw = axes.heading(rotate(below[0].rotation, axes.forward)) -
                              axes.heading(rotate(first.rotation, axes.forward));
            al = {true, Quat::from_axis_angle(axes.up, yaw), axes.horizontal(first.translation), axes.horizontal(below[0].translation)};
        }
        const Vec3 h{root.translation.x - al.from.x, 0.F, root.translation.z - al.from.z};
        const Vec3 moved = rotate(al.yaw, h) + al.to;
        root.translation = {moved.x, root.translation.y, moved.z};
        root.rotation = normalize(al.yaw * root.rotation);
    }
    return true;
}

std::expected<void, std::string> AnimationStack::add_layer(AnimationLayer layer) {
    auto r = resolve(std::move(layer));
    if (!r) return std::unexpected(r.error());
    layers_.push_back(std::move(*r));
    alignment_.assign(layers_.size(), {});
    return {};
}

std::expected<void, std::string> AnimationStack::replace_layer(std::size_t i, AnimationLayer layer) {
    if (i >= layers_.size()) return std::unexpected("layer index out of range");
    auto r = resolve(std::move(layer));
    if (!r) return std::unexpected(r.error());
    layers_[i] = std::move(*r);
    alignment_.assign(layers_.size(), {});
    return {};
}

void AnimationStack::move_layer(std::size_t from, std::size_t to) {
    if (from >= layers_.size() || to >= layers_.size() || from == to) return;
    auto item = std::move(layers_[from]);
    layers_.erase(layers_.begin() + static_cast<std::ptrdiff_t>(from));
    layers_.insert(layers_.begin() + static_cast<std::ptrdiff_t>(to), std::move(item));
    alignment_.assign(layers_.size(), {});
}

void AnimationStack::remove_layer(std::size_t i) {
    if (i < layers_.size()) layers_.erase(layers_.begin() + static_cast<std::ptrdiff_t>(i));
    alignment_.assign(layers_.size(), {});
}

float AnimationStack::duration() const {
    float d = 0.F;
    for (const Resolved &r : layers_)
        if (r.layer.enabled) d = std::max(d, r.layer.wrap == TimeWrap::Loop ? r.layer.timing.start + r.segment / r.layer.timing.speed : layer_end(r));
    return d;
}

std::vector<Transform> AnimationStack::evaluate(float t) const { return evaluate_below(layers_.size(), t); }

// Pose of layers [0, index) at time t.
std::vector<Transform> AnimationStack::evaluate_below(std::size_t index, float t) const {
    std::vector<Transform> pose(skeleton_.size());
    for (std::size_t j = 0; j < skeleton_.size(); ++j) pose[j] = skeleton_.joints[j].rest_local;
    std::vector<Transform> sample;
    for (std::size_t li = 0; li < index && li < layers_.size(); ++li) {
        const Resolved &r = layers_[li];
        const AnimationLayer &l = r.layer;
        if (!l.enabled || l.muted || l.weight <= 0.F) continue;
        float fade = 1.F;
        if (!sample_layer(li, t, sample, fade) || fade <= 0.F) continue;
        for (std::size_t j = 0; j < pose.size(); ++j) {
            const int track = r.track[j];
            if (track < 0) continue;
            const float w = std::clamp(l.weight * fade * r.mask[j], 0.F, 1.F);
            if (w <= 0.F) continue;
            const Transform &s = sample[static_cast<std::size_t>(track)];
            if (l.mode == BlendMode::Override) {
                pose[j] = interpolate(pose[j], s, w);
            } else { // Additive (rotation and translation; scale is not additive)
                const Transform &ref = r.reference[j];
                Quat delta = inverse(normalize(ref.rotation)) * normalize(s.rotation);
                if (w < 1.F) delta = slerp(Quat{}, delta, w);
                pose[j].rotation = normalize(pose[j].rotation * delta);
                pose[j].translation = pose[j].translation + (s.translation - ref.translation) * w;
            }
        }
    }
    return pose;
}

AnimationClip AnimationStack::bake(float fps) const {
    if (!(fps > 0.F)) {
        fps = 30.F;
        for (const Resolved &r : layers_)
            if (r.layer.enabled) { fps = r.layer.clip.fps; break; }
    }
    AnimationClip out;
    out.name = "stack";
    out.fps = fps;
    out.joint_count = skeleton_.size();
    for (const Joint &j : skeleton_.joints) out.joint_names.push_back(j.name);
    const auto frames = static_cast<std::size_t>(std::lround(duration() * fps)) + 1;
    out.locals.reserve(frames * out.joint_count);
    for (std::size_t f = 0; f < frames; ++f) {
        const auto pose = evaluate(static_cast<float>(f) / fps);
        out.locals.insert(out.locals.end(), pose.begin(), pose.end());
    }
    return out;
}

} // namespace kimodo::anim
