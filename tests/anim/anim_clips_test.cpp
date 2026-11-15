// Kimodo Extended: clip timing on layers (start, trim, speed, repeat, extend, fades, root alignment).
// usage: kimodo-anim-clips-test BASELINE_MOTION_DIR
#include <kimodo/anim/clip.hpp>
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

bool near(float a, float b, float eps = 1.e-4F) { return std::fabs(a - b) <= eps; }
bool near(Vec3 a, Vec3 b, float eps = 1.e-4F) { return length(a - b) <= eps; }
bool same(const std::vector<Transform> &a, const std::vector<Transform> &b, float eps = 1.e-4F) {
    for (std::size_t j = 0; j < a.size(); ++j)
        if (angle_between(a[j].rotation, b[j].rotation) > eps * 10.F || length(a[j].translation - b[j].translation) > eps) return false;
    return true;
}
std::vector<Transform> rest(const Skeleton &s) {
    std::vector<Transform> r;
    for (const Joint &j : s.joints) r.push_back(j.rest_local);
    return r;
}
AnimationStack single(const Skeleton &s, AnimationLayer l) {
    AnimationStack st(s);
    if (!st.add_layer(std::move(l))) ++failures;
    return st;
}

void timing_tests(const Skeleton &soma, const AnimationClip &walk) {
    const float D = walk.duration(); // ~2.967 s
    // Start offset with Extend::None: nothing before the start, the clip shifted afterwards.
    AnimationLayer late{.name = "late", .clip = walk};
    late.timing.start = 1.F;
    late.timing.extend = Extend::None;
    auto st = single(soma, late);
    CHECK(near(st.duration(), 1.F + D));
    CHECK(same(st.evaluate(.5F), rest(soma)));
    CHECK(same(st.evaluate(1.7F), sample_clip(walk, .7F)));
    // Extend::Hold (default): the first frame is held before the start ...
    late.timing.extend = Extend::Hold;
    CHECK(same(single(soma, late).evaluate(.5F), sample_clip(walk, 0.F)));
    // ... unless empty_before: then nothing before the start, the end is still held.
    late.timing.empty_before = true;
    CHECK(same(single(soma, late).evaluate(.5F), rest(soma)));
    CHECK(same(single(soma, late).evaluate(9.F), sample_clip(walk, D)));
    late.timing.empty_before = false;
    // end: nothing after it, the stack ends there, and fade_out ends there.
    {
        AnimationLayer bounded{.name = "bounded", .clip = walk};
        bounded.timing.start = .5F;
        bounded.timing.end = 1.5F;
        bounded.timing.fade_out = .5F;
        auto sb = single(soma, bounded);
        CHECK(near(sb.duration(), 1.5F));
        CHECK(same(sb.evaluate(.9F), sample_clip(walk, .4F)));
        CHECK(same(sb.evaluate(1.6F), rest(soma)));
    }

    // Scene length override: shorter cuts, longer holds the end (Extend::Hold).
    {
        auto s1 = single(soma, AnimationLayer{.name = "len", .clip = walk});
        CHECK(s1.bake(30.F, 1.F).frames() == 31);
        const auto longer = s1.bake(30.F, D + 1.F);
        CHECK(longer.frames() == static_cast<std::size_t>(std::lround((D + 1.F) * 30.F)) + 1);
        CHECK(same(s1.evaluate(D + .9F), sample_clip(walk, D)));
    }

    // Trim.
    AnimationLayer trimmed{.name = "trim", .clip = walk};
    trimmed.timing.trim_in = .5F;
    trimmed.timing.trim_out = 1.5F;
    st = single(soma, trimmed);
    CHECK(near(st.duration(), 1.F));
    CHECK(same(st.evaluate(0.F), sample_clip(walk, .5F)));
    CHECK(same(st.evaluate(.6F), sample_clip(walk, 1.1F)));
    CHECK(same(st.evaluate(5.F), sample_clip(walk, 1.5F))); // held end

    // Speed: 2x plays the walk in half the time; 0.5x stretches it.
    AnimationLayer fast{.name = "fast", .clip = walk};
    fast.timing.speed = 2.F;
    st = single(soma, fast);
    CHECK(near(st.duration(), D / 2.F));
    CHECK(same(st.evaluate(.4F), sample_clip(walk, .8F)));
    fast.timing.speed = .5F;
    st = single(soma, fast);
    CHECK(near(st.duration(), D * 2.F));
    CHECK(same(st.evaluate(2.F), sample_clip(walk, 1.F)));
    CHECK(near(static_cast<float>(st.bake().frames()), std::round(D * 2.F * 30.F) + 1.F));

    // Repeat with root continuation: cycle k = the segment + k * its root travel.
    AnimationLayer cycles{.name = "cycles", .clip = walk};
    cycles.timing.repeat = 3;
    st = single(soma, cycles);
    CHECK(near(st.duration(), 3.F * D));
    const Vec3 travel = sample_clip(walk, D)[0].translation - sample_clip(walk, 0.F)[0].translation;
    for (const float x : {.3F, 1.4F}) {
        const auto p = st.evaluate(D + x), w = sample_clip(walk, x);
        CHECK(near(p[0].translation, w[0].translation + Vec3{travel.x, 0.F, travel.z}));
        CHECK(near(p[0].translation.y, w[0].translation.y));
        for (std::size_t j = 1; j < p.size(); ++j) CHECK(angle_between(p[j].rotation, w[j].rotation) < 1.e-5F);
    }
    const auto third = st.evaluate(2.F * D + .5F);
    CHECK(near(third[0].translation, sample_clip(walk, .5F)[0].translation + Vec3{2.F * travel.x, 0.F, 2.F * travel.z}));

    // Fades: half way through a fade-in the layer has half its weight.
    AnimationLayer base{.name = "base", .clip = walk};
    AnimationLayer other{.name = "other", .clip = walk};
    for (std::size_t f = 0; f < other.clip.frames(); ++f)
        for (std::size_t j = 1; j < other.clip.joint_count; ++j)
            other.clip.at(f, j).rotation = normalize(Quat::from_axis_angle({1, 0, 0}, .6F) * other.clip.at(f, j).rotation);
    other.timing.fade_in = 1.F;
    AnimationStack faded(soma);
    CHECK(faded.add_layer(base).has_value() && faded.add_layer(other).has_value());
    const auto pf = faded.evaluate(.5F), pb = sample_clip(walk, .5F), po = sample_clip(other.clip, .5F);
    const std::size_t la = static_cast<std::size_t>(soma.find("LeftArm"));
    CHECK(near(angle_between(pf[la].rotation, pb[la].rotation), angle_between(po[la].rotation, pb[la].rotation) / 2.F, 1.e-3F));
    CHECK(same(faded.evaluate(1.5F), sample_clip(other.clip, 1.5F)));
    // Eased fades: smoothstep, so a quarter of the way in the weight is 0.15625 (linear: 0.25).
    AnimationLayer eased = other;
    eased.timing.ease_fades = true;
    AnimationStack se(soma);
    CHECK(se.add_layer(base).has_value() && se.add_layer(eased).has_value());
    const auto pe = se.evaluate(.25F), pb2 = sample_clip(walk, .25F), po2 = sample_clip(other.clip, .25F);
    CHECK(near(angle_between(pe[la].rotation, pb2[la].rotation), angle_between(po2[la].rotation, pb2[la].rotation) * .15625F, 2.e-3F));

    // Split at 1.5 s into two clips (Extend::None) reproduces the original.
    AnimationLayer a{.name = "a", .clip = walk}, b{.name = "b", .clip = walk};
    a.timing.trim_out = 1.5F;
    a.timing.extend = Extend::None;
    b.timing.trim_in = 1.5F;
    b.timing.start = 1.5F;
    b.timing.extend = Extend::None;
    AnimationStack split(soma);
    CHECK(split.add_layer(a).has_value() && split.add_layer(b).has_value());
    CHECK(near(split.duration(), D));
    for (const float t : {.2F, 1.2F, 1.8F, 2.9F}) CHECK(same(split.evaluate(t), sample_clip(walk, t)));

    // Sequencing with root alignment: the second walk starts where the first one ended.
    AnimationLayer first{.name = "first", .clip = walk};
    first.timing.extend = Extend::None;
    AnimationLayer second{.name = "second", .clip = walk};
    second.timing.start = D;
    second.timing.align_root = true;
    AnimationStack seq(soma);
    CHECK(seq.add_layer(first).has_value() && seq.add_layer(second).has_value());
    const auto end_first = sample_clip(walk, D);
    const auto at_join = seq.evaluate(D + 1.e-4F);
    CHECK(near(Vec3{at_join[0].translation.x, 0, at_join[0].translation.z}, Vec3{end_first[0].translation.x, 0, end_first[0].translation.z}, 2.e-3F));
    const AxisConvention axes;
    CHECK(near(axes.heading(rotate(at_join[0].rotation, axes.forward)), axes.heading(rotate(end_first[0].rotation, axes.forward)), 1.e-3F));
    const auto later = seq.evaluate(2.F * D);
    CHECK(later[0].translation.z > end_first[0].translation.z + 2.F); // keeps walking forward

    // Validation.
    AnimationStack bad(soma);
    AnimationLayer z{.name = "z", .clip = walk};
    z.timing.speed = 0.F;
    CHECK(!bad.add_layer(z).has_value());
    z.timing.speed = 1.F;
    z.timing.repeat = 0;
    CHECK(!bad.add_layer(z).has_value());
    z.timing.repeat = 1;
    z.timing.trim_in = -1.F;
    CHECK(!bad.add_layer(z).has_value());
}
} // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::cerr << "usage: kimodo-anim-clips-test BASELINE_MOTION_DIR\n";
        return 2;
    }
    auto motion = read_motion_dir(argv[1]);
    if (!motion) {
        std::cerr << motion.error() << '\n';
        return 1;
    }
    const Skeleton soma = native_skeleton("soma30").value();
    timing_tests(soma, clip_from_motion(soma, *motion).value());
    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all anim clip timing checks passed\n";
    return 0;
}
