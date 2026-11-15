// kmd-anim: Kimodo Extended post-processing tool.
//   kmd-anim inspect CHARACTER.glb [--skin N]   skeleton of a rigged glTF/GLB as JSON
//   kmd-anim inspect --native KEY               native Kimodo skeleton (smplx22|soma30|g1skel34)
//   kmd-anim root-motion IN_DIR OUT_DIR --mode full|inplace|path [options]
//                                               Full / InPlace / CustomPath on kmd-generate output
//   kmd-anim map SOURCE_KEY TARGET.glb [--mapping FILE]
//                                               automatic (or given) joint mapping + diagnostics
//   kmd-anim retarget MOTION_DIR TARGET.glb OUT_DIR [options]
//                                               retarget a native motion onto a rigged character
#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/gltf.hpp>
#include <kimodo/anim/retarget.hpp>
#include <kimodo/anim/root_motion.hpp>
#include <kimodo/anim/skeleton.hpp>

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <optional>
#include <stdexcept>
#include <iostream>
#include <sstream>
#include <string>
#include <string_view>

namespace {
using namespace kimodo::anim;

std::string quote(std::string_view s) {
    std::string out = "\"";
    for (const char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (static_cast<unsigned char>(c) < 0x20) {
                char buf[8];
                std::snprintf(buf, sizeof buf, "\\u%04x", c);
                out += buf;
            } else {
                out += c;
            }
        }
    }
    return out + "\"";
}

std::string num(float v) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.9g", static_cast<double>(v));
    return buf;
}
std::string vec(Vec3 v) { return "[" + num(v.x) + "," + num(v.y) + "," + num(v.z) + "]"; }
std::string quat(Quat q) { return "[" + num(q.x) + "," + num(q.y) + "," + num(q.z) + "," + num(q.w) + "]"; }
std::string trs(const Transform &t) {
    return "{\"translation\":" + vec(t.translation) + ",\"rotation_xyzw\":" + quat(t.rotation) +
           ",\"scale\":" + vec(t.scale) + "}";
}

std::string skeleton_json(const Skeleton &s) {
    const auto global = s.rest_global();
    std::ostringstream o;
    o << "{\"source\":" << quote(s.source) << ",\"joint_count\":" << s.size() << ",\"joints\":[";
    for (std::size_t i = 0; i < s.size(); ++i) {
        const Joint &j = s.joints[i];
        o << (i ? "," : "") << "\n  {\"index\":" << i << ",\"name\":" << quote(j.name) << ",\"parent\":" << j.parent
          << ",\"deforming\":" << (j.deforming ? "true" : "false") << ",\"source_node\":" << j.source_node
          << ",\"skin_joint\":" << j.skin_joint << ",\"bone_length\":" << num(s.bone_length(static_cast<int>(i)))
          << ",\"rest_local\":" << trs(j.rest_local) << ",\"rest_global\":" << trs(global[i]) << "}";
    }
    o << "\n]}";
    return o.str();
}

int usage() {
    std::cerr << "usage: kmd-anim inspect CHARACTER.glb [--skin N]\n"
                 "       kmd-anim inspect --native smplx22|soma30|g1skel34\n"
                 "       kmd-anim root-motion IN_DIR OUT_DIR --mode full|inplace|path\n"
                 "           [--up X,Y,Z] [--forward X,Y,Z] [--lock both|forward|lateral] [--fps N]\n"
                 "           [--points X,Y,Z;X,Y,Z;...] [--interp catmull|polyline] [--loop]\n"
                 "           [--timing distance|duration|speed] [--duration S] [--speed M_PER_S] [--no-orient]\n"
                 "       IN_DIR/OUT_DIR hold root_positions.f32 + local_rotations_xyzw.f32; path mode also\n"
                 "       writes OUT_DIR/path_samples.f32 ([N,3], the evaluated curve for display).\n"
                 "       kmd-anim map smplx22|soma30|g1skel34 TARGET.glb [--mapping FILE] [--skin N]\n"
                 "       kmd-anim retarget MOTION_DIR TARGET.glb OUT_DIR [--mapping FILE] [--save-mapping FILE]\n"
                 "           [--root-scale S] [--yaw DEG] [--no-auto-facing] [--align-rest] [--skin N] [--fps N]\n"
                 "       retarget writes OUT_DIR/retarget.json, local_rotations_xyzw.f32 [T,J,4] and\n"
                 "       local_translations.f32 [T,J,3] in the target's joint order.\n";
    return 2;
}

