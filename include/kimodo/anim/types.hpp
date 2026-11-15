#pragma once
// Minimal math primitives for the Kimodo Extended motion runtime.
//
// Conventions (shared by every kimodo::anim module and matching kimodo::motion_data):
//   * right-handed, Y-up, metres (the glTF and Kimodo native convention);
//   * quaternions are Hamilton, stored x, y, z, w, and rotate vectors actively (q * v * q^-1);
//   * a joint's local Transform maps points from the joint's space into its parent's space,
//     applied as scale, then rotation, then translation.
// Coordinate conversions happen once, at import; nothing downstream converts axes again.

#include <cmath>

namespace kimodo::anim {

struct Vec3 {
    float x = 0.F, y = 0.F, z = 0.F;
};

[[nodiscard]] constexpr Vec3 operator+(Vec3 a, Vec3 b) noexcept { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
[[nodiscard]] constexpr Vec3 operator-(Vec3 a, Vec3 b) noexcept { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
[[nodiscard]] constexpr Vec3 operator-(Vec3 a) noexcept { return {-a.x, -a.y, -a.z}; }
[[nodiscard]] constexpr Vec3 operator*(Vec3 a, float s) noexcept { return {a.x * s, a.y * s, a.z * s}; }
[[nodiscard]] constexpr Vec3 operator*(float s, Vec3 a) noexcept { return a * s; }
[[nodiscard]] constexpr Vec3 mul(Vec3 a, Vec3 b) noexcept { return {a.x * b.x, a.y * b.y, a.z * b.z}; }
[[nodiscard]] constexpr float dot(Vec3 a, Vec3 b) noexcept { return a.x * b.x + a.y * b.y + a.z * b.z; }
[[nodiscard]] constexpr Vec3 cross(Vec3 a, Vec3 b) noexcept {
    return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
[[nodiscard]] inline float length(Vec3 a) noexcept { return std::sqrt(dot(a, a)); }
[[nodiscard]] inline Vec3 normalize(Vec3 a, Vec3 fallback = {}) noexcept {
    const float n = length(a);
    return n > 1.e-12F ? a * (1.F / n) : fallback;
}
[[nodiscard]] constexpr Vec3 lerp(Vec3 a, Vec3 b, float t) noexcept { return a + (b - a) * t; }

struct Quat {
    float x = 0.F, y = 0.F, z = 0.F, w = 1.F;

    [[nodiscard]] static constexpr Quat identity() noexcept { return {}; }
    [[nodiscard]] static Quat from_axis_angle(Vec3 axis, float radians) noexcept {
        const Vec3 a = normalize(axis, {0.F, 1.F, 0.F});
        const float s = std::sin(radians * .5F);
        return {a.x * s, a.y * s, a.z * s, std::cos(radians * .5F)};
    }
};

[[nodiscard]] constexpr Quat operator*(Quat a, Quat b) noexcept {
    return {a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
            a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z};
}
[[nodiscard]] constexpr Quat conjugate(Quat q) noexcept { return {-q.x, -q.y, -q.z, q.w}; }
[[nodiscard]] constexpr float dot(Quat a, Quat b) noexcept { return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w; }
[[nodiscard]] inline Quat normalize(Quat q) noexcept {
    const float n = std::sqrt(dot(q, q));
    return n > 1.e-12F ? Quat{q.x / n, q.y / n, q.z / n, q.w / n} : Quat{};
}
// Inverse of a unit quaternion.
[[nodiscard]] constexpr Quat inverse(Quat q) noexcept { return conjugate(q); }
[[nodiscard]] constexpr Vec3 rotate(Quat q, Vec3 v) noexcept {
    // v + 2w(u x v) + 2u x (u x v), with u the vector part.
    const Vec3 u{q.x, q.y, q.z};
    const Vec3 t = cross(u, v) * 2.F;
    return v + t * q.w + cross(u, t);
}
// Shortest-arc spherical interpolation; falls back to normalised lerp for nearly equal inputs.
[[nodiscard]] inline Quat slerp(Quat a, Quat b, float t) noexcept {
    float c = dot(a, b);
    if (c < 0.F) { b = {-b.x, -b.y, -b.z, -b.w}; c = -c; }
    if (c > .9995F)
        return normalize(Quat{a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, a.w + (b.w - a.w) * t});
    const float theta = std::acos(c);
    const float s = std::sin(theta);
    const float wa = std::sin((1.F - t) * theta) / s, wb = std::sin(t * theta) / s;
    return {a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb, a.w * wa + b.w * wb};
}
// Shortest-arc rotation taking direction a onto direction b (identity if either is ~zero).
[[nodiscard]] inline Quat from_to(Vec3 a, Vec3 b) noexcept {
    a = normalize(a);
    b = normalize(b);
    if (dot(a, a) == 0.F || dot(b, b) == 0.F) return {};
    const float c = dot(a, b);
    if (c < -.999999F) { // opposite: rotate pi about any axis perpendicular to a
        Vec3 axis = cross({1.F, 0.F, 0.F}, a);
        if (dot(axis, axis) < 1.e-6F) axis = cross({0.F, 1.F, 0.F}, a);
        return Quat::from_axis_angle(axis, 3.14159265358979F);
    }
    const Vec3 v = cross(a, b);
    return normalize(Quat{v.x, v.y, v.z, 1.F + c});
}
// Angle in radians between two orientations (0..pi), sign-independent.
[[nodiscard]] inline float angle_between(Quat a, Quat b) noexcept {
    const float c = std::fabs(dot(normalize(a), normalize(b)));
    return 2.F * std::acos(c > 1.F ? 1.F : c);
}

struct Transform {
    Vec3 translation{};
    Quat rotation{};
    Vec3 scale{1.F, 1.F, 1.F};

    [[nodiscard]] constexpr Vec3 apply(Vec3 p) const noexcept { return translation + rotate(rotation, mul(scale, p)); }
};

// parent * child: the child's transform expressed in the parent's parent space.
// Exact for uniform scale; for non-uniform scale the result keeps TRS form (no shear),
// which matches how glTF viewers propagate node scale in practice.
[[nodiscard]] constexpr Transform operator*(const Transform &parent, const Transform &child) noexcept {
    return {parent.apply(child.translation), parent.rotation * child.rotation, mul(parent.scale, child.scale)};
}
[[nodiscard]] inline Transform inverse(const Transform &t) noexcept {
    const Vec3 inv_s{t.scale.x != 0.F ? 1.F / t.scale.x : 0.F, t.scale.y != 0.F ? 1.F / t.scale.y : 0.F,
                     t.scale.z != 0.F ? 1.F / t.scale.z : 0.F};
    const Quat inv_r = inverse(t.rotation);
    return {mul(inv_s, rotate(inv_r, -t.translation)), inv_r, inv_s};
}

// Which directions mean "up" and "forward" for a motion. Kimodo and glTF: Y up, +Z forward.
// Both must be unit length and perpendicular; lateral() completes the basis.
struct AxisConvention {
    Vec3 up{0.F, 1.F, 0.F};
    Vec3 forward{0.F, 0.F, 1.F};

    [[nodiscard]] constexpr Vec3 lateral() const noexcept { return cross(up, forward); }
    // Component of v perpendicular to up (projection onto the ground plane through the origin).
    [[nodiscard]] constexpr Vec3 horizontal(Vec3 v) const noexcept { return v - up * dot(v, up); }
    // Signed angle (radians) about up from `forward` to the horizontal part of `direction`.
    [[nodiscard]] inline float heading(Vec3 direction) const noexcept {
        const Vec3 h = horizontal(direction);
        return std::atan2(dot(cross(forward, h), up), dot(forward, h));
    }
};

// Column-major 4x4 matrix (glTF layout): m[column * 4 + row].
struct Mat4 {
    float m[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
};

[[nodiscard]] Mat4 to_matrix(const Transform &t) noexcept;
// Decomposes an affine matrix into TRS. A negative determinant is folded into scale.x.
[[nodiscard]] Transform decompose(const Mat4 &m) noexcept;

} // namespace kimodo::anim
