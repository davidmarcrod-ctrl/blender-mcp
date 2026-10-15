import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerFileTools } from "./tools/file.js";
import { registerSceneTools } from "./tools/scene.js";
import { registerAnimationTools } from "./tools/animation.js";
import { registerRenderTools } from "./tools/render.js";
import { registerBakeTools } from "./tools/bake.js";
import { registerSolveTools } from "./tools/solve.js";
import { registerAeLinkTools } from "./tools/ae-link.js";
import { registerEscapeHatchTool } from "./tools/escape_hatch.js";

const server = new McpServer({ name: "blender-mcp", version: "0.1.0" });

registerFileTools(server);
registerSceneTools(server);
registerAnimationTools(server);
registerRenderTools(server);
registerBakeTools(server);
registerSolveTools(server);
registerAeLinkTools(server);
registerEscapeHatchTool(server);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error("blender-mcp fatal startup error:", err);
    process.exit(1);
});
