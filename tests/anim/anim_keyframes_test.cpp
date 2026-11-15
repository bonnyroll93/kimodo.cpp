// Kimodo Extended: keyframe curves and keyframe layers.
// usage: kimodo-anim-keyframes-test BASELINE_MOTION_DIR
#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/keyframes.hpp>
#include <kimodo/anim/layers.hpp>

#include <cmath>
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

bool near(float a, float b, float eps = 1.e-4F) { return std::fabs(a - b) <= eps; }
Keyframe key(float f, float v, KeyInterpolation i = KeyInterpolation::Bezier) {
    Keyframe k;
    k.frame = f;
    k.value = v;
    k.interpolation = i;
    return k;
}

void curve_tests() {
    Curve empty;
    CHECK(empty.evaluate(3.F) == 0.F);
    Curve c;
    c.keys = {key(0, 0, KeyInterpolation::Linear), key(10, 20, KeyInterpolation::Constant), key(20, 5, KeyInterpolation::Bezier), key(30, 5)};
    CHECK(near(c.evaluate(-5.F), 0.F) && near(c.evaluate(99.F), 5.F)); // constant extrapolation
    CHECK(near(c.evaluate(5.F), 10.F));                                   // linear
    CHECK(near(c.evaluate(15.F), 20.F));                                  // constant holds the left key
    for (const auto &k : c.keys) CHECK(near(c.evaluate(k.frame), k.value)); // passes through every key
    // Bezier with auto-clamped tangents never overshoots between keys of a monotonic run.
    Curve m;
    m.keys = {key(0, 0), key(10, 10), key(20, 30), key(30, 30)};
    float prev = -1.F;
    for (float f = 0.F; f <= 30.F; f += .25F) {
        const float v = m.evaluate(f);
        CHECK(v >= prev - 1.e-4F && v >= -1.e-4F && v <= 30.F + 1.e-4F);
        prev = v;
    }
    // Local extremum: flat tangent, no overshoot above the peak.
    Curve peak;
    peak.keys = {key(0, 0), key(10, 10), key(20, 0)};
    for (float f = 0.F; f <= 20.F; f += .25F) CHECK(peak.evaluate(f) <= 10.F + 1.e-4F);
    CHECK(near(peak.handles(1)[1][1], 0.F));
    // Manual handles: an ease-in/out S between 0 and 1 is symmetric around the middle.
    Curve s;
    s.keys = {key(0, 0), key(10, 1)};
    for (auto &k : s.keys) {
        k.auto_tangent = false;
        k.left = {-4.F, 0.F};
        k.right = {4.F, 0.F};
    }
    CHECK(near(s.evaluate(5.F), .5F, 1.e-3F));
    CHECK(s.evaluate(2.F) < .2F && s.evaluate(8.F) > .8F);
    // Handles beyond the segment are clamped (the curve stays a function of time).
    s.keys[0].right = {40.F, 0.F};
    for (float f = 0.F; f <= 10.F; f += .5F) CHECK(std::isfinite(s.evaluate(f)));
}

void json_tests() {
    const char *text = R"({"version":1,"fps":30,"tracks":{"LeftForeArm":{"rx":[{"f":10,"v":30},{"f":0,"v":0,"i":"linear"}],
                         "ty":[{"f":5,"v":0.02,"i":"constant","a":false,"l":[-1,0],"r":[1,0]}]}}})";
    auto t = keyframes_from_json(text);
    CHECK(t.has_value());
    if (!t) return;
    const auto &rx = t->joints.at("LeftForeArm")[RotX];
    CHECK(rx.keys.size() == 2 && rx.keys[0].frame == 0.F); // sorted
    CHECK(near(t->last_frame(), 10.F));
    auto back = keyframes_from_json(keyframes_to_json(*t));
    CHECK(back && back->joints.at("LeftForeArm")[PosY].keys[0].interpolation == KeyInterpolation::Constant);
    CHECK(!keyframes_from_json(R"({"tracks":{"A":{"rx":[{"f":-1,"v":0}]}}})").has_value());
    CHECK(!keyframes_from_json(R"({"tracks":{"A":{"rx":[{"f":0,"v":0,"i":"cubic"}]}}})").has_value());
    CHECK(!keyframes_from_json("{").has_value());
}

