#include <kimodo/anim/ik.hpp>
#include <kimodo/anim/retarget.hpp> // detect_roles

#include <algorithm>
#include <cmath>
#include <unordered_map>

namespace kimodo::anim {
namespace {

float clamp1(float v) { return std::clamp(v, -1.F, 1.F); }
float angle(Vec3 a, Vec3 b) { return std::acos(clamp1(dot(normalize(a), normalize(b)))); }

// The clip re-expressed in skeleton joint order (joints without a track stay at rest).
std::expected<AnimationClip, std::string> in_skeleton_order(const AnimationClip &clip, const Skeleton &s) {
    std::vector<int> track(s.size(), -1);
    if (clip.joint_names.empty()) {
        if (clip.joint_count != s.size()) return std::unexpected("clip tracks do not match the skeleton");
        for (std::size_t j = 0; j < s.size(); ++j) track[j] = static_cast<int>(j);
    } else {
        std::unordered_map<std::string_view, int> by_name;
        for (std::size_t i = 0; i < clip.joint_names.size(); ++i) by_name.emplace(clip.joint_names[i], static_cast<int>(i));
        for (std::size_t j = 0; j < s.size(); ++j)
            if (auto it = by_name.find(s.joints[j].name); it != by_name.end()) track[j] = it->second;
    }
    AnimationClip out;
    out.name = clip.name;
    out.fps = clip.fps;
    out.joint_count = s.size();
    for (const Joint &j : s.joints) out.joint_names.push_back(j.name);
    out.locals.resize(clip.frames() * s.size());
    for (std::size_t f = 0; f < clip.frames(); ++f)
        for (std::size_t j = 0; j < s.size(); ++j)
            out.at(f, j) = track[j] >= 0 ? clip.at(f, static_cast<std::size_t>(track[j])) : s.joints[j].rest_local;
    return out;
}

bool solve(const Skeleton &s, std::span<Transform> local, int a, int b, int c, Vec3 target, bool keep_end,
           Vec3 bend_hint) {
    const auto global = forward_kinematics(s, local);
    const auto ia = static_cast<std::size_t>(a), ib = static_cast<std::size_t>(b), ic = static_cast<std::size_t>(c);
    const Vec3 A = global[ia].translation, B = global[ib].translation, C = global[ic].translation;
    const float la = length(B - A), lb = length(C - B);
    if (la < 1.e-6F || lb < 1.e-6F) return false;
    const Vec3 at = target - A;
    const float dist = length(at);
    const float eps = 1.e-4F * (la + lb);
    const bool reachable = dist <= la + lb && dist >= std::fabs(la - lb);
    const float d = std::clamp(dist, std::fabs(la - lb) + eps, la + lb - eps);

    // 1. Knee: rotate the lower bone about the bend-plane normal so that |AC| = d.
    Vec3 n = cross(A - B, C - B);
    if (length(n) < 1.e-6F * la * lb) n = bend_hint; // straight leg: use the hint (knee-forward axis)
    if (length(n) < 1.e-9F) n = cross(A - B, Vec3{0.F, 0.F, 1.F});
    if (length(n) < 1.e-9F) n = cross(A - B, Vec3{1.F, 0.F, 0.F});
    n = normalize(n);
    const float b_now = angle(A - B, C - B);
    const float b_want = std::acos(clamp1((la * la + lb * lb - d * d) / (2.F * la * lb)));
    const Quat W1 = Quat::from_axis_angle(n, b_want - b_now);
    const Vec3 C1 = B + rotate(W1, C - B);
    // 2. Aim: rotate the whole chain about A so that C lands on the target direction.
    const Quat W2 = dist > 1.e-9F ? from_to(C1 - A, at) : Quat{};

    const Quat Ra = normalize(W2 * global[ia].rotation);
    const Quat Rb = normalize(W2 * W1 * global[ib].rotation);
    const int pa = s.joints[ia].parent;
    const Quat parent = pa >= 0 ? global[static_cast<std::size_t>(pa)].rotation : Quat{};
    local[ia].rotation = normalize(inverse(normalize(parent)) * Ra);
    local[ib].rotation = normalize(inverse(Ra) * Rb);
    if (keep_end) local[ic].rotation = normalize(inverse(Rb) * global[ic].rotation);
    return reachable;
}

float height(Vec3 v, Vec3 up) { return dot(v, up); }
Vec3 flat(Vec3 v, Vec3 up) { return v - up * dot(v, up); }

} // namespace

bool solve_two_bone_ik(const Skeleton &skeleton, std::span<Transform> local, int a, int b, int c, Vec3 target,
                       bool keep_end_orientation) {
    const int n = static_cast<int>(skeleton.size());
    if (a < 0 || b < 0 || c < 0 || a >= n || b >= n || c >= n || local.size() != skeleton.size()) return false;
    if (skeleton.joints[static_cast<std::size_t>(b)].parent != a || skeleton.joints[static_cast<std::size_t>(c)].parent != b)
        return false;
    return solve(skeleton, local, a, b, c, target, keep_end_orientation, {});
}

std::expected<std::array<LegChain, 2>, std::string> find_legs(const Skeleton &s) {
    const SkeletonRoles r = detect_roles(s);
    std::array<LegChain, 2> legs{LegChain{r[Role::LeftThigh], r[Role::LeftCalf], r[Role::LeftFoot], r[Role::LeftToe]},
                                 LegChain{r[Role::RightThigh], r[Role::RightCalf], r[Role::RightFoot], r[Role::RightToe]}};
    for (const LegChain &l : legs) {
        if (l.thigh < 0 || l.calf < 0 || l.foot < 0)
            return std::unexpected("could not find both legs (thigh, calf and foot) in '" + s.source + "'");
        if (s.joints[static_cast<std::size_t>(l.calf)].parent != l.thigh || s.joints[static_cast<std::size_t>(l.foot)].parent != l.calf)
            return std::unexpected("leg joints of '" + s.source + "' are not a direct thigh -> calf -> foot chain");
    }
    return legs;
}

namespace {

struct Analysis {
    AnimationClip clip; // skeleton order
    std::array<LegChain, 2> legs;
    std::vector<std::array<Vec3, 2>> ankle, toe;
    std::vector<std::array<Vec3, 2>> lateral; // per frame, -(left hip - right hip) direction (knee hint)
    std::vector<FootContact> contacts;
    float ground = 0.F, leg = 0.F, h = 0.F, v = 0.F;
};

std::expected<Analysis, std::string> analyse(const AnimationClip &input, const Skeleton &s, const FootLockOptions &o) {
    if (input.frames() == 0) return std::unexpected("clip has no frames");
    if (!(input.fps > 0.F)) return std::unexpected("clip fps must be positive");
    if (std::fabs(length(o.up) - 1.F) > 1.e-3F) return std::unexpected("up must be a unit vector");
    auto legs = find_legs(s);
    if (!legs) return std::unexpected(legs.error());
    auto clip = in_skeleton_order(input, s);
    if (!clip) return std::unexpected(clip.error());
    Analysis a{std::move(*clip), *legs, {}, {}, {}, {}, 0.F, 0.F, 0.F, 0.F};
    const auto rest = s.rest_global();
    for (const LegChain &l : a.legs)
        a.leg += .5F * (length(rest[static_cast<std::size_t>(l.calf)].translation - rest[static_cast<std::size_t>(l.thigh)].translation) +
                        length(rest[static_cast<std::size_t>(l.foot)].translation - rest[static_cast<std::size_t>(l.calf)].translation));
    a.h = o.height_threshold > 0.F ? o.height_threshold : .08F * a.leg;
    a.v = o.speed_threshold > 0.F ? o.speed_threshold : .4F * a.leg;

    const std::size_t frames = a.clip.frames();
    a.ankle.resize(frames);
    a.toe.resize(frames);
    a.lateral.resize(frames);
    float lowest = 1.e30F;
    for (std::size_t f = 0; f < frames; ++f) {
        const auto g = forward_kinematics(s, a.clip.frame(f));
        const Vec3 lr = g[static_cast<std::size_t>(a.legs[0].thigh)].translation - g[static_cast<std::size_t>(a.legs[1].thigh)].translation;
        for (std::size_t k = 0; k < 2; ++k) {
            const LegChain &l = a.legs[k];
            a.ankle[f][k] = g[static_cast<std::size_t>(l.foot)].translation;
            a.toe[f][k] = l.toe >= 0 ? g[static_cast<std::size_t>(l.toe)].translation : a.ankle[f][k];
            a.lateral[f][k] = -normalize(lr);
            lowest = std::min({lowest, height(a.ankle[f][k], o.up), height(a.toe[f][k], o.up)});
        }
    }
    // Horizontal ankle speed (central differences) and foot height (lower of ankle and toe).
    std::vector<std::array<float, 2>> speed(frames), low(frames);
    for (std::size_t f = 0; f < frames; ++f) {
        const std::size_t f0 = f > 0 ? f - 1 : f, f1 = f + 1 < frames ? f + 1 : f;
        const float dt = static_cast<float>(f1 - f0) / a.clip.fps;
        for (std::size_t k = 0; k < 2; ++k) {
            speed[f][k] = dt > 0.F ? length(flat(a.ankle[f1][k] - a.ankle[f0][k], o.up)) / dt : 0.F;
            low[f][k] = std::min(height(a.ankle[f][k], o.up), height(a.toe[f][k], o.up));
        }
    }
    // Ground: the median foot height while a foot is (nearly) still, i.e. during stances.
    // Robust to brief dips below the floor (e.g. a long retargeted toe pitching down at
    // toe-off), which would put the clip's lowest point far below the real floor.
    std::vector<float> planted;
    for (std::size_t f = 0; f < frames; ++f)
        for (std::size_t k = 0; k < 2; ++k)
            if (speed[f][k] < a.v) planted.push_back(low[f][k]);
    if (planted.empty()) {
        a.ground = lowest;
    } else {
        std::ranges::nth_element(planted, planted.begin() + static_cast<std::ptrdiff_t>(planted.size() / 2));
        a.ground = planted[planted.size() / 2];
    }
    for (int k = 0; k < 2; ++k) {
        const auto uk = static_cast<std::size_t>(k);
        std::vector<bool> on(frames, false);
        for (std::size_t f = 0; f < frames; ++f) on[f] = low[f][uk] - a.ground < a.h && speed[f][uk] < a.v;
        // Close short gaps, then drop short contacts.
        for (std::size_t f = 0; f < frames;) {
            if (on[f]) { ++f; continue; }
            std::size_t g = f;
            while (g < frames && !on[g]) ++g;
            if (f > 0 && g < frames && g - f <= o.fill_gap_frames) std::fill(on.begin() + static_cast<std::ptrdiff_t>(f), on.begin() + static_cast<std::ptrdiff_t>(g), true);
            f = g;
        }
        for (std::size_t f = 0; f < frames;) {
            if (!on[f]) { ++f; continue; }
            std::size_t g = f;
            while (g < frames && on[g]) ++g;
            if (g - f >= std::max<std::size_t>(o.min_contact_frames, 1)) {
                // Pin at the contact's mean ankle position: the hips travel over the planted foot,
                // so the middle needs the least reach at both ends of the stance.
                Vec3 mean{};
                for (std::size_t i = f; i < g; ++i) mean = mean + a.ankle[i][static_cast<std::size_t>(k)];
                a.contacts.push_back({k, f, g - 1, mean * (1.F / static_cast<float>(g - f))});
            }
            f = g;
        }
    }
    std::ranges::sort(a.contacts, [](const FootContact &x, const FootContact &y) { return x.start != y.start ? x.start < y.start : x.foot < y.foot; });
    return a;
}

float max_slide(const std::vector<FootContact> &contacts, const std::vector<std::array<Vec3, 2>> &ankle, Vec3 up) {
    float worst = 0.F;
    for (const FootContact &c : contacts)
        for (std::size_t f = c.start; f <= c.end; ++f)
            worst = std::max(worst, length(flat(ankle[f][static_cast<std::size_t>(c.foot)] - c.position, up)));
    return worst;
}

} // namespace

std::expected<std::vector<FootContact>, std::string> detect_foot_contacts(const AnimationClip &clip, const Skeleton &skeleton,
                                                                          const FootLockOptions &options) {
    auto a = analyse(clip, skeleton, options);
    if (!a) return std::unexpected(a.error());
    return std::move(a->contacts);
}

std::expected<FootLockResult, std::string> foot_lock(const AnimationClip &clip, const Skeleton &skeleton,
                                                     const FootLockOptions &o) {
    auto analysis = analyse(clip, skeleton, o);
    if (!analysis) return std::unexpected(analysis.error());
    Analysis &a = *analysis;
    const std::size_t frames = a.clip.frames();
    FootLockResult r;
    r.contacts = a.contacts;
    r.ground = a.ground;
    r.leg_length = a.leg;
    r.height_threshold = a.h;
    r.speed_threshold = a.v;
    r.slide_before = max_slide(a.contacts, a.ankle, o.up);

    // Per foot and frame: pin weight and the pinned (horizontal) position.
    std::vector<std::array<float, 2>> weight(frames, {0.F, 0.F});
    std::vector<std::array<Vec3, 2>> pin(frames);
    const auto blend = static_cast<long>(o.blend_frames);
    for (const FootContact &c : a.contacts) {
        const auto k = static_cast<std::size_t>(c.foot);
        for (long f = static_cast<long>(c.start) - blend; f <= static_cast<long>(c.end) + blend; ++f) {
            if (f < 0 || f >= static_cast<long>(frames)) continue;
            float w = 1.F;
            if (f < static_cast<long>(c.start)) w = 1.F - static_cast<float>(static_cast<long>(c.start) - f) / static_cast<float>(blend + 1);
            if (f > static_cast<long>(c.end)) w = 1.F - static_cast<float>(f - static_cast<long>(c.end)) / static_cast<float>(blend + 1);
            const auto uf = static_cast<std::size_t>(f);
            if (w > weight[uf][k]) {
                weight[uf][k] = w;
                pin[uf][k] = c.position;
            }
        }
    }
    // Hip adjustment: per frame, the smallest root drop that brings every pinned ankle within
    // reach (98% of the leg, keeping a slight knee bend), then smoothed so the body moves softly.
    if (o.adjust_hips) {
        const float limit = o.max_hip_drop > 0.F ? o.max_hip_drop : .1F * a.leg;
        const auto rest = skeleton.rest_global();
        std::vector<float> drop(frames, 0.F);
        for (std::size_t f = 0; f < frames; ++f) {
            const auto g = forward_kinematics(skeleton, a.clip.frame(f));
            for (std::size_t k = 0; k < 2; ++k) {
                if (weight[f][k] <= 0.F) continue;
                const LegChain &l = a.legs[k];
                const float reach = .98F * (length(rest[static_cast<std::size_t>(l.calf)].translation - rest[static_cast<std::size_t>(l.thigh)].translation) +
                                            length(rest[static_cast<std::size_t>(l.foot)].translation - rest[static_cast<std::size_t>(l.calf)].translation));
                const Vec3 orig = a.ankle[f][k];
                const Vec3 target = lerp(orig, flat(pin[f][k], o.up) + o.up * height(orig, o.up), weight[f][k]);
                const Vec3 d = g[static_cast<std::size_t>(l.thigh)].translation - target;
                const float h = length(flat(d, o.up)), v = height(d, o.up);
                if (h * h + v * v <= reach * reach) continue;
                const float need = h < reach ? v - std::sqrt(reach * reach - h * h) : v;
                drop[f] = std::max(drop[f], std::clamp(need, 0.F, limit));
            }
        }
        // Smooth: running max then running mean over +-blend frames.
        const long w = std::max<long>(static_cast<long>(o.blend_frames), 1);
        const long n = static_cast<long>(frames);
        std::vector<float> peak(frames, 0.F), smooth(frames, 0.F);
        for (long f = 0; f < n; ++f)
            for (long i = std::max<long>(0, f - w); i <= std::min<long>(n - 1, f + w); ++i)
                peak[static_cast<std::size_t>(f)] = std::max(peak[static_cast<std::size_t>(f)], drop[static_cast<std::size_t>(i)]);
        for (long f = 0; f < n; ++f) {
            float sum = 0.F;
            long count = 0;
            for (long i = std::max<long>(0, f - w); i <= std::min<long>(n - 1, f + w); ++i, ++count) sum += peak[static_cast<std::size_t>(i)];
            smooth[static_cast<std::size_t>(f)] = sum / static_cast<float>(count);
        }
        for (std::size_t f = 0; f < frames; ++f) {
            if (smooth[f] <= 0.F) continue;
            a.clip.at(f, 0).translation = a.clip.at(f, 0).translation - o.up * smooth[f];
            r.max_hip_drop = std::max(r.max_hip_drop, smooth[f]);
        }
    }

    for (std::size_t f = 0; f < frames; ++f) {
        auto pose = std::span<Transform>(a.clip.locals).subspan(f * a.clip.joint_count, a.clip.joint_count);
        for (std::size_t k = 0; k < 2; ++k) {
            const float w = weight[f][k];
            if (w <= 0.F) continue;
            const Vec3 orig = a.ankle[f][k];
            // Pinned horizontally, the animated height is kept (heel and toe roll stay natural).
            const Vec3 locked = flat(pin[f][k], o.up) + o.up * height(orig, o.up);
            const Vec3 target = lerp(orig, locked, w);
            const LegChain &l = a.legs[k];
            if (!solve(skeleton, pose, l.thigh, l.calf, l.foot, target, o.keep_foot_orientation, a.lateral[f][k]))
                ++r.unreachable_frames;
        }
    }
    // Measure the result.
    std::vector<std::array<Vec3, 2>> after(frames);
    for (std::size_t f = 0; f < frames; ++f) {
        const auto g = forward_kinematics(skeleton, a.clip.frame(f));
        for (std::size_t k = 0; k < 2; ++k) after[f][k] = g[static_cast<std::size_t>(a.legs[k].foot)].translation;
    }
    r.slide_after = max_slide(a.contacts, after, o.up);
    r.clip = std::move(a.clip);
    return r;
}

} // namespace kimodo::anim
