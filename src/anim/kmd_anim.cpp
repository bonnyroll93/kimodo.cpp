// kmd-anim: Kimodo Extended post-processing tool.
//   kmd-anim inspect CHARACTER.glb [--skin N]   skeleton of a rigged glTF/GLB as JSON
//   kmd-anim inspect --native KEY               native Kimodo skeleton (smplx22|soma30|g1skel34)
//   kmd-anim root-motion IN_DIR OUT_DIR --mode full|inplace|path [options]
//                                               Full / InPlace / CustomPath on kmd-generate output
//   kmd-anim map SOURCE_KEY TARGET.glb [--mapping FILE]
//                                               automatic (or given) joint mapping + diagnostics
//   kmd-anim retarget MOTION_DIR TARGET.glb OUT_DIR [options]
//                                               retarget a native motion onto a rigged character
//   kmd-anim layers OUT_DIR (--native KEY | --character FILE.glb) --layer DIR [layer options]...
//                                               compose and bake an animation layer stack
//   kmd-anim export CHARACTER.glb CLIP_DIR OUT.glb [--name S] [--replace-animations]
//                                               character + clip -> one animated GLB
//   kmd-anim footlock IN_DIR OUT_DIR [--character FILE.glb] [foot lock options]
//                                               detect foot contacts, pin feet with two-bone IK
#include <kimodo/anim/clip.hpp>
#include <kimodo/anim/gltf.hpp>
#include <kimodo/anim/gltf_export.hpp>
#include <kimodo/anim/ik.hpp>
#include <kimodo/anim/keyframes.hpp>
#include <kimodo/anim/control_rig.hpp>
#include <kimodo/anim/layers.hpp>
#include <kimodo/anim/loop.hpp>
#include <kimodo/anim/retarget.hpp>
#include <kimodo/anim/root_motion.hpp>
#include <kimodo/anim/skeleton.hpp>

