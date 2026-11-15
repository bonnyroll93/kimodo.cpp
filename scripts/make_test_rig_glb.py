#!/usr/bin/env python3
"""Generate the small rigged GLB characters used by Kimodo Extended tests and the studio viewer.

Standard library only. Writes, into OUTPUT_DIR (default tests/data/rigs):
  test_rig.glb     skinned humanoid with deliberately awkward structure:
                   * a non-joint "Armature" ancestor with rotation + translation,
                   * joint nodes stored children-before-parents (non-topological),
                   * non-identity rest rotations on arms and legs,
                   * a non-deforming end joint (HeadTop_End);
  test_noskin.glb  the same hierarchy with an unskinned mesh (importer must reject it);
  test_rig_mixamo_apose.glb
                   the skinned rig with "mixamorig:" joint names and arms in an A-pose.
"""
import json
import math
import struct
import sys
from pathlib import Path

# name, parent, translation, rotation (axis, degrees) or None
JOINTS = [
    ("Hips", None, (0.0, 1.0, 0.0), None),
    ("Spine", "Hips", (0.0, 0.12, 0.0), None),
    ("Chest", "Spine", (0.0, 0.2, 0.0), None),
    ("Neck", "Chest", (0.0, 0.25, 0.0), None),
    ("Head", "Neck", (0.0, 0.1, 0.0), None),
    ("HeadTop_End", "Head", (0.0, 0.22, 0.0), None),
    ("LeftArm", "Chest", (0.18, 0.2, 0.0), ((0, 0, 1), -90.0)),
    ("LeftForeArm", "LeftArm", (0.0, 0.28, 0.0), None),
    ("LeftHand", "LeftForeArm", (0.0, 0.25, 0.0), None),
    ("RightArm", "Chest", (-0.18, 0.2, 0.0), ((0, 0, 1), 90.0)),
    ("RightForeArm", "RightArm", (0.0, 0.28, 0.0), None),
    ("RightHand", "RightForeArm", (0.0, 0.25, 0.0), None),
    ("LeftUpLeg", "Hips", (0.1, -0.05, 0.0), ((0, 0, 1), 180.0)),
    ("LeftLeg", "LeftUpLeg", (0.0, 0.42, 0.0), None),
    ("LeftFoot", "LeftLeg", (0.0, 0.42, 0.0), ((1, 0, 0), 90.0)),
    ("LeftToeBase", "LeftFoot", (0.0, 0.12, 0.0), None),
    ("RightUpLeg", "Hips", (-0.1, -0.05, 0.0), ((0, 0, 1), 180.0)),
    ("RightLeg", "RightUpLeg", (0.0, 0.42, 0.0), None),
    ("RightFoot", "RightLeg", (0.0, 0.42, 0.0), ((1, 0, 0), 90.0)),
    ("RightToeBase", "RightFoot", (0.0, 0.12, 0.0), None),
]
NON_DEFORMING = {"HeadTop_End"}
ARMATURE_T = (0.5, 0.0, -0.25)
ARMATURE_R = ((0, 1, 0), 90.0)
LEAF_LENGTH = 0.08
HALF_WIDTH = 0.045


def quat(axis_deg):
    if axis_deg is None:
        return (0.0, 0.0, 0.0, 1.0)
    (ax, ay, az), deg = axis_deg
    n = math.sqrt(ax * ax + ay * ay + az * az)
    s = math.sin(math.radians(deg) / 2)
    return (ax / n * s, ay / n * s, az / n * s, math.cos(math.radians(deg) / 2))


def trs_matrix(t, q, s=(1.0, 1.0, 1.0)):
    """Column-major 4x4 as a flat list (glTF layout)."""
    x, y, z, w = q
    r = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ]
    m = [0.0] * 16
    for c in range(3):
        for row in range(3):
            m[c * 4 + row] = r[row][c] * s[c]
    m[12], m[13], m[14], m[15] = t[0], t[1], t[2], 1.0
    return m


