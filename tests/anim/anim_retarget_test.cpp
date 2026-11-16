// Kimodo Extended step 3: role detection, mapping, diagnostics and retargeting.
// usage: kimodo-anim-retarget-test BASELINE_MOTION_DIR RIGS_DIR
#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/gltf.hpp>
#include <kimodo/anim/retarget.hpp>

#include <cmath>
#include <filesystem>
#include <iostream>
#include <numbers>

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

constexpr float pi = std::numbers::pi_v<float>;
bool near(float a, float b, float eps = 1.e-4F) { return std::fabs(a - b) <= eps; }
bool near(Vec3 a, Vec3 b, float eps = 1.e-4F) { return length(a - b) <= eps; }
bool finite(Vec3 v) { return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z); }

std::string mapped_source(const RetargetMapping &m, std::string_view target) {
    for (const auto &j : m.joints)
        if (j.target == target) return j.source;
    return "";
}

// Builds a skeleton with the given names/parents, global rest positions and global rest rotations.
Skeleton from_globals(const Skeleton &topology, const std::vector<Vec3> &pos, const std::vector<Quat> &rot,
                      std::string source = "custom") {
    Skeleton s = topology;
    s.source = std::move(source);
    for (std::size_t j = 0; j < s.size(); ++j) {
        const int p = s.joints[j].parent;
        Transform &l = s.joints[j].rest_local;
        if (p < 0) {
            l.translation = pos[j];
            l.rotation = rot[j];
        } else {
            const Quat pinv = inverse(rot[static_cast<std::size_t>(p)]);
            l.translation = rotate(pinv, pos[j] - pos[static_cast<std::size_t>(p)]);
            l.rotation = normalize(pinv * rot[j]);
        }
        l.scale = {1, 1, 1};
        s.joints[j].source_node = s.joints[j].skin_joint = -1;
    }
    return s;
}

std::vector<Vec3> positions(const std::vector<Transform> &g) {
    std::vector<Vec3> p;
    for (const auto &t : g) p.push_back(t.translation);
    return p;
}

// One-frame source clip at the source's standing reference (rest rotations, root at hip height).
AnimationClip reference_frame(const Skeleton &soma) {
    AnimationClip c;
    c.joint_count = soma.size();
    for (const Joint &j : soma.joints) c.locals.push_back(j.rest_local);
    float lowest = 0.F;
    for (const auto &t : soma.rest_global()) lowest = std::min(lowest, t.translation.y);
    c.locals[0].translation = {0, -lowest, 0};
    return c;
}

void role_tests(const Skeleton &soma, const Skeleton &rig) {
    const auto rs = detect_roles(soma);
    auto name = [](const Skeleton &s, int j) { return j >= 0 ? s.joints[static_cast<std::size_t>(j)].name : std::string("-"); };
    CHECK(name(soma, rs[Role::Hips]) == "Hips");
    CHECK(name(soma, rs[Role::LeftThigh]) == "LeftLeg");   // SOMA: LeftLeg is the thigh
    CHECK(name(soma, rs[Role::LeftCalf]) == "LeftShin");
    CHECK(name(soma, rs[Role::LeftFoot]) == "LeftFoot");
    CHECK(name(soma, rs[Role::LeftToe]) == "LeftToeBase");
    CHECK(name(soma, rs[Role::RightClavicle]) == "RightShoulder");
    CHECK(name(soma, rs[Role::RightUpperArm]) == "RightArm");
    CHECK(name(soma, rs[Role::RightHand]) == "RightHand");
    CHECK(name(soma, rs[Role::Head]) == "Head");
    CHECK(rs.spine.size() == 3 && rs.neck.size() == 2);

    const auto smplx = native_skeleton("smplx22").value();
    const auto rx = detect_roles(smplx);
    CHECK(name(smplx, rx[Role::Hips]) == "pelvis");
    CHECK(name(smplx, rx[Role::LeftThigh]) == "left_hip");
    CHECK(name(smplx, rx[Role::LeftCalf]) == "left_knee");
    CHECK(name(smplx, rx[Role::LeftFoot]) == "left_ankle");
    CHECK(name(smplx, rx[Role::LeftToe]) == "left_foot");
    CHECK(name(smplx, rx[Role::LeftClavicle]) == "left_collar");
    CHECK(name(smplx, rx[Role::LeftUpperArm]) == "left_shoulder");
    CHECK(name(smplx, rx[Role::LeftHand]) == "left_wrist");

    const auto rr = detect_roles(rig); // Mixamo-style names: LeftLeg is the calf
    CHECK(name(rig, rr[Role::LeftThigh]) == "LeftUpLeg");
    CHECK(name(rig, rr[Role::LeftCalf]) == "LeftLeg");
    CHECK(name(rig, rr[Role::LeftClavicle]) == "-");
    CHECK(name(rig, rr[Role::LeftUpperArm]) == "LeftArm");
    CHECK(name(rig, rr[Role::Head]) == "Head"); // not HeadTop_End

    // Namespaced / UE-style names.
    Skeleton ns = rig;
    for (auto &j : ns.joints) j.name = "mixamorig:" + j.name;
    CHECK(name(ns, detect_roles(ns)[Role::LeftCalf]) == "mixamorig:LeftLeg");
    Skeleton ue = rig;
    for (auto &j : ue.joints) {
        if (j.name == "LeftUpLeg") j.name = "thigh_l";
        if (j.name == "LeftLeg") j.name = "calf_l";
        if (j.name == "LeftFoot") j.name = "foot_l";
        if (j.name == "LeftToeBase") j.name = "ball_l";
        if (j.name == "Hips") j.name = "pelvis";
    }
    const auto ru = detect_roles(ue);
    CHECK(name(ue, ru[Role::LeftThigh]) == "thigh_l" && name(ue, ru[Role::LeftCalf]) == "calf_l");
    CHECK(name(ue, ru[Role::LeftToe]) == "ball_l");
}

