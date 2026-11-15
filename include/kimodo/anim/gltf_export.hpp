#pragma once
// Writes a character GLB with an animation clip added: everything in the source file
// (meshes, materials, textures, skins and inverse bind matrices, other nodes, extensions)
// is copied unchanged; only an animation (and its data) is appended. External buffers,
// data-URI buffers and external/data-URI images are embedded, so the result is one
// self-contained .glb.

#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/skeleton.hpp>

#include <cstddef>
#include <expected>
#include <filesystem>
#include <string>
#include <vector>

namespace kimodo::anim {

struct GltfExportOptions {
    std::string animation_name = "Kimodo";
    bool replace_animations = false; // drop the file's existing animations instead of keeping them
    bool export_scale = false;       // also write scale channels (off: scale stays the node's rest scale)
};

struct GltfExportReport {
    std::size_t channels = 0;
    std::size_t frames = 0;
    float duration = 0.F;
    std::size_t animations = 0;      // animations in the written file
    std::size_t embedded_files = 0;  // external buffers/images pulled into the GLB
    std::vector<std::string> warnings;
};

// `skeleton` must come from load_gltf_character() of `source` (joint source_node indices
// refer to its nodes). The clip is matched to joints by name (or skeleton order if
// unnamed); local transforms are in the skeleton's convention (root in scene space) and
// are converted to node-local values where a joint's glTF parent is not its skeleton
// parent (e.g. a root below an "Armature" node). Quaternion keys are made sign-continuous
// so LINEAR (slerp) interpolation takes the short way.
[[nodiscard]] std::expected<GltfExportReport, std::string> export_gltf_animation(
    const std::filesystem::path &source, const Skeleton &skeleton, const AnimationClip &clip,
    const std::filesystem::path &output, const GltfExportOptions &options = {});

} // namespace kimodo::anim
