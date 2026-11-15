// Role detection, automatic mapping, mapping diagnostics and mapping JSON I/O.
#include <kimodo/anim/retarget.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <fstream>
#include <map>
#include <set>
#include <sstream>

namespace kimodo::anim {
namespace {

enum class Side { None, Left, Right };

struct NameInfo {
    std::vector<std::string> tokens; // lower case words
    std::string compact;             // tokens concatenated
    Side side = Side::None;
};

// "mixamorig:LeftUpLeg" -> {left, up, leg}; "upperarm_l" -> {upperarm, l}; "Bip01 L Thigh" -> {bip01, l, thigh}.
NameInfo analyse(std::string_view raw) {
    if (const auto p = raw.find_last_of(":|"); p != std::string_view::npos) raw = raw.substr(p + 1);
    NameInfo info;
    std::string cur;
    auto flush = [&] {
        if (!cur.empty()) info.tokens.push_back(cur);
        cur.clear();
    };
    for (std::size_t i = 0; i < raw.size(); ++i) {
        const auto c = static_cast<unsigned char>(raw[i]);
        if (!std::isalnum(c)) { flush(); continue; }
        // camelCase boundary: lower->Upper, or digit<->letter is kept together.
        if (std::isupper(c) && i > 0 && std::islower(static_cast<unsigned char>(raw[i - 1]))) flush();
        cur.push_back(static_cast<char>(std::tolower(c)));
    }
    flush();
    for (const auto &t : info.tokens) info.compact += t;
    for (const auto &t : info.tokens) {
        if (t == "left" || t == "l" || t == "lft") { info.side = Side::Left; break; }
        if (t == "right" || t == "r" || t == "rgt") { info.side = Side::Right; break; }
    }
    if (info.side == Side::None) {
        if (info.compact.starts_with("left")) info.side = Side::Left;
        else if (info.compact.starts_with("right")) info.side = Side::Right;
    }
    return info;
}

bool has(const NameInfo &n, std::initializer_list<std::string_view> words) {
    return std::ranges::any_of(words, [&](std::string_view w) { return n.compact.find(w) != std::string::npos; });
}

bool is_ancestor(const Skeleton &s, int ancestor, int joint) {
    for (int p = joint >= 0 ? s.joints[static_cast<std::size_t>(joint)].parent : -1; p >= 0;
         p = s.joints[static_cast<std::size_t>(p)].parent)
        if (p == ancestor) return true;
    return false;
}

int depth(const Skeleton &s, int j) {
    int d = 0;
    for (int p = s.joints[static_cast<std::size_t>(j)].parent; p >= 0; p = s.joints[static_cast<std::size_t>(p)].parent) ++d;
    return d;
}

// Shallowest joint satisfying pred (ties: lowest index).
template <class Pred> int shallowest(const Skeleton &s, Pred pred) {
    int best = -1, best_depth = 1 << 30;
    for (int j = 0; j < static_cast<int>(s.size()); ++j)
        if (pred(j) && depth(s, j) < best_depth) { best = j; best_depth = depth(s, j); }
    return best;
}

constexpr std::array<std::string_view, static_cast<std::size_t>(Role::Count)> role_names{
    "hips", "head",
    "left_clavicle", "left_upper_arm", "left_forearm", "left_hand",
    "right_clavicle", "right_upper_arm", "right_forearm", "right_hand",
    "left_thigh", "left_calf", "left_foot", "left_toe",
    "right_thigh", "right_calf", "right_foot", "right_toe"};

// Chains of different length: first<->first and last<->last always; middle joints go to the
// proportional position when it is still free (extra target joints stay unmapped, at rest).
void proportional(const std::vector<int> &src, const std::vector<int> &dst,
                  std::vector<std::pair<int, int>> &out) { // pairs (target, source)
    if (src.empty() || dst.empty()) return;
    std::set<std::size_t> used{0};
    out.emplace_back(dst.front(), src.front());
    if (src.size() == 1 || dst.size() == 1) return;
    used.insert(dst.size() - 1);
    out.emplace_back(dst.back(), src.back());
    for (std::size_t i = 1; i + 1 < src.size(); ++i) {
        const auto t = static_cast<std::size_t>(std::lround(static_cast<double>(i) * static_cast<double>(dst.size() - 1) /
                                                            static_cast<double>(src.size() - 1)));
        if (used.insert(t).second) out.emplace_back(dst[t], src[i]);
    }
}

} // namespace

std::string_view role_name(Role role) noexcept {
    const auto i = static_cast<std::size_t>(role);
    return i < role_names.size() ? role_names[i] : "unknown";
}

SkeletonRoles detect_roles(const Skeleton &s) {
    SkeletonRoles r;
    r.joint.fill(-1);
    if (s.size() == 0) return r;
    std::vector<NameInfo> info;
    info.reserve(s.size());
    for (const Joint &j : s.joints) info.push_back(analyse(j.name));
    auto at = [&](Role role) -> int & { return r.joint[static_cast<std::size_t>(role)]; };
    auto parent = [&](int j) { return j >= 0 ? s.joints[static_cast<std::size_t>(j)].parent : -1; };
    const std::initializer_list<std::string_view> ex_fingers = {"thumb", "index", "middle", "ring", "pinky", "finger", "end", "nub", "tip"};

    int hips = shallowest(s, [&](int j) { return has(info[static_cast<std::size_t>(j)], {"hips", "pelvis"}); });
    if (hips < 0) hips = 0;
    at(Role::Hips) = hips;

    const int head = shallowest(s, [&](int j) {
        const NameInfo &n = info[static_cast<std::size_t>(j)];
        return n.side == Side::None && has(n, {"head"}) && !has(n, {"end", "top", "nub", "tip"}) && is_ancestor(s, hips, j);
    });
    at(Role::Head) = head;
    if (head >= 0) {
        std::vector<int> path; // hips (exclusive) .. head (exclusive), top-down
        for (int p = parent(head); p >= 0 && p != hips; p = parent(p)) path.insert(path.begin(), p);
        const auto first_neck = std::ranges::find_if(path, [&](int j) { return has(info[static_cast<std::size_t>(j)], {"neck"}); });
        r.spine.assign(path.begin(), first_neck);
        r.neck.assign(first_neck, path.end());
    }
    const int spine_root = !r.spine.empty() ? r.spine.front() : (!r.neck.empty() ? r.neck.front() : -1);

    for (const Side side : {Side::Left, Side::Right}) {
        const bool left = side == Side::Left;
        auto sided = [&](int j) { return info[static_cast<std::size_t>(j)].side == side; };
        // Arm: the hand (or wrist) closest to the root, then walk up.
        const int hand = shallowest(s, [&](int j) {
            const NameInfo &n = info[static_cast<std::size_t>(j)];
            return sided(j) && has(n, {"hand", "wrist"}) && !has(n, ex_fingers) &&
                   (spine_root < 0 || is_ancestor(s, spine_root, j) || is_ancestor(s, hips, j));
        });
        if (hand >= 0) {
            const int fore = parent(hand), upper = parent(fore), clav = parent(upper);
            at(left ? Role::LeftHand : Role::RightHand) = hand;
            if (fore >= 0 && sided(fore)) at(left ? Role::LeftForearm : Role::RightForearm) = fore;
            if (upper >= 0 && sided(upper)) at(left ? Role::LeftUpperArm : Role::RightUpperArm) = upper;
            if (upper >= 0 && sided(upper) && clav >= 0 && sided(clav)) at(left ? Role::LeftClavicle : Role::RightClavicle) = clav;
        }
        // Leg: the ankle (or foot) closest to the root that is not inside the spine/arms.
        auto leg_candidate = [&](int j, std::initializer_list<std::string_view> words) {
            return sided(j) && has(info[static_cast<std::size_t>(j)], words) &&
                   !has(info[static_cast<std::size_t>(j)], {"end", "nub", "tip"}) && is_ancestor(s, hips, j) &&
                   (spine_root < 0 || !is_ancestor(s, spine_root, j));
        };
        int foot = shallowest(s, [&](int j) { return leg_candidate(j, {"ankle"}); });
        if (foot < 0) foot = shallowest(s, [&](int j) { return leg_candidate(j, {"foot"}); });
        if (foot >= 0) {
            at(left ? Role::LeftFoot : Role::RightFoot) = foot;
            const int calf = parent(foot), thigh = parent(calf);
            if (calf >= 0 && calf != hips && sided(calf)) {
                if (thigh >= 0 && thigh != hips && sided(thigh)) {
                    at(left ? Role::LeftCalf : Role::RightCalf) = calf;
                    at(left ? Role::LeftThigh : Role::RightThigh) = thigh;
                } else {
                    at(left ? Role::LeftThigh : Role::RightThigh) = calf; // two-bone leg
                }
            }
            const auto kids = s.children(foot);
            const auto toe = std::ranges::find_if(kids, [&](int c) { return sided(c) || has(info[static_cast<std::size_t>(c)], {"toe", "ball"}); });
            if (toe != kids.end()) at(left ? Role::LeftToe : Role::RightToe) = *toe;
        }
    }
    return r;
}

RetargetMapping auto_map(const Skeleton &source, const Skeleton &target) {
    const SkeletonRoles rs = detect_roles(source), rt = detect_roles(target);
    std::vector<std::pair<int, int>> pairs; // (target, source)
    for (std::size_t i = 0; i < static_cast<std::size_t>(Role::Count); ++i)
        if (rs.joint[i] >= 0 && rt.joint[i] >= 0) pairs.emplace_back(rt.joint[i], rs.joint[i]);
    proportional(rs.spine, rt.spine, pairs);
    proportional(rs.neck, rt.neck, pairs);
    std::ranges::sort(pairs); // target order (parents first)
    RetargetMapping m;
    m.source_skeleton = source.source;
    m.target_skeleton = target.source;
    std::set<int> used;
    for (auto [t, src] : pairs)
        if (used.insert(t).second)
            m.joints.push_back({target.joints[static_cast<std::size_t>(t)].name, source.joints[static_cast<std::size_t>(src)].name, {}});
    return m;
}

MappingDiagnostics check_mapping(const RetargetMapping &mapping, const Skeleton &source, const Skeleton &target) {
    MappingDiagnostics d;
    std::vector<int> src_of(target.size(), -1);
    std::map<int, std::vector<std::string>> targets_of_source;
    for (const JointMapping &m : mapping.joints) {
        const int t = target.find(m.target), s = source.find(m.source);
        if (t < 0) d.errors.push_back("target joint '" + m.target + "' does not exist");
        if (s < 0) d.errors.push_back("source joint '" + m.source + "' does not exist");
        if (t < 0 || s < 0) continue;
        if (src_of[static_cast<std::size_t>(t)] >= 0) {
            d.errors.push_back("target joint '" + m.target + "' is mapped more than once");
            continue;
        }
        const Quat &q = m.offset;
        if (!(std::fabs(std::sqrt(dot(q, q)) - 1.F) < 1.e-3F))
            d.errors.push_back("offset of '" + m.target + "' is not a unit quaternion");
        src_of[static_cast<std::size_t>(t)] = s;
        targets_of_source[s].push_back(m.target);
    }
    if (!targets_of_source.contains(0))
        d.errors.push_back("the source root '" + (source.size() ? source.joints[0].name : std::string("?")) +
                           "' is not mapped; it carries the root motion");
    for (const auto &[s, names] : targets_of_source)
        if (names.size() > 1) {
            std::string list;
            for (const auto &n : names) list += (list.empty() ? "" : ", ") + n;
            d.warnings.push_back("source joint '" + source.joints[static_cast<std::size_t>(s)].name +
                                 "' drives several targets (" + list + ")");
        }
    // Hierarchy compatibility.
    for (int t = 0; t < static_cast<int>(target.size()); ++t) {
        const int s = src_of[static_cast<std::size_t>(t)];
        if (s < 0) continue;
        int ta = target.joints[static_cast<std::size_t>(t)].parent;
        while (ta >= 0 && src_of[static_cast<std::size_t>(ta)] < 0) ta = target.joints[static_cast<std::size_t>(ta)].parent;
        if (ta < 0) continue;
        const int sa = src_of[static_cast<std::size_t>(ta)];
        if (sa != s && !is_ancestor(source, sa, s))
            d.errors.push_back("incompatible parents: target '" + target.joints[static_cast<std::size_t>(t)].name +
                               "' is below '" + target.joints[static_cast<std::size_t>(ta)].name + "', but source '" +
                               source.joints[static_cast<std::size_t>(s)].name + "' is not below '" +
                               source.joints[static_cast<std::size_t>(sa)].name + "'");
    }
    std::vector<std::string> unmapped;
    for (std::size_t t = 0; t < target.size(); ++t)
        if (src_of[t] < 0 && target.joints[t].deforming) unmapped.push_back(target.joints[t].name);
    if (!unmapped.empty()) {
        std::string list;
        for (std::size_t i = 0; i < unmapped.size() && i < 8; ++i) list += (i ? ", " : "") + unmapped[i];
        if (unmapped.size() > 8) list += ", ...";
        d.warnings.push_back(std::to_string(unmapped.size()) + " deforming target joint(s) unmapped, kept at rest: " + list);
    }
    return d;
}

std::expected<RetargetMapping, std::string> mapping_from_json(std::string_view text) {
    try {
        const auto j = nlohmann::json::parse(text);
        if (!j.is_object()) return std::unexpected("mapping JSON must be an object");
        if (j.value("version", 1) != 1) return std::unexpected("unsupported mapping version");
        RetargetMapping m;
        m.source_skeleton = j.value("source_skeleton", "");
        m.target_skeleton = j.value("target_skeleton", "");
        if (!j.contains("joints") || !j["joints"].is_array()) return std::unexpected("mapping JSON needs a \"joints\" array");
        for (const auto &e : j["joints"]) {
            if (!e.is_object() || !e.contains("target") || !e.contains("source") || !e["target"].is_string() || !e["source"].is_string())
                return std::unexpected("each mapping entry needs string \"target\" and \"source\"");
            JointMapping jm{e["target"].get<std::string>(), e["source"].get<std::string>(), {}};
            if (e.contains("offset_xyzw")) {
                const auto &o = e["offset_xyzw"];
                if (!o.is_array() || o.size() != 4) return std::unexpected("offset_xyzw must have 4 numbers");
                jm.offset = {o[0].get<float>(), o[1].get<float>(), o[2].get<float>(), o[3].get<float>()};
            }
            m.joints.push_back(std::move(jm));
        }
        return m;
    } catch (const nlohmann::json::exception &e) {
        return std::unexpected(std::string("invalid mapping JSON: ") + e.what());
    }
}

std::string mapping_to_json(const RetargetMapping &m) {
    nlohmann::ordered_json j;
    j["version"] = 1;
    j["source_skeleton"] = m.source_skeleton;
    j["target_skeleton"] = m.target_skeleton;
    j["joints"] = nlohmann::ordered_json::array();
    for (const JointMapping &e : m.joints) {
        nlohmann::ordered_json o{{"target", e.target}, {"source", e.source}};
        if (e.offset.x != 0.F || e.offset.y != 0.F || e.offset.z != 0.F || e.offset.w != 1.F)
            o["offset_xyzw"] = {e.offset.x, e.offset.y, e.offset.z, e.offset.w};
        j["joints"].push_back(std::move(o));
    }
    return j.dump(2) + "\n";
}

std::expected<RetargetMapping, std::string> load_mapping(const std::filesystem::path &path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return std::unexpected("cannot open " + path.string());
    std::stringstream ss;
    ss << in.rdbuf();
    return mapping_from_json(ss.str());
}

std::expected<ReferencePose, std::string> reference_pose_from_json(std::string_view text) {
    try {
        const auto j = nlohmann::json::parse(text);
        if (j.value("format", std::string{"kimodo-reference-pose"}) != "kimodo-reference-pose")
            return std::unexpected("not a kimodo reference pose");
        ReferencePose pose;
        pose.name = j.value("name", std::string{"T-pose"});
        if (!j.contains("joints") || !j["joints"].is_object()) return std::unexpected("reference pose: 'joints' object expected");
        for (const auto &[name, q] : j["joints"].items()) {
            if (!q.is_array() || q.size() != 4) return std::unexpected("reference pose: '" + name + "' must be [x,y,z,w]");
            Quat r{q[0].get<float>(), q[1].get<float>(), q[2].get<float>(), q[3].get<float>()};
            const float n = std::sqrt(r.x * r.x + r.y * r.y + r.z * r.z + r.w * r.w);
            if (!std::isfinite(n) || n < 1.e-6F) return std::unexpected("reference pose: '" + name + "' is not a rotation");
            pose.rotations.emplace(name, normalize(r));
        }
        return pose;
    } catch (const std::exception &e) {
        return std::unexpected(std::string("reference pose JSON: ") + e.what());
    }
}

std::expected<ReferencePose, std::string> load_reference_pose(const std::filesystem::path &path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return std::unexpected("cannot open " + path.string());
    std::stringstream ss;
    ss << in.rdbuf();
    return reference_pose_from_json(ss.str());
}

std::expected<void, std::string> save_mapping(const std::filesystem::path &path, const RetargetMapping &mapping) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out << mapping_to_json(mapping);
    if (!out) return std::unexpected("cannot write " + path.string());
    return {};
}

} // namespace kimodo::anim
