// Kimodo Extended F5: two-bone IK, foot contact detection and foot locking.
// usage: kimodo-anim-ik-test BASELINE_MOTION_DIR RIGS_DIR
#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/gltf.hpp>
#include <kimodo/anim/ik.hpp>
#include <kimodo/anim/retarget.hpp>
#include <kimodo/anim/root_motion.hpp>

#include <cmath>
#include <filesystem>
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

bool near(Vec3 a, Vec3 b, float eps = 1.e-4F) { return length(a - b) <= eps; }
bool finite(Vec3 v) { return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z); }
std::size_t idx(const Skeleton &s, std::string_view n) { return static_cast<std::size_t>(s.find(n)); }
bool identical(const Transform &a, const Transform &b) {
    return a.rotation.x == b.rotation.x && a.rotation.y == b.rotation.y && a.rotation.z == b.rotation.z &&
           a.rotation.w == b.rotation.w && a.translation.x == b.translation.x && a.translation.y == b.translation.y &&
           a.translation.z == b.translation.z;
}

void two_bone_tests(const Skeleton &soma) {
    const int thigh = soma.find("LeftLeg"), calf = soma.find("LeftShin"), foot = soma.find("LeftFoot");
    std::vector<Transform> pose;
    for (const Joint &j : soma.joints) pose.push_back(j.rest_local);
    // Bend the knee a little so the bend plane is defined (knee forward = +Z).
    pose[static_cast<std::size_t>(calf)].rotation = Quat::from_axis_angle({1, 0, 0}, .3F);
    const auto before = forward_kinematics(soma, pose);
    const Vec3 hip = before[static_cast<std::size_t>(thigh)].translation;
    const float la = length(before[static_cast<std::size_t>(calf)].translation - hip);
    const float lb = length(before[static_cast<std::size_t>(foot)].translation - before[static_cast<std::size_t>(calf)].translation);
    const Quat foot_rot = before[static_cast<std::size_t>(foot)].rotation;

    // Reachable target: up and forward (a crouch / step).
    const Vec3 target = before[static_cast<std::size_t>(foot)].translation + Vec3{.05F, .25F, .15F};
    CHECK(solve_two_bone_ik(soma, pose, thigh, calf, foot, target));
    const auto after = forward_kinematics(soma, pose);
    CHECK(near(after[static_cast<std::size_t>(foot)].translation, target));
    CHECK(near(after[static_cast<std::size_t>(thigh)].translation, hip, 1.e-6F)); // hip untouched
    CHECK(std::fabs(length(after[static_cast<std::size_t>(calf)].translation - hip) - la) < 1.e-4F); // bone lengths kept
    CHECK(std::fabs(length(after[static_cast<std::size_t>(foot)].translation - after[static_cast<std::size_t>(calf)].translation) - lb) < 1.e-4F);
    CHECK(angle_between(after[static_cast<std::size_t>(foot)].rotation, foot_rot) < 1.e-4F); // foot keeps its orientation
    // The knee still points forward (bend plane preserved).
    const Vec3 knee = after[static_cast<std::size_t>(calf)].translation;
    const Vec3 mid = (hip + after[static_cast<std::size_t>(foot)].translation) * .5F;
    CHECK((knee - mid).z > 0.F);
    // Other joints untouched.
    CHECK(near(after[idx(soma, "RightFoot")].translation, before[idx(soma, "RightFoot")].translation, 0.F));

    // Unreachable: the foot ends on the line towards the target at full reach, no NaN.
    std::vector<Transform> far = pose;
    const Vec3 away = hip + Vec3{0, -5.F, 1.F};
    CHECK(!solve_two_bone_ik(soma, far, thigh, calf, foot, away));
    const auto gf = forward_kinematics(soma, far);
    const Vec3 dir = normalize(gf[static_cast<std::size_t>(foot)].translation - hip);
    CHECK(near(dir, normalize(away - hip), 1.e-3F));
    CHECK(length(gf[static_cast<std::size_t>(foot)].translation - hip) <= la + lb + 1.e-4F);
    // Degenerate: target on the hip, and a perfectly straight leg.
    std::vector<Transform> close = pose;
    solve_two_bone_ik(soma, close, thigh, calf, foot, hip);
    for (const auto &t : forward_kinematics(soma, close)) CHECK(finite(t.translation));
    std::vector<Transform> straight;
    for (const Joint &j : soma.joints) straight.push_back(j.rest_local);
    straight[static_cast<std::size_t>(calf)].rotation = {};
    CHECK(solve_two_bone_ik(soma, straight, thigh, calf, foot, hip + Vec3{0, -.6F, .1F}));
    CHECK(near(forward_kinematics(soma, straight)[static_cast<std::size_t>(foot)].translation, hip + Vec3{0, -.6F, .1F}));
    // Not a chain.
    CHECK(!solve_two_bone_ik(soma, pose, thigh, foot, calf, target));
}

