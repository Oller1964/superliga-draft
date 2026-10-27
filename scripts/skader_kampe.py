#!/usr/bin/env python3
"""
Skriver data/skader.json og data/kampe.json til Superliga Draft.

Bruges sådan (fra repoets rod, efter scripts/opdater.py om tirsdagen):
    python3 scripts/skader_kampe.py --skader skader_raa.json --kampe kampe_raa.json

skader_raa.json  [{"klub": "FCK", "navn": "Fornavn Efternavn", "status": "skadet|tvivl|karantaene",
                   "grund": "Knæ", "retur": "2026-11-10" eller null}, ...]
                 Listen skal dække alle klubber, der er tjekket. Spillere, der ikke står på listen, regnes for klar.
kampe_raa.json   [{"hjemme": "FCK", "ude": "AGF", "tid": "2026-11-02T15:00:00Z"}, ...]  (næste runde, UTC)

Begge filer er valgfrie: udelades en, røres den tilsvarende datafil ikke.
Karantæne efter rødt kort i den seneste registrerede runde (data/runder.json) lægges automatisk til.
"""
import argparse, json, os, sys
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from opdater import norm  # noqa: E402

KLUBKODER = {"AGF", "BIF", "FCK", "ACH", "LBK", "FCM", "FCN", "OB", "RFC", "SIF", "SJE", "VFF"}
STATUS = {"skadet", "tvivl", "karantaene"}


def match(navn, kandidater):
    n = norm(navn)
    fulde = [(norm((r[1] + " " + r[2]).strip()), r) for r in kandidater]
    for f, r in fulde:
        if f == n:
            return r
    m = [r for f, r in fulde if n and f and (n in f or f in n)]
    if len(m) == 1:
        return m[0]
    efter = n.split()[-1:] if n else []
    m = [r for f, r in fulde if f.split()[-1:] == efter]
    return m[0] if len(m) == 1 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skader", default=None)
    ap.add_argument("--kampe", default=None)
    ap.add_argument("--data", default="data")
    args = ap.parse_args()

    nu = datetime.now(timezone.utc)
    spillere = json.load(open(os.path.join(args.data, "priser.json"), encoding="utf-8"))["spillere"]
    ud = {}

    if args.skader:
        raa = json.load(open(args.skader, encoding="utf-8"))
        res, ukendte = {}, []
        for x in raa:
            klub = str(x.get("klub", "")).upper()
            status = str(x.get("status", "")).lower()
            if klub not in KLUBKODER or status not in STATUS:
                ukendte.append(x.get("navn", "?") + " (" + klub + ", " + status + ")")
                continue
            r = match(x.get("navn", ""), [s for s in spillere if s[4] == klub])
            if not r:
                ukendte.append(x.get("navn", "?") + " (" + klub + ")")
                continue
            res[r[0]] = {"status": status, "grund": x.get("grund") or None, "retur": x.get("retur") or None}

        # Rødt kort i seneste runde = karantæne i næste kamp (DBU: mindst én kamp)
        runder_fil = os.path.join(args.data, "runder.json")
        roede = []
        if os.path.exists(runder_fil):
            runder = json.load(open(runder_fil, encoding="utf-8")).get("runder", [])
            if runder:
                seneste = max(runder, key=lambda r: r["skrevet"])
                skrevet = datetime.fromisoformat(seneste["skrevet"].replace("Z", "+00:00"))
                if nu - skrevet < timedelta(days=10):
                    for pid, d in seneste["spillere"].items():
                        if len(d) > 4 and d[4] > 0:
                            roede.append(pid)
                            if res.get(pid, {}).get("status") != "skadet":
                                res[pid] = {"status": "karantaene", "grund": "Rødt kort i sidste runde", "retur": None}

        json.dump({"opdateret": nu.strftime("%Y-%m-%d"), "kilde": "skadelister pr. klub + røde kort", "spillere": res},
                  open(os.path.join(args.data, "skader.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        ud["skader"] = {"antal": len(res), "roede_kort": roede, "ikke_fundet": ukendte}

    if args.kampe:
        raa = json.load(open(args.kampe, encoding="utf-8"))
        kampe, fejl = [], []
        for k in raa:
            h, u = str(k.get("hjemme", "")).upper(), str(k.get("ude", "")).upper()
            try:
                t = datetime.fromisoformat(str(k.get("tid", "")).replace("Z", "+00:00")).astimezone(timezone.utc)
            except ValueError:
                t = None
            if h not in KLUBKODER or u not in KLUBKODER or h == u or not t:
                fejl.append(k)
                continue
            kampe.append({"hjemme": h, "ude": u, "tid": t.strftime("%Y-%m-%dT%H:%M:%SZ")})
        kampe.sort(key=lambda k: k["tid"])
        if kampe:
            json.dump({"opdateret": nu.strftime("%Y-%m-%d"), "kampe": kampe},
                      open(os.path.join(args.data, "kampe.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        ud["kampe"] = {"antal": len(kampe), "fejl": fejl, "skrevet": bool(kampe)}

    print(json.dumps(ud, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
