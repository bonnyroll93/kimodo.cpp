#include <kimodo/anim/skeleton.hpp>

#include "../skeleton.hpp"

#include <array>
#include <cmath>
#include <unordered_set>

namespace kimodo::anim {
namespace {
constexpr std::array<std::string_view, 3> native_keys{"smplx22", "soma30", "g1skel34"};

bool finite(Vec3 v) { return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z); }
} // namespace

int Skeleton::find(std::string_view name) const noexcept {
    for (std::size_t i = 0; i < joints.size(); ++i)
        if (joints[i].name == name) return static_cast<int>(i);
    return -1;
}

std::vector<int> Skeleton::children(int joint) const {
    std::vector<int> out;
    for (std::size_t i = 0; i < joints.size(); ++i)
        if (joints[i].parent == joint) out.push_back(static_cast<int>(i));
    return out;
}

std::expected<void, std::string> Skeleton::validate() const {
    if (joints.empty()) return std::unexpected("skeleton has no joints");
    if (joints[0].parent != -1) return std::unexpected("joint 0 must be the root");
    std::unordered_set<std::string_view> names;
    for (std::size_t i = 0; i < joints.size(); ++i) {
        const Joint &j = joints[i];
        if (j.name.empty()) return std::unexpected("joint " + std::to_string(i) + " has no name");
        if (!names.insert(j.name).second) return std::unexpected("duplicate joint name '" + j.name + "'");
        if (i > 0 && (j.parent < 0 || j.parent >= static_cast<int>(i)))
            return std::unexpected("joint '" + j.name + "' must have a parent that precedes it (found " +
                                   std::to_string(j.parent) + "); skeletons need exactly one root");
        const Quat &q = j.rest_local.rotation;
        const float n = std::sqrt(dot(q, q));
        if (!finite(j.rest_local.translation) || !finite(j.rest_local.scale) || !std::isfinite(n) ||
            std::fabs(n - 1.F) > 1.e-3F)
            return std::unexpected("joint '" + j.name + "' has a non-finite or non-unit rest transform");
    }
    return {};
}

std::vector<Transform> forward_kinematics(const Skeleton &skeleton, std::span<const Transform> local) {
    std::vector<Transform> global(skeleton.size());
    for (std::size_t i = 0; i < skeleton.size() && i < local.size(); ++i) {
        const int p = skeleton.joints[i].parent;
        global[i] = p < 0 ? local[i] : global[static_cast<std::size_t>(p)] * local[i];
    }
    return global;
}

std::vector<Transform> Skeleton::rest_global() const {
    std::vector<Transform> local(joints.size());
    for (std::size_t i = 0; i < joints.size(); ++i) local[i] = joints[i].rest_local;
    return forward_kinematics(*this, local);
}

float Skeleton::bone_length(int joint) const {
    if (joint < 0 || joint >= static_cast<int>(joints.size())) return 0.F;
    const auto kids = children(joint);
    if (kids.empty()) return 0.F;
    const auto g = rest_global();
    return length(g[static_cast<std::size_t>(kids.front())].translation - g[static_cast<std::size_t>(joint)].translation);
}

std::expected<Skeleton, std::string> native_skeleton(std::string_view key) {
    const detail::skeleton_spec *spec = detail::find_skeleton(key);
    if (spec == nullptr) return std::unexpected("unknown native skeleton '" + std::string(key) + "'");
    Skeleton s;
    s.source = "native:" + std::string(spec->key);
    s.joints.resize(spec->joints());
    for (std::size_t i = 0; i < spec->joints(); ++i) {
        Joint &j = s.joints[i];
        j.name = std::string(spec->names[i]);
        j.parent = spec->parents[i];
        j.rest_local.translation = {spec->offsets[i][0], spec->offsets[i][1], spec->offsets[i][2]};
    }
    if (auto ok = s.validate(); !ok) return std::unexpected(ok.error());
    return s;
}

std::expected<Skeleton, std::string> native_skeleton_for_joint_count(std::size_t joints) {
    for (const auto key : native_keys)
        if (detail::find_skeleton(key)->joints() == joints) return native_skeleton(key);
    return std::unexpected("no native skeleton has " + std::to_string(joints) + " joints");
}

std::span<const std::string_view> native_skeleton_keys() noexcept { return native_keys; }

} // namespace kimodo::anim
