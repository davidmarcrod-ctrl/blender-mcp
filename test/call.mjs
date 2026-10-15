// Minimal MCP stdio client for manual testing: node test/call.mjs '<tool>' '<json args>' [...more pairs]
// FULL=1 prints whole text results (default: first 2500 chars).
import { spawn } from "node:child_process";
const srv = spawn("node", [new URL("../dist/index.js", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "", id = 0;
const pending = new Map();
srv.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
});
const rpc = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const argv = process.argv.slice(2);
if (argv[0] === "--list") {
    const r = await rpc("tools/list", {});
    console.log(r.result.tools.map((t) => t.name).join("\n"));
} else for (let k = 0; k < argv.length; k += 2) {
    if (argv[k] === "__sleep") { await new Promise((s) => setTimeout(s, Number(argv[k + 1]))); continue; }
    if (argv[k + 1]?.includes("$JOB")) argv[k + 1] = argv[k + 1].replace("$JOB", globalThis.JOB);
    const r = await rpc("tools/call", { name: argv[k], arguments: JSON.parse(argv[k + 1] || "{}") });
    console.log(`=== ${argv[k]} ${r.result?.isError ? "ERROR" : "ok"}`);
    if (r.error) console.log(JSON.stringify(r.error));
    try { const j = JSON.parse(r.result.content[0].text); if (j.jobId) globalThis.JOB = j.jobId; } catch {}
    for (const c of r.result?.content ?? []) console.log(c.type === "text" ? (process.env.FULL ? c.text : c.text.slice(0, 2500)) : `[image ${c.mimeType} ${c.data.length} b64 chars]`);
}
srv.kill();
