import { z } from "zod";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import { runPython } from "../blender-bridge.js";
import { runTool } from "../tool-helpers.js";
import { BLENDER_BIN } from "./file.js";
import { publicJob, runJobProcess, touchJobs, type BakeJob } from "../jobs.js";

const BAKE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "blender-scripts", "bake_job.py");

/** <dir>/blendcache_<stem>: where Blender keeps disk point caches for <dir>/<stem>.blend. */
function blendcacheDir(blend: string): string {
    return join(dirname(blend), "blendcache_" + blend.split("/").pop()!.replace(/\.blend$/, ""));
}

/** Deletes the snapshot and the .blend1 backup Blender wrote when the bake saved it. */
async function removeSnapshot(copy: string): Promise<void> {
    await unlink(copy).catch(() => {});
    await unlink(copy + "1").catch(() => {});
}

/**
 * Loads a finished bake into the user's Blender: opens the baked snapshot and saves it over the
 * original file. Refuses (unless discardChanges) if the file changed since the bake started.
 */
export async function applyBake(job: BakeJob, discardChanges: boolean): Promise<void> {
    const res = await runPython<{ applied: boolean; reason?: string }>(
        `
import os
if bpy.data.filepath != args["file"]:
    return {"applied": False, "reason": f"Blender now has another file open ({bpy.data.filepath or 'unsaved'}); open {args['file']} first."}
changed = bpy.data.is_dirty or os.path.getmtime(args["file"]) > args["savedAt"] + 1
if changed and not args["discard"]:
    return {"applied": False, "reason": "The file changed in Blender after the bake started. Loading the bake would lose those changes: "
            "ask the user, then call get_render_status with apply=true and discardChanges=true (or bake again)."}
bpy.ops.wm.open_mainfile(filepath=args["copy"])
bpy.ops.wm.save_as_mainfile(filepath=args["file"])
return {"applied": True}
`,
        { file: job.file, copy: job.blendCopy, savedAt: Date.parse(job.startedAt) / 1000, discard: discardChanges },
        { timeoutMs: 300_000 }
    );
    if (!res.applied) {
        job.applied = res.reason ?? "not applied";
        touchJobs();
        return;
    }
    // Disk point caches were written next to the snapshot, under its name: hand them to the original file.
    const snapCache = blendcacheDir(job.blendCopy);
    if (existsSync(snapCache)) {
        await cp(snapCache, blendcacheDir(job.file), { recursive: true, force: true });
        await rm(snapCache, { recursive: true, force: true });
    }
    await removeSnapshot(job.blendCopy);
    job.applied = true;
    touchJobs();
}

