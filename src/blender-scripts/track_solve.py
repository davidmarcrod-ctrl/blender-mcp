"""Tracks image points through a shot and triangulates them with a known (solved) camera.

Runs with Blender's bundled Python (it has numpy), outside Blender: no bpy here.
usage: python3 track_solve.py <in.json> <out.json>

in.json:
  frames     raw 8-bit grey frames file, N x H x W (work resolution)
  W, H, N    work size and frame count
  P          N projection matrices (3x4, world -> work pixels, y down)
  frame0     scene frame of frame index 0
  seed_idx   frame index (0..N-1) where the seeds are given
  seeds      {name: [u, v]} work pixels at seed_idx
  regions    [[x0, y0, x1, y1], ...] work pixels at seed_idx, or null: floor patches to fit a plane to
  floor_points  names of seeds that touch the floor (anchor the plane fit)
  cam_pos    camera position at seed_idx (orients the floor normal towards the camera)
  overlay    PNG path for a check image, or null
  grid_step  grid spacing (work px) for the overlay when nothing was asked (pick mode), or null
  to_full    work px -> full-resolution px factor (for the overlay grid labels only)

How: Shi-Tomasi corners (min eigenvalue of the structure tensor) refine seeds and pick floor
features; NCC template matching with sub-pixel peaks tracks them frame to frame, forwards and
backwards from the seed frame; DLT triangulates each track over all its frames, dropping
outlier observations; RANSAC fits a first floor plane to the triangulated floor samples, then the
plane is refined photometrically: floor patches warped through it from the seed frame must match the
other frames (plain tiles give noisy points but still a strong image signal).
"""

import json
import struct
import sys
import zlib

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

cfg = json.load(open(sys.argv[1]))
W, H, N = cfg["W"], cfg["H"], cfg["N"]
frames = np.fromfile(cfg["frames"], dtype=np.uint8)[: N * H * W].reshape(N, H, W).astype(np.float32)
Ps = [np.array(p, dtype=np.float64) for p in cfg["P"]]
S = cfg["seed_idx"]


