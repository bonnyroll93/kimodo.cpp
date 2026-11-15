#include <kimodo/anim/control_rig.hpp>
#include <kimodo/anim/ik.hpp>

#include <nlohmann/json.hpp>

#include <fstream>
#include <span>
#include <sstream>

namespace kimodo::anim {
namespace {

bool keyed(const Curve &c) { return !c.keys.empty(); }

// Curves of one control ({"tx":[...],...}) through the keyframe-tracks parser.
std::expected<std::array<Curve, ChannelCount>, std::string> curves(const nlohmann::json &j) {
    if (j.is_null()) return std::array<Curve, ChannelCount>{};
    nlohmann::json doc{{"version", 1}, {"tracks", {{"c", j}}}};
    auto t = keyframes_from_json(doc.dump());
    if (!t) return std::unexpected(t.error());
    const auto it = t->joints.find("c");
    return it == t->joints.end() ? std::array<Curve, ChannelCount>{} : it->second;
}

} // namespace

std::expected<ControlRig, std::string> control_rig_from_json(std::string_view text) {
    try {
        const auto j = nlohmann::json::parse(text);
        ControlRig rig;
        rig.fps = j.value("fps", 30.F);
        if (!(rig.fps > 0.F)) return std::unexpected("control rig: fps must be positive");
        rig.hips = j.value("hips", std::string{});
        for (const auto &l : j.value("limbs", nlohmann::json::array())) {
            IkLimb limb;
            limb.name = l.value("name", std::string{"limb"});
            const auto chain = l.value("chain", nlohmann::json::array());
            if (!chain.is_array() || chain.size() != 3) return std::unexpected("control rig: " + limb.name + ": chain must list 3 joints");
            for (std::size_t k = 0; k < 3; ++k) limb.chain[k] = chain[k].get<std::string>();
            limb.ik = l.value("ik", false);
            const std::string follow = l.value("follow", std::string{"root"});
            if (follow == "root") limb.follow = ControlSpace::Root;
            else if (follow == "hips") limb.follow = ControlSpace::Hips;
            else return std::unexpected("control rig: " + limb.name + ": follow must be root or hips");
            limb.weight = l.value("weight", 1.F);
            if (!(limb.weight >= 0.F && limb.weight <= 1.F)) return std::unexpected("control rig: " + limb.name + ": weight must be 0..1");
            auto target = curves(l.value("target", nlohmann::json()));
            if (!target) return std::unexpected("control rig: " + limb.name + ": target: " + target.error());
            limb.target = *target;
            auto pole = curves(l.value("pole", nlohmann::json()));
            if (!pole) return std::unexpected("control rig: " + limb.name + ": pole: " + pole.error());
            for (std::size_t k = 0; k < 3; ++k) limb.pole[k] = (*pole)[PosX + k]; // tx ty tz
            rig.limbs.push_back(std::move(limb));
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
    struct Chain { const IkLimb *limb; int a, b, c; };
    std::vector<Chain> chains;
    for (const IkLimb &l : rig.limbs) {
        if (!l.ik || l.weight <= 0.F) continue;
        const int a = s.find(l.chain[0]), b = s.find(l.chain[1]), c = s.find(l.chain[2]);
        if (a < 0 || b < 0 || c < 0) { report.warnings.push_back(l.name + ": chain joints not found"); continue; }
        if (s.joints[static_cast<std::size_t>(b)].parent != a || s.joints[static_cast<std::size_t>(c)].parent != b) {
            report.warnings.push_back(l.name + ": " + l.chain[0] + " -> " + l.chain[1] + " -> " + l.chain[2] + " is not a direct chain");
            continue;
        }
        chains.push_back({&l, a, b, c});
        report.solved.push_back(l.name);
    }
    if (chains.empty()) return report;
    const float scale = rig.fps / (clip.fps > 0.F ? clip.fps : 30.F); // clip frame -> rig frame
    for (std::size_t f = 0; f < clip.frames(); ++f) {
        std::span<Transform> local(&clip.at(f, 0), s.size());
        const float kf = static_cast<float>(f) * scale;
        for (const Chain &ch : chains) {
            const IkLimb &l = *ch.limb;
            const auto g = forward_kinematics(s, local);
            Transform space; // follow space -> skeleton space
            if (l.follow == ControlSpace::Hips) {
                space.translation = g[static_cast<std::size_t>(hips)].translation;
                space.rotation = normalize(g[static_cast<std::size_t>(hips)].rotation);
            }
            const auto &t = l.target;
            const bool has_pos = keyed(t[PosX]) || keyed(t[PosY]) || keyed(t[PosZ]);
            const bool has_rot = keyed(t[RotX]) || keyed(t[RotY]) || keyed(t[RotZ]);
            const bool has_pole = keyed(l.pole[0]) || keyed(l.pole[1]) || keyed(l.pole[2]);
            if (!has_pos && !has_rot && !has_pole) continue; // follows the animation: nothing to do
            const Vec3 target = has_pos ? space.apply(Vec3{t[PosX].evaluate(kf), t[PosY].evaluate(kf), t[PosZ].evaluate(kf)})
                                        : g[static_cast<std::size_t>(ch.c)].translation;
            Quat end = g[static_cast<std::size_t>(ch.c)].rotation;
            if (has_rot) end = normalize(space.rotation * euler_xyz_degrees(t[RotX].evaluate(kf), t[RotY].evaluate(kf), t[RotZ].evaluate(kf)));
            std::vector<Transform> before(local.begin(), local.end());
            bool reached;
            if (has_pole) {
                const Vec3 pole = space.apply(Vec3{l.pole[0].evaluate(kf), l.pole[1].evaluate(kf), l.pole[2].evaluate(kf)});
                reached = solve_two_bone_ik_pole(s, local, ch.a, ch.b, ch.c, target, pole, &end);
            } else {
                reached = solve_two_bone_ik(s, local, ch.a, ch.b, ch.c, target, true);
                if (has_rot) { // end joint: the keyed global rotation
                    const auto g2 = forward_kinematics(s, local);
                    local[static_cast<std::size_t>(ch.c)].rotation =
                        normalize(inverse(normalize(g2[static_cast<std::size_t>(ch.b)].rotation)) * end);
                }
            }
            if (!reached) ++report.unreachable_frames;
            if (l.weight < 1.F)
                for (const int j : {ch.a, ch.b, ch.c}) {
                    const auto k = static_cast<std::size_t>(j);
                    local[k].rotation = slerp(before[k].rotation, local[k].rotation, l.weight);
                }
        }
    }
    return report;
}

} // namespace kimodo::anim
