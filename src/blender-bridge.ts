import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_PATH = join(__dirname, "blender-scripts", "lib.py");

const HOST = "127.0.0.1";
const PORT = Number(process.env.BLENDER_MCP_PORT || 9877);
const DEFAULT_TIMEOUT_MS = 60_000;

export type BlenderBridgeErrorKind = "BLENDER_NOT_RUNNING" | "SOCKET_ERROR" | "TIMEOUT" | "INVALID_RESPONSE" | "PYTHON_ERROR";

export class BlenderBridgeError extends Error {
    readonly kind: BlenderBridgeErrorKind;
    readonly line?: number | null;
    readonly pyTraceback?: string | null;

    constructor(message: string, kind: BlenderBridgeErrorKind, extra?: { line?: number | null; traceback?: string | null }) {
        super(message);
        this.name = "BlenderBridgeError";
        this.kind = kind;
        this.line = extra?.line ?? null;
        this.pyTraceback = extra?.traceback ?? null;
    }
}

interface Envelope<T> {
    ok: boolean;
    data?: T;
    error?: { message: string; traceback?: string; line?: number | null };
}

let cachedLib: string | null = null;
function loadLib(): string {
    if (cachedLib === null) cachedLib = readFileSync(LIB_PATH, "utf8");
    return cachedLib;
}

function request<T>(payload: object, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ host: HOST, port: PORT });
        let buf = "";
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            fn();
        };
        const timer = setTimeout(
            () =>
                finish(() =>
                    reject(
                        new BlenderBridgeError(
                            `Blender did not answer within ${timeoutMs}ms. It may be busy (rendering, baking, a modal dialog) -- check the Blender window.`,
                            "TIMEOUT"
                        )
                    )
                ),
            timeoutMs
        );

        socket.setEncoding("utf8");
        socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
        socket.on("data", (chunk: string) => {
            buf += chunk;
            if (!buf.endsWith("\n")) return;
            finish(() => {
                let parsed: Envelope<T>;
                try {
                    parsed = JSON.parse(buf);
                } catch {
                    return reject(new BlenderBridgeError(`Blender sent a non-JSON reply: ${buf.slice(0, 500)}`, "INVALID_RESPONSE"));
                }
                if (!parsed.ok) {
                    return reject(
                        new BlenderBridgeError(parsed.error?.message ?? "Unknown Python error", "PYTHON_ERROR", {
                            line: parsed.error?.line,
                            traceback: parsed.error?.traceback
                        })
                    );
                }
                resolve(parsed.data as T);
            });
        });
        socket.on("error", (err: NodeJS.ErrnoException) =>
            finish(() =>
                reject(
                    err.code === "ECONNREFUSED"
                        ? new BlenderBridgeError(
                              `Blender is not reachable on ${HOST}:${PORT}. Open Blender (launch_blender can do it) and make sure the "MCP Bridge" add-on is enabled -- its panel is in the 3D View sidebar (N) > MCP.`,
                              "BLENDER_NOT_RUNNING"
                          )
                        : new BlenderBridgeError(`Socket error: ${err.message}`, "SOCKET_ERROR")
                )
            )
        );
        socket.on("end", () =>
            finish(() => reject(new BlenderBridgeError("Blender closed the connection without replying.", "INVALID_RESPONSE")))
        );
    });
}

export interface RunOptions {
    /** Label for a Blender undo step pushed after the body succeeds; omit for read-only calls. */
    undo?: string;
    timeoutMs?: number;
}

/**
 * Runs a Python function body (may use `return`) on Blender's main thread with the shared
 * lib.py helpers in scope. `args` arrives as a plain dict named `args` -- pass data this way
 * instead of splicing it into the source, so no escaping is ever needed.
 */
export async function runPython<T>(body: string, args: Record<string, unknown> = {}, opts: RunOptions = {}): Promise<T> {
    return request<T>({ lib: loadLib(), body, args, undo: opts.undo ?? null }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/** Cheap reachability check that does not touch the main thread. */
export async function pingBlender(timeoutMs = 2_000): Promise<{ blender: string; file: string }> {
    return request({ ping: true }, timeoutMs);
}
