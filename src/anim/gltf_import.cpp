#include <kimodo/anim/gltf.hpp>

#include "cgltf_impl.hpp"

#include <cmath>
#include <memory>
#include <unordered_map>

namespace kimodo::anim {
namespace {

struct cgltf_deleter {
    void operator()(cgltf_data *d) const noexcept { cgltf_free(d); }
};
using cgltf_ptr = std::unique_ptr<cgltf_data, cgltf_deleter>;

const char *result_text(cgltf_result r) {
    switch (r) {
    case cgltf_result_success: return "success";
    case cgltf_result_data_too_short: return "data too short";
    case cgltf_result_unknown_format: return "unknown format";
    case cgltf_result_invalid_json: return "invalid JSON";
    case cgltf_result_invalid_gltf: return "invalid glTF";
    case cgltf_result_invalid_options: return "invalid options";
    case cgltf_result_file_not_found: return "file not found";
    case cgltf_result_io_error: return "I/O error";
    case cgltf_result_out_of_memory: return "out of memory";
    case cgltf_result_legacy_gltf: return "legacy glTF 1.0";
    default: return "unknown error";
    }
}

Mat4 multiply(const Mat4 &a, const Mat4 &b) {
    Mat4 r;
    for (int c = 0; c < 4; ++c)
        for (int row = 0; row < 4; ++row) {
            float s = 0.F;
            for (int k = 0; k < 4; ++k) s += a.m[k * 4 + row] * b.m[c * 4 + k];
            r.m[c * 4 + row] = s;
        }
    return r;
}

Mat4 node_local_matrix(const cgltf_node *n) {
    Mat4 m;
    cgltf_node_transform_local(n, m.m);
    return m;
}

// Exact TRS when the node stores TRS; decomposed matrix otherwise.
Transform node_local_transform(const cgltf_node *n) {
    if (n->has_matrix) return decompose(node_local_matrix(n));
    Transform t;
    if (n->has_translation) t.translation = {n->translation[0], n->translation[1], n->translation[2]};
    if (n->has_rotation) t.rotation = normalize(Quat{n->rotation[0], n->rotation[1], n->rotation[2], n->rotation[3]});
    if (n->has_scale) t.scale = {n->scale[0], n->scale[1], n->scale[2]};
    return t;
}

bool uniform_scale(const Transform &t) {
    return std::fabs(t.scale.x - t.scale.y) < 1.e-6F && std::fabs(t.scale.x - t.scale.z) < 1.e-6F;
}

// Composes node transforms from `n` up to (excluding) `stop`. TRS composition is exact when
// every scale is uniform; otherwise fall back to matrices (possible shear is dropped).
Transform compose_up_to(const cgltf_node *n, const cgltf_node *stop) {
    Transform t = node_local_transform(n);
    bool exact = uniform_scale(t);
    for (const cgltf_node *a = n->parent; a != nullptr && a != stop; a = a->parent) {
        const Transform at = node_local_transform(a);
        exact = exact && uniform_scale(at);
        t = at * t;
    }
    if (exact) return t;
    Mat4 m = node_local_matrix(n);
    for (const cgltf_node *a = n->parent; a != nullptr && a != stop; a = a->parent) m = multiply(node_local_matrix(a), m);
    return decompose(m);
}

std::string node_name(const cgltf_data *data, const cgltf_node *n) {
    if (n->name != nullptr && n->name[0] != '\0') return n->name;
    return "node_" + std::to_string(n - data->nodes);
}

} // namespace

std::expected<GltfCharacter, std::string> load_gltf_character(const std::filesystem::path &path,
                                                              const GltfImportOptions &options) {
    const std::string file = path.string();
    cgltf_options opts{};
    cgltf_data *raw = nullptr;
    if (cgltf_result r = cgltf_parse_file(&opts, file.c_str(), &raw); r != cgltf_result_success)
        return std::unexpected("cannot parse '" + file + "': " + result_text(r));
    cgltf_ptr data(raw);
    if (cgltf_result r = cgltf_load_buffers(&opts, data.get(), file.c_str()); r != cgltf_result_success)
        return std::unexpected("cannot load buffers of '" + file + "': " + result_text(r));
    if (cgltf_result r = cgltf_validate(data.get()); r != cgltf_result_success)
        return std::unexpected("'" + file + "' failed glTF validation: " + result_text(r));

    if (data->skins_count == 0)
        return std::unexpected("'" + file + "' has no skin; Kimodo Extended needs a rigged (skinned) character");
    if (options.skin < 0 || static_cast<std::size_t>(options.skin) >= data->skins_count)
        return std::unexpected("skin " + std::to_string(options.skin) + " out of range (file has " +
                               std::to_string(data->skins_count) + ")");
    const cgltf_skin *skin = &data->skins[options.skin];
    if (skin->joints_count == 0) return std::unexpected("skin has no joints");

    std::unordered_map<const cgltf_node *, int> skin_index; // node -> index in skin->joints
    for (std::size_t i = 0; i < skin->joints_count; ++i) skin_index.emplace(skin->joints[i], static_cast<int>(i));

    // Nearest ancestor that is a joint of this skin.
    auto joint_parent = [&](const cgltf_node *n) -> const cgltf_node * {
        for (const cgltf_node *p = n->parent; p != nullptr; p = p->parent)
            if (skin_index.contains(p)) return p;
        return nullptr;
    };

    std::vector<const cgltf_node *> roots;
    std::unordered_map<const cgltf_node *, std::vector<const cgltf_node *>> kids;
    for (std::size_t i = 0; i < skin->joints_count; ++i) {
        const cgltf_node *n = skin->joints[i];
        if (const cgltf_node *p = joint_parent(n)) kids[p].push_back(n);
        else roots.push_back(n);
    }
    if (roots.size() != 1) {
        std::string names;
        for (const cgltf_node *r : roots) names += (names.empty() ? "" : ", ") + node_name(data.get(), r);
        return std::unexpected("skin has " + std::to_string(roots.size()) +
                               " root joints (" + names + "); exactly one is required");
    }

    GltfCharacter out;
    Skeleton &s = out.skeleton;
    s.source = file;
    std::unordered_map<const cgltf_node *, int> order; // node -> skeleton index
    // Depth-first, children in skin order: parents always precede children.
    std::vector<std::pair<const cgltf_node *, int>> stack{{roots.front(), -1}};
    while (!stack.empty()) {
        auto [n, parent] = stack.back();
        stack.pop_back();
        Joint j;
        j.name = node_name(data.get(), n);
        j.parent = parent;
        j.source_node = static_cast<int>(n - data->nodes);
        j.skin_joint = skin_index.at(n);
        j.deforming = false;
        // Root: bake every non-joint ancestor (Armature, scene roots) into it.
        // Other joints: compose any non-joint nodes between the joint and its parent joint.
        const cgltf_node *stop =
            parent < 0 ? nullptr : data->nodes + s.joints[static_cast<std::size_t>(parent)].source_node;
        j.rest_local = compose_up_to(n, stop);
        const int index = static_cast<int>(s.joints.size());
        order.emplace(n, index);
        s.joints.push_back(std::move(j));
        if (auto it = kids.find(n); it != kids.end())
            for (auto c = it->second.rbegin(); c != it->second.rend(); ++c) stack.emplace_back(*c, index);
    }

    // Deforming flags and stats from the meshes bound to this skin.
    out.meshes = data->meshes_count;
    out.materials = data->materials_count;
    out.skins = data->skins_count;
    for (std::size_t a = 0; a < data->animations_count; ++a)
        out.animations.emplace_back(data->animations[a].name != nullptr ? data->animations[a].name
                                                                        : "animation_" + std::to_string(a));
    std::vector<bool> deforming(skin->joints_count, false);
    for (std::size_t ni = 0; ni < data->nodes_count; ++ni) {
        const cgltf_node &node = data->nodes[ni];
        if (node.mesh == nullptr || node.skin != skin) continue;
        ++out.skinned_meshes;
        for (std::size_t pi = 0; pi < node.mesh->primitives_count; ++pi) {
            const cgltf_primitive &prim = node.mesh->primitives[pi];
            for (std::size_t ai = 0; ai < prim.attributes_count; ++ai) {
                const cgltf_attribute &joints_attr = prim.attributes[ai];
                if (joints_attr.type != cgltf_attribute_type_joints) continue;
                const cgltf_accessor *weights = nullptr;
                for (std::size_t wi = 0; wi < prim.attributes_count; ++wi)
                    if (prim.attributes[wi].type == cgltf_attribute_type_weights &&
                        prim.attributes[wi].index == joints_attr.index)
                        weights = prim.attributes[wi].data;
                const cgltf_accessor *js = joints_attr.data;
                for (cgltf_size v = 0; v < js->count; ++v) {
                    cgltf_uint ids[4] = {0, 0, 0, 0};
                    float w[4] = {1.F, 1.F, 1.F, 1.F};
                    cgltf_accessor_read_uint(js, v, ids, 4);
                    if (weights != nullptr) cgltf_accessor_read_float(weights, v, w, 4);
                    for (int k = 0; k < 4; ++k)
                        if (w[k] > 0.F && ids[k] < deforming.size()) deforming[ids[k]] = true;
                }
            }
        }
    }
    for (Joint &j : s.joints) j.deforming = deforming[static_cast<std::size_t>(j.skin_joint)];

    if (auto ok = s.validate(); !ok) return std::unexpected("'" + file + "': " + ok.error());
    return out;
}

} // namespace kimodo::anim
