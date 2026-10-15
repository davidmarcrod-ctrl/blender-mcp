import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { runPython } from "../blender-bridge.js";
import { runTool } from "../tool-helpers.js";

export function registerAnimationTools(server: McpServer): void {
    server.registerTool(
        "set_keyframe",
        {
            title: "Set keyframe",
            description:
                "Inserts a keyframe on any animatable property, optionally setting its value first, with interpolation and easing. Target is an object by name, or any datablock/struct by Python path (e.g. 'bpy.data.objects[\"Camera\"].data' for lens, 'bpy.data.materials[\"Mat\"].node_tree.nodes[\"Principled BSDF\"].inputs[\"Alpha\"]' with dataPath 'default_value'). Rotations are in degrees when dataPath is 'rotation_euler'.",
            inputSchema: z.object({
                object: z.string().optional().describe("Object name. Use this or target."),
                target: z.string().optional().describe("Python path of the struct owning the property."),
                dataPath: z.string().describe("Property on the target, e.g. 'location', 'rotation_euler', 'scale', 'lens', 'energy', 'default_value'."),
                frame: z.number(),
                value: z.unknown().optional().describe("Set this value before keying (number or list). Omit to key the current value."),
                index: z.number().int().default(-1).describe("Array index to key (-1 = all channels)."),
                interpolation: z.enum(["BEZIER", "LINEAR", "CONSTANT"]).optional(),
                easing: z.enum(["AUTO", "EASE_IN", "EASE_OUT", "EASE_IN_OUT"]).optional(),
                handleType: z.enum(["AUTO_CLAMPED", "AUTO", "VECTOR", "ALIGNED", "FREE"]).optional()
            })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
if args.get("object"):
    tgt = get_object(args["object"])
elif args.get("target"):
    tgt = eval(args["target"], {"bpy": bpy})
else:
    raise ValueError("Give object or target")
dp, idx, frame = args["dataPath"], args["index"], args["frame"]
if "value" in args and args["value"] is not None:
    val = args["value"]
    if dp == "rotation_euler":
        val = [math.radians(v) for v in val] if isinstance(val, list) else math.radians(val)
    if idx >= 0:
        getattr(tgt, dp)[idx] = val
    else:
        setattr(tgt, dp, val)
tgt.keyframe_insert(dp, index=idx, frame=frame)
owner = tgt.id_data
full_path = tgt.path_from_id(dp) if tgt != owner else dp
touched = []
for fc in fcurves_for(owner):
    if fc.data_path != full_path or (idx >= 0 and fc.array_index != idx):
        continue
    for k in fc.keyframe_points:
        if abs(k.co.x - frame) < 1e-4:
            if args.get("interpolation"):
                k.interpolation = args["interpolation"]
            if args.get("easing"):
                k.easing = args["easing"]
            if args.get("handleType"):
                k.handle_left_type = k.handle_right_type = args["handleType"]
            touched.append({"channel": fc.array_index, "value": r(k.co.y), "interpolation": k.interpolation})
    fc.update()
return {"owner": owner.name, "data_path": full_path, "frame": frame, "keys": touched}
`,
                    args,
                    { undo: "MCP: keyframe" }
                )
            )
    );

    server.registerTool(
        "get_animation",
        {
            title: "Get animation",
            description: "Lists the F-curves of an object (and its object data, e.g. camera lens) with keyframe frames, values and interpolation. Use before editing existing animation.",
            inputSchema: z.object({ object: z.string(), maxKeys: z.number().int().default(50) })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
o = get_object(args["object"])
out = []
for owner in [o] + ([o.data] if o.data is not None else []):
    for fc in fcurves_for(owner):
        keys = [{"frame": r(k.co.x, 2), "value": r(k.co.y), "interp": k.interpolation} for k in fc.keyframe_points]
        out.append({"owner": owner.name, "data_path": fc.data_path, "index": fc.array_index,
                    "modifiers": [m.type for m in fc.modifiers], "count": len(keys), "keys": keys[: args["maxKeys"]]})
return out
`,
                    args
                )
            )
    );
}
