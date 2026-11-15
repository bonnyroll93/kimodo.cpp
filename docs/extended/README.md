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
| 3 | retargeting (role-based mapping, JSON mappings, studio preview on the character) | done |
| 4 | animation layers (Override/Additive, masks, enable/mute), layer timeline | done |
| 5 | GLB export (mesh + skin + clip), round-trip tests, baseline regression test | done |
| F5 | two-bone IK, foot contact detection, foot locking (backlog) | done |

## Layout

| Path | What |
|---|---|
| `include/kimodo/anim/` | public C++ API, namespace `kimodo::anim` |
| `src/anim/` | implementation and the `kmd-anim` tool |
| `third_party/cgltf/` | vendored cgltf v1.14 (MIT) |
| `third_party/nlohmann/` | vendored nlohmann/json v3.11.3 (MIT), mapping files |
| `demo/studio/`, `demo/studio*.go` | Three.js viewer at `/studio/`, root-motion endpoints |
| `tests/anim/`, `tests/data/rigs/` | tests and generated test characters (T-pose rig, Mixamo-named A-pose rig, unskinned) |
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

The importer requires one skin and unique joint names, and reports which joints influence
skinned vertices (`Joint::deforming`).

**Several root joints.** Blender control rigs often export helpers such as `Controls`,
`Parts`, `RigBuilder`/`COG` or foot pivots as extra roots of the skin, next to `Hips`.
- The skeleton becomes the root subtree with the most deforming joints, with ties broken
  by joint count. You can force a different one with `GltfImportOptions::root_joint`.
- The other subtrees stay in the file at rest and are not animated; they are listed in
  `GltfCharacter::ignored_roots` and `warnings`.
- An extra warning appears if any ignored joint deforms the mesh.
- The studio picks the same root, and the warning appears with the mapping diagnostics.

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

## Step 3 API: retargeting

```cpp
#include <kimodo/anim/retarget.hpp>

auto source = kimodo::anim::native_skeleton("soma30");
auto character = kimodo::anim::load_gltf_character("character.glb");
auto mapping = kimodo::anim::auto_map(*source, character->skeleton);   // or load_mapping("m.json")
auto diag = kimodo::anim::check_mapping(mapping, *source, character->skeleton);
kimodo::anim::RetargetOptions opt;            // auto facing, hip-height root scale, KeepRest
opt.align_rest_directions = true;             // for A-pose characters
auto result = kimodo::anim::retarget(clip, *source, character->skeleton, mapping, opt);
// result->clip: target joint order; result->diagnostics.warnings; result->root_scale ...
```

**Method.** Each mapped joint receives the source's change of *global* rotation relative to
the source rest pose. That change is applied to the target's own global rest rotation, so
the two rigs may use different local axes, rest offsets, axis flips and bone lengths. The
target always keeps its own bone lengths. The joint mapped to the source root also gets
the root translation:
- the translation is measured relative to the source's standing reference (native rigs
  stand with the root at hip height);
- it is turned by the facing difference, which is detected from the hips (or a yaw you
  give);
- it is scaled by the ratio of hip heights (or an explicit `root_scale`).

A source frame at its reference therefore reproduces the target rest pose exactly.
Unmapped target joints keep their rest local rotation (`UnmappedPolicy::KeepRest`).

**A-pose / T-pose.** `align_rest_directions` first rotates each mapped target rest bone onto
the source's rest bone direction. It is off by default, so that the rest pose maps to the
rest pose. Turn it on when the character's rest pose differs from the source's, e.g. an
A-pose Mixamo character driven by T-pose SOMA.

**Mapping.**
- **Persisted format.** Mappings are stored by joint name in a JSON file
  (`{"version":1,"joints":[{"target":..,"source":..,"offset_xyzw":[..]?}]}`). The optional
  offset is an extra rotation in the target joint's local frame.
- **Role detection.** `detect_roles` combines naming conventions (Mixamo, `mixamorig:`
  prefixes, UE `thigh_l`/`calf_l`, SMPL, SOMA, left/right tokens) with the hierarchy:
  - limbs are found as chains walking up from the hand and the foot, so SOMA's `LeftLeg`
    (thigh) and Mixamo's `LeftLeg` (calf) are told apart;
  - spine and neck chains of different lengths are matched first↔first and last↔last.
