import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { jsxLiteral } from "./jsx-literal.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_PATH = join(__dirname, "lib.jsx");

let cachedLib: string | null = null;

function loadLib(): string {
    if (cachedLib === null) {
        cachedLib = readFileSync(LIB_PATH, "utf8");
    }
    return cachedLib;
}

/**
 * Wraps a tool-specific ExtendScript body (a snippet ending in `return <value>;`)
 * with the shared lib.jsx helpers and a try/catch -> JSON envelope. The result
 * is written to `outputPath` from *inside* ExtendScript (rather than relied on
 * as the DoScriptFile AppleEvent reply) because that reply does not reliably
 * carry the script's return value back through osascript on this AE version --
 * empirically it comes back as a generic status value regardless of what the
 * script returns. The bridge reads outputPath back afterward instead.
 */
export function buildScript(bodyExpression: string, outputPath: string): string {
    const lib = loadLib();
    return `${lib}
(function () {
    var __envelope;
    try {
        var __result = (function () {
${bodyExpression}
        })();
        __envelope = JSON.stringify({ ok: true, data: __result });
    } catch (e) {
        __envelope = JSON.stringify({
            ok: false,
            error: {
                message: e && e.toString ? e.toString() : String(e),
                line: (e && e.line !== undefined) ? e.line : null,
                fileName: (e && e.fileName !== undefined) ? e.fileName : null
            }
        });
    }
    var __outFile = new File(${jsxLiteral(outputPath)});
    __outFile.encoding = "UTF-8";
    __outFile.open("w");
    __outFile.write(__envelope);
    __outFile.close();
})();
`;
}

/** Same as buildScript, but wraps the body in an AE undo group (used by run_script). */
export function buildScriptWithUndoGroup(bodyExpression: string, undoGroupName: string, outputPath: string): string {
    const wrapped = `
            app.beginUndoGroup(${jsxLiteral(undoGroupName)});
            try {
${bodyExpression}
            } finally {
                app.endUndoGroup();
            }
`;
    return buildScript(wrapped, outputPath);
}
