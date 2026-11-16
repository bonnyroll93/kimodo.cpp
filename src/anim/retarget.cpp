#include <kimodo/anim/retarget.hpp>

#include <algorithm>
#include <cmath>
#include <numbers>
#include <optional>

namespace kimodo::anim {
namespace {

constexpr float deg = std::numbers::pi_v<float> / 180.F;

// Facing of a skeleton at rest: perpendicular to the hips' left-right axis, on the ground.
// Character's left is +X when facing +Z with +Y up (glTF / SMPL / SOMA convention).
std::optional<Vec3> rest_facing(const Skeleton &s, const std::vector<Transform> &rest, Vec3 up) {
    const SkeletonRoles roles = detect_roles(s);
    const int l = roles[Role::LeftThigh] >= 0 ? roles[Role::LeftThigh] : roles[Role::LeftUpperArm];
    const int r = roles[Role::RightThigh] >= 0 ? roles[Role::RightThigh] : roles[Role::RightUpperArm];
    if (l < 0 || r < 0) return std::nullopt;
    const Vec3 lateral = rest[static_cast<std::size_t>(l)].translation - rest[static_cast<std::size_t>(r)].translation;
    const Vec3 f = cross(lateral - up * dot(lateral, up), up);
    if (length(f) < 1.e-6F) return std::nullopt;
    return normalize(f);
}

// Height of joint j above the lowest joint of the rest pose, along up.
float height_above_lowest(const std::vector<Transform> &rest, int j, Vec3 up) {
    float lowest = dot(rest[static_cast<std::size_t>(j)].translation, up);
    for (const Transform &t : rest) lowest = std::min(lowest, dot(t.translation, up));
    return dot(rest[static_cast<std::size_t>(j)].translation, up) - lowest;
}

} // namespace

std::expected<RetargetResult, std::string> retarget(const AnimationClip &source_clip, const Skeleton &source,
                                                    const Skeleton &target, const RetargetMapping &mapping,
                                                    const RetargetOptions &options) {
    if (source_clip.joint_count != source.size())
        return std::unexpected("clip has " + std::to_string(source_clip.joint_count) + " joints, source skeleton has " +
                               std::to_string(source.size()));
    if (auto ok = source.validate(); !ok) return std::unexpected("source skeleton: " + ok.error());
    if (auto ok = target.validate(); !ok) return std::unexpected("target skeleton: " + ok.error());
    if (std::fabs(length(options.up) - 1.F) > 1.e-3F) return std::unexpected("up must be a unit vector");
    if (!std::isfinite(options.root_scale) || options.root_scale < 0.F) return std::unexpected("root_scale must be >= 0");

    RetargetResult result;
    result.diagnostics = check_mapping(mapping, source, target);
    if (!result.diagnostics.ok()) {
        std::string msg = "invalid mapping:";
        for (const auto &e : result.diagnostics.errors) msg += "\n  - " + e;
        return std::unexpected(msg);
    }
    const Vec3 up = options.up;
    const std::size_t nt = target.size();
    std::vector<int> src_of(nt, -1);
    std::vector<Quat> offset(nt);
    for (const JointMapping &m : mapping.joints) {
        const auto t = static_cast<std::size_t>(target.find(m.target));
        src_of[t] = source.find(m.source);
        offset[t] = normalize(m.offset);
        if (src_of[t] == 0) result.translation_joint = static_cast<int>(t);
    }

    const auto src_rest = source.rest_global();
    const auto tgt_rest = target.rest_global();

    // Facing compensation: C maps source world directions to target world directions.
    float yaw = options.yaw_offset_degrees * deg;
    if (options.auto_facing) {
        const auto fs = rest_facing(source, src_rest, up), ft = rest_facing(target, tgt_rest, up);
        if (fs && ft) yaw += std::atan2(dot(cross(*fs, *ft), up), dot(*fs, *ft));
        else result.diagnostics.warnings.push_back("facing not detected (hips/arms missing); assuming both face the same way");
    }
    const Quat C = Quat::from_axis_angle(up, yaw);
    const Quat Ci = inverse(C);
    result.facing_yaw_degrees = yaw / deg;

    // Root translation scale from hip heights.
    const auto tj = static_cast<std::size_t>(result.translation_joint);
    const bool native = source.source.starts_with("native:");
    const float hs = height_above_lowest(src_rest, 0, up);
    const float ht = height_above_lowest(tgt_rest, result.translation_joint, up);
    float scale = options.root_scale;
    if (scale == 0.F) {
        scale = hs > 1.e-4F && ht > 1.e-4F ? ht / hs : 1.F;
        if (!(hs > 1.e-4F && ht > 1.e-4F)) result.diagnostics.warnings.push_back("hip height undetectable; root scale 1");
    }
    result.root_scale = scale;
    // Source standing reference (see header): native rigs stand with the root at hip height.
    Vec3 src_ref = src_rest[0].translation;
    if (native) src_ref = src_ref - up * dot(src_ref, up) + up * hs;
    result.source_reference = src_ref;
    result.target_reference = tgt_rest[tj].translation;
    result.target_ground = dot(tgt_rest[tj].translation, up) - ht;

    // Optional A/T-pose alignment: rotate each mapped target rest bone onto its source direction.
    std::vector<Quat> align(nt);
    if (options.align_rest_directions) {
        for (std::size_t t = 0; t < nt; ++t) {
            const int s = src_of[t];
            if (s < 0) continue;
            int tc = -1, sc = -1;
            for (const int c : target.children(static_cast<int>(t)))
                if (src_of[static_cast<std::size_t>(c)] >= 0) { tc = c; sc = src_of[static_cast<std::size_t>(c)]; break; }
            if (tc < 0) continue; // leaf in the mapping: no bone direction to align
            const Vec3 dt = tgt_rest[static_cast<std::size_t>(tc)].translation - tgt_rest[t].translation;
            const Vec3 ds = rotate(C, src_rest[static_cast<std::size_t>(sc)].translation - src_rest[static_cast<std::size_t>(s)].translation);
            align[t] = from_to(dt, ds);
        }
    }

    // A reference pose (hand-edited T-pose) gives the target's global rotation at source rest
    // directly: ref_global[t] = align[t] * tgt_rest[t] is replaced by its FK.
    std::vector<Quat> ref_global(nt);
    if (options.reference_pose) {
        std::vector<Transform> locals(nt);
        for (std::size_t t = 0; t < nt; ++t) {
            locals[t] = target.joints[t].rest_local;
            if (const auto it = options.reference_pose->rotations.find(target.joints[t].name); it != options.reference_pose->rotations.end())
                locals[t].rotation = normalize(it->second);
        }
        const auto g = forward_kinematics(target, locals);
        for (std::size_t t = 0; t < nt; ++t) ref_global[t] = normalize(g[t].rotation);
    } else {
        for (std::size_t t = 0; t < nt; ++t) ref_global[t] = normalize(align[t] * normalize(tgt_rest[t].rotation));
    }

    // Per-joint constant: target global at source rest = A_t * R_t_rest.
    std::vector<Quat> src_rest_inv(source.size());
    for (std::size_t s = 0; s < source.size(); ++s) src_rest_inv[s] = inverse(normalize(src_rest[s].rotation));

    AnimationClip &out = result.clip;
    out.name = source_clip.name;
    out.fps = source_clip.fps;
    out.joint_count = nt;
    for (const Joint &j : target.joints) out.joint_names.push_back(j.name);
    out.locals.resize(source_clip.frames() * nt);
    std::vector<Transform> tgt_global(nt);
    for (std::size_t f = 0; f < source_clip.frames(); ++f) {
        const auto src_global = forward_kinematics(source, source_clip.frame(f));
        for (std::size_t t = 0; t < nt; ++t) {
            const Joint &joint = target.joints[t];
            Transform local = joint.rest_local;
            const int p = joint.parent;
            const Quat parent_rot = p >= 0 ? tgt_global[static_cast<std::size_t>(p)].rotation : Quat{};
            if (const int s = src_of[t]; s >= 0) {
                const Quat delta = normalize(src_global[static_cast<std::size_t>(s)].rotation) * src_rest_inv[static_cast<std::size_t>(s)];
                const Quat global = C * delta * Ci * ref_global[t] * offset[t];
                local.rotation = normalize(inverse(parent_rot) * global);
            }
            if (t == tj) {
                // Root translation: offset from the source reference, rotated into the target's
                // facing and scaled, applied around the target joint's rest position.
                const Vec3 d = src_global[0].translation - src_ref;
                const Vec3 world = tgt_rest[t].translation + rotate(C, d) * scale;
                const Transform parent_global = p >= 0 ? tgt_global[static_cast<std::size_t>(p)] : Transform{};
                local.translation = inverse(parent_global).apply(world);
            }
            tgt_global[t] = p >= 0 ? tgt_global[static_cast<std::size_t>(p)] * local : local;
            out.at(f, t) = local;
        }
    }
    return result;
}

std::expected<RetargetResult, std::string> retarget_back(const AnimationClip &target_clip, const Skeleton &target,
                                                        const Skeleton &source, const RetargetMapping &forward_mapping,
                                                        const RetargetOptions &forward_options) {
    // The target's T-pose: the forward retarget of one source rest frame.
    Skeleton tposed = target;
    AnimationClip rest;
    rest.fps = target_clip.fps;
    rest.joint_count = source.size();
    for (const Joint &j : source.joints) rest.locals.push_back(j.rest_local);
    auto t = retarget(rest, source, target, forward_mapping, forward_options);
    if (!t) return std::unexpected("target T-pose: " + t.error());
    for (std::size_t j = 0; j < tposed.size(); ++j) tposed.joints[j].rest_local.rotation = t->clip.at(0, j).rotation;
    RetargetMapping reverse;
    reverse.source_skeleton = forward_mapping.target_skeleton;
    reverse.target_skeleton = forward_mapping.source_skeleton;
    for (const JointMapping &m : forward_mapping.joints) reverse.joints.push_back({.target = m.source, .source = m.target});
    // The exact inverse of the forward travel scale and facing (estimating them again from
    // the hip heights / facings of the swapped skeletons does not give the inverse).
    RetargetOptions back;
    back.up = forward_options.up;
    back.root_scale = t->root_scale > 0.F ? 1.F / t->root_scale : 0.F;
    back.auto_facing = false;
    back.yaw_offset_degrees = -t->facing_yaw_degrees;
    auto result = retarget(target_clip, tposed, source, reverse, back);
    if (!result) return result;
    // Height: target = target_reference + (source - source_reference) * root_scale in both
    // directions; the target standing at the forward target reference must give the forward
    // source reference.
    const float mapped = result->target_reference.y + (t->target_reference.y - result->source_reference.y) * result->root_scale;
    const float shift = t->source_reference.y - mapped;
    AnimationClip &out = result->clip;
    const int root = result->translation_joint >= 0 ? result->translation_joint : 0;
    for (std::size_t f = 0; f < out.frames(); ++f) out.at(f, static_cast<std::size_t>(root)).translation.y += shift;
    return result;
}

} // namespace kimodo::anim