- **Errors** (retargeting is refused with a message, it never crashes):
  - unknown joints;
  - a target mapped twice;
  - an unmapped source root;
  - incompatible parents, i.e. a target joint whose mapped ancestor is driven by a source
    joint that is not an ancestor of its own source.
- **Warnings:**
  - unmapped deforming joints;
  - one source driving several targets;
  - undetectable facing or hip height.

Only humanoid rigs that are compatible with the source skeleton are supported. Arbitrary
rigs (quadrupeds, robots) are out of scope for the MVP.

## Step 4 API: animation layers

```cpp
#include <kimodo/anim/layers.hpp>

kimodo::anim::AnimationStack stack(character->skeleton);
kimodo::anim::AnimationLayer base{.name = "walk", .clip = walk_clip};
kimodo::anim::AnimationLayer arms{.name = "arms", .clip = wave_clip,
                                  .mode = kimodo::anim::BlendMode::Additive, .weight = 0.5F};
arms.mask = kimodo::anim::upper_body_mask(character->skeleton);   // or load_mask("m.json")
arms.reference = kimodo::anim::AdditiveReference::RestPose;      // FirstFrame | RestPose | Frame
stack.add_layer(base);
stack.add_layer(arms);
auto pose = stack.evaluate(1.25F);       // local pose at t = 1.25 s
auto clip = stack.bake();                // [0, duration] at the first layer's fps
```

**Semantics.**
- Evaluation starts from the rest pose and applies the layers bottom to top. Each joint
  gets the weight `clamp(layer weight × mask(joint), 0, 1)`.
- **Override** slerps the rotation along the shortest arc and lerps translation and
  scale; at weight 1 it copies the layer exactly.
- **Additive** applies the layer's change from its reference pose, scaled by the weight:
  `current · slerp(I, ref⁻¹·layer, w)` for rotation and `+ w·(layer − ref)` for
  translation. Scale is not additive. The reference pose is explicit: the first frame,
  the rest pose, or a frame index.
- **Enabled vs muted.** A disabled layer is bypassed completely and does not count
  towards the stack duration. A muted layer keeps its place on the timeline and in the
  duration, but adds nothing to the pose. Weight 0 equals muted for the pose.
- **Joint identity.** Layers address joints by name (`AnimationClip::joint_names`), so a
  clip can drive a subset of the skeleton.
- **Frame rates and durations.** Clips with different frame rates and durations are
  sampled at the same time `t`, with interpolation between frames. Past its end a clip
  holds its last frame (`Clamp`) or loops (`Loop`).
- **Masks.** Built-in presets are Full, Upper body (the first spine joint and everything
  below it) and Lower body (hips and legs). A custom mask is JSON:
  `{"version":1,"name":..,"default":0,"weights":{"Joint":0..1}}`.

Not in the MVP: `Multiply` and procedural layers, weight curves, keyframe editing.

## Step 5 API: GLB export

```cpp
#include <kimodo/anim/gltf_export.hpp>

auto character = kimodo::anim::load_gltf_character("character.glb");
auto report = kimodo::anim::export_gltf_animation("character.glb", character->skeleton, final_clip,
                                                  "character_animation.glb", {.animation_name = "Walk"});
```

**What the export keeps.** The export edits the glTF JSON and copies everything in the
source unchanged: meshes, materials, textures, skins and inverse bind matrices, the other
nodes, extensions and extras. The source can be a `.glb` or a `.gltf`. Its external
`.bin` buffers, data-URI buffers and external or data-URI images are embedded, so the
output is one self-contained `.glb`.

**What it adds.** One animation, with LINEAR rotation and translation channels per joint.
- Scale channels are optional (`export_scale`).
- The file's existing animations are kept unless you set `replace_animations`.
- Where a joint's glTF parent is not its skeleton parent (a root below an `Armature`
  node), the transform is converted back to node-local values.
- Quaternion keys are kept sign-continuous, so slerp takes the short way.

**Round-trip test.** The test reloads the written file and checks three things:
- the importer still sees the same skeleton, mesh, skin and inverse bind matrices;
- the animation, applied to the file's nodes and composed with `cgltf_node_transform_world`,
  matches the clip's forward kinematics at the first, middle and last frame within 0.1 mm;
- the same holds for the T-pose rig, the Mixamo-named A-pose rig, the data-URI `.gltf`
  rig and a baked layer stack.

## F5: IK and foot locking

