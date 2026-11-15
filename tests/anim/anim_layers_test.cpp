// Kimodo Extended step 4: masks, Override/Additive layers, stack evaluation and baking.
// usage: kimodo-anim-layers-test BASELINE_MOTION_DIR RIGS_DIR
#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/gltf.hpp>
#include <kimodo/anim/layers.hpp>

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
bool near(float a, float b, float eps = 1.e-5F) { return std::fabs(a - b) <= eps; }
bool same_rot(Quat a, Quat b, float eps = 1.e-4F) { return angle_between(a, b) <= eps; }
bool identical(const Transform &a, const Transform &b) {
    return a.rotation.x == b.rotation.x && a.rotation.y == b.rotation.y && a.rotation.z == b.rotation.z &&
           a.rotation.w == b.rotation.w && a.translation.x == b.translation.x && a.translation.y == b.translation.y &&
           a.translation.z == b.translation.z;
}
bool same_pose(const std::vector<Transform> &a, const std::vector<Transform> &b, float eps = 1.e-5F) {
    if (a.size() != b.size()) return false;
    for (std::size_t j = 0; j < a.size(); ++j)
        if (!same_rot(a[j].rotation, b[j].rotation, eps * 10.F) || length(a[j].translation - b[j].translation) > eps) return false;
    return true;
}

AnimationLayer layer(std::string name, AnimationClip clip, BlendMode mode = BlendMode::Override, float weight = 1.F) {
    AnimationLayer l;
    l.name = std::move(name);
    l.clip = std::move(clip);
    l.mode = mode;
    l.weight = weight;
    return l;
}

// The walk with every joint rotated by a joint-dependent offset (a clearly different motion).
AnimationClip twisted(const AnimationClip &walk) {
    AnimationClip c = walk;
    for (std::size_t f = 0; f < c.frames(); ++f)
        for (std::size_t j = 0; j < c.joint_count; ++j)
            c.at(f, j).rotation = normalize(Quat::from_axis_angle(normalize(Vec3{1.F, float(j % 3), .5F}), .4F) * c.at(f, j).rotation);
    return c;
}

// Clip at rest except `joint`, which holds `first` on frame 0 and `first * rot` afterwards.
AnimationClip constant(const Skeleton &s, std::size_t frames, std::string_view joint, Quat rot, Quat first = {}) {
    AnimationClip c;
    c.joint_count = s.size();
    for (const Joint &j : s.joints) c.joint_names.push_back(j.name);
    for (std::size_t f = 0; f < frames; ++f)
        for (const Joint &j : s.joints) {
            Transform t = j.rest_local;
            if (j.name == joint) t.rotation = f == 0 ? first : normalize(first * rot);
            c.locals.push_back(t);
        }
    return c;
}

std::vector<std::size_t> indices(const Skeleton &s, std::initializer_list<std::string_view> names) {
    std::vector<std::size_t> out;
    for (auto n : names) out.push_back(static_cast<std::size_t>(s.find(n)));
    return out;
}

void basic_tests(const Skeleton &soma, const AnimationClip &walk) {
    // One full Override layer at weight 1 bakes to the clip itself, bit for bit.
    AnimationStack one(soma);
    CHECK(one.add_layer(layer("base", walk)).has_value());
    const AnimationClip baked = one.bake();
    CHECK(baked.frames() == walk.frames() && near(baked.fps, 30.F));
    bool exact = true;
    for (std::size_t i = 0; i < walk.locals.size(); ++i) exact = exact && identical(baked.locals[i], walk.locals[i]);
    CHECK(exact);

    const AnimationClip other = twisted(walk);
    // Weight 0 == disabled == not there.
    AnimationStack zero(soma), off(soma);
    CHECK(zero.add_layer(layer("base", walk)).has_value() && zero.add_layer(layer("b", other, BlendMode::Override, 0.F)).has_value());
    AnimationLayer disabled = layer("b", other);
    disabled.enabled = false;
    CHECK(off.add_layer(layer("base", walk)).has_value() && off.add_layer(disabled).has_value());
    for (float t : {0.F, .5F, 1.7F, 2.9F}) {
        CHECK(same_pose(zero.evaluate(t), one.evaluate(t), 0.F));
        CHECK(same_pose(off.evaluate(t), one.evaluate(t), 0.F));
    }
    // Weight 1 Override replaces the pose; weight 0.5 is halfway.
    AnimationStack full(soma), half(soma);
    CHECK(full.add_layer(layer("base", walk)).has_value() && full.add_layer(layer("b", other)).has_value());
    CHECK(half.add_layer(layer("base", walk)).has_value() && half.add_layer(layer("b", other, BlendMode::Override, .5F)).has_value());
    const auto pf = full.evaluate(1.F), ph = half.evaluate(1.F), pw = sample_clip(walk, 1.F), po = sample_clip(other, 1.F);
    CHECK(same_pose(pf, po, 0.F));
    for (std::size_t j = 0; j < pw.size(); ++j)
        CHECK(near(angle_between(pw[j].rotation, ph[j].rotation), angle_between(pw[j].rotation, po[j].rotation) / 2.F, 1.e-3F));
}

