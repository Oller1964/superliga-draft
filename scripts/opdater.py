#!/usr/bin/env python3
"""
Ugentlig opdatering af Superliga Draft.

Bruges sådan (fra repoets rod):
    python3 scripts/opdater.py --stats stats/ --resultater resultater.json

stats/<KLUB>.csv   én linje pr. spiller i truppen:  navn;pos;kampe;mål;assists;gule;røde;minutter
                   pos må være MÅ/FO/MI/AN eller GK/DF/MF/FW. KLUB er klubkoden (AGF, BIF, FCK ...).
                   Mangler en klub, beholdes dens spillere uændret til næste uge.
resultater.json    {"FCK": 0, "AGF": 2, ...}  mål lukket ind i rundens kamp(e) – bruges til clean sheets.

Scriptet
 1. regner rundens tal ud som forskellen mellem nye og gamle sæsontal og tilføjer runden til data/runder.json
    (kun hvis der er spillet noget siden sidst),
 2. beregner nye priser (højst ±0,5 mio. pr. uge) og skriver data/priser.json,
 3. skriver en kort opsummering som JSON på stdout.
"""
import argparse, json, os, re, sys, unicodedata
from datetime import datetime, timezone

POSKODE = {"MÅ": "MM", "MA": "MM", "GK": "MM", "FO": "FOR", "DF": "FOR", "MI": "MID", "MF": "MID", "AN": "ANG", "FW": "ANG"}
INTERVAL = {"MM": (4.0, 8.5), "FOR": (4.0, 9.5), "MID": (4.5, 12.0), "ANG": (4.5, 13.0)}
MAALPOINT = {"MM": 6, "FOR": 6, "MID": 5, "ANG": 4}


def norm(s):
    s = s.replace("ð", "d").replace("Ð", "D").replace("þ", "th").replace("Þ", "Th")
    s = s.replace("ø", "o").replace("Ø", "O").replace("æ", "ae").replace("Æ", "Ae").replace("å", "a").replace("Å", "A")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z ]", "", s).strip()


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", norm(s).replace(" ", "-")).strip("-")


def laes_stats(mappe):
    alle = {}
    for fil in sorted(os.listdir(mappe)):
        if not fil.lower().endswith(".csv"):
            continue
        klub = fil[:-4].upper()
        raekker = []
        for linje in open(os.path.join(mappe, fil), encoding="utf-8"):
            linje = linje.strip()
            if not linje or linje.startswith("#"):
                continue
            dele = [d.strip() for d in linje.split(";")]
            if len(dele) < 8:
                continue
            pos = POSKODE.get(dele[1].split(",")[0].upper())
            if not pos:
                continue
            tal = [int(float(x or 0)) for x in dele[2:8]]
            raekker.append({"navn": dele[0], "pos": pos, "k": tal[0], "g": tal[1], "a": tal[2], "y": tal[3], "r": tal[4], "min": tal[5]})
        if raekker:
            alle[klub] = raekker
    return alle


def find(raekke, kandidater):
    fuld = norm((raekke[1] + " " + raekke[2]).strip())
    for s in kandidater:
        if norm(s["navn"]) == fuld:
            return s
    for s in kandidater:
        ns = norm(s["navn"])
        if fuld and ns and (fuld in ns or ns in fuld):
            return s
    efter = norm(raekke[2]).split()
    if efter:
        m = [s for s in kandidater if norm(s["navn"]).split()[-1:] == efter[-1:]]
        if len(m) == 1:
            return m[0]
    return None