```cpp
#include <kimodo/anim/ik.hpp>

auto locked = kimodo::anim::foot_lock(clip, skeleton);   // FootLockOptions{} = automatic thresholds
// locked->clip, locked->contacts (foot, frames, pinned position), slide_before/after, max_hip_drop
kimodo::anim::solve_two_bone_ik(skeleton, pose, thigh, calf, foot, target);   // one frame, in place
```

- **Two-bone IK** is analytic. It sets the knee angle so the hip-to-ankle distance matches
  the target, then aims the chain at it. The knee keeps its current bend plane; a straight
  leg uses the character's lateral axis, so knees bend forward. The foot keeps its
  animated global orientation. Unreachable targets are clamped to full reach.
- **Contact detection** marks a foot as in contact while two conditions hold:
  - the lower of ankle and toe is within 8% of the leg length above the ground. The
    ground is the median foot height over frames where the ankle is nearly still (the
    stances). That way it is robust to toes that briefly dip below the floor, as long
    retargeted feet do at toe-off;
  - the ankle's horizontal speed is below 40% of the leg length per second.

  Short gaps are merged and contacts shorter than 3 frames are dropped. Both thresholds
  can be set.
- **Foot locking**:
  - pins each contact's ankle horizontally at its mean position, keeping the animated
    height so heel and toe roll stay natural;
  - solves both legs with IK and blends in and out over 4 frames;
  - with `adjust_hips` (on by default), lowers the root by the smallest smoothed amount
    that keeps every pinned foot reachable, at most 10% of the leg length.

  Spine, arms, head, root rotation and horizontal root position stay bit-identical, and
  frames away from any contact are untouched.
- **Results on the test motion:** sliding inside contacts goes from 23–64 mm to below
  0.001 mm, with no frame out of reach. This holds for the generated walk, the walk
  retargeted onto the test rig, a curved path and a path 20% faster than the walk.
- **Where it applies.** Foot locking is a final step after the layers are baked:
  `kmd-anim layers … --key-layer KEYS.json [layer options]   # keyframe offset layer (additive, rest reference)
kmd-anim layers … --foot-lock`, `kmd-anim footlock`, `foot_lock` in `/api/layers` and
  `/api/export`, and the *Foot locking (IK)* option in the studio. So it also applies to
  the exported GLB. The studio draws a print at each pinned position and a row of contact
  bars per foot in the timeline.

## Tools

```sh
kmd-anim inspect character.glb [--skin N]   # skeleton, rest pose, mesh stats as JSON
kmd-anim inspect --native soma30            # a native Kimodo skeleton as JSON
kmd-anim root-motion IN_DIR OUT_DIR --mode full|inplace|path     [--lock both|forward|lateral] [--up X,Y,Z] [--forward X,Y,Z]     [--points "x,y,z;x,y,z;..."] [--interp catmull|polyline] [--loop]     [--timing distance|duration|speed] [--duration S] [--speed M_PER_S] [--no-orient]
```

```sh
kmd-anim map soma30 character.glb [--mapping m.json]      # auto (or given) mapping + errors/warnings
kmd-anim retarget MOTION_DIR character.glb OUT_DIR \
    [--mapping m.json] [--save-mapping m.json] [--align-rest] [--root-scale S] [--yaw DEG] [--no-auto-facing]
```

```sh
kmd-anim layers OUT_DIR (--native soma30 | --character character.glb) [--fps N] \
    --layer DIR [--name S] [--mode override|additive] [--weight W] [--mask full|upper|lower|m.json] \
                [--disabled] [--muted] [--reference first|rest|FRAME] [--wrap clamp|loop] \
    --layer DIR ...
```

```sh
kmd-anim export character.glb CLIP_DIR out.glb [--name Walk] [--replace-animations] [--export-scale]
```

```sh
kmd-anim masks (--native soma30 | --character character.glb)   # preset masks as JSON
kmd-anim footlock IN_DIR OUT_DIR [--character character.glb] [--foot-height M] [--foot-speed M_PER_S] \
    [--foot-blend FRAMES] [--no-hip-adjust]
kmd-anim layers … --foot-lock [--foot-height M] [--foot-speed M_PER_S] [--foot-blend N] [--no-hip-adjust]
```

`footlock` reads a native motion directory or a clip directory and writes a clip
directory. Its `clip.json` holds `foot_lock` with the contacts and statistics.

`export` writes the character with the clip in `CLIP_DIR` (output of `retarget` or
`layers`) as a new animation. It then reloads the result to make sure it is still a valid
character.

