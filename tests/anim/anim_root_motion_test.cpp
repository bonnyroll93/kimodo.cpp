// Kimodo Extended step 2: clip conversion, Full / InPlace root motion and MotionPath.
// usage: kimodo-anim-root-motion-test BASELINE_MOTION_DIR
//   (tests/data/baseline/soma30-walk-s42: a real generated soma30 walk, 90 frames)
#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/motion_path.hpp>
#include <kimodo/anim/root_motion.hpp>

#include <cmath>
#include <cstring>
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
bool bit_equal(const std::vector<float> &a, const std::vector<float> &b) {
    return a.size() == b.size() && std::memcmp(a.data(), b.data(), a.size() * sizeof(float)) == 0;
}
bool same_clip(const AnimationClip &a, const AnimationClip &b) {
    const MotionArrays x = clip_to_motion(a), y = clip_to_motion(b);
    return bit_equal(x.root_positions, y.root_positions) && bit_equal(x.rotations_xyzw, y.rotations_xyzw);
}
float horizontal_travel(const AnimationClip &c, const AxisConvention &axes = {}) {
    return length(axes.horizontal(c.at(c.frames() - 1, 0).translation - c.at(0, 0).translation));
}

// Synthetic soma30 clip: root moves +2 m along X over 61 frames at height 0.9 with a bob,
// facing +Z (identity rotations).
AnimationClip synthetic(const Skeleton &soma, std::size_t frames = 61) {
    MotionArrays m;
    m.frames = frames;
    m.joints = soma.size();
    for (std::size_t f = 0; f < frames; ++f) {
        const float u = static_cast<float>(f) / static_cast<float>(frames - 1);
        m.root_positions.insert(m.root_positions.end(), {2.F * u, .9F + .02F * std::sin(u * 12.F), .1F});
        for (std::size_t j = 0; j < m.joints; ++j) m.rotations_xyzw.insert(m.rotations_xyzw.end(), {0, 0, 0, 1});
    }
    return clip_from_motion(soma, m).value();
}

void clip_tests(const MotionArrays &walk, const Skeleton &soma) {
    auto clip = clip_from_motion(soma, walk);
    CHECK(clip.has_value());
    if (!clip) return;
    CHECK(clip->frames() == 90);
    CHECK(near(clip->duration(), 89.F / 30.F));
    // Round trip is bit-exact (no normalisation anywhere).
    const MotionArrays back = clip_to_motion(*clip);
    CHECK(bit_equal(back.root_positions, walk.root_positions));
    CHECK(bit_equal(back.rotations_xyzw, walk.rotations_xyzw));
    // Non-root translations are the rest offsets.
    CHECK(near(clip->at(10, 5).translation, soma.joints[5].rest_local.translation, 0.F));
    // Mismatched skeleton / arrays are diagnosed.
    CHECK(!clip_from_motion(native_skeleton("smplx22").value(), walk).has_value());
    MotionArrays broken = walk;
    broken.root_positions.pop_back();
    CHECK(!clip_from_motion(soma, broken).has_value());
}

