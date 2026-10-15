// Projects 3D points through the Blender camera and through the exported AE camera; prints pixel deltas.
import { runPython } from "../dist/blender-bridge.js";
import { runExtendScript } from "../dist/ae/ae-bridge.js";
const comp = process.argv[2] || "BL_test";
const frames = [1, 12, 30, 48];
const pts = [[0, 0, 0], [1, 2, 0.5], [2, -1, 1.5], [-1.5, 1, -0.5]];
const bl = await runPython(`
from bpy_extras.object_utils import world_to_camera_view
sc = scene(); cam = sc.camera; w, h = render_size(sc); ppm = 100
out = {"px": {}, "ae": []}
for p in args["pts"]:
    q = C @ Vector(p) * ppm
    out["ae"].append([q.x + w / 2, q.y + h / 2, q.z])
cur = sc.frame_current
for f in args["frames"]:
    sc.frame_set(f)
    out["px"][f] = []
    for p in args["pts"]:
        v = world_to_camera_view(sc, cam, Vector(p))
        out["px"][f].append([v.x * w, (1 - v.y) * h])
sc.frame_set(cur)
return out
`, { pts, frames });
const ae = await runExtendScript(`
var comp = null;
for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i) instanceof CompItem && app.project.item(i).name === ${JSON.stringify(comp)}) comp = app.project.item(i);
var pos = ${JSON.stringify(bl.ae)}, frames = ${JSON.stringify(frames)};
var nulls = [];
for (var i = 0; i < pos.length; i++) { var n = comp.layers.addNull(); n.threeDLayer = true; n.transform.anchorPoint.setValue([0,0,0]); n.transform.position.setValue(pos[i]); nulls.push(n); }
var t = comp.layers.addText("probe");
var idx = []; for (var i = 0; i < nulls.length; i++) idx.push(nulls[i].index);
var st = t.property("ADBE Text Properties").property("ADBE Text Document");
st.expression = "var idx=[" + idx.join(",") + "]; var s=[]; for (var i=0;i<idx.length;i++){ var p=thisComp.layer(idx[i]).toComp([0,0,0]); s.push('['+p[0]+','+p[1]+']'); } '['+s.join(',')+']';";
var res = {};
for (var k = 0; k < frames.length; k++) res[frames[k]] = st.valueAtTime((frames[k] - 1) / comp.frameRate, false).text;
t.remove(); for (var i = 0; i < nulls.length; i++) nulls[i].remove();
return res;
`);
let worst = 0;
for (const f of frames) {
    const a = JSON.parse(ae[f]);
    const rows = bl.px[f].map((b, i) => { const d = Math.hypot(b[0] - a[i][0], b[1] - a[i][1]); worst = Math.max(worst, d); return `[${b.map((x) => x.toFixed(1))}] vs [${a[i].map((x) => x.toFixed(1))}] d=${d.toFixed(2)}`; });
    console.log(`frame ${f}:\n  ` + rows.join("\n  "));
}
console.log(`worst pixel error: ${worst.toFixed(3)}`);
