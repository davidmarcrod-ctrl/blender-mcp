import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { runPython } from "../blender-bridge.js";
import { runTool } from "../tool-helpers.js";
import { BLENDER_BIN } from "./file.js";
import { applyBake } from "./bake.js";
import { cancelJob, ELEMENTS_FILE, jobs, publicJob, runJobProcess, type RenderJob } from "../jobs.js";

export function registerRenderTools(server: McpServer): void {
    server.registerTool(
        "set_render_settings",
        {
            title: "Set render settings",
            description:
                "Sets engine, resolution, fps, frame range, samples, color management, transparency and output path. Only the fields you pass are changed. For AE work keep fps and resolution identical to the AE comp.",
            inputSchema: z.object({
                engine: z.enum(["EEVEE", "CYCLES", "WORKBENCH"]).optional(),
                resolution: z.array(z.number().int().positive()).length(2).optional(),
                resolutionPercent: z.number().int().min(1).max(100).optional(),
                fps: z.number().positive().optional().describe("e.g. 25, 24, 23.976, 29.97, 50."),
                frameStart: z.number().int().optional(),
                frameEnd: z.number().int().optional(),
                samples: z.number().int().positive().optional().describe("Render samples for the current engine."),
                viewTransform: z.string().optional().describe("'AgX', 'Standard', 'Filmic', 'Khronos PBR Neutral', ..."),
                look: z.string().optional(),
                filmTransparent: z.boolean().optional().describe("Transparent background (alpha) -- usual for AE compositing."),
                outputPath: z.string().optional().describe("render.filepath, e.g. '//render/shot010/shot010_'.")
            })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
sc = scene()
rd = sc.render
eng = {"EEVEE": "BLENDER_EEVEE", "CYCLES": "CYCLES", "WORKBENCH": "BLENDER_WORKBENCH"}
if args.get("engine"):
    rd.engine = eng[args["engine"]]
if args.get("resolution"):
    rd.resolution_x, rd.resolution_y = args["resolution"]
if args.get("resolutionPercent"):
    rd.resolution_percentage = args["resolutionPercent"]
if args.get("fps"):
    f = args["fps"]
    if abs(f - round(f)) < 1e-3:
        rd.fps, rd.fps_base = int(round(f)), 1.0
    else:
        rd.fps, rd.fps_base = int(math.ceil(f)), math.ceil(f) / f
if args.get("frameStart") is not None:
    sc.frame_start = args["frameStart"]
if args.get("frameEnd") is not None:
    sc.frame_end = args["frameEnd"]
if args.get("samples"):
    if rd.engine == "CYCLES":
        sc.cycles.samples = args["samples"]
    elif rd.engine == "BLENDER_EEVEE":
        sc.eevee.taa_render_samples = args["samples"]
if args.get("viewTransform"):
    sc.view_settings.view_transform = args["viewTransform"]
if args.get("look"):
    sc.view_settings.look = args["look"]
if args.get("filmTransparent") is not None:
    rd.film_transparent = args["filmTransparent"]
if args.get("outputPath"):
    rd.filepath = args["outputPath"]
w, h = render_size(sc)
return {"engine": rd.engine, "output_size": [w, h], "fps": round(fps(sc), 3), "frames": [sc.frame_start, sc.frame_end],
        "view_transform": sc.view_settings.view_transform, "film_transparent": rd.film_transparent, "output": rd.filepath}
`,
                    args,
                    { undo: "MCP: render settings" }
                )
            )
    );

    server.registerTool(
        "preview_render",
        {
            title: "Preview render (EEVEE)",
            description:
                "Renders a single frame with EEVEE at reduced size and returns the image so you can look at it. For fast look-dev iterations only; final renders are render_animation or the user's F12. The scene's own render settings are restored afterwards. Always renders the full frame unless useBorder is true (a render region crops the image and breaks compositing over the plate).",
            inputSchema: z.object({
                frame: z.number().int().optional().describe("Default: current frame."),
                percent: z.number().int().min(5).max(100).default(50),
                samples: z.number().int().positive().default(16),
                useSceneEngine: z.boolean().default(false).describe("Render with the scene's engine (e.g. Cycles) instead of forcing EEVEE. Slower."),
                useBorder: z
                    .boolean()
                    .default(false)
                    .describe("Honour the scene's render region (Ctrl+B border). Off by default: a region render is a crop, so compositor setups over the plate (shadow catcher, alpha over) do not line up."),
                viewLayer: z
                    .string()
                    .optional()
                    .describe("Render only this view layer and return its own image (e.g. one element from setup_element_layers). Default: the scene's render result (composite).")
            })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
sc = scene()
rd, im = sc.render, sc.render.image_settings
saved = {"engine": rd.engine, "pct": rd.resolution_percentage, "media": im.media_type, "fmt": im.file_format,
         "depth": im.color_depth, "mode": im.color_mode, "frame": sc.frame_current,
         "samples": sc.eevee.taa_render_samples, "border": rd.use_border}
path = temp_png("preview")
# File Output nodes would write this small preview into the render folders: mute them meanwhile.
ng = sc.compositing_node_group
muted = [n for n in (ng.nodes if ng else []) if n.bl_idname == "CompositorNodeOutputFile" and not n.mute]
for n in muted:
    n.mute = True
vl_name = args.get("viewLayer")
if vl_name and sc.view_layers.get(vl_name) is None:
    raise KeyError(f"No view layer {vl_name!r}. Layers: {[v.name for v in sc.view_layers]}")
try:
    # A region (border) render returns only a crop, which breaks any comp over the plate: always render the full frame.
    rd.use_border = args["useBorder"]
    if not args["useSceneEngine"]:
        rd.engine = "BLENDER_EEVEE"
        sc.eevee.taa_render_samples = args["samples"]
    rd.resolution_percentage = args["percent"]
    if args.get("frame") is not None:
        sc.frame_set(args["frame"])
    im.media_type = "IMAGE"
    im.file_format = "PNG"
    im.color_depth = "8"
    im.color_mode = "RGBA"
    if vl_name:
        # Only that layer renders, without the compositor, so the result is its own image.
        saved["use"] = {v.name: v.use for v in sc.view_layers}
        saved["comp"] = rd.use_compositing
        for v in sc.view_layers:
            v.use = v.name == vl_name
        rd.use_compositing = False
    bpy.ops.render.render()
    bpy.data.images["Render Result"].save_render(filepath=path, scene=sc)
finally:
    for n in muted:
        n.mute = False
    if "use" in saved:
        for v in sc.view_layers:
            v.use = saved["use"].get(v.name, v.use)
        rd.use_compositing = saved["comp"]
    rd.engine = saved["engine"]
    rd.use_border = saved["border"]
    rd.resolution_percentage = saved["pct"]
    sc.eevee.taa_render_samples = saved["samples"]
    im.media_type = saved["media"]
    im.file_format = saved["fmt"]
    im.color_depth = saved["depth"]
    im.color_mode = saved["mode"]
    sc.frame_set(saved["frame"])
res = {"frame": args.get("frame", saved["frame"]), "camera": sc.camera.name if sc.camera else None, "images": [path]}
if vl_name:
    res["view_layer"] = vl_name
if saved["border"] and not args["useBorder"]:
    res["note"] = "The scene has a render region (border) set; it was ignored for this preview and left as it was."
return res
`,
                    args,
                    { timeoutMs: 300_000 }
                )
            )
    );

    server.registerTool(
        "viewport_screenshot",
        {
            title: "Viewport screenshot",
            description: "Captures the largest 3D viewport as the user currently sees it (no render) and returns the image. Cheapest way to check layout or framing.",
            inputSchema: z.object({})
        },
        async () =>
            runTool(() =>
                runPython(`
win = bpy.context.window_manager.windows[0]
areas = [a for a in win.screen.areas if a.type == "VIEW_3D"]
if not areas:
    raise RuntimeError("No 3D viewport is open in the main window")
area = max(areas, key=lambda a: a.width * a.height)
path = temp_png("viewport")
with bpy.context.temp_override(window=win, screen=win.screen, area=area):
    bpy.ops.screen.screenshot_area(filepath=path)
img = bpy.data.images.load(path)
try:
    if img.size[0] > 1280:
        img.scale(1280, int(img.size[1] * 1280 / img.size[0]))
        img.save()
finally:
    bpy.data.images.remove(img)
return {"size": [area.width, area.height], "images": [path]}
`)
            )
    );

    server.registerTool(
        "setup_render_passes",
        {
            title: "Set up render passes for AE",
            description:
                "Prepares the active view layer for compositing in After Effects: enables the requested passes and sets the output to 16/32-bit EXR. layout='multilayer' writes one multilayer EXR sequence (all passes + Cryptomatte, best for AE's Cryptomatte effect / EXtractoR). layout='separate' ALSO adds a compositor File Output node writing each pass (beauty, AO, shadow, depth...) as its own EXR sequence, which AE imports as plain layers. Cryptomatte always lives in the multilayer file. Pass names: combined, z, mist, normal, vector, position, uv, ao, shadow, emission, environment, diffuse_direct/indirect/color, glossy_direct/indirect/color, transmission_direct/indirect/color, object_index, material_index, crypto_object, crypto_material, crypto_asset, volume_direct, bloom, transparent, shadow_catcher.",
            inputSchema: z.object({
                passes: z.array(z.string()).default(["combined", "z", "ao", "shadow", "crypto_object"]),
                disableOthers: z.boolean().default(false).describe("Turn off passes not in the list."),
                layout: z.enum(["multilayer", "separate"]).default("multilayer"),
                outputDir: z.string().optional().describe("Directory (Blender path, // = next to the .blend). Default //render/<scene>/."),
                prefix: z.string().optional().describe("File prefix. Default '<scene>_'."),
                depth: z.enum(["16", "32"]).default("16").describe("16 = half float (enough for beauty/light passes); use 32 for depth/position/vector precision."),
                codec: z.enum(["ZIP", "PIZ", "DWAA", "DWAB", "ZIPS", "NONE"]).default("ZIP"),
                filmTransparent: z.boolean().default(true),
                viewLayer: z.string().optional()
            })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
import os
sc = scene()
vl = sc.view_layers[args["viewLayer"]] if args.get("viewLayer") else bpy.context.view_layer
wanted = [p.lower() for p in args["passes"]]
if args["disableOthers"]:
    for key in PASS_ATTRS:
        if key not in wanted and key != "combined":
            try:
                set_pass(vl, key, False)
            except Exception:
                pass
applied, skipped = [], []
for key in wanted:
    (applied if set_pass(vl, key, True) else skipped).append(key)
prefix = args.get("prefix") or (re.sub(r"[^A-Za-z0-9_-]+", "_", sc.name) + "_")
out_dir = args.get("outputDir") or f"//render/{re.sub(r'[^A-Za-z0-9_-]+', '_', sc.name)}/"
if not out_dir.endswith("/"):
    out_dir += "/"
rd, im = sc.render, sc.render.image_settings
rd.film_transparent = args["filmTransparent"]
im.media_type = "MULTI_LAYER_IMAGE"
im.file_format = "OPEN_EXR_MULTILAYER"
im.color_depth = args["depth"]
im.exr_codec = args["codec"]
rd.filepath = out_dir + prefix
rd.use_file_extension = True
result = {"view_layer": vl.name, "enabled": applied, "not_available_for_engine": skipped,
          "multilayer_pattern": bpy.path.abspath(out_dir) + prefix + "####.exr", "engine": rd.engine}
if args["layout"] == "separate":
    pass_dir = out_dir + "passes/"
    result["separate"] = setup_separate_outputs(sc, pass_dir, prefix, args["depth"], args["codec"])
    result["passes_dir"] = bpy.path.abspath(pass_dir)
else:
    result["removed_separate_node"] = remove_separate_outputs(sc)
result["note"] = ("EXR is scene-linear (Linear Rec.709), not AgX/Filmic. In AE, interpret it as linear "
                  "(or enable OCIO/linearized working space) so it matches the Blender viewport.")
return result
`,
                    args,
                    { undo: "MCP: render passes" }
                )
            )
    );

    server.registerTool(
        "setup_element_layers",
        {
            title: "Set up one view layer per element for AE",
            description:
                "Per-element, per-pass output for After Effects: each element (e.g. the ball, the confetti) gets its own view layer and its own folder of EXR sequences, one file per pass: //render/<scene>/<element>/<element>_<pass>_####.exr (plus the scene's multilayer EXR with every layer and Cryptomatte). In each element's layer the other elements are holdout by default (cut out where they pass in front, so the layers stack cleanly in AE), or indirect_only (Cycles: invisible but still cast shadows, reflect and bounce light) or exclude (gone entirely). Shadow catchers (objects with is_shadow_catcher, plus `shadowCatchers`) stay visible in every layer and the shadow_catcher pass is added (Cycles). Elements are given as {name: [collection or object names]}; loose objects are MOVED into a collection named after the element (holdout works per collection). Things in no element (set, lights, catchers) render in every layer. The user's own view layers are switched off for the render (they come back with remove=true). Idempotent: re-run with the full element list to update; elements left out are removed. Replaces the single-layer 'MCP Pass Output' node of setup_render_passes. Before rendering, show the user a preview_render and get their OK: nothing goes to After Effects without it.",
            inputSchema: z.object({
                elements: z
                    .record(z.string(), z.array(z.string()).min(1))
                    .optional()
                    .describe("{element name: [collection or object names]}, in stacking order front to back (first = on top in AE) if no camera depth is available. Required unless remove=true."),
                others: z
                    .enum(["holdout", "indirect_only", "exclude"])
                    .default("holdout")
                    .describe("What the OTHER elements do in each element's layer. holdout = cut out (correct overlaps); indirect_only = invisible to camera but still shadows/reflections (Cycles); exclude = removed."),
                passes: z.array(z.string()).default(["combined", "ao", "shadow", "z", "crypto_object"]).describe("Same names as setup_render_passes."),
                shadowCatchers: z.array(z.string()).optional().describe("Objects to mark as shadow catchers (objects already marked are found automatically)."),
                outputDir: z.string().optional().describe("Blender path. Default //render/<scene>/."),
                depth: z.enum(["16", "32"]).default("16"),
                codec: z.enum(["ZIP", "PIZ", "DWAA", "DWAB", "ZIPS", "NONE"]).default("ZIP"),
                filmTransparent: z.boolean().default(true),
                shadows: z
                    .enum(["shared", "per_element"])
                    .default("shared")
                    .describe("Shadow catcher pass. Held-out elements still cast shadows, so with holdout/indirect_only every element's catcher pass holds ALL the shadows: 'shared' = one shadow layer for all (import_render_to_ae switches on just one). 'per_element' = an extra shadow-only view layer per element (others excluded), so each element brings its own shadow pass; costs one more render per element. others='exclude' is always per element."),
                disableUserLayers: z.boolean().default(true).describe("Switch off the scene's other view layers so only the elements render."),
                remove: z.boolean().default(false).describe("Undo: delete the element layers and their nodes, switch the user's layers back on.")
            })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
sc = scene()
if args["remove"]:
    return remove_element_layers(sc)
if not args.get("elements"):
    raise ValueError("Give elements, e.g. {'Ball': ['Ball'], 'Confetti': ['Confetti']}")
tag = safe_name(sc.name)
out_dir = args.get("outputDir") or f"//render/{tag}/"
if not out_dir.endswith("/"):
    out_dir += "/"
res = setup_element_layers(sc, args["elements"], args["others"], args["passes"], out_dir, args["depth"], args["codec"],
                           args.get("shadowCatchers"), args["disableUserLayers"], args["shadows"])
rd, im = sc.render, sc.render.image_settings
rd.film_transparent = args["filmTransparent"]
im.media_type = "MULTI_LAYER_IMAGE"
im.file_format = "OPEN_EXR_MULTILAYER"
im.color_depth = args["depth"]
im.exr_codec = args["codec"]
rd.filepath = out_dir + tag + "_"
rd.use_file_extension = True
res["multilayer_pattern"] = bpy.path.abspath(out_dir) + tag + "_####.exr"
res["engine"] = rd.engine
res["depth_from_camera"] = element_depths(sc)
res["next"] = ("Show the user a preview_render of each element layer before rendering, and get an OK "
               "before render_animation / import_render_to_ae.")
return res
`,
                    args,
                    { undo: "MCP: element layers" }
                )
            )
    );

    server.registerTool(
        "render_animation",
        {
            title: "Render animation (background)",
            description:
                "Renders the frame range in a separate background Blender process from a saved snapshot of the current file, so the user's Blender stays usable. Returns a jobId immediately; poll with get_render_status. Progress also shows in Blender's sidebar (N) > MCP. This spends machine time (a Cycles shot can take hours): confirm frame range, engine and samples with the user before starting, and when the render is meant for After Effects show them a preview_render (one per element layer) and wait for their OK. With setup_element_layers, the job lists each element's folder (nearest to the camera first) so import_render_to_ae can bring them in as separate groups. The file must have been saved at least once (the snapshot is written next to it so // paths keep working).",
            inputSchema: z.object({
                frameStart: z.number().int().optional(),
                frameEnd: z.number().int().optional(),
                keepSnapshot: z.boolean().default(false).describe("Keep the <name>.mcp_render.blend snapshot after the render.")
            })
        },
        async (args) =>
            runTool(async () => {
                const info = await runPython<{
                    copy: string;
                    file: string;
                    scene: string;
                    start: number;
                    end: number;
                    output_dir: string;
                    passes_dir: string | null;
                    elements: { name: string; dir: string; depth: number | null }[];
                    element_shadows: string | null;
                    fps: number;
                    width: number;
                    height: number;
                }>(
                    `
import os
if not bpy.data.filepath:
    raise RuntimeError("Save the .blend first: the background render works from a snapshot next to it.")
sc = scene()
stem, _ = os.path.splitext(bpy.data.filepath)
copy = stem + ".mcp_render.blend"
bpy.ops.wm.save_as_mainfile(filepath=copy, copy=True)
ng = sc.compositing_node_group
fo = ng.nodes.get(PASS_NODE_NAME) if ng else None
w, h = render_size(sc)
return {"copy": copy, "file": bpy.data.filepath, "scene": sc.name,
        "start": args.get("frameStart") if args.get("frameStart") is not None else sc.frame_start,
        "end": args.get("frameEnd") if args.get("frameEnd") is not None else sc.frame_end,
        "output_dir": os.path.dirname(bpy.path.abspath(sc.render.filepath)),
        "passes_dir": bpy.path.abspath(fo.directory) if fo and not fo.mute else None,
        "elements": element_outputs(sc),
        "element_shadows": sc.get(SHADOWS_PROP),
        "fps": fps(sc), "width": w, "height": h}
`,
                    args
                );
                const job: RenderJob = {
                    id: randomUUID().slice(0, 8),
                    kind: "render",
                    status: "running",
                    file: info.file,
                    blendCopy: info.copy,
                    scene: info.scene,
                    frameStart: info.start,
                    frameEnd: info.end,
                    currentFrame: null,
                    framesDone: 0,
                    stage: null,
                    savedFiles: [],
                    outputDir: info.output_dir,
                    passesDir: info.passes_dir,
                    elements: info.elements.length ? info.elements : null,
                    elementShadows: info.elements.length ? ((info.element_shadows ?? "shared") as RenderJob["elementShadows"]) : null,
                    fps: info.fps,
                    width: info.width,
                    height: info.height,
                    startedAt: new Date().toISOString(),
                    logTail: []
                };
                if (job.elements) {
                    // Lets import_render_to_ae find the elements from the folder alone (e.g. after a server restart).
                    await mkdir(job.outputDir, { recursive: true });
                    const meta = { scene: job.scene, fps: job.fps, shadows: job.elementShadows, elements: job.elements };
                    await writeFile(join(job.outputDir, ELEMENTS_FILE), JSON.stringify(meta, null, 2));
                }
                const framesSeen = new Set<number>();
                runJobProcess(
                    job,
                    BLENDER_BIN,
                    ["-b", info.copy, "-S", info.scene, "-s", String(info.start), "-e", String(info.end), "-a"],
                    (line) => {
                        const saved = /Saved: '(.+)'/.exec(line);
                        if (!saved) return;
                        job.savedFiles.push(saved[1]);
                        // Blender 5.x no longer prints "Fra:" lines: take the frame from the file name
                        const num = /(\d+)\.\w+$/.exec(saved[1]);
                        if (num) {
                            job.currentFrame = Number(num[1]);
                            framesSeen.add(job.currentFrame);
                            job.framesDone = framesSeen.size;
                        }
                    },
                    async () => {
                        if (!args.keepSnapshot) await unlink(info.copy).catch(() => {});
                    }
                );
                return { jobId: job.id, ...publicJob(job) };
            })
    );

    server.registerTool(
        "get_render_status",
        {
            title: "Get job status",
            description:
                "Progress of background jobs: renders from render_animation and simulation bakes from bake_simulation (frames done, stage, last saved files, log tail). Omit jobId to list all jobs of this session. cancel=true stops the job. For a finished bake that was not applied (the user's file had unsaved changes), apply=true loads the baked file into Blender; add discardChanges=true only after the user agreed to lose those changes. The same jobs and their progress show in Blender's sidebar (N) > MCP, where the user can also cancel them.",
            inputSchema: z.object({
                jobId: z.string().optional(),
                cancel: z.boolean().default(false),
                apply: z.boolean().default(false).describe("Bake jobs only: load the baked file into the user's Blender."),
                discardChanges: z.boolean().default(false)
            })
        },
        async ({ jobId, cancel, apply, discardChanges }) =>
            runTool(async () => {
                if (!jobId) return [...jobs.values()].map(publicJob);
                const job = jobs.get(jobId);
                if (!job) throw new Error(`No job ${jobId}. Jobs: ${[...jobs.keys()].join(", ") || "none"}`);
                if (cancel) cancelJob(job);
                if (apply) {
                    if (job.kind !== "bake") throw new Error("apply is for bake jobs");
                    if (job.status !== "finished") throw new Error(`Bake ${job.id} is ${job.status}`);
                    await applyBake(job, discardChanges);
                }
                return publicJob(job);
            })
    );
}