`layers` takes each `DIR` from either a clip directory (`kmd-anim retarget`/`layers` output)
or a native motion directory. It writes `clip.json`, `local_rotations_xyzw.f32` and
`local_translations.f32`; with `--native` it also writes `root_positions.f32`, so the
result reads like any generated motion.

`retarget` writes three files to `OUT_DIR`:
- `local_rotations_xyzw.f32` (`[T,J,4]`) and `local_translations.f32` (`[T,J,3]`), in the
  target's joint order;
- `retarget.json`, with the joints (name, parent, glTF node, rest scale), the mapping, the
  diagnostics, `root_scale`, `facing_yaw_degrees`, and the source/target reference points
  used to map overlays into the character's space.

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
- **Edit the path in the viewport.** In Path mode, *Edit in viewport* shows the active
  layer's waypoints as handles on the ground.
  - Drag a handle to move it; an orange preview of the curve follows live, and on release
    the path is recomputed by `kmd-anim`.
  - Click the ground to insert a waypoint into the nearest segment, or after the last
    point if that is closer.
  - Double-click a handle, or select it and press Delete, to remove it. Press Esc to
    finish.
  - Orbiting still works on empty space.
  - With retargeting, points are edited in the character's space and converted back to
    the motion's space, so the waypoint text stays the source of truth.
  - Deep link: `…&mode=path&editpath=1`.
- **Retarget onto character.** Load a character, keep *Retarget onto character* on, and
  the current motion (after Full / In place / Path) is retargeted on the server and played
  on the character's mesh.
  - The source skeleton can be shown beside it.
  - The path and the root trails are drawn in the character's space.
  - *Align rest pose* handles A-pose characters.
  - *Edit mapping* shows a target→source table that you can edit. Every change is checked
    on the server and the errors and warnings appear inline.
  - *Auto* recomputes the mapping. *Save* and *Load* exchange mapping JSON files.
  - Locally opened `.glb` files are uploaded once, on demand. Bones are matched by glTF
    node index, because three.js rewrites names such as `mixamorig:Hips`.
- **Story mode: anim clips, anim layers and the attribute editor.** The scene is made of
  *anim clips* on tracks (the Story timeline under the viewport) and *anim layers*
  (keyframes, in the right panel), similar to MotionBuilder's Story mode.
  - Every **anim clip** has its own motion source and root motion (Full / In place / Path),
    blend mode (Override / Additive), weight, mask, enable, mute, additive reference, end
    behaviour (hold / loop) and clip timing.
  - Clips on the same **track** play in sequence. Where two clips **overlap**, the later one
    blends in over the overlap (*Auto blend overlaps*, on by default, smoothstep when
    *Smooth blends* is on), and the timeline draws the blend as a gradient. A clip that
    is not the first of its track, or is on an upper track, does not hold its first frame
    before it starts.
  - **Higher tracks apply over lower ones** (with their own blend mode, weight, mask and
    blend in / out), so an upper-body clip on Track 2 replaces or adds to Track 1 only
    where it plays.
  - **Anim layers** (keyframes) are applied after all the clips; the *Anim layers* panel
    lists them, with up / down to reorder. Each one has a blend mode:
    - *Additive (offsets)*, the default: keys are offsets added to what the clips give;
    - *Override (replace)*: keyed joints take the keyed pose (rest pose * key), only in the
      channels that have keys (a joint keyed in rotation keeps its translation from the
      clips); with the gizmo, *Key* captures the pose as shown. Switching mode
      reinterprets the existing keys.
  - **Scope** of an anim layer (*Applies to* in the attribute editor): the whole main
    timeline, or **bound to a clip** (⛓ on its row). A bound layer's keys are in the
    clip's time: they move and stretch with the clip, act only while it plays and blend
    in / out with it. Changing the scope keeps the keys where they are on the timeline;
    deleting the clip turns its layers back to the whole timeline.
  - **Root motion scope** (*Root motion applies to* in the Motion form): *Each clip* (every
    clip has its own Full / In place / Path) or *Whole scene*: the clips are composed first
    on the source skeleton, then one root motion applies to the result (e.g. one path for a
    whole sequence), which is then retargeted and stacked with the anim layers
    (`scene_root` in `/api/layers` and `/api/export`).
  - **Changing the character** (Open GLB or Sample rigs) keeps the scene: clips, tracks,
    timing, root motion, anim layers, masks and options. Keys and custom masks move to the
    new rig's joints (via the old and new retarget mappings, else by name), rotations are
    re-expressed through the rest poses like the retargeter does, translations are scaled
    by the rigs' heights; joints with the same frames keep their curves exactly, others are
    re-keyed with auto tangents; unmatched joints keep their keys under the old name. Edited
    mappings are remembered per character for the session. The undo history restarts.
  - Select a clip in the timeline (or an anim layer in its panel or row) and the
    **Attribute editor** shows its settings: the row (enable, name, mute, blend, weight,
    mask, reference, end), the timing fields (Start, Trim in / out, Speed, Repeat, After
    end, Blend in / out, Auto blend, Smooth blends, Match root), the joint mask editor and
    the *Motion* form (source and root motion).
  - The stack sent to `kmd-anim` is ordered tracks bottom to top (clips by start), then
    the anim layers; the studio computes each clip's effective blend-in and
    `empty_before` from the overlaps.
  - *Custom…* opens the **joint mask editor**, where you choose which joints the layer
    affects:
    - each joint has an include checkbox and a weight from 0 to 1; ⤵ applies the choice to
      the joint and everything below it;
    - *All*, *None*, *Upper*, *Lower* and *Invert* give starting points. Upper and Lower
      come from `kmd-anim masks`, so they are exactly the presets;
    - with *Pick joints* on, clicking a joint in the viewport or the hierarchy includes or
      excludes it; Shift applies it to the whole subtree;
    - included joints are coloured in the viewport and excluded ones are grey;
    - switching a layer from Upper or Lower to Custom starts from that preset;
    - Save and Load exchange mask JSON files.
  - A single default clip behaves exactly as before. Anything else is baked on the
    server, on the character's skeleton when retargeting, otherwise on the native
    skeleton.
