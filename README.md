# blender-mcp

An MCP server for driving Blender from an LLM, built for a VFX/motion workflow with After Effects. It covers scene inspection, objects, materials, keyframes, EEVEE previews the model can look at, EXR render passes, background renders, and a two-way camera/null/footage bridge with After Effects, background simulation bakes, point/floor triangulation from a solved camera, plus a raw Python escape hatch for everything else.

Sister project of [ae-mcp](https://github.com/davidmarcrod-ctrl/ae-mcp). The AE bridge here uses the same osascript → `DoScriptFile` mechanism, so AE needs nothing extra installed.

## How it works

```
Claude ──stdio──> blender-mcp (Node) ──TCP 127.0.0.1:9877──> "MCP Bridge" add-on ──> bpy (main thread)
                                 └──osascript/JSX──> After Effects
```

The add-on (`addon/blender_mcp_bridge`) listens on localhost only. Each request carries a Python function body plus a JSON `args` dict, and the shared helpers in `src/blender-scripts/lib.py`. The body runs on Blender's main thread through a timer, since bpy is not thread-safe. Data always travels in `args` and is never spliced into source, so there is no escaping. The helpers ship with every call, so updating the server never requires reinstalling the add-on. Each mutating call pushes one Blender undo step (Cmd+Z).

## Requirements

- macOS, Blender 4.2+ (tested on 5.2.2 LTS), Node.js 20+.
- For `triangulate_points`: ffmpeg/ffprobe (`brew install ffmpeg`). The solver runs on Blender's bundled Python (it ships numpy).
- For the AE tools: After Effects running with a project open (default app name `Adobe After Effects 2026`; override with `AE_MCP_APP_NAME`).

## Setup

```bash
npm install
npm run build
npm run install-addon   # with Blender CLOSED: links the add-on into Blender's extensions and enables it
```

The add-on auto-starts with Blender. Its panel is in the 3D View sidebar (N) › **MCP**, with Start/Stop, the port, and the background jobs (renders and bakes) with a progress bar and a cancel button. After updating the add-on code, restart Blender.

Register the server in Claude Code (user scope, available in every project):

```bash
claude mcp add --scope user blender-mcp -- node ~/code/blender-mcp/dist/index.js
```

Environment variables: `BLENDER_MCP_PORT` (default 9877), `BLENDER_MCP_APP` (default `/Applications/Blender.app`), `BLENDER_MCP_BIN` (Blender executable used for background renders and bakes), `BLENDER_MCP_PYTHON` (Python with numpy for `triangulate_points`; default: Blender's own), `AE_MCP_APP_NAME`.

## Tools

| Tool | Purpose |
|---|---|
| `bridge_status` / `launch_blender` / `open_file` / `save_file` | connection and .blend I/O (`open_file` refuses to discard unsaved changes unless told to) |
| `get_scene_info` / `list_objects` | audit the scene before acting; `get_scene_info` lists movie clips and warns about HDR footage |
| `get_property` / `set_property` | read/write anything by Python path (`bpy.data.objects["Cube"].location`) |
| `create_object` / `delete_objects` | primitives, empties, cameras, lights, text (context-free, via bmesh/bpy.data) |
| `set_material` | Principled BSDF inputs by UI name |
| `set_footage_colorspace` | input colour space of clips/images; by default turns HDR (Rec.2100 HLG/PQ) footage into sRGB so Blender shows what AE shows |
| `set_keyframe` / `get_animation` | keys with interpolation/easing on any property; works with Blender 4.4+/5.x layered actions |
| `set_render_settings` | engine, resolution, fps (incl. 23.976/29.97), range, samples, color management, transparency |
| `preview_render` / `viewport_screenshot` | images returned to the model for look-dev checks (scene settings restored afterwards; `preview_render` ignores the render region unless `useBorder`, can render a single view layer with `viewLayer`, and mutes File Output nodes so previews never land in the render folders) |
| `setup_render_passes` | passes + EXR output for one view layer: `multilayer` (one EXR incl. Cryptomatte) or `separate` (also one EXR sequence per pass via a compositor File Output node) |
| `setup_element_layers` | one view layer per element (the other elements holdout, indirect-only or excluded; shadow catchers in every layer) and one File Output node per element: `//render/<scene>/<element>/<element>_<pass>_####.exr`. Idempotent; `remove: true` undoes it |
| `render_animation` / `get_render_status` | render in a separate background Blender from a snapshot saved next to the .blend; Blender stays usable. With element layers the job lists each element's folder, nearest to the camera first, and writes `mcp_elements.json` next to the render. `get_render_status` covers bakes too |
| `bake_simulation` | bake particles, cloth, soft/rigid body, dynamic paint, fluids and Geometry Nodes simulations in a background Blender, then load the baked file back |
| `triangulate_points` | track image points through the shot and triangulate them with the solved camera; fit the floor plane (shadow catcher) |
| `export_to_ae` | Blender camera + objects → AE one-node 3D camera + 3D nulls, baked per frame |
| `import_from_ae` | AE camera (incl. two-node/POI, parented, 3D Camera Tracker) + 3D layers → Blender camera, empties and planes (footage planes get the source as texture, solids their colour) |
| `import_render_to_ae` | rendered sequences → AE comp: beauty visible, passes above it switched off with suggested blend modes; over a plate, beauty right above it and the shadow catcher pass under the beauty in Multiply. Per-element renders arrive as one colour-labelled block of layers per element (`<element> <pass>`), nearest element on top, shadow catchers under all the beauties |
| `run_python` | escape hatch: arbitrary bpy code (geometry nodes, modifiers, drivers, compositor...) |

## Blender ↔ AE conventions

- **Axes:** AE position = (Bx, −Bz, By) × ppm + (w/2, h/2, 0). Blender's world origin lands at the comp centre on AE's z = 0. `ppm` (pixels per metre) defaults to 100. Use the same value in both directions.
- **Rotation:** AE applies Z, then Y, then X (mathutils `'ZYX'`). Cameras and planes get an extra 180° about X, because Blender cameras look down −Z and AE cameras look down +z.
- **Lens:** AE Zoom = focal length / sensor size × frame size along the sensor-fit axis. Lens shift and orthographic cameras cannot be reproduced in AE; `export_to_ae` warns about them.
- **Time:** Blender `frame_start` = AE time 0. New comps get `displayStartFrame` = `frame_start`.
- **Color:** EXR output is scene-linear (Linear Rec.709), not AgX/Filmic. In AE, use a linear working space or OCIO, or interpret the footage as linear.
- **HDR footage:** iPhones record HLG (Dolby Vision). Blender tags it Rec.2100-HLG and decodes it as HDR; AE in a Rec.709 project shows the file unconverted. Set the clip to sRGB (`set_footage_colorspace`) so the plate looks the same in both apps.
- **Shadows on the plate:** render the Cycles `shadow_catcher` pass (`setup_render_passes`, layout `separate`) with a shadow-catcher floor (`triangulate_points` makes one). `import_render_to_ae` stacks beauty > shadow catcher (Multiply) > plate.
- **Elements:** `setup_element_layers` gives each element (the ball, the confetti...) its own view layer and folder. In each layer the other elements are holdout by default: they cut a hole where they pass in front, so the AE stack rebuilds the overlaps. Held-out and indirect-only objects still cast shadows, so every element's shadow catcher pass holds every shadow: with `shadows: "shared"` AE gets it once (`Blender shadows (all elements)`); `shadows: "per_element"` adds a shadow-only layer per element (`<element>_shadow`, others excluded) whose catcher pass replaces the element's, at the cost of one more render per element. Objects listed loose are moved into a collection named after the element. Things in no element (set, lights, catchers) render in every layer. The user's own view layers are switched off while the element layers exist.

Accuracy is checked against the real apps by `test/verify-projection.mjs` (Blender → AE) and `test/verify-import.mjs` (AE → Blender). Both project 3D points through both cameras and compare pixels. Last run: 0.00 px and 0.14 px worst error, with animated rotation, zoom, a two-node parented camera and an offset anchor point.

## Background jobs

`render_animation` and `bake_simulation` run a separate `Blender -b` on a snapshot of the file (`<name>.mcp_render.blend` / `<name>.mcp_bake.blend`, next to the original so `//` paths work). The server mirrors its jobs to `~/.blender-mcp/jobs/<server pid>.json`; the add-on reads it once a second for the sidebar panel, and its cancel button creates `~/.blender-mcp/cancel/<jobId>`, which the server picks up.

`bake_simulation` saves the file, bakes the snapshot (point caches with `ptcache.free_bake_all()` + `bake_all(bake=True)`, the only way that really re-simulates in Blender 5.2; the cache range is set last, because changing particle settings resets it), then opens the baked snapshot in the user's Blender and saves it over the original. If the file changed in Blender during the bake, it is not loaded: `get_render_status` with `apply=true` (and `discardChanges=true` once the user agrees) does it.

## Triangulating points and the floor

`triangulate_points` reuses a solved camera (e.g. AE's 3D Camera Tracker brought in with `import_from_ae`) as a small 3D tracker. ffmpeg extracts the shot in grey at 960 px; Shi-Tomasi corners snap the seeds; NCC template matching tracks them forwards and backwards from the seed frame; DLT triangulates each track, dropping outlier observations. The floor gets a RANSAC plane from triangulated floor samples (named `floorPoints`, plus corners found in `floorRegions`), then a photometric refinement: the floor patches warped through the plane from the seed frame must match the other frames. Plain tiles give noisy points but a strong image signal, so this step is what makes the floor accurate. On the test shot (iPhone, AE 3D Camera Tracker) points reprojected at 0.2–0.9 px; the floor landed 3° from a hand-made reference, and the rear wheel hub came out one wheel radius above it. The check images (seed frame and far end of the shot, with the floor drawn as a grid) show whether it holds. With no points and no regions it returns the seed frame with a pixel grid, to read coordinates from.

## Testing

`test/call.mjs` is a minimal MCP stdio client:

```bash
node test/call.mjs --list
node test/call.mjs get_scene_info '{}' list_objects '{"type":"CAMERA"}'
node test/call.mjs render_animation '{}' __sleep 20000 get_render_status '{"jobId":"$JOB"}'
FULL=1 node test/call.mjs triangulate_points '{"points":{"hub":[1716,1704]},"floorRegions":[[2400,1400,3700,2150]]}'
```

`FULL=1` prints whole results (the default cuts at 2500 characters). To test without touching the Blender you work in, run a second one with the bridge on another port and point the client at it with `BLENDER_MCP_PORT`. `BLENDER_MCP_KEEP_SOLVE=1` keeps the extracted frames and solver input of `triangulate_points` in `$TMPDIR/blender-mcp-solve-*`.

## Known limitations

- Long main-thread work (baking hundreds of frames for `export_to_ae`, a Cycles `preview_render`) blocks the Blender UI while it runs. Final renders should use `render_animation`, and simulations `bake_simulation`.
- Loading a finished bake reopens the file, so Blender's undo history starts over.
- Bake progress is per frame for point caches; fluids and Geometry Nodes report only the current step.
- Jobs live in the server process: restarting the MCP server forgets them (the files stay on disk; use `import_render_to_ae` with `directory`; for element renders, the scene's render folder, which has `mcp_elements.json`).
- `triangulate_points` needs camera parallax: points the camera barely moves around (`parallax_deg` < 1) get unreliable depth. The floor needs texture or named contact points; a single small patch is not enough.
- `import_from_ae`: solids come in as planes with their colour; precomps, text and shape layers as untextured planes; AE lights as empties.
- Multilayer EXR in AE: the layer shows the beauty. Use AE's Cryptomatte effect or EXtractoR for the other channels.
