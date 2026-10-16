# Shared helpers, executed before every tool body (see addon/blender_mcp_bridge).
# Keep this file free of side effects: it only defines names.

import math
import os
import re
import tempfile

import bpy
from mathutils import Matrix, Vector, Euler, Quaternion


# --- Lookup -----------------------------------------------------------------------------

def get_object(name):
    o = bpy.data.objects.get(name)
    if o is None:
        names = [x.name for x in bpy.data.objects][:60]
        raise KeyError(f"No object named {name!r}. Objects: {names}")
    return o


def scene():
    return bpy.context.scene


def r(v, nd=4):
    """Round floats/vectors for compact readable output."""
    if isinstance(v, (int, bool)) or v is None:
        return v
    if isinstance(v, float):
        return round(v, nd)
    return [round(float(x), nd) for x in v]


def summarize(o):
    d = {
        "name": o.name,
        "type": o.type,
        "location": r(o.location),
        "rotation_euler_deg": r([math.degrees(a) for a in o.rotation_euler], 2),
        "scale": r(o.scale),
        "parent": o.parent.name if o.parent else None,
        "collections": [c.name for c in o.users_collection],
        "hide_viewport": o.hide_viewport,
        "hide_render": o.hide_render,
        "visible": o.visible_get() if bpy.context.view_layer.objects.get(o.name) else False,
        "animated": is_animated(o),
    }
    if o.type == "MESH" and o.data:
        d["mesh"] = {"verts": len(o.data.vertices), "faces": len(o.data.polygons)}
    if getattr(o, "material_slots", None):
        d["materials"] = [s.material.name if s.material else None for s in o.material_slots]
    if o.type == "CAMERA":
        c = o.data
        d["camera"] = {"type": c.type, "lens": r(c.lens), "sensor_width": r(c.sensor_width),
                       "sensor_fit": c.sensor_fit, "shift": r([c.shift_x, c.shift_y]),
                       "clip": r([c.clip_start, c.clip_end])}
    if o.type == "LIGHT":
        d["light"] = {"type": o.data.type, "energy": r(o.data.energy), "color": r(o.data.color)}
    if o.modifiers:
        d["modifiers"] = [f"{m.name} ({m.type})" for m in o.modifiers]
    if o.constraints:
        d["constraints"] = [f"{c.name} ({c.type})" for c in o.constraints]
    return d


# --- Animation helpers -----------------------------------------------------------------

def fcurves_for(id_block):
    """F-curves of an ID's action, for both layered (4.4+/5.x) and legacy actions."""
    ad = getattr(id_block, "animation_data", None)
    if not ad or not ad.action:
        return []
    action = ad.action
    if hasattr(action, "layers") and action.layers:
        try:
            from bpy_extras.anim_utils import action_get_channelbag_for_slot
            cb = action_get_channelbag_for_slot(action, ad.action_slot)
            return list(cb.fcurves) if cb else []
        except Exception:
            pass
    return list(getattr(action, "fcurves", []))


def is_animated(o):
    """True if anything could move the object's world matrix over time."""
    cur = o
    while cur is not None:
        if fcurves_for(cur) or cur.constraints:
            return True
        ad = cur.animation_data
        if ad and (ad.drivers or (ad.nla_tracks and len(ad.nla_tracks))):
            return True
        if cur.type == "CAMERA" and fcurves_for(cur.data):
            return True
        cur = cur.parent
    return False


# --- Blender <-> After Effects space conversion -----------------------------------------
#
# Blender: right-handed, X right, Y forward (depth), Z up, metres.
# AE:      X right, Y down, Z into the screen, pixels, origin at the comp's top-left.
# AE_pos = C @ blender_pos * ppm + (w/2, h/2, 0): Blender's world origin lands at the comp
# centre on AE's z=0 plane. Orientation: R_ae = C @ R_b @ X, where X = C^T for plain
# objects (nulls), and X = D for things that "look" down an axis: Blender cameras look
# down local -Z with +Y up, AE cameras look down +z with -y up; Blender planes face +Z,
# AE layers face -z. AE applies rotations Z then Y then X (R = Rx @ Ry @ Rz), which is
# mathutils' 'ZYX' Euler order.

C = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
D = Matrix(((1, 0, 0), (0, -1, 0), (0, 0, -1)))


def _flips(o_type):
    return o_type in ("CAMERA", "PLANE")