void mapping_tests(const Skeleton &soma, const Skeleton &rig) {
    const RetargetMapping m = auto_map(soma, rig);
    CHECK(mapped_source(m, "Hips") == "Hips");
    CHECK(mapped_source(m, "LeftUpLeg") == "LeftLeg");
    CHECK(mapped_source(m, "LeftLeg") == "LeftShin");
    CHECK(mapped_source(m, "RightToeBase") == "RightToeBase");
    CHECK(mapped_source(m, "LeftArm") == "LeftArm");
    CHECK(mapped_source(m, "Spine") == "Spine1");
    CHECK(mapped_source(m, "Chest") == "Chest");       // last spine <-> last spine
    CHECK(mapped_source(m, "Neck") == "Neck1");
    CHECK(mapped_source(m, "Head") == "Head");
    CHECK(mapped_source(m, "HeadTop_End").empty());
    const auto d = check_mapping(m, soma, rig);
    CHECK(d.ok());
    for (const auto &e : d.errors) std::cerr << "  unexpected error: " << e << '\n';

    // JSON round trip, offsets included.
    RetargetMapping with_offset = m;
    with_offset.joints[1].offset = Quat::from_axis_angle({0, 1, 0}, .5F);
    const auto back = mapping_from_json(mapping_to_json(with_offset));
    CHECK(back.has_value());
    if (back) {
        CHECK(back->joints.size() == m.joints.size());
        CHECK(back->joints[1].target == with_offset.joints[1].target);
        CHECK(near(angle_between(back->joints[1].offset, with_offset.joints[1].offset), 0.F, 1.e-5F));
        CHECK(back->source_skeleton == "native:soma30");
    }
    CHECK(!mapping_from_json("{").has_value());
    CHECK(!mapping_from_json(R"({"joints":[{"target":"Hips"}]})").has_value());
    CHECK(!mapping_from_json(R"({"version":2,"joints":[]})").has_value());
    const auto tmp = std::filesystem::temp_directory_path() / "kimodo_mapping_test.json";
    CHECK(save_mapping(tmp, m).has_value());
    CHECK(load_mapping(tmp).has_value() && load_mapping(tmp)->joints.size() == m.joints.size());
    std::filesystem::remove(tmp);

    // Diagnostics: errors, never crashes.
    RetargetMapping bad = m;
    bad.joints.push_back({"NoSuchJoint", "Hips", {}});
    CHECK(!check_mapping(bad, soma, rig).ok());
    bad = m;
    bad.joints.push_back({"LeftArm", "RightArm", {}}); // target mapped twice
    CHECK(!check_mapping(bad, soma, rig).ok());
    bad = m;
    std::erase_if(bad.joints, [](const JointMapping &j) { return j.source == "Hips"; }); // root unmapped
    CHECK(!check_mapping(bad, soma, rig).ok());
    AnimationClip one = reference_frame(soma);
    CHECK(!retarget(one, soma, rig, bad).has_value());
    bad = m;
    for (auto &j : bad.joints)
        if (j.target == "LeftForeArm") j.source = "LeftShin"; // arm driven by a leg: incompatible parents
    const auto incompatible = check_mapping(bad, soma, rig);
    CHECK(!incompatible.ok() && incompatible.errors.front().find("incompatible parents") != std::string::npos);
    bad = m;
    for (auto &j : bad.joints)
        if (j.target == "LeftForeArm") j.source = "LeftArm"; // same source twice along a chain: warning
    const auto twice = check_mapping(bad, soma, rig);
    CHECK(twice.ok() && !twice.warnings.empty());
    bad = m;
    std::erase_if(bad.joints, [](const JointMapping &j) { return j.target == "LeftHand"; });
    const auto incomplete = check_mapping(bad, soma, rig);
    CHECK(incomplete.ok() && !incomplete.warnings.empty());
}