Vec3 parse_vec3(std::string_view text) {
    Vec3 v;
    if (std::sscanf(std::string(text).c_str(), "%f,%f,%f", &v.x, &v.y, &v.z) != 3)
        throw std::runtime_error("expected X,Y,Z but got '" + std::string(text) + "'");
    return v;
}

std::vector<Vec3> parse_points(std::string_view text) {
    std::vector<Vec3> points;
    std::size_t start = 0;
    while (start <= text.size()) {
        const std::size_t end = std::min(text.find(';', start), text.size());
        if (end > start) points.push_back(parse_vec3(text.substr(start, end - start)));
        start = end + 1;
    }
    return points;
}

int root_motion(int argc, char **argv) {
    if (argc < 4) return usage();
    const std::filesystem::path in = argv[2], out = argv[3];
    RootMotionSettings settings;
    float fps = 30.F;
    bool have_mode = false;
    auto path_spec = [&]() -> MotionPathSpec & {
        if (!settings.path) settings.path.emplace();
        return *settings.path;
    };
    for (int i = 4; i < argc; ++i) {
        const std::string_view arg = argv[i];
        auto value = [&]() -> std::string_view {
            if (i + 1 >= argc) throw std::runtime_error(std::string(arg) + " needs a value");
            return argv[++i];
        };
        if (arg == "--mode") {
            const auto m = value();
            have_mode = true;
            if (m == "full") settings.mode = RootMotionMode::Full;
            else if (m == "inplace") settings.mode = RootMotionMode::InPlace;
            else if (m == "path") settings.mode = RootMotionMode::CustomPath;
            else throw std::runtime_error("unknown mode '" + std::string(m) + "'");
        } else if (arg == "--up") {
            settings.axes.up = parse_vec3(value());
        } else if (arg == "--forward") {
            settings.axes.forward = parse_vec3(value());
        } else if (arg == "--fps") {
            fps = std::stof(std::string(value()));
        } else if (arg == "--lock") {
            const auto l = value();
            settings.in_place.lock_forward = l == "both" || l == "forward";
            settings.in_place.lock_lateral = l == "both" || l == "lateral";
            if (!settings.in_place.lock_forward && !settings.in_place.lock_lateral)
                throw std::runtime_error("--lock must be both, forward or lateral");
        } else if (arg == "--points") {
            path_spec().points = parse_points(value());
        } else if (arg == "--interp") {
            const auto t = value();
            if (t == "catmull") path_spec().interpolation = PathInterpolation::CatmullRom;
            else if (t == "polyline") path_spec().interpolation = PathInterpolation::Polyline;
            else throw std::runtime_error("unknown interpolation '" + std::string(t) + "'");
        } else if (arg == "--loop") {
            path_spec().loop = true;
        } else if (arg == "--timing") {
            const auto t = value();
            if (t == "distance") settings.follow.timing = PathTiming::MotionDistance;
            else if (t == "duration") settings.follow.timing = PathTiming::Duration;
            else if (t == "speed") settings.follow.timing = PathTiming::Speed;
            else throw std::runtime_error("unknown timing '" + std::string(t) + "'");
        } else if (arg == "--duration") {
            settings.follow.duration = std::stof(std::string(value()));
        } else if (arg == "--speed") {
            settings.follow.speed = std::stof(std::string(value()));
        } else if (arg == "--no-orient") {
            settings.follow.orient_to_path = false;
        } else {
            throw std::runtime_error("unknown option '" + std::string(arg) + "'");
        }
    }
    if (!have_mode) throw std::runtime_error("--mode is required");
    if (auto ok = validate(settings); !ok) throw std::runtime_error(ok.error());

    auto motion = read_motion_dir(in);
    if (!motion) throw std::runtime_error(motion.error());
    auto skeleton = native_skeleton_for_joint_count(motion->joints);
    if (!skeleton) throw std::runtime_error(skeleton.error());
    auto clip = clip_from_motion(*skeleton, *motion, fps);
    if (!clip) throw std::runtime_error(clip.error());
    if (auto ok = apply_root_motion(*clip, settings); !ok) throw std::runtime_error(ok.error());
    if (auto ok = write_motion_dir(out, clip_to_motion(*clip)); !ok) throw std::runtime_error(ok.error());
    if (settings.mode == RootMotionMode::CustomPath) {
        auto path = MotionPath::build(*settings.path, settings.axes); // built successfully above
        const auto samples = path->sample(256);
        std::ofstream f(out / "path_samples.f32", std::ios::binary | std::ios::trunc);
        for (const Vec3 &p : samples) {
            const float xyz[3] = {p.x, p.y, p.z};
            f.write(reinterpret_cast<const char *>(xyz), sizeof xyz);
        }
        if (!f) throw std::runtime_error("cannot write path_samples.f32");
    }
    std::cout << "{\"frames\":" << motion->frames << ",\"joints\":" << motion->joints
              << ",\"skeleton\":" << quote(skeleton->source) << "}\n";
    return 0;
}
std::string string_list(const std::vector<std::string> &items) {
    std::string out = "[";
    for (std::size_t i = 0; i < items.size(); ++i) out += (i ? "," : "") + quote(items[i]);
    return out + "]";
}