void full_and_in_place_tests(const MotionArrays &walk, const Skeleton &soma) {
    const AnimationClip original = clip_from_motion(soma, walk).value();
    CHECK(horizontal_travel(original) > .5F); // the baseline really walks

    // Full: bit-identical to the original path.
    AnimationClip full = original;
    CHECK(apply_root_motion(full, {}).has_value());
    CHECK(same_clip(full, original));

    // InPlace: no horizontal drift on any frame, height and all rotations untouched.
    RootMotionSettings in_place;
    in_place.mode = RootMotionMode::InPlace;
    AnimationClip ip = original;
    CHECK(apply_root_motion(ip, in_place).has_value());
    const Vec3 start = original.at(0, 0).translation;
    float max_drift = 0.F;
    for (std::size_t f = 0; f < ip.frames(); ++f) {
        const Vec3 t = ip.at(f, 0).translation;
        max_drift = std::max(max_drift, length(AxisConvention{}.horizontal(t))); // on the origin
        CHECK(t.y == original.at(f, 0).translation.y);
        for (std::size_t j = 0; j < ip.joint_count; ++j) {
            const Quat a = ip.at(f, j).rotation, b = original.at(f, j).rotation;
            CHECK(a.x == b.x && a.y == b.y && a.z == b.z && a.w == b.w);
        }
    }
    CHECK(max_drift < 1.e-5F);
    CHECK(ip.at(0, 0).translation.x == 0.F && ip.at(0, 0).translation.z == 0.F); // at the origin
    // at_origin = false: it stays where it starts.
    RootMotionSettings keep = in_place;
    keep.in_place.at_origin = false;
    AnimationClip kp = original;
    CHECK(apply_root_motion(kp, keep).has_value());
    for (std::size_t f = 0; f < kp.frames(); ++f) CHECK(length(AxisConvention{}.horizontal(kp.at(f, 0).translation - start)) < 1.e-5F);

    // Deterministic.
    AnimationClip ip2 = original;
    CHECK(apply_root_motion(ip2, in_place).has_value());
    CHECK(same_clip(ip, ip2));

    // Only the configured axes are removed.
    AnimationClip forward_only = synthetic(soma);
    in_place.in_place = {.lock_forward = true, .lock_lateral = false}; // forward = +Z, travel is along +X
    CHECK(apply_root_motion(forward_only, in_place).has_value());
    CHECK(near(horizontal_travel(forward_only), 2.F));
    AnimationClip lateral_only = synthetic(soma);
    in_place.in_place = {.lock_forward = false, .lock_lateral = true};
    CHECK(apply_root_motion(lateral_only, in_place).has_value());
    CHECK(horizontal_travel(lateral_only) < 1.e-5F);

    // Z-up convention: "height" is Z, so X and Y are removed and Z is preserved.
    AnimationClip zup = synthetic(soma);
    RootMotionSettings zs;
    zs.mode = RootMotionMode::InPlace;
    zs.axes = {.up = {0, 0, 1}, .forward = {0, 1, 0}};
    CHECK(apply_root_motion(zup, zs).has_value());
    for (std::size_t f = 0; f < zup.frames(); ++f) {
        CHECK(near(zup.at(f, 0).translation.x, 0.F, 1.e-6F));
        CHECK(near(zup.at(f, 0).translation.y, 0.F, 1.e-6F)); // on the origin (Y is horizontal here)
        CHECK(zup.at(f, 0).translation.z == .1F);
    }

    // Invalid axes are rejected.
    zs.axes = {.up = {0, 1, 0}, .forward = {0, 1, 0}};
    CHECK(!validate(zs).has_value());
    zs.axes = {.up = {0, 2, 0}, .forward = {0, 0, 1}};
    CHECK(!validate(zs).has_value());
}

void exclusivity_tests() {
    RootMotionSettings s;
    s.path = MotionPathSpec{{{0, 0, 0}, {1, 0, 0}}};
    s.mode = RootMotionMode::InPlace;
    CHECK(!validate(s).has_value()); // InPlace + path: mutually exclusive
    s.mode = RootMotionMode::Full;
    CHECK(!validate(s).has_value());
    s.path_preview_only = true; // explicit preview mode: allowed, path only displayed
    CHECK(validate(s).has_value());
    s.mode = RootMotionMode::InPlace;
    CHECK(validate(s).has_value());
    s.mode = RootMotionMode::CustomPath;
    CHECK(validate(s).has_value());
    s.path.reset();
    CHECK(!validate(s).has_value()); // CustomPath without a path
}

