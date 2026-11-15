// kmd-anim: Kimodo Extended post-processing tool.
//   kmd-anim inspect CHARACTER.glb [--skin N]   skeleton of a rigged glTF/GLB as JSON
//   kmd-anim inspect --native KEY               native Kimodo skeleton (smplx22|soma30|g1skel34)
#include <kimodo/anim/gltf.hpp>
#include <kimodo/anim/skeleton.hpp>

#include <cstdio>
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
                 "       kmd-anim inspect --native smplx22|soma30|g1skel34\n";
    return 2;
}
} // namespace

int main(int argc, char **argv) try {
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
