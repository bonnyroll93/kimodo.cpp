#include <kimodo/anim/clip.hpp>

#include <nlohmann/json.hpp>

#include <fstream>
#include <sstream>

namespace kimodo::anim {
namespace {

std::expected<std::vector<float>, std::string> read_f32(const std::filesystem::path &path) {
    std::ifstream in(path, std::ios::binary | std::ios::ate);
    if (!in) return std::unexpected("cannot open " + path.string());
    const auto bytes = static_cast<std::size_t>(in.tellg());
    if (bytes % sizeof(float) != 0) return std::unexpected(path.string() + " is not a float32 array");
    std::vector<float> values(bytes / sizeof(float));
    in.seekg(0);
    in.read(reinterpret_cast<char *>(values.data()), static_cast<std::streamsize>(bytes));
    if (!in) return std::unexpected("cannot read " + path.string());
    return values;
}

std::expected<void, std::string> write_f32(const std::filesystem::path &path, const std::vector<float> &values) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out.write(reinterpret_cast<const char *>(values.data()), static_cast<std::streamsize>(values.size() * sizeof(float)));
    if (!out) return std::unexpected("cannot write " + path.string());
    return {};
}

} // namespace

std::expected<AnimationClip, std::string> clip_from_motion(const Skeleton &skeleton, const MotionArrays &motion,
                                                           float fps) {
    if (motion.joints != skeleton.size())
        return std::unexpected("motion has " + std::to_string(motion.joints) + " joints, skeleton '" + skeleton.source +
                               "' has " + std::to_string(skeleton.size()));
    if (motion.root_positions.size() != motion.frames * 3 || motion.rotations_xyzw.size() != motion.frames * motion.joints * 4)
        return std::unexpected("motion arrays do not match frames x joints");
    if (!(fps > 0.F)) return std::unexpected("fps must be positive");
    AnimationClip clip;
    clip.fps = fps;
    clip.joint_count = motion.joints;
    for (const Joint &j : skeleton.joints) clip.joint_names.push_back(j.name);
    clip.locals.resize(motion.frames * motion.joints);
    for (std::size_t f = 0; f < motion.frames; ++f)
        for (std::size_t j = 0; j < motion.joints; ++j) {
            Transform &t = clip.at(f, j);
            const float *q = motion.rotations_xyzw.data() + (f * motion.joints + j) * 4;
            t.rotation = {q[0], q[1], q[2], q[3]};
            t.translation = skeleton.joints[j].rest_local.translation;
            t.scale = skeleton.joints[j].rest_local.scale;
        }
    for (std::size_t f = 0; f < motion.frames; ++f) {
        const float *p = motion.root_positions.data() + f * 3;
        clip.at(f, 0).translation = {p[0], p[1], p[2]};
    }
    return clip;
}

MotionArrays clip_to_motion(const AnimationClip &clip) {
    MotionArrays m;
    m.frames = clip.frames();
    m.joints = clip.joint_count;
    m.root_positions.reserve(m.frames * 3);
    m.rotations_xyzw.reserve(m.frames * m.joints * 4);
    for (std::size_t f = 0; f < m.frames; ++f) {
        const Vec3 p = clip.at(f, 0).translation;
        m.root_positions.insert(m.root_positions.end(), {p.x, p.y, p.z});
        for (std::size_t j = 0; j < m.joints; ++j) {
            const Quat q = clip.at(f, j).rotation;
            m.rotations_xyzw.insert(m.rotations_xyzw.end(), {q.x, q.y, q.z, q.w});
        }
    }
    return m;
}

std::expected<MotionArrays, std::string> read_motion_dir(const std::filesystem::path &dir) {
    auto root = read_f32(dir / "root_positions.f32");
    if (!root) return std::unexpected(root.error());
    auto rot = read_f32(dir / "local_rotations_xyzw.f32");
    if (!rot) return std::unexpected(rot.error());
    if (root->empty() || root->size() % 3 != 0) return std::unexpected("root_positions.f32 is not [frames, 3]");
    MotionArrays m;
    m.frames = root->size() / 3;
    if (rot->size() % (m.frames * 4) != 0) return std::unexpected("local_rotations_xyzw.f32 is not [frames, joints, 4]");
    m.joints = rot->size() / (m.frames * 4);
    m.root_positions = std::move(*root);
    m.rotations_xyzw = std::move(*rot);
    return m;
}