std::string diagnostics_json(const MappingDiagnostics &d) {
    return "\"errors\":" + string_list(d.errors) + ",\"warnings\":" + string_list(d.warnings);
}

std::string compact_mapping_json(const RetargetMapping &mapping) {
    std::string json = mapping_to_json(mapping);
    while (!json.empty() && (json.back() == '\n' || json.back() == ' ')) json.pop_back();
    return json;
}

int map_command(int argc, char **argv) {
    if (argc < 4) return usage();
    auto source = native_skeleton(argv[2]);
    if (!source) throw std::runtime_error(source.error());
    std::optional<std::filesystem::path> mapping_file;
    GltfImportOptions import;
    for (int i = 4; i < argc; ++i) {
        const std::string_view arg = argv[i];
        if (arg == "--mapping" && i + 1 < argc) mapping_file = argv[++i];
        else if (arg == "--skin" && i + 1 < argc) import.skin = std::stoi(argv[++i]);
        else throw std::runtime_error("unknown option '" + std::string(arg) + "'");
    }
    auto character = load_gltf_character(argv[3], import);
    if (!character) throw std::runtime_error(character.error());
    RetargetMapping mapping;
    if (mapping_file) {
        auto loaded = load_mapping(*mapping_file);
        if (!loaded) throw std::runtime_error(loaded.error());
        mapping = std::move(*loaded);
    } else {
        mapping = auto_map(*source, character->skeleton);
    }
    const auto d = check_mapping(mapping, *source, character->skeleton);
    std::cout << "{\"mapping\":" << compact_mapping_json(mapping) << "," << diagnostics_json(d) << "}\n";
    return d.ok() ? 0 : 1;
}

