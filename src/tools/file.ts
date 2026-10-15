import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import { pingBlender, runPython } from "../blender-bridge.js";
import { runTool } from "../tool-helpers.js";

export const BLENDER_APP = process.env.BLENDER_MCP_APP || "/Applications/Blender.app";
export const BLENDER_BIN = process.env.BLENDER_MCP_BIN || `${BLENDER_APP}/Contents/MacOS/Blender`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerFileTools(server: McpServer): void {
    server.registerTool(
        "bridge_status",
        {
            title: "Bridge status",
            description: "Checks whether Blender is reachable through the MCP Bridge add-on and which file it has open. Does not wait for Blender's main thread.",
            inputSchema: z.object({})
        },
        async () => runTool(() => pingBlender())
    );

    server.registerTool(
        "launch_blender",
        {
            title: "Launch Blender",
            description:
                "Opens Blender (optionally with a .blend file) and waits until the MCP Bridge answers. Does nothing if Blender is already reachable -- use open_file to switch files in a running Blender.",
            inputSchema: z.object({
                file: z.string().optional().describe("Absolute path to a .blend file."),
                waitSeconds: z.number().positive().max(180).default(60)
            })
        },
        async ({ file, waitSeconds }) =>
            runTool(async () => {
                try {
                    const info = await pingBlender();
                    return { alreadyRunning: true, ...info };
                } catch {
                    /* not running: launch below */
                }
                if (file && !existsSync(file)) throw new Error(`File not found: ${file}`);
                const args = ["-na", BLENDER_APP, ...(file ? ["--args", file] : [])];
                spawn("open", args, { detached: true, stdio: "ignore" }).unref();
                const deadline = Date.now() + waitSeconds * 1000;
                while (Date.now() < deadline) {
                    await sleep(1000);
                    try {
                        return { launched: true, ...(await pingBlender()) };
                    } catch {
                        /* keep waiting */
                    }
                }
                throw new Error(
                    `Blender started but the MCP Bridge did not answer within ${waitSeconds}s. Check that the "MCP Bridge" add-on is installed and enabled (npm run install-addon).`
                );
            })
    );

    server.registerTool(
        "open_file",
        {
            title: "Open .blend file",
            description:
                "Opens a .blend file in the running Blender. Refuses if the current file has unsaved changes unless discardChanges is true -- ask the user before discarding.",
            inputSchema: z.object({
                path: z.string().describe("Absolute path to the .blend file."),
                discardChanges: z.boolean().default(false)
            })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
import os
if not os.path.isfile(args["path"]):
    raise FileNotFoundError(args["path"])
if bpy.data.is_dirty and not args["discardChanges"]:
    raise RuntimeError(f"Current file {bpy.data.filepath or '(unsaved)'} has unsaved changes. Save it first or pass discardChanges=true.")
bpy.ops.wm.open_mainfile(filepath=args["path"])
return {"file": bpy.data.filepath, "scene": bpy.context.scene.name}
`,
                    args
                )
            )
    );

    server.registerTool(
        "save_file",
        {
            title: "Save .blend file",
            description:
                "Saves the current file, or saves it under a new path. With asCopy, writes a copy and keeps the current file open (useful for versioned snapshots like shot_v03.blend).",
            inputSchema: z.object({
                path: z.string().optional().describe("Absolute path. Omit to save in place."),
                asCopy: z.boolean().default(false)
            })
        },
        async (args) =>
            runTool(() =>
                runPython(
                    `
path = args.get("path")
if path:
    bpy.ops.wm.save_as_mainfile(filepath=path, copy=args["asCopy"])
else:
    if not bpy.data.filepath:
        raise RuntimeError("File has never been saved: pass a path.")
    bpy.ops.wm.save_mainfile()
return {"saved": path or bpy.data.filepath, "current_file": bpy.data.filepath}
`,
                    args
                )
            )
    );
}
