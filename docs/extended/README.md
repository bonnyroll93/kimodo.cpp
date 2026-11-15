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
| 2 | root motion (Full / InPlace) and MotionPath | — |
| 3 | retargeting | — |
| 4 | animation layers, timeline | — |
| 5 | GLB export, regression | — |

## Layout

| Path | What |
|---|---|
| `include/kimodo/anim/` | public C++ API, namespace `kimodo::anim` |
| `src/anim/` | implementation and the `kmd-anim` tool |
| `third_party/cgltf/` | vendored cgltf v1.14 (MIT) |
| `demo/studio/`, `demo/studio.go` | Three.js viewer served at `/studio/` |
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

## Tools

```sh
kmd-anim inspect character.glb [--skin N]   # skeleton, rest pose, mesh stats as JSON
kmd-anim inspect --native soma30            # a native Kimodo skeleton as JSON
```

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
- deep link: `/studio/?load=samples/test_rig.glb&joint=LeftArm`.

Three.js r170 is loaded from jsDelivr, so the viewer needs network access.

## Tests

```sh
cmake --build build --config Release
ctest --test-dir build -C Release -R anim     # needs no model weights
go test ./demo
```

On Windows put `build/bin/Release` (ggml DLLs) on `PATH` before running the GGML tests.