#include <algorithm>
#include <cmath>
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
                 "           [--seamless [--seamless-blend FRAMES] [--seamless-cut MIN_FRACTION]]   loopable clip\n"
                 "           [--timing distance|duration|speed] [--duration S] [--speed M_PER_S] [--no-orient]\n"
                 "       IN_DIR/OUT_DIR hold root_positions.f32 + local_rotations_xyzw.f32; path mode also\n"
                 "       writes OUT_DIR/path_samples.f32 ([N,3], the evaluated curve for display).\n"
                 "       kmd-anim map smplx22|soma30|g1skel34 TARGET.glb [--mapping FILE] [--skin N]\n"
                 "       kmd-anim retarget MOTION_DIR TARGET.glb OUT_DIR [--mapping FILE] [--save-mapping FILE]\n"
                 "           [--root-scale S] [--yaw DEG] [--no-auto-facing] [--align-rest] [--skin N] [--fps N]\n"
                 "           [--reference-pose POSE.json] [--rest-pose]   (reference pose: the character's T-pose, replaces --align-rest)\n"
                 "       retarget writes OUT_DIR/retarget.json, local_rotations_xyzw.f32 [T,J,4] and\n"
                 "       local_translations.f32 [T,J,3] in the target's joint order. --rest-pose retargets one\n"
                 "       frame of the source's rest pose (T-pose) instead of the motion (with --align-rest: the\n"
                 "       character in the T-pose the retargeting works from).\n"
                 "       kmd-anim layers OUT_DIR (--native KEY | --character FILE.glb [--skin N]) [--fps N] [--length S]\n"
                 "           [--control-rig RIG.json]   IK arms / legs (control_rig.hpp) after the layers\n"
                 "           --layer DIR [--name S] [--mode override|additive] [--weight W]\n"
                 "                       [--mask full|upper|lower|MASK.json] [--disabled] [--muted]\n"
                 "                       [--reference first|rest|FRAME] [--wrap clamp|loop]  (repeat per layer)\n"
                 "           --key-layer KEYS.json [same layer options]   keyframe layer: additive offsets; with --mode\n"
                 "                       override the keyed channels replace the pose (rest * offset)\n"
                 "           clip timing per layer: [--start S] [--trim-in S] [--trim-out S] [--speed X] [--repeat N]\n"
                 "                       [--extend hold|none] [--fade-in S] [--fade-out S] [--ease-fades] [--empty-before] [--end S] [--align-root]\n"
                 "       DIR is a clip directory (clip.json/retarget.json) or a native motion directory;\n"
                 "       layers are applied bottom to top in command-line order. OUT_DIR gets clip.json,\n"
                 "       local_rotations_xyzw.f32, local_translations.f32 (+ root_positions.f32 if --native).\n"
                 "       kmd-anim export CHARACTER.glb|.gltf CLIP_DIR OUT.glb [--name S] [--replace-animations]\n"
                 "           [--export-scale] [--skin N]\n"
                 "       CLIP_DIR is a retarget or layers output for that character; the character's meshes,\n"
                 "       materials, skins and existing animations are kept and the clip is added.\n"
                 "       kmd-anim masks (--native KEY | --character FILE.glb)   preset masks (full/upper/lower) as JSON\n"
                 "       kmd-anim footlock IN_DIR OUT_DIR [--character FILE.glb] [--foot-height M] [--foot-speed M_PER_S]\n"
                 "           [--foot-blend FRAMES] [--no-hip-adjust]\n"
                 "       (layers also accepts --foot-lock plus the same --foot-* options, applied after baking)\n";
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
    std::optional<LoopOptions> seamless; // make the clip loopable before the root motion
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
        } else if (arg == "--seamless") {
            if (!seamless) seamless.emplace();
        } else if (arg == "--seamless-blend") {
            if (!seamless) seamless.emplace();
            const int b = std::stoi(std::string(value()));
            if (b < 0 || b > 100000) throw std::runtime_error("--seamless-blend must be 0 or more frames");
            seamless->blend = static_cast<std::size_t>(b);
        } else if (arg == "--seamless-cut") {
            if (!seamless) seamless.emplace();
            seamless->cut = true;
            seamless->min_length = std::stof(std::string(value()));
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
    std::string loop_meta;
    if (seamless) {
        auto r = make_loopable(*clip, *skeleton, *seamless);
        if (!r) throw std::runtime_error(r.error());
        loop_meta = ",\"seamless\":{\"start\":" + std::to_string(r->start) + ",\"end\":" + std::to_string(r->end) +
                    ",\"blend\":" + std::to_string(r->blend) + ",\"seam_degrees_before\":" + num(r->seam_degrees_before) +
                    ",\"seam_root_before\":" + num(r->seam_root_before) + ",\"seam_degrees_after\":" + num(r->seam_degrees_after) + "}";
    }
    if (auto ok = apply_root_motion(*clip, settings); !ok) throw std::runtime_error(ok.error());
    if (auto ok = write_motion_dir(out, clip_to_motion(*clip)); !ok) throw std::runtime_error(ok.error());
    if (!loop_meta.empty()) { // the loop report for editors (without the leading comma and key)
        std::ofstream f(out / "seamless.json", std::ios::binary | std::ios::trunc);
        f << loop_meta.substr(std::string(",\"seamless\":").size()) << "\n";
        if (!f) throw std::runtime_error("cannot write seamless.json");
    }
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
    std::cout << "{\"frames\":" << clip->frames() << ",\"joints\":" << motion->joints
              << ",\"skeleton\":" << quote(skeleton->source) << loop_meta << "}\n";
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
    auto d = check_mapping(mapping, *source, character->skeleton);
    d.warnings.insert(d.warnings.begin(), character->warnings.begin(), character->warnings.end());
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
    bool rest_pose = false;
    for (int i = 5; i < argc; ++i) {
        const std::string_view arg = argv[i];
        auto value = [&]() -> std::string {
            if (i + 1 >= argc) throw std::runtime_error(std::string(arg) + " needs a value");
            return argv[++i];
        };
        if (arg == "--rest-pose") rest_pose = true;
        else if (arg == "--mapping") mapping_file = value();
        else if (arg == "--save-mapping") save_file = value();
        else if (arg == "--root-scale") options.root_scale = std::stof(value());
        else if (arg == "--yaw") options.yaw_offset_degrees = std::stof(value());
        else if (arg == "--no-auto-facing") options.auto_facing = false;
        else if (arg == "--align-rest") options.align_rest_directions = true;
        else if (arg == "--reference-pose") {
            auto pose = load_reference_pose(value());
            if (!pose) throw std::runtime_error(pose.error());
            options.reference_pose = std::move(*pose);
        } else if (arg == "--skin") import.skin = std::stoi(value());
        else if (arg == "--fps") fps = std::stof(value());
        else throw std::runtime_error("unknown option '" + std::string(arg) + "'");
    }
    auto motion = read_motion_dir(motion_dir);
    if (!motion) throw std::runtime_error(motion.error());
    auto source = native_skeleton_for_joint_count(motion->joints);
    if (!source) throw std::runtime_error(source.error());
    auto clip = clip_from_motion(*source, *motion, fps);
    if (!clip) throw std::runtime_error(clip.error());
    if (rest_pose) {
        // One frame of the source's rest pose (the native skeletons' rest is a T-pose): with
        // --align-rest this is the character in the pose the retargeting works from.
        clip->locals.assign(clip->locals.begin(), clip->locals.begin() + static_cast<std::ptrdiff_t>(clip->joint_count));
        for (std::size_t j = 0; j < clip->joint_count; ++j) clip->locals[j] = source->joints[j].rest_local;
        clip->locals[0].translation = clip_from_motion(*source, *motion, fps)->locals[0].translation;
    }
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
    result->diagnostics.warnings.insert(result->diagnostics.warnings.begin(), character->warnings.begin(), character->warnings.end());

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
// Parses a --foot-* option at argv[i]; returns false if argv[i] is not one.
bool parse_foot_option(int argc, char **argv, int &i, FootLockOptions &o) {
    const std::string_view arg = argv[i];
    auto value = [&]() -> std::string {
        if (i + 1 >= argc) throw std::runtime_error(std::string(arg) + " needs a value");
        return argv[++i];
    };
    if (arg == "--foot-height") o.height_threshold = std::stof(value());
    else if (arg == "--foot-speed") o.speed_threshold = std::stof(value());
    else if (arg == "--foot-blend") o.blend_frames = static_cast<std::size_t>(std::stoul(value()));
    else if (arg == "--no-hip-adjust") o.adjust_hips = false;
    else return false;
    return true;
}

std::string foot_lock_json(const FootLockResult &r) {
    std::ostringstream o;
    o << "{\"contacts\":[";
    for (std::size_t i = 0; i < r.contacts.size(); ++i) {
        const FootContact &c = r.contacts[i];
        o << (i ? "," : "") << "{\"foot\":\"" << (c.foot == 0 ? "left" : "right") << "\",\"start\":" << c.start
          << ",\"end\":" << c.end << ",\"position\":" << vec(c.position) << "}";
    }
    o << "],\"ground\":" << num(r.ground) << ",\"leg_length\":" << num(r.leg_length) << ",\"height_threshold\":"
      << num(r.height_threshold) << ",\"speed_threshold\":" << num(r.speed_threshold) << ",\"slide_before\":"
      << num(r.slide_before) << ",\"slide_after\":" << num(r.slide_after) << ",\"unreachable_frames\":"
      << r.unreachable_frames << ",\"max_hip_drop\":" << num(r.max_hip_drop) << "}";
    return o.str();
}

// Reads a layer input: a clip directory (clip.json / retarget.json) or a native motion directory.
std::expected<AnimationClip, std::string> read_layer_input(const std::filesystem::path &dir, float fps) {
    if (std::filesystem::exists(dir / "clip.json") || std::filesystem::exists(dir / "retarget.json")) return read_clip_dir(dir);
    auto motion = read_motion_dir(dir);
    if (!motion) return std::unexpected(motion.error());
    auto skeleton = native_skeleton_for_joint_count(motion->joints);
    if (!skeleton) return std::unexpected(skeleton.error());
    return clip_from_motion(*skeleton, *motion, fps);
}

int layers_command(int argc, char **argv) {
    if (argc < 3) return usage();
    const std::filesystem::path out = argv[2];
    std::optional<Skeleton> skeleton;
    bool native = false;
    float fps = 0.F, input_fps = 30.F, length = 0.F;
    std::optional<ControlRig> control_rig;
    struct Pending {
        AnimationLayer layer;
        std::filesystem::path dir;
        std::filesystem::path keys; // keyframe layer (JSON) instead of a motion directory
        std::string mask = "full";
        std::string reference = "first";
        bool mode_set = false; // --mode given (keyframe layers default to additive)
    };
    std::vector<Pending> pending;
    GltfImportOptions import;
    std::optional<std::filesystem::path> character;
    bool lock_feet = false;
    FootLockOptions foot;
    for (int i = 3; i < argc; ++i) {
        const std::string_view arg = argv[i];
        if (arg == "--foot-lock") { lock_feet = true; continue; }
        if (parse_foot_option(argc, argv, i, foot)) continue;
        auto value = [&]() -> std::string {
            if (i + 1 >= argc) throw std::runtime_error(std::string(arg) + " needs a value");
            return argv[++i];
        };
        auto current = [&]() -> Pending & {
            if (pending.empty()) throw std::runtime_error(std::string(arg) + " must follow --layer");
            return pending.back();
        };
        if (arg == "--native") {
            auto s = native_skeleton(value());
            if (!s) throw std::runtime_error(s.error());
            skeleton = std::move(*s);
            native = true;
        } else if (arg == "--character") {
            character = value();
        } else if (arg == "--skin") {
            import.skin = std::stoi(value());
        } else if (arg == "--fps") {
            fps = std::stof(value());
        } else if (arg == "--input-fps") {
            input_fps = std::stof(value());
        } else if (arg == "--control-rig") {
            auto r = load_control_rig(value());
            if (!r) throw std::runtime_error(r.error());
            control_rig = std::move(*r);
        } else if (arg == "--length") {
            length = std::stof(value());
            if (!(length >= 0.F) || length > 3600.F) throw std::runtime_error("--length must be in [0, 3600] seconds");
        } else if (arg == "--layer" || arg == "--key-layer") {
            Pending p;
            (arg == "--layer" ? p.dir : p.keys) = value();
            p.layer.name = "layer " + std::to_string(pending.size() + 1);
            pending.push_back(std::move(p));
        } else if (arg == "--name") {
            current().layer.name = value();
        } else if (arg == "--mode") {
            const std::string m = value();
            current().mode_set = true;
            if (m == "override") current().layer.mode = BlendMode::Override;
            else if (m == "additive") current().layer.mode = BlendMode::Additive;
            else throw std::runtime_error("unknown blend mode '" + m + "'");
        } else if (arg == "--weight") {
            current().layer.weight = std::stof(value());
        } else if (arg == "--mask") {
            current().mask = value();
        } else if (arg == "--disabled") {
            current().layer.enabled = false;
        } else if (arg == "--muted") {
            current().layer.muted = true;
        } else if (arg == "--reference") {
            current().reference = value();
        } else if (arg == "--wrap") {
            const std::string w = value();
            if (w == "clamp") current().layer.wrap = TimeWrap::Clamp;
            else if (w == "loop") current().layer.wrap = TimeWrap::Loop;
            else throw std::runtime_error("unknown wrap '" + w + "'");
        } else if (arg == "--start") {
            current().layer.timing.start = std::stof(value());
        } else if (arg == "--trim-in") {
            current().layer.timing.trim_in = std::stof(value());
        } else if (arg == "--trim-out") {
            current().layer.timing.trim_out = std::stof(value());
        } else if (arg == "--speed") {
            current().layer.timing.speed = std::stof(value());
        } else if (arg == "--repeat") {
            current().layer.timing.repeat = std::stoi(value());
        } else if (arg == "--extend") {
            const std::string x = value();
            if (x == "hold") current().layer.timing.extend = Extend::Hold;
            else if (x == "none") current().layer.timing.extend = Extend::None;
            else throw std::runtime_error("unknown extend '" + x + "'");
        } else if (arg == "--fade-in") {
            current().layer.timing.fade_in = std::stof(value());
        } else if (arg == "--fade-out") {
            current().layer.timing.fade_out = std::stof(value());
        } else if (arg == "--end") {
            current().layer.timing.end = std::stof(value());
        } else if (arg == "--align-root") {
            current().layer.timing.align_root = true;
        } else if (arg == "--ease-fades") {
            current().layer.timing.ease_fades = true;
        } else if (arg == "--empty-before") {
            current().layer.timing.empty_before = true;
        } else {
            throw std::runtime_error("unknown option '" + std::string(arg) + "'");
        }
    }
    if (character) {
        auto c = load_gltf_character(*character, import);
        if (!c) throw std::runtime_error(c.error());
        skeleton = std::move(c->skeleton);
        native = false;
    }
    if (!skeleton) throw std::runtime_error("--native KEY or --character FILE.glb is required");
    if (pending.empty()) throw std::runtime_error("at least one --layer is required");

    AnimationStack stack(*skeleton);
    std::ostringstream summary;
    summary << "[";
    for (std::size_t i = 0; i < pending.size(); ++i) {
        Pending &p = pending[i];
        std::string layer_warnings;
        if (!p.keys.empty()) {
            // Keyframe layer: offset curves sampled on the stack skeleton, applied additively
            // against the rest pose (so unkeyed joints and zero offsets change nothing).
            auto tracks = load_keyframes(p.keys);
            if (!tracks) throw std::runtime_error(p.layer.name + ": " + tracks.error());
            auto kc = keyframe_clip(*tracks, *skeleton);
            if (!kc) throw std::runtime_error(p.layer.name + ": " + kc.error());
            p.layer.clip = std::move(kc->clip);
            if (!tracks->weight.keys.empty()) { // keyable layer weight, sampled per layer frame
                const float last = tracks->weight.keys.back().frame;
                p.layer.weight_fps = tracks->fps;
                p.layer.weight_samples.resize(static_cast<std::size_t>(std::ceil(last)) + 1);
                for (std::size_t k = 0; k < p.layer.weight_samples.size(); ++k)
                    p.layer.weight_samples[k] = std::clamp(tracks->weight.evaluate(static_cast<float>(k)), 0.F, 1.F);
            }
            // Additive (default): offsets on top of the layers below. Override (--mode override):
            // keyed joints take rest * offset, only in the channels they have keys for.
            if (p.layer.mode == BlendMode::Override && p.mode_set) p.layer.channels = std::move(kc->channels);
            else p.layer.mode = BlendMode::Additive;
            p.reference = "rest";
            layer_warnings = string_list(kc->warnings);
        } else {
            auto clip = read_layer_input(p.dir, input_fps);
            if (!clip) throw std::runtime_error(p.layer.name + ": " + clip.error());
            p.layer.clip = std::move(*clip);
        }
        if (p.mask == "full") p.layer.mask = full_body_mask();
        else if (p.mask == "upper") p.layer.mask = upper_body_mask(*skeleton);
        else if (p.mask == "lower") p.layer.mask = lower_body_mask(*skeleton);
        else {
            auto m = load_mask(p.mask);
            if (!m) throw std::runtime_error(p.layer.name + ": " + m.error());
            p.layer.mask = std::move(*m);
        }
        if (p.reference == "first") p.layer.reference = AdditiveReference::FirstFrame;
        else if (p.reference == "rest") p.layer.reference = AdditiveReference::RestPose;
        else {
            p.layer.reference = AdditiveReference::Frame;
            p.layer.reference_frame = static_cast<std::size_t>(std::stoul(p.reference));
        }
        const AnimationLayer &l = p.layer;
        summary << (i ? "," : "") << "{\"name\":" << quote(l.name) << ",\"frames\":" << l.clip.frames()
                << ",\"fps\":" << num(l.clip.fps) << ",\"duration\":" << num(l.clip.duration()) << ",\"mode\":\""
                << (l.mode == BlendMode::Override ? "override" : "additive") << "\",\"weight\":" << num(l.weight)
                << ",\"enabled\":" << (l.enabled ? "true" : "false") << ",\"muted\":" << (l.muted ? "true" : "false")
                << ",\"mask\":" << quote(l.mask.name) << ",\"keys\":" << (p.keys.empty() ? "false" : "true")
                << ",\"start\":" << num(l.timing.start) << ",\"speed\":" << num(l.timing.speed)
                << ",\"repeat\":" << l.timing.repeat
                << (layer_warnings.empty() ? "" : ",\"warnings\":" + layer_warnings) << "}";
        if (auto ok = stack.add_layer(std::move(p.layer)); !ok) throw std::runtime_error(ok.error());
    }
    summary << "]";
    AnimationClip baked = stack.bake(fps, length);
    std::string rig_meta;
    std::vector<float> controls; // per-frame control values (control_rig.f32) for editors
    if (control_rig) { // IK limbs, after the layers and before foot locking
        auto r = apply_control_rig(baked, *skeleton, *control_rig);
        if (!r) throw std::runtime_error(r.error());
        std::vector<std::string> limb_names;
        for (const IkLimb &l : control_rig->limbs) limb_names.push_back(l.name);
        rig_meta = ",\"control_rig\":{\"solved\":" + string_list(r->solved) + ",\"warnings\":" + string_list(r->warnings) +
                   ",\"unreachable_frames\":" + std::to_string(r->unreachable_frames) + ",\"limbs\":" + string_list(limb_names) +
                   ",\"stride\":" + std::to_string(r->stride) + ",\"controls\":\"control_rig.f32\"}";
        controls = std::move(r->controls);
    }
    std::string foot_meta;
    if (lock_feet) {
        auto locked = foot_lock(baked, *skeleton, foot);
        if (!locked) throw std::runtime_error("foot lock: " + locked.error());
        baked = std::move(locked->clip);
        foot_meta = ",\"foot_lock\":" + foot_lock_json(*locked);
    }
    const std::string extra = "{\"skeleton\":" + quote(skeleton->source) + ",\"duration\":" + num(stack.duration()) + ",\"length\":" + num(length) +
                              ",\"layers\":" + summary.str() + rig_meta + foot_meta + "}";
    if (auto ok = write_clip_dir(out, baked, *skeleton, extra); !ok) throw std::runtime_error(ok.error());
    if (control_rig) {
        std::ofstream f(out / "control_rig.f32", std::ios::binary);
        f.write(reinterpret_cast<const char *>(controls.data()), static_cast<std::streamsize>(controls.size() * sizeof(float)));
        if (!f) throw std::runtime_error("cannot write control_rig.f32");
    }
    if (native) // also the kmd-generate layout, so native results play like any generated motion
        if (auto ok = write_motion_dir(out, clip_to_motion(baked)); !ok) throw std::runtime_error(ok.error());
    std::ifstream meta(out / "clip.json", std::ios::binary);
    std::cout << meta.rdbuf();
    return 0;
}
// Preset masks for a skeleton, so editors start from exactly what --mask upper/lower mean.
int masks_command(int argc, char **argv) {
    if (argc != 4) return usage();
    const std::string_view kind = argv[2];
    std::optional<Skeleton> skeleton;
    if (kind == "--native") {
        auto s = native_skeleton(argv[3]);
        if (!s) throw std::runtime_error(s.error());
        skeleton = std::move(*s);
    } else if (kind == "--character") {
        auto c = load_gltf_character(argv[3]);
        if (!c) throw std::runtime_error(c.error());
        skeleton = std::move(c->skeleton);
    } else {
        return usage();
    }
    auto compact = [](std::string s) {
        while (!s.empty() && (s.back() == '\n' || s.back() == ' ')) s.pop_back();
        return s;
    };
    std::cout << "{\"skeleton\":" << quote(skeleton->source) << ",\"full\":" << compact(mask_to_json(full_body_mask()))
              << ",\"upper\":" << compact(mask_to_json(upper_body_mask(*skeleton)))
              << ",\"lower\":" << compact(mask_to_json(lower_body_mask(*skeleton))) << "}\n";
    return 0;
}

int footlock_command(int argc, char **argv) {
    if (argc < 4) return usage();
    const std::filesystem::path in = argv[2], out = argv[3];
    FootLockOptions options;
    std::optional<std::filesystem::path> character;
    for (int i = 4; i < argc; ++i) {
        const std::string_view arg = argv[i];
        if (arg == "--character" && i + 1 < argc) character = argv[++i];
        else if (!parse_foot_option(argc, argv, i, options)) throw std::runtime_error("unknown option '" + std::string(arg) + "'");
    }
    auto clip = read_layer_input(in, 30.F);
    if (!clip) throw std::runtime_error(clip.error());
    std::optional<Skeleton> skeleton;
    if (character) {
        auto c = load_gltf_character(*character);
        if (!c) throw std::runtime_error(c.error());
        skeleton = std::move(c->skeleton);
    } else {
        auto s = native_skeleton_for_joint_count(clip->joint_count);
        if (!s) throw std::runtime_error(s.error() + " (pass --character for a character clip)");
        skeleton = std::move(*s);
    }
    auto r = foot_lock(*clip, *skeleton, options);
    if (!r) throw std::runtime_error(r.error());
    const std::string meta = "{\"skeleton\":" + quote(skeleton->source) + ",\"foot_lock\":" + foot_lock_json(*r) + "}";
    if (auto ok = write_clip_dir(out, r->clip, *skeleton, meta); !ok) throw std::runtime_error(ok.error());
    if (!character)
        if (auto ok = write_motion_dir(out, clip_to_motion(r->clip)); !ok) throw std::runtime_error(ok.error());
    std::cout << meta << "\n";
    return 0;
}

int export_command(int argc, char **argv) {
    if (argc < 5) return usage();
    const std::filesystem::path character_path = argv[2], clip_dir = argv[3], out = argv[4];
    GltfExportOptions options;
    GltfImportOptions import;
    for (int i = 5; i < argc; ++i) {
        const std::string_view arg = argv[i];
        if (arg == "--name" && i + 1 < argc) options.animation_name = argv[++i];
        else if (arg == "--replace-animations") options.replace_animations = true;
        else if (arg == "--export-scale") options.export_scale = true;
        else if (arg == "--skin" && i + 1 < argc) import.skin = std::stoi(argv[++i]);
        else throw std::runtime_error("unknown option '" + std::string(arg) + "'");
    }
    auto character = load_gltf_character(character_path, import);
    if (!character) throw std::runtime_error(character.error());
    auto clip = read_clip_dir(clip_dir);
    if (!clip) throw std::runtime_error(clip.error());
    auto report = export_gltf_animation(character_path, character->skeleton, *clip, out, options);
    if (!report) throw std::runtime_error(report.error());
    // The written file must load again as the same character.
    auto again = load_gltf_character(out, import);
    if (!again) throw std::runtime_error("exported file does not reload: " + again.error());
    std::vector<std::string> warnings = report->warnings;
    std::cout << "{\"output\":" << quote(out.string()) << ",\"animation\":" << quote(options.animation_name)
              << ",\"frames\":" << report->frames << ",\"duration\":" << num(report->duration)
              << ",\"channels\":" << report->channels << ",\"animations\":" << report->animations
              << ",\"embedded_files\":" << report->embedded_files << ",\"joints\":" << again->skeleton.size()
              << ",\"meshes\":" << again->meshes << ",\"skins\":" << again->skins << ",\"warnings\":" << string_list(warnings)
              << "}\n";
    return 0;
}
} // namespace

