// Kimodo Extended step 5: GLB export round trip.
// usage: kimodo-anim-export-test BASELINE_MOTION_DIR RIGS_DIR
#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/gltf.hpp>
#include <kimodo/anim/gltf_export.hpp>
#include <kimodo/anim/layers.hpp>
#include <kimodo/anim/retarget.hpp>

#include <cgltf.h>

#include <cmath>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using namespace kimodo::anim;
namespace fs = std::filesystem;

namespace {
int failures = 0;
#define CHECK(cond)                                                                                  \
    do {                                                                                             \
        if (!(cond)) {                                                                               \
            ++failures;                                                                              \
            std::cerr << __FILE__ << ':' << __LINE__ << ": CHECK failed: " #cond "\n";               \
        }                                                                                            \
    } while (0)

struct Gltf {
    cgltf_data *data = nullptr;
    explicit Gltf(const fs::path &p) {
        cgltf_options o{};
        const std::string s = p.string();
        if (cgltf_parse_file(&o, s.c_str(), &data) != cgltf_result_success || cgltf_load_buffers(&o, data, s.c_str()) != cgltf_result_success) {
            cgltf_free(data);
            data = nullptr;
        }
    }
    ~Gltf() { cgltf_free(data); }
    Gltf(const Gltf &) = delete;
    Gltf &operator=(const Gltf &) = delete;
};

const cgltf_animation *find_animation(const cgltf_data *d, std::string_view name) {
    for (cgltf_size i = 0; i < d->animations_count; ++i)
        if (d->animations[i].name && name == d->animations[i].name) return &d->animations[i];
    return nullptr;
}

// Poses the file's nodes at key `frame` of `anim` and returns the world matrix of a node.
void apply_keys(cgltf_data *d, const cgltf_animation *anim, cgltf_size frame) {
    for (cgltf_size c = 0; c < anim->channels_count; ++c) {
        const cgltf_animation_channel &ch = anim->channels[c];
        cgltf_node *n = ch.target_node;
        float v[4] = {0, 0, 0, 1};
        if (ch.target_path == cgltf_animation_path_type_rotation) {
            cgltf_accessor_read_float(ch.sampler->output, frame, v, 4);
            std::memcpy(n->rotation, v, sizeof(float) * 4);
            n->has_rotation = 1;
        } else if (ch.target_path == cgltf_animation_path_type_translation) {
            cgltf_accessor_read_float(ch.sampler->output, frame, v, 3);
            std::memcpy(n->translation, v, sizeof(float) * 3);
            n->has_translation = 1;
        }
        n->has_matrix = 0;
    }
}

Transform world(const cgltf_node *n) {
    Mat4 m;
    cgltf_node_transform_world(n, m.m);
    return decompose(m);
}

std::vector<float> ibm(const cgltf_data *d) {
    const cgltf_accessor *a = d->skins[0].inverse_bind_matrices;
    std::vector<float> out(a->count * 16);
    for (cgltf_size i = 0; i < a->count; ++i) cgltf_accessor_read_float(a, i, out.data() + i * 16, 16);
    return out;
}

// Compares the exported animation with the clip's FK at the first, middle and last frame.
float max_pose_error(const fs::path &exported, const Skeleton &skeleton, const AnimationClip &clip, std::string_view name) {
    Gltf g(exported);
    CHECK(g.data != nullptr);
    if (!g.data) return 1e9F;
    const cgltf_animation *anim = find_animation(g.data, name);
    CHECK(anim != nullptr);
    if (!anim) return 1e9F;
    CHECK(anim->samplers[0].input->count == clip.frames());
    float worst = 0.F;
    for (const std::size_t f : {std::size_t{0}, clip.frames() / 2, clip.frames() - 1}) {
        apply_keys(g.data, anim, f);
        const auto fk = forward_kinematics(skeleton, clip.frame(f));
        for (std::size_t j = 0; j < skeleton.size(); ++j) {
            const Transform w = world(&g.data->nodes[skeleton.joints[j].source_node]);
            worst = std::max(worst, length(w.translation - fk[j].translation));
            worst = std::max(worst, angle_between(w.rotation, fk[j].rotation) * .1F); // 0.1 m per radian
        }
    }
    return worst;
}

void round_trip(const fs::path &rig_path, const Skeleton &soma, const AnimationClip &walk, const fs::path &tmp,
                bool align = false) {
    auto character = load_gltf_character(rig_path);
    CHECK(character.has_value());
    if (!character) return;
    RetargetOptions opt;
    opt.align_rest_directions = align;
    auto r = retarget(walk, soma, character->skeleton, auto_map(soma, character->skeleton), opt);
    CHECK(r.has_value());
    if (!r) return;
    const fs::path out = tmp / (rig_path.stem().string() + "_walk.glb");
    auto report = export_gltf_animation(rig_path, character->skeleton, r->clip, out, {.animation_name = "Walk"});
    CHECK(report.has_value());
    if (!report) { std::cerr << report.error() << '\n'; return; }
    CHECK(report->frames == walk.frames() && report->channels == 2 * character->skeleton.size());

    // Mesh, skin and skeleton preserved.
    auto again = load_gltf_character(out);
    CHECK(again.has_value());
    if (!again) return;
    CHECK(again->meshes == character->meshes && again->skins == character->skins && again->materials == character->materials);
    CHECK(again->skinned_meshes == character->skinned_meshes);
    CHECK(again->animations.size() == character->animations.size() + 1 && again->animations.back() == "Walk");
    CHECK(again->skeleton.size() == character->skeleton.size());
    for (std::size_t j = 0; j < again->skeleton.size(); ++j) {
        const Joint &a = again->skeleton.joints[j], &b = character->skeleton.joints[j];
        CHECK(a.name == b.name && a.parent == b.parent && a.deforming == b.deforming);
        CHECK(length(a.rest_local.translation - b.rest_local.translation) < 1.e-6F);
        CHECK(angle_between(a.rest_local.rotation, b.rest_local.rotation) < 1.e-5F);
    }
    Gltf src(rig_path), dst(out);
    CHECK(src.data && dst.data);
    if (src.data && dst.data) {
        CHECK(ibm(src.data) == ibm(dst.data));
        CHECK(src.data->meshes[0].primitives[0].attributes_count == dst.data->meshes[0].primitives[0].attributes_count);
        // Quaternion keys are sign-continuous (slerp takes the short way).
        const cgltf_animation *anim = find_animation(dst.data, "Walk");
        for (cgltf_size c = 0; anim && c < anim->channels_count; ++c) {
            if (anim->channels[c].target_path != cgltf_animation_path_type_rotation) continue;
            const cgltf_accessor *o = anim->channels[c].sampler->output;
            float prev[4], cur[4];
            cgltf_accessor_read_float(o, 0, prev, 4);
            for (cgltf_size k = 1; k < o->count; ++k) {
                cgltf_accessor_read_float(o, k, cur, 4);
                CHECK(prev[0] * cur[0] + prev[1] * cur[1] + prev[2] * cur[2] + prev[3] * cur[3] >= 0.F);
                std::memcpy(prev, cur, sizeof prev);
            }
        }
    }
    // The animation played from the file matches the preview (FK of the clip) at start, middle, end.
    const float err = max_pose_error(out, character->skeleton, r->clip, "Walk");
    CHECK(err < 1.e-4F);
    if (err >= 1.e-4F) std::cerr << "  " << rig_path.filename() << ": max pose error " << err << '\n';
}
} // namespace

