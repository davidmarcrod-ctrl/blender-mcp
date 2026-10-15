import { z } from "zod";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/server";
import { runPython } from "../blender-bridge.js";
import { runTool } from "../tool-helpers.js";
import { BLENDER_APP } from "./file.js";

const execFileAsync = promisify(execFile);
const SOLVE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "blender-scripts", "track_solve.py");

/** Blender's bundled Python (it ships numpy), used to run the solver outside Blender's main thread. */
function blenderPython(): string {
    if (process.env.BLENDER_MCP_PYTHON) return process.env.BLENDER_MCP_PYTHON;
    const res = join(BLENDER_APP, "Contents", "Resources");
    for (const ver of readdirSync(res).filter((d) => /^\d+\.\d+$/.test(d)).sort().reverse()) {
        const bin = join(res, ver, "python", "bin");
        const py = existsSync(bin) ? readdirSync(bin).find((f) => /^python3(\.\d+)?$/.test(f)) : undefined;
        if (py) return join(bin, py);
    }
    throw new Error(`No Python found inside ${BLENDER_APP}. Set BLENDER_MCP_PYTHON to a python3 with numpy.`);
}

function findTool(name: string): string {
    for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) if (existsSync(join(dir, name))) return join(dir, name);
    throw new Error(`${name} not found. Install it with: brew install ffmpeg`);
}

interface CamInfo {
    path: string;
    is_sequence: boolean;
    first: number;
    offset: number;
    start: number;
    end: number;
    seed: number;
    camera: string;
    P: number[][][];
    cam_pos: number[][];
}

