# Kimodo Extended

Additive extension of kimodo.cpp: import a rigged GLB character, then (in later steps)
retarget Kimodo motion onto it, apply root-motion / path / layer edits, preview and export.
The original generation path is unchanged; `tests/data/baseline/` guards it bit for bit.

- [MVP_PLAN.md](MVP_PLAN.md) — scope and milestones
- [AUDIT.md](AUDIT.md) — step 0 audit of the upstream code base

## Status

| Step | Content | State |
|---|---|---|
| 0 | audit, baseline, fork | done |
| 1 | skeleton runtime, GLB import, Three.js studio viewer | done |
| 2 | root motion (Full / InPlace) and MotionPath, studio playback | done |
| 3 | retargeting | — |
| 4 | animation layers, timeline | — |
| 5 | GLB export, regression | — |

## Layout

| Path | What |
|---|---|
| `include/kimodo/anim/` | public C++ API, namespace `kimodo::anim` |
| `src/anim/` | implementation and the `kmd-anim` tool |
| `third_party/cgltf/` | vendored cgltf v1.14 (MIT) |
| `demo/studio/`, `demo/studio*.go` | Three.js viewer at `/studio/`, root-motion endpoints |
| `tests/anim/`, `tests/data/rigs/` | tests and generated test characters |
| `scripts/make_test_rig_glb.py` | regenerates the test characters (stdlib only) |

The CMake option `KIMODO_BUILD_ANIM` (default ON) builds the static library `kimodo_anim`
and `kmd-anim`. The `kimodo` library never links it.

## Conventions

Right-handed, Y-up, metres. Quaternions are Hamilton, stored `x, y, z, w`, matching
`kimodo::motion_data`. A joint's local transform maps joint space into parent space
(scale, then rotation, then translation). Coordinate conversion happens only at import:
the glTF importer bakes non-joint ancestors of the root (e.g. an `Armature` node) into the
root's rest transform, so every `Skeleton` lives in scene space.

Persisted data refers to joints by **name**; indices are only valid inside one skeleton.

## Step 1 API

```cpp
#include <kimodo/anim/gltf.hpp>

auto character = kimodo::anim::load_gltf_character("character.glb");   // std::expected
if (!character) std::cerr << character.error();                        // diagnostic, no crash
const auto &target = character->skeleton;           // joints in parent-first order
auto source = kimodo::anim::native_skeleton_for_joint_count(motion.joints); // soma30, ...
auto rest = target.rest_global();                   // skeleton-space rest pose
auto pose = kimodo::anim::forward_kinematics(target, local_transforms);
```

The importer requires one skin with exactly one root joint and unique joint names, and
reports which joints influence skinned vertices (`Joint::deforming`).

## Step 2 API: root motion and MotionPath

```cpp
#include <kimodo/anim/root_motion.hpp>

auto motion = kimodo::anim::read_motion_dir("demo-output/<id>");   // kmd-generate output
auto skeleton = kimodo::anim::native_skeleton_for_joint_count(motion->joints);
auto clip = kimodo::anim::clip_from_motion(*skeleton, *motion);   // 30 fps, bit-exact copy

kimodo::anim::RootMotionSettings s;
s.mode = kimodo::anim::RootMotionMode::CustomPath;               // Full | InPlace | CustomPath
s.path = kimodo::anim::MotionPathSpec{{{0, 0, 0}, {1, 0, 1.5}, {-1, 0, 3}}}; // Catmull-Rom
s.follow.timing = kimodo::anim::PathTiming::MotionDistance;      // | Duration | Speed
if (auto ok = kimodo::anim::apply_root_motion(*clip, s); !ok) std::cerr << ok.error();
kimodo::anim::write_motion_dir("out", kimodo::anim::clip_to_motion(*clip));
```

- **Full** leaves the clip bit-identical to the generated motion.
- **InPlace** removes the horizontal root travel relative to frame 0. You can remove the
  forward component, the lateral component, or both. The root height and every rotation
  are untouched. `AxisConvention` sets which axis is up and which is forward.
