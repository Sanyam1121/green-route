"""Estimates how wide each gali / street is from the gap between the buildings on either side.

Building outlines come from Overture Maps (Google, Microsoft and OpenStreetMap buildings).
Every ~15 m along each street we look 12 m to the left and right for the nearest building wall;
left + right is the open width there. A street's width is the 20th percentile of its samples,
so a single wide spot doesn't hide a tight stretch. Result: data/v3/<city>-widths.json with one
value per way of data/v3/<city>.json, in decimetres (0 = unknown).

Run by GitHub Actions: python scripts/lane_widths.py [city]
"""
import json, math, os, subprocess, sys
import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely import STRtree

CITIES = {
    "jalandhar": (31.27, 75.52, 31.38, 75.65),  # south, west, north, east
    "ludhiana": (30.84, 75.76, 30.95, 75.92),
    "amritsar": (31.59, 74.81, 31.68, 74.93),
    "phagwara": (31.20, 75.74, 31.25, 75.80),
}
MEASURE = {"secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service", "road"}
RAY = 12.0   # metres to look left and right
STEP = 15.0  # metres between samples


def city(name, box):
    s, w, n, e = box
    roads_fn = f"data/v3/{name}.json"
    if not os.path.exists(roads_fn):
        print(f"{name}: no road file, skipping")
        return
    out = f"/tmp/buildings-{name}.parquet"
    pad = 0.003
    subprocess.run(["overturemaps", "download", f"--bbox={w - pad},{s - pad},{e + pad},{n + pad}", "-f", "geoparquet", "--type=building", "-o", out], check=True)
    geoms = shapely.from_wkb(pq.read_table(out, columns=["geometry"]).column("geometry").to_numpy(zero_copy_only=False))
    lat0, lon0 = (s + n) / 2, (w + e) / 2
    kx, ky = math.cos(math.radians(lat0)) * 111320, 110540.0
    geoms = shapely.transform(geoms, lambda c: np.column_stack(((c[:, 0] - lon0) * kx, (c[:, 1] - lat0) * ky)))
    geoms = geoms[~shapely.is_empty(geoms)]
    print(f"{name}: {len(geoms)} buildings")
    tree = STRtree(geoms)

    c = json.load(open(roads_fn, encoding="utf-8"))
    X = (np.array(c["n"][1::2]) / 1e6 - lon0) * kx
    Y = (np.array(c["n"][0::2]) / 1e6 - lat0) * ky
    pts, dirs, way = [], [], []
    for wi, wy in enumerate(c["w"]):
        if c["hw"][wy[0]] not in MEASURE:
            continue
        ns = wy[2:]
        for a, b in zip(ns, ns[1:]):
            dx, dy = X[b] - X[a], Y[b] - Y[a]
            L = math.hypot(dx, dy)
            if L < 4:
                continue
            k = max(1, int(L // STEP))
            for i in range(k):
                f = (i + 0.5) / k
                pts.append((X[a] + dx * f, Y[a] + dy * f))
                dirs.append((-dy / L, dx / L))
                way.append(wi)
    P, D, W = np.array(pts), np.array(dirs), np.array(way)
    print(f"{name}: {len(P)} samples on {len(set(way))} streets")
    pg = shapely.points(P)
    inside = np.zeros(len(P), bool)
    q = tree.query(pg, predicate="within")
    inside[q[0]] = True

    def side(sign):
        lines = shapely.linestrings(np.stack([P, P + sign * D * RAY], axis=1))
        dist = np.full(len(P), np.inf)
        pairs = tree.query(lines, predicate="intersects")
        if pairs.shape[1]:
            inter = shapely.intersection(lines[pairs[0]], geoms[pairs[1]])
            dd = shapely.distance(pg[pairs[0]], inter)
            np.minimum.at(dist, pairs[0], dd)
        return dist

    left, right = side(1), side(-1)
    both = np.isfinite(left) & np.isfinite(right) & ~inside
    width = np.where(np.isfinite(left), left, RAY) + np.where(np.isfinite(right), right, RAY)

    out_w = [0] * len(c["w"])
    groups = {}
    for i in range(len(P)):
        if inside[i]:
            continue
        groups.setdefault(int(W[i]), []).append((float(width[i]), bool(both[i])))
    stats = {"<3.5": 0, "3.5-5": 0, "5-7": 0, ">7": 0}
    for wi, samples in groups.items():
        if not any(b for _, b in samples):
            continue  # no buildings on both sides anywhere: open land, unknown
        ws = sorted(x for x, _ in samples)
        v = ws[min(len(ws) - 1, int(len(ws) * 0.2))]
        out_w[wi] = int(round(v * 10))
        stats["<3.5" if v < 3.5 else "3.5-5" if v < 5 else "5-7" if v < 7 else ">7"] += 1
    json.dump({"roads_updated": c["updated"], "w": out_w}, open(f"data/v3/{name}-widths.json", "w"), separators=(",", ":"))
    print(f"{name}: widths for {sum(1 for x in out_w if x)} streets {json.dumps(stats)}")


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for nm, bx in CITIES.items():
        if only and only != nm:
            continue
        try:
            city(nm, bx)
        except Exception as ex:
            print(f"{nm}: width estimate failed: {ex}")