def min_eig(img, k):
    gy, gx = np.gradient(img)

    def box(a):
        c = np.cumsum(np.cumsum(np.pad(a, ((1, 0), (1, 0))), 0), 1)
        return c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]

    a, b, c = box(gx * gx), box(gx * gy), box(gy * gy)
    lam = (a + c) / 2 - np.sqrt(((a - c) / 2) ** 2 + b * b)
    out = np.zeros_like(img)
    out[k // 2:k // 2 + lam.shape[0], k // 2:k // 2 + lam.shape[1]] = lam
    return out


LAM = min_eig(frames[S], 5)


def refine(x, y, rad=8):
    """Snaps a seed to the strongest corner within rad px (a trackable feature)."""
    x0, y0 = max(0, x - rad), max(0, y - rad)
    sub = LAM[y0:y + rad + 1, x0:x + rad + 1]
    if sub.size == 0:
        return x, y
    iy, ix = np.unravel_index(np.argmax(sub), sub.shape)
    return x0 + ix, y0 + iy


def corners(x0, y0, x1, y1, n=120, spacing=10):
    sub = LAM[y0:y1, x0:x1].copy()
    pts = []
    thr = max(sub.max() * 0.03, 1e-6)
    for _ in range(n):
        iy, ix = np.unravel_index(np.argmax(sub), sub.shape)
        if sub[iy, ix] <= thr:
            break
        pts.append((x0 + ix, y0 + iy))
        sub[max(0, iy - spacing):iy + spacing, max(0, ix - spacing):ix + spacing] = -1
    return pts


def ncc(prev, cur, x, y, half=9, rad=16):
    if not (half + rad <= x < W - half - rad and half + rad <= y < H - half - rad):
        return None
    t = prev[y - half:y + half + 1, x - half:x + half + 1]
    t = (t - t.mean()) / (t.std() + 1e-6)
    pw = swv(cur[y - half - rad:y + half + rad + 1, x - half - rad:x + half + rad + 1], (2 * half + 1,) * 2)
    m = pw.mean(axis=(2, 3), keepdims=True)
    sd = pw.std(axis=(2, 3), keepdims=True) + 1e-6
    sc = (((pw - m) / sd) * t).mean(axis=(2, 3))
    iy, ix = np.unravel_index(np.argmax(sc), sc.shape)
    dx = dy = 0.0
    if 0 < ix < sc.shape[1] - 1:
        l, c_, r_ = sc[iy, ix - 1], sc[iy, ix], sc[iy, ix + 1]
        dx = 0.5 * (l - r_) / (l - 2 * c_ + r_ + 1e-9)
    if 0 < iy < sc.shape[0] - 1:
        u, c_, d_ = sc[iy - 1, ix], sc[iy, ix], sc[iy + 1, ix]
        dy = 0.5 * (u - d_) / (u - 2 * c_ + d_ + 1e-9)
    return x - rad + ix + dx, y - rad + iy + dy, sc[iy, ix]


def track(x, y, min_score):
    """Observations [(frame, u, v)] following the feature both ways from the seed frame."""
    obs = [(S, float(x), float(y))]
    for step in (1, -1):
        px, py = float(x), float(y)
        f = S + step
        while 0 <= f < N:
            res = ncc(frames[f - step], frames[f], int(round(px)), int(round(py)))
            if res is None or res[2] < min_score:
                break
            px, py = res[0] + (px - round(px)), res[1] + (py - round(py))
            obs.append((f, px, py))
            f += step
    return sorted(obs)


def reproj_errors(X, obs):
    errs = []
    for f, u, v in obs:
        p = Ps[f] @ np.append(X, 1)
        errs.append(np.hypot(p[0] / p[2] - u, p[1] / p[2] - v) if p[2] > 0 else 1e9)
    return np.array(errs)


def triangulate(obs):
    """DLT over all observations, then drops outliers (> 3x median + 1 px) and solves again."""
    def solve(o):
        A = []
        for f, u, v in o:
            A += [u * Ps[f][2] - Ps[f][0], v * Ps[f][2] - Ps[f][1]]
        X = np.linalg.svd(np.array(A))[2][-1]
        return X[:3] / X[3]

    X = solve(obs)
    e = reproj_errors(X, obs)
    keep = [o for o, err in zip(obs, e) if err <= 3 * np.median(e) + 1.0]
    if len(keep) >= 3 and len(keep) < len(obs):
        X = solve(keep)
        obs = keep
    return X, reproj_errors(X, obs), obs


def parallax_deg(X, obs):
    """Angle between the rays from the first and last camera position: low = depth poorly defined."""
    def centre(P):
        return np.linalg.svd(P)[2][-1][:3] / np.linalg.svd(P)[2][-1][3]
    a, b = centre(Ps[obs[0][0]]) - X, centre(Ps[obs[-1][0]]) - X
    c = np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12)
    return float(np.degrees(np.arccos(np.clip(c, -1, 1))))


out = {"points": {}, "floor": None}
marks = []  # (u, v, colour) on the seed frame for the overlay

for name, (u, v) in (cfg.get("seeds") or {}).items():
    x0, y0 = refine(int(round(u)), int(round(v)))
    obs = track(x0, y0, 0.8)
    if len(obs) < 8:
        out["points"][name] = {"ok": False, "frames": len(obs), "reason": "lost after a few frames (low texture, occlusion or motion blur)"}
        marks.append((x0, y0, (255, 60, 60)))
        continue
    X, e, used = triangulate(obs)
    p = Ps[S] @ np.append(X, 1)
    marks.append((p[0] / p[2], p[1] / p[2], (60, 255, 60)))
    par = parallax_deg(X, used)
    ok = bool(np.median(e) < 1.5 and par > 1.0)
    out["points"][name] = {"ok": ok, "xyz": X.tolist(), "frames": len(used), "frame_span": [used[0][0] + cfg["frame0"], used[-1][0] + cfg["frame0"]],
                           "err_px": float(np.median(e)), "parallax_deg": round(par, 2),
                           "seed_snapped": [float(x0), float(y0)]}
    if not ok:
        out["points"][name]["reason"] = "reprojection error too high" if np.median(e) >= 1.5 else "too little camera movement to judge depth"