int retarget_command(int argc, char **argv) {
    if (argc < 5) return usage();
    const std::filesystem::path motion_dir = argv[2], target_path = argv[3], out = argv[4];
    std::optional<std::filesystem::path> mapping_file, save_file;
    RetargetOptions options;
    GltfImportOptions import;
    float fps = 30.F;
    for (int i = 5; i < argc; ++i) {
        const std::string_view arg = argv[i];
        auto value = [&]() -> std::string {
            if (i + 1 >= argc) throw std::runtime_error(std::string(arg) + " needs a value");
            return argv[++i];
        };
        if (arg == "--mapping") mapping_file = value();
        else if (arg == "--save-mapping") save_file = value();
        else if (arg == "--root-scale") options.root_scale = std::stof(value());
        else if (arg == "--yaw") options.yaw_offset_degrees = std::stof(value());
        else if (arg == "--no-auto-facing") options.auto_facing = false;
        else if (arg == "--align-rest") options.align_rest_directions = true;
        else if (arg == "--skin") import.skin = std::stoi(value());
        else if (arg == "--fps") fps = std::stof(value());
        else throw std::runtime_error("unknown option '" + std::string(arg) + "'");
    }
    auto motion = read_motion_dir(motion_dir);
    if (!motion) throw std::runtime_error(motion.error());
    auto source = native_skeleton_for_joint_count(motion->joints);
    if (!source) throw std::runtime_error(source.error());
    auto clip = clip_from_motion(*source, *motion, fps);
    if (!clip) throw std::runtime_error(clip.error());
    auto character = load_gltf_character(target_path, import);
    if (!character) throw std::runtime_error(character.error());
    const Skeleton &target = character->skeleton;
    RetargetMapping mapping;
    if (mapping_file) {
        auto loaded = load_mapping(*mapping_file);
        if (!loaded) throw std::runtime_error(loaded.error());
        mapping = std::move(*loaded);
    } else {
        mapping = auto_map(*source, target);
    }
    if (save_file)
        if (auto ok = save_mapping(*save_file, mapping); !ok) throw std::runtime_error(ok.error());
    auto result = retarget(*clip, *source, target, mapping, options);
    if (!result) throw std::runtime_error(result.error());

    std::error_code ec;
    std::filesystem::create_directories(out, ec);
    if (ec) throw std::runtime_error("cannot create " + out.string() + ": " + ec.message());
    const std::size_t frames = result->clip.frames(), joints = result->clip.joint_count;
    std::vector<float> rot, trans;
    rot.reserve(frames * joints * 4);
    trans.reserve(frames * joints * 3);
    for (const Transform &t : result->clip.locals) {
        rot.insert(rot.end(), {t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w});
        trans.insert(trans.end(), {t.translation.x, t.translation.y, t.translation.z});
    }
    auto write = [&](const char *name, const std::vector<float> &v) {
        std::ofstream f(out / name, std::ios::binary | std::ios::trunc);
        f.write(reinterpret_cast<const char *>(v.data()), static_cast<std::streamsize>(v.size() * sizeof(float)));
        if (!f) throw std::runtime_error(std::string("cannot write ") + name);
    };
    write("local_rotations_xyzw.f32", rot);
    write("local_translations.f32", trans);
    std::ostringstream meta;
    meta << "{\"frames\":" << frames << ",\"fps\":" << num(result->clip.fps) << ",\"source_skeleton\":"
         << quote(source->source) << ",\"translation_joint\":" << result->translation_joint
         << ",\"root_scale\":" << num(result->root_scale) << ",\"facing_yaw_degrees\":"
         << num(result->facing_yaw_degrees) << ",\"source_reference\":" << vec(result->source_reference)
         << ",\"target_reference\":" << vec(result->target_reference) << ",\"target_ground\":"
         << num(result->target_ground) << "," << diagnostics_json(result->diagnostics) << ",\"joints\":[";
    for (std::size_t j = 0; j < joints; ++j) {
        const Joint &jt = target.joints[j];
        meta << (j ? "," : "") << "{\"name\":" << quote(jt.name) << ",\"parent\":" << jt.parent
             << ",\"source_node\":" << jt.source_node << ",\"scale\":" << vec(jt.rest_local.scale) << "}";
    }
    meta << "],\"mapping\":" << compact_mapping_json(mapping) << "}\n";
    std::ofstream meta_file(out / "retarget.json", std::ios::binary | std::ios::trunc);
    meta_file << meta.str();
    if (!meta_file) throw std::runtime_error("cannot write retarget.json");
    std::cout << meta.str();
    return 0;
}
} // namespace

int main(int argc, char **argv) try {
    if (argc >= 2 && std::string_view(argv[1]) == "root-motion") return root_motion(argc, argv);
    if (argc >= 2 && std::string_view(argv[1]) == "map") return map_command(argc, argv);
    if (argc >= 2 && std::string_view(argv[1]) == "retarget") return retarget_command(argc, argv);
    if (argc < 3 || std::string_view(argv[1]) != "inspect") return usage();
    if (std::string_view(argv[2]) == "--native") {
        if (argc != 4) return usage();
        auto s = native_skeleton(argv[3]);
        if (!s) { std::cerr << s.error() << '\n'; return 1; }
        std::cout << "{\"skeleton\":" << skeleton_json(*s) << "}\n";
        return 0;
    }
    GltfImportOptions options;
    if (argc == 5 && std::string_view(argv[3]) == "--skin") options.skin = std::stoi(argv[4]);
    else if (argc != 3) return usage();
    auto c = load_gltf_character(argv[2], options);
    if (!c) { std::cerr << c.error() << '\n'; return 1; }
    std::cout << "{\"meshes\":" << c->meshes << ",\"skinned_meshes\":" << c->skinned_meshes
              << ",\"materials\":" << c->materials << ",\"skins\":" << c->skins << ",\"animations\":[";
    for (std::size_t i = 0; i < c->animations.size(); ++i) std::cout << (i ? "," : "") << quote(c->animations[i]);
    std::cout << "],\"skeleton\":" << skeleton_json(c->skeleton) << "}\n";
    return 0;
} catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
}