int main(int argc, char **argv) try {
    if (argc >= 2 && std::string_view(argv[1]) == "root-motion") return root_motion(argc, argv);
    if (argc >= 2 && std::string_view(argv[1]) == "map") return map_command(argc, argv);
    if (argc >= 2 && std::string_view(argv[1]) == "retarget") return retarget_command(argc, argv);
    if (argc >= 2 && std::string_view(argv[1]) == "layers") return layers_command(argc, argv);
    if (argc >= 2 && std::string_view(argv[1]) == "export") return export_command(argc, argv);
    if (argc >= 2 && std::string_view(argv[1]) == "footlock") return footlock_command(argc, argv);
    if (argc >= 2 && std::string_view(argv[1]) == "masks") return masks_command(argc, argv);
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
    std::cout << "{\"warnings\":" << string_list(c->warnings) << ",\"ignored_roots\":" << string_list(c->ignored_roots)
              << ",\"meshes\":" << c->meshes << ",\"skinned_meshes\":" << c->skinned_meshes
              << ",\"materials\":" << c->materials << ",\"skins\":" << c->skins << ",\"animations\":[";
    for (std::size_t i = 0; i < c->animations.size(); ++i) std::cout << (i ? "," : "") << quote(c->animations[i]);
    std::cout << "],\"skeleton\":" << skeleton_json(c->skeleton) << "}\n";
    return 0;
} catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
}