- **CustomPath** replaces the root's horizontal translation with a polyline or a
  centripetal Catmull-Rom curve, parameterised by arc length and optionally looped.
  Waypoint heights are ignored and the root keeps its generated height.
  - `orient_to_path` yaws the root so that its frame-0 facing follows the tangent. The
    motion's own turning is preserved relative to that.
  - Timing has three modes. `MotionDistance` (the default) moves the root along the path
    by the distance the generated motion actually travels, so stride and speed stay
    consistent. `Duration` traverses the whole path in a set time. `Speed` uses a
    constant metres per second.
  - Paths are validated: an empty path is an error, coincident points are merged, a
    single point parks the root, and a zero-length tangent keeps the last facing.
- A path combined with Full or InPlace is an error unless `path_preview_only` is set.
- This is procedural post-processing: it does not condition the diffusion model, and it
  does not re-time the steps.

## Tools

```sh
kmd-anim inspect character.glb [--skin N]   # skeleton, rest pose, mesh stats as JSON
kmd-anim inspect --native soma30            # a native Kimodo skeleton as JSON
kmd-anim root-motion IN_DIR OUT_DIR --mode full|inplace|path     [--lock both|forward|lateral] [--up X,Y,Z] [--forward X,Y,Z]     [--points "x,y,z;x,y,z;..."] [--interp catmull|polyline] [--loop]     [--timing distance|duration|speed] [--duration S] [--speed M_PER_S] [--no-orient]
```

`root-motion` reads and writes the `kmd-generate` format (`root_positions.f32`,
`local_rotations_xyzw.f32`). In path mode it also writes `path_samples.f32`, which is the
evaluated curve the viewer draws, so the viewer and the backend cannot disagree.

## Studio viewer

Start the demo (e.g. `kimodo_demo_vulkan.bat`, or `go run ./demo -addr 127.0.0.1:8094 ...`)
and open `http://localhost:8094/studio/`. It works without starting a generation.

- open a `.glb` / `.gltf` with *Open GLB*, drag and drop, or *Sample rigs*
  (served from `-sample-rigs`, default `tests/data/rigs`);
- orbit with left-drag, pan with right-drag, zoom with the wheel, `F` to frame;
- toggle mesh, skeleton lines, joint markers, grid and axes;
- select joints in the tree or by clicking a marker; the inspector shows parent,
  children, local position / quaternion / Euler / scale and world position;
  non-deforming joints are greyed out;
- **Motion** panel:
  - Pick a sample motion (from `-sample-motions`, default `tests/data/baseline`) or a
    finished generation from the gallery.
  - Choose Full, In place or Path. Path offers presets (straight, S-curve, corner,
    zig-zag, circle loop) or your own waypoints, with a curve type, a timing mode and
    orientation along the path.
  - Every change is processed by `kmd-anim` on the server.
  - The result plays locally on the native skeleton (purple), with play/pause,
    scrubbing and loop. Space toggles play/pause.
  - The viewport shows the source root trail (dashed), the evaluated path (cyan), its
    waypoints and the resulting root trail (purple).
- **Deep links:**
  - `/studio/?load=samples/test_rig.glb&joint=LeftArm`
  - `/studio/?motion=sample:soma30-walk-s42&mode=path&preset=scurve&frame=45`

| Endpoint | Purpose |
|---|---|
| `GET /studio/motions` | motion sources (`sample:<dir>`, `animation:<id>`) |
| `GET /studio/motions/<id>/{root,rotations}.f32` | source arrays |
| `GET /api/skeletons/<key>` | native skeleton names, parents and offsets |
| `POST /api/root-motion` | `{source, mode, lock?, path?{points,interpolation,loop}, timing?, duration?, speed?, orient?}` |
| `GET /api/root-motion/<id>/{root,rotations,path}.f32` | result, cached by request hash |

The demo finds `kmd-anim` next to `-generator`; override that location with `-anim`.

Three.js r170 is loaded from jsDelivr, so the viewer needs network access.

## Tests

```sh
cmake --build build --config Release
ctest --test-dir build -C Release -R anim     # needs no model weights
go test ./demo
```

On Windows put `build/bin/Release` (ggml DLLs) on `PATH` before running the GGML tests.