def mat_mul(a, b):
    out = [0.0] * 16
    for c in range(4):
        for row in range(4):
            out[c * 4 + row] = sum(a[k * 4 + row] * b[c * 4 + k] for k in range(4))
    return out


def mat_apply(m, p):
    return tuple(m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row] for row in range(3))


def mat_inverse_rigid(m):
    """Inverse of a rotation+translation matrix (all test transforms are rigid)."""
    inv = [0.0] * 16
    for c in range(3):
        for row in range(3):
            inv[c * 4 + row] = m[row * 4 + c]
    for row in range(3):
        inv[12 + row] = -sum(inv[k * 4 + row] * m[12 + k] for k in range(3))
    inv[15] = 1.0
    return inv


def box(m, length):
    """Flat-shaded box along local +Y from 0 to length, transformed by m. Returns (pos, nrm, idx)."""
    h = HALF_WIDTH
    faces = [  # normal, four corners (counter-clockwise seen from outside)
        ((1, 0, 0), [(h, 0, -h), (h, length, -h), (h, length, h), (h, 0, h)]),
        ((-1, 0, 0), [(-h, 0, h), (-h, length, h), (-h, length, -h), (-h, 0, -h)]),
        ((0, 1, 0), [(-h, length, -h), (-h, length, h), (h, length, h), (h, length, -h)]),
        ((0, -1, 0), [(-h, 0, h), (-h, 0, -h), (h, 0, -h), (h, 0, h)]),
        ((0, 0, 1), [(-h, 0, h), (h, 0, h), (h, length, h), (-h, length, h)]),
        ((0, 0, -1), [(h, 0, -h), (-h, 0, -h), (-h, length, -h), (h, length, -h)]),
    ]
    pos, nrm, idx = [], [], []
    for n, corners in faces:
        base = len(pos)
        wn = tuple(m[row] * n[0] + m[4 + row] * n[1] + m[8 + row] * n[2] for row in range(3))
        for c in corners:
            pos.append(mat_apply(m, c))
            nrm.append(wn)
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return pos, nrm, idx


class Bin:
    def __init__(self):
        self.data = bytearray()
        self.views = []
        self.accessors = []

    def add(self, payload, target=None):
        while len(self.data) % 4:
            self.data.append(0)
        view = {"buffer": 0, "byteOffset": len(self.data), "byteLength": len(payload)}
        if target:
            view["target"] = target
        self.data += payload
        self.views.append(view)
        return len(self.views) - 1

    def accessor(self, payload, component, count, kind, target=None, minmax=None):
        acc = {"bufferView": self.add(payload, target), "componentType": component, "count": count, "type": kind}
        if minmax:
            acc["min"], acc["max"] = minmax
        self.accessors.append(acc)
        return len(self.accessors) - 1


