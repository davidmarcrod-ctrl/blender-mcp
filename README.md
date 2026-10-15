# blender-mcp

An MCP server for driving Blender from an LLM, built for a VFX/motion workflow with After Effects. It covers scene inspection, objects, materials, keyframes, EEVEE previews the model can look at, EXR render passes, background renders, and a two-way camera/null/footage bridge with After Effects, plus a raw Python escape hatch for everything else.

Sister project of [ae-mcp](https://github.com/davidmarcrod-ctrl/ae-mcp). The AE bridge here uses the same osascript → `DoScriptFile` mechanism, so AE needs nothing extra installed.

## How it works

```
Claude ──stdio──> blender-mcp (Node) ──TCP 127.0.0.1:9877──> "MCP Bridge" add-on ──> bpy (main thread)
                                 └──osascript/JSX──> After Effects
```

The add-on (`addon/blender_mcp_bridge`) listens on localhost only. Each request carries a Python function body plus a JSON `args` dict, and the shared helpers in `src/blender-scripts/lib.py`. The body runs on Blender's main thread through a timer, since bpy is not thread-safe. Data always travels in `args` and is never spliced into source, so there is no escaping. The helpers ship with every call, so updating the server never requires reinstalling the add-on. Each mutating call pushes one Blender undo step (Cmd+Z).

## Requirements

- macOS, Blender 4.2+ (tested on 5.2.2 LTS), Node.js 20+.
- For the AE tools: After Effects running with a project open (default app name `Adobe After Effects 2026`; override with `AE_MCP_APP_NAME`).

## Setup

```bash
npm install
npm run build
npm run install-addon   # with Blender CLOSED: links the add-on into Blender's extensions and enables it
```

The add-on auto-starts with Blender. Its panel is in the 3D View sidebar (N) › **MCP**, with Start/Stop and the port.

Register the server in Claude Code (user scope, available in every project):

```bash
claude mcp add --scope user blender-mcp -- node ~/code/blender-mcp/dist/index.js
```

Environment variables: `BLENDER_MCP_PORT` (default 9877), `BLENDER_MCP_APP` (default `/Applications/Blender.app`), `BLENDER_MCP_BIN` (Blender executable used for background renders), `AE_MCP_APP_NAME`.

## Tools

| Tool | Purpose |
|---|---|
| `bridge_status` / `launch_blender` / `open_file` / `save_file` | connection and .blend I/O (`open_file` refuses to discard unsaved changes unless told to) |
| `get_scene_info` / `list_objects` | audit the scene before acting |
| `get_property` / `set_property` | read/write anything by Python path (`bpy.data.objects["Cube"].location`) |
| `create_object` / `delete_objects` | primitives, empties, cameras, lights, text (context-free, via bmesh/bpy.data) |
| `set_material` | Principled BSDF inputs by UI name |
| `set_keyframe` / `get_animation` | keys with interpolation/easing on any property; works with Blender 4.4+/5.x layered actions |
| `set_render_settings` | engine, resolution, fps (incl. 23.976/29.97), range, samples, color management, transparency |
| `preview_render` / `viewport_screenshot` | images returned to the model for look-dev checks (scene settings restored afterwards) |
| `setup_render_passes` | passes + EXR output: `multilayer` (one EXR incl. Cryptomatte) or `separate` (also one EXR sequence per pass via a compositor File Output node) |
| `render_animation` / `get_render_status` | render in a separate background Blender from a snapshot saved next to the .blend; Blender stays usable |
| `export_to_ae` | Blender camera + objects → AE one-node 3D camera + 3D nulls, baked per frame |
| `import_from_ae` | AE camera (incl. two-node/POI, parented, 3D Camera Tracker) + 3D layers → Blender camera, empties and planes (footage planes get the source as texture) |
| `import_render_to_ae` | rendered sequences → AE comp: beauty visible, passes above it switched off with suggested blend modes |
| `run_python` | escape hatch: arbitrary bpy code (geometry nodes, modifiers, drivers, compositor...) |

## Blender ↔ AE conventions

- **Axes:** AE position = (Bx, −Bz, By) × ppm + (w/2, h/2, 0). Blender's world origin lands at the comp centre on AE's z = 0. `ppm` (pixels per metre) defaults to 100. Use the same value in both directions.
- **Rotation:** AE applies Z, then Y, then X (mathutils `'ZYX'`). Cameras and planes get an extra 180° about X, because Blender cameras look down −Z and AE cameras look down +z.
- **Lens:** AE Zoom = focal length / sensor size × frame size along the sensor-fit axis. Lens shift and orthographic cameras cannot be reproduced in AE; `export_to_ae` warns about them.
- **Time:** Blender `frame_start` = AE time 0. New comps get `displayStartFrame` = `frame_start`.
- **Color:** EXR output is scene-linear (Linear Rec.709), not AgX/Filmic. In AE, use a linear working space or OCIO, or interpret the footage as linear.

Accuracy is checked against the real apps by `test/verify-projection.mjs` (Blender → AE) and `test/verify-import.mjs` (AE → Blender). Both project 3D points through both cameras and compare pixels. Last run: 0.00 px and 0.14 px worst error, with animated rotation, zoom, a two-node parented camera and an offset anchor point.

## Testing

`test/call.mjs` is a minimal MCP stdio client:

```bash
node test/call.mjs --list
node test/call.mjs get_scene_info '{}' list_objects '{"type":"CAMERA"}'
node test/call.mjs render_animation '{}' __sleep 20000 get_render_status '{"jobId":"$JOB"}'
```

## Known limitations

- Long main-thread work (baking hundreds of frames for `export_to_ae`, a Cycles `preview_render`) blocks the Blender UI while it runs. Final renders should use `render_animation`.
- Render jobs live in the server process: restarting the MCP server forgets them (the files stay on disk; use `import_render_to_ae` with `directory`).
- `import_from_ae` brings solids/precomps/text as untextured planes. AE lights come in as empties.
- Multilayer EXR in AE: the layer shows the beauty. Use AE's Cryptomatte effect or EXtractoR for the other channels.