def camera_centre(P):
    v = np.linalg.svd(P)[2][-1]
    return v[:3] / v[3]


def bilinear(img, x, y):
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    ax, ay = x - x0, y - y0
    ok = (x0 >= 0) & (y0 >= 0) & (x0 < W - 1) & (y0 < H - 1)
    x0, y0 = np.clip(x0, 0, W - 2), np.clip(y0, 0, H - 2)
    v = (img[y0, x0] * (1 - ax) * (1 - ay) + img[y0, x0 + 1] * ax * (1 - ay)
         + img[y0 + 1, x0] * (1 - ax) * ay + img[y0 + 1, x0 + 1] * ax * ay)
    return v, ok


def nelder_mead(f, x0, steps, iters=300):
    pts = [x0] + [x0 + np.eye(len(x0))[i] * steps[i] for i in range(len(x0))]
    vals = [f(p) for p in pts]
    for _ in range(iters):
        o = np.argsort(vals)
        pts, vals = [pts[i] for i in o], [vals[i] for i in o]
        c = np.mean(pts[:-1], 0)
        r = c + (c - pts[-1])
        fr_ = f(r)
        if fr_ < vals[0]:
            e = c + 2 * (c - pts[-1])
            fe = f(e)
            pts[-1], vals[-1] = (e, fe) if fe < fr_ else (r, fr_)
        elif fr_ < vals[-2]:
            pts[-1], vals[-1] = r, fr_
        else:
            k = c + 0.5 * (pts[-1] - c)
            fk = f(k)
            if fk < vals[-1]:
                pts[-1], vals[-1] = k, fk
            else:
                pts = [pts[0]] + [pts[0] + 0.5 * (p - pts[0]) for p in pts[1:]]
                vals = [vals[0]] + [f(p) for p in pts[1:]]
    i = int(np.argmin(vals))
    return pts[i], vals[i]


def refine_plane(n0, ctr0, regions):
    """Adjusts the plane so the floor patches, warped from the seed frame into other frames through it,
    match the image (1 - NCC, averaged). Tiles and grout lines that are too plain to track as points
    still constrain this well. Returns (normal, point on plane, cost before, cost after)."""
    C0 = camera_centre(Ps[S])
    Minv = np.linalg.inv(Ps[S][:, :3])
    uv = []
    for x0, y0, x1, y1 in regions:
        xs, ys = np.meshgrid(np.arange(max(int(x0), 1), min(int(x1), W - 1), 3), np.arange(max(int(y0), 1), min(int(y1), H - 1), 3))
        uv.append(np.stack([xs.ravel(), ys.ravel()], 1))
    uv = np.concatenate(uv).astype(np.float64)
    dirs = (Minv @ np.c_[uv, np.ones(len(uv))].T).T
    I0 = frames[S][uv[:, 1].astype(int), uv[:, 0].astype(int)]
    others = sorted({int(f) for f in np.linspace(0, N - 1, 10)} - set(range(S - 2, S + 3)))
    if not others:
        return n0, ctr0, None, None

    def plane(p):
        th, ph, d = p
        return np.array([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th)]), d

    def cost(p):
        n, d = plane(p)
        den = dirs @ n
        lam = (d - n @ C0) / np.where(np.abs(den) < 1e-9, 1e-9, den)
        X = np.c_[C0 + lam[:, None] * dirs, np.ones(len(dirs))]
        tot = 0.0
        for f in others:
            q = (Ps[f] @ X.T).T
            v, ok = bilinear(frames[f], q[:, 0] / q[:, 2], q[:, 1] / q[:, 2])
            m = ok & (lam > 0)
            if m.sum() < 200:
                tot += 1.0
                continue
            a, b = I0[m] - I0[m].mean(), v[m] - v[m].mean()
            tot += 1 - (a @ b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9)
        return tot / len(others)

    n0 = n0 / np.linalg.norm(n0)
    p0 = np.array([np.arccos(np.clip(n0[2], -1, 1)), np.arctan2(n0[1], n0[0]), n0 @ ctr0])
    p, v = nelder_mead(cost, p0, [0.15, 0.15, 0.05 * np.linalg.norm(C0 - ctr0)])
    n, d = plane(p)
    return n, ctr0 - ((ctr0 @ n) - d) * n, float(cost(p0)), float(v)


