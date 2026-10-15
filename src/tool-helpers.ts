import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { BlenderBridgeError } from "./blender-bridge.js";
import { AEBridgeError } from "./ae/ae-bridge.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/**
 * Successful tool result: pretty-printed JSON. If the data carries an `images` array of
 * local file paths (preview renders, viewport captures), they are attached as image
 * content so the model can actually look at them.
 */
export async function ok(data: unknown) {
    const content: Content[] = [];
    if (data && typeof data === "object" && Array.isArray((data as { images?: unknown }).images)) {
        for (const path of (data as { images: string[] }).images) {
            const mimeType = MIME[extname(path).toLowerCase()];
            if (!mimeType) continue;
            content.push({ type: "image", data: (await readFile(path)).toString("base64"), mimeType });
        }
    }
    content.unshift({ type: "text", text: JSON.stringify(data, null, 2) });
    return { content };
}

function errorResult(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Wraps a tool body so bridge failures (Blender/AE not running, Python or ExtendScript
 * errors) come back as isError results with the app-side message, line and traceback.
 */
export async function runTool<T>(fn: () => Promise<T>) {
    try {
        return await ok(await fn());
    } catch (err) {
        if (err instanceof BlenderBridgeError) {
            const location = err.line ? ` (body line ${err.line})` : "";
            const tb = err.pyTraceback ? `\n\n${err.pyTraceback}` : "";
            return errorResult(`[${err.kind}] ${err.message}${location}${tb}`);
        }
        if (err instanceof AEBridgeError) {
            const location = err.line !== null && err.line !== undefined ? ` (line ${err.line})` : "";
            return errorResult(`[AE:${err.kind}] ${err.message}${location}`);
        }
        return errorResult(err instanceof Error ? err.message : String(err));
    }
}