def b2ae_transform(mw, ppm, w, h, kind, prev_euler=None):
    loc, rot, scl = mw.decompose()
    R = rot.to_matrix()
    R_ae = C @ R @ (D if _flips(kind) else C.transposed())
    e = R_ae.to_euler("ZYX", prev_euler) if prev_euler else R_ae.to_euler("ZYX")
    p = C @ loc * ppm
    if _flips(kind):
        s = (scl.x, scl.y, scl.z)
    else:
        s = (scl.x, scl.z, scl.y)
    return {
        "position": [p.x + w / 2.0, p.y + h / 2.0, p.z],
        "rotation": [math.degrees(e.x), math.degrees(e.y), math.degrees(e.z)],
        "scale": [s[0] * 100.0, s[1] * 100.0, s[2] * 100.0],
    }, e


def ae2b_matrix(origin, ax, ay, az, ppm, w, h, kind):
    """World matrix from an AE layer's toWorld() samples (origin + local unit axes)."""
    o = Vector(origin)
    vx, vy, vz = Vector(ax) - o, Vector(ay) - o, Vector(az) - o
    sx, sy, sz = vx.length or 1.0, vy.length or 1.0, vz.length or 1.0
    R_ae = Matrix((vx / sx, vy / sy, vz / sz)).transposed()  # columns = local axes
    R_b = C.transposed() @ R_ae @ (D if _flips(kind) else C)
    loc = C.transposed() @ ((o - Vector((w / 2.0, h / 2.0, 0.0))) / ppm)
    scl = (sx, sy, sz) if _flips(kind) else (sx, sz, sy)
    return Matrix.LocRotScale(loc, R_b.to_quaternion(), Vector(scl))


def camera_zoom_px(cam, w, h):
    """AE camera Zoom (pixels) equivalent to a Blender perspective camera."""
    c = cam.data
    fit = c.sensor_fit
    if fit == "AUTO":
        fit = "HORIZONTAL" if w >= h else "VERTICAL_AUTO"
    if fit == "HORIZONTAL":
        return c.lens / c.sensor_width * w
    if fit == "VERTICAL_AUTO":  # AUTO fit on a portrait frame uses sensor_width on the long side
        return c.lens / c.sensor_width * h
    return c.lens / c.sensor_height * h


def render_size(sc=None):
    sc = sc or scene()
    pct = sc.render.resolution_percentage / 100.0
    return int(round(sc.render.resolution_x * pct)), int(round(sc.render.resolution_y * pct))


def fps(sc=None):
    sc = sc or scene()
    return sc.render.fps / sc.render.fps_base


def sample_for_ae(names, camera_name, ppm, frame_start, frame_end, step=1):
    """Samples world transforms of objects (and a camera) per frame, in AE space."""
    sc = scene()
    w, h = render_size(sc)
    cam = get_object(camera_name) if camera_name else None
    if cam is not None and cam.type != "CAMERA":
        raise TypeError(f"{camera_name!r} is not a camera")
    objs = [get_object(n) for n in names]
    items = []
    if cam:
        items.append((cam, "CAMERA"))
    items += [(o, "NULL") for o in objs]
    if not items:
        raise ValueError("Nothing to export: give a camera and/or object names")

    animated = {o.name: is_animated(o) for o, _ in items}
    frames = list(range(frame_start, frame_end + 1, step)) if any(animated.values()) else [frame_start]
    out = {o.name: {"kind": k, "animated": animated[o.name], "frames": []} for o, k in items}
    prev = {}
    warnings = []
    if cam:
        if cam.data.type != "PERSP":
            warnings.append(f"Camera {cam.name!r} is {cam.data.type}; AE cameras are perspective only.")
        if abs(cam.data.shift_x) > 1e-6 or abs(cam.data.shift_y) > 1e-6:
            warnings.append("Camera has lens shift, which AE cameras cannot reproduce: framing will differ.")

    original = sc.frame_current
    try:
        for f in frames:
            sc.frame_set(f)
            for o, kind in items:
                if not animated[o.name] and out[o.name]["frames"]:
                    continue
                t, e = b2ae_transform(o.matrix_world, ppm, w, h, kind, prev.get(o.name))
                prev[o.name] = e
                t["frame"] = f
                if kind == "CAMERA":
                    t["zoom"] = camera_zoom_px(o, w, h)
                    if o.data.dof.use_dof:
                        t["focus_distance"] = o.data.dof.focus_distance * ppm
                        t["f_stop"] = o.data.dof.aperture_fstop
                out[o.name]["frames"].append(t)
    finally:
        sc.frame_set(original)

    return {
        "width": w, "height": h, "fps": fps(sc), "ppm": ppm,
        "frame_start": frame_start, "frame_end": frame_end,
        "scene": sc.name, "file": bpy.data.filepath,
        "items": out, "warnings": warnings,
    }