void walk_tests(const Skeleton &s, const AnimationClip &walk, const char *label) {
    auto contacts = detect_foot_contacts(walk, s);
    CHECK(contacts.has_value());
    if (!contacts) { std::cerr << contacts.error() << '\n'; return; }
    std::size_t per_foot[2] = {0, 0}, frames_in_contact = 0;
    for (const FootContact &c : *contacts) {
        ++per_foot[c.foot];
        frames_in_contact += c.end - c.start + 1;
        CHECK(c.end >= c.start + 2); // min_contact_frames
    }
    CHECK(per_foot[0] >= 1 && per_foot[1] >= 1);
    const float fraction = static_cast<float>(frames_in_contact) / static_cast<float>(2 * walk.frames());
    CHECK(fraction > .2F && fraction < .9F);

    auto r = foot_lock(walk, s);
    CHECK(r.has_value());
    if (!r) { std::cerr << r.error() << '\n'; return; }
    std::cerr << "  " << label << ": " << r->contacts.size() << " contacts, slide " << r->slide_before * 1000.F << " mm -> "
              << r->slide_after * 1000.F << " mm, unreachable " << r->unreachable_frames << ", hip drop "
              << r->max_hip_drop * 1000.F << " mm\n";
    CHECK(r->slide_after < 1.e-3F);                  // pinned feet do not slide
    CHECK(r->slide_after <= r->slide_before);
    CHECK(r->clip.frames() == walk.frames());
    CHECK(r->unreachable_frames == 0);               // adjust_hips makes every pinned foot reachable
    CHECK(r->max_hip_drop <= .1F * r->leg_length + 1.e-6F);
    // Only the legs and the root height change: root rotation and horizontal position, spine,
    // arms and head are bit-identical.
    const auto legs = find_legs(s).value();
    std::vector<bool> leg(s.size(), false);
    for (const LegChain &l : legs)
        for (int j : {l.thigh, l.calf, l.foot}) leg[static_cast<std::size_t>(j)] = true;
    bool untouched = true;
    for (std::size_t f = 0; f < walk.frames(); ++f)
        for (std::size_t j = 0; j < s.size(); ++j)
            if (!leg[j] && j != 0) untouched = untouched && identical(r->clip.at(f, j), walk.at(f, j));
    for (std::size_t f = 0; f < walk.frames(); ++f) {
        const Transform &a = r->clip.at(f, 0), &b = walk.at(f, 0);
        untouched = untouched && a.rotation.w == b.rotation.w && a.translation.x == b.translation.x &&
                    a.translation.z == b.translation.z && a.translation.y <= b.translation.y;
    }
    CHECK(untouched);
    // Far from any contact (outside contacts and blends) legs are unchanged too.
    std::vector<bool> touched(walk.frames(), false);
    for (const FootContact &c : r->contacts)
        for (long f = static_cast<long>(c.start) - 4; f <= static_cast<long>(c.end) + 4; ++f)
            if (f >= 0 && f < static_cast<long>(walk.frames())) touched[static_cast<std::size_t>(f)] = true;
    for (std::size_t f = 0; f < walk.frames(); ++f)
        if (!touched[f] && r->clip.at(f, 0).translation.y == walk.at(f, 0).translation.y)
            for (std::size_t j = 0; j < s.size(); ++j) CHECK(identical(r->clip.at(f, j), walk.at(f, j)));
    // Without hip adjustment the root is never touched (and reach limits may leave some slide).
    FootLockOptions fixed_hips;
    fixed_hips.adjust_hips = false;
    auto pinned = foot_lock(walk, s, fixed_hips);
    CHECK(pinned && pinned->max_hip_drop == 0.F);
    for (std::size_t f = 0; pinned && f < walk.frames(); ++f) CHECK(identical(pinned->clip.at(f, 0), walk.at(f, 0)));
    // Pinned ankles sit where each contact started, at their animated height.
    for (const FootContact &c : r->contacts) {
        const auto g = forward_kinematics(s, r->clip.frame((c.start + c.end) / 2));
        const Vec3 a = g[static_cast<std::size_t>(legs[static_cast<std::size_t>(c.foot)].foot)].translation;
        CHECK(std::hypot(a.x - c.position.x, a.z - c.position.z) < 1.e-3F);
    }
    // Deterministic.
    auto again = foot_lock(walk, s);
    CHECK(again && again->clip.at(40, legs[0].calf).rotation.w == r->clip.at(40, legs[0].calf).rotation.w);
}