- **Export.** *Export GLB* bakes the current result (motion, root mode, retarget and
  layers) onto the loaded character and offers the `.glb` for download.
  - *Open exported* loads the written file back into the viewer and plays its animation
    from the file, so you can compare it with the preview.
  - Any loaded GLB that contains animations shows an *Embedded animation* selector. These
    animations play through three.js' `AnimationMixer`, on the same play bar.
- **Anim layers (keyframes).** *+ Keys* adds an anim layer on top of the stack. It holds
  offsets added to the layers below, so joints without keys are untouched.
  - Select a bone of the character (viewport or hierarchy) and pose it with the gizmo:
    *Rotate* (E) or *Move* (W).
  - *Key* (K) records the selected joint at the current frame; *Auto key* records every
    gizmo edit. *Delete key* removes the keys at the current frame.
  - Keyed joints are listed, and their keys appear as diamonds on the layer's timeline row.
  - **Graph editor**: the curves of the selected joint. rx/ry/rz are rotation offsets in
    degrees (Euler XYZ); tx/ty/tz are translation offsets in parent units.
    - Drag keys (frames snap; Alt: free), drag bezier handles (manual tangents, aligned;
      Alt breaks them), double-click to add a key, Delete to remove.
    - Constant / Linear / Bezier / Auto tangents apply to the selected keys.
    - Wheel zooms time (Shift: values), right-drag pans, a click seeks.
  - The curves are evaluated by the same rules in the graph editor (`viewer/keyframes.js`)
    and in `kmd-anim` (`include/kimodo/anim/keyframes.hpp`), so the bake and the export
    match what you see.
  - Gizmo edits are exact when the keyframe layer is the top layer at weight 1, which is
    how *+ Keys* adds it.
- **Undo / redo.** Ctrl+Z undoes, and Ctrl+Y or Ctrl+Shift+Z redoes; ↶ and ↷ are in the
  toolbar. The history keeps the last 100 states of everything you edit: clips, tracks,
  anim layers and their sources, the scene length, root motion and paths (including viewport edits), keyframes (gizmo and graph
  editor), masks, clip timing, mapping, retarget and foot-lock options, and the export
  name.
  - Quick successive edits, such as a drag, count as one step.
  - In text fields, Ctrl+Z stays the field's own undo.
  - Loading a character or opening a scene starts a new history.
