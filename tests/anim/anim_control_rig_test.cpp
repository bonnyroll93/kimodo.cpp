// Kimodo Extended: control rig (IK arms / legs with poles) on a baked walk.
// usage: kimodo-anim-control-rig-test BASELINE_MOTION_DIR
#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/control_rig.hpp>
#include <kimodo/anim/ik.hpp>
#include <kimodo/anim/layers.hpp>

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

    // Keyed IK/FK blend: FK at frame 0, IK from frame 20 (overrides weight, even weight 0).
    auto blended = control_rig_from_json(R"({"limbs":[{"name":"b","chain":["A","B","C"],
        "blend":[{"f":0,"v":0,"i":"linear"},{"f":20,"v":1}]}]})");
    CHECK(blended && blended->limbs[0].blend.keys.size() == 2);
    ControlRig brig{.fps = 30.F, .hips = "Hips", .limbs = {arm}};
    brig.limbs[0].weight = 0.F;
    brig.limbs[0].blend = blended->limbs[0].blend;
    const Vec3 hand20 = forward_kinematics(soma, walk.frame(20))[static_cast<std::size_t>(lh)].translation;
    brig.limbs[0].target[PosX] = flat(hand20.x + .1F);
    brig.limbs[0].target[PosY] = flat(hand20.y);
    brig.limbs[0].target[PosZ] = flat(hand20.z);
    AnimationClip mixed = walk;
    auto mr = apply_control_rig(mixed, soma, brig);
    CHECK(mr && mr->solved.size() == 1);
    CHECK(angle_between(mixed.at(0, static_cast<std::size_t>(la)).rotation, walk.at(0, static_cast<std::size_t>(la)).rotation) < 1.e-6F);
    CHECK(length(forward_kinematics(soma, mixed.frame(20))[static_cast<std::size_t>(lh)].translation - Vec3{hand20.x + .1F, hand20.y, hand20.z}) < 2.e-3F ||
          mr->unreachable_frames > 0);
    CHECK(angle_between(mixed.at(10, static_cast<std::size_t>(la)).rotation, walk.at(10, static_cast<std::size_t>(la)).rotation) > 1.e-5F);
    CHECK(!control_rig_from_json(R"({"limbs":[{"chain":["A","B","C"],"blend":{"f":0}}]})").has_value());

    // Body controls: hips lowered 10 cm, root moved 1 m along x and turned 90° about y.
    {
        const int hips = soma.find("Hips");
        CHECK(hips >= 0);
        const auto hj = static_cast<std::size_t>(hips);
        ControlRig body{.fps = 30.F, .hips = "Hips"};
        body.hips_control[PosY] = flat(-.1F);
        AnimationClip low = walk;
        auto lr = apply_control_rig(low, soma, body);
        CHECK(lr && lr->solved.size() == 1 && lr->solved[0] == "hips");
        for (const std::size_t f : {std::size_t{0}, std::size_t{30}}) {
            const auto gl = forward_kinematics(soma, low.frame(f)), gw = forward_kinematics(soma, walk.frame(f));
            CHECK(std::abs(gl[hj].translation.y - (gw[hj].translation.y - .1F)) < 1.e-4F);
            CHECK(length(gl[hj].translation - gw[hj].translation) < .1001F);
        }
        // Lowered hips with the left leg planted by IK in root space: the foot stays put.
        const int ll = soma.find("LeftLeg"), ls = soma.find("LeftShin"), lfoot = soma.find("LeftFoot");
        if (ll >= 0 && ls >= 0 && lfoot >= 0) {
            const Vec3 foot0 = forward_kinematics(soma, walk.frame(0))[static_cast<std::size_t>(lfoot)].translation;
            IkLimb leg{.name = "left_leg", .chain = {"LeftLeg", "LeftShin", "LeftFoot"}, .ik = true};
            leg.target[PosX] = flat(foot0.x);
            leg.target[PosY] = flat(foot0.y);
            leg.target[PosZ] = flat(foot0.z);
            ControlRig planted_leg = body;
            planted_leg.limbs = {leg};
            AnimationClip crouch = walk;
            CHECK(apply_control_rig(crouch, soma, planted_leg).has_value());
            CHECK(length(forward_kinematics(soma, crouch.frame(0))[static_cast<std::size_t>(lfoot)].translation - foot0) < 2.e-3F);
        }
        ControlRig moved_rig{.fps = 30.F, .hips = "Hips"};
        moved_rig.root_control[PosX] = flat(1.F);
        moved_rig.root_control[RotY] = flat(90.F);
        AnimationClip turned_all = walk;
        auto rr = apply_control_rig(turned_all, soma, moved_rig);
        CHECK(rr && rr->solved.size() == 1 && rr->solved[0] == "root");
        const auto g1 = forward_kinematics(soma, turned_all.frame(10)), w1 = forward_kinematics(soma, walk.frame(10));
        // The hips move by exactly the offset (they sit over the pivot), the hand turns about them.
        CHECK(std::abs(g1[hj].translation.x - (w1[hj].translation.x + 1.F)) < 1.e-4F);
        CHECK(std::abs(g1[hj].translation.z - w1[hj].translation.z) < 1.e-4F);
        const Vec3 rel_w = w1[static_cast<std::size_t>(lh)].translation - w1[hj].translation;
        const Vec3 rel_g = g1[static_cast<std::size_t>(lh)].translation - g1[hj].translation;
        CHECK(length(rel_g - rotate(euler_xyz_degrees(0.F, 90.F, 0.F), rel_w)) < 1.e-3F);
        // Follow spaces with the root control moved 1 m: Root carries the hand, World does not.
        {
            IkLimb wl = arm; // target keyed at hand0
            wl.follow = ControlSpace::World;
            IkLimb rl = arm;
            rl.follow = ControlSpace::Root;
            ControlRig wrig{.fps = 30.F, .hips = "Hips", .limbs = {wl}};
            wrig.root_control[PosX] = flat(.1F);
            ControlRig rrig = wrig;
            rrig.limbs = {rl};
            AnimationClip cw = walk, cr = walk;
            auto a = apply_control_rig(cw, soma, wrig), b = apply_control_rig(cr, soma, rrig);
            CHECK(a && b);
            const Vec3 hw = forward_kinematics(soma, cw.frame(0))[static_cast<std::size_t>(lh)].translation;
            const Vec3 hr = forward_kinematics(soma, cr.frame(0))[static_cast<std::size_t>(lh)].translation;
            CHECK(length(hw - hand0) < 2.e-3F);
            CHECK(length(hr - (hand0 + Vec3{.1F, 0.F, 0.F})) < 2.e-3F);
            CHECK(control_rig_from_json(R"({"limbs":[{"chain":["A","B","C"],"follow":"world"}]})").has_value());
        }
        auto pj = control_rig_from_json(R"({"hips":"Hips","root_control":{"tx":[{"f":0,"v":1}]},"hips_control":{"ty":[{"f":0,"v":-0.1}]}})");
        CHECK(pj && pj->root_control[PosX].keys.size() == 1 && pj->hips_control[PosY].keys.size() == 1);
    }

    // Anim layers on the controls.
    {
        // An additive layer lifts a hand that follows the animation (base unkeyed) by 5 cm.
        IkLimb free_arm{.name = "left_arm", .chain = {"LeftArm", "LeftForeArm", "LeftHand"}, .ik = true};
        ControlRigLayer up{.name = "up"};
        up.limbs["left_arm"].target[PosY] = flat(.05F);
        ControlRig lr{.fps = 30.F, .hips = "Hips", .limbs = {free_arm}, .layers = {up}};
        AnimationClip lifted = walk;
        auto rr = apply_control_rig(lifted, soma, lr);
        CHECK(rr && rr->stride == kControlLimbStride + kControlBodyStride && rr->controls.size() == rr->stride * walk.frames());
        const Vec3 h5 = forward_kinematics(soma, walk.frame(5))[static_cast<std::size_t>(lh)].translation;
        const Vec3 l5 = forward_kinematics(soma, lifted.frame(5))[static_cast<std::size_t>(lh)].translation;
        CHECK(length(l5 - (h5 + Vec3{0.F, .05F, 0.F})) < 2.e-3F || (rr && rr->unreachable_frames > 0));
        // The output: composed position = animation + 5 cm, base position = the animation.
        if (rr) {
            const float *o = rr->controls.data() + 5 * rr->stride;
            CHECK(std::abs(o[1] - (h5.y + .05F)) < 1.e-4F && std::abs(o[12] - h5.y) < 1.e-4F);
            CHECK(std::abs(o[10] - 1.F) < 1.e-6F); // blend
        }
        // Override layer at weight 0.5 between a keyed base (hand0) and the layer value.
        IkLimb keyed_arm = free_arm;
        keyed_arm.target[PosX] = flat(hand0.x);
        keyed_arm.target[PosY] = flat(hand0.y);
        keyed_arm.target[PosZ] = flat(hand0.z);
        ControlRigLayer over{.name = "over", .additive = false, .weight = .5F};
        over.limbs["left_arm"].target[PosY] = flat(hand0.y + .1F);
        ControlRig orig{.fps = 30.F, .hips = "Hips", .limbs = {keyed_arm}, .layers = {over}};
        AnimationClip half = walk;
        auto hr = apply_control_rig(half, soma, orig);
        CHECK(hr && std::abs(hr->controls[1] - (hand0.y + .05F)) < 1.e-4F && std::abs(hr->controls[0] - hand0.x) < 1.e-5F);
        // Keyed layer weight: 0 at frame 0, 1 from frame 10 (layer time).
        ControlRigLayer anim_w = up;
        anim_w.weight_curve.keys = {Keyframe{.frame = 0.F, .value = 0.F, .interpolation = KeyInterpolation::Linear},
                                    Keyframe{.frame = 10.F, .value = 1.F, .interpolation = KeyInterpolation::Linear}};
        ControlRig wr{.fps = 30.F, .hips = "Hips", .limbs = {free_arm}, .layers = {anim_w}};
        AnimationClip ramp = walk;
        auto wres = apply_control_rig(ramp, soma, wr);
        CHECK(wres.has_value());
        if (wres) {
            const Vec3 a0 = forward_kinematics(soma, walk.frame(0))[static_cast<std::size_t>(lh)].translation;
            const Vec3 a5 = forward_kinematics(soma, walk.frame(5))[static_cast<std::size_t>(lh)].translation;
            CHECK(std::abs(wres->controls[1] - a0.y) < 1.e-4F);                          // weight 0
            CHECK(std::abs(wres->controls[5 * wres->stride + 1] - (a5.y + .025F)) < 1.e-3F); // weight 0.5
        }
        // Layers JSON, and a body offset on a layer.
        auto pj = control_rig_from_json(R"({"hips":"Hips","layers":[{"name":"L","mode":"override","weight":0.5,
            "weight_keys":[{"f":0,"v":1}],"start":1,"speed":2,"limbs":{"left_arm":{"target":{"ty":[{"f":0,"v":1}]},"blend":[{"f":0,"v":0}]}},
            "hips_control":{"ty":[{"f":0,"v":-0.1}]}}]})");
        CHECK(pj && pj->layers.size() == 1 && !pj->layers[0].additive && pj->layers[0].weight_curve.keys.size() == 1 &&
              pj->layers[0].start == 1.F && pj->layers[0].limbs.at("left_arm").target[PosY].keys.size() == 1 &&
              pj->layers[0].limbs.at("left_arm").blend.keys.size() == 1 && pj->layers[0].hips_control[PosY].keys.size() == 1);
        CHECK(!control_rig_from_json(R"({"layers":[{"mode":"multiply"}]})").has_value());
        ControlRigLayer low{.name = "low"};
        low.hips_control[PosY] = flat(-.1F);
        ControlRig body_layer{.fps = 30.F, .hips = "Hips", .layers = {low}};
        AnimationClip dropped = walk;
        auto dr = apply_control_rig(dropped, soma, body_layer);
        CHECK(dr && dr->solved.size() == 1 && dr->solved[0] == "hips");
        const int hj = soma.find("Hips");
        if (hj >= 0)
            CHECK(std::abs(forward_kinematics(soma, dropped.frame(3))[static_cast<std::size_t>(hj)].translation.y -
                           (forward_kinematics(soma, walk.frame(3))[static_cast<std::size_t>(hj)].translation.y - .1F)) < 1.e-4F);
    }

    // Animated anim layer weight (joint layers): samples per layer frame.
    {
        AnimationLayer l;
        l.weight = .3F;
        CHECK(std::abs(layer_weight(l, 1.F) - .3F) < 1.e-6F);
        l.weight_samples = {0.F, 1.F};
        l.weight_fps = 10.F;
        l.timing.start = 1.F;
        CHECK(std::abs(layer_weight(l, 1.F) - 0.F) < 1.e-6F);
        CHECK(std::abs(layer_weight(l, 1.05F) - .5F) < 1.e-4F);
        CHECK(std::abs(layer_weight(l, 3.F) - 1.F) < 1.e-6F);
        auto kt = keyframes_from_json(R"({"version":1,"weight":[{"f":0,"v":0},{"f":5,"v":1}],"tracks":{}})");
        CHECK(kt && kt->weight.keys.size() == 2);
    }

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
