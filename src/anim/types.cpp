#include <kimodo/anim/types.hpp>

namespace kimodo::anim {

Mat4 to_matrix(const Transform &t) noexcept {
    const Quat q = normalize(t.rotation);
    const float xx = q.x * q.x, yy = q.y * q.y, zz = q.z * q.z;
    const float xy = q.x * q.y, xz = q.x * q.z, yz = q.y * q.z;
    const float wx = q.w * q.x, wy = q.w * q.y, wz = q.w * q.z;
    Mat4 r;
    // Column 0..2 are the rotated, scaled basis vectors.
    r.m[0] = (1.F - 2.F * (yy + zz)) * t.scale.x;
    r.m[1] = (2.F * (xy + wz)) * t.scale.x;
    r.m[2] = (2.F * (xz - wy)) * t.scale.x;
    r.m[3] = 0.F;
    r.m[4] = (2.F * (xy - wz)) * t.scale.y;
    r.m[5] = (1.F - 2.F * (xx + zz)) * t.scale.y;
    r.m[6] = (2.F * (yz + wx)) * t.scale.y;
    r.m[7] = 0.F;
    r.m[8] = (2.F * (xz + wy)) * t.scale.z;
    r.m[9] = (2.F * (yz - wx)) * t.scale.z;
    r.m[10] = (1.F - 2.F * (xx + yy)) * t.scale.z;
    r.m[11] = 0.F;
    r.m[12] = t.translation.x;
    r.m[13] = t.translation.y;
    r.m[14] = t.translation.z;
    r.m[15] = 1.F;
    return r;
}

Transform decompose(const Mat4 &m) noexcept {
    Transform t;
    t.translation = {m.m[12], m.m[13], m.m[14]};
    Vec3 c0{m.m[0], m.m[1], m.m[2]}, c1{m.m[4], m.m[5], m.m[6]}, c2{m.m[8], m.m[9], m.m[10]};
    t.scale = {length(c0), length(c1), length(c2)};
    if (dot(cross(c0, c1), c2) < 0.F) t.scale.x = -t.scale.x;
    if (t.scale.x == 0.F || t.scale.y == 0.F || t.scale.z == 0.F) return t; // degenerate: identity rotation
    c0 = c0 * (1.F / t.scale.x);
    c1 = c1 * (1.F / t.scale.y);
    c2 = c2 * (1.F / t.scale.z);
    // Rotation matrix R[row][col] with columns c0, c1, c2.
    const float r00 = c0.x, r10 = c0.y, r20 = c0.z;
    const float r01 = c1.x, r11 = c1.y, r21 = c1.z;
    const float r02 = c2.x, r12 = c2.y, r22 = c2.z;
    const float trace = r00 + r11 + r22;
    Quat q;
    if (trace > 0.F) {
        const float s = 2.F * std::sqrt(trace + 1.F);
        q = {(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, .25F * s};
    } else if (r00 > r11 && r00 > r22) {
        const float s = 2.F * std::sqrt(1.F + r00 - r11 - r22);
        q = {.25F * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s};
    } else if (r11 > r22) {
        const float s = 2.F * std::sqrt(1.F + r11 - r00 - r22);
        q = {(r01 + r10) / s, .25F * s, (r12 + r21) / s, (r02 - r20) / s};
    } else {
        const float s = 2.F * std::sqrt(1.F + r22 - r00 - r11);
        q = {(r02 + r20) / s, (r12 + r21) / s, .25F * s, (r10 - r01) / s};
    }
    t.rotation = normalize(q);
    return t;
}

} // namespace kimodo::anim