void mask_tests(const Skeleton &soma, const AnimationClip &walk, const Skeleton &rig) {
    const AnimationClip other = twisted(walk);
    const auto legs = indices(soma, {"Hips", "LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase", "RightLeg", "RightShin", "RightFoot", "RightToeBase"});
    const auto arms = indices(soma, {"Chest", "LeftArm", "LeftForeArm", "RightHand", "Head", "Spine1"});
    AnimationLayer upper = layer("upper", other);
    upper.mask = upper_body_mask(soma);
    AnimationStack s(soma);
    CHECK(s.add_layer(layer("base", walk)).has_value() && s.add_layer(upper).has_value());
    for (float t : {0.F, 1.2F, 2.5F}) {
        const auto p = s.evaluate(t), w = sample_clip(walk, t), o = sample_clip(other, t);
        for (auto j : legs) CHECK(identical(p[j], w[j])); // an Upper Body layer never touches the legs
        for (auto j : arms) CHECK(identical(p[j], o[j]));
    }
    AnimationLayer lower = layer("lower", other);
    lower.mask = lower_body_mask(soma);
    AnimationStack sl(soma);
    CHECK(sl.add_layer(layer("base", walk)).has_value() && sl.add_layer(lower).has_value());
    const auto p = sl.evaluate(1.F), w = sample_clip(walk, 1.F), o = sample_clip(other, 1.F);
    for (auto j : arms) CHECK(identical(p[j], w[j]));
    for (auto j : legs) CHECK(identical(p[j], o[j]));

    // Presets on an imported rig: legs out of the upper body, spine in.
    const AnimationMask ru = upper_body_mask(rig), rl = lower_body_mask(rig);
    CHECK(ru.weight("LeftUpLeg") == 0.F && ru.weight("Spine") == 1.F && ru.weight("LeftHand") == 1.F && ru.weight("Hips") == 0.F);
    CHECK(rl.weight("LeftUpLeg") == 1.F && rl.weight("Hips") == 1.F && rl.weight("Head") == 0.F);
    CHECK(full_body_mask().weight("anything") == 1.F);

    // Empty mask (nothing selected) has no effect; a full mask is the full layer.
    AnimationLayer empty = layer("empty", other);
    empty.mask = AnimationMask{"empty", {}, 0.F};
    AnimationStack se(soma), base(soma);
    CHECK(se.add_layer(layer("base", walk)).has_value() && se.add_layer(empty).has_value());
    CHECK(base.add_layer(layer("base", walk)).has_value());
    CHECK(same_pose(se.evaluate(1.3F), base.evaluate(1.3F), 0.F));

    // Fractional mask weights scale the layer weight.
    AnimationLayer partial = layer("partial", other);
    partial.mask = AnimationMask{"partial", {{"LeftArm", .5F}}, 0.F};
    AnimationStack sp(soma);
    CHECK(sp.add_layer(layer("base", walk)).has_value() && sp.add_layer(partial).has_value());
    const std::size_t la = static_cast<std::size_t>(soma.find("LeftArm"));
    const auto pp = sp.evaluate(1.F);
    CHECK(near(angle_between(w[la].rotation, pp[la].rotation), angle_between(w[la].rotation, o[la].rotation) / 2.F, 1.e-3F));

    // JSON round trip and validation.
    const auto back = mask_from_json(mask_to_json(ru));
    CHECK(back.has_value() && back->weights == ru.weights && back->name == "upper");
    CHECK(!mask_from_json(R"({"weights":{"Hips":2}})").has_value());
    CHECK(!mask_from_json("[1,2]").has_value());
    const auto tmp = std::filesystem::temp_directory_path() / "kimodo_mask_test.json";
    CHECK(save_mask(tmp, rl).has_value() && load_mask(tmp)->weights == rl.weights);
    std::filesystem::remove(tmp);
}