def _keyframe_matrix(o, f):
    o.keyframe_insert("location", frame=f)
    o.keyframe_insert("rotation_euler", frame=f)
    o.keyframe_insert("scale", frame=f)


def apply_from_ae(data, ppm, collection_name, set_scene, frame_offset):
    """Creates/updates Blender objects from AE samples produced by the import_from_ae JSX."""
    sc = scene()
    w, h, rate = data["width"], data["height"], data["fps"]
    if set_scene:
        sc.render.resolution_x, sc.render.resolution_y = w, h
        sc.render.resolution_percentage = 100
        if abs(rate - round(rate)) < 1e-3:
            sc.render.fps, sc.render.fps_base = int(round(rate)), 1.0
        else:  # 23.976, 29.97...
            sc.render.fps, sc.render.fps_base = int(math.ceil(rate)), math.ceil(rate) / rate
        sc.frame_start = frame_offset
        sc.frame_end = frame_offset + data["num_frames"] - 1

    coll = bpy.data.collections.get(collection_name)
    if coll is None:
        coll = bpy.data.collections.new(collection_name)
        sc.collection.children.link(coll)

    created = []
    for layer in data["layers"]:
        name, kind = layer["name"], layer["kind"]
        o = bpy.data.objects.get(name)
        if kind == "CAMERA":
            if o is None or o.type != "CAMERA":
                o = bpy.data.objects.new(name, bpy.data.cameras.new(name))
            o.data.sensor_fit = "HORIZONTAL"
            o.data.sensor_width = 36.0
        elif kind == "PLANE":
            mesh = _ae_plane_mesh(name, layer, ppm)
            if o is None or o.type != "MESH":
                o = bpy.data.objects.new(name, mesh)
            else:
                o.data = mesh
            if layer.get("source"):
                _assign_footage_material(o, layer["source"], frame_offset)
            elif layer.get("solid_color"):
                _assign_solid_material(o, layer["solid_color"])
        else:
            if o is None or o.type != "EMPTY":
                o = bpy.data.objects.new(name, None)
                o.empty_display_type = "PLAIN_AXES"
                o.empty_display_size = 0.5
        if coll not in o.users_collection:
            coll.objects.link(o)
        o.parent = None
        o.rotation_mode = "XYZ"
        if o.animation_data:
            o.animation_data_clear()
        if kind == "CAMERA" and o.data.animation_data:
            o.data.animation_data_clear()

        samples = layer["samples"]
        prev = None
        for i, s in enumerate(samples):
            m = ae2b_matrix(s["o"], s["x"], s["y"], s["z"], ppm, w, h, kind)
            o.matrix_world = m
            if prev is not None:
                o.rotation_euler = o.rotation_euler.to_matrix().to_euler("XYZ", prev)
            prev = o.rotation_euler.copy()
            if kind == "CAMERA" and s.get("zoom"):
                o.data.lens = s["zoom"] * o.data.sensor_width / w
            if len(samples) > 1:
                f = frame_offset + i * layer.get("step", 1)
                _keyframe_matrix(o, f)
                if kind == "CAMERA":
                    o.data.keyframe_insert("lens", frame=f)
        if len(samples) > 1:
            for fc in fcurves_for(o) + (fcurves_for(o.data) if kind == "CAMERA" else []):
                for k in fc.keyframe_points:
                    k.interpolation = "LINEAR"
        created.append({"name": o.name, "kind": kind, "keys": len(samples) if len(samples) > 1 else 0})

    cams = [l["name"] for l in data["layers"] if l["kind"] == "CAMERA"]
    if set_scene and cams:
        sc.camera = bpy.data.objects[cams[0]]
    return created