def build(skinned, prefix="", arm_deg=90.0):
    """prefix: namespace for node names (e.g. "mixamorig:"); arm_deg: 90 = T-pose, 135 = A-pose."""
    joints = [(n, p, t, ((0, 0, 1), -arm_deg) if n == "LeftArm" else ((0, 0, 1), arm_deg) if n == "RightArm" else r)
              for n, p, t, r in JOINTS]
    names = [j[0] for j in joints]
    local = {n: trs_matrix(t, quat(r)) for n, _, t, r in joints}
    armature = trs_matrix(ARMATURE_T, quat(ARMATURE_R))
    world = {}
    for n, p, _, _ in joints:
        world[n] = mat_mul(world[p] if p else armature, local[n])
    children = {n: [c for c, p, _, _ in joints if p == n] for n in names}

    # Node order: reversed joint list puts every child before its parent.
    order = list(reversed(names))
    node_of = {n: i for i, n in enumerate(order)}
    nodes = []
    for n in order:
        _, _, t, r = next(j for j in joints if j[0] == n)
        node = {"name": prefix + n, "translation": list(t)}
        if r is not None:
            node["rotation"] = list(quat(r))
        if children[n]:
            node["children"] = [node_of[c] for c in children[n]]
        nodes.append(node)
    armature_node = len(nodes)
    nodes.append({"name": "Armature", "translation": list(ARMATURE_T), "rotation": list(quat(ARMATURE_R)),
                  "children": [node_of["Hips"]]})

    # Mesh: one rigid box per deforming joint, skinned to that joint only.
    skin_joints = order  # skin joint list follows node order
    skin_index = {n: i for i, n in enumerate(skin_joints)}
    pos, nrm, jnt, wts, idx = [], [], [], [], []
    for n in names:
        if n in NON_DEFORMING:
            continue
        length = (math.dist(mat_apply(world[children[n][0]], (0, 0, 0)), mat_apply(world[n], (0, 0, 0)))
                  if children[n] else LEAF_LENGTH)
        p, nr, ix = box(world[n], length)
        base = len(pos)
        pos += p
        nrm += nr
        idx += [base + i for i in ix]
        jnt += [(skin_index[n], 0, 0, 0)] * len(p)
        wts += [(1.0, 0.0, 0.0, 0.0)] * len(p)

    b = Bin()
    lo = [min(v[k] for v in pos) for k in range(3)]
    hi = [max(v[k] for v in pos) for k in range(3)]
    attrs = {
        "POSITION": b.accessor(b"".join(struct.pack("<3f", *v) for v in pos), 5126, len(pos), "VEC3", 34962, (lo, hi)),
        "NORMAL": b.accessor(b"".join(struct.pack("<3f", *v) for v in nrm), 5126, len(nrm), "VEC3", 34962),
    }
    if skinned:
        attrs["JOINTS_0"] = b.accessor(b"".join(struct.pack("<4B", *v) for v in jnt), 5121, len(jnt), "VEC4", 34962)
        attrs["WEIGHTS_0"] = b.accessor(b"".join(struct.pack("<4f", *v) for v in wts), 5126, len(wts), "VEC4", 34962)
    indices = b.accessor(b"".join(struct.pack("<H", i) for i in idx), 5123, len(idx), "SCALAR", 34963)

    mesh_node = {"name": "Body", "mesh": 0}
    gltf = {
        "asset": {"version": "2.0", "generator": "kimodo-extended make_test_rig_glb.py"},
        "scene": 0,
        "nodes": nodes,
        "meshes": [{"name": "Body", "primitives": [{"attributes": attrs, "indices": indices, "material": 0}]}],
        "materials": [{"name": "Clay", "pbrMetallicRoughness": {"baseColorFactor": [0.78, 0.62, 0.48, 1.0],
                                                                "metallicFactor": 0.0, "roughnessFactor": 0.8}}],
    }
    if skinned:
        ibm = b"".join(struct.pack("<16f", *mat_inverse_rigid(world[n])) for n in skin_joints)
        gltf["skins"] = [{"name": "Rig", "joints": [node_of[n] for n in skin_joints],
                          "inverseBindMatrices": b.accessor(ibm, 5126, len(skin_joints), "MAT4"),
                          "skeleton": armature_node}]
        mesh_node["skin"] = 0
    nodes.append(mesh_node)
    gltf["scenes"] = [{"name": "Scene", "nodes": [armature_node, len(nodes) - 1]}]
    gltf["accessors"] = b.accessors
    gltf["bufferViews"] = b.views
    gltf["buffers"] = [{"byteLength": len(b.data)}]
    return gltf, bytes(b.data)


def write_glb(path, gltf, binary):
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(js), b"JSON") + js)
        f.write(struct.pack("<I4s", len(binary), b"BIN\0") + binary)


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "tests/data/rigs"
    out.mkdir(parents=True, exist_ok=True)
    write_glb(out / "test_rig.glb", *build(skinned=True))
    write_glb(out / "test_noskin.glb", *build(skinned=False))
    write_glb(out / "test_rig_mixamo_apose.glb", *build(skinned=True, prefix="mixamorig:", arm_deg=135.0))
    print(f"wrote test_rig.glb, test_noskin.glb and test_rig_mixamo_apose.glb to {out}")


if __name__ == "__main__":
    main()