def split_navn(navn):
    dele = navn.split()
    return (" ".join(dele[:-1]), dele[-1]) if len(dele) > 1 else ("", navn)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats", required=True)
    ap.add_argument("--resultater", default=None)
    ap.add_argument("--data", default="data")
    ap.add_argument("--nulstil", action="store_true", help="sæt alle priser direkte til modelprisen (kun til opstart)")
    args = ap.parse_args()

    priser = json.load(open(os.path.join(args.data, "priser.json"), encoding="utf-8"))
    runder_fil = os.path.join(args.data, "runder.json")
    runder = json.load(open(runder_fil, encoding="utf-8")) if os.path.exists(runder_fil) else {"runder": []}
    resultater = json.load(open(args.resultater, encoding="utf-8")) if args.resultater else {}
    stats = laes_stats(args.stats)

    gamle = priser["spillere"]  # [id, fornavn, efternavn, pos, klub, pris, forrige, k, g, a, min, gule, røde]
    nye, delta, brugte = [], {}, set()
    fjernet, tilfoejet, uden_tal = [], [], []

    for klub in sorted({r[4] for r in gamle} | set(stats)):
        kandidater = stats.get(klub)
        egne = [r for r in gamle if r[4] == klub]
        if kandidater is None:
            uden_tal.append(klub)
            nye.extend([list(r) for r in egne])  # uændret, så tallene kommer med næste uge
            continue
        for r in egne:
            s = find(r, [k for k in kandidater if id(k) not in brugte])
            if not s:
                fjernet.append(r[1] + " " + r[2] + " (" + klub + ")")
                continue
            brugte.add(id(s))
            gammel = {"min": r[10], "g": r[8], "a": r[9], "y": r[11] if len(r) > 11 else 0, "r": r[12] if len(r) > 12 else 0}
            d = [max(0, s["min"] - gammel["min"]), max(0, s["g"] - gammel["g"]), max(0, s["a"] - gammel["a"]),
                 max(0, s["y"] - gammel["y"]), max(0, s["r"] - gammel["r"])]
            if any(d):
                delta[r[0]] = d
            nye.append([r[0], r[1], r[2], r[3], klub, r[5], r[6], s["k"], s["g"], s["a"], s["min"], s["y"], s["r"]])
        for s in kandidater:
            if id(s) in brugte:
                continue
            f, e = split_navn(s["navn"])
            pid = klub.lower() + "-" + slug(s["navn"])
            if any(x[0] == pid for x in nye):
                pid += "-2"
            nye.append([pid, f, e, s["pos"], klub, None, None, s["k"], s["g"], s["a"], s["min"], s["y"], s["r"]])
            tilfoejet.append(s["navn"] + " (" + klub + ")")

    # ---- 1. Runden ----
    nu = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    ny_runde = None
    if delta:
        ny_runde = {"id": nu[:10], "skrevet": nu, "spillere": delta,
                    "modtaget": {k.upper(): int(v) for k, v in resultater.items()}}
        if any(x["id"] == ny_runde["id"] for x in runder["runder"]):
            ny_runde["id"] += "-" + nu[11:16].replace(":", "")
        runder["runder"].append(ny_runde)

    # ---- 2. Priser ----
    holdmax = {}
    for r in nye:
        holdmax[r[4]] = max(holdmax.get(r[4], 0), r[10])
    vaerdi = {}
    for r in nye:
        pos, mi, g, a, y, rd = r[3], r[10], r[8], r[9], r[11], r[12]
        k90 = mi / 90
        point = 2 * k90 + MAALPOINT[pos] * g + 3 * a - y - 3 * rd + (k90 if pos in ("MM", "FOR") else 0)
        rate = (point + 3) / (k90 + 3)
        andel = mi / (holdmax[r[4]] or 1)
        vaerdi[r[0]] = 0.55 * rate + 2.2 * andel
    steg, faldt = [], []
    for pos, (lo, hi) in INTERVAL.items():
        grp = sorted([r for r in nye if r[3] == pos], key=lambda r: (vaerdi[r[0]], r[0]))
        # Spillere med præcis samme værdi (fx ingen minutter) får samme placering og dermed samme pris
        foerste = {}
        for i, r in enumerate(grp):
            foerste.setdefault(round(vaerdi[r[0]], 9), i)
        for i, r in enumerate(grp):
            plads = foerste[round(vaerdi[r[0]], 9)]
            pct = plads / (len(grp) - 1) if len(grp) > 1 else 0
            maal = round((lo + (hi - lo) * pct ** 2.2) * 2) / 2
            gammel = r[5]
            if args.nulstil:
                r[5], r[6] = maal, None
            elif gammel is None:
                r[5], r[6] = maal, None
            else:
                ny = gammel + 0.5 if maal > gammel else gammel - 0.5 if maal < gammel else gammel
                ny = min(hi, max(lo, ny))
                r[5], r[6] = ny, gammel
                if ny > gammel:
                    steg.append((ny - gammel, r))
                elif ny < gammel:
                    faldt.append((gammel - ny, r))

    if len(nye) < 250:
        print(json.dumps({"fejl": "Kun %d spillere – intet skrevet." % len(nye)}, ensure_ascii=False))
        sys.exit(1)

    priser = {"opdateret": nu[:10], "kilde": "superstats.dk (Sønderjyske: fbref.com)", "spillere": nye}
    json.dump(priser, open(os.path.join(args.data, "priser.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump(runder, open(runder_fil, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

    def navn(r): return (r[1] + " " + r[2]).strip() + " (" + r[4] + ")"
    print(json.dumps({
        "runde_registreret": bool(ny_runde),
        "spillere_med_tal_i_runden": len(delta),
        "priser_steg": len(steg), "priser_faldt": len(faldt),
        "stoerste_stigninger": [navn(r) + " " + str(r[5]) for _, r in sorted(steg, key=lambda x: -x[0])[:5]],
        "stoerste_fald": [navn(r) + " " + str(r[5]) for _, r in sorted(faldt, key=lambda x: -x[0])[:5]],
        "nye_spillere": tilfoejet, "fjernede_spillere": fjernet, "klubber_uden_tal": uden_tal,
        "antal_spillere": len(nye)
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
