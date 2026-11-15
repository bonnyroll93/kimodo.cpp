// Kimodo Extended: seamless loops (make_loopable) on a generated walk.
// usage: kimodo-anim-loop-test BASELINE_MOTION_DIR
#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/loop.hpp>

#include <algorithm>
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

// Largest joint rotation between consecutive frames (degrees).
float max_step(const AnimationClip &c) {
    float m = 0.F;
    for (std::size_t f = 1; f < c.frames(); ++f)
        for (std::size_t j = 0; j < c.joint_count; ++j) m = std::max(m, angle_between(c.at(f - 1, j).rotation, c.at(f, j).rotation));
    return m * 57.2958F;
}

void tests(const Skeleton &s, const AnimationClip &walk) {
    const std::size_t n = walk.frames();
    CHECK(n > 40);

    // Blend only: the ends meet, the travel is kept, the middle is untouched.
    AnimationClip a = walk;
    auto r = make_loopable(a, s);
    CHECK(r.has_value());
    if (!r) return;
    const std::size_t T = a.frames() - 1;
    CHECK(a.frames() == n && r->blend == T / 2);
    CHECK(r->seam_degrees_before > 1.F && r->seam_degrees_after < 1.e-2F);
    for (std::size_t j = 0; j < a.joint_count; ++j) CHECK(angle_between(a.at(0, j).rotation, a.at(T, j).rotation) < 1.e-3F);
    const Vec3 t0 = walk.at(T, 0).translation - walk.at(0, 0).translation, t1 = a.at(T, 0).translation - a.at(0, 0).translation;
    CHECK(std::abs(t0.x - t1.x) < 1.e-4F && std::abs(t0.z - t1.z) < 1.e-4F); // horizontal travel kept
    CHECK(std::abs(t1.y) < 1.e-4F);                                          // same height at both ends
    for (std::size_t j = 0; j < a.joint_count; ++j) CHECK(angle_between(a.at(T / 2, j).rotation, walk.at(T / 2, j).rotation) < 1.e-5F);
    // Smooth: no step across the seam (T-1 -> T = 0 -> 1) bigger than the motion's own steps.
    float seam = 0.F;
    for (std::size_t j = 0; j < a.joint_count; ++j) seam = std::max(seam, angle_between(a.at(T - 1, j).rotation, a.at(T, j).rotation) * 57.2958F);
    CHECK(seam <= max_step(walk) * 1.5F + .5F);
    CHECK(max_step(a) <= max_step(walk) * 1.5F + .5F);

    // A short blend window only touches the ends.
    AnimationClip b = walk;
    auto rb = make_loopable(b, s, {.blend = 8});
    CHECK(rb && rb->blend == 8);
    for (std::size_t j = 0; j < b.joint_count; ++j) {
        CHECK(angle_between(b.at(0, j).rotation, b.at(T, j).rotation) < 1.e-3F);
        CHECK(angle_between(b.at(20, j).rotation, walk.at(20, j).rotation) < 1.e-5F);
    }

    // Best cut: a loop at least half the clip long, matching better than the full clip.
    AnimationClip c = walk;
    auto rc = make_loopable(c, s, {.cut = true, .min_length = .5F});
    CHECK(rc.has_value());
    if (rc) {
        CHECK(rc->end > rc->start && rc->end - rc->start >= (n - 1) / 2);
        CHECK(c.frames() == rc->end - rc->start + 1);
        CHECK(rc->seam_degrees_before <= r->seam_degrees_before + 1.e-3F);
        for (std::size_t j = 0; j < c.joint_count; ++j) CHECK(angle_between(c.at(0, j).rotation, c.at(c.frames() - 1, j).rotation) < 1.e-3F);
    }

    // Errors.
    AnimationClip tiny = walk;
    tiny.locals.resize(3 * tiny.joint_count);
    CHECK(!make_loopable(tiny, s).has_value());
    AnimationClip bad = walk;
    CHECK(!make_loopable(bad, s, {.cut = true, .min_length = 0.F}).has_value());
}
} // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::cerr << "usage: kimodo-anim-loop-test BASELINE_MOTION_DIR\n";
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
    std::cout << "all loop checks passed\n";
    return 0;
}