void layer_tests(const Skeleton &soma, const AnimationClip &walk) {
    KeyframeTracks t;
    auto &arm = t.joints["LeftForeArm"];
    arm[RotX].keys = {key(0, 0, KeyInterpolation::Linear), key(30, 60, KeyInterpolation::Linear)};
    arm[PosY].keys = {key(0, .05F)};
    t.joints["NoSuchJoint"][RotZ].keys = {key(0, 10)};
    auto kc = keyframe_clip(t, soma);
    CHECK(kc.has_value());
    if (!kc) return;
    CHECK(kc->warnings.size() == 1);
    CHECK(kc->clip.joint_count == 1 && kc->clip.frames() == 31);

    AnimationStack stack(soma);
    CHECK(stack.add_layer({.name = "walk", .clip = walk}).has_value());
    AnimationLayer keys{.name = "keys", .clip = kc->clip, .mode = BlendMode::Additive};
    keys.reference = AdditiveReference::RestPose;
    CHECK(stack.add_layer(keys).has_value());
    const auto fa = static_cast<std::size_t>(soma.find("LeftForeArm"));
    for (const float frame : {0.F, 15.F, 30.F, 60.F}) {
        const float t_sec = frame / 30.F;
        const auto p = stack.evaluate(t_sec);
        const auto w = sample_clip(walk, t_sec);
        const float deg = std::min(frame, 30.F) * 2.F; // 0..60 over 30 frames, held afterwards
        const Quat expected = w[fa].rotation * euler_xyz_degrees(deg, 0.F, 0.F);
        CHECK(angle_between(p[fa].rotation, expected) < 1.e-3F);
        CHECK(near(p[fa].translation.y, w[fa].translation.y + .05F, 1.e-5F));
        for (std::size_t j = 0; j < p.size(); ++j)
            if (j != fa) CHECK(angle_between(p[j].rotation, w[j].rotation) < 1.e-6F);
    }
    // Override keyframes: keyed rotation replaces the walk (rest * offset); the translation of
    // a joint keyed only in rotation, and every unkeyed joint, keep the walk.
    {
        KeyframeTracks ot;
        ot.joints["LeftForeArm"][RotX].keys = {key(0, 40)};
        auto okc = keyframe_clip(ot, soma);
        CHECK(okc.has_value() && okc->channels.at("LeftForeArm") == ChannelRotation);
        AnimationStack os(soma);
        CHECK(os.add_layer({.name = "walk", .clip = walk}).has_value());
        AnimationLayer ok{.name = "keys", .clip = okc->clip, .mode = BlendMode::Override};
        ok.channels = okc->channels;
        CHECK(os.add_layer(ok).has_value());
        const auto p = os.evaluate(.5F), w = sample_clip(walk, .5F);
        const Quat expected = soma.joints[fa].rest_local.rotation * euler_xyz_degrees(40.F, 0.F, 0.F);
        CHECK(angle_between(p[fa].rotation, expected) < 1.e-3F);
        CHECK(near(p[fa].translation.y, w[fa].translation.y, 1.e-6F));
        for (std::size_t j = 0; j < p.size(); ++j)
            if (j != fa) CHECK(angle_between(p[j].rotation, w[j].rotation) < 1.e-6F);
        // Half weight: half way between the walk and the keyed pose.
        os.layer(1).weight = .5F;
        const auto h = os.evaluate(.5F);
        CHECK(std::fabs(angle_between(h[fa].rotation, w[fa].rotation) - angle_between(expected, w[fa].rotation) / 2.F) < 1.e-3F);
    }
    // An empty keyframe layer is valid and changes nothing.
    auto none = keyframe_clip(KeyframeTracks{}, soma);
    CHECK(none.has_value());
    AnimationStack inert(soma);
    AnimationLayer empty{.name = "empty", .clip = none->clip, .mode = BlendMode::Additive};
    empty.reference = AdditiveReference::RestPose;
    CHECK(inert.add_layer({.name = "walk", .clip = walk}).has_value() && inert.add_layer(empty).has_value());
    const auto a = inert.evaluate(1.F), b = sample_clip(walk, 1.F);
    for (std::size_t j = 0; j < a.size(); ++j) CHECK(angle_between(a[j].rotation, b[j].rotation) < 1.e-6F);
    // Euler order XYZ: q = qx * qy * qz.
    const Quat q = euler_xyz_degrees(10.F, 20.F, 30.F);
    const Quat r = Quat::from_axis_angle({1, 0, 0}, 10.F * std::numbers::pi_v<float> / 180.F) *
                   Quat::from_axis_angle({0, 1, 0}, 20.F * std::numbers::pi_v<float> / 180.F) *
                   Quat::from_axis_angle({0, 0, 1}, 30.F * std::numbers::pi_v<float> / 180.F);
    CHECK(angle_between(q, r) < 1.e-6F);
}
} // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::cerr << "usage: kimodo-anim-keyframes-test BASELINE_MOTION_DIR\n";
        return 2;
    }
    auto motion = read_motion_dir(argv[1]);
    if (!motion) {
        std::cerr << motion.error() << '\n';
        return 1;
    }
    const Skeleton soma = native_skeleton("soma30").value();
    curve_tests();
    json_tests();
    layer_tests(soma, clip_from_motion(soma, *motion).value());
    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all anim keyframe checks passed\n";
    return 0;
}