void rest_pose_tests(const Skeleton &soma, const Skeleton &rig) {
    // A source frame at its standing reference gives exactly the target rest pose.
    const auto r = retarget(reference_frame(soma), soma, rig, auto_map(soma, rig));
    CHECK(r.has_value());
    if (!r) { std::cerr << r.error() << '\n'; return; }
    // The test rig's Armature faces +X. SOMA's hips are not perfectly symmetric (~0.07 deg).
    CHECK(near(r->facing_yaw_degrees, 90.F, .5F));
    for (std::size_t t = 0; t < rig.size(); ++t) {
        CHECK(near(angle_between(r->clip.at(0, t).rotation, rig.joints[t].rest_local.rotation), 0.F, 1.e-3F));
        CHECK(near(r->clip.at(0, t).translation, rig.joints[t].rest_local.translation, 1.e-4F));
    }
}

void structural_tests(const Skeleton &soma, const AnimationClip &walk) {
    const auto rest = soma.rest_global();
    float lowest = 0.F;
    for (const auto &t : rest) lowest = std::min(lowest, t.translation.y);
    std::vector<Vec3> pos;
    for (const auto &t : rest) pos.push_back(t.translation + Vec3{0, -lowest, 0}); // stand on y = 0
    const std::size_t n = soma.size();
    const auto src_frames = [&](std::size_t f) { return positions(forward_kinematics(soma, walk.frame(f))); };

    // (1) Inverted axes / rest rotation offsets: same rest positions, scrambled local frames.
    std::vector<Quat> scrambled(n);
    const Vec3 axes[3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    for (std::size_t j = 0; j < n; ++j)
        scrambled[j] = j % 4 == 0 ? Quat::from_axis_angle(axes[j % 3], pi)                  // 180 deg flips
                                  : Quat::from_axis_angle(normalize(Vec3{1.F, float(j), -2.F}), .3F * float(j));
    const Skeleton weird = from_globals(soma, pos, scrambled, "scrambled");
    CHECK(weird.validate().has_value());
    RetargetMapping identity;
    for (const Joint &j : soma.joints) identity.joints.push_back({j.name, j.name, {}});
    auto r = retarget(walk, soma, weird, identity);
    CHECK(r.has_value());
    if (r) {
        CHECK(near(r->root_scale, 1.F, 1.e-4F));
        CHECK(near(r->facing_yaw_degrees, 0.F, 1.e-3F));
        float worst = 0.F;
        for (std::size_t f = 0; f < walk.frames(); f += 7) {
            const auto a = src_frames(f), b = positions(forward_kinematics(weird, r->clip.frame(f)));
            for (std::size_t j = 0; j < n; ++j) worst = std::max(worst, length(a[j] - b[j]));
        }
        CHECK(worst < 1.e-4F);
        if (worst >= 1.e-4F) std::cerr << "  scrambled axes: max joint error " << worst << " m\n";
    }

    // (2) Different limb lengths: everything 1.3x larger -> root travel and pose scale by 1.3.
    std::vector<Vec3> big = pos;
    for (auto &p : big) p = p * 1.3F;
    const Skeleton giant = from_globals(soma, big, std::vector<Quat>(n), "giant");
    r = retarget(walk, soma, giant, identity);
    CHECK(r.has_value());
    if (r) {
        CHECK(near(r->root_scale, 1.3F, 1.e-4F));
        float worst = 0.F;
        for (std::size_t f = 0; f < walk.frames(); f += 7) {
            const auto a = src_frames(f), b = positions(forward_kinematics(giant, r->clip.frame(f)));
            for (std::size_t j = 0; j < n; ++j) worst = std::max(worst, length((a[j] - a[0]) * 1.3F - (b[j] - b[0])));
            CHECK(near(b[0], a[0] * 1.3F, 1.e-3F)); // root offset scaled about the floor origin
        }
        CHECK(worst < 1.e-4F);
    }

    // (3) Different facing: the whole target turned 90 degrees about up.
    const Quat turn = Quat::from_axis_angle({0, 1, 0}, pi / 2);
    std::vector<Vec3> turned_pos;
    std::vector<Quat> turned_rot;
    for (std::size_t j = 0; j < n; ++j) {
        turned_pos.push_back(rotate(turn, pos[j]));
        turned_rot.push_back(turn * scrambled[j]);
    }
    const Skeleton turned = from_globals(soma, turned_pos, turned_rot, "turned");
    r = retarget(walk, soma, turned, identity);
    CHECK(r.has_value());
    if (r) {
        CHECK(near(r->facing_yaw_degrees, 90.F, 1.e-3F));
        const auto a = src_frames(45), b = positions(forward_kinematics(turned, r->clip.frame(45)));
        for (std::size_t j = 0; j < n; ++j) CHECK(near(b[j], rotate(turn, a[j]), 1.e-4F));
    }

    // (4) Unmapped joints keep their rest local rotation (explicit KeepRest policy).
    RetargetMapping partial = identity;
    std::erase_if(partial.joints, [](const JointMapping &j) { return j.target == "LeftForeArm"; });
    r = retarget(walk, soma, weird, partial);
    CHECK(r.has_value());
    if (r) {
        const auto fa = static_cast<std::size_t>(weird.find("LeftForeArm"));
        for (std::size_t f = 0; f < walk.frames(); f += 11)
            CHECK(near(angle_between(r->clip.at(f, fa).rotation, weird.joints[fa].rest_local.rotation), 0.F, 1.e-5F));
        CHECK(!r->diagnostics.warnings.empty());
    }

    // (5) A-pose target: rest-direction alignment makes the arm follow the source's T-pose.
    std::vector<Vec3> apose = pos;
    const int la = soma.find("LeftArm");
    const Quat down = Quat::from_axis_angle({0, 0, 1}, -pi / 4);
    for (std::size_t j = 0; j < n; ++j)
        if (static_cast<int>(j) != la && (soma.find("LeftArm") == static_cast<int>(j) ||
                                          [&] { for (int p = soma.joints[j].parent; p >= 0; p = soma.joints[static_cast<std::size_t>(p)].parent) if (p == la) return true; return false; }()))
            apose[j] = pos[static_cast<std::size_t>(la)] + rotate(down, pos[j] - pos[static_cast<std::size_t>(la)]);
    const Skeleton aposed = from_globals(soma, apose, std::vector<Quat>(n), "apose");
    const std::size_t lf = static_cast<std::size_t>(soma.find("LeftForeArm"));
    const AnimationClip ref = reference_frame(soma);
    const auto src_dir = normalize(pos[lf] - pos[static_cast<std::size_t>(la)]);
    auto plain = retarget(ref, soma, aposed, identity);
    RetargetOptions align;
    align.align_rest_directions = true;
    auto aligned = retarget(ref, soma, aposed, identity, align);
    CHECK(plain.has_value() && aligned.has_value());
    if (plain && aligned) {
        const auto pp = positions(forward_kinematics(aposed, plain->clip.frame(0)));
        const auto pa = positions(forward_kinematics(aposed, aligned->clip.frame(0)));
        const auto ua = static_cast<std::size_t>(la);
        CHECK(near(angle_between(Quat{}, from_to(pp[lf] - pp[ua], src_dir)), pi / 4, 1.e-3F)); // stays in A-pose
        CHECK(near(normalize(pa[lf] - pa[ua]), src_dir, 1.e-4F));                              // follows T-pose
    }
}

void real_rig_tests(const Skeleton &soma, const AnimationClip &walk, const Skeleton &rig) {
    const RetargetMapping m = auto_map(soma, rig);
    auto r = retarget(walk, soma, rig, m);
    CHECK(r.has_value());
    if (!r) { std::cerr << r.error() << '\n'; return; }
    CHECK(r->translation_joint == rig.find("Hips"));
    CHECK(r->clip.frames() == walk.frames() && r->clip.joint_count == rig.size());
    const auto rest = rig.rest_global();
    float lowest_rest = 1e9F;
    for (const auto &t : rest) lowest_rest = std::min(lowest_rest, t.translation.y);
    const auto feet = {rig.find("LeftToeBase"), rig.find("RightToeBase"), rig.find("LeftFoot"), rig.find("RightFoot")};
    float lowest_foot = 1e9F;
    for (std::size_t f = 0; f < walk.frames(); ++f) {
        const auto g = forward_kinematics(rig, r->clip.frame(f));
        for (const auto &t : g) CHECK(finite(t.translation));
        for (const int j : feet) lowest_foot = std::min(lowest_foot, g[static_cast<std::size_t>(j)].translation.y);
    }
    CHECK(lowest_foot > lowest_rest - .1F); // feet stay near the rig's ground
    CHECK(lowest_foot < lowest_rest + .1F);
    // The walk travels forward in the rig's own facing (+X for the test rig).
    const auto g0 = forward_kinematics(rig, r->clip.frame(0));
    const auto g1 = forward_kinematics(rig, r->clip.frame(walk.frames() - 1));
    const Vec3 travel = g1[0].translation - g0[0].translation;
    CHECK(travel.x > 1.F && std::fabs(travel.z) < .5F);
    // Deterministic.
    auto again = retarget(walk, soma, rig, m);
    CHECK(again && again->clip.at(50, 7).rotation.w == r->clip.at(50, 7).rotation.w);
}
// Mixamo-style names ("mixamorig:") and an A-pose rest: auto-mapping and rest alignment.
void mixamo_apose_tests(const Skeleton &soma, const Skeleton &rig) {
    const RetargetMapping m = auto_map(soma, rig);
    CHECK(mapped_source(m, "mixamorig:LeftLeg") == "LeftShin");
    CHECK(mapped_source(m, "mixamorig:LeftArm") == "LeftArm");
    CHECK(check_mapping(m, soma, rig).ok());
    const auto rest = rig.rest_global();
    const auto la = static_cast<std::size_t>(rig.find("mixamorig:LeftArm"));
    const auto lf = static_cast<std::size_t>(rig.find("mixamorig:LeftForeArm"));
    const Vec3 rest_dir = normalize(rest[lf].translation - rest[la].translation);
    CHECK(rest_dir.y < -.6F); // A-pose: the upper arm points down at rest

    RetargetOptions align;
    align.align_rest_directions = true;
    auto plain = retarget(reference_frame(soma), soma, rig, m);
    auto aligned = retarget(reference_frame(soma), soma, rig, m, align);
    CHECK(plain.has_value() && aligned.has_value());
    if (!plain || !aligned) return;
    const auto gp = forward_kinematics(rig, plain->clip.frame(0));
    const auto ga = forward_kinematics(rig, aligned->clip.frame(0));
    CHECK(near(normalize(gp[lf].translation - gp[la].translation), rest_dir, 1.e-4F)); // keeps the A-pose
    CHECK(std::fabs(normalize(ga[lf].translation - ga[la].translation).y) < .05F);      // T-pose like the source

    // Reference pose: the aligned T-pose given explicitly reproduces the alignment ...
    RetargetOptions ref;
    ref.reference_pose.emplace();
    for (std::size_t t = 0; t < rig.size(); ++t) ref.reference_pose->rotations[rig.joints[t].name] = aligned->clip.at(0, t).rotation;
    auto with_ref = retarget(reference_frame(soma), soma, rig, m, ref);
    CHECK(with_ref.has_value());
    if (with_ref)
        for (std::size_t t = 0; t < rig.size(); ++t)
            CHECK(angle_between(with_ref->clip.at(0, t).rotation, aligned->clip.at(0, t).rotation) < 1.e-3F);
    // ... and a hand edit (left upper arm raised 20 degrees more in the T-pose) means the source
    // rest maps to that edited pose.
    const Quat raise = Quat::from_axis_angle({0, 0, 1}, .35F);
    ref.reference_pose->rotations["mixamorig:LeftArm"] = normalize(aligned->clip.at(0, la).rotation * raise);
    auto edited = retarget(reference_frame(soma), soma, rig, m, ref);
    CHECK(edited.has_value());
    if (edited) CHECK(angle_between(edited->clip.at(0, la).rotation, ref.reference_pose->rotations["mixamorig:LeftArm"]) < 1.e-3F);
    // JSON.
    auto parsed = reference_pose_from_json(R"({"format":"kimodo-reference-pose","version":1,"joints":{"A":[0,0,0,2]}})");
    CHECK(parsed && parsed->rotations.at("A").w == 1.F);
    CHECK(!reference_pose_from_json(R"({"joints":{"A":[0,0,0]}})").has_value());
}
// Back to the source: forward then back keeps the root and every joint the rig maps.
void back_tests(const Skeleton &soma, const AnimationClip &walk, const Skeleton &rig, bool align) {
    const RetargetMapping m = auto_map(soma, rig);
    RetargetOptions o;
    o.align_rest_directions = align;
    auto fwd = retarget(walk, soma, rig, m, o);
    CHECK(fwd.has_value());
    if (!fwd) return;
    auto back = retarget_back(fwd->clip, rig, soma, m, o);
    CHECK(back.has_value());
    if (!back) return;
    CHECK(back->clip.frames() == walk.frames() && back->clip.joint_count == soma.size());
    float root = 0.F, legs = 0.F;
    for (const std::size_t f : {std::size_t{0}, std::size_t{30}, std::size_t{60}, walk.frames() - 1}) {
        const auto a = forward_kinematics(soma, walk.frame(f)), b = forward_kinematics(soma, back->clip.frame(f));
        root = std::max(root, length(a[0].translation - b[0].translation));
        for (const char *n : {"LeftFoot", "RightFoot", "LeftShin", "RightToeBase"}) {
            const auto j = static_cast<std::size_t>(soma.find(n));
            legs = std::max(legs, length(a[j].translation - b[j].translation));
        }
    }
    if (root >= 1.e-3F) {
        const auto a = forward_kinematics(soma, walk.frame(0)), b = forward_kinematics(soma, back->clip.frame(0));
        std::cerr << "frame0 root orig " << a[0].translation.x << "," << a[0].translation.y << "," << a[0].translation.z
                  << " back " << b[0].translation.x << "," << b[0].translation.y << "," << b[0].translation.z << " scale " << back->root_scale
                  << " fwd scale " << fwd->root_scale << " tj " << back->translation_joint << '\n';
    }
    if (root >= 1.e-3F || legs >= 1.e-2F) std::cerr << "back (align " << align << "): root " << root << " legs " << legs << '\n';
    CHECK(root < 1.e-3F);  // the root (height included) comes back
    CHECK(legs < 1.e-2F);  // the legs, mapped one to one, come back
}
// A skeleton without a head (the Unitree G1 robot): the spine is the path to the arms' common
// parent, so the character's spine and chest are driven too.
void g1_tests(const Skeleton &rig) {
    const Skeleton g1 = native_skeleton("g1skel34").value();
    const SkeletonRoles roles = detect_roles(g1);
    CHECK(roles.spine.size() == 3 && g1.joints[static_cast<std::size_t>(roles.spine.back())].name == "waist_pitch_skel");
    const RetargetMapping m = auto_map(g1, rig);
    CHECK(check_mapping(m, g1, rig).ok());
    CHECK(!mapped_source(m, "Spine").empty() && !mapped_source(m, "Chest").empty());
    CHECK(mapped_source(m, "Chest") == "waist_pitch_skel");
    CHECK(mapped_source(m, "LeftArm") == "left_shoulder_yaw_skel" && mapped_source(m, "RightLeg") == "right_knee_skel");
}
} // namespace