export function registerBakeTools(server: McpServer): void {
    server.registerTool(
        "bake_simulation",
        {
            title: "Bake simulations (background)",
            description:
                "Bakes simulations (particles, cloth, soft body, rigid body, dynamic paint, Mantaflow fluids, Geometry Nodes simulation zones) in a separate background Blender, so the user's Blender stays usable. Baking = computing the simulation once and storing it, so playback and renders are fixed and repeatable. It SAVES the user's file first (confirm with the user if it has unsaved changes), bakes a snapshot next to it, and when done loads the baked file back into Blender (only if the file was not touched meanwhile; otherwise get_render_status shows why and accepts apply=true). Point caches are fully re-simulated (free + bake all), with their frame range set to the bake range. Returns a jobId; poll with get_render_status. Progress also shows in Blender's sidebar (N) > MCP.",
            inputSchema: z.object({
                frameStart: z.number().int().optional().describe("Default: scene start."),
                frameEnd: z.number().int().optional().describe("Default: scene end."),
                pointCaches: z.boolean().default(true).describe("Particles, cloth, soft body, rigid body world, dynamic paint."),
                fluids: z.boolean().default(true).describe("Mantaflow domains (cache on disk, in the domain's cache directory)."),
                geometryNodes: z.boolean().default(true).describe("Geometry Nodes simulation zones."),
                applyWhenDone: z.boolean().default(true).describe("Load the baked file into Blender when the bake finishes.")
            })
        },
        async (args) =>
            runTool(async () => {
                const info = await runPython<{ file: string; copy: string; scene: string; start: number; end: number; sims: string[] }>(
                    `
import os
if not bpy.data.filepath:
    raise RuntimeError("Save the .blend first: the bake works from a snapshot next to it.")
sc = scene()
sims = []
for o in sc.objects:
    for m in o.modifiers:
        if m.type in ("PARTICLE_SYSTEM", "CLOTH", "SOFT_BODY", "DYNAMIC_PAINT") or (m.type == "FLUID" and m.fluid_type == "DOMAIN"):
            sims.append(f"{o.name} > {m.name} ({m.type.lower()})")
        elif m.type == "NODES" and m.node_group and any(n.bl_idname == "GeometryNodeSimulationOutput" for n in m.node_group.nodes):
            sims.append(f"{o.name} > {m.name} (geometry nodes)")
if sc.rigidbody_world and sc.rigidbody_world.enabled:
    sims.append("Rigid Body World")
if not sims:
    raise RuntimeError("Nothing to bake: no particles, cloth, soft body, rigid body, dynamic paint, fluid domain or simulation zone in this scene.")
bpy.ops.wm.save_mainfile()
stem, _ = os.path.splitext(bpy.data.filepath)
copy = stem + ".mcp_bake.blend"
bpy.ops.wm.save_as_mainfile(filepath=copy, copy=True)
return {"file": bpy.data.filepath, "copy": copy, "scene": sc.name, "sims": sims,
        "start": args.get("frameStart") if args.get("frameStart") is not None else sc.frame_start,
        "end": args.get("frameEnd") if args.get("frameEnd") is not None else sc.frame_end}
`,
                    args
                );
                const job: BakeJob = {
                    id: randomUUID().slice(0, 8),
                    kind: "bake",
                    status: "running",
                    file: info.file,
                    blendCopy: info.copy,
                    scene: info.scene,
                    frameStart: info.start,
                    frameEnd: info.end,
                    currentFrame: null,
                    framesDone: 0,
                    stage: "starting",
                    startedAt: new Date().toISOString(),
                    logTail: [],
                    baked: [],
                    applied: false
                };
                const scriptArgs = JSON.stringify({
                    scene: info.scene,
                    frameStart: info.start,
                    frameEnd: info.end,
                    pointCaches: args.pointCaches,
                    fluids: args.fluids,
                    geometryNodes: args.geometryNodes,
                    origStem: info.file.split("/").pop()!.replace(/\.blend$/, "")
                });
                runJobProcess(
                    job,
                    BLENDER_BIN,
                    ["-b", info.copy, "--python-exit-code", "1", "--python", BAKE_SCRIPT, "--", scriptArgs],
                    (line) => {
                        const st = /^MCP_STAGE (.+)/.exec(line);
                        if (st) {
                            job.stage = st[1];
                            job.framesDone = 0;
                            job.currentFrame = null;
                        }
                        const fr = /bake: frame (\d+) :: (\d+)/.exec(line);
                        if (fr) {
                            job.currentFrame = Number(fr[1]);
                            job.framesDone = Math.max(0, job.currentFrame - job.frameStart + 1);
                        }
                        const res = /^MCP_RESULT (.+)/.exec(line);
                        if (res) job.baked = JSON.parse(res[1]).baked;
                    },
                    async () => {
                        if (job.status !== "finished") {
                            await removeSnapshot(job.blendCopy);
                            await rm(blendcacheDir(job.blendCopy), { recursive: true, force: true });
                            return;
                        }
                        job.stage = "done";
                        job.framesDone = job.frameEnd - job.frameStart + 1;
                        if (!args.applyWhenDone) {
                            job.applied = "applyWhenDone=false: call get_render_status with apply=true to load it";
                            return;
                        }
                        try {
                            await applyBake(job, false);
                        } catch (err) {
                            job.applied = `could not load the bake: ${err instanceof Error ? err.message : String(err)}`;
                        }
                    }
                );
                return { jobId: job.id, simulations: info.sims, ...publicJob(job) };
            })
    );
}
