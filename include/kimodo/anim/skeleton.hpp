#pragma once
// Runtime skeleton shared by importers, the retargeter and the animation stack.
// It is independent of the import library and of the Kimodo checkpoint layout.

#include <kimodo/anim/types.hpp>

#include <cstddef>
#include <expected>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace kimodo::anim {

struct Joint {
    // Stable identifier inside this skeleton. Persisted data (mappings, masks) refers to joints
    // by name, never by index, because indices differ between skeletons.
    std::string name;
    int parent = -1;          // index into Skeleton::joints, always < this joint's index
    Transform rest_local{};   // rest pose, parent space (root: skeleton/world space)
    bool deforming = true;    // influences at least one skinned vertex (native rigs: all true)
    int source_node = -1;     // glTF node index, -1 for native skeletons
    int skin_joint = -1;      // index in the glTF skin's joint list, -1 for native skeletons
};

class Skeleton {
public:
    std::string source;       // "native:soma30", or the imported file path
    std::vector<Joint> joints;

    [[nodiscard]] std::size_t size() const noexcept { return joints.size(); }
    [[nodiscard]] int root() const noexcept { return joints.empty() ? -1 : 0; }
    [[nodiscard]] int find(std::string_view name) const noexcept;
    [[nodiscard]] std::vector<int> children(int joint) const;

    // Checks the invariants: non-empty, one root at index 0, parents precede children,
    // unique non-empty names, finite unit rotations.
    [[nodiscard]] std::expected<void, std::string> validate() const;

    // Rest pose in skeleton space, one Transform per joint.
    [[nodiscard]] std::vector<Transform> rest_global() const;
    // Distance from the joint to its first child at rest (0 for leaves).
    [[nodiscard]] float bone_length(int joint) const;
};

// Skeleton space transforms from per-joint local transforms (same order as skeleton.joints).
[[nodiscard]] std::vector<Transform> forward_kinematics(const Skeleton &skeleton,
                                                        std::span<const Transform> local);

// The rigs Kimodo checkpoints generate for. Keys: "smplx22", "soma30", "g1skel34".
// Rest rotations are identity; rest translations are the checkpoint's parent-local offsets.
[[nodiscard]] std::expected<Skeleton, std::string> native_skeleton(std::string_view key);
// The public generation API reports only the joint count; 22, 30 and 34 are unambiguous.
[[nodiscard]] std::expected<Skeleton, std::string> native_skeleton_for_joint_count(std::size_t joints);
[[nodiscard]] std::span<const std::string_view> native_skeleton_keys() noexcept;

} // namespace kimodo::anim