def _ae_plane_mesh(name, layer, ppm):
    """Plane matching an AE layer's size, with its origin at the layer's anchor point."""
    lw, lh = layer["width"], layer["height"]
    ax, ay = layer.get("anchor", [lw / 2.0, lh / 2.0])[:2]
    # AE layer-local (x right, y down) -> Blender plane-local via D: y flips.
    x0, x1 = -ax / ppm, (lw - ax) / ppm
    y0, y1 = (ay - lh) / ppm, ay / ppm
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0)], [], [(0, 1, 2, 3)])
    uv = mesh.uv_layers.new(name="UVMap")
    for loop, co in zip(uv.data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        loop.uv = co
    mesh.update()
    return mesh


def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _assign_solid_material(o, color):
    """Flat unlit material matching an AE solid (AE stores display sRGB; Blender wants linear)."""
    mat = bpy.data.materials.get(o.name) or bpy.data.materials.new(o.name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = [_srgb_to_linear(c) for c in color[:3]] + [1.0]
    nt.links.new(emit.outputs[0], out.inputs["Surface"])
    emit.location, out.location = (-200, 0), (0, 0)
    mat.diffuse_color = list(emit.inputs["Color"].default_value)
    if not o.material_slots:
        o.data.materials.append(mat)
    else:
        o.material_slots[0].material = mat


def _assign_footage_material(o, source, frame_offset):
    path = source["path"]
    mat = bpy.data.materials.get(o.name) or bpy.data.materials.new(o.name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    transp = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    tex = nt.nodes.new("ShaderNodeTexImage")
    img = bpy.data.images.load(path, check_existing=True)
    if source.get("is_sequence"):
        img.source = "SEQUENCE"
    elif source.get("is_movie"):
        img.source = "MOVIE"
    img.size[0]  # loads the header, so the movie's colour space (e.g. Rec.2100-HLG) is detected now
    tex.image = img
    if img.source in ("SEQUENCE", "MOVIE"):
        tex.image_user.frame_duration = max(1, int(source.get("frames", 1)))
        tex.image_user.frame_start = frame_offset + int(source.get("start_offset_frames", 0))
        if img.source == "SEQUENCE":
            # Blender reads file number (scene_frame - frame_start + 1) + frame_offset
            tex.image_user.frame_offset = int(source.get("first_number", 1)) - 1
        tex.image_user.use_auto_refresh = True
    nt.links.new(tex.outputs["Color"], emit.inputs["Color"])
    nt.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
    nt.links.new(transp.outputs[0], mix.inputs[1])
    nt.links.new(emit.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    for i, n in enumerate((tex, emit, transp, mix, out)):
        n.location = (i * 220 - 600, 0)
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "BLENDED"
    if not o.material_slots:
        o.data.materials.append(mat)
    else:
        o.material_slots[0].material = mat


# --- HDR footage -------------------------------------------------------------------------

HDR_COLORSPACES = ("Rec.2100-HLG", "Rec.2100-PQ")
HDR_HINT = ("HDR footage (iPhones record HLG / Dolby Vision). Blender decodes it as HDR, but After Effects in a "
            "Rec.709 project shows the file without converting it, so the plate will look different in each app "
            "(and the CG lit to match Blender will not match AE). To see in Blender what AE shows, set these to "
            "'sRGB' with set_footage_colorspace.")


def hdr_media():
    """Movie clips and images whose colour space is HDR (Rec.2100 HLG/PQ)."""
    out = []
    for kind, coll in (("movieclip", bpy.data.movieclips), ("image", bpy.data.images)):
        for d in coll:
            cs = getattr(getattr(d, "colorspace_settings", None), "name", "")
            if cs in HDR_COLORSPACES:
                out.append({"kind": kind, "name": d.name, "colorspace": cs, "path": d.filepath})
    return out


def hdr_warning():
    items = hdr_media()
    return {"hdr_footage": items, "hint": HDR_HINT} if items else None


# --- Render passes ---------------------------------------------------------------------

PASS_ATTRS = {
    "combined": "use_pass_combined", "z": "use_pass_z", "depth": "use_pass_z", "mist": "use_pass_mist",
    "normal": "use_pass_normal", "vector": "use_pass_vector", "position": "use_pass_position",
    "uv": "use_pass_uv", "ao": "use_pass_ambient_occlusion", "shadow": "use_pass_shadow",
    "emission": "use_pass_emit", "environment": "use_pass_environment",
    "diffuse_direct": "use_pass_diffuse_direct", "diffuse_indirect": "use_pass_diffuse_indirect",
    "diffuse_color": "use_pass_diffuse_color", "glossy_direct": "use_pass_glossy_direct",
    "glossy_indirect": "use_pass_glossy_indirect", "glossy_color": "use_pass_glossy_color",
    "transmission_direct": "use_pass_transmission_direct",
    "transmission_indirect": "use_pass_transmission_indirect",
    "transmission_color": "use_pass_transmission_color",
    "object_index": "use_pass_object_index", "material_index": "use_pass_material_index",
    "crypto_object": "use_pass_cryptomatte_object", "crypto_material": "use_pass_cryptomatte_material",
    "crypto_asset": "use_pass_cryptomatte_asset",
    # engine-specific (view_layer.eevee / view_layer.cycles)
    "volume_direct": "eevee_or_cycles:use_pass_volume_direct", "bloom": "eevee:use_pass_bloom",
    "transparent": "eevee:use_pass_transparent", "shadow_catcher": "cycles:use_pass_shadow_catcher",
}

# Short names for the separate-file outputs (Render Layers socket name -> file tag).
PASS_FILE_TAGS = {
    "Image": "beauty", "Depth": "depth", "Mist": "mist", "Normal": "normal", "Vector": "vector",
    "Position": "position", "UV": "uv", "Ambient Occlusion": "AO", "Shadow": "shadow", "Emission": "emission",
    "Environment": "env", "Diffuse Direct": "diffDir", "Diffuse Indirect": "diffInd", "Diffuse Color": "diffCol",
    "Glossy Direct": "glossDir", "Glossy Indirect": "glossInd", "Glossy Color": "glossCol",
    "Transmission Direct": "transDir", "Transmission Indirect": "transInd", "Transmission Color": "transCol",
    "Object Index": "objIndex", "Material Index": "matIndex", "Volume Direct": "volDir", "Bloom": "bloom",
    "Transparent": "transparent", "Shadow Catcher": "shadowCatcher",
}

PASS_NODE_NAME = "MCP Pass Output"


def set_pass(view_layer, key, value):
    attr = PASS_ATTRS.get(key)
    if attr is None:
        raise KeyError(f"Unknown pass {key!r}. Known: {sorted(PASS_ATTRS)}")
    if ":" in attr:
        where, attr = attr.split(":")
        done = False
        for sub in ("eevee", "cycles"):
            if sub in where and hasattr(view_layer, sub) and hasattr(getattr(view_layer, sub), attr):
                setattr(getattr(view_layer, sub), attr, value)
                done = True
        return done
    setattr(view_layer, attr, value)
    return True


def compositor_tree(sc):
    """The scene's compositor node group, created (Render Layers -> Group Output) if missing."""
    if hasattr(sc.render, "use_compositing"):
        sc.render.use_compositing = True
    ng = sc.compositing_node_group
    if ng is None:
        ng = bpy.data.node_groups.new(f"{sc.name} Compositor", "CompositorNodeTree")
        sc.compositing_node_group = ng
        rl_new = ng.nodes.new("CompositorNodeRLayers")
        rl_new.location = (-300, 0)
        if not any(i.in_out == "OUTPUT" for i in ng.interface.items_tree if hasattr(i, "in_out")):
            ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        go = ng.nodes.new("NodeGroupOutput")
        go.location = (200, 150)
        ng.links.new(rl_new.outputs["Image"], go.inputs[0])
    return ng


def fill_file_output(ng, rl, fo, directory, prefix, depth, codec):
    """Points a File Output node at directory/prefix and wires every enabled non-crypto pass of rl to it."""
    fo.directory = directory
    fo.file_name = prefix
    fo.format.media_type = "IMAGE"
    fo.format.file_format = "OPEN_EXR"
    fo.format.color_depth = depth
    fo.format.exr_codec = codec
    fo.file_output_items.clear()
    written = []
    for sock in rl.outputs:
        if (not sock.enabled or sock.name == "Alpha" or sock.name.startswith(("Crypto", "Noisy", "Denoising"))):
            continue
        tag = PASS_FILE_TAGS.get(sock.name, re.sub(r"\W+", "", sock.name))
        stype = {"VALUE": "FLOAT", "VECTOR": "VECTOR"}.get(sock.type, "RGBA")
        fo.file_output_items.new(stype, tag + "_")
        ng.links.new(sock, fo.inputs[tag + "_"])
        written.append({"pass": sock.name, "file_pattern": f"{prefix}{tag}_####.exr"})
    return written


def setup_separate_outputs(sc, directory, prefix, depth, codec):
    """Adds/refreshes a File Output node writing each non-crypto pass to its own EXR sequence."""
    ng = compositor_tree(sc)
    rl = next((n for n in ng.nodes if n.bl_idname == "CompositorNodeRLayers" and not n.name.startswith(ELEMENT_RL_PREFIX)), None)
    if rl is None:
        rl = ng.nodes.new("CompositorNodeRLayers")
    fo = ng.nodes.get(PASS_NODE_NAME)
    if fo is None:
        fo = ng.nodes.new("CompositorNodeOutputFile")
        fo.name = fo.label = PASS_NODE_NAME
        fo.location = (rl.location.x + 400, rl.location.y - 200)
    return fill_file_output(ng, rl, fo, directory, prefix, depth, codec)


def remove_separate_outputs(sc):
    ng = sc.compositing_node_group
    if ng and ng.nodes.get(PASS_NODE_NAME):
        ng.nodes.remove(ng.nodes[PASS_NODE_NAME])
        return True
    return False


# --- One view layer per element (per-element, per-pass output for AE) -----------------

ELEMENT_RL_PREFIX = "MCP Element RL: "
ELEMENT_FO_PREFIX = "MCP Element Output: "
ELEMENTS_PROP = "mcp_elements"            # scene prop: {element: [collection names]}, in order
DISABLED_LAYERS_PROP = "mcp_disabled_layers"  # scene prop: the user's view layers switched off for it
SHADOW_LAYERS_PROP = "mcp_element_shadow_layers"  # scene prop: shadow-only layers (shadows="per_element")
SHADOWS_PROP = "mcp_element_shadows"      # scene prop: "shared", "per_element" or "none"


def safe_name(s):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", s).strip("_") or "element"


def find_layer_collection(lc, coll):
    if lc.collection == coll:
        return lc
    for c in lc.children:
        found = find_layer_collection(c, coll)
        if found:
            return found
    return None


def _walk_layer_collections(lc):
    yield lc
    for c in lc.children:
        yield from _walk_layer_collections(c)


def element_names(sc):
    data = sc.get(ELEMENTS_PROP)
    return list(data.keys()) if data else []


def _resolve_elements(sc, elements):
    """{element: [collection or object names]} -> {safe name: [collections]}. Loose objects are moved
    into a collection named after the element (holdout works per collection, not per object)."""
    in_scene = set(sc.collection.children_recursive)
    out, moved = {}, []
    for raw, members in elements.items():
        name = safe_name(raw)
        if name in out:
            raise ValueError(f"Two elements end up named {name!r}")
        colls, loose = [], []
        for m in members:
            c = bpy.data.collections.get(m)
            if c is not None:
                if c not in in_scene:
                    raise ValueError(f"Collection {m!r} is not in scene {sc.name!r} (or is the scene's root)")
                colls.append(c)
            else:
                loose.append(get_object(m))
        if loose:
            target = bpy.data.collections.get(name)
            if target is None or target not in in_scene:
                target = bpy.data.collections.new(name)
                sc.collection.children.link(target)
            for o in loose:
                if o.users_collection != (target,):
                    for c in list(o.users_collection):
                        c.objects.unlink(o)
                    target.objects.link(o)
                    moved.append({"object": o.name, "to_collection": target.name})
            if target not in colls:
                colls.append(target)
        if not colls:
            raise ValueError(f"Element {raw!r} has no collections or objects")
        out[name] = colls
    flat = [(n, c) for n, cs in out.items() for c in cs]
    for i, (n1, c1) in enumerate(flat):
        for n2, c2 in flat[i + 1:]:
            if n1 != n2 and (c1 == c2 or c2 in c1.children_recursive or c1 in c2.children_recursive):
                raise ValueError(f"Elements {n1!r} and {n2!r} share collection {c1.name!r}/{c2.name!r}: "
                                 "each object must belong to one element")
    return out, moved


def _remove_element_nodes(sc, keep=()):
    ng = sc.compositing_node_group
    removed = []
    if ng:
        for n in list(ng.nodes):
            for pre in (ELEMENT_RL_PREFIX, ELEMENT_FO_PREFIX):
                if n.name.startswith(pre) and n.name[len(pre):] not in keep:
                    removed.append(n.name)
                    ng.nodes.remove(n)
                    break
    return removed


def _relink_group_output(sc, rl):
    """Points the compositor's Group Output at rl if it is fed by a layer that will not render."""
    ng = sc.compositing_node_group
    go = next((n for n in ng.nodes if n.bl_idname == "NodeGroupOutput"), None) if ng else None
    if go is None or not go.inputs:
        return
    src = go.inputs[0].links[0].from_node if go.inputs[0].is_linked else None
    layer = sc.view_layers.get(getattr(src, "layer", "")) if src else None
    if src is None or (src.bl_idname == "CompositorNodeRLayers" and (layer is None or not layer.use)):
        ng.links.new(rl.outputs["Image"], go.inputs[0])


def _apply_layer_state(vl, tmpl_state, resolved, own, others):
    """Collection flags of one element layer: the template's for the set, `others` for the other elements."""
    for lc in _walk_layer_collections(vl.layer_collection):
        if lc == vl.layer_collection:
            continue
        ex, ho, io = tmpl_state.get(lc.collection.name, (False, False, False))
        lc.exclude = ex
        if not ex:
            lc.holdout, lc.indirect_only = ho, io
    for other, ocolls in resolved.items():
        for c in ocolls:
            lc = find_layer_collection(vl.layer_collection, c)
            mine = other == own
            lc.exclude = (not mine) and others == "exclude"
            if not lc.exclude:
                lc.holdout = (not mine) and others == "holdout"
                lc.indirect_only = (not mine) and others == "indirect_only"


def _get_node(ng, name, kind, location):
    n = ng.nodes.get(name)
    if n is None:
        n = ng.nodes.new(kind)
        n.name = n.label = name
    n.location = location
    return n


def setup_element_layers(sc, elements, others, passes, out_dir, depth, codec, catcher_names, disable_user_layers, shadows):
    resolved, moved = _resolve_elements(sc, elements)
    warnings = []
    cycles = sc.render.engine == "CYCLES"
    if others == "indirect_only" and not cycles:
        warnings.append("indirect_only only works in Cycles; with this engine the other elements render as if fully visible.")

    geometry = {"MESH", "CURVE", "SURFACE", "META", "FONT", "POINTCLOUD", "VOLUME", "CURVES"}
    catchers = {o for o in sc.objects if o.type in geometry and getattr(o, "is_shadow_catcher", False)}
    for n in catcher_names or []:
        o = get_object(n)
        o.is_shadow_catcher = True
        catchers.add(o)
    for o in catchers:
        for name, colls in resolved.items():
            if any(o.name in c.all_objects for c in colls):
                warnings.append(f"Shadow catcher {o.name!r} is inside element {name!r}: the other layers will not "
                                "show it. Keep catchers outside the elements.")
    if catchers and not cycles:
        warnings.append("Shadow catchers need Cycles.")
    # Held-out / indirect-only objects still cast shadows, so every layer's catcher pass holds every
    # element's shadow ("shared"). "per_element" adds a shadow-only layer per element with the others excluded.
    use_catcher = bool(catchers) and cycles
    if others == "exclude":
        shadows = "per_element"
    extra_shadow_layers = use_catcher and shadows == "per_element" and others != "exclude"
    shadow_layers = {f"{n}_shadow": n for n in resolved} if extra_shadow_layers else {}

    prev = set(element_names(sc)) | set(sc.get(SHADOW_LAYERS_PROP, []))
    ours = set(resolved) | set(shadow_layers)
    # Template for collections that are not elements: the user's own layer (keeps their excludes/holdouts).
    template = next((vl for vl in sc.view_layers if vl.name not in prev and vl.name not in ours), None)
    tmpl_state = {}
    if template:
        for lc in _walk_layer_collections(template.layer_collection):
            tmpl_state[lc.collection.name] = (lc.exclude, lc.holdout, lc.indirect_only)
    for vl in list(sc.view_layers):  # elements dropped since the last run
        if vl.name in prev and vl.name not in ours:
            sc.view_layers.remove(vl)

    def layer(name):
        vl = sc.view_layers.get(name)
        if vl is None:
            vl = sc.view_layers.new(name)
        elif name not in prev:
            raise ValueError(f"A view layer named {name!r} already exists and is not an element layer: rename the element")
        vl.use = True
        return vl

    out_dir = out_dir if out_dir.endswith("/") else out_dir + "/"
    wanted = [p.lower() for p in passes]
    if use_catcher and "shadow_catcher" not in wanted:
        wanted.append("shadow_catcher")
    ng = compositor_tree(sc)
    removed_single = remove_separate_outputs(sc)
    result_layers, first_rl = [], None
    for i, (name, colls) in enumerate(resolved.items()):
        vl = layer(name)
        _apply_layer_state(vl, tmpl_state, resolved, name, others)
        enabled, skipped = [], []
        for key in wanted:
            (enabled if set_pass(vl, key, True) else skipped).append(key)
        y = -600 * i - 400
        rl = _get_node(ng, ELEMENT_RL_PREFIX + name, "CompositorNodeRLayers", (-700, y))
        rl.layer = name
        fo = _get_node(ng, ELEMENT_FO_PREFIX + name, "CompositorNodeOutputFile", (-300, y))
        written = fill_file_output(ng, rl, fo, out_dir + name + "/", name + "_", depth, codec)
        first_rl = first_rl or rl
        entry = {"element": name, "view_layer": vl.name, "collections": [c.name for c in colls],
                 "enabled": enabled, "not_available_for_engine": skipped,
                 "directory": bpy.path.abspath(out_dir + name + "/"), "files": written}
        if extra_shadow_layers:
            sname = f"{name}_shadow"
            svl = layer(sname)
            _apply_layer_state(svl, tmpl_state, resolved, name, "exclude")
            set_pass(svl, "shadow_catcher", True)
            srl = _get_node(ng, ELEMENT_RL_PREFIX + sname, "CompositorNodeRLayers", (-700, y - 300))
            srl.layer = sname
            if "shadowCatcher_" in fo.inputs and "Shadow Catcher" in srl.outputs:
                ng.links.new(srl.outputs["Shadow Catcher"], fo.inputs["shadowCatcher_"])
            entry["shadow_layer"] = sname
        result_layers.append(entry)
    removed_nodes = _remove_element_nodes(sc, keep=ours)

    disabled = list(sc.get(DISABLED_LAYERS_PROP, []))
    if disable_user_layers:
        for vl in sc.view_layers:
            if vl.name not in ours and vl.use:
                vl.use = False
                disabled.append(vl.name)
    sc[DISABLED_LAYERS_PROP] = sorted(set(disabled))
    sc[ELEMENTS_PROP] = {n: [c.name for c in cs] for n, cs in resolved.items()}
    sc[SHADOW_LAYERS_PROP] = sorted(shadow_layers)
    sc[SHADOWS_PROP] = ("per_element" if shadows == "per_element" else "shared") if use_catcher else "none"
    _relink_group_output(sc, first_rl)
    return {"elements": result_layers, "others": others, "shadow_catchers": sorted(o.name for o in catchers),
            "shadows": sc[SHADOWS_PROP], "moved_objects": moved, "user_layers_off": sc[DISABLED_LAYERS_PROP],
            "removed_single_layer_pass_node": removed_single, "removed_nodes": removed_nodes, "warnings": warnings}


def remove_element_layers(sc):
    names = element_names(sc) + list(sc.get(SHADOW_LAYERS_PROP, []))
    for n in names:
        vl = sc.view_layers.get(n)
        if vl and len(sc.view_layers) > 1:
            sc.view_layers.remove(vl)
    removed_nodes = _remove_element_nodes(sc)
    restored = []
    for n in sc.get(DISABLED_LAYERS_PROP, []):
        vl = sc.view_layers.get(n)
        if vl and not vl.use:
            vl.use = True
            restored.append(n)
    for k in (ELEMENTS_PROP, DISABLED_LAYERS_PROP, SHADOW_LAYERS_PROP, SHADOWS_PROP):
        if k in sc:
            del sc[k]
    ng = sc.compositing_node_group
    rl = next((n for n in ng.nodes if n.bl_idname == "CompositorNodeRLayers"), None) if ng else None
    if rl and sc.view_layers.get(rl.layer) is None:
        rl.layer = sc.view_layers[0].name
    if rl:
        _relink_group_output(sc, rl)
    return {"removed_view_layers": names, "removed_nodes": removed_nodes, "user_layers_back_on": restored}


def element_depths(sc):
    """Median distance from the camera of each element's rendered objects at the current frame."""
    data = sc.get(ELEMENTS_PROP)
    cam = sc.camera
    if not data or cam is None:
        return {}
    owner = {}
    for name, colls in data.items():
        for cn in colls:
            c = bpy.data.collections.get(cn)
            for o in (c.all_objects if c else []):
                owner[o.name] = name
    inv = cam.matrix_world.inverted()
    dg = bpy.context.evaluated_depsgraph_get()
    dist = {}
    for inst in dg.object_instances:
        o = inst.instance_object if inst.is_instance else inst.object
        if o is None or o.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT", "POINTCLOUD", "VOLUME", "CURVES"}:
            continue
        el = owner.get(o.original.name)
        if el is None and inst.is_instance and inst.parent:
            el = owner.get(inst.parent.original.name)
        if el is None:
            continue
        center = sum((Vector(c) for c in o.bound_box), Vector()) / 8
        dist.setdefault(el, []).append(-(inv @ (inst.matrix_world @ center)).z)
    return {el: round(sorted(v)[len(v) // 2], 3) for el, v in dist.items()}


def element_outputs(sc):
    """[{name, dir, depth}] for the element layers that will render, nearest to the camera first
    (setup order when a depth is missing)."""
    ng = sc.compositing_node_group
    out = []
    for name in element_names(sc):
        vl = sc.view_layers.get(name)
        fo = ng.nodes.get(ELEMENT_FO_PREFIX + name) if ng else None
        if vl is None or not vl.use or fo is None or fo.mute:
            continue
        out.append({"name": name, "dir": bpy.path.abspath(fo.directory)})
    depths = element_depths(sc)
    for e in out:
        e["depth"] = depths.get(e["name"])
    if out and all(e["depth"] is not None for e in out):
        out.sort(key=lambda e: e["depth"])
    return out


# --- Images for the model to look at --------------------------------------------------

def temp_png(tag):
    d = os.path.join(tempfile.gettempdir(), "blender-mcp")
    os.makedirs(d, exist_ok=True)
    import uuid
    return os.path.join(d, f"{tag}-{uuid.uuid4().hex[:8]}.png")