export function registerSolveTools(server: McpServer): void {
    server.registerTool(
        "triangulate_points",
        {
            title: "Triangulate points & floor from the camera",
            description:
                "Finds where things in the filmed footage are in 3D, using a camera that is already solved (e.g. imported from AE's 3D Camera Tracker with import_from_ae). It follows image points through the shot (NCC tracking), and from the camera positions triangulates their 3D position (DLT), like a small 3D tracker that reuses the existing camera. Use it to place objects on real surfaces: give named points (a box corner, a wheel hub) and/or a floor (floorPoints: named points that touch the ground, best; floorRegions: textured floor patches); a floor plane is fitted with RANSAC and created as a shadow catcher, and the named points get their height above it. Coordinates are FULL-RES footage pixels (= AE comp pixels when the comp matches the footage), y down, at seedFrame. Call it first with no points and no floorRegions to get the seed frame with a grid (lines every 200 px, brighter every 1000) to read coordinates from. The answer includes check images of the seed frame and of the far end of the shot: magenta grid = the solved floor (it must stay glued to the real floor in both), green = triangulated points reprojected, red = lost, blue = floor features used, orange = floor outliers. Quality: err_px under ~1 px is good; parallax_deg under ~1 means the camera barely moves relative to that point, so its depth is unreliable. Needs ffmpeg (brew install ffmpeg).",
            inputSchema: z.object({
                clip: z.string().optional().describe("Movie clip datablock with the footage. Default: the only movie clip in the file."),
                footage: z.string().optional().describe("Or an absolute path to a movie / first image of a sequence, instead of a clip."),
                footageStartFrame: z.number().int().optional().describe("With footage: scene frame showing its first frame. Default: scene start."),
                camera: z.string().optional().describe("Solved camera object. Default: the scene camera."),
                frameStart: z.number().int().optional(),
                frameEnd: z.number().int().optional(),
                seedFrame: z.number().int().optional().describe("Frame where the pixel coordinates are given. Default: frameStart."),
                points: z
                    .record(z.string(), z.array(z.number()).length(2))
                    .optional()
                    .describe("{name: [x, y]} full-res pixels at seedFrame. Each snaps to the nearest strong corner within a few px."),
                floorRegions: z
                    .array(z.array(z.number()).length(4))
                    .optional()
                    .describe("[[x0, y0, x1, y1], ...] full-res pixels at seedFrame: textured patches of floor to fit the ground plane to. Several patches spread over the floor give a much better plane than one."),
                floorPoints: z
                    .array(z.string())
                    .optional()
                    .describe("Names from points that touch the floor (a foot, where a tyre meets the ground, a box's bottom corner). They anchor the floor plane and are far more reliable than plain tiles: give at least 3, or combine with floorRegions."),
                create: z.boolean().default(true).describe("Create empties 'Solved <name>' and the plane 'Solved Floor' (re-running updates them)."),
                floorShadowCatcher: z.boolean().default(true).describe("Make 'Solved Floor' a Cycles shadow catcher (invisible, but receives the CG shadows)."),
                collection: z.string().default("Solved Points"),
                workWidth: z.number().int().min(320).max(3840).default(960).describe("Analysis width in px. Higher = slower, a bit more precise.")
            })
        },
        async (args) =>
            runTool(async () => {
                const pickMode = !args.points && !args.floorRegions;
                const cam = await runPython<CamInfo>(
                    `
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
sc = scene()
cam = get_object(args["camera"]) if args.get("camera") else sc.camera
if cam is None or cam.type != "CAMERA":
    raise RuntimeError("No camera: pass camera or set a scene camera")
if args.get("footage"):
    path, is_seq = args["footage"], not re.search(r"\\.(mov|mp4|m4v|avi|mxf|webm|mkv)$", args["footage"], re.I)
    first = args.get("footageStartFrame") if args.get("footageStartFrame") is not None else sc.frame_start
    offset = 0
else:
    clips = bpy.data.movieclips
    if args.get("clip"):
        clip = clips[args["clip"]]
    elif len(clips) == 1:
        clip = clips[0]
    else:
        raise RuntimeError(f"Pass clip (one of {[c.name for c in clips]}) or footage")
    path, is_seq, first, offset = os.path.normpath(bpy.path.abspath(clip.filepath)), clip.source == "SEQUENCE", clip.frame_start, clip.frame_offset
start = args.get("frameStart") if args.get("frameStart") is not None else sc.frame_start
end = args.get("frameEnd") if args.get("frameEnd") is not None else sc.frame_end
seed = args.get("seedFrame") if args.get("seedFrame") is not None else start
if args["pickMode"]:
    start = end = seed
if not start <= seed <= end:
    raise RuntimeError(f"seedFrame {seed} is outside {start}-{end}")
# Fit each frame's 3x4 projection (world -> [0,1] image coords, y down) to exact projections of
# synthetic points: covers lens, sensor fit and shift without re-deriving Blender's camera model.
grid = [(x, y, z) for z in (1.0, 3.0, 9.0) for x in (-0.4, 0.4) for y in (-0.3, 0.3)] + [(0.0, 0.0, 2.0), (0.1, -0.2, 5.0)]
saved = sc.frame_current
Ps, pos = [], []
try:
    for f in range(start, end + 1):
        sc.frame_set(f)
        mw = cam.matrix_world.copy()
        A = []
        for x, y, z in grid:
            pw = mw @ Vector((x * z, y * z, -z))
            n = world_to_camera_view(sc, cam, pw)
            u, v = n.x, 1.0 - n.y
            X = [pw.x, pw.y, pw.z, 1.0]
            A.append([*X, 0, 0, 0, 0, *[-u * c for c in X]])
            A.append([0, 0, 0, 0, *X, *[-v * c for c in X]])
        P = np.linalg.svd(np.array(A))[2][-1].reshape(3, 4)
        P /= np.linalg.norm(P[2, :3])
        if P[2] @ [*(mw @ Vector((0, 0, -1))), 1.0] < 0:
            P = -P  # SVD sign is arbitrary: make points in front of the camera have positive depth
        Ps.append(P.tolist())
        pos.append(list(mw.translation))
finally:
    sc.frame_set(saved)
return {"path": path, "is_sequence": is_seq, "first": first, "offset": offset, "start": start, "end": end,
        "seed": seed, "camera": cam.name, "P": Ps, "cam_pos": pos}
`,
                    { ...args, pickMode },
                    { timeoutMs: 300_000 }
                );
                if (!existsSync(cam.path)) throw new Error(`Footage not found: ${cam.path}`);

                const ffprobe = findTool("ffprobe");
                const ffmpeg = findTool("ffmpeg");
                const work = await mkdtemp(join(tmpdir(), "blender-mcp-solve-"));
                try {
                    // Footage input: a movie, or an image sequence turned into an ffmpeg pattern.
                    let input: string[];
                    if (cam.is_sequence) {
                        const name = basename(cam.path);
                        const m = /(\d+)(\.[^.]+)$/.exec(name);
                        if (!m) throw new Error(`Cannot find the frame number in ${name}`);
                        const prefix = name.slice(0, m.index);
                        const nums = readdirSync(dirname(cam.path))
                            .filter((f) => f.startsWith(prefix) && f.endsWith(m[2]) && /^\d+$/.test(f.slice(prefix.length, -m[2].length)))
                            .map((f) => Number(f.slice(prefix.length, -m[2].length)));
                        const pattern = join(dirname(cam.path), `${prefix}%0${m[1].length}d${m[2]}`);
                        input = ["-start_number", String(Math.min(...nums)), "-i", pattern];
                    } else {
                        input = ["-i", cam.path];
                    }
                    const probe = await execFileAsync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", ...input.slice(-1)]);
                    const [fw, fh] = probe.stdout.trim().split(",").map(Number);
                    const W = Math.min(args.workWidth, fw);
                    const H = Math.round((W * fh) / fw / 2) * 2;
                    const s = W / fw;

                    // Blender shows clip frame (scene frame - clip start + offset), 0-based here.
                    const n0 = cam.start - cam.first + cam.offset;
                    const n1 = cam.end - cam.first + cam.offset;
                    if (n0 < 0) throw new Error(`Frame ${cam.start} is before the footage starts (scene frame ${cam.first - cam.offset})`);
                    const framesPath = join(work, "frames.gray");
                    await execFileAsync(
                        ffmpeg,
                        ["-v", "error", ...input, "-vf", `select='between(n\\,${n0}\\,${n1})',scale=${W}:${H}:flags=area,format=gray`, "-fps_mode", "passthrough", "-f", "rawvideo", "-y", framesPath],
                        { maxBuffer: 1 << 26, timeout: 600_000 }
                    );
                    const got = (await readFile(framesPath)).length / (W * H);
                    const N = Math.min(Math.floor(got), cam.P.length);
                    const seedIdx = cam.seed - cam.start;
                    if (seedIdx >= N) throw new Error(`The footage ends before the seed frame (got ${N} of ${cam.P.length} frames)`);

                    const scaleP = (P: number[][]) => [P[0].map((v) => v * W), P[1].map((v) => v * H), P[2]];
                    const toWork = (p: number[]) => p.map((v) => v * s);
                    const overlay = join(tmpdir(), "blender-mcp", `solve-${Date.now()}.png`);
                    await execFileAsync("mkdir", ["-p", dirname(overlay)]);
                    const cfg = {
                        frames: framesPath,
                        W,
                        H,
                        N,
                        P: cam.P.slice(0, N).map(scaleP),
                        seed_idx: seedIdx,
                        seeds: args.points ? Object.fromEntries(Object.entries(args.points).map(([k, v]) => [k, toWork(v)])) : {},
                        regions: args.floorRegions ? args.floorRegions.map(toWork) : null,
                        frame0: cam.start,
                        floor_points: args.floorPoints ?? [],
                        cam_pos: cam.cam_pos[seedIdx],
                        overlay,
                        grid_step: pickMode ? 200 * s : null,
                        to_full: 1 / s
                    };
                    const inPath = join(work, "in.json");
                    const outPath = join(work, "out.json");
                    await writeFile(inPath, JSON.stringify(cfg));
                    await execFileAsync(blenderPython(), ["-I", SOLVE_SCRIPT, inPath, outPath], { timeout: 900_000, maxBuffer: 1 << 24 });
                    const solved = JSON.parse(await readFile(outPath, "utf8")) as {
                        points: Record<string, { ok: boolean; xyz?: number[]; err_px?: number; seed_snapped?: number[] }>;
                        floor: { ok?: boolean; center?: number[]; normal?: number[]; extent?: number } | null;
                        overlays?: string[];
                    };
                    const overlays = solved.overlays ?? [overlay];
                    delete solved.overlays;
                    for (const p of Object.values(solved.points)) if (p.seed_snapped) p.seed_snapped = p.seed_snapped.map((v) => Math.round(v / s));

                    const result: Record<string, unknown> = {
                        camera: cam.camera,
                        footage: cam.path,
                        frames: [cam.start, cam.start + N - 1],
                        seedFrame: cam.seed,
                        footageSize: [fw, fh],
                        workSize: [W, H],
                        ...(pickMode ? { note: "Pick mode: read full-res pixel coordinates off the grid (lines every 200 px, brighter every 1000), then call again with points and/or floorRegions." } : solved),
                        images: overlays
                    };
                    if (!pickMode && args.create) {
                        result.created = await runPython(
                            `
coll = bpy.data.collections.get(args["collection"])
if coll is None:
    coll = bpy.data.collections.new(args["collection"])
    scene().collection.children.link(coll)
def put(name, data):
    o = bpy.data.objects.get(name)
    if o is None:
        o = bpy.data.objects.new(name, data)
    if not o.users_collection:
        coll.objects.link(o)
    return o
made = []
fl = args["floor"]
size = (fl["extent"] if fl and fl.get("ok") else 1.0)
for name, p in args["points"].items():
    if not p.get("ok"):
        continue
    o = put(f"Solved {name}", None)
    o.empty_display_type = "PLAIN_AXES"
    o.empty_display_size = size * 0.08
    o.location = p["xyz"]
    made.append(o.name)
if fl and fl.get("ok"):
    n = Vector(fl["normal"])
    name = "Solved Floor"
    o = bpy.data.objects.get(name)
    me = bpy.data.meshes.new(name)
    half = fl["extent"] * 1.5
    me.from_pydata([(-half, -half, 0), (half, -half, 0), (half, half, 0), (-half, half, 0)], [], [(0, 1, 2, 3)])
    if o is None:
        o = put(name, me)
    else:
        old = o.data
        o.data = me
        if old.users == 0:
            bpy.data.meshes.remove(old)
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(n)
    o.location = fl["center"]
    if args["shadowCatcher"]:
        o.is_shadow_catcher = True
    made.append(o.name)
return made
`,
                            { collection: args.collection, points: solved.points, floor: solved.floor, shadowCatcher: args.floorShadowCatcher },
                            { undo: "MCP: triangulate points" }
                        );
                    }
                    return result;
                } finally {
                    // BLENDER_MCP_KEEP_SOLVE=1 keeps frames.gray + in.json for debugging track_solve.py by hand.
                    if (!process.env.BLENDER_MCP_KEEP_SOLVE) await rm(work, { recursive: true, force: true });
                }
            })
    );
}
