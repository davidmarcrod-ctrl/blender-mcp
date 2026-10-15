"""Bakes simulations in a background Blender (run by bake_simulation on a snapshot of the user's file).

usage: Blender -b <snapshot.blend> --python-exit-code 1 --python bake_job.py -- '<json args>'
args: {"scene", "frameStart", "frameEnd", "pointCaches", "fluids", "geometryNodes", "origStem"}

Prints "MCP_STAGE <text>" when a step starts and "MCP_RESULT <json>" at the end, then saves the snapshot.
Blender itself prints "bake: frame N :: M" while baking point caches.
"""

import json
import sys

import bpy

args = json.loads(sys.argv[sys.argv.index("--") + 1])
sc = bpy.data.scenes[args["scene"]]
if bpy.context.window_manager.windows:
    bpy.context.window_manager.windows[0].scene = sc
start = args.get("frameStart") if args.get("frameStart") is not None else sc.frame_start
end = args.get("frameEnd") if args.get("frameEnd") is not None else sc.frame_end
baked = []


def stage(text):
    print(f"MCP_STAGE {text}", flush=True)


def point_caches():
    """(owner, kind, point cache) for every point-cache simulation in the scene."""
    out = []
    for o in sc.objects:
        for m in o.modifiers:
            if m.type == "PARTICLE_SYSTEM":
                out.append((f"{o.name} > {m.name}", "particles", m.particle_system.point_cache))
            elif m.type in ("CLOTH", "SOFT_BODY"):
                out.append((f"{o.name} > {m.name}", m.type.lower(), m.point_cache))
            elif m.type == "DYNAMIC_PAINT" and m.canvas_settings:
                for surf in m.canvas_settings.canvas_surfaces:
                    out.append((f"{o.name} > {surf.name}", "dynamic_paint", surf.point_cache))
    rw = sc.rigidbody_world
    if rw and rw.enabled:
        out.append(("Rigid Body World", "rigid_body", rw.point_cache))
    return out


if args["pointCaches"]:
    caches = point_caches()
    if caches:
        stage("point caches: " + ", ".join(sorted({k for _, k, _ in caches})))
        # The cache range is reset when particle settings change, so it is set last, right before baking.
        for _, _, pc in caches:
            pc.frame_start = start
            pc.frame_end = end
        # Stepping frames with frame_set reuses stale cache states; only free + bake_all really re-simulates.
        bpy.ops.ptcache.free_bake_all()
        bpy.ops.ptcache.bake_all(bake=True)
        for owner, kind, pc in caches:
            baked.append({"what": owner, "kind": kind, "baked": pc.is_baked, "frames": [pc.frame_start, pc.frame_end],
                          "disk_cache": pc.use_disk_cache, "info": pc.info})

if args["fluids"]:
    for o in sc.objects:
        for m in o.modifiers:
            if m.type != "FLUID" or m.fluid_type != "DOMAIN":
                continue
            ds = m.domain_settings
            stage(f"fluid: {o.name}")
            ds.cache_frame_start = start
            ds.cache_frame_end = end
            if ds.cache_type == "REPLAY":  # replay caches cannot be baked
                ds.cache_type = "ALL"
            with bpy.context.temp_override(scene=sc, object=o, active_object=o):
                bpy.ops.fluid.free_all()
                bpy.ops.fluid.bake_all()
            baked.append({"what": f"{o.name} > {m.name}", "kind": "fluid", "frames": [start, end],
                          "cache_directory": ds.cache_directory, "cache_type": ds.cache_type})

if args["geometryNodes"]:
    sims = []
    for o in sc.objects:
        for m in o.modifiers:
            ng = getattr(m, "node_group", None) if m.type == "NODES" else None
            if ng and any(n.bl_idname == "GeometryNodeSimulationOutput" for n in ng.nodes):
                sims.append((o, m))
                # A disk bake with no directory is named after the .blend; pin it to the user's file name.
                if getattr(m, "bake_target", "PACKED") == "DISK" and not m.bake_directory:
                    m.bake_directory = f"//{args['origStem']}_bakes/{o.name}_{m.name}/"
    if sims:
        stage("geometry nodes simulations")
        saved_range = (sc.frame_start, sc.frame_end)
        sc.frame_start, sc.frame_end = start, end  # simulation zones bake over the scene range
        try:
            with bpy.context.temp_override(scene=sc):
                bpy.ops.object.simulation_nodes_cache_bake(selected=False)
        finally:
            sc.frame_start, sc.frame_end = saved_range
        for o, m in sims:
            baked.append({"what": f"{o.name} > {m.name}", "kind": "geometry_nodes",
                          "target": getattr(m, "bake_target", None), "directory": m.bake_directory or None})

stage("saving")
bpy.ops.wm.save_mainfile()
print("MCP_RESULT " + json.dumps({"baked": baked, "frames": [start, end]}), flush=True)