void enable_mute_tests(const Skeleton &soma, const AnimationClip &walk) {
    // A longer second layer (4 s) distinguishes muted (still on the timeline) from disabled.
    AnimationClip longer = twisted(walk);
    const auto extra = std::vector<Transform>(longer.locals.end() - static_cast<std::ptrdiff_t>(longer.joint_count), longer.locals.end());
    while (longer.frames() < 121) longer.locals.insert(longer.locals.end(), extra.begin(), extra.end());
    AnimationLayer muted = layer("long", longer), disabled = layer("long", longer);
    muted.muted = true;
    disabled.enabled = false;
    AnimationStack sm(soma), sd(soma), base(soma);
    CHECK(sm.add_layer(layer("base", walk)).has_value() && sm.add_layer(muted).has_value());
    CHECK(sd.add_layer(layer("base", walk)).has_value() && sd.add_layer(disabled).has_value());
    CHECK(base.add_layer(layer("base", walk)).has_value());
    CHECK(near(sm.duration(), 4.F) && near(sd.duration(), walk.duration()));
    CHECK(sm.bake().frames() == 121 && sd.bake().frames() == walk.frames());
    for (float t : {.3F, 2.F, 3.5F}) {
        CHECK(same_pose(sm.evaluate(t), base.evaluate(t), 0.F)); // muted: no pose contribution
        CHECK(same_pose(sd.evaluate(t), base.evaluate(t), 0.F)); // disabled: no pose contribution either
    }
    // Toggling at run time through layer(i).
    sm.layer(1).muted = false;
    CHECK(!same_pose(sm.evaluate(2.F), base.evaluate(2.F), 1.e-3F));
}

void additive_tests(const Skeleton &soma, const AnimationClip &walk) {
    const std::size_t fa = static_cast<std::size_t>(soma.find("LeftForeArm"));
    const Quat bend = Quat::from_axis_angle({1, 0, 0}, .5F);
    // Rest-pose reference: the delta is the held rotation itself (SOMA rest rotations are identity).
    AnimationLayer add = layer("bend", constant(soma, 30, "LeftForeArm", {}, bend), BlendMode::Additive); // bend on every frame
    add.reference = AdditiveReference::RestPose;
    AnimationStack s(soma);
    CHECK(s.add_layer(layer("base", walk)).has_value() && s.add_layer(add).has_value());
    for (float t : {0.F, .5F, 2.F}) {
        const auto p = s.evaluate(t), w = sample_clip(walk, t);
        for (std::size_t j = 0; j < p.size(); ++j) {
            if (j == fa) CHECK(same_rot(p[j].rotation, w[j].rotation * bend));
            else CHECK(same_rot(p[j].rotation, w[j].rotation, 1.e-6F) && length(p[j].translation - w[j].translation) < 1.e-6F);
        }
    }
    // First-frame reference (default): frame 0 holds `start`, later frames start*bend -> delta bend after frame 0.
    const Quat start = Quat::from_axis_angle({0, 0, 1}, .8F);
    AnimationStack s2(soma);
    CHECK(s2.add_layer(layer("base", walk)).has_value() &&
          s2.add_layer(layer("bend", constant(soma, 30, "LeftForeArm", bend, start), BlendMode::Additive)).has_value());
    CHECK(same_rot(s2.evaluate(0.F)[fa].rotation, sample_clip(walk, 0.F)[fa].rotation));
    CHECK(same_rot(s2.evaluate(.5F)[fa].rotation, sample_clip(walk, .5F)[fa].rotation * bend));
    // Explicit reference frame and weight scaling.
    AnimationLayer framed = layer("bend", constant(soma, 30, "LeftForeArm", bend, start), BlendMode::Additive, .5F);
    framed.reference = AdditiveReference::Frame;
    framed.reference_frame = 10; // reference = start*bend, so every later frame has an identity delta
    AnimationStack s3(soma);
    CHECK(s3.add_layer(layer("base", walk)).has_value() && s3.add_layer(framed).has_value());
    CHECK(same_rot(s3.evaluate(.5F)[fa].rotation, sample_clip(walk, .5F)[fa].rotation));
    AnimationLayer halfway = layer("bend", constant(soma, 30, "LeftForeArm", {}, bend), BlendMode::Additive, .5F);
    halfway.reference = AdditiveReference::RestPose;
    AnimationStack s4(soma);
    CHECK(s4.add_layer(layer("base", walk)).has_value() && s4.add_layer(halfway).has_value());
    CHECK(same_rot(s4.evaluate(1.F)[fa].rotation, sample_clip(walk, 1.F)[fa].rotation * Quat::from_axis_angle({1, 0, 0}, .25F)));
    AnimationLayer bad = framed;
    bad.reference_frame = 99;
    CHECK(!s4.add_layer(bad).has_value());
}

