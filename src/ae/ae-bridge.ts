import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildScript, buildScriptWithUndoGroup } from "./ae-script-builder.js";

const execFileAsync = promisify(execFile);

// Override with AE_MCP_APP_NAME if your machine has a different AE version
// installed (e.g. "Adobe After Effects 2025") -- this must match the app's
// exact name as macOS sees it (the .app bundle name in /Applications).
const AE_APP_NAME = process.env.AE_MCP_APP_NAME || "Adobe After Effects 2026";
const DEFAULT_TIMEOUT_MS = 30_000;
const KEEP_TEMP = process.env.AE_MCP_KEEP_TEMP === "1";
// After the osascript call returns, how long to wait for the result file to
// show up before giving up. Execution is expected to be synchronous within
// AE's main thread, so this only guards against a tiny filesystem-visibility
// race, not a real wait for AE to finish working.
const RESULT_FILE_POLL_MS = 100;
const RESULT_FILE_MAX_WAIT_MS = 3_000;

export type AEBridgeErrorKind =
    | "AE_NOT_RUNNING"
    | "OSASCRIPT_FAILED"
    | "NO_RESULT_FILE"
    | "INVALID_JSON_RESPONSE"
    | "EXTENDSCRIPT_ERROR";

export class AEBridgeError extends Error {
    readonly kind: AEBridgeErrorKind;
    readonly line?: number | null;
    readonly fileName?: string | null;

    constructor(message: string, kind: AEBridgeErrorKind, extra?: { line?: number | null; fileName?: string | null }) {
        super(message);
        this.name = "AEBridgeError";
        this.kind = kind;
        this.line = extra?.line ?? null;
        this.fileName = extra?.fileName ?? null;
    }
}

interface ScriptEnvelope<T> {
    ok: boolean;
    data?: T;
    error?: { message: string; line: number | null; fileName: string | null };
}

/** AppleScript string-literal escaping for our own controlled temp path. */
function escapeAppleScriptString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function isAERunning(): Promise<boolean> {
    // "application X is running" is a boolean predicate and does NOT launch the app,
    // unlike a bare `tell application "X" to ...` which auto-launches it.
    const { stdout } = await execFileAsync("osascript", [
        "-e",
        `application "${escapeAppleScriptString(AE_APP_NAME)}" is running`
    ]);
    return stdout.trim() === "true";
}

async function runScriptFile(tmpPath: string, timeoutMs: number): Promise<void> {
    const appleScript = `tell application "${escapeAppleScriptString(AE_APP_NAME)}" to DoScriptFile "${escapeAppleScriptString(tmpPath)}"`;
    try {
        await execFileAsync("osascript", ["-e", appleScript], {
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024
        });
    } catch (err: unknown) {
        const e = err as { killed?: boolean; code?: unknown; stderr?: string; message?: string };
        if (e.killed) {
            throw new AEBridgeError(
                `After Effects did not respond within ${timeoutMs}ms (osascript call timed out). ` +
                    `This usually means a native AE dialog (e.g. a syntax-error alert, or a "Save changes?" prompt) is blocking it -- check the AE window.`,
                "OSASCRIPT_FAILED"
            );
        }
        throw new AEBridgeError(`osascript failed: ${e.stderr || e.message || String(err)}`, "OSASCRIPT_FAILED");
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResultFile(outPath: string): Promise<string> {
    const deadline = Date.now() + RESULT_FILE_MAX_WAIT_MS;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            return await readFile(outPath, "utf8");
        } catch {
            if (Date.now() >= deadline) {
                throw new AEBridgeError(
                    "After Effects did not produce a result file. The script likely failed before it could run " +
                        "(e.g. a dialog is blocking AE, or After Effects has no project open) -- check the AE window.",
                    "NO_RESULT_FILE"
                );
            }
            await sleep(RESULT_FILE_POLL_MS);
        }
    }
}

async function runBody<T>(buildFn: (outputPath: string) => string, timeoutMs: number): Promise<T> {
    if (!(await isAERunning())) {
        throw new AEBridgeError(
            `${AE_APP_NAME} is not running. Please launch it and open a project, then try again.`,
            "AE_NOT_RUNNING"
        );
    }

    const id = randomUUID();
    const scriptPath = join(tmpdir(), `blender-mcp-ae-${id}.jsx`);
    const outPath = join(tmpdir(), `blender-mcp-ae-${id}.json`);
    const script = buildFn(outPath);
    await writeFile(scriptPath, script, "utf8");

    try {
        await runScriptFile(scriptPath, timeoutMs);

        const raw = await readResultFile(outPath);
        let parsed: ScriptEnvelope<T>;
        try {
            parsed = JSON.parse(raw.trim());
        } catch {
            throw new AEBridgeError(
                `After Effects wrote a non-JSON result: ${raw.slice(0, 500)}`,
                "INVALID_JSON_RESPONSE"
            );
        }

        if (!parsed.ok) {
            throw new AEBridgeError(
                parsed.error?.message ?? "Unknown ExtendScript error",
                "EXTENDSCRIPT_ERROR",
                { line: parsed.error?.line, fileName: parsed.error?.fileName }
            );
        }
        return parsed.data as T;
    } finally {
        if (!KEEP_TEMP) {
            await unlink(scriptPath).catch(() => {});
            await unlink(outPath).catch(() => {});
        }
    }
}

/**
 * Runs an ExtendScript body (a snippet ending in `return <value>;`) against the
 * running After Effects instance and returns its JSON-decoded result.
 * Throws AEBridgeError on any failure (AE not running, osascript failure,
 * missing/malformed result, or an error thrown inside the ExtendScript itself).
 */
export async function runExtendScript<T>(bodyExpression: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
    return runBody<T>((outputPath) => buildScript(bodyExpression, outputPath), timeoutMs);
}

/**
 * Same as runExtendScript, but wraps the body in an AE undo group. Used by the
 * run_script escape hatch so its effects are revertable with a single Cmd+Z.
 */
export async function runExtendScriptInUndoGroup<T>(
    bodyExpression: string,
    undoGroupName: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
    return runBody<T>((outputPath) => buildScriptWithUndoGroup(bodyExpression, undoGroupName, outputPath), timeoutMs);
}