int main(int argc, char **argv) {
    if (argc != 3) {
        std::cerr << "usage: kimodo-anim-retarget-test BASELINE_MOTION_DIR RIGS_DIR\n";
        return 2;
    }
    auto motion = read_motion_dir(argv[1]);
    auto character = load_gltf_character(std::filesystem::path(argv[2]) / "test_rig.glb");
    if (!motion || !character) {
        std::cerr << (motion ? character.error() : motion.error()) << '\n';
        return 1;
    }
    const Skeleton soma = native_skeleton("soma30").value();
    const AnimationClip walk = clip_from_motion(soma, *motion).value();
    role_tests(soma, character->skeleton);
    mapping_tests(soma, character->skeleton);
    rest_pose_tests(soma, character->skeleton);
    structural_tests(soma, walk);
    real_rig_tests(soma, walk, character->skeleton);
    auto mixamo = load_gltf_character(std::filesystem::path(argv[2]) / "test_rig_mixamo_apose.glb");
    CHECK(mixamo.has_value());
    if (mixamo) mixamo_apose_tests(soma, mixamo->skeleton);
    back_tests(soma, walk, character->skeleton, false);
    g1_tests(character->skeleton);
    if (mixamo) back_tests(soma, walk, mixamo->skeleton, true);
    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all anim retarget checks passed\n";
    return 0;
}