void quaternion_edge_tests(const Skeleton &soma) {
    const std::size_t la = static_cast<std::size_t>(soma.find("LeftArm"));
    // Identity vs nearly 180 degrees: halfway is ~90 degrees, no NaN.
    const Quat almost = Quat::from_axis_angle({0, 1, 0}, pi - 1.e-3F);
    AnimationStack s(soma);
    CHECK(s.add_layer(layer("a", constant(soma, 2, "LeftArm", {}, {}))).has_value());
    CHECK(s.add_layer(layer("b", constant(soma, 2, "LeftArm", {}, almost), BlendMode::Override, .5F)).has_value());
    const Quat mid = s.evaluate(0.F)[la].rotation;
    CHECK(std::isfinite(mid.w) && near(angle_between(Quat{}, mid), (pi - 1.e-3F) / 2.F, 1.e-3F));
    // Antipodal representation of the same rotation: blending must not swing around.
    const Quat q = Quat::from_axis_angle({1, 1, 0}, 1.1F);
    const Quat neg{-q.x, -q.y, -q.z, -q.w};
    AnimationStack a(soma);
    CHECK(a.add_layer(layer("a", constant(soma, 2, "LeftArm", {}, q))).has_value());
    CHECK(a.add_layer(layer("b", constant(soma, 2, "LeftArm", {}, neg), BlendMode::Override, .5F)).has_value());
    CHECK(same_rot(a.evaluate(0.F)[la].rotation, q));
    // Additive of an antipodal delta is still the same rotation.
    AnimationLayer add = layer("add", constant(soma, 2, "LeftArm", {}, neg), BlendMode::Additive);
    add.reference = AdditiveReference::RestPose;
    AnimationStack b(soma);
    CHECK(b.add_layer(layer("a", constant(soma, 2, "LeftArm", {}, {}))).has_value() && b.add_layer(add).has_value());
    CHECK(same_rot(b.evaluate(0.F)[la].rotation, q));
}

