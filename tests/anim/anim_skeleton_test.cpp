// Kimodo Extended step 1: math primitives, native skeletons, FK and glTF skeleton import.
// usage: kimodo-anim-skeleton-test RIGS_DIR   (RIGS_DIR = tests/data/rigs)
#include <kimodo/anim/gltf.hpp>
#include <kimodo/anim/skeleton.hpp>
#include <kimodo/anim/types.hpp>

#include <cgltf.h>

#include <cmath>
#include <filesystem>
#include <iostream>
#include <string>

using namespace kimodo::anim;

namespace {
int failures = 0;
#define CHECK(cond)                                                                                  \
    do {                                                                                             \
        if (!(cond)) {                                                                               \
            ++failures;                                                                              \
            std::cerr << __FILE__ << ':' << __LINE__ << ": CHECK failed: " #cond "\n";               \
        }                                                                                            \
    } while (0)

bool near(float a, float b, float eps = 1.e-5F) { return std::fabs(a - b) <= eps; }
bool near(Vec3 a, Vec3 b, float eps = 1.e-5F) { return near(a.x, b.x, eps) && near(a.y, b.y, eps) && near(a.z, b.z, eps); }
bool same_rotation(Quat a, Quat b, float eps = 1.e-4F) { return angle_between(a, b) <= eps; }
bool near(const Transform &a, const Transform &b, float eps = 1.e-5F) {
    return near(a.translation, b.translation, eps) && same_rotation(a.rotation, b.rotation, eps * 10.F) &&
           near(a.scale, b.scale, eps);
}
constexpr float pi = 3.14159265358979F;

void math_tests() {
    const Quat rz = Quat::from_axis_angle({0, 0, 1}, pi / 2);
    CHECK(near(rotate(rz, {1, 0, 0}), {0, 1, 0}));
    CHECK(same_rotation(rz * inverse(rz), Quat::identity()));
    // Composition order: (a * b) applies b first.
    const Quat ry = Quat::from_axis_angle({0, 1, 0}, pi / 2);
    CHECK(near(rotate(ry * rz, {1, 0, 0}), rotate(ry, rotate(rz, {1, 0, 0}))));

    // slerp endpoints, shortest arc and the near-180 degree case.
    const Quat a = Quat::identity();
    const Quat b = Quat::from_axis_angle({0, 1, 0}, pi - 1.e-3F);
    CHECK(same_rotation(slerp(a, b, 0.F), a));
    CHECK(same_rotation(slerp(a, b, 1.F), b));
    CHECK(near(angle_between(a, slerp(a, b, .5F)), (pi - 1.e-3F) / 2, 1.e-3F));
    const Quat neg_b{-b.x, -b.y, -b.z, -b.w};
    CHECK(same_rotation(slerp(a, neg_b, .5F), slerp(a, b, .5F)));
    CHECK(same_rotation(slerp(rz, rz, .3F), rz));

    // TRS <-> matrix round trip, including non-uniform and mirrored scale.
    const Transform t{{1, 2, 3}, normalize(Quat{.1F, .7F, -.2F, .6F}), {2, 3, .5F}};
    CHECK(near(decompose(to_matrix(t)), t, 1.e-4F));
    const Transform mirrored{{0, 0, 0}, Quat::from_axis_angle({1, 0, 0}, .4F), {-1, 1, 1}};
    const Transform back = decompose(to_matrix(mirrored));
    CHECK(near(back.apply({.3F, .2F, .1F}), mirrored.apply({.3F, .2F, .1F}), 1.e-5F));

    const Transform u{{1, -2, .5F}, normalize(Quat{.3F, -.1F, .4F, .8F}), {2, 2, 2}};
    CHECK(near(inverse(u) * u, Transform{}, 1.e-5F));
    CHECK(near((u * inverse(u)).translation, {0, 0, 0}));
}

void native_tests() {
    auto soma = native_skeleton("soma30");
    CHECK(soma.has_value());
    if (!soma) return;
    CHECK(soma->size() == 30);
    CHECK(soma->source == "native:soma30");
    CHECK(soma->joints[0].name == "Hips");
    CHECK(soma->validate().has_value());
    const int foot = soma->find("LeftFoot");
    CHECK(foot > 0);
    // Rest rotations are identity, so the global rest position is the sum of offsets.
    Vec3 sum{};
    for (int j = foot; j >= 0; j = soma->joints[static_cast<std::size_t>(j)].parent)
        sum = sum + soma->joints[static_cast<std::size_t>(j)].rest_local.translation;
    const auto rest = soma->rest_global();
    CHECK(near(rest[static_cast<std::size_t>(foot)].translation, sum));
    CHECK(soma->bone_length(soma->find("LeftHandMiddleEnd")) == 0.F);
    CHECK(soma->bone_length(soma->find("LeftShin")) > .3F);

    CHECK(native_skeleton_for_joint_count(22).value().source == "native:smplx22");
    CHECK(native_skeleton_for_joint_count(30).value().source == "native:soma30");
    CHECK(native_skeleton_for_joint_count(34).value().source == "native:g1skel34");
    CHECK(!native_skeleton_for_joint_count(31).has_value());
    CHECK(!native_skeleton("unknown").has_value());
    for (const auto key : native_skeleton_keys()) CHECK(native_skeleton(key).has_value());

    // FK: identity locals reproduce the rest pose; a root yaw rotates every joint about the root.
    std::vector<Transform> local(soma->size());
    for (std::size_t i = 0; i < local.size(); ++i) local[i] = soma->joints[i].rest_local;
    const auto fk_rest = forward_kinematics(*soma, local);
    for (std::size_t i = 0; i < local.size(); ++i) CHECK(near(fk_rest[i], rest[i]));
    const Quat yaw = Quat::from_axis_angle({0, 1, 0}, pi / 2);
    local[0].rotation = yaw;
    const auto fk_yaw = forward_kinematics(*soma, local);
    CHECK(near(fk_yaw[static_cast<std::size_t>(foot)].translation, rotate(yaw, sum)));

    // Validation diagnostics instead of crashes.
    Skeleton bad = *soma;
    bad.joints[5].name = bad.joints[4].name;
    CHECK(!bad.validate().has_value());
    bad = *soma;
    bad.joints[3].parent = 7;
    CHECK(!bad.validate().has_value());
    CHECK(!Skeleton{}.validate().has_value());
}

void gltf_tests(const std::filesystem::path &rigs) {
    const auto rig_path = rigs / "test_rig.glb";
    auto c = load_gltf_character(rig_path);
    if (!c) std::cerr << c.error() << '\n';
    CHECK(c.has_value());
    if (!c) return;
    const Skeleton &s = c->skeleton;
    CHECK(s.size() == 20);
    CHECK(s.joints[0].name == "Hips");
    CHECK(s.validate().has_value());
    CHECK(c->skinned_meshes == 1);
    CHECK(c->materials == 1);
    CHECK(c->skins == 1);
    CHECK(s.find("HeadTop_End") >= 0 && !s.joints[static_cast<std::size_t>(s.find("HeadTop_End"))].deforming);
    CHECK(s.joints[static_cast<std::size_t>(s.find("LeftForeArm"))].deforming);
    CHECK(s.joints[static_cast<std::size_t>(s.find("LeftForeArm"))].parent == s.find("LeftArm"));
    CHECK(s.joints[static_cast<std::size_t>(s.find("LeftArm"))].parent == s.find("Chest"));
    CHECK(s.children(s.find("Hips")).size() == 3);
    CHECK(near(s.bone_length(s.find("LeftForeArm")), .25F));

    // Ground truth independent of the importer: rest_global * inverseBindMatrix == identity.
    cgltf_options opts{};
    cgltf_data *data = nullptr;
    const std::string file = rig_path.string();
    CHECK(cgltf_parse_file(&opts, file.c_str(), &data) == cgltf_result_success);
    CHECK(cgltf_load_buffers(&opts, data, file.c_str()) == cgltf_result_success);
    const auto rest = s.rest_global();
    for (std::size_t i = 0; i < s.size(); ++i) {
        Mat4 ibm;
        cgltf_accessor_read_float(data->skins[0].inverse_bind_matrices,
                                  static_cast<cgltf_size>(s.joints[i].skin_joint), ibm.m, 16);
        CHECK(&data->nodes[s.joints[i].source_node] == data->skins[0].joints[s.joints[i].skin_joint]);
        // Joint origin, mapped through IBM, lands at the origin; a unit offset maps back to itself.
        const Transform bind = decompose(ibm);
        const Transform product = bind * rest[i];
        if (!near(product, Transform{}, 1.e-4F)) {
            ++failures;
            std::cerr << "rest/IBM mismatch at joint " << s.joints[i].name << '\n';
        }
    }
    cgltf_free(data);

    auto noskin = load_gltf_character(rigs / "test_noskin.glb");
    CHECK(!noskin.has_value() && noskin.error().find("no skin") != std::string::npos);
    auto missing = load_gltf_character(rigs / "does_not_exist.glb");
    CHECK(!missing.has_value() && missing.error().find("file not found") != std::string::npos);
    GltfImportOptions bad_skin;
    bad_skin.skin = 3;
    CHECK(!load_gltf_character(rig_path, bad_skin).has_value());

    // Several root joints (control-rig helpers): the deforming "Hips" subtree is the skeleton.
    auto helpers = load_gltf_character(rigs / "test_rig_helpers.glb");
    if (!helpers) std::cerr << helpers.error() << '\n';
    CHECK(helpers.has_value());
    if (helpers) {
        CHECK(helpers->skeleton.size() == 20 && helpers->skeleton.joints[0].name == "Hips");
        CHECK(helpers->ignored_roots == (std::vector<std::string>{"Controls", "RigBuilder"}));
        CHECK(helpers->ignored_joints == 3 && helpers->ignored_deforming_joints == 0);
        CHECK(helpers->warnings.size() == 1);
        for (std::size_t j = 0; j < helpers->skeleton.size(); ++j)
            CHECK(helpers->skeleton.joints[j].name == s.joints[j].name &&
                  near(helpers->skeleton.joints[j].rest_local, s.joints[j].rest_local, 1.e-6F));
        GltfImportOptions pick;
        pick.root_joint = "RigBuilder";
        auto forced = load_gltf_character(rigs / "test_rig_helpers.glb", pick);
        CHECK(forced && forced->skeleton.size() == 2 && forced->skeleton.joints[1].name == "COG");
        pick.root_joint = "Nope";
        CHECK(!load_gltf_character(rigs / "test_rig_helpers.glb", pick).has_value());
    }
}
} // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::cerr << "usage: kimodo-anim-skeleton-test RIGS_DIR\n";
        return 2;
    }
    math_tests();
    native_tests();
    gltf_tests(argv[1]);
    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all anim skeleton checks passed\n";
    return 0;
}
