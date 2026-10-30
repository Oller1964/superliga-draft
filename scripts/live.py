#!/usr/bin/env python3
"""
Foreløbige point i løbet af runden (live-point).

Bruges sådan (fra repoets rod):
    python3 scripts/live.py --stats stats/ --resultater resultater.json

Samme inputfiler som opdater.py. Scriptet regner rundens tal ud indtil nu som forskellen
mellem de nye sæsontal og dem i data/priser.json og skriver dem til data/live.json.
Det rører IKKE priser.json eller runder.json, så tirsdagens rigtige opdatering er uændret.
Appen viser live-point for ugens hold, indtil tirsdagens runde er registreret.

    python3 scripts/live.py --nulstil     tømmer data/live.json (bruges tirsdag)
"""
import argparse, json, os, sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from opdater import laes_stats, find  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats")
    ap.add_argument("--resultater", default=None)
    ap.add_argument("--data", default="data")
    ap.add_argument("--nulstil", action="store_true")
    args = ap.parse_args()
    live_fil = os.path.join(args.data, "live.json")

    if args.nulstil:
        json.dump({"skrevet": None, "spillere": {}, "modtaget": {}}, open(live_fil, "w", encoding="utf-8"))
        print(json.dumps({"live_nulstillet": True}, ensure_ascii=False))
        return
    if not args.stats:
        ap.error("--stats mangler")

    priser = json.load(open(os.path.join(args.data, "priser.json"), encoding="utf-8"))
    resultater = json.load(open(args.resultater, encoding="utf-8")) if args.resultater else {}
    stats = laes_stats(args.stats)
    gamle = priser["spillere"]  # [id, fornavn, efternavn, pos, klub, pris, forrige, k, g, a, min, gule, røde]

    delta, uden_tal = {}, []
    for klub in sorted({r[4] for r in gamle}):
        kandidater = stats.get(klub)
        if kandidater is None:
            uden_tal.append(klub)
            continue
        brugte = set()
        for r in [r for r in gamle if r[4] == klub]:
            s = find(r, [k for k in kandidater if id(k) not in brugte])
            if not s:
                continue
            brugte.add(id(s))
            d = [max(0, s["min"] - r[10]), max(0, s["g"] - r[8]), max(0, s["a"] - r[9]),
                 max(0, s["y"] - (r[11] if len(r) > 11 else 0)), max(0, s["r"] - (r[12] if len(r) > 12 else 0))]
            if any(d):
                delta[r[0]] = d

    nu = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    live = {"skrevet": nu, "spillere": delta, "modtaget": {k.upper(): int(v) for k, v in resultater.items()}}
    json.dump(live, open(live_fil, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(json.dumps({"spillere_med_tal": len(delta), "klubber_med_resultat": sorted(live["modtaget"]),
                      "klubber_uden_tal": uden_tal}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
