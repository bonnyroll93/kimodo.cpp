#include <kimodo/anim/gltf_export.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iterator>
#include <optional>
#include <unordered_map>

namespace kimodo::anim {
namespace {

using json = nlohmann::ordered_json;
using bytes = std::vector<std::uint8_t>;

std::expected<bytes, std::string> read_file(const std::filesystem::path &path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return std::unexpected("cannot open " + path.string());
    return bytes(std::istreambuf_iterator<char>(in), {});
}

std::uint32_t u32(const bytes &b, std::size_t at) {
    std::uint32_t v;
    std::memcpy(&v, b.data() + at, 4);
    return v; // glTF is little-endian; so are all supported targets
}

std::expected<bytes, std::string> base64(std::string_view text) {
    static constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    bytes out;
    std::uint32_t acc = 0;
    int bits = 0;
    for (const char c : text) {
        if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
        const auto pos = alphabet.find(c);
        if (pos == std::string_view::npos) return std::unexpected("invalid base64 data URI");
        acc = (acc << 6) | static_cast<std::uint32_t>(pos);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<std::uint8_t>((acc >> bits) & 0xFF));
        }
    }
    return out;
}

std::string percent_decode(std::string_view s) {
    std::string out;
    for (std::size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size() && std::isxdigit(static_cast<unsigned char>(s[i + 1])) &&
            std::isxdigit(static_cast<unsigned char>(s[i + 2]))) {
            out.push_back(static_cast<char>(std::stoi(std::string(s.substr(i + 1, 2)), nullptr, 16)));
            i += 2;
        } else {
            out.push_back(s[i]);
        }
    }
    return out;
}

struct UriData {
    bytes data;
    std::string mime; // from a data URI header, if any
};

// data: URIs are decoded; anything else is a path relative to the source file's directory.
std::expected<UriData, std::string> resolve_uri(std::string_view uri, const std::filesystem::path &base) {
    if (uri.starts_with("data:")) {
        const auto comma = uri.find(',');
        if (comma == std::string_view::npos || uri.substr(0, comma).find(";base64") == std::string_view::npos)
            return std::unexpected("only base64 data URIs are supported");
        auto data = base64(uri.substr(comma + 1));
        if (!data) return std::unexpected(data.error());
        const auto semi = uri.find(';');
        return UriData{std::move(*data), std::string(uri.substr(5, semi - 5))};
    }
    if (uri.find("://") != std::string_view::npos) return std::unexpected("remote URI not supported: " + std::string(uri));
    const auto path = base / std::filesystem::path(percent_decode(uri));
    auto data = read_file(path);
    if (!data) return std::unexpected(data.error());
    return UriData{std::move(*data), {}};
}

std::string image_mime(const std::filesystem::path &uri_path) {
    auto ext = uri_path.extension().string();
    std::ranges::transform(ext, ext.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (ext == ".png") return "image/png";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".webp") return "image/webp";
    if (ext == ".ktx2") return "image/ktx2";
    return "application/octet-stream";
}

void align4(bytes &b, std::uint8_t pad = 0) {
    while (b.size() % 4) b.push_back(pad);
}

Mat4 multiply(const Mat4 &a, const Mat4 &b) {
    Mat4 r;
    for (int c = 0; c < 4; ++c)
        for (int row = 0; row < 4; ++row) {
            float s = 0.F;
            for (int k = 0; k < 4; ++k) s += a.m[k * 4 + row] * b.m[c * 4 + k];
            r.m[c * 4 + row] = s;
        }
    return r;
}

// General affine inverse (3x3 inverse + translation).
Mat4 invert(const Mat4 &m) {
    const float *a = m.m;
    const float c00 = a[5] * a[10] - a[9] * a[6], c01 = a[9] * a[2] - a[1] * a[10], c02 = a[1] * a[6] - a[5] * a[2];
    const float c10 = a[8] * a[6] - a[4] * a[10], c11 = a[0] * a[10] - a[8] * a[2], c12 = a[4] * a[2] - a[0] * a[6];
    const float c20 = a[4] * a[9] - a[8] * a[5], c21 = a[8] * a[1] - a[0] * a[9], c22 = a[0] * a[5] - a[4] * a[1];
    const float det = a[0] * c00 + a[4] * c01 + a[8] * c02;
    Mat4 r;
    if (std::fabs(det) < 1.e-20F) return r;
    const float inv = 1.F / det;
    // Column-major: r[col*4+row].
    r.m[0] = c00 * inv; r.m[1] = c01 * inv; r.m[2] = c02 * inv;
    r.m[4] = c10 * inv; r.m[5] = c11 * inv; r.m[6] = c12 * inv;
    r.m[8] = c20 * inv; r.m[9] = c21 * inv; r.m[10] = c22 * inv;
    r.m[3] = r.m[7] = r.m[11] = 0.F;
    r.m[12] = -(r.m[0] * a[12] + r.m[4] * a[13] + r.m[8] * a[14]);
    r.m[13] = -(r.m[1] * a[12] + r.m[5] * a[13] + r.m[9] * a[14]);
    r.m[14] = -(r.m[2] * a[12] + r.m[6] * a[13] + r.m[10] * a[14]);
    r.m[15] = 1.F;
    return r;
}

