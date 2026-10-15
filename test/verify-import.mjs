// Builds a tricky AE comp, imports it into Blender with import_from_ae (via the MCP), and compares projections.
import { spawnSync } from "node:child_process";
import { runPython } from "../dist/blender-bridge.js";
import { runExtendScript, runExtendScriptInUndoGroup } from "../dist/ae/ae-bridge.js";
await runExtendScriptInUndoGroup(`
for (var i = app.project.numItems; i >= 1; i--) if (app.project.item(i).name === "AE_test") app.project.item(i).remove();
var c = app.project.items.addComp("AE_test", 1920, 1080, 1, 2, 25);
var rig = c.layers.addNull(); rig.name = "Rig"; rig.threeDLayer = true;
rig.transform.position.setValueAtTime(0, [960, 540, 0]); rig.transform.position.setValueAtTime(2, [700, 500, -300]);
rig.transform.yRotation.setValueAtTime(0, 0); rig.transform.yRotation.setValueAtTime(2, 25);
var cam = c.layers.addCamera("AE Cam", [960, 540]);
cam.parent = rig;
cam.transform.pointOfInterest.setValueAtTime(0, [100, 50, 400]);
cam.transform.pointOfInterest.setValueAtTime(2, [-150, 0, 600]);
var zp = cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom");
zp.setValueAtTime(0, 1800); zp.setValueAtTime(2, 1200);
var m = c.layers.addNull(); m.name = "Marker"; m.threeDLayer = true;
m.transform.position.setValue([1100, 400, 300]); m.transform.xRotation.setValue(30); m.transform.zRotation.setValue(-20);
var s = c.layers.addSolid([0.2, 0.6, 0.9], "Card", 400, 300, 1); s.threeDLayer = true;
s.transform.anchorPoint.setValue([50, 250, 0]);
s.transform.position.setValue([800, 600, 200]); s.transform.orientation.setValue([20, 40, 10]); s.transform.scale.setValue([120, 80, 100]);
c.openInViewer();
return "ok";
`, "test setup");
const r = spawnSync("node", ["test/call.mjs", "import_from_ae", JSON.stringify({ compName: "AE_test", collection: "From AE test" })], { encoding: "utf8" });
console.log(r.stdout.slice(0, 1500));
const frames = [0, 12, 25, 49];
const ae = await runExtendScript(`
var c = null; for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).name === "AE_test") c = app.project.item(i);
var t = c.layers.addText("probe");
var st = t.property("ADBE Text Properties").property("ADBE Text Document");
st.expression = "var m=thisComp.layer('Marker').toComp([0,0,0]); var L=thisComp.layer('Card'); var q=[[0,300],[400,300],[400,0],[0,0]]; var s=['['+m[0]+','+m[1]+']']; for (var i=0;i<4;i++){var p=L.toComp(q[i]); s.push('['+p[0]+','+p[1]+']');} '['+s.join(',')+']';";
var out = {}; var fr = ${JSON.stringify(frames)};
for (var k = 0; k < fr.length; k++) out[fr[k]] = st.valueAtTime(fr[k] / 25, false).text;
t.remove(); return out;`);
const bl = await runPython(`
from bpy_extras.object_utils import world_to_camera_view
sc = scene(); cam = bpy.data.objects["AE Cam"]; w, h = render_size(sc); out = {}
cur = sc.frame_current
for f in args["frames"]:
    sc.frame_set(f + 1)
    pts = [bpy.data.objects["Marker"].matrix_world.translation]
    card = bpy.data.objects["Card"]
    pts += [card.matrix_world @ v.co for v in card.data.vertices]
    out[f] = [[world_to_camera_view(sc, cam, p).x * w, (1 - world_to_camera_view(sc, cam, p).y) * h] for p in pts]
sc.frame_set(cur)
return out`, { frames });
let worst = 0;
for (const f of frames) {
    const a = JSON.parse(ae[f]);
    const d = bl[f].map((b, i) => Math.hypot(b[0] - a[i][0], b[1] - a[i][1]));
    worst = Math.max(worst, ...d);
    console.log(`frame ${f}: ` + bl[f].map((b, i) => `[${b.map((x) => x.toFixed(0))}]~[${a[i].map((x) => x.toFixed(0))}]`).join(" ") + `  max d=${Math.max(...d).toFixed(2)}`);
}
console.log(`worst pixel error: ${worst.toFixed(3)}`);
