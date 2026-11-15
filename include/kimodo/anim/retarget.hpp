#pragma once
// Retargeting a clip from one humanoid skeleton (normally a native Kimodo rig) onto another
// (normally an imported GLB character).
//
// Method: for every mapped joint the source's change of *global* rotation from its rest
// pose is applied to the target's global rest rotation (optionally after aligning rest
// bone directions). The target keeps its own bone lengths; unmapped target joints keep
// their rest local rotation. The joint mapped to the source root also receives the root
// translation, scaled by the ratio of hip heights. The two skeletons may face different
// directions: the facing is detected from the hips and compensated by a yaw about up.

#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/skeleton.hpp>

#include <array>
#include <expected>
#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace kimodo::anim {

// Anatomical roles used by automatic mapping. Spine and neck are chains, matched
// proportionally between skeletons with different joint counts.
enum class Role {
    Hips, Head,
    LeftClavicle, LeftUpperArm, LeftForearm, LeftHand,
    RightClavicle, RightUpperArm, RightForearm, RightHand,
    LeftThigh, LeftCalf, LeftFoot, LeftToe,
    RightThigh, RightCalf, RightFoot, RightToe,
    Count
};
[[nodiscard]] std::string_view role_name(Role role) noexcept;

struct SkeletonRoles {
    std::array<int, static_cast<std::size_t>(Role::Count)> joint{}; // -1 when absent
    std::vector<int> spine;                                          // hips (exclusive) .. neck (exclusive)
    std::vector<int> neck;                                           // neck joints above the spine, below the head
    [[nodiscard]] int operator[](Role r) const noexcept { return joint[static_cast<std::size_t>(r)]; }
};

// Detects roles from joint names (left/right tokens, Mixamo/UE/SMPL/SOMA vocabularies,
// namespace prefixes such as "mixamorig:") combined with the hierarchy: limbs are found
// as chains, so "LeftLeg" is a thigh in SOMA (child of Hips) and a calf in Mixamo.
[[nodiscard]] SkeletonRoles detect_roles(const Skeleton &skeleton);

struct JointMapping {
    std::string target;          // target joint name
    std::string source;          // source joint name
    Quat offset{};               // extra rotation in the target joint's local frame (post-multiplied)
};

struct RetargetMapping {
    std::string source_skeleton; // informative (Skeleton::source of the source)
    std::string target_skeleton; // informative
    std::vector<JointMapping> joints;
};

struct MappingDiagnostics {
    std::vector<std::string> errors;   // retargeting refuses to run
    std::vector<std::string> warnings; // runs, but the result may be incomplete
    [[nodiscard]] bool ok() const noexcept { return errors.empty(); }
};

// Unknown joints, a target mapped twice, an unmapped source root, and hierarchies that do
// not match (a mapped target joint whose nearest mapped ancestor is driven by a source
// joint that is not an ancestor of its own source) are errors. Unmapped deforming target
// joints, unused important source joints and sources driving several targets are warnings.
[[nodiscard]] MappingDiagnostics check_mapping(const RetargetMapping &mapping, const Skeleton &source,
                                               const Skeleton &target);

// Role-based automatic mapping (a starting point; users correct it and save it).
[[nodiscard]] RetargetMapping auto_map(const Skeleton &source, const Skeleton &target);

// JSON: {"version":1,"source_skeleton":"...","target_skeleton":"...",
//        "joints":[{"target":"Hips","source":"Hips","offset_xyzw":[0,0,0,1]}, ...]}
[[nodiscard]] std::expected<RetargetMapping, std::string> mapping_from_json(std::string_view json);
[[nodiscard]] std::string mapping_to_json(const RetargetMapping &mapping);
[[nodiscard]] std::expected<RetargetMapping, std::string> load_mapping(const std::filesystem::path &path);
[[nodiscard]] std::expected<void, std::string> save_mapping(const std::filesystem::path &path,
                                                            const RetargetMapping &mapping);

// The target's reference pose: the pose of the character that corresponds to the source's
// rest pose (a T-pose for the native skeletons), as local rotations by joint name in the
// target skeleton's joint space; joints not listed use their rest rotation. Retargeting
// with it replaces the automatic rest alignment, so a hand-edited T-pose fixes how the
// motion lands on the character.
// JSON: {"format":"kimodo-reference-pose","version":1,"name":"...","joints":{"Hips":[x,y,z,w],...}}
struct ReferencePose {
    std::string name;
    std::map<std::string, Quat, std::less<>> rotations;
};
[[nodiscard]] std::expected<ReferencePose, std::string> reference_pose_from_json(std::string_view json);
[[nodiscard]] std::expected<ReferencePose, std::string> load_reference_pose(const std::filesystem::path &path);

enum class UnmappedPolicy {
    KeepRest, // unmapped target joints keep their rest local rotation (the only MVP policy)
};

struct RetargetOptions {
    Vec3 up{0.F, 1.F, 0.F};
    bool auto_facing = true;      // compensate the facing difference detected from the hips
    float yaw_offset_degrees = 0.F; // extra yaw about up, added to the detected one
    float root_scale = 0.F;       // translation scale; 0 = target hip height / source hip height
    bool align_rest_directions = false; // rotate target rest bones onto source rest directions (A/T pose)
    std::optional<ReferencePose> reference_pose; // overrides align_rest_directions
    UnmappedPolicy unmapped = UnmappedPolicy::KeepRest;
};

struct RetargetResult {
    AnimationClip clip;            // target skeleton, target joint order
    int translation_joint = -1;    // target joint that receives the root translation
    float root_scale = 1.F;
    float facing_yaw_degrees = 0.F;
    // How a source-space point maps to target space (for overlays such as the root trail):
    // target = target_reference + yaw(facing) * (source - source_reference) * root_scale.
    Vec3 source_reference{};
    Vec3 target_reference{};
    float target_ground = 0.F; // lowest rest joint of the target, along up
    MappingDiagnostics diagnostics;
};

// Source "standing" reference: native skeletons ("native:*") are root-centred at rest and
// their motions stand on y = 0, so the root's rest height is taken as the hip height;
// other skeletons use their rest pose as is. A source frame equal to that reference
// therefore yields the target's rest pose.
[[nodiscard]] std::expected<RetargetResult, std::string> retarget(const AnimationClip &source_clip,
                                                                  const Skeleton &source, const Skeleton &target,
                                                                  const RetargetMapping &mapping,
                                                                  const RetargetOptions &options = {});

} // namespace kimodo::anim