Mat4 node_local(const json &node) {
    if (node.contains("matrix")) {
        Mat4 m;
        for (int i = 0; i < 16; ++i) m.m[i] = node["matrix"][static_cast<std::size_t>(i)].get<float>();
        return m;
    }
    Transform t;
    if (node.contains("translation"))
        t.translation = {node["translation"][0].get<float>(), node["translation"][1].get<float>(), node["translation"][2].get<float>()};
    if (node.contains("rotation"))
        t.rotation = normalize(Quat{node["rotation"][0].get<float>(), node["rotation"][1].get<float>(),
                                    node["rotation"][2].get<float>(), node["rotation"][3].get<float>()});
    if (node.contains("scale")) t.scale = {node["scale"][0].get<float>(), node["scale"][1].get<float>(), node["scale"][2].get<float>()};
    return to_matrix(t);
}

template <class T> void append_pod(bytes &b, const T &v) {
    const auto *p = reinterpret_cast<const std::uint8_t *>(&v);
    b.insert(b.end(), p, p + sizeof(T));
}

} // namespace

std::expected<GltfExportReport, std::string> export_gltf_animation(const std::filesystem::path &source,
                                                                   const Skeleton &skeleton, const AnimationClip &clip,
                                                                   const std::filesystem::path &output,
                                                                   const GltfExportOptions &options) {
    GltfExportReport report;
    if (clip.frames() == 0) return std::unexpected("clip has no frames");
    if (!(clip.fps > 0.F)) return std::unexpected("clip fps must be positive");

    // ---- read the container --------------------------------------------------------
    auto file = read_file(source);
    if (!file) return std::unexpected(file.error());
    json doc;
    std::optional<bytes> glb_bin;
    try {
        if (file->size() >= 12 && std::memcmp(file->data(), "glTF", 4) == 0) {
            if (u32(*file, 4) != 2) return std::unexpected("only glTF 2.0 binary files are supported");
            std::size_t at = 12;
            while (at + 8 <= file->size()) {
                const std::uint32_t len = u32(*file, at), type = u32(*file, at + 4);
                if (at + 8 + len > file->size()) return std::unexpected("truncated GLB chunk");
                const auto *data = file->data() + at + 8;
                if (type == 0x4E4F534A) doc = json::parse(data, data + len);         // JSON
                else if (type == 0x004E4942 && !glb_bin) glb_bin = bytes(data, data + len); // BIN
                at += 8 + len;
            }
            if (doc.is_null()) return std::unexpected("GLB has no JSON chunk");
        } else {
            doc = json::parse(file->begin(), file->end());
        }
    } catch (const json::exception &e) {
        return std::unexpected(std::string("invalid glTF JSON: ") + e.what());
    }
    const auto base_dir = source.parent_path();

    // ---- merge every buffer into one BIN --------------------------------------------
    bytes bin;
    std::vector<std::size_t> buffer_offset;
    for (std::size_t i = 0; i < doc.value("buffers", json::array()).size(); ++i) {
        const json &buf = doc["buffers"][i];
        bytes data;
        if (buf.contains("uri")) {
            auto r = resolve_uri(buf["uri"].get<std::string>(), base_dir);
            if (!r) return std::unexpected("buffer " + std::to_string(i) + ": " + r.error());
            data = std::move(r->data);
            ++report.embedded_files;
        } else if (i == 0 && glb_bin) {
            data = *glb_bin;
        } else {
            return std::unexpected("buffer " + std::to_string(i) + " has no data");
        }
        const std::size_t declared = buf.value("byteLength", data.size());
        if (data.size() < declared) return std::unexpected("buffer " + std::to_string(i) + " is shorter than its byteLength");
        data.resize(declared);
        align4(bin);
        buffer_offset.push_back(bin.size());
        bin.insert(bin.end(), data.begin(), data.end());
    }
    if (!doc.contains("bufferViews")) doc["bufferViews"] = json::array();
    for (json &view : doc["bufferViews"]) {
        const auto b = view.value("buffer", 0);
        if (b < 0 || static_cast<std::size_t>(b) >= buffer_offset.size()) return std::unexpected("bufferView references a missing buffer");
        view["byteOffset"] = view.value("byteOffset", std::size_t{0}) + buffer_offset[static_cast<std::size_t>(b)];
        view["buffer"] = 0;
    }
    auto add_view = [&](const bytes &data, std::optional<int> target = std::nullopt) {
        align4(bin);
        json view{{"buffer", 0}, {"byteOffset", bin.size()}, {"byteLength", data.size()}};
        if (target) view["target"] = *target;
        bin.insert(bin.end(), data.begin(), data.end());
        doc["bufferViews"].push_back(std::move(view));
        return doc["bufferViews"].size() - 1;
    };
    // External / data-URI images become bufferView images.
    if (doc.contains("images"))
        for (json &image : doc["images"]) {
            if (!image.contains("uri")) continue;
            const auto uri = image["uri"].get<std::string>();
            auto r = resolve_uri(uri, base_dir);
            if (!r) {
                report.warnings.push_back("image '" + uri + "' kept as an external reference: " + r.error());
                continue;
            }
            image["bufferView"] = add_view(r->data);
            image["mimeType"] = !r->mime.empty() ? r->mime : image.value("mimeType", image_mime(percent_decode(uri)));
            image.erase("uri");
            ++report.embedded_files;
        }

    // ---- node hierarchy and joint resolution -----------------------------------------
    const json &nodes = doc.value("nodes", json::array());
    const std::size_t node_count = nodes.size();
    std::vector<int> node_parent(node_count, -1);
    for (std::size_t n = 0; n < node_count; ++n)
        for (const auto &c : nodes[n].value("children", json::array())) {
            const auto ci = c.get<std::size_t>();
            if (ci < node_count) node_parent[ci] = static_cast<int>(n);
        }
    std::vector<int> track_of(skeleton.size(), -1); // skeleton joint -> clip track
    if (clip.joint_names.empty()) {
        if (clip.joint_count != skeleton.size()) return std::unexpected("unnamed clip must have one track per joint");
        for (std::size_t j = 0; j < skeleton.size(); ++j) track_of[j] = static_cast<int>(j);
    } else {
        std::unordered_map<std::string_view, int> by_name;
        for (std::size_t i = 0; i < clip.joint_names.size(); ++i) by_name.emplace(clip.joint_names[i], static_cast<int>(i));
        for (std::size_t j = 0; j < skeleton.size(); ++j)
            if (auto it = by_name.find(skeleton.joints[j].name); it != by_name.end()) track_of[j] = it->second;
    }
    for (const Joint &j : skeleton.joints)
        if (j.source_node < 0 || static_cast<std::size_t>(j.source_node) >= node_count)
            return std::unexpected("skeleton joint '" + j.name + "' has no node in " + source.string());

    // Static transform from a joint's skeleton parent node down to its glTF parent node
    // (identity when they coincide; the whole ancestor chain for the root).
    std::vector<std::optional<Mat4>> chain(skeleton.size());
    for (std::size_t j = 0; j < skeleton.size(); ++j) {
        const int node = skeleton.joints[j].source_node, pj = skeleton.joints[j].parent;
        const int stop = pj >= 0 ? skeleton.joints[static_cast<std::size_t>(pj)].source_node : -1;
        if (node_parent[static_cast<std::size_t>(node)] == stop) continue; // direct: use local values as they are
        Mat4 m;
        for (int a = node_parent[static_cast<std::size_t>(node)]; a >= 0 && a != stop; a = node_parent[static_cast<std::size_t>(a)])
            m = multiply(node_local(nodes[static_cast<std::size_t>(a)]), m);
        chain[j] = m;
    }

    // ---- sample the clip into node-local TRS per frame -----------------------------------
    const std::size_t frames = clip.frames(), nj = skeleton.size();
    std::vector<Transform> locals(frames * nj);
    std::vector<Transform> pose(nj);
    std::vector<Transform> global(nj);
    for (std::size_t f = 0; f < frames; ++f) {
        for (std::size_t j = 0; j < nj; ++j)
            pose[j] = track_of[j] >= 0 ? clip.at(f, static_cast<std::size_t>(track_of[j])) : skeleton.joints[j].rest_local;
        for (std::size_t j = 0; j < nj; ++j) {
            const int p = skeleton.joints[j].parent;
            global[j] = p >= 0 ? global[static_cast<std::size_t>(p)] * pose[j] : pose[j];
            Transform out = pose[j];
            if (chain[j]) {
                const Mat4 parent_world = multiply(p >= 0 ? to_matrix(global[static_cast<std::size_t>(p)]) : Mat4{}, *chain[j]);
                out = decompose(multiply(invert(parent_world), to_matrix(global[j])));
            }
            locals[f * nj + j] = out;
        }
    }
    // Sign-continuous quaternions per joint.
    for (std::size_t j = 0; j < nj; ++j)
        for (std::size_t f = 1; f < frames; ++f) {
            Quat &q = locals[f * nj + j].rotation;
            if (dot(q, locals[(f - 1) * nj + j].rotation) < 0.F) q = {-q.x, -q.y, -q.z, -q.w};
        }

    // ---- animation ---------------------------------------------------------------------
    if (!doc.contains("accessors")) doc["accessors"] = json::array();
    auto add_accessor = [&](const bytes &data, std::size_t count, const char *type, json minmax = nullptr) {
        json acc{{"bufferView", add_view(data)}, {"componentType", 5126}, {"count", count}, {"type", type}};
        if (!minmax.is_null()) { acc["min"] = minmax[0]; acc["max"] = minmax[1]; }
        doc["accessors"].push_back(std::move(acc));
        return doc["accessors"].size() - 1;
    };
    bytes times;
    for (std::size_t f = 0; f < frames; ++f) append_pod(times, static_cast<float>(f) / clip.fps);
    const float duration = static_cast<float>(frames - 1) / clip.fps;
    const auto time_acc = add_accessor(times, frames, "SCALAR", json::array({json::array({0.F}), json::array({duration})}));
    json animation{{"name", options.animation_name}, {"channels", json::array()}, {"samplers", json::array()}};
    auto add_channel = [&](std::size_t node, const char *path, std::size_t output) {
        animation["samplers"].push_back({{"input", time_acc}, {"output", output}, {"interpolation", "LINEAR"}});
        animation["channels"].push_back({{"sampler", animation["samplers"].size() - 1}, {"target", {{"node", node}, {"path", path}}}});
    };
    for (std::size_t j = 0; j < nj; ++j) {
        const auto node = static_cast<std::size_t>(skeleton.joints[j].source_node);
        bytes rot, trans, scale;
        for (std::size_t f = 0; f < frames; ++f) {
            const Transform &t = locals[f * nj + j];
            for (const float v : {t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w}) append_pod(rot, v);
            for (const float v : {t.translation.x, t.translation.y, t.translation.z}) append_pod(trans, v);
            for (const float v : {t.scale.x, t.scale.y, t.scale.z}) append_pod(scale, v);
        }
        add_channel(node, "rotation", add_accessor(rot, frames, "VEC4"));
        add_channel(node, "translation", add_accessor(trans, frames, "VEC3"));
        if (options.export_scale) add_channel(node, "scale", add_accessor(scale, frames, "VEC3"));
    }
    report.channels = animation["channels"].size();
    if (options.replace_animations || !doc.contains("animations")) doc["animations"] = json::array();
    doc["animations"].push_back(std::move(animation));
    report.animations = doc["animations"].size();
    report.frames = frames;
    report.duration = duration;

    // ---- write the GLB ---------------------------------------------------------------------
    align4(bin);
    doc["buffers"] = json::array({json{{"byteLength", bin.size()}}});
    auto &asset = doc["asset"];
    if (!asset.is_object()) asset = json{{"version", "2.0"}};
    asset["generator"] = std::string("kimodo-extended kmd-anim (from: ") + asset.value("generator", std::string("unknown")) + ")";
    std::string text = doc.dump();
    while (text.size() % 4) text.push_back(' ');
    std::error_code ec;
    if (output.has_parent_path()) std::filesystem::create_directories(output.parent_path(), ec);
    std::ofstream out(output, std::ios::binary | std::ios::trunc);
    const auto put32 = [&](std::uint32_t v) { out.write(reinterpret_cast<const char *>(&v), 4); };
    out.write("glTF", 4);
    put32(2);
    put32(static_cast<std::uint32_t>(12 + 8 + text.size() + 8 + bin.size()));
    put32(static_cast<std::uint32_t>(text.size()));
    put32(0x4E4F534A);
    out.write(text.data(), static_cast<std::streamsize>(text.size()));
    put32(static_cast<std::uint32_t>(bin.size()));
    put32(0x004E4942);
    out.write(reinterpret_cast<const char *>(bin.data()), static_cast<std::streamsize>(bin.size()));
    if (!out) return std::unexpected("cannot write " + output.string());
    return report;
}

} // namespace kimodo::anim
