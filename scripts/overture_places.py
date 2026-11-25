"""Adds places from Overture Maps (https://overturemaps.org, CDLA-Permissive-2.0) to each city's
place list in data/v3/<city>-places.json, next to the OpenStreetMap places.

Entries keep the app's format [name, lat, lon, type, altNames, street] plus an 7th field "o"
that marks Overture rows, so a re-run replaces them without touching OpenStreetMap rows.
Run by GitHub Actions: python scripts/overture_places.py
"""
import json, os, re, sys, math, subprocess
import duckdb

CITIES = {
    "jalandhar": (31.27, 75.52, 31.38, 75.65),  # south, west, north, east
    "ludhiana": (30.84, 75.76, 30.95, 75.92),
    "amritsar": (31.59, 74.81, 31.68, 74.93),
    "phagwara": (31.20, 75.74, 31.25, 75.80),
}
MIN_CONFIDENCE = 0.5
MAX_PER_CITY = 30000

# Overture category (substring) -> app type, first match wins
CAT_RULES = [
    (("gas_station", "fuel", "petrol"), "fuel"), (("ev_charging", "charging_station"), "ev"),
    (("sikh_temple", "gurdwara"), "gurdwara"), (("hindu_temple", "temple", "shrine"), "temple"),
    (("mosque",), "mosque"), (("church", "cathedral"), "church"),
    (("hospital", "emergency_room"), "hospital"),
    (("pharmacy", "drugstore", "chemist"), "pharmacy"),
    (("clinic", "doctor", "dentist", "medical", "physician", "diagnostic", "laborator", "health"), "clinic"),
    (("atm",), "atm"), (("bank", "credit_union"), "bank"),
    (("college", "university"), "college"), (("school", "kindergarten", "preschool", "academy", "coaching", "tutor"), "school"),
    (("movie_theater", "cinema"), "cinema"),
    (("shopping_mall", "shopping_center", "market", "bazaar"), "market"),
    (("restaurant", "dhaba", "food_court", "buffet"), "restaurant"),
    (("cafe", "coffee", "bakery", "dessert", "sweet", "ice_cream", "fast_food", "juice", "tea", "pizza", "burger", "snack"), "cafe"),
    (("hotel", "lodging", "guest_house", "hostel", "resort", "motel"), "hotel"),
    (("police",), "police"), (("bus_station", "bus_stop"), "bus"), (("train_station", "railway"), "train"),
    (("park", "garden", "playground"), "park"),
    (("gym", "fitness", "sports", "stadium", "swimming", "yoga"), "sport"),
    (("government", "post_office", "courthouse", "city_hall", "town_hall", "passport", "public_service"), "govt"),
    (("landmark", "monument", "museum", "historic", "tourist"), "sight"),
    (("office", "agency", "consult", "insurance", "real_estate", "lawyer", "accountant"), "office"),
    (("store", "shop", "retail", "boutique", "dealer", "showroom", "supermarket", "grocery", "mobile_phone", "electronics", "clothing", "jewelry", "hardware", "furniture", "salon", "beauty", "repair", "tailor", "optician", "book"), "shop"),
]


def type_of(cat):
    c = (cat or "").lower()
    for keys, ty in CAT_RULES:
        if any(k in c for k in keys):
            return ty
    return "other"


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^\w]+", " ", (s or "").lower())).strip()


def dist_m(a1, o1, a2, o2):
    dy = (a2 - a1) * 111320
    dx = (o2 - o1) * 111320 * math.cos(math.radians(a1))
    return math.hypot(dx, dy)


def fetch_city_rows(city, box):
    """Download one city's places with the official `overturemaps` tool (reads only the needed parts)."""
    s, w, n, e = box
    out = f"/tmp/overture-{city}.parquet"
    subprocess.run(["overturemaps", "download", f"--bbox={w},{s},{e},{n}", "-f", "geoparquet", "--type=place", "-o", out], check=True)
    con = duckdb.connect()
    cols = {r[0]: r[1] for r in con.sql(f"DESCRIBE SELECT * FROM read_parquet('{out}') LIMIT 1").fetchall()}
    print(f"{city} columns:", ", ".join(sorted(cols)))
    if "basic_category" in cols:
        cat_expr = "basic_category"
    elif "taxonomy" in cols:
        cat_expr = "taxonomy.primary"
    elif "categories" in cols:
        cat_expr = "categories.primary"
    else:
        cat_expr = "NULL"
    addr_expr = "addresses[1].freeform" if "addresses" in cols else "NULL"
    conf_expr = "confidence" if "confidence" in cols else "1.0"
    rows = con.sql(f"""
        SELECT names.primary AS name, {cat_expr} AS cat, {conf_expr} AS confidence,
               (bbox.xmin + bbox.xmax) / 2 AS lon, (bbox.ymin + bbox.ymax) / 2 AS lat, {addr_expr} AS addr
        FROM read_parquet('{out}')
        WHERE {conf_expr} >= {MIN_CONFIDENCE} AND names.primary IS NOT NULL
    """).fetchall()
    print(f"{city}: {len(rows)} Overture places in the box")
    return rows


def main():
    rel = "latest"
    for city, (s, w, n, e) in CITIES.items():
        fn = f"data/v3/{city}-places.json"
        try:
            data = json.load(open(fn, encoding="utf-8"))
        except FileNotFoundError:
            data = {"updated": None, "p": []}
        osm = [p for p in data["p"] if len(p) < 7 or p[6] != "o"]
        grid = {}
        def cell(la, lo): return (round(la * 500), round(lo * 500))  # ~220 m cells
        for p in osm:
            grid.setdefault(cell(p[1], p[2]), []).append((norm(p[0]), p[1], p[2]))
        try:
            rows = fetch_city_rows(city, (s, w, n, e))
        except Exception as ex:
            print(f'{city}: Overture download failed: {ex}')
            continue
        mine = [r for r in rows if s <= r[4] <= n and w <= r[3] <= e]
        mine.sort(key=lambda r: -(r[2] or 0))
        added = []
        for name, cat, conf, lon, lat, addr in mine:
            nm = name.strip()
            if len(nm) < 2:
                continue
            k = norm(nm)
            ca, co = cell(lat, lon)
            dup = False
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for (n2, a2, o2) in grid.get((ca + dx, co + dy), []):
                        if n2 == k and dist_m(lat, lon, a2, o2) < 250:
                            dup = True
            if dup:
                continue
            grid.setdefault((ca, co), []).append((k, lat, lon))
            street = 0
            if addr:
                street = addr.split(",")[0].strip()[:60] or 0
            added.append([nm, round(lat, 5), round(lon, 5), type_of(cat), 0, street, "o"])
            if len(added) >= MAX_PER_CITY:
                break
        data["p"] = osm + added
        data["overture"] = {"release": rel, "count": len(added)}
        os.makedirs("data/v3", exist_ok=True)
        json.dump(data, open(fn, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        by = {}
        for p in added:
            by[p[3]] = by.get(p[3], 0) + 1
        print(f"{city}: {len(osm)} OpenStreetMap + {len(added)} Overture places {json.dumps(by)}")


if __name__ == "__main__":
    sys.exit(main())
