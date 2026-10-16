import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { runPython } from "../blender-bridge.js";
import { runExtendScript, runExtendScriptInUndoGroup } from "../ae/ae-bridge.js";
import { jsxLiteral } from "../ae/jsx-literal.js";
import { runTool } from "../tool-helpers.js";
import { ELEMENTS_FILE, jobs } from "../jobs.js";

const PPM = z
    .number()
    .positive()
    .default(100)
    .describe("Pixels per Blender metre in AE space. Keep the same value in both directions for a round trip.");

/** JSX helper: find a comp by name, or create it. */
const JSX_GET_OR_CREATE_COMP = `
function __getOrCreateComp(name, w, h, fps, duration) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name === name) return { comp: it, created: false };
    }
    return { comp: app.project.items.addComp(name, w, h, 1, duration, fps), created: true };
}
function __removeLayersNamed(comp, name) {
    for (var i = comp.numLayers; i >= 1; i--) {
        if (comp.layer(i).name === name) comp.layer(i).remove();
    }
}
`;

interface AeSample {
    width: number;
    height: number;
    fps: number;
    ppm: number;
    frame_start: number;
    frame_end: number;
    scene: string;
    file: string;
    warnings: string[];
    items: Record<
        string,
        {
            kind: "CAMERA" | "NULL";
            animated: boolean;
            frames: { frame: number; position: number[]; rotation: number[]; scale: number[]; zoom?: number; focus_distance?: number }[];
        }
    >;
}

