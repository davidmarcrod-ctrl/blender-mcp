import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Background jobs (renders, simulation bakes) run in separate Blender processes.
 *
 * Their state is mirrored to ~/.blender-mcp/jobs/<server pid>.json so the MCP Bridge add-on
 * can show progress in Blender's sidebar. The add-on asks to cancel a job by creating
 * ~/.blender-mcp/cancel/<jobId>; the server polls for it.
 */
export const STATE_DIR = join(homedir(), ".blender-mcp");
const JOBS_DIR = join(STATE_DIR, "jobs");
const CANCEL_DIR = join(STATE_DIR, "cancel");
const STATE_FILE = join(JOBS_DIR, `${process.pid}.json`);

/** Written next to a per-element render (render_animation) so import_render_to_ae can find the elements later. */
export const ELEMENTS_FILE = "mcp_elements.json";

export type JobStatus = "running" | "finished" | "failed" | "cancelled";

interface JobBase {
    id: string;
    status: JobStatus;
    /** The user's .blend the job was started from. */
    file: string;
    blendCopy: string;
    scene: string;
    frameStart: number;
    frameEnd: number;
    currentFrame: number | null;
    framesDone: number;
    /** Human-readable step, e.g. "particles" or "Confeti_emisor: fluid". */
    stage: string | null;
    startedAt: string;
    finishedAt?: string;
    exitCode?: number | null;
    logTail: string[];
    kill?: () => void;
}

export interface RenderJob extends JobBase {
    kind: "render";
    savedFiles: string[];
    outputDir: string;
    passesDir: string | null;
    /** setup_element_layers output: one folder per element, nearest to the camera first. */
    elements: { name: string; dir: string; depth: number | null }[] | null;
    /** "shared": every element's shadow catcher pass holds all the shadows (use one); "per_element": each its own. */
    elementShadows: "shared" | "per_element" | "none" | null;
    fps: number;
    width: number;
    height: number;
}

export interface BakeJob extends JobBase {
    kind: "bake";
    /** What the bake script reported it baked (caches, domains, modifiers). */
    baked: unknown[];
    /** Whether the baked file has been loaded into the user's Blender, or why not. */
    applied: boolean | string;
}

export type Job = RenderJob | BakeJob;

export const jobs = new Map<string, Job>();

export function publicJob(job: Job) {
    const { kill: _kill, ...rest } = job;
    const total = job.frameEnd - job.frameStart + 1;
    const base = { ...rest, progress: `${job.framesDone}/${total}` };
    if (job.kind === "render") return { ...base, savedFiles: job.savedFiles.slice(-10), savedCount: job.savedFiles.length };
    return base;
}

let writeTimer: NodeJS.Timeout | null = null;

/** Schedules a write of the state file (debounced). Call after any job change. */
export function touchJobs(): void {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
        writeTimer = null;
        writeState();
    }, 300);
}

function writeState(): void {
    try {
        mkdirSync(JOBS_DIR, { recursive: true });
        const list = [...jobs.values()].map((j) => ({
            id: j.id,
            kind: j.kind,
            status: j.status,
            file: j.file,
            scene: j.scene,
            frameStart: j.frameStart,
            frameEnd: j.frameEnd,
            framesDone: j.framesDone,
            currentFrame: j.currentFrame,
            stage: j.stage,
            startedAt: j.startedAt,
            finishedAt: j.finishedAt ?? null,
            applied: j.kind === "bake" ? j.applied : null
        }));
        const tmp = STATE_FILE + ".tmp";
        writeFileSync(tmp, JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString(), jobs: list }));
        renameSync(tmp, STATE_FILE);
    } catch {
        /* the panel is a convenience: never fail a tool over it */
    }
}

process.on("exit", () => {
    try {
        unlinkSync(STATE_FILE);
    } catch {
        /* already gone */
    }
});

// Cancel requests from the Blender panel.
setInterval(() => {
    for (const job of jobs.values()) {
        if (job.status !== "running") continue;
        const flag = join(CANCEL_DIR, job.id);
        if (!existsSync(flag)) continue;
        rmSync(flag, { force: true });
        cancelJob(job);
    }
}, 1000).unref();

export function cancelJob(job: Job): void {
    if (job.status !== "running") return;
    job.status = "cancelled";
    job.kill?.();
    touchJobs();
}

/**
 * Starts a background Blender process for a job and feeds its output, line by line,
 * to onLine. onClose runs after the process exits and the job status is set.
 */
export function runJobProcess(job: Job, bin: string, args: string[], onLine: (line: string) => void, onClose: (code: number | null) => void | Promise<void>): void {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    job.kill = () => child.kill("SIGTERM");
    let pending = "";
    const feed = (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) continue;
            job.logTail.push(line);
            if (job.logTail.length > 30) job.logTail.shift();
            onLine(line);
        }
        touchJobs();
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("close", async (code) => {
        if (job.status === "running") job.status = code === 0 ? "finished" : "failed";
        job.exitCode = code;
        job.finishedAt = new Date().toISOString();
        try {
            await onClose(code);
        } finally {
            touchJobs();
        }
    });
    jobs.set(job.id, job);
    touchJobs();
}
