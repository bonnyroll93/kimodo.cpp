# Kimodo Extended — Step 0 audit

Base: upstream `localai-org/kimodo.cpp` commit `75ed52d` (ggml submodule `8c63e70`, v0.20.2).
Work branch: `extended/main`. Plan: [MVP_PLAN.md](MVP_PLAN.md).

## 1. Build and test baseline (Windows, MSVC / VS 17 2022, Vulkan ON)

`cmake --build build --config Release` builds every target with no source changes.

The ggml DLLs are in `build/bin/Release`. That directory must be on `PATH`, or every
GGML test exits with `0xc0000135` (DLL not found).

`ctest -C Release` with that `PATH`:

| Result | Tests | Cause |
|---|---|---|
| pass | capi-test, diffusion-test, converter-test | — |
| fail (env) | root/body parity, fixture-sampler, ggml-weights, denoiser-runtime ×3, decode-test, generate-smoke | `KIMODO_ROOT_PARITY_MODEL` points at `models/kimodo-smplx-rp-v1-f32.gguf`, which has not been downloaded; `fixtures/smplx-zero-embedding` does not exist |
| fail (env) | llm-text-session cpu/vulkan | `KIMODO_LLM_TEXT_BUNDLE`/`_FIXTURE` not configured; `fixtures/llm2vec-real-prompt` is missing |
| fail (env) | quantization-metrics-test | `numpy` is not installed for Python 3.14 |

None of these failures come from the code. To make them pass:
- `scripts/download_gguf_weights.sh --model smplx-rp-v1` fetches the SMPL-X motion model.
- The fixtures are produced with `reference/` and `scripts/extract_reference_fixture.py`. They need the NVIDIA PyTorch reference.
- `pip install numpy`.

`go test ./demo` passes on Go 1.27.4.

**Generation-path regression reference:** `tests/data/baseline/soma30-walk-s42/`.
- The capture is soma30, 90 frames, 100 steps, seed 42, on Vulkan.
- Two runs produced byte-identical output.
- Any Kimodo Extended change must leave `kmd-generate` bit-identical to it.

## 2. Real extension points

### Generation output
`include/kimodo/kimodo.hpp:18` defines `kimodo::motion_data`:
- `local_rotations_xyzw` has shape `[T,J,4]`. The quaternions are parent-local, in xyzw order.
- `root_positions` has shape `[T,3]`. It is the pelvis world position in metres, Y-up.
- The frame rate is fixed at 30 fps (`src/motion_rep.hpp:19`).
- The C API (`kimodo_capi.h`, ABI v1) exposes the same data.

**Gap:** the public API does not report which skeleton generated the motion. The key exists internally (`model.cpp:40`, the `kimodo.skeleton` GGUF string).

Options:
- **(a)** Add a `model::skeleton_key()` member and a matching `kimodo_model_skeleton_key()` C function.
- **(b)** Infer the skeleton from `joints`. The counts 22, 30 and 34 identify smplx22, soma30 and g1skel34 unambiguously.

For the MVP, (b) keeps the core untouched. (a) would be a small, purely additive upstream-friendly patch.

### Skeletons
`src/skeleton.hpp` defines `kimodo::detail::skeleton_spec`, with `find_skeleton()` at line 94. It holds:
- names
- parents
- parent-local rest offsets, in metres
- hips
- end effectors

The rest rotations are identity, so the rest pose is offsets only. That is what the Go GLB writer and `scripts/export_glb.py` assume.

The header is internal but self-contained (constexpr, no dependencies). `kimodo_anim` can include it from `src/` to build its public `Skeleton` adapter, so the data is not duplicated a fourth time.

The same tables already exist in three other places:
- Go: `demo/main.go:233`
- Go: `demo/skeletons_extra.go`
- JS: `demo/index.html`

### Math / FK
- There is no math library.
- `src/motion_decode.cpp` has local 3×3-matrix, 6D→matrix and matrix→quat helpers in an anonymous namespace.
- There is no C++ forward kinematics. FK exists only in JS (`demo/index.html`) and Python (`scripts/export_glb.py:40`, `scripts/fk_compare_fixture.py`).