floor_named = [n for n in (cfg.get("floor_points") or []) if out["points"].get(n, {}).get("ok")]
if cfg.get("regions") or cfg.get("floor_points"):
    # Floor samples: (xyz, reprojection error, seed u, seed v, is a named point). Named floor points (a foot,
    # a tyre contact, a box corner) are well-textured and trusted more than features on plain tiles.
    pts = [(np.array(out["points"][n]["xyz"]), out["points"][n]["err_px"], None, None, True) for n in floor_named]
    cands = []
    for reg in cfg.get("regions") or []:
        x0, y0, x1, y1 = [int(round(c)) for c in reg]
        cands += corners(max(x0, 0), max(y0, 0), min(x1, W), min(y1, H))
    for (x, y) in cands:
        obs = track(x, y, 0.85)
        if len(obs) >= 10:
            X, e, used = triangulate(obs)
            # Little parallax = depth poorly defined, which tilts the plane: skip those features.
            if np.median(e) < 1.0 and parallax_deg(X, used) >= 1.5:
                pts.append((X, float(np.median(e)), x, y, False))
                continue
        marks.append((x, y, (255, 60, 60)))
    floor = {"candidates": len(cands), "tracked_features": sum(1 for p in pts if not p[4]), "named_points": floor_named}
    if len(pts) >= 3:
        P = np.array([p[0] for p in pts])
        wts = np.array([5.0 if p[4] else 1.0 for p in pts])
        scale = np.linalg.norm(P - np.median(P, 0), axis=1).mean() or 1.0
        rng = np.random.default_rng(0)
        best, best_score = np.ones(len(P), bool), -1.0
        if len(P) > 3:
            for _ in range(800):
                a, b, c = P[rng.choice(len(P), 3, replace=False)]
                n = np.cross(b - a, c - a)
                nn = np.linalg.norm(n)
                if nn < 1e-9:
                    continue
                inl = np.abs((P - a) @ (n / nn)) < 0.02 * scale
                if wts[inl].sum() > best_score:
                    best, best_score = inl, wts[inl].sum()
        Q, wq = P[best], wts[best]
        ctr = (Q * wq[:, None]).sum(0) / wq.sum()
        n = np.linalg.svd((Q - ctr) * np.sqrt(wq)[:, None])[2][-1]
        if cfg.get("regions"):
            n, ctr, c0, c1 = refine_plane(n, ctr, cfg["regions"])
            if c1 is not None:
                floor["photometric"] = {"before": round(c0, 4), "after": round(c1, 4),
                                        "note": "1 - NCC of the floor patches warped through the plane; ~0.02-0.05 = sticks to the floor"}
        if (np.array(cfg["cam_pos"]) - ctr) @ n < 0:
            n = -n  # normal points to the camera side (up)
        resid = (Q - ctr) @ n
        floor.update({"ok": bool(best.sum() >= 3), "inliers": int(best.sum()), "center": ctr.tolist(), "normal": n.tolist(),
                      "sample_rms": float(np.sqrt((resid ** 2).mean())), "extent": float(np.linalg.norm(Q - ctr, axis=1).max()),
                      "reproj_median_px": float(np.median([p[1] for p, k in zip(pts, best) if k]))})
        for (X, _, x, y, named), k in zip(pts, best):
            if not named:
                marks.append((x, y, (60, 200, 255) if k else (255, 160, 0)))
        # Heights of the named points above the floor: a quick check that the scale and plane make physical sense.
        for v in out["points"].values():
            if v.get("xyz"):
                v["height_above_floor"] = float((np.array(v["xyz"]) - ctr) @ n)
    else:
        floor.update({"ok": False, "reason": "fewer than 3 floor samples: add floorPoints or larger / more textured floorRegions"})
    out["floor"] = floor


