#pragma once
// glTF 2.0 / GLB character import. The importer extracts the skeleton of one skin; mesh,
// material and skin data stay in the file and are rendered by the viewer directly.

#include <kimodo/anim/skeleton.hpp>

#include <cstddef>
#include <expected>
#include <filesystem>
#include <string>
#include <vector>

namespace kimodo::anim {

struct GltfImportOptions {
    int skin = 0; // which skin defines the skeleton
};

struct GltfCharacter {
    // Joints are reordered so parents precede children; Joint::source_node and
    // Joint::skin_joint keep the link back to the file. Transforms of non-joint
    // ancestors of the root (e.g. an "Armature" node) are baked into the root's
    // rest_local, so the skeleton lives in glTF scene space (Y-up, metres).
    Skeleton skeleton;
    std::size_t meshes = 0;
    std::size_t skinned_meshes = 0; // mesh nodes bound to the selected skin
    std::size_t materials = 0;
    std::size_t skins = 0;
    std::vector<std::string> animations;
};

[[nodiscard]] std::expected<GltfCharacter, std::string> load_gltf_character(
    const std::filesystem::path &path, const GltfImportOptions &options = {});

} // namespace kimodo::anim
