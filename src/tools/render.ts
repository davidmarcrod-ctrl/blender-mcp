import { z } from "zod";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import { runPython } from "../blender-bridge.js";
import { runTool } from "../tool-helpers.js";
import { BLENDER_BIN } from "./file.js";

export interface RenderJob {
    id: string;
    status: "running" | "finished" | "failed" | "cancelled";
    blendCopy: string;
    scene: string;
    frameStart: number;
    frameEnd: number;
    currentFrame: number | null;
    framesDone: number;
    savedFiles: string[];
    outputDir: string;
    passesDir: string | null;
    fps: number;
    width: number;
    height: number;
    startedAt: string;
    finishedAt?: string;
    exitCode?: number | null;
    logTail: string[];
    kill?: () => void;
}

export const renderJobs = new Map<string, RenderJob>();

function publicJob(job: RenderJob) {
    const { kill: _kill, ...rest } = job;
    const total = job.frameEnd - job.frameStart + 1;
    return { ...rest, savedFiles: job.savedFiles.slice(-10), savedCount: job.savedFiles.length, progress: `${job.framesDone}/${total}` };
}

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
                    .describe("Honour the scene's render region (Ctrl+B border). Off by default: a region render is a crop, so compositor setups over the plate (shadow catcher, alpha over) do not line up.")
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
    bpy.ops.render.render()
    bpy.data.images["Render Result"].save_render(filepath=path, scene=sc)
finally:
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
        "render_animation",
        {
            title: "Render animation (background)",
            description:
                "Renders the frame range in a separate background Blender process from a saved snapshot of the current file, so the user's Blender stays usable. Returns a jobId immediately; poll with get_render_status. This spends machine time (a Cycles shot can take hours): confirm frame range, engine and samples with the user before starting. The file must have been saved at least once (the snapshot is written next to it so // paths keep working).",
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
                    scene: string;
                    start: number;
                    end: number;
                    output_dir: string;
                    passes_dir: string | null;
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
return {"copy": copy, "scene": sc.name,
        "start": args.get("frameStart") if args.get("frameStart") is not None else sc.frame_start,
        "end": args.get("frameEnd") if args.get("frameEnd") is not None else sc.frame_end,
        "output_dir": os.path.dirname(bpy.path.abspath(sc.render.filepath)),
        "passes_dir": bpy.path.abspath(fo.directory) if fo and not fo.mute else None,
        "fps": fps(sc), "width": w, "height": h}
`,
                    args
                );
                const job: RenderJob = {
                    id: randomUUID().slice(0, 8),
                    status: "running",
                    blendCopy: info.copy,
                    scene: info.scene,
                    frameStart: info.start,
                    frameEnd: info.end,
                    currentFrame: null,
                    framesDone: 0,
                    savedFiles: [],
                    outputDir: info.output_dir,
                    passesDir: info.passes_dir,
                    fps: info.fps,
                    width: info.width,
                    height: info.height,
                    startedAt: new Date().toISOString(),
                    logTail: []
                };
                const child = spawn(
                    BLENDER_BIN,
                    ["-b", info.copy, "-S", info.scene, "-s", String(info.start), "-e", String(info.end), "-a"],
                    { stdio: ["ignore", "pipe", "pipe"] }
                );
                job.kill = () => child.kill("SIGTERM");
                const framesSeen = new Set<number>();
                const onLine = (line: string) => {
                    if (!line.trim()) return;
                    job.logTail.push(line);
                    if (job.logTail.length > 30) job.logTail.shift();
                    const saved = /Saved: '(.+)'/.exec(line);
                    if (saved) {
                        job.savedFiles.push(saved[1]);
                        // Blender 5.x no longer prints "Fra:" lines: take the frame from the file name
                        const num = /(\d+)\.\w+$/.exec(saved[1]);
                        if (num) {
                            job.currentFrame = Number(num[1]);
                            framesSeen.add(job.currentFrame);
                            job.framesDone = framesSeen.size;
                        }
                    }
                };
                let pending = "";
                const feed = (chunk: Buffer) => {
                    pending += chunk.toString("utf8");
                    const lines = pending.split("\n");
                    pending = lines.pop() ?? "";
                    lines.forEach(onLine);
                };
                child.stdout.on("data", feed);
                child.stderr.on("data", feed);
                child.on("close", async (code) => {
                    if (job.status === "running") job.status = code === 0 ? "finished" : "failed";
                    job.exitCode = code;
                    job.finishedAt = new Date().toISOString();
                    if (!args.keepSnapshot) await unlink(info.copy).catch(() => {});
                });
                renderJobs.set(job.id, job);
                return { jobId: job.id, ...publicJob(job) };
            })
    );

    server.registerTool(
        "get_render_status",
        {
            title: "Get render status",
            description: "Progress of background renders started with render_animation (frames done, last saved files, log tail). Omit jobId to list all jobs of this session. cancel=true stops the job.",
            inputSchema: z.object({ jobId: z.string().optional(), cancel: z.boolean().default(false) })
        },
        async ({ jobId, cancel }) =>
            runTool(async () => {
                if (!jobId) return [...renderJobs.values()].map(publicJob);
                const job = renderJobs.get(jobId);
                if (!job) throw new Error(`No render job ${jobId}. Jobs: ${[...renderJobs.keys()].join(", ") || "none"}`);
                if (cancel && job.status === "running") {
                    job.status = "cancelled";
                    job.kill?.();
                }
                return publicJob(job);
            })
    );
}
