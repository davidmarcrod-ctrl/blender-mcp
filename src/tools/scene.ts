import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { runPython } from "../blender-bridge.js";
import { runTool } from "../tool-helpers.js";

export function registerSceneTools(server: McpServer): void {
    server.registerTool(
        "get_scene_info",
        {
            title: "Get scene info",
            description:
                "Snapshot of the open Blender file: file path and unsaved state, scene frame range, fps, resolution, render engine, color management, active camera, collections, and object counts by type. Call this first in any session -- never assume objects exist or how they are named.",
            inputSchema: z.object({})
        },
        async () =>
            runTool(() =>
                runPython(`
sc = scene()
w, h = render_size(sc)
types = {}
for o in sc.objects:
    types[o.type] = types.get(o.type, 0) + 1
return {
    "blender": bpy.app.version_string,
    "file": bpy.data.filepath or None,
    "unsaved_changes": bpy.data.is_dirty,
    "scenes": [s.name for s in bpy.data.scenes],
    "scene": sc.name,
    "frame_range": [sc.frame_start, sc.frame_end],
    "frame_current": sc.frame_current,
    "fps": round(fps(sc), 3),
    "resolution": [sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage],
    "output_size": [w, h],
    "engine": sc.render.engine,
    "color": {"view_transform": sc.view_settings.view_transform, "look": sc.view_settings.look,
              "display": sc.display_settings.display_device},
    "film_transparent": sc.render.film_transparent,
    "camera": sc.camera.name if sc.camera else None,
    "output_path": sc.render.filepath,
    "output_format": [sc.render.image_settings.media_type, sc.render.image_settings.file_format],
    "view_layers": [vl.name for vl in sc.view_layers],
    "collections": [{"name": c.name, "objects": len(c.objects), "children": [x.name for x in c.children]}
                    for c in sc.collection.children_recursive],
    "object_counts": types,
}
`)
            )
    );

    server.registerTool(
        "list_objects",
        {
            title: "List objects",
            description:
                "Lists objects in the scene with transform, parent, collections, visibility, materials, modifiers, constraints and whether they are animated. Filter by type and/or collection.",
            inputSchema: z.object({
                type: z
                    .string()
                    .optional()
                    .describe("Blender object type filter, e.g. 'MESH', 'CAMERA', 'LIGHT', 'EMPTY', 'CURVE'."),
                collection: z.string().optional().describe("Only objects in this collection (recursive)."),
                names: z.array(z.string()).optional().describe("Only these objects, with full detail.")
            })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
sc = scene()
if args.get("names"):
    objs = [get_object(n) for n in args["names"]]
elif args.get("collection"):
    coll = bpy.data.collections.get(args["collection"])
    if coll is None:
        raise KeyError(f"No collection {args['collection']!r}")
    objs = list(coll.all_objects)
else:
    objs = list(sc.objects)
if args.get("type"):
    objs = [o for o in objs if o.type == args["type"].upper()]
return [summarize(o) for o in objs]
`,
                    args
                )
            )
    );

    server.registerTool(
        "get_property",
        {
            title: "Get property",
            description:
                "Reads any Blender value by Python expression rooted at bpy, e.g. 'bpy.data.objects[\"Cube\"].location', 'bpy.context.scene.render.fps', 'bpy.data.materials[\"Mat\"].node_tree.nodes[\"Principled BSDF\"].inputs[\"Roughness\"].default_value'. Vectors/matrices come back as lists.",
            inputSchema: z.object({ path: z.string().describe("Python expression evaluated with bpy in scope.") })
        },
        async (args) => runTool(() => runPython(`return eval(args["path"], {"bpy": bpy})`, args))
    );

    server.registerTool(
        "set_property",
        {
            title: "Set property",
            description:
                "Assigns a value to any Blender property by Python path (same form as get_property). Lists become vectors/colors. Idempotent: it overwrites, so it is safe to repeat. Returns the value read back.",
            inputSchema: z.object({
                path: z.string().describe("Assignable Python expression, e.g. 'bpy.data.objects[\"Cube\"].location'."),
                value: z.unknown().describe("JSON value: number, bool, string, or list for vectors/colors.")
            })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
ns = {"bpy": bpy, "__value": args["value"]}
exec(f"{args['path']} = __value", ns)
return eval(args["path"], ns)
`,
                    args,
                    { undo: "MCP: set property" }
                )
            )
    );

    server.registerTool(
        "create_object",
        {
            title: "Create object",
            description:
                "Creates a mesh primitive, empty, camera, light or text object without relying on UI context. Name collisions get Blender's .001 suffix, so read back the returned name.",
            inputSchema: z.object({
                kind: z.enum(["cube", "plane", "uv_sphere", "ico_sphere", "cylinder", "cone", "monkey", "empty", "camera", "light", "text"]),
                name: z.string().optional(),
                size: z.number().positive().default(1).describe("Overall size in metres (cube edge, plane side, sphere/cylinder diameter)."),
                location: z.array(z.number()).length(3).default([0, 0, 0]),
                rotationDeg: z.array(z.number()).length(3).default([0, 0, 0]).describe("XYZ Euler degrees."),
                scale: z.array(z.number()).length(3).default([1, 1, 1]),
                collection: z.string().optional().describe("Target collection (created if missing). Default: scene collection."),
                lightType: z.enum(["POINT", "SUN", "SPOT", "AREA"]).default("POINT"),
                lightEnergy: z.number().optional().describe("Watts (point/spot/area) or irradiance (sun)."),
                lens: z.number().optional().describe("Camera focal length in mm."),
                text: z.string().optional().describe("Body for kind='text'."),
                setActiveCamera: z.boolean().default(false)
            })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
import bmesh
k = args["kind"]
name = args.get("name") or k.replace("_", " ").title()
size = args["size"]
data = None
if k in ("cube", "plane", "uv_sphere", "ico_sphere", "cylinder", "cone", "monkey"):
    data = bpy.data.meshes.new(name)
    bm = bmesh.new()
    if k == "cube":
        bmesh.ops.create_cube(bm, size=size)
    elif k == "plane":
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=size / 2)
    elif k == "uv_sphere":
        bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=size / 2)
    elif k == "ico_sphere":
        bmesh.ops.create_icosphere(bm, subdivisions=3, radius=size / 2)
    elif k == "cylinder":
        bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=size / 2, radius2=size / 2, depth=size)
    elif k == "cone":
        bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=size / 2, radius2=0, depth=size)
    elif k == "monkey":
        bmesh.ops.create_monkey(bm)
        bmesh.ops.scale(bm, vec=(size / 2,) * 3, verts=bm.verts)
    uv = bm.loops.layers.uv.verify()
    bm.to_mesh(data)
    bm.free()
    if k in ("uv_sphere", "ico_sphere", "cylinder", "cone", "monkey"):
        for p in data.polygons:
            p.use_smooth = k != "cylinder" and k != "cone"
