// Kimodo Extended: control rig (IK arms / legs with poles) on a baked walk.
// usage: kimodo-anim-control-rig-test BASELINE_MOTION_DIR
#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/control_rig.hpp>
#include <kimodo/anim/ik.hpp>

#include <cmath>
#include <iostream>

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

Curve flat(float v) {
    Curve c;
    c.keys.push_back(Keyframe{.frame = 0.F, .value = v});
    return c;
}

void tests(const Skeleton &soma, const AnimationClip &walk) {
    const int la = soma.find("LeftArm"), lf = soma.find("LeftForeArm"), lh = soma.find("LeftHand");
    CHECK(la >= 0 && lf >= 0 && lh >= 0);
    const auto g0 = forward_kinematics(soma, walk.frame(0));
    const Vec3 hand0 = g0[static_cast<std::size_t>(lh)].translation;

    // IK on, the hand control keyed (constant) where the hand is at frame 0: planted all along.
    IkLimb arm{.name = "left_arm", .chain = {"LeftArm", "LeftForeArm", "LeftHand"}, .ik = true};
    arm.target[PosX] = flat(hand0.x);
    arm.target[PosY] = flat(hand0.y);
    arm.target[PosZ] = flat(hand0.z);
    ControlRig rig{.fps = 30.F, .hips = "Hips", .limbs = {arm}};
    AnimationClip planted = walk;
    auto r = apply_control_rig(planted, soma, rig);
    CHECK(r && r->solved.size() == 1 && r->warnings.empty());
    for (const std::size_t f : {std::size_t{0}, std::size_t{10}, std::size_t{20}}) {
        const auto g = forward_kinematics(soma, planted.frame(f));
        CHECK(length(g[static_cast<std::size_t>(lh)].translation - hand0) < 2.e-3F || (r && r->unreachable_frames > 0));
        // Joints outside the chain are untouched.
        CHECK(angle_between(planted.at(f, 0).rotation, walk.at(f, 0).rotation) < 1.e-6F);
    }
    // Frame 0: the hand reaches exactly (within reach there).
    CHECK(length(forward_kinematics(soma, planted.frame(0))[static_cast<std::size_t>(lh)].translation - hand0) < 1.e-3F);

    // IK off: nothing changes.
    rig.limbs[0].ik = false;
    AnimationClip off = walk;
    CHECK(apply_control_rig(off, soma, rig).has_value());
    CHECK(angle_between(off.at(10, static_cast<std::size_t>(la)).rotation, walk.at(10, static_cast<std::size_t>(la)).rotation) < 1.e-6F);
    rig.limbs[0].ik = true;

    // Pole: the elbow points towards the pole (in the plane through shoulder and hand).
    const Vec3 shoulder = g0[static_cast<std::size_t>(la)].translation;
    const Vec3 pole = shoulder + Vec3{0.F, -.3F, -.5F};
    rig.limbs[0].pole = {flat(pole.x), flat(pole.y), flat(pole.z)};
    AnimationClip poled = walk;
    CHECK(apply_control_rig(poled, soma, rig).has_value());
    const auto gp = forward_kinematics(soma, poled.frame(0));
    const Vec3 A = gp[static_cast<std::size_t>(la)].translation, B = gp[static_cast<std::size_t>(lf)].translation,
               C = gp[static_cast<std::size_t>(lh)].translation;
    const Vec3 u = normalize(C - A);
    const Vec3 bp = (B - A) - u * dot(B - A, u), pp = (pole - A) - u * dot(pole - A, u);
    CHECK(length(C - hand0) < 1.e-3F);
    CHECK(dot(normalize(bp), normalize(pp)) > .99F);

    // Keyed hand rotation (root space): the hand takes it.
    rig.limbs[0].target[RotX] = flat(30.F);
    rig.limbs[0].target[RotY] = flat(0.F);
    rig.limbs[0].target[RotZ] = flat(0.F);
    AnimationClip turned = walk;
    CHECK(apply_control_rig(turned, soma, rig).has_value());
    const auto gt = forward_kinematics(soma, turned.frame(5));
    CHECK(angle_between(gt[static_cast<std::size_t>(lh)].rotation, euler_xyz_degrees(30.F, 0.F, 0.F)) < 1.e-3F);

    // Hips space: a control keyed at the hips' offset of frame 0 follows the hips.
    IkLimb follow = arm;
    follow.follow = ControlSpace::Hips;
    const Transform hips0 = g0[0];
    const Vec3 rel = rotate(inverse(normalize(hips0.rotation)), hand0 - hips0.translation);
    follow.target[PosX] = flat(rel.x);
    follow.target[PosY] = flat(rel.y);
    follow.target[PosZ] = flat(rel.z);
    ControlRig hrig{.fps = 30.F, .hips = "Hips", .limbs = {follow}};
    AnimationClip moved = walk;
    CHECK(apply_control_rig(moved, soma, hrig).has_value());
    const auto g40 = forward_kinematics(soma, moved.frame(40)), w40 = forward_kinematics(soma, walk.frame(40));
    const Vec3 want = w40[0].apply(rel);
    const Vec3 got = g40[static_cast<std::size_t>(lh)].translation;
    CHECK(length(got - want) < 5.e-3F || length(got - w40[static_cast<std::size_t>(la)].translation) > .5F);
    CHECK(length(got - hand0) > .5F); // travelled with the walk

    // JSON.
    auto parsed = control_rig_from_json(R"({"version":1,"fps":30,"hips":"Hips","limbs":[{"name":"left_arm",
        "chain":["LeftArm","LeftForeArm","LeftHand"],"ik":true,"follow":"hips","target":{"tx":[{"f":0,"v":0.1}]},
        "pole":{"tz":[{"f":0,"v":-0.5}]}}]})");
    CHECK(parsed && parsed->limbs.size() == 1 && parsed->limbs[0].follow == ControlSpace::Hips &&
          parsed->limbs[0].target[PosX].keys.size() == 1 && parsed->limbs[0].pole[2].keys.size() == 1);
    CHECK(!control_rig_from_json(R"({"limbs":[{"chain":["A","B"]}]})").has_value());
    CHECK(!control_rig_from_json(R"({"limbs":[{"chain":["A","B","C"],"follow":"moon"}]})").has_value());
    // Broken chain: a warning, nothing applied.
    auto broken = control_rig_from_json(R"({"limbs":[{"name":"x","chain":["LeftArm","LeftHand","LeftForeArm"],"ik":true,"target":{"tx":[{"f":0,"v":0}]}}]})");
    AnimationClip same = walk;
    auto br = apply_control_rig(same, soma, *broken);
    CHECK(br && br->solved.empty() && br->warnings.size() == 1);
}
} // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::cerr << "usage: kimodo-anim-control-rig-test BASELINE_MOTION_DIR\n";
        return 2;
    }
    auto motion = read_motion_dir(argv[1]);
    if (!motion) {
        std::cerr << motion.error() << '\n';
        return 1;
    }
    const Skeleton soma = native_skeleton("soma30").value();
    tests(soma, clip_from_motion(soma, *motion).value());
    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all control rig checks passed\n";
    return 0;
}