→ `kimodo_anim` brings its own `Vec3`/`Quat`/`Transform`/FK. `motion_decode.cpp` is not changed.

### Export
| Where | What | Mesh/skin |
|---|---|---|
| `demo/main.go:265` `writeSkeletonGLB` | nodes + T/R channels, LINEAR, extras `{skeleton,fps,rotation_order}` | no |
| `scripts/export_glb.py` | bone-cube skinned mesh, IBMs, Unreal/Blender oriented | proxy only |
| `scripts/export_bvh.py` | BVH, ZXY Euler, ×100 cm | n/a |
| `kmd-generate` | raw `root_positions.f32`, `local_rotations_xyzw.f32` | n/a |

None of these exports keeps a user mesh. M8 needs a real glTF writer: cgltf `cgltf_write`, or a custom writer that copies the source buffers.

### Demo
- **Server:** the Go server `demo/main.go` (default `127.0.0.1:8090`; the local `.bat` uses 8094).
- **Worker:** the server keeps one persistent `kmd-generate --server MOTION TEXT` worker. Requests and replies are tab-separated lines: `OK\tframes\tjoints` or `ERR\tmsg`.
- **Outputs:** each animation is stored in `demo-output/<id>/`. They are served as `/api/animations/{id}/{root.f32|rotations.f32|animation.glb}`.
- **Viewer:** `demo/index.html` is plain JS on **Canvas 2D**. It does its own FK, polls `/api/animations` every 2.5 s, and plays at 30 fps.
- **Other pages:** `demo/models.js` (model and quantization selectors), `demo/comparison.html`.

→ The new Three.js viewer goes in `demo/studio/` and is served on a new route. `kmd-anim` is invoked by the server on files that already exist on disk, so the generation worker and its protocol stay unchanged.

### Tests
- **C++ tests:** plain executables plus `add_test`, with no framework. Each one returns non-zero on failure.
- **Python and Go:** `tests/*.py` run through CTest; the Go tests run with `go test ./demo`.
- New `kimodo-anim-*` tests follow the same pattern. Most of them need no model weights, so they always run.

### Dependencies and licences
| Item | Licence | Note |
|---|---|---|
| kimodo.cpp | Apache-2.0 (`LICENSE`, `NOTICE`) | — |
| ggml (submodule) | MIT | only third-party code today |
| skeleton tables | Apache-2.0 (NVIDIA Kimodo) | `src/skeleton.hpp` header comment |
| motion/text weights | NVIDIA Open Model License | not redistributed; gitignored |
| proposed: cgltf | MIT | single header, read + write |
| proposed: nlohmann/json | MIT | single header |
| proposed: three.js | MIT | viewer only, vendored or pinned CDN |

## 3. Local environment notes
- The GPU is an RTX 4070 Laptop with 8 GB. The text encoder needs `KIMODO_TEXT_LAYER_CHUNK=8` and `KIMODO_TEXT_RESIDENT_LIMIT_MIB=4096`. With the defaults (32 / 10000) it fails with "layer chunk backend allocation failed".
- Local models: `models/kimodo-soma-rp-v1.1-f32.gguf`, `Llama-3-Kimodo-Q8_0.gguf` and `tokenizer.gguf` in the repo root.
- `kimodo_demo_vulkan.bat` is the local launcher. It hard-codes those values and the Go path, and it is left untracked.

## 4. Decisions carried into Step 1
1. The new code goes into a CMake target `kimodo_anim`, behind the option `KIMODO_BUILD_ANIM`. The `kimodo` target does not link it.
2. The source skeleton comes from `detail::find_skeleton()`, chosen by joint count.
3. The first target rig is soma30 → a CC0 Mixamo-style humanoid, stored in `tests/data/`.
4. Vendor cgltf and nlohmann/json into `third_party/`, pinning versions.