def write_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def floor_grid_pixels(fi):
    """Pixels of a grid lying on the solved floor plane, projected into frame fi."""
    fl = out.get("floor") or {}
    if not fl.get("ok"):
        return []
    n, c, ext = np.array(fl["normal"]), np.array(fl["center"]), fl["extent"] / 1.5
    a = np.cross(n, [1.0, 0, 0] if abs(n[0]) < 0.9 else [0, 1.0, 0])
    a /= np.linalg.norm(a)
    b = np.cross(n, a)
    ts = np.linspace(-1.5 * ext, 1.5 * ext, 13)
    pix = []
    for t in ts:
        for d1, d2 in ((a, b), (b, a)):
            seg = c + t * d1 + np.linspace(-1.5 * ext, 1.5 * ext, 1200)[:, None] * d2
            q = (Ps[fi] @ np.c_[seg, np.ones(len(seg))].T).T
            q = q[q[:, 2] > 0]
            pix.append(np.stack([q[:, 0] / q[:, 2], q[:, 1] / q[:, 2]], 1))
    return np.concatenate(pix) if pix else []


def draw(fi, marks_, path, with_grid):
    img = np.repeat(frames[fi][..., None], 3, axis=2).astype(np.uint8)
    if with_grid:  # pick mode: a grid so coordinates can be read off the image
        step = cfg["grid_step"]
        for gx in np.arange(0, W, step):
            img[:, int(gx)] = (255, 255, 0) if int(round(gx * cfg["to_full"])) % 1000 == 0 else (120, 120, 0)
        for gy in np.arange(0, H, step):
            img[int(gy), :] = (255, 255, 0) if int(round(gy * cfg["to_full"])) % 1000 == 0 else (120, 120, 0)
    for u, v in floor_grid_pixels(fi):
        if 0 <= u < W and 0 <= v < H:
            img[int(v), int(u)] = (255, 0, 255)
    if fi == S:
        for reg in cfg.get("regions") or []:
            x0, y0, x1, y1 = [int(np.clip(c, 0, d - 1)) for c, d in zip(reg, (W, H, W, H))]
            img[y0, x0:x1] = img[y1, x0:x1] = (255, 255, 255)
            img[y0:y1, x0] = img[y0:y1, x1] = (255, 255, 255)
    for (u, v, col) in marks_:
        u, v = int(round(u)), int(round(v))
        for d in range(-6, 7):
            if 0 <= v < H and 0 <= u + d < W:
                img[v, u + d] = col
            if 0 <= u < W and 0 <= v + d < H:
                img[v + d, u] = col
    write_png(path, img)


if cfg.get("overlay"):
    draw(S, marks, cfg["overlay"], bool(cfg.get("grid_step")))
    out["overlays"] = [cfg["overlay"]]
    if (out.get("floor") or {}).get("ok") or out["points"]:
        # The far end of the shot, with the named points reprojected: if the floor grid and the marks
        # still sit on the same spots of the image, the solve holds over the whole move.
        far = 0 if S > (N - 1) / 2 else N - 1
        far_marks = []
        for v in out["points"].values():
            if v.get("xyz"):
                q = Ps[far] @ np.append(v["xyz"], 1)
                far_marks.append((q[0] / q[2], q[1] / q[2], (60, 255, 60)))
        path2 = cfg["overlay"].replace(".png", f"-frame{far + cfg.get('frame0', 0)}.png")
        draw(far, far_marks, path2, False)
        out["overlays"].append(path2)

json.dump(out, open(sys.argv[2], "w"))
