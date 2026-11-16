# Kimodo Extended: GLB <-> FBX conversion through Blender (run in background mode).
#
#   blender -b --factory-startup --python demo/blender_fbx.py -- glb2fbx IN.glb OUT.fbx [--fps 30]
#   blender -b --factory-startup --python demo/blender_fbx.py -- fbx2glb IN.fbx OUT.glb
#
# glb2fbx: the studio's export (the character with its baked clip(s): several animations
#   become one FBX take each) as an FBX for Maya,
#   MotionBuilder, Unreal, Unity: Y up, -Z forward, cm (Blender's FBX unit handling),
#   the animation baked on every frame, no leaf bones, textures embedded.
# fbx2glb: a rigged FBX character as a GLB the studio and kmd-anim read (skin and mesh; the
#   FBX's own animations are kept: the studio lists them as embedded animations).
# Prints one JSON line on success: {"ok":true,"frames":N,"bones":N,"meshes":N}.
import json
import sys

import bpy


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 3 or argv[0] not in ("glb2fbx", "fbx2glb"):
        raise SystemExit("usage: -- glb2fbx|fbx2glb IN OUT [--fps N]")
    fps = 30
    if "--fps" in argv:
        fps = int(argv[argv.index("--fps") + 1])
    return argv[0], argv[1], argv[2], fps


def counts():
    bones = sum(len(o.data.bones) for o in bpy.data.objects if o.type == "ARMATURE")
    meshes = sum(1 for o in bpy.data.objects if o.type == "MESH")
    return bones, meshes


def glb2fbx(src, dst, fps):
    scene = bpy.context.scene
    scene.render.fps = fps  # the glTF importer turns seconds into frames at the scene rate
    scene.render.fps_base = 1.0
    bpy.ops.import_scene.gltf(filepath=src)
    # The glTF importer draws bones with a custom shape (an icosphere object): not part of
    # the character, so it must not end up in the FBX as a mesh.
    shapes = set()
    for o in bpy.data.objects:
        if o.type == "ARMATURE":
            for pb in o.pose.bones:
                if pb.custom_shape:
                    shapes.add(pb.custom_shape)
                    pb.custom_shape = None
    for s in shapes:
        bpy.data.objects.remove(s, do_unlink=True)
    frames = 0
    actions = list(bpy.data.actions)
    # Several animations (studio takes): each becomes its own FBX take.
    all_actions = len(actions) > 1
    if actions:
        start, end = actions[0].frame_range
        scene.frame_start, scene.frame_end = int(round(start)), int(round(end))
        frames = scene.frame_end - scene.frame_start + 1
    bpy.ops.export_scene.fbx(
        filepath=dst, use_selection=False, object_types={"ARMATURE", "MESH", "EMPTY"},
        add_leaf_bones=False, bake_anim=True, bake_anim_use_all_bones=True,
        bake_anim_use_nla_strips=False, bake_anim_use_all_actions=all_actions,
        bake_anim_force_startend_keying=True, bake_anim_step=1.0, bake_anim_simplify_factor=0.0,
        path_mode="COPY", embed_textures=True, axis_forward="-Z", axis_up="Y",
        primary_bone_axis="Y", secondary_bone_axis="X", armature_nodetype="NULL")
    return frames


def fbx2glb(src, dst):
    bpy.ops.import_scene.fbx(filepath=src, ignore_leaf_bones=False, automatic_bone_orientation=False)
    bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_animations=True,
                              export_skins=True, export_yup=True)
    return 0


def main():
    mode, src, dst, fps = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    frames = glb2fbx(src, dst, fps) if mode == "glb2fbx" else fbx2glb(src, dst)
    bones, meshes = counts()
    print(json.dumps({"ok": True, "frames": frames, "bones": bones, "meshes": meshes}))


main()