- **Scenes.** *Save scene* downloads the whole studio state as JSON:
  - the character reference; the root motion scope and the scene root motion;
  - every anim clip (track, timing, source, root motion, path waypoints, blend, weight,
    mask or custom mask, enabled, muted, reference, wrap), every anim layer (keys) and
    the selection; the scene length and the playback range. Scenes saved before tracks
    existed open with each motion layer on its own track;
  - the retarget options and mapping, foot locking, the export name, the view toggles,
    the playback frame and the camera.

  *Open scene* restores it, and `/studio/?scene=<url>` opens one from a link.
  - Characters are referenced, not embedded: sample rigs by name, and opened `.glb` files
    by the content hash of their upload. The demo keeps uploads in
    `<output>/characters/` and serves them back at `/api/characters/<hash>.glb`.
  - Motions are referenced by their sample or gallery id. Anything missing on the server
    is reported when the scene opens.
- **Motion library** (*▦ Library* next to *Source*) shows every motion source.
  - Two views: a grid with an animated stick-figure preview of each motion, or a list
    with kind, skeleton, length and date.
  - Search, sort by name or newest first; the chosen view and sort are remembered.
  - Click an item to use it as the active layer's source.
  - Generated animations can be deleted. This removes them from the gallery and from
    `demo-output`; samples cannot be deleted, nor can a generation that is still running.
  - The *Source* menu is sorted alphabetically.
- **Text to motion** opens the generator in a new tab, so the scene in the studio is
  untouched. New generations appear in *Source* when you come back to the studio tab,
  or when you press ↻.