std::expected<AnimationClip, std::string> read_clip_dir(const std::filesystem::path &dir) {
    std::filesystem::path meta_path = dir / "clip.json";
    if (!std::filesystem::exists(meta_path)) meta_path = dir / "retarget.json";
    std::ifstream in(meta_path, std::ios::binary);
    if (!in) return std::unexpected("no clip.json or retarget.json in " + dir.string());
    std::stringstream text;
    text << in.rdbuf();
    AnimationClip clip;
    std::vector<Vec3> scales;
    try {
        const auto meta = nlohmann::json::parse(text.str());
        clip.fps = meta.value("fps", 30.F);
        clip.name = meta.value("name", dir.filename().string());
        for (const auto &j : meta.at("joints")) {
            clip.joint_names.push_back(j.at("name").get<std::string>());
            Vec3 s{1.F, 1.F, 1.F};
            if (j.contains("scale")) s = {j["scale"][0].get<float>(), j["scale"][1].get<float>(), j["scale"][2].get<float>()};
            scales.push_back(s);
        }
    } catch (const nlohmann::json::exception &e) {
        return std::unexpected("invalid " + meta_path.string() + ": " + e.what());
    }
    if (!(clip.fps > 0.F)) return std::unexpected("clip fps must be positive");
    clip.joint_count = clip.joint_names.size();
    auto rot = read_f32(dir / "local_rotations_xyzw.f32");
    if (!rot) return std::unexpected(rot.error());
    auto trans = read_f32(dir / "local_translations.f32");
    if (!trans) return std::unexpected(trans.error());
    const std::size_t j = clip.joint_count;
    if (j == 0 || rot->size() % (j * 4) != 0 || trans->size() != rot->size() / 4 * 3)
        return std::unexpected("clip arrays in " + dir.string() + " do not match " + std::to_string(j) + " joints");
    const std::size_t frames = rot->size() / (j * 4);
    clip.locals.resize(frames * j);
    for (std::size_t i = 0; i < frames * j; ++i) {
        const float *q = rot->data() + i * 4, *t = trans->data() + i * 3;
        clip.locals[i] = {{t[0], t[1], t[2]}, {q[0], q[1], q[2], q[3]}, scales[i % j]};
    }
    return clip;
}

std::expected<void, std::string> write_clip_dir(const std::filesystem::path &dir, const AnimationClip &clip,
                                                const Skeleton &skeleton, std::string_view extra_json) {
    if (clip.joint_count != skeleton.size()) return std::unexpected("clip and skeleton joint counts differ");
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    if (ec) return std::unexpected("cannot create " + dir.string() + ": " + ec.message());
    std::vector<float> rot, trans;
    rot.reserve(clip.locals.size() * 4);
    trans.reserve(clip.locals.size() * 3);
    for (const Transform &t : clip.locals) {
        rot.insert(rot.end(), {t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w});
        trans.insert(trans.end(), {t.translation.x, t.translation.y, t.translation.z});
    }
    if (auto ok = write_f32(dir / "local_rotations_xyzw.f32", rot); !ok) return ok;
    if (auto ok = write_f32(dir / "local_translations.f32", trans); !ok) return ok;
    nlohmann::ordered_json meta;
    try {
        if (!extra_json.empty()) meta = nlohmann::ordered_json::parse(extra_json);
    } catch (const nlohmann::json::exception &e) {
        return std::unexpected(std::string("invalid extra clip metadata: ") + e.what());
    }
    meta["name"] = clip.name;
    meta["frames"] = clip.frames();
    meta["fps"] = clip.fps;
    meta["joints"] = nlohmann::ordered_json::array();
    for (const Joint &j : skeleton.joints)
        meta["joints"].push_back({{"name", j.name}, {"parent", j.parent}, {"source_node", j.source_node},
                                  {"scale", {j.rest_local.scale.x, j.rest_local.scale.y, j.rest_local.scale.z}}});
    std::ofstream out(dir / "clip.json", std::ios::binary | std::ios::trunc);
    out << meta.dump() << '\n';
    if (!out) return std::unexpected("cannot write clip.json");
    return {};
}

std::expected<void, std::string> write_motion_dir(const std::filesystem::path &dir, const MotionArrays &motion) {
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    if (ec) return std::unexpected("cannot create " + dir.string() + ": " + ec.message());
    if (auto ok = write_f32(dir / "root_positions.f32", motion.root_positions); !ok) return ok;
    return write_f32(dir / "local_rotations_xyzw.f32", motion.rotations_xyzw);
}

} // namespace kimodo::anim