void path_geometry_tests() {
    // Polyline: exact length, waypoint distances, positions between waypoints.
    auto poly = MotionPath::build({{{0, 0, 0}, {3, 0, 0}, {3, 0, 4}}, PathInterpolation::Polyline}).value();
    CHECK(near(poly.length(), 7.F));
    CHECK(near(poly.waypoint_distance(1), 3.F));
    CHECK(near(poly.position(1.5F), {1.5F, 0, 0}));
    CHECK(near(poly.position(5.F), {3, 0, 2}));
    CHECK(near(poly.position(-1.F), {0, 0, 0}));    // clamped before start
    CHECK(near(poly.position(100.F), {3, 0, 4}));   // clamped after end
    CHECK(near(poly.tangent(1.F), {1, 0, 0}));
    CHECK(near(poly.tangent(6.F), {0, 0, 1}));
    CHECK(near(poly.tangent(7.F), {0, 0, 1}));      // end keeps the last direction

    // Waypoint height is ignored (ground plane).
    auto raised = MotionPath::build({{{0, 5, 0}, {1, -3, 0}}, PathInterpolation::Polyline}).value();
    CHECK(near(raised.position(.5F), {.5F, 0, 0}));

    // Catmull-Rom passes through every waypoint, in order.
    const std::vector<Vec3> pts{{0, 0, 0}, {2, 0, 1}, {4, 0, -1}, {6, 0, 0}};
    auto cr = MotionPath::build({pts, PathInterpolation::CatmullRom}).value();
    float prev = -1.F;
    for (std::size_t i = 0; i < pts.size(); ++i) {
        CHECK(near(cr.position(cr.waypoint_distance(i)), pts[i], 1.e-3F));
        CHECK(cr.waypoint_distance(i) > prev);
        prev = cr.waypoint_distance(i);
    }
    CHECK(cr.length() > 6.F);
    for (float s = 0.F; s <= cr.length(); s += .05F) CHECK(near(length(cr.tangent(s)), 1.F, 1.e-4F));

    // Loop: wraps and closes back to the start.
    auto loop = MotionPath::build({{{0, 0, 0}, {2, 0, 0}, {2, 0, 2}, {0, 0, 2}}, PathInterpolation::Polyline, true}).value();
    CHECK(near(loop.length(), 8.F));
    CHECK(near(loop.position(9.F), {1, 0, 0}));
    CHECK(near(loop.position(-1.F), {0, 0, 1}));
    CHECK(near(loop.sample(5).back(), {0, 0, 0}));

    // Degenerate inputs: empty, one point, coincident points.
    CHECK(!MotionPath::build({}).has_value());
    CHECK(!MotionPath::build({{{0, 0, 0}, {NAN, 0, 0}}}).has_value());
    auto single = MotionPath::build({{{1, 0, 2}}}).value();
    CHECK(single.length() == 0.F);
    CHECK(near(single.position(3.F), {1, 0, 2}));
    CHECK(length(single.tangent(0.F)) == 0.F);
    auto same = MotionPath::build({{{1, 0, 1}, {1, 0, 1}, {1, 0, 1}}}).value();
    CHECK(same.waypoints() == 1 && same.length() == 0.F);
    auto dup = MotionPath::build({{{0, 0, 0}, {0, 0, 0}, {1, 0, 0}, {1, 0, 0}, {2, 0, 0}}}).value();
    CHECK(dup.waypoints() == 3);
    CHECK(near(dup.length(), 2.F, 1.e-3F));
    for (float s = 0.F; s <= 2.F; s += .1F) CHECK(finite(dup.position(s)) && finite(dup.tangent(s)));
}