- **Story timeline (retiming).** One row per anim layer (◆, on top), one row per track,
  and the foot contacts.
  - **Toolbar:** *+ Clip* adds a clip of the selected clip's source after the last clip
    of its track (with *Match root*); *+ Track* adds a track above with a clip at the
    playhead (blend in / out 0.25 s); *Split* cuts the selected clip at the playhead into
    two clips that reproduce the original motion; *Duplicate* places a copy right after
    it, root continuing; *Delete* removes the selected clip or anim layer (the scene keeps
    at least one clip).
  - **Keyframes on the timeline:** anim-layer rows show ◆ for the selected joint's keys,
    or for every keyed frame when no joint is selected. Click a key to select it and seek
    there (Shift+click adds / removes), drag to move the selected keys in time (whole
    frames of the layer's time; a key landing on another replaces it), Delete removes
    them. With a joint selected only its keys change; otherwise every joint's keys at
    those frames. Undo works as for any edit.
  - **Mouse:** drag a clip to move it, also onto another track row; drag its left edge to
    trim the start and its right edge to trim the end. Times snap to frames; Shift moves
    freely. Click empty space to seek.
  - **Stretch / compress** (change the speed) with **Ctrl + drag**, or Cmd / Alt: on the
    clip or its right edge the start stays put, on the left edge the end stays put;
    **Ctrl + wheel** over a clip stretches or compresses it in steps.
  - Clip timing is part of the clip (`ClipTiming` in `layers.hpp`; `--start`,
    `--trim-in`, `--trim-out`, `--speed`, `--repeat`, `--extend`, `--fade-in`,
    `--fade-out`, `--ease-fades`, `--empty-before`, `--end` and `--align-root` in `kmd-anim
    layers`; `timing` in `/api/layers`). It is therefore baked, foot-locked and exported
    like everything else, and saved in scenes.
  - Not yet: root yaw continuation across repeats (only travel), and retiming curves
    (time warping).
- **Main timeline frame controls** (play bar): |◀ ◀ ▶ ▶| and a *Frame* field (keys: ← / →,
  Shift: 10 frames, Home / End); a **playback range** *In* / *Out* (frames; `[` / `]` or
  I / O set them at the current frame, ⟷ resets) inside which play and loop stay, shown
  dimmed outside on the timeline; and the **scene Length** in seconds (0 = the end of the
  last clip): shorter cuts the result, longer holds the clips' ends. The length is
  baked and exported (`--length` in `kmd-anim layers`, `length` in `/api/layers` and
  `/api/export`) and saved in scenes with the range.
- **Deep links:**
  - `/studio/?load=samples/test_rig.glb&joint=LeftArm`
  - `/studio/?motion=sample:soma30-walk-s42&mode=path&preset=scurve&frame=45`
  - `/studio/?load=samples/test_rig_mixamo_apose.glb&motion=sample:soma30-walk-s42&mode=inplace&align=1&mapping=open`
  - `/studio/?load=samples/test_rig.glb&motion=sample:soma30-walk-s42&stack=demo&mask=custom` (a demo second track: additive upper body)
  - `…&footlock=1` turns foot locking on; `…&export=1` runs the export once the motion is ready; `/studio/?load=<url of a .glb>&embedded=<animation>&frame=45` reopens a file

| Endpoint | Purpose |
|---|---|
| `GET /studio/motions` | motion sources (`sample:<dir>`, `animation:<id>`) |
| `GET /studio/motions/<id>/{root,rotations}.f32` | source arrays |
| `GET /api/skeletons/<key>` | native skeleton names, parents and offsets |
| `POST /api/root-motion` | `{source, mode, lock?, path?{points,interpolation,loop}, timing?, duration?, speed?, orient?}` |
| `GET /api/root-motion/<id>/{root,rotations,path}.f32` | result, cached by request hash |
| `POST /api/characters` | upload a `.glb` (≤ 128 MiB) → `{"id":"upload:<hash>"}`; sample rigs are `sample:<file>` |
| `GET /api/retarget/map?character=&skeleton=` | automatic mapping + diagnostics |
| `POST /api/retarget/check` | `{character, skeleton, mapping}` → diagnostics |
| `POST /api/retarget` | `{root_motion:{…}, character, mapping?, align_rest?, root_scale?, yaw?}` |
| `GET /api/retarget/<id>/{retarget.json,rotations.f32,translations.f32}` | result, cached by request hash |
| `POST /api/layers` | `{character?, mapping?, align_rest?, length?, foot_lock?:{enabled, height?, speed?, blend?, adjust_hips?}, layers:[{name, root_motion \| keys, mode, weight, mask, enabled, muted, reference, wrap, timing}]}` (1–64 clips and layers, in stack order) |
| `GET /api/layers/<id>/{clip.json,rotations.f32,translations.f32,root.f32}` | baked stack, cached by request hash |
| `GET /api/masks?character=…` or `?skeleton=…` | preset masks (full / upper / lower) from `kmd-anim masks` |
| `DELETE /studio/motions/animation:<id>` | delete a generated animation (gallery entry and files) |
| `GET /api/characters/<hash>.glb` | an uploaded character (used to reopen saved scenes) |
| `POST /api/export` | `{name?, character, mapping?, align_rest?, layers:[…]}` → `{url, download, bytes, meta}` |
| `GET /api/export/<id>/<name>.glb[?download=1]` | the exported GLB (inline for the viewer, or as an attachment) |

Results are cached under the demo output directory by a hash of the request and of the
`kmd-anim` binary (size and modification time), so a rebuilt tool never serves stale
results.

The demo finds `kmd-anim` next to `-generator`; override that location with `-anim`.

Three.js r170 is loaded from jsDelivr, so the viewer needs network access.

## Tests

```sh
cmake --build build --config Release
ctest --test-dir build -C Release -R anim     # needs no model weights
go test ./demo
```

On Windows put `build/bin/Release` (ggml DLLs) on `PATH` before running the GGML tests.

**Generation regression guard.** Configure with `-DKIMODO_BASELINE_PARITY=ON`. The test
`kimodo-generate-baseline-parity` then:
- runs `kmd-generate` with the recorded prompt, frames, steps and seed of
  `tests/data/baseline/soma30-walk-s42`;
- requires the outputs to be bit-identical to `SHA256SUMS`.

It needs `models/kimodo-soma-rp-v1.1-f32.gguf` and `Llama-3-Kimodo-Q8_0.gguf`; override the
paths with `KIMODO_BASELINE_MOTION` and `KIMODO_BASELINE_TEXT`. The baseline was captured
on Vulkan with an RTX 4070 Laptop, so on other backends or GPUs recapture it before using
it.

| Suite | What it covers |
|---|---|
| `kimodo-anim-skeleton-test` | math, native skeletons, FK, glTF import (vs inverse bind matrices) |
| `kimodo-anim-root-motion-test` | clip conversion, Full bit-exact, InPlace drift, MotionPath geometry/timing/degenerate cases |
| `kimodo-anim-retarget-test` | roles, mapping JSON/diagnostics, rest pose, axis flips, limb lengths, facing, A-pose |
| `kimodo-anim-layers-test` | Override/Additive, masks, enable vs mute, weights, quaternion edge cases, fps/durations |
| `kimodo-anim-export-test` | GLB round trip (skeleton, mesh, skin, IBMs, poses at start/middle/end) |
| `kimodo-anim-ik-test` | two-bone IK (reach, bone lengths, knee plane, degenerate cases), contacts, foot locking on native, retargeted and path-following walks |
| `kimodo-anim-*-cli` | `kmd-anim` subcommands end to end |
| `go test ./demo` | studio routes, root motion, retarget, layers, export endpoints (with the real `kmd-anim`) |
| `kimodo-generate-baseline-parity` | the original generation path is unchanged (opt-in) |

## MVP definition of done

| # | Requirement (MVP_PLAN §11) | Where it is verified |
|---|---|---|
| 1 | original project builds, existing tests unchanged | full build; same 12 environment-only failures as at step 0 (missing smplx model/fixtures/numpy), no new failures |
| 2 | a rigged GLB is imported and shown | `kimodo-anim-skeleton-test`, studio |
| 3 | skeleton inspectable, joints selectable | studio hierarchy, picking, inspector |
| 4 | Kimodo motion in Full and InPlace | `kimodo-anim-root-motion-test` (Full bit-exact, InPlace drift < 1e-5 m) |
| 5 | waypoints / Catmull–Rom MotionPath | `kimodo-anim-root-motion-test` |
| 6 | retarget onto a compatible humanoid | `kimodo-anim-retarget-test` |
| 7 | two or more layers composed | `kimodo-anim-layers-test`, `TestLayersEndpoint` |
| 8 | Upper Body mask never moves the legs | `kimodo-anim-layers-test` (bit-identical leg joints) |
| 9 | weight, enable and mute verifiable | `kimodo-anim-layers-test` |
| 10 | result shown in the viewport | studio (playback on native skeleton or character) |
| 11 | exported GLB reopens with mesh, skin, animation | `kimodo-anim-export-test`, `TestExportEndpoint`, studio *Open exported* |
| 12 | new features optional, original behaviour unchanged | `KIMODO_BUILD_ANIM` target is separate; `kimodo-generate-baseline-parity`; original demo routes untouched |

## Known limitations

- **Path following** is procedural post-processing. It neither conditions the model nor
  re-times steps.
  - Foot locking removes the sliding caused by curvature, retargeting or moderate speed
    differences.
  - When the path is much faster than the walk (for example 2× or more), no foot is ever
    slow enough to count as a contact, so nothing is locked. Pinning would also be out of
    reach.
- **Foot locking** pins the ankle; toes are not solved separately. Hip lowering is limited
  to 10% of the leg length, and the bend plane comes from the animation. There are no
  arm/hand constraints, look-at or ground-penetration solving beyond the pinned feet.
- **Retargeting** supports humanoids compatible with the source rig.
  - It needs one skin with one root joint and unique joint names.
  - Translations are transferred only for the root; other joints keep their bone lengths.
  - Shear and non-uniform scale in the rig hierarchy are approximated, with no shear.
- **Layers** offer Override and Additive only, with no Multiply, procedural layers or
  weight curves. Additive does not touch scale.
- **Export** writes LINEAR channels sampled at the clip frame rate (no key reduction).
  - Images with remote (`http://`) URIs stay external, and the export reports a warning.
  - Only GLB/glTF are supported; FBX is out of scope for the MVP.
- **Studio**:
  - three.js r170 comes from jsDelivr, so the studio needs network access;
  - every edit is processed on the server, so slider changes are not previewed live;
  - the editor has no keyframe editing and no in-viewport path manipulation;
  - custom masks are edited by joint name.
- **Generation regression test** is bit-exact only on the backend and GPU where the
  baseline was captured.

## Test assets

| File | Purpose |
|---|---|
| `tests/data/baseline/soma30-walk-s42/` | generated soma30 walk (90 f) + `SHA256SUMS`: regression baseline and motion test data |
| `tests/data/rigs/test_rig.glb` | T-pose humanoid: rotated `Armature`, non-topological node order, rest rotations, a non-deforming end joint |
| `tests/data/rigs/test_rig_mixamo_apose.glb` | same with `mixamorig:` names and arms in an A-pose |
| `tests/data/rigs/test_rig_embedded.gltf` | same as JSON glTF with a base64 data-URI buffer (export embedding) |
| `tests/data/rigs/test_rig_helpers.glb` | `test_rig` plus non-deforming `Controls` / `RigBuilder`→`COG` skin roots (Blender control rigs) |
| `tests/data/rigs/test_noskin.glb` | unskinned mesh (must be rejected) |

All rigs are generated by `scripts/make_test_rig_glb.py` (standard library only) and are
deterministic.
