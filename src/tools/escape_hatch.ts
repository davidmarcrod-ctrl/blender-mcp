import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { runPython } from "../blender-bridge.js";
import { runTool } from "../tool-helpers.js";

export function registerEscapeHatchTool(server: McpServer): void {
    server.registerTool(
        "run_python",
        {
            title: "Run Python (escape hatch)",
            description:
                "Runs arbitrary Python inside the user's Blender on the main thread, with full bpy access and NO sandboxing -- it can modify or delete scene data and read/write files. Use only when the structured tools cannot express the task (geometry nodes, modifiers, drivers, F-curve modifiers, constraints, compositor, etc.). The code is a function body: use `return <value>` to send a JSON-serializable result back (mathutils values and datablocks are converted automatically). `bpy`, `math`, `Matrix`, `Vector`, `Euler` and the helpers get_object(name), scene(), summarize(obj), fcurves_for(id), render_size(), fps() are in scope; anything passed in `args` is available as the dict `args`. Write idempotent code (safe to run twice). One Blender undo step is pushed per call.",
            inputSchema: z.object({
                code: z.string().describe("Python function body. May use `return`."),
                args: z.record(z.string(), z.unknown()).optional().describe("Data passed to the code as `args` (avoids string escaping)."),
                timeoutSeconds: z.number().positive().max(3600).default(60)
            })
        },
        async ({ code, args, timeoutSeconds }) =>
            runTool(() => runPython(code, args ?? {}, { undo: "MCP: run_python", timeoutMs: timeoutSeconds * 1000 }))
    );
}