int main(int argc, char **argv) {
    if (argc != 3) {
        std::cerr << "usage: kimodo-anim-export-test BASELINE_MOTION_DIR RIGS_DIR\n";
        return 2;
    }
    const fs::path rigs = argv[2];
    const fs::path tmp = fs::temp_directory_path() / "kimodo_export_test";
    fs::create_directories(tmp);
    auto motion = read_motion_dir(argv[1]);
    if (!motion) {
        std::cerr << motion.error() << '\n';
        return 1;
    }
    const Skeleton soma = native_skeleton("soma30").value();
    const AnimationClip walk = clip_from_motion(soma, *motion).value();

    round_trip(rigs / "test_rig.glb", soma, walk, tmp);                       // root under a rotated Armature
    round_trip(rigs / "test_rig_mixamo_apose.glb", soma, walk, tmp, true);   // mixamorig: names, A-pose aligned
    round_trip(rigs / "test_rig_embedded.gltf", soma, walk, tmp);            // JSON glTF with a data-URI buffer

    // Embedding report, keep vs replace existing animations, layered clips.
    auto character = load_gltf_character(rigs / "test_rig_embedded.gltf").value();
    auto clip = retarget(walk, soma, character.skeleton, auto_map(soma, character.skeleton)).value().clip;
    auto rep = export_gltf_animation(rigs / "test_rig_embedded.gltf", character.skeleton, clip, tmp / "embedded.glb");
    CHECK(rep.has_value() && rep->embedded_files == 1);
    auto twice = export_gltf_animation(tmp / "embedded.glb", load_gltf_character(tmp / "embedded.glb")->skeleton, clip,
                                       tmp / "twice.glb", {.animation_name = "Second"});
    CHECK(twice.has_value() && twice->animations == 2);
    auto replaced = export_gltf_animation(tmp / "twice.glb", load_gltf_character(tmp / "twice.glb")->skeleton, clip,
                                          tmp / "replaced.glb", {.animation_name = "Only", .replace_animations = true});
    CHECK(replaced.has_value() && replaced->animations == 1);
    CHECK(load_gltf_character(tmp / "replaced.glb")->animations == std::vector<std::string>{"Only"});

    AnimationStack stack(character.skeleton);
    AnimationLayer upper{.name = "upper", .clip = clip, .mode = BlendMode::Additive, .weight = .5F};
    upper.mask = upper_body_mask(character.skeleton);
    CHECK(stack.add_layer({.name = "base", .clip = clip}).has_value() && stack.add_layer(upper).has_value());
    const AnimationClip baked = stack.bake();
    CHECK(export_gltf_animation(rigs / "test_rig.glb", load_gltf_character(rigs / "test_rig.glb")->skeleton, baked,
                                tmp / "layered.glb", {.animation_name = "Layered"}).has_value());
    CHECK(max_pose_error(tmp / "layered.glb", load_gltf_character(rigs / "test_rig.glb")->skeleton, baked, "Layered") < 1.e-4F);

    // Errors are reported, not crashes.
    CHECK(!export_gltf_animation(rigs / "missing.glb", character.skeleton, clip, tmp / "x.glb").has_value());
    CHECK(!export_gltf_animation(rigs / "test_rig.glb", character.skeleton, AnimationClip{}, tmp / "x.glb").has_value());

    fs::remove_all(tmp);
    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all anim export checks passed\n";
    return 0;
}