export function registerAeLinkTools(server: McpServer): void {
    server.registerTool(
        "export_to_ae",
        {
            title: "Export camera & nulls to After Effects",
            description:
                "Sends a Blender camera and objects (empties, or any object as a position/rotation reference) to a running After Effects as a one-node 3D camera and 3D nulls, baked per frame, so AE layers can be parented to them and composited over the Blender render. Converts axes (Blender Z-up metres -> AE Y-down pixels), focal length -> Zoom, and maps frame_start to AE time 0 (comp start frame display is set to match). Creates the comp (named after the scene by default, with the Blender output size/fps) or reuses an existing one, replacing layers with the same names, so it is safe to re-run. Requires AE open with a project.",
            inputSchema: z.object({
                camera: z.string().optional().describe("Blender camera object. Default: the scene camera. Pass empty string to skip the camera."),
                objects: z.array(z.string()).default([]).describe("Objects to export as 3D nulls (track points, empties, hero object pivots...)."),
                compName: z.string().optional(),
                frameStart: z.number().int().optional(),
                frameEnd: z.number().int().optional(),
                step: z.number().int().min(1).default(1).describe("Bake every Nth frame."),
                ppm: PPM
            })
        },
        async (args) =>
            runTool(async () => {
                const data = await runPython<AeSample>(
                    `
sc = scene()
cam = args.get("camera")
if cam is None:
    cam = sc.camera.name if sc.camera else None
start = args.get("frameStart") if args.get("frameStart") is not None else sc.frame_start
end = args.get("frameEnd") if args.get("frameEnd") is not None else sc.frame_end
return sample_for_ae(args["objects"], cam or None, args["ppm"], start, end, args["step"])
`,
                    args,
                    { timeoutMs: 600_000 }
                );
                const compName = args.compName || data.scene;
                const result = await runExtendScriptInUndoGroup<{ comp: string; created: boolean; layers: unknown[]; mismatch: string[] }>(
                    `${JSX_GET_OR_CREATE_COMP}
var d = ${jsxLiteral(data)};
var step = ${jsxLiteral(args.step)};
var nFrames = d.frame_end - d.frame_start + 1;
var duration = nFrames / d.fps;
var got = __getOrCreateComp(${jsxLiteral(compName)}, d.width, d.height, d.fps, duration);
var comp = got.comp;
var mismatch = [];
if (comp.width !== d.width || comp.height !== d.height) mismatch.push("comp size " + comp.width + "x" + comp.height + " != Blender " + d.width + "x" + d.height);
if (Math.abs(comp.frameRate - d.fps) > 0.001) mismatch.push("comp fps " + comp.frameRate + " != Blender " + d.fps);
if (got.created) { try { comp.displayStartFrame = d.frame_start; } catch (e) {} }
var report = [];
for (var name in d.items) {
    var it = d.items[name];
    __removeLayersNamed(comp, name);
    var L;
    if (it.kind === "CAMERA") {
        L = comp.layers.addCamera(name, [d.width / 2, d.height / 2]);
        L.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
    } else {
        L = comp.layers.addNull(duration);
        L.name = name;
        L.threeDLayer = true;
        L.transform.anchorPoint.setValue([L.width / 2, L.height / 2, 0]);
    }
    L.label = it.kind === "CAMERA" ? 2 : 9;
    L.comment = "From Blender: " + d.file + " (scene " + d.scene + ", frames " + d.frame_start + "-" + d.frame_end + ", ppm " + d.ppm + ")";
    L.startTime = 0;
    L.outPoint = duration;
    var tr = L.transform;
    if (tr.position.dimensionsSeparated) tr.position.dimensionsSeparated = false;
    tr.orientation.setValue([0, 0, 0]);
    var times = [], pos = [], rx = [], ry = [], rz = [], scl = [], zoom = [];
    for (var i = 0; i < it.frames.length; i++) {
        var f = it.frames[i];
        times.push((f.frame - d.frame_start) / d.fps);
        pos.push(f.position); rx.push(f.rotation[0]); ry.push(f.rotation[1]); rz.push(f.rotation[2]);
        scl.push(f.scale); if (f.zoom !== undefined) zoom.push(f.zoom);
    }
    function apply(prop, vals) {
        if (vals.length === 0) return;
        if (vals.length === 1) prop.setValue(vals[0]); else prop.setValuesAtTimes(times, vals);
    }
    apply(tr.position, pos); apply(tr.xRotation, rx); apply(tr.yRotation, ry); apply(tr.zRotation, rz);
    if (it.kind === "CAMERA") {
        var opts = L.property("ADBE Camera Options Group");
        apply(opts.property("ADBE Camera Zoom"), zoom);
        var f0 = it.frames[0];
        if (f0.focus_distance !== undefined) {
            opts.property("ADBE Camera Depth of Field").setValue(1);
            opts.property("ADBE Camera Focus Distance").setValue(f0.focus_distance);
        }
    } else {
        apply(tr.scale, scl);
    }
    report.push({ name: L.name, index: L.index, kind: it.kind, keys: it.frames.length > 1 ? it.frames.length : 0 });
}
return { comp: comp.name, created: got.created, layers: report, mismatch: mismatch };
`,
                    "blender-mcp: export_to_ae",
                    300_000
                );
                return { ...result, blender: { scene: data.scene, frames: [data.frame_start, data.frame_end], size: [data.width, data.height], fps: data.fps }, warnings: data.warnings };
            })
    );

    server.registerTool(
        "import_from_ae",
        {
            title: "Import camera, nulls & footage from After Effects",
            description:
                "Reads 3D layers from an After Effects comp and recreates them in Blender, baked per frame: cameras (incl. two-node/POI and parented cameras, e.g. from the 3D Camera Tracker) become Blender cameras with matching focal length; nulls and lights become empties; footage/solid/precomp layers become planes of the right size at the anchor point, footage ones with an emission material using the source file (stills, sequences, movies). Optionally sets Blender's resolution, fps and frame range to the comp. Re-running updates objects with the same names. Requires AE open with the comp.",
            inputSchema: z.object({
                compName: z.string().optional().describe("Default: the active comp."),
                layers: z.array(z.string()).optional().describe("Layer names. Default: the active camera plus every 3D layer."),
                ppm: PPM,
                step: z.number().int().min(1).default(1),
                collection: z.string().default("From AE"),
                setScene: z.boolean().default(true).describe("Match Blender resolution/fps/frame range to the comp."),
                frameStart: z.number().int().default(1).describe("Blender frame for AE comp time 0.")
            })
        },
        async (args) =>
            runTool(async () => {
                const ae = await runExtendScript<{
                    width: number;
                    height: number;
                    fps: number;
                    num_frames: number;
                    comp: string;
                    layers: { name: string; index: number; kind: string; width: number; height: number; anchor: number[]; source?: Record<string, unknown> }[];
                    raw: string[];
                }>(
                    `
var compName = ${jsxLiteral(args.compName)};
var wanted = ${jsxLiteral(args.layers)};
var step = ${jsxLiteral(args.step)};
var comp = null;
if (compName) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name === compName) { comp = it; break; }
    }
    if (!comp) throw new Error("No comp named " + compName);
} else {
    comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) throw new Error("No active comp: open one in AE or pass compName");
}
var picked = [];
for (var i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    var take;
    if (wanted) {
        take = false;
        for (var j = 0; j < wanted.length; j++) if (wanted[j] === L.name) take = true;
    } else {
        take = (L instanceof CameraLayer && L === comp.activeCamera) || (L instanceof AVLayer && L.threeDLayer) || (L instanceof LightLayer);
    }
    if (take) picked.push(L);
}
if (picked.length === 0) throw new Error("No matching layers (default = active camera + 3D layers)");
var meta = [];
for (var i = 0; i < picked.length; i++) {
    var L = picked[i];
    var m = { name: L.name, kind: "NULL", width: 0, height: 0, anchor: [0, 0, 0] };
    if (L instanceof CameraLayer) m.kind = "CAMERA";
    else if (L instanceof AVLayer && !L.nullLayer) {
        m.kind = "PLANE"; m.width = L.width; m.height = L.height;
        var ap = L.transform.anchorPoint.valueAtTime(0, false);
        m.anchor = [ap[0], ap[1], ap.length > 2 ? ap[2] : 0];
        var src = L.source;
        if (src instanceof FootageItem && src.mainSource instanceof SolidSource) {
            var sc = src.mainSource.color;
            m.solid_color = [sc[0], sc[1], sc[2]];
        } else if (src instanceof FootageItem && src.mainSource instanceof FileSource && src.file) {
            var path = src.file.fsName;
            var isMovie = /\\.(mov|mp4|m4v|avi|mxf|webm|mkv)$/i.test(path);
            m.source = { path: path, is_movie: isMovie, is_sequence: !isMovie && !src.mainSource.isStill,
                         frames: Math.round(src.duration * (src.frameRate || comp.frameRate)),
                         start_offset_frames: Math.round(L.startTime / comp.frameDuration) };
        }
    }
    meta.push(m);
}
var sampler = comp.layers.addText("__blender_mcp_sampler");
var raw = [];
try {
    var idx = [];
    for (var i = 0; i < picked.length; i++) idx.push(picked[i].index);
    var expr = [
        "var idx = [" + idx.join(",") + "]; var parts = [];",
        "function v(a) { return '[' + a[0] + ',' + a[1] + ',' + (a.length > 2 ? a[2] : 0) + ']'; }",
        "for (var i = 0; i < idx.length; i++) {",
        "  var L = thisComp.layer(idx[i]); var a = [0, 0, 0];",
        "  try { var ap = L.transform.anchorPoint; a = [ap[0], ap[1], ap.length > 2 ? ap[2] : 0]; } catch (e) {}",
        "  var zm = 'null'; try { zm = L.cameraOption.zoom; } catch (e) {}",
        "  parts.push('{\\"o\\":' + v(L.toWorld(a)) + ',\\"x\\":' + v(L.toWorld([a[0] + 1, a[1], a[2]])) +",
        "    ',\\"y\\":' + v(L.toWorld([a[0], a[1] + 1, a[2]])) + ',\\"z\\":' + v(L.toWorld([a[0], a[1], a[2] + 1])) + ',\\"zoom\\":' + zm + '}');",
        "}",
        "'[' + parts.join(',') + ']';"
    ].join("\\n");
    var st = sampler.property("ADBE Text Properties").property("ADBE Text Document");
    st.expression = expr;
    if (st.expressionError) throw new Error("Sampler expression error: " + st.expressionError);
    var n = Math.round(comp.duration * comp.frameRate);
    for (var f = 0; f < n; f += step) raw.push(st.valueAtTime(f * comp.frameDuration, false).text);
} finally {
    sampler.remove();
}
return { comp: comp.name, width: comp.width, height: comp.height, fps: comp.frameRate,
         num_frames: Math.round(comp.duration * comp.frameRate), layers: meta, raw: raw };
`,
                    300_000
                );
                // raw[frame] = JSON array (one entry per layer); transpose to per-layer samples
                const perFrame = ae.raw.map((s) => JSON.parse(s) as { o: number[]; x: number[]; y: number[]; z: number[]; zoom: number | null }[]);
                const layers = ae.layers.map((meta, li) => {
                    let samples = perFrame.map((fr) => fr[li]);
                    const first = JSON.stringify(samples[0]);
                    if (samples.every((s) => JSON.stringify(s) === first)) samples = [samples[0]];
                    return { ...meta, samples, step: args.step };
                });
                const created = await runPython<{ objects: unknown[]; warnings: unknown[] }>(
                    `
data = args["data"]
for l in data["layers"]:
    src = l.get("source")
    if src and src.get("is_sequence"):
        m = re.search(r"(\\d+)(?=\\.[^.]+$)", os.path.basename(src["path"]))
        src["first_number"] = int(m.group(1)) if m else 1
return {"objects": apply_from_ae(data, args["ppm"], args["collection"], args["setScene"], args["frameStart"]),
        "warnings": [w for w in [hdr_warning()] if w]}
`,
                    {
                        data: { width: ae.width, height: ae.height, fps: ae.fps, num_frames: ae.num_frames, layers },
                        ppm: args.ppm,
                        collection: args.collection,
                        setScene: args.setScene,
                        frameStart: args.frameStart
                    },
                    { undo: "MCP: import from AE", timeoutMs: 600_000 }
                );
                return { comp: ae.comp, size: [ae.width, ae.height], fps: ae.fps, frames: ae.num_frames, created: created.objects, warnings: created.warnings };
            })
    );

    server.registerTool(
        "import_render_to_ae",
        {
            title: "Import Blender render into After Effects",
            description:
                "Imports rendered image sequences into After Effects and stacks them in a comp. Only after the user has seen the render (or a preview_render) and said OK to bringing it into AE. Give a jobId from render_animation, or a directory. With separate passes, the beauty is the visible base layer and each pass is added above it, disabled, with a suggested blend mode (AO/shadow multiply, emission/glossy/env add) so the compositor switches on what they need. Per-element renders (setup_element_layers) come in as one group of adjacent layers per element, named '<element> <pass>' and colour-labelled per element: [passes off] > beauty for each element, nearest to the camera on top (or in the order given), then the shadow catcher passes, then the plate. Shared shadows (holdout) come in once, as 'Blender shadows (all elements)'. Multilayer EXR comes in as one layer, off when there are separate passes (use AE's Cryptomatte effect or EXtractoR on it). If the comp already holds an opaque footage layer (the plate, e.g. the filmed shot), the CG goes right above it and the shadow catcher passes (Cycles shadow_catcher) sit under the beauties, switched on in Multiply, so the CG casts its shadows onto the plate. Without a plate, the layers go to the bottom of the comp, below any camera/nulls from export_to_ae. To land in the plate's comp, pass its name as compName. Footage is interpreted at the Blender fps.",
            inputSchema: z.object({
                jobId: z.string().optional(),
                directory: z
                    .string()
                    .optional()
                    .describe("Absolute directory with the sequences (used if no jobId). For a per-element render give the scene's render folder (//render/<scene>/): its element subfolders are found from mcp_elements.json or by name."),
                passesDirectory: z.string().optional(),
                elements: z
                    .array(z.object({ name: z.string(), directory: z.string() }))
                    .optional()
                    .describe("Explicit per-element folders, front (top of the comp) to back. Overrides the job's or directory's elements."),
                elementOrder: z.array(z.string()).optional().describe("Element names front to back, to override the camera-depth order."),
                sharedShadows: z
                    .boolean()
                    .optional()
                    .describe("Whether every element's shadow catcher pass holds all the shadows (setup_element_layers shadows='shared'). Default: from the job or mcp_elements.json, else false."),
                compName: z.string().optional().describe("Default: '<scene>' for a job, folder name otherwise."),
                fps: z.number().positive().optional().describe("Default: the job's fps, else 25."),
                projectFolder: z.string().default("Blender Renders").describe("AE project folder for the footage; 'A/B' nests B in A. Elements get a subfolder each.")
            })
        },
        async (args) =>
            runTool(async () => {
                // One source folder: element "" = the single-layer render.
                let sources: { dir: string; element: string; kind: "auto" | "passes" }[] = [];
                let fps = args.fps;
                let compName = args.compName;
                let size: number[] | null = null;
                let elements: { name: string; dir: string }[] | null = null;
                let shared: boolean | undefined = args.sharedShadows;
                if (args.jobId) {
                    const job = jobs.get(args.jobId);
                    if (!job || job.kind !== "render") throw new Error(`No render job ${args.jobId}`);
                    if (job.status === "running") throw new Error(`Job ${job.id} is still rendering (${job.framesDone} frames done)`);
                    sources = [{ dir: job.outputDir, element: "", kind: "auto" }];
                    if (job.passesDir) sources.push({ dir: job.passesDir, element: "", kind: "auto" });
                    if (job.elements) elements = job.elements;
                    shared ??= job.elementShadows === "shared";
                    fps ??= job.fps;
                    compName ??= job.scene;
                    size = [job.width, job.height];
                } else if (args.directory) {
                    sources = [{ dir: args.directory, element: "", kind: "auto" }];
                    if (args.passesDirectory) sources.push({ dir: args.passesDirectory, element: "", kind: "auto" });
                    compName ??= args.directory.replace(/\/+$/, "").split("/").pop();
                    const found = await findElementDirs(args.directory);
                    if (found) {
                        elements = found.elements;
                        shared ??= found.shadows === "shared";
                        fps ??= found.fps;
                    }
                } else if (!args.elements) {
                    throw new Error("Give jobId, directory or elements");
                }
                if (args.elements) elements = args.elements.map((e) => ({ name: e.name, dir: e.directory }));
                if (elements && args.elementOrder) {
                    const rank = (n: string) => {
                        const i = args.elementOrder!.indexOf(n);
                        return i < 0 ? 1e9 : i;
                    };
                    elements = [...elements].sort((a, b) => rank(a.name) - rank(b.name));
                }
                for (const e of elements ?? []) sources.push({ dir: e.dir, element: e.name, kind: "passes" });
                compName ??= elements?.[0]?.name ?? "Blender";
                fps ??= 25;

                const seqs = new Map<string, { first: string; firstNum: number; count: number; tag: string; element: string; kind: string }>();
                for (const src of sources) {
                    for (const f of await readdir(src.dir)) {
                        const m = /^(.*?)(\d+)\.(exr|png|tif|tiff|jpg|jpeg|dpx)$/i.exec(f);
                        if (!m || f.includes(".mcp_render")) continue;
                        const key = join(src.dir, m[1] + "#." + m[3].toLowerCase());
                        const num = Number(m[2]);
                        const cur = seqs.get(key);
                        if (!cur) seqs.set(key, { first: join(src.dir, f), firstNum: num, count: 1, tag: m[1], element: src.element, kind: src.kind });
                        else {
                            cur.count++;
                            if (num < cur.firstNum) Object.assign(cur, { first: join(src.dir, f), firstNum: num });
                        }
                    }
                }
                if (seqs.size === 0) throw new Error(`No image sequences found in ${sources.map((s) => s.dir).join(", ")}`);
                let list = [...seqs.values()].map(({ kind, ...s }) => {
                    const tag = /_([A-Za-z]+)_$/.exec(s.tag)?.[1] ?? "beauty";
                    const isPass = kind === "passes" || s.first.includes("/passes/");
                    return { ...s, pass: isPass ? tag : "multilayer" };
                });
                // Shared shadows are the same picture in every element: bring in one.
                let sharedShadowFrom: string | null = null;
                if (elements && shared) {
                    const catchers = list.filter((s) => s.element && s.pass === "shadowCatcher");
                    sharedShadowFrom = catchers[catchers.length - 1]?.element ?? null;
                    list = list.filter((s) => !(s.element && s.pass === "shadowCatcher" && s.element !== sharedShadowFrom));
                }
                const groups = elements ? elements.map((e) => e.name).filter((n) => list.some((s) => s.element === n)) : [];

                return runExtendScriptInUndoGroup(
                    `${JSX_GET_OR_CREATE_COMP}
var seqs = ${jsxLiteral(list)};
var groups = ${jsxLiteral(groups)};
var sharedShadowFrom = ${jsxLiteral(sharedShadowFrom)};
var fps = ${jsxLiteral(fps)};
var size = ${jsxLiteral(size)};
var compName = ${jsxLiteral(compName)};
var folderPath = ${jsxLiteral(args.projectFolder.split("/").filter(Boolean))};
var BLEND = { AO: "MULTIPLY", shadow: "MULTIPLY", emission: "ADD", glossDir: "ADD", glossInd: "ADD", env: "ADD", bloom: "ADD", volDir: "ADD", transDir: "ADD", transInd: "ADD" };
// AE label colours, one per element group: red, yellow, aqua, pink, lavender, peach, sea foam, blue, green, purple, orange...
var LABELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
function findFolder(name, parent) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof FolderItem && it.name === name && it.parentFolder === parent) return it;
    }
    var f = app.project.items.addFolder(name);
    f.parentFolder = parent;
    return f;
}
var folder = app.project.rootFolder;
for (var i = 0; i < folderPath.length; i++) folder = findFolder(folderPath[i], folder);
function inOurFolder(item) {
    for (var p = item.parentFolder; p && p !== app.project.rootFolder; p = p.parentFolder) if (p === folder) return true;
    return false;
}
var items = [];
function findImported(path) {
    for (var k = 1; k <= app.project.numItems; k++) {
        var f = app.project.item(k);
        if (f instanceof FootageItem && f.file && f.file.fsName === path && inOurFolder(f)) return f;
    }
    return null;
}
for (var i = 0; i < seqs.length; i++) {
    var again = findImported(new File(seqs[i].first).fsName);
    if (again) {  // already imported: reload it (picks up re-rendered frames) instead of importing a duplicate
        try { again.mainSource.reload(); } catch (e) {}
        if (seqs[i].count > 1) again.mainSource.conformFrameRate = fps;
        items.push({ item: again, s: seqs[i] });
        continue;
    }
    var io = new ImportOptions(new File(seqs[i].first));
    io.sequence = seqs[i].count > 1;
    io.forceAlphabetical = false;
    var item = app.project.importFile(io);
    item.parentFolder = seqs[i].element ? findFolder(seqs[i].element, folder) : folder;
    if (io.sequence) item.mainSource.conformFrameRate = fps;
    items.push({ item: item, s: seqs[i] });
}
var hasBeauty = {};
for (var i = 0; i < items.length; i++) if (items[i].s.pass === "beauty") hasBeauty[items[i].s.element] = true;
function isBase(x) { return x.s.pass === "beauty" || (x.s.pass === "multilayer" && !x.s.element && !hasBeauty[""] && groups.length === 0); }
var ref = items[0].item;
for (var i = 0; i < items.length; i++) if (isBase(items[i])) { ref = items[i].item; break; }
var got = __getOrCreateComp(compName, size ? size[0] : ref.width, size ? size[1] : ref.height, fps, ref.duration);
var comp = got.comp;
function layerName(x) {
    if (x.s.pass === "multilayer") return "Blender EXR (multilayer)";
    if (x.s.element && x.s.pass === "shadowCatcher" && sharedShadowFrom) return "Blender shadows (all elements)";
    return x.s.element ? x.s.element + " " + x.s.pass : "Blender " + x.s.pass;
}
for (var i = 0; i < items.length; i++) __removeLayersNamed(comp, layerName(items[i]));
// The plate: the topmost enabled, opaque file-footage layer that is not one of our renders.
var plate = null;
for (var i = 1; i <= comp.numLayers && !plate; i++) {
    var P = comp.layer(i);
    if (!(P instanceof AVLayer) || P.nullLayer || P.adjustmentLayer || P.guideLayer || !P.enabled) continue;
    var ps = P.source;
    if (!(ps instanceof FootageItem) || !(ps.mainSource instanceof FileSource) || ps.mainSource.hasAlpha) continue;
    if (inOurFolder(ps) || /^Blender /.test(P.name)) continue;
    plate = P;
}
// Per group (element, or "" for a single-layer render): passes above, then the base.
var byGroup = {}, catchers = [], multilayer = [], added = [];
var order = groups.length ? groups.slice() : [""];
for (var g = 0; g < order.length; g++) byGroup[order[g]] = { passes: [], base: null };
for (var i = 0; i < items.length; i++) {
    var x = items[i];
    var L = comp.layers.add(x.item);
    L.name = layerName(x);
    L.startTime = 0;
    var base = isBase(x);
    var isCatcher = x.s.pass === "shadowCatcher";
    // The shadow catcher pass is the plate's shading (white = untouched): multiplied over the plate it adds the shadows.
    var visible = base || (isCatcher && plate !== null);
    if (!visible) L.enabled = false;
    var blend = isCatcher ? "MULTIPLY" : BLEND[x.s.pass];
    if (blend) L.blendingMode = BlendingMode[blend];
    var gi = -1;
    for (var g = 0; g < groups.length; g++) if (groups[g] === x.s.element) gi = g;
    if (gi >= 0) L.label = LABELS[gi % LABELS.length];
    var fit = null;
    if (x.item.width !== comp.width) {
        fit = comp.width / x.item.width * 100;
        L.transform.scale.setValue([fit, fit]);
    }
    var grp = byGroup[x.s.element];
    if (isCatcher) catchers.push({ L: L, g: gi });
    else if (x.s.pass === "multilayer" && groups.length) multilayer.push(L);
    else if (base && grp && !grp.base) grp.base = L;
    else if (grp) grp.passes.push(L);
    else multilayer.push(L);
    added.push({ layer: L.name, element: x.s.element || null, frames: x.s.count, visible: visible, blend: blend || "NORMAL", scaledToFitPercent: fit });
}
catchers.sort(function (a, b) { return a.g - b.g; });
// Stack, top to bottom: [passes, off] > base for each group (nearest first) > multilayer (off) > shadow catchers (multiply) > plate.
var stack = [];
for (var g = 0; g < order.length; g++) {
    var G = byGroup[order[g]];
    for (var k = 0; k < G.passes.length; k++) stack.push(G.passes[k]);
    if (G.base) stack.push(G.base);
}
for (var k = 0; k < multilayer.length; k++) stack.push(multilayer[k]);
for (var k = 0; k < catchers.length; k++) stack.push(catchers[k].L);
for (var k = 0; k < stack.length; k++) { if (plate) stack[k].moveBefore(plate); else stack[k].moveToEnd(); }
var layerOrder = [];
for (var i = 1; i <= comp.numLayers; i++) layerOrder.push(comp.layer(i).name);
var notes = ["EXR is linear: set the project to a linear working space / OCIO, or interpret footage as Linear Rec.709, to match Blender."];
if (catchers.length && !plate) notes.push("No opaque footage layer (plate) found: the shadow catcher passes were left off, under the CG. Put them over the plate, in Multiply.");
if (sharedShadowFrom) notes.push("Shadows are shared (holdout): every element's shadow catcher pass holds all the shadows, so it comes in once. For one shadow layer per element, re-run setup_element_layers with shadows='per_element'.");
return { comp: comp.name, created: got.created, plate: plate ? plate.name : null, elements: groups, layers: added, order: layerOrder, notes: notes };
`,
                    "blender-mcp: import_render_to_ae",
                    300_000
                );
            })
    );
}

/**
 * Per-element render folder: mcp_elements.json (written by render_animation) or, failing that,
 * subfolders holding '<subfolder>_<pass>_####' sequences, in alphabetical order.
 */
async function findElementDirs(dir: string): Promise<{ elements: { name: string; dir: string }[]; shadows?: string; fps?: number } | null> {
    try {
        const meta = JSON.parse(await readFile(join(dir, ELEMENTS_FILE), "utf8"));
        if (Array.isArray(meta.elements) && meta.elements.length) return meta;
    } catch {
        /* no metadata: look at the subfolders */
    }
    const found: { name: string; dir: string }[] = [];
    for (const ent of await readdir(dir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const sub = join(dir, ent.name);
        const files = await readdir(sub).catch(() => [] as string[]);
        if (files.some((f) => f.startsWith(ent.name + "_") && /_[A-Za-z]+_\d+\.\w+$/.test(f))) found.push({ name: ent.name, dir: sub });
    }
    return found.length ? { elements: found.sort((a, b) => a.name.localeCompare(b.name)) } : null;
}
