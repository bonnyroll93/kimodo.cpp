#include <kimodo/anim/control_rig.hpp>
#include <kimodo/anim/ik.hpp>
#include <kimodo/anim/layers.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <fstream>
#include <optional>
#include <span>
#include <sstream>

namespace kimodo::anim {
namespace {

using Channels = std::array<Curve, ChannelCount>;

bool keyed(const Curve &c) { return !c.keys.empty(); }
bool any_keyed(const Channels &c) {
    for (const Curve &x : c) if (keyed(x)) return true;
    return false;
}
bool group_keyed(const Channels &c, int from) { return keyed(c[from]) || keyed(c[from + 1]) || keyed(c[from + 2]); }
bool pole_keyed(const std::array<Curve, 3> &p) { return keyed(p[0]) || keyed(p[1]) || keyed(p[2]); }
float at(const Curve &c, float f) { return keyed(c) ? c.evaluate(f) : 0.F; }
// Position channels (tx, ty, tz from `from`); unkeyed channels take the fallback's.
Vec3 eval3(const Curve *c, float f, Vec3 fallback) {
    return {keyed(c[0]) ? c[0].evaluate(f) : fallback.x, keyed(c[1]) ? c[1].evaluate(f) : fallback.y, keyed(c[2]) ? c[2].evaluate(f) : fallback.z};
}
Vec3 eval_pos(const Channels &c, float f, Vec3 fallback) { return eval3(&c[PosX], f, fallback); }
Quat eval_rot(const Channels &c, float f) { return normalize(euler_xyz_degrees(at(c[RotX], f), at(c[RotY], f), at(c[RotZ], f))); }

void blend_vec(Vec3 &v, Vec3 layer, float w, bool additive) { v = additive ? v + layer * w : lerp(v, layer, w); }
void blend_rot(Quat &q, Quat layer, float w, bool additive) { q = additive ? normalize(q * slerp(Quat{}, layer, w)) : slerp(q, layer, w); }

// Sets joint j's global transform (rotation, translation) through its parent.
void set_global(const Skeleton &s, std::span<Transform> local, const std::vector<Transform> &g, std::size_t j, Vec3 pos, Quat rot) {
    const int p = s.joints[j].parent;
    Transform want = g[j];
    want.translation = pos;
    want.rotation = normalize(rot);
    const Transform l = p < 0 ? want : inverse(g[static_cast<std::size_t>(p)]) * want;
    local[j].translation = l.translation;
    local[j].rotation = normalize(l.rotation);
}

// Curves of one control ({"tx":[...],...}) through the keyframe-tracks parser.
std::expected<Channels, std::string> curves(const nlohmann::json &j) {
    if (j.is_null()) return Channels{};
    nlohmann::json doc{{"version", 1}, {"tracks", {{"c", j}}}};
    auto t = keyframes_from_json(doc.dump());
    if (!t) return std::unexpected(t.error());
    const auto it = t->joints.find("c");
    return it == t->joints.end() ? Channels{} : it->second;
}
std::expected<Curve, std::string> curve(const nlohmann::json &j) {
    if (j.is_null()) return Curve{};
    auto c = curves(nlohmann::json{{"tx", j}});
    if (!c) return std::unexpected(c.error());
    return (*c)[PosX];
}

// An anim layer active on a frame: its frame (layer time, rig frames) and weight.
struct Active {
    const ControlRigLayer *layer;
    float frame;
    float w;
};

struct Body {
    Vec3 t{};
    Quat q{};
};

} // namespace

std::expected<ControlRig, std::string> control_rig_from_json(std::string_view text) {
    try {
        const auto j = nlohmann::json::parse(text);
        ControlRig rig;
        rig.fps = j.value("fps", 30.F);
        if (!(rig.fps > 0.F)) return std::unexpected("control rig: fps must be positive");
        rig.hips = j.value("hips", std::string{});
        for (const auto &[key, dst] : {std::pair{"root_control", &rig.root_control}, std::pair{"hips_control", &rig.hips_control}}) {
            auto c = curves(j.value(key, nlohmann::json()));
            if (!c) return std::unexpected(std::string("control rig: ") + key + ": " + c.error());
            *dst = *c;
        }
        for (const auto &l : j.value("limbs", nlohmann::json::array())) {
            IkLimb limb;
            limb.name = l.value("name", std::string{"limb"});
            const auto chain = l.value("chain", nlohmann::json::array());
            if (!chain.is_array() || chain.size() != 3) return std::unexpected("control rig: " + limb.name + ": chain must list 3 joints");
            for (std::size_t k = 0; k < 3; ++k) limb.chain[k] = chain[k].get<std::string>();
            limb.ik = l.value("ik", false);
            const std::string follow = l.value("follow", std::string{"root"});
            if (follow == "world") limb.follow = ControlSpace::World;
            else if (follow == "root") limb.follow = ControlSpace::Root;
            else if (follow == "hips") limb.follow = ControlSpace::Hips;
            else return std::unexpected("control rig: " + limb.name + ": follow must be world, root or hips");
            limb.weight = l.value("weight", 1.F);
            if (!(limb.weight >= 0.F && limb.weight <= 1.F)) return std::unexpected("control rig: " + limb.name + ": weight must be 0..1");
            auto blend = curve(l.value("blend", nlohmann::json()));
            if (!blend) return std::unexpected("control rig: " + limb.name + ": blend: " + blend.error());
            limb.blend = *blend;
            auto target = curves(l.value("target", nlohmann::json()));
            if (!target) return std::unexpected("control rig: " + limb.name + ": target: " + target.error());
            limb.target = *target;
            auto pole = curves(l.value("pole", nlohmann::json()));
            if (!pole) return std::unexpected("control rig: " + limb.name + ": pole: " + pole.error());
            for (std::size_t k = 0; k < 3; ++k) limb.pole[k] = (*pole)[PosX + k]; // tx ty tz
            rig.limbs.push_back(std::move(limb));
        }
        for (const auto &l : j.value("layers", nlohmann::json::array())) {
            ControlRigLayer layer;
            layer.name = l.value("name", std::string{"layer"});
            const std::string mode = l.value("mode", std::string{"additive"});
            if (mode != "additive" && mode != "override") return std::unexpected("control rig: layer " + layer.name + ": mode must be additive or override");
            layer.additive = mode == "additive";
            layer.weight = l.value("weight", 1.F);
            if (!(layer.weight >= 0.F && layer.weight <= 1.F)) return std::unexpected("control rig: layer " + layer.name + ": weight must be 0..1");
            auto wc = curve(l.value("weight_keys", nlohmann::json()));
            if (!wc) return std::unexpected("control rig: layer " + layer.name + ": weight_keys: " + wc.error());
            layer.weight_curve = *wc;
            layer.start = l.value("start", 0.F);
            layer.speed = l.value("speed", 1.F);
            layer.end = l.value("end", 0.F);
            if (!(layer.speed > 0.F)) return std::unexpected("control rig: layer " + layer.name + ": speed must be positive");
            for (const auto &p : l.value("warp", nlohmann::json::array())) {
                if (!p.is_array() || p.size() != 2) return std::unexpected("control rig: layer " + layer.name + ": warp needs [out, in] pairs");
                layer.warp.emplace_back(p[0].get<float>(), p[1].get<float>());
            }
            for (const auto &[key, dst] : {std::pair{"root_control", &layer.root_control}, std::pair{"hips_control", &layer.hips_control}}) {
                auto c = curves(l.value(key, nlohmann::json()));
                if (!c) return std::unexpected("control rig: layer " + layer.name + ": " + key + ": " + c.error());
                *dst = *c;
            }
            const nlohmann::json layer_limbs = l.value("limbs", nlohmann::json::object());
            for (const auto &[name, v] : layer_limbs.items()) {
                LimbLayerCurves lc;
                auto target = curves(v.value("target", nlohmann::json()));
                if (!target) return std::unexpected("control rig: layer " + layer.name + ": " + name + ": " + target.error());
                lc.target = *target;
                auto pole = curves(v.value("pole", nlohmann::json()));
                if (!pole) return std::unexpected("control rig: layer " + layer.name + ": " + name + ": " + pole.error());
                for (std::size_t k = 0; k < 3; ++k) lc.pole[k] = (*pole)[PosX + k];
                auto blend = curve(v.value("blend", nlohmann::json()));
                if (!blend) return std::unexpected("control rig: layer " + layer.name + ": " + name + ": " + blend.error());
                lc.blend = *blend;
                layer.limbs[name] = std::move(lc);
            }
            rig.layers.push_back(std::move(layer));
        }
        return rig;
    } catch (const std::exception &e) {
        return std::unexpected(std::string("control rig JSON: ") + e.what());
    }
}

std::expected<ControlRig, std::string> load_control_rig(const std::filesystem::path &path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return std::unexpected("cannot open " + path.string());
    std::stringstream ss;
    ss << in.rdbuf();
    return control_rig_from_json(ss.str());
}

std::expected<ControlRigReport, std::string> apply_control_rig(AnimationClip &clip, const Skeleton &s, const ControlRig &rig) {
    ControlRigReport report;
    if (clip.joint_count != s.size()) return std::unexpected("control rig: the clip does not match the skeleton");
    int hips = rig.hips.empty() ? 0 : s.find(rig.hips);
    if (hips < 0) {
        report.warnings.push_back("hips joint '" + rig.hips + "' not found; using the skeleton root");
        hips = 0;
    }
    struct Chain { int a, b, c; };
    bool root_on = any_keyed(rig.root_control), hips_on = any_keyed(rig.hips_control);
    for (const ControlRigLayer &L : rig.layers) {
        root_on = root_on || any_keyed(L.root_control);
        hips_on = hips_on || any_keyed(L.hips_control);
    }
    if (root_on) report.solved.emplace_back("root");
    if (hips_on) report.solved.emplace_back("hips");
    std::vector<std::optional<Chain>> chains; // per rig.limbs entry
    for (const IkLimb &l : rig.limbs) {
        chains.emplace_back();
        if (!l.ik) continue;
        const int a = s.find(l.chain[0]), b = s.find(l.chain[1]), c = s.find(l.chain[2]);
        if (a < 0 || b < 0 || c < 0) { report.warnings.push_back(l.name + ": chain joints not found"); continue; }
        if (s.joints[static_cast<std::size_t>(b)].parent != a || s.joints[static_cast<std::size_t>(c)].parent != b) {
            report.warnings.push_back(l.name + ": " + l.chain[0] + " -> " + l.chain[1] + " -> " + l.chain[2] + " is not a direct chain");
            continue;
        }
        chains.back() = Chain{a, b, c};
        report.solved.push_back(l.name);
    }
    report.stride = kControlLimbStride * rig.limbs.size() + kControlBodyStride;
    report.controls.assign(report.stride * clip.frames(), 0.F);
    const float clip_fps = clip.fps > 0.F ? clip.fps : 30.F;
    const float scale = rig.fps / clip_fps; // clip frame -> rig frame
    const auto h = static_cast<std::size_t>(hips);
    std::vector<Active> act;
    for (std::size_t f = 0; f < clip.frames(); ++f) {
        std::span<Transform> local(&clip.at(f, 0), s.size());
        const float kf = static_cast<float>(f) * scale, sec = static_cast<float>(f) / clip_fps;
        act.clear();
        for (const ControlRigLayer &L : rig.layers) {
            if (L.end > L.start && sec > L.end) continue;
            const float lf = warp_time(L.warp, sec - L.start) * L.speed * rig.fps;
            const float w = keyed(L.weight_curve) ? std::clamp(L.weight_curve.evaluate(lf), 0.F, 1.F) : L.weight;
            if (w > 0.F) act.push_back({&L, lf, w});
        }
        float *out = report.controls.data() + f * report.stride;
        // Body offsets: the base curves, then the layers.
        auto compose_body = [&](const Channels &base, bool is_hips, Body &b0) {
            Body b{eval_pos(base, kf, {}), group_keyed(base, RotX) ? eval_rot(base, kf) : Quat{}};
            b0 = b;
            for (const Active &a : act) {
                const Channels &c = is_hips ? a.layer->hips_control : a.layer->root_control;
                if (group_keyed(c, PosX)) blend_vec(b.t, eval_pos(c, a.frame, a.layer->additive ? Vec3{} : b.t), a.w, a.layer->additive);
                if (group_keyed(c, RotX)) blend_rot(b.q, eval_rot(c, a.frame), a.w, a.layer->additive);
            }
            return b;
        };
        auto put_body = [](float *o, const Body &b) {
            o[0] = b.t.x; o[1] = b.t.y; o[2] = b.t.z;
            o[3] = b.q.x; o[4] = b.q.y; o[5] = b.q.z; o[6] = b.q.w;
        };
        Body hb0, rb0;
        const Body hb = compose_body(rig.hips_control, true, hb0), rb = compose_body(rig.root_control, false, rb0);
        float *body_out = out + kControlLimbStride * rig.limbs.size();
        put_body(body_out, hb); put_body(body_out + 7, hb0);
        put_body(body_out + 14, rb); put_body(body_out + 21, rb0);
        Transform root_space; // the root control's offset (Root follow space)
        if (root_on) { // every skeleton root, about the hips' ground point
            const auto g = forward_kinematics(s, local);
            const Vec3 pivot{g[h].translation.x, 0.F, g[h].translation.z};
            root_space.rotation = rb.q;
            root_space.translation = pivot + rb.t - rotate(rb.q, pivot);
            for (std::size_t j = 0; j < s.size(); ++j) {
                if (s.joints[j].parent >= 0) continue;
                local[j].translation = pivot + rb.t + rotate(rb.q, local[j].translation - pivot);
                local[j].rotation = normalize(rb.q * local[j].rotation);
            }
        }
        if (hips_on) {
            const auto g = forward_kinematics(s, local);
            set_global(s, local, g, h, g[h].translation + hb.t, hb.q * g[h].rotation);
        }
        for (std::size_t li = 0; li < rig.limbs.size(); ++li) {
            float *o = out + li * kControlLimbStride;
            for (const std::size_t k : {std::size_t{6}, std::size_t{17}}) o[k] = 1.F; // identity rotations
            if (!chains[li]) continue;
            const IkLimb &l = rig.limbs[li];
            const Chain ch = *chains[li];
            const auto g = forward_kinematics(s, local);
            Transform space; // follow space -> skeleton space
            if (l.follow == ControlSpace::Hips) {
                space.translation = g[h].translation;
                space.rotation = normalize(g[h].rotation);
            } else if (l.follow == ControlSpace::Root) {
                space = root_space;
            }
            const Transform inv = inverse(space);
            const auto ga = g[static_cast<std::size_t>(ch.a)], gb = g[static_cast<std::size_t>(ch.b)], gc = g[static_cast<std::size_t>(ch.c)];
            // The animation's values (follow space): end joint, and the pole of its bend plane.
            const Vec3 anim_pos = inv.apply(gc.translation);
            const Quat anim_rot = normalize(inv.rotation * gc.rotation);
            const Vec3 u = normalize(gc.translation - ga.translation, {0.F, 1.F, 0.F});
            Vec3 off = (gb.translation - ga.translation) - u * dot(gb.translation - ga.translation, u);
            off = normalize(off, {0.F, 0.F, 1.F});
            const Vec3 anim_pole = inv.apply(gb.translation + off * length(gb.translation - ga.translation));
            // Base layer, then the anim layers.
            bool has_pos = group_keyed(l.target, PosX), has_rot = group_keyed(l.target, RotX), has_pole = pole_keyed(l.pole);
            Vec3 pos = eval_pos(l.target, kf, anim_pos);
            Quat rot = has_rot ? eval_rot(l.target, kf) : anim_rot;
            Vec3 pole = has_pole ? eval3(l.pole.data(), kf, anim_pole) : anim_pole;
            float blend = keyed(l.blend) ? std::clamp(l.blend.evaluate(kf), 0.F, 1.F) : l.weight;
            auto put = [](float *p, Vec3 a, Quat q, Vec3 b, float w) {
                p[0] = a.x; p[1] = a.y; p[2] = a.z; p[3] = q.x; p[4] = q.y; p[5] = q.z; p[6] = q.w;
                p[7] = b.x; p[8] = b.y; p[9] = b.z; p[10] = w;
            };
            put(o + 11, pos, rot, pole, blend);
            for (const Active &a : act) {
                const auto it = a.layer->limbs.find(l.name);
                if (it == a.layer->limbs.end()) continue;
                const LimbLayerCurves &lc = it->second;
                const bool add = a.layer->additive;
                if (group_keyed(lc.target, PosX)) { has_pos = true; blend_vec(pos, eval_pos(lc.target, a.frame, add ? Vec3{} : pos), a.w, add); }
                if (group_keyed(lc.target, RotX)) { has_rot = true; blend_rot(rot, eval_rot(lc.target, a.frame), a.w, add); }
                if (pole_keyed(lc.pole)) { has_pole = true; blend_vec(pole, eval3(lc.pole.data(), a.frame, add ? Vec3{} : pole), a.w, add); }
                if (keyed(lc.blend)) {
                    const float v = lc.blend.evaluate(a.frame);
                    blend = add ? blend + v * a.w : blend + (v - blend) * a.w;
                }
            }
            blend = std::clamp(blend, 0.F, 1.F);
            put(o, pos, rot, pole, blend);
            if (blend <= 0.F) continue; // FK on this frame
            if (!has_pos && !has_rot && !has_pole) continue; // follows the animation: nothing to do
            const Vec3 target = space.apply(pos);
            const Quat end = normalize(space.rotation * rot);
            std::vector<Transform> before(local.begin(), local.end());
            bool reached;
            if (has_pole) {
                reached = solve_two_bone_ik_pole(s, local, ch.a, ch.b, ch.c, target, space.apply(pole), &end);
            } else {
                reached = solve_two_bone_ik(s, local, ch.a, ch.b, ch.c, target, true);
                if (has_rot) { // end joint: the keyed global rotation
                    const auto g2 = forward_kinematics(s, local);
                    local[static_cast<std::size_t>(ch.c)].rotation =
                        normalize(inverse(normalize(g2[static_cast<std::size_t>(ch.b)].rotation)) * end);
                }
            }
            if (!reached) ++report.unreachable_frames;
            if (blend < 1.F)
                for (const int j : {ch.a, ch.b, ch.c}) {
                    const auto k = static_cast<std::size_t>(j);
                    local[k].rotation = slerp(before[k].rotation, local[k].rotation, blend);
                }
        }
    }
    return report;
}

} // namespace kimodo::anim