elif k == "camera":
    data = bpy.data.cameras.new(name)
    if args.get("lens"):
        data.lens = args["lens"]
elif k == "light":
    data = bpy.data.lights.new(name, type=args["lightType"])
    if args.get("lightEnergy") is not None:
        data.energy = args["lightEnergy"]
elif k == "text":
    data = bpy.data.curves.new(name, type="FONT")
    data.body = args.get("text") or name
    data.align_x = "CENTER"
    data.size = size
o = bpy.data.objects.new(name, data)
if k == "empty":
    o.empty_display_type = "PLAIN_AXES"
    o.empty_display_size = size / 2
sc = scene()
cname = args.get("collection")
if cname:
    coll = bpy.data.collections.get(cname)
    if coll is None:
        coll = bpy.data.collections.new(cname)
        sc.collection.children.link(coll)
else:
    coll = sc.collection
coll.objects.link(o)
o.location = args["location"]
o.rotation_euler = [math.radians(a) for a in args["rotationDeg"]]
o.scale = args["scale"]
if k == "camera" and (args["setActiveCamera"] or sc.camera is None):
    sc.camera = o
return summarize(o)
`,
                    args,
                    { undo: "MCP: create object" }
                )
            )
    );

    server.registerTool(
        "delete_objects",
        {
            title: "Delete objects",
            description:
                "Removes objects from the file (their mesh/camera data is kept if other objects use it). Undoable with Cmd+Z in Blender. Confirm with the user before deleting anything they did not ask to remove.",
            inputSchema: z.object({ names: z.array(z.string()).min(1) })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
removed = []
for n in args["names"]:
    o = get_object(n)
    bpy.data.objects.remove(o, do_unlink=True)
    removed.append(n)
return {"removed": removed}
`,
                    args,
                    { undo: "MCP: delete objects" }
                )
            )
    );

    server.registerTool(
        "set_material",
        {
            title: "Set material",
            description:
                "Creates or updates a Principled BSDF material and assigns it to an object. Set any Principled input by its UI name (e.g. 'Base Color', 'Metallic', 'Roughness', 'Emission Color', 'Emission Strength', 'Alpha', 'Transmission Weight', 'Coat Weight'). Colors are linear RGBA lists. Only translate a look the user has described or referenced -- do not invent one.",
            inputSchema: z.object({
                object: z.string(),
                material: z.string().describe("Material name; reused if it exists."),
                inputs: z.record(z.string(), z.unknown()).default({}),
                slot: z.number().int().min(0).default(0).describe("Material slot index to fill (slots are added as needed).")
            })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
o = get_object(args["object"])
if not hasattr(o.data, "materials"):
    raise TypeError(f"{o.name} ({o.type}) cannot hold materials")
mat = bpy.data.materials.get(args["material"]) or bpy.data.materials.new(args["material"])
mat.use_nodes = True
bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
if bsdf is None:
    bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    out = next((n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL"), None) or mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
    mat.node_tree.links.new(bsdf.outputs[0], out.inputs["Surface"])
unknown = []
for key, val in args["inputs"].items():
    sock = bsdf.inputs.get(key)
    if sock is None:
        unknown.append(key)
        continue
    if isinstance(val, list) and len(val) == 3 and len(sock.default_value) == 4:
        val = val + [1.0]
    sock.default_value = val
if unknown:
    raise KeyError(f"Unknown Principled inputs {unknown}. Available: {[i.name for i in bsdf.inputs]}")
slot = args["slot"]
while len(o.data.materials) <= slot:
    o.data.materials.append(None)
o.data.materials[slot] = mat
return {"object": o.name, "material": mat.name, "slot": slot,
        "inputs": {k: r(bsdf.inputs[k].default_value) if hasattr(bsdf.inputs[k].default_value, "__len__") else r(bsdf.inputs[k].default_value)
                   for k in args["inputs"]}}
`,
                    args,
                    { undo: "MCP: set material" }
                )
            )
    );
}