void synthetic_slide_test(const Skeleton &soma) {
    // Standing still while the whole body drifts slowly (a sliding stand): one long contact per
    // foot, and locking removes the drift from the feet.
    AnimationClip c;
    c.joint_count = soma.size();
    for (const Joint &j : soma.joints) c.joint_names.push_back(j.name);
    float lowest = 0.F;
    for (const auto &t : soma.rest_global()) lowest = std::min(lowest, t.translation.y);
    for (std::size_t f = 0; f < 40; ++f) {
        for (const Joint &j : soma.joints) c.locals.push_back(j.rest_local);
        c.at(f, 0).translation = {.004F * static_cast<float>(f), -lowest - .03F, 0.F}; // knees slightly bent below
        c.at(f, idx(soma, "LeftShin")).rotation = Quat::from_axis_angle({1, 0, 0}, .25F);
        c.at(f, idx(soma, "RightShin")).rotation = Quat::from_axis_angle({1, 0, 0}, .25F);
        c.at(f, idx(soma, "LeftLeg")).rotation = Quat::from_axis_angle({1, 0, 0}, -.12F);
        c.at(f, idx(soma, "RightLeg")).rotation = Quat::from_axis_angle({1, 0, 0}, -.12F);
    }
    auto r = foot_lock(c, soma);
    CHECK(r.has_value());
    if (!r) return;
    CHECK(r->contacts.size() == 2 && r->contacts[0].start == 0 && r->contacts[0].end == 39);
    CHECK(r->slide_before > .07F && r->slide_after < 1.e-3F); // 0.16 m drift, measured from the mean pin
    // Thresholds can be set explicitly; an impossible height threshold finds no contacts.
    FootLockOptions none;
    none.height_threshold = 1.e-6F;
    none.speed_threshold = 1.e-6F;
    CHECK(detect_foot_contacts(c, soma, none).value().empty());
    // Errors.
    CHECK(!foot_lock(AnimationClip{}, soma).has_value());
    Skeleton no_legs = soma;
    for (auto &j : no_legs.joints) j.name = "joint_" + std::to_string(&j - no_legs.joints.data());
    CHECK(!find_legs(no_legs).has_value());
}
} // namespace

int main(int argc, char **argv) {
    if (argc != 3) {
        std::cerr << "usage: kimodo-anim-ik-test BASELINE_MOTION_DIR RIGS_DIR\n";
        return 2;
    }
    auto motion = read_motion_dir(argv[1]);
    auto rig = load_gltf_character(std::filesystem::path(argv[2]) / "test_rig.glb");
    if (!motion || !rig) {
        std::cerr << (motion ? rig.error() : motion.error()) << '\n';
        return 1;
    }
    const Skeleton soma = native_skeleton("soma30").value();
    const AnimationClip walk = clip_from_motion(soma, *motion).value();
    two_bone_tests(soma);
    walk_tests(soma, walk, "soma30 walk");
    // Retargeted onto the test character; and with the path follower (which makes feet slide).
    const auto rt = retarget(walk, soma, rig->skeleton, auto_map(soma, rig->skeleton)).value();
    walk_tests(rig->skeleton, rt.clip, "test_rig walk");
    AnimationClip fast = walk;
    RootMotionSettings path;
    path.mode = RootMotionMode::CustomPath;
    path.path = MotionPathSpec{{{0, 0, 0}, {0, 0, 3.6F}}, PathInterpolation::Polyline};
    path.follow = {.timing = PathTiming::Duration}; // 3.6 m over the clip: ~20% faster than the walk, feet slide
    CHECK(apply_root_motion(fast, path).has_value());
    walk_tests(soma, fast, "soma30 fast path");
    synthetic_slide_test(soma);

    // Toes that dip below the floor for a few frames (long retargeted feet pitching at
    // toe-off) must not drag the ground estimate down and hide every contact.
    {
        AnimationClip dip = walk;
        const auto lf = static_cast<std::size_t>(soma.find("LeftFoot"));
        for (std::size_t f = 36; f < 42; ++f)
            dip.at(f, lf).rotation = normalize(dip.at(f, lf).rotation * Quat::from_axis_angle({1, 0, 0}, 1.2F));
        const auto base = detect_foot_contacts(walk, soma).value();
        const auto with_dip = detect_foot_contacts(dip, soma).value();
        CHECK(with_dip.size() + 1 >= base.size()); // at most the dipping step changes
        const auto rl = foot_lock(walk, soma).value(), rd = foot_lock(dip, soma).value();
        CHECK(std::fabs(rd.ground - rl.ground) < .01F);
        CHECK(rd.slide_after < 1.e-3F);
    }
    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all anim IK checks passed\n";
    return 0;
}