void follow_tests(const MotionArrays &walk, const Skeleton &soma) {
    const AxisConvention axes;
    const AnimationClip original = clip_from_motion(soma, walk).value();

    // MotionDistance (default): root travels the same distance as the generated walk.
    RootMotionSettings s;
    s.mode = RootMotionMode::CustomPath;
    s.path = MotionPathSpec{{{0, 0, 0}, {10, 0, 0}}, PathInterpolation::Polyline};
    AnimationClip c = original;
    CHECK(apply_root_motion(c, s).has_value());
    float walked = 0.F;
    for (std::size_t f = 1; f < original.frames(); ++f)
        walked += length(axes.horizontal(original.at(f, 0).translation - original.at(f - 1, 0).translation));
    CHECK(near(c.at(c.frames() - 1, 0).translation.x, walked, 1.e-3F));
    for (std::size_t f = 0; f < c.frames(); ++f) {
        CHECK(near(c.at(f, 0).translation.z, 0.F, 1.e-5F));
        CHECK(c.at(f, 0).translation.y == original.at(f, 0).translation.y); // height kept
        for (std::size_t j = 1; j < c.joint_count; ++j) {                  // non-root rotations kept
            const Quat a = c.at(f, j).rotation, b = original.at(f, j).rotation;
            CHECK(a.x == b.x && a.y == b.y && a.z == b.z && a.w == b.w);
        }
    }
    // orient_to_path: frame 0 facing now points along +X (the tangent).
    const Vec3 facing0 = axes.horizontal(rotate(c.at(0, 0).rotation, axes.forward));
    CHECK(near(normalize(facing0), {1, 0, 0}, 1.e-3F));
    // Facing change relative to frame 0 is preserved (yaw offset is constant on a straight path).
    for (std::size_t f = 0; f < c.frames(); ++f) {
        const float before = axes.heading(rotate(original.at(f, 0).rotation, axes.forward)) -
                             axes.heading(rotate(original.at(0, 0).rotation, axes.forward));
        const float after = axes.heading(rotate(c.at(f, 0).rotation, axes.forward)) -
                            axes.heading(rotate(c.at(0, 0).rotation, axes.forward));
        CHECK(near(std::remainder(after - before, 2.F * pi), 0.F, 1.e-3F));
    }

    // Duration timing: the whole path is covered in the given time, waypoints in order.
    AnimationClip syn = synthetic(soma, 61); // 2 s at 30 fps
    s.path = MotionPathSpec{{{0, 0, 0}, {4, 0, 0}, {4, 0, 4}}, PathInterpolation::Polyline};
    s.follow = {.timing = PathTiming::Duration, .duration = 2.F};
    CHECK(apply_root_motion(syn, s).has_value());
    CHECK(near(syn.at(0, 0).translation, {0, .9F, 0}, 1.e-5F));
    CHECK(near(syn.at(30, 0).translation, {4, syn.at(30, 0).translation.y, 0}, 1.e-3F));  // corner at 1 s
    CHECK(near(syn.at(60, 0).translation, {4, syn.at(60, 0).translation.y, 4}, 1.e-3F));  // end at 2 s
    // Tangent determines orientation: after the corner the root faces +Z.
    CHECK(near(normalize(axes.horizontal(rotate(syn.at(45, 0).rotation, axes.forward))), {0, 0, 1}, 1.e-3F));
    CHECK(near(normalize(axes.horizontal(rotate(syn.at(15, 0).rotation, axes.forward))), {1, 0, 0}, 1.e-3F));

    // Shorter duration: holds at the end. Speed timing: constant metres per second.
    AnimationClip fast = synthetic(soma, 61);
    s.follow = {.timing = PathTiming::Duration, .duration = 1.F};
    CHECK(apply_root_motion(fast, s).has_value());
    CHECK(near(fast.at(45, 0).translation.z, 4.F, 1.e-3F));
    AnimationClip speed = synthetic(soma, 61);
    s.follow = {.timing = PathTiming::Speed, .speed = 1.5F};
    CHECK(apply_root_motion(speed, s).has_value());
    CHECK(near(speed.at(60, 0).translation.x, 3.F, 1.e-3F));

    // Loop + speed beyond the length wraps around.
    AnimationClip looped = synthetic(soma, 61);
    s.path = MotionPathSpec{{{0, 0, 0}, {1, 0, 0}, {1, 0, 1}, {0, 0, 1}}, PathInterpolation::Polyline, true};
    s.follow = {.timing = PathTiming::Speed, .speed = 2.5F}; // 5 m in 2 s on a 4 m loop
    CHECK(apply_root_motion(looped, s).has_value());
    CHECK(near(looped.at(60, 0).translation, {1, looped.at(60, 0).translation.y, 0}, 1.e-3F));

    // No orientation: rotations bit-identical.
    AnimationClip plain = synthetic(soma, 61);
    const AnimationClip plain_ref = plain;
    s.follow = {.timing = PathTiming::Duration, .orient_to_path = false};
    CHECK(apply_root_motion(plain, s).has_value());
    CHECK(plain.at(30, 0).rotation.w == plain_ref.at(30, 0).rotation.w);

    // Single point: root parked there, facing unchanged, no NaN.
    AnimationClip parked = clip_from_motion(soma, walk).value();
    s.path = MotionPathSpec{{{5, 0, 5}}};
    s.follow = {};
    CHECK(apply_root_motion(parked, s).has_value());
    for (std::size_t f = 0; f < parked.frames(); ++f) {
        CHECK(near(axes.horizontal(parked.at(f, 0).translation), {5, 0, 5}, 1.e-5F));
        CHECK(parked.at(f, 0).rotation.w == original.at(f, 0).rotation.w);
    }

    // In-place input with MotionDistance falls back to Duration instead of standing still.
    AnimationClip ip = clip_from_motion(soma, walk).value();
    CHECK(make_in_place(ip).has_value());
    s.path = MotionPathSpec{{{0, 0, 0}, {3, 0, 0}}, PathInterpolation::Polyline};
    CHECK(apply_root_motion(ip, s).has_value());
    CHECK(near(ip.at(ip.frames() - 1, 0).translation.x, 3.F, 1.e-3F));

    CHECK(!follow_path(syn, MotionPath::build({{{0, 0, 0}, {1, 0, 0}}}).value(), axes, {.speed = -1.F}).has_value());
}
} // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::cerr << "usage: kimodo-anim-root-motion-test BASELINE_MOTION_DIR\n";
        return 2;
    }
    auto walk = read_motion_dir(argv[1]);
    if (!walk) {
        std::cerr << walk.error() << '\n';
        return 1;
    }
    const Skeleton soma = native_skeleton_for_joint_count(walk->joints).value();
    clip_tests(*walk, soma);
    full_and_in_place_tests(*walk, soma);
    exclusivity_tests();
    path_geometry_tests();
    follow_tests(*walk, soma);
    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all anim root motion checks passed\n";
    return 0;
}
