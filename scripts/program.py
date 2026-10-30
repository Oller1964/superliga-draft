#!/usr/bin/env python3
"""
Sæsonens kampprogram med resultater og hændelser til Kampe-siden: data/program.json.

Bruges sådan (fra repoets rod):
    python3 scripts/program.py --program program_raa.json     hele sæsonprogrammet (tirsdag/torsdag)
    python3 scripts/program.py --kampe kampe_detaljer.json    resultat og hændelser for spillede kampe (live-point)

program_raa.json  [{"runde": 13, "hjemme": "LBK", "ude": "RFC", "tid": "2026-10-30T18:00:00Z" eller "2026-10-30" eller null,
                    "res": [2, 1] eller null}, ...]
                  Erstatter programmet (runder, tider, resultater). Hændelser, der allerede er gemt, beholdes.
kampe_detaljer.json  [{"hjemme": "LBK", "ude": "RFC", "res": [2, 1],
                       "haendelser": [{"min": 12, "type": "maal", "klub": "LBK", "spiller": "Navn", "assist": "Navn"}, ...]}, ...]
                  type: maal, straffe, selvmaal, gult, roedt, gultroedt. "assist" kun ved mål (eller null).
                  Kampen findes i programmet som det seneste opgør mellem de to hold, der er startet.

data/program.json  {"opdateret": "...", "runder": [{"nr": 13, "kampe": [{"hjemme", "ude", "tid", "res", "haendelser"}]}]}
"""
import argparse, json, os, re, sys
from datetime import datetime, timezone

TYPER = {"maal", "straffe", "selvmaal", "gult", "roedt", "gultroedt"}


def klubkoder(data):
    priser = json.load(open(os.path.join(data, "priser.json"), encoding="utf-8"))
    return {r[4] for r in priser["spillere"]}


def ret_tid(t):
    if not t:
        return None
    t = str(t).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", t):
        return t  # kun dato, tidspunkt ikke fastsat
    try:
        return datetime.strptime(t.replace(".000", ""), "%Y-%m-%dT%H:%M:%SZ").strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def ret_res(r):
    if isinstance(r, (list, tuple)) and len(r) == 2 and all(isinstance(x, (int, float)) and x >= 0 for x in r):
        return [int(r[0]), int(r[1])]
    return None


def tid_ms(t):
    if not t:
        return None
    try:
        return datetime.strptime(t if "T" in t else t + "T00:00:00Z", "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--program")
    ap.add_argument("--kampe")
    ap.add_argument("--data", default="data")
    args = ap.parse_args()
    if not args.program and not args.kampe:
        ap.error("brug --program og/eller --kampe")

    fil = os.path.join(args.data, "program.json")
    prog = json.load(open(fil, encoding="utf-8")) if os.path.exists(fil) else {"opdateret": None, "runder": []}
    koder = klubkoder(args.data)
    fejl, rapport = [], {}

    if args.program:
        gemt = {}
        for rd in prog["runder"]:
            for k in rd["kampe"]:
                if k.get("haendelser"):
                    gemt[(rd["nr"], k["hjemme"], k["ude"])] = k["haendelser"]
        runder = {}
        for k in json.load(open(args.program, encoding="utf-8")):
            h, u = str(k.get("hjemme", "")).upper(), str(k.get("ude", "")).upper()
            try:
                nr = int(k.get("runde"))
            except (TypeError, ValueError):
                nr = None
            if h not in koder or u not in koder or not nr:
                fejl.append(k)
                continue
            kamp = {"hjemme": h, "ude": u, "tid": ret_tid(k.get("tid")), "res": ret_res(k.get("res")),
                    "haendelser": gemt.get((nr, h, u))}
            runder.setdefault(nr, []).append(kamp)
        if len(runder) < 2:
            print(json.dumps({"fejl": "Programmet har under 2 runder – intet skrevet.", "afvist": fejl}, ensure_ascii=False))
            sys.exit(1)
        prog["runder"] = [{"nr": nr, "kampe": sorted(ks, key=lambda x: (x["tid"] or "9", x["hjemme"]))}
                          for nr, ks in sorted(runder.items())]
        rapport["runder"] = len(runder)
        rapport["kampe"] = sum(len(v) for v in runder.values())

    if args.kampe:
        nu = datetime.now(timezone.utc).timestamp()
        opdateret = []
        for d in json.load(open(args.kampe, encoding="utf-8")):
            h, u = str(d.get("hjemme", "")).upper(), str(d.get("ude", "")).upper()
            kandidater = [k for rd in prog["runder"] for k in rd["kampe"]
                          if k["hjemme"] == h and k["ude"] == u and (tid_ms(k["tid"]) or 0) <= nu + 3600]
            if not kandidater:
                fejl.append({"hjemme": h, "ude": u, "grund": "ikke i programmet"})
                continue
            kamp = max(kandidater, key=lambda k: tid_ms(k["tid"]) or 0)
            res = ret_res(d.get("res"))
            if res:
                kamp["res"] = res
            hl = []
            for e in d.get("haendelser") or []:
                typ, klub = str(e.get("type", "")).lower(), str(e.get("klub", "")).upper()
                if typ not in TYPER or klub not in (h, u) or not e.get("spiller"):
                    fejl.append({"kamp": h + "-" + u, "haendelse": e})
                    continue
                try:
                    mi = int(e.get("min")) if e.get("min") not in (None, "") else None
                except (TypeError, ValueError):
                    mi = None
                ny = {"min": mi, "type": typ, "klub": klub, "spiller": str(e["spiller"]).strip()}
                if typ in ("maal", "straffe") and e.get("assist"):
                    ny["assist"] = str(e["assist"]).strip()
                hl.append(ny)
            hl.sort(key=lambda e: (e["min"] is None, e["min"] or 0))
            kamp["haendelser"] = hl
            opdateret.append(h + "-" + u + (" %d-%d" % tuple(kamp["res"]) if kamp["res"] else ""))
        rapport["kampe_opdateret"] = opdateret

    prog["opdateret"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    json.dump(prog, open(fil, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    rapport["afvist"] = fejl
    print(json.dumps(rapport, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