void order_and_time_tests(const Skeleton &soma, const AnimationClip &walk) {
    const AnimationClip other = twisted(walk);
    AnimationLayer add = layer("add", constant(soma, 30, "LeftForeArm", Quat::from_axis_angle({1, 0, 0}, .5F)), BlendMode::Additive);
    add.reference = AdditiveReference::RestPose;
    AnimationStack ab(soma), ba(soma);
    CHECK(ab.add_layer(layer("base", walk)).has_value() && ab.add_layer(add).has_value() && ab.add_layer(layer("o", other)).has_value());
    CHECK(ba.add_layer(layer("base", walk)).has_value() && ba.add_layer(layer("o", other)).has_value() && ba.add_layer(add).has_value());
    CHECK(!same_pose(ab.evaluate(1.F), ba.evaluate(1.F), 1.e-3F)); // order matters
    ab.move_layer(2, 1);                                            // ... and reordering reproduces it
    CHECK(same_pose(ab.evaluate(1.F), ba.evaluate(1.F), 0.F));
    CHECK(same_pose(ab.evaluate(1.F), ab.evaluate(1.F), 0.F));      // deterministic
    ab.remove_layer(2);
    CHECK(ab.size() == 2);

    // Different frame rate: the walk resampled at 60 fps samples like the original.
    AnimationClip w60 = walk;
    w60.fps = 60.F;
    w60.locals.clear();
    for (std::size_t f = 0; f < (walk.frames() - 1) * 2 + 1; ++f) {
        const auto p = sample_clip(walk, static_cast<float>(f) / 60.F);
        w60.locals.insert(w60.locals.end(), p.begin(), p.end());
    }
    CHECK(near(w60.duration(), walk.duration()));
    for (float t : {0.F, .51F, 1.73F, 2.9F}) CHECK(same_pose(sample_clip(w60, t), sample_clip(walk, t), 2.e-3F));
    AnimationStack mixed(soma);
    CHECK(mixed.add_layer(layer("w60", w60)).has_value() && mixed.add_layer(layer("w30", walk, BlendMode::Override, .5F)).has_value());
    CHECK(near(mixed.bake().fps, 60.F) && mixed.bake().frames() == w60.frames());
    // Clamp holds the last frame; Loop wraps.
    const float d = walk.duration();
    CHECK(same_pose(sample_clip(walk, d + 1.F), sample_clip(walk, d), 0.F));
    CHECK(same_pose(sample_clip(walk, d + .5F, TimeWrap::Loop), sample_clip(walk, .5F), 1.e-5F));
}

void naming_tests(const Skeleton &soma, const AnimationClip &walk) {
    // A clip with a single named track drives only that joint.
    AnimationClip arm;
    arm.joint_count = 1;
    arm.joint_names = {"LeftArm"};
    arm.locals = {Transform{soma.joints[static_cast<std::size_t>(soma.find("LeftArm"))].rest_local.translation, Quat::from_axis_angle({0, 0, 1}, 1.F)}};
    AnimationStack s(soma);
    CHECK(s.add_layer(layer("base", walk)).has_value() && s.add_layer(layer("arm", arm)).has_value());
    const auto p = s.evaluate(1.F), w = sample_clip(walk, 1.F);
    for (std::size_t j = 0; j < p.size(); ++j) {
        if (soma.joints[j].name == "LeftArm") CHECK(same_rot(p[j].rotation, Quat::from_axis_angle({0, 0, 1}, 1.F)));
        else CHECK(identical(p[j], w[j]));
    }
    AnimationClip stranger = arm;
    stranger.joint_names = {"NoSuchJoint"};
    CHECK(!s.add_layer(layer("x", stranger)).has_value());
    CHECK(!s.add_layer(layer("w", walk, BlendMode::Override, 1.5F)).has_value());
    CHECK(!s.add_layer(layer("empty", AnimationClip{})).has_value());

    // Clip directory round trip keeps names, values and fps.
    const auto dir = std::filesystem::temp_directory_path() / "kimodo_clip_dir_test";
    CHECK(write_clip_dir(dir, walk, soma, R"({"note":"test"})").has_value());
    const auto back = read_clip_dir(dir);
    CHECK(back.has_value());
    if (back) {
        CHECK(back->joint_names == walk.joint_names && back->frames() == walk.frames() && near(back->fps, 30.F));
        bool exact = true;
        for (std::size_t i = 0; i < walk.locals.size(); ++i) exact = exact && identical(back->locals[i], walk.locals[i]);
        CHECK(exact);
    }
    std::filesystem::remove_all(dir);
}
} // namespace

int main(int argc, char **argv) {
    if (argc != 3) {
        std::cerr << "usage: kimodo-anim-layers-test BASELINE_MOTION_DIR RIGS_DIR\n";
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
    basic_tests(soma, walk);
    mask_tests(soma, walk, rig->skeleton);
    enable_mute_tests(soma, walk);
    additive_tests(soma, walk);
    quaternion_edge_tests(soma);
    order_and_time_tests(soma, walk);
    naming_tests(soma, walk);
    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all anim layer checks passed\n";
    return 0;
}
