// =====================================================
//  SUPERLIGA DRAFT – web-app (Firebase)
//
//  Firestore:
//   liga/info              { navn, ejer, drafttype }
//   medlemmer/<uid>        { holdnavn, navn, tilmeldt }
//   uger/<nr>              { nr, type, start, deadline, raekkefoelge, budget, sekPrPick, antalPicks }
//   uger/<nr>/picks/<k>    { nr, uid, spillerId, pos, klub, pris, tid, auto }
//   uger/<nr>/klar/<uid>   { tid }
//   uger/<nr>/kaptajn/<uid> { spillerId, tid (servertid) }
//
//  Filer i repoet (opdateres hver tirsdag):
//   data/priser.json       priser + sæsontal
//   data/runder.json       { runder: [{ id, skrevet, spillere: {id: [min, mål, ass, gule, røde]}, modtaget: {klub: mål} }] }
//   data/kampe.json        { opdateret, kampe: [{ hjemme, ude, tid }] }      (næste runde)
//   data/skader.json       { opdateret, spillere: { id: { status: skadet|tvivl|karantaene, grund, retur } } }
// =====================================================

var KLUBBER = {
  AGF: "AGF", BIF: "Brøndby IF", FCK: "FC København", ACH: "AC Horsens",
  LBK: "Lyngby BK", FCM: "FC Midtjylland", FCN: "FC Nordsjælland", OB: "OB",
  RFC: "Randers FC", SIF: "Silkeborg IF", SJE: "Sønderjyske", VFF: "Viborg FF"
};
var POSITIONER = { MM: "Målmand", FOR: "Forsvar", MID: "Midtbane", ANG: "Angreb" };
var POS_RAEKKE = ["MM", "FOR", "MID", "ANG"];
var KVOTE = { MM: 1, FOR: 2, MID: 2, ANG: 2 };
var SPILLERE_PR_HOLD = 7;
var BUDGET_FAKTOR = 1.35;
var MAALPOINT = { MM: 6, FOR: 6, MID: 5, ANG: 4 };
var CSPOINT = { MM: 4, FOR: 4, MID: 1, ANG: 0 };

// Baggrundens små lys: SVG'en sættes direkte ind i siden, så browseren kun flytter prikkerne
(function () {
  try {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    fetch(window.innerWidth < 600 ? "grafik/topo_lys_mobil.svg" : "grafik/topo_lys.svg")
      .then(function (r) { return r.ok ? r.text() : ""; })
      .then(function (t) { if (t.indexOf("<svg") === 0) document.getElementById("lysLag").innerHTML = t; })
      .catch(function () {});
  } catch (e) {}
})();

firebase.initializeApp(window.FIREBASE_CONFIG);
var auth = firebase.auth();
var db = firebase.firestore();

var MIG = null, MIT_NAVN = "", ER_EJER = false;
var LIGA = null;            // id på den liga, der er åben
var MINE_LIGAER = [];       // [{ id, navn }]
function ligaDoc(sti) { return db.doc("ligaer/" + LIGA + "/" + sti); }
function ligaCol(sti) { return db.collection("ligaer/" + LIGA + "/" + sti); }
var D = { spillere: [], efterId: {}, prisDato: null, info: null, infoHentet: false, medlemmer: {},
  uger: {}, picks: [], klar: {}, runderListe: [], runder: {}, live: null, program: null, kampe: {}, kampeDato: null, skader: {}, skaderDato: null, kaptajner: {}, kampeListe: [], plan: tomPlan(), planer: {} };
function tomPlan() { var p = []; for (var i = 0; i < SPILLERE_PR_HOLD * MOCK_ANTAL; i++) p.push(""); return p; }
var aktivUgeNr = null, picksUnsub = null, klarUnsub = null, kaptajnUnsub = null, lyttere = [];
var tidligereKaptajner = {};
var kaptajnTilstand = false;
var aabenHistorik = null;
var MOCK_ANTAL = 3;           // ønsker pr. valg i mock draften
var planSlot = null;          // { r, c } når spillervælgeren bruges til mock draften
var valgt = null, filterPos = "ALLE";
var tidligerePicks = {};
var arbejder = false;
var opretKonto = false;

var $ = function (id) { return document.getElementById(id); };
function esc(t) {
  return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
// Formtal 0-100 ud fra spillerens værdi (4,0-13,0) – opdateres hver tirsdag ud fra kampe, minutter, mål, assists og kort
function form(v) { return Math.max(0, Math.min(100, Math.round((v - 4) / 9 * 100))); }

// ---------- Trøjer i klubbernes hjemmebanefarver (krop, ærmer/krave, evt. striber) ----------
var TROEJER = {
  FCK: { krop: "#ffffff", kant: "#0b3d91" },
  BIF: { krop: "#ffd200", kant: "#0a2c74" },
  FCM: { krop: "#111111", kant: "#d4001f" },
  AGF: { krop: "#ffffff", kant: "#0055a5" },
  FCN: { krop: "#e2001a", kant: "#ffffff" },
  OB:  { krop: "#ffffff", kant: "#005dab", striber: "#005dab" },
  RFC: { krop: "#0066b3", kant: "#ffffff" },
  SIF: { krop: "#c8102e", kant: "#ffffff" },
  SJE: { krop: "#4fa3db", kant: "#ffffff" },
  VFF: { krop: "#00843d", kant: "#ffffff" },
  ACH: { krop: "#ffd400", kant: "#111111" },
  LBK: { krop: "#1e4ba0", kant: "#ffffff" }
};
function troeje(klub, str) {
  var t = TROEJER[klub] || { krop: "#7d8aa0", kant: "#ffffff" };
  str = str || 18;
  var krop = "M7 3 L4 4.5 L1.5 9 L4.5 10.5 L5.5 9 L5.5 21 L18.5 21 L18.5 9 L19.5 10.5 L22.5 9 L20 4.5 L17 3 C16 5 14.3 6 12 6 C9.7 6 8 5 7 3 Z";
  var striber = t.striber ?
    '<clipPath id="k' + klub + '"><path d="' + krop + '"/></clipPath><g clip-path="url(#k' + klub + ')" fill="' + t.striber + '">' +
    '<rect x="7.2" y="0" width="2.2" height="24"/><rect x="11" y="0" width="2.2" height="24"/><rect x="14.8" y="0" width="2.2" height="24"/></g>' : "";
  return '<svg class="troeje" width="' + str + '" height="' + str + '" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="' + krop + '" fill="' + t.krop + '" stroke="rgba(255,255,255,.55)" stroke-width="0.9" stroke-linejoin="round"/>' + striber +
    '<path d="M1.5 9 L4 4.5 L7 3 L5.5 9 L4.5 10.5 Z M22.5 9 L20 4.5 L17 3 L18.5 9 L19.5 10.5 Z" fill="' + t.kant + '" opacity=".95"/>' +
    '<path d="M7 3 C8 5 9.7 6 12 6 C14.3 6 16 5 17 3" fill="none" stroke="' + t.kant + '" stroke-width="1.6"/>' +
    '</svg>';
}

function fuldtNavn(s) { return (s.fornavn ? s.fornavn + " " : "") + s.efternavn; }
function initialer(s) { return ((s.fornavn ? s.fornavn[0] : "") + s.efternavn[0]).toUpperCase(); }

// ---------- Tid i dansk tidszone ----------
function kbhDele(ms) {
  var f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false });
  var o = {};
  f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, wd: o.weekday };
}
function kbhTilMs(y, m, d, h) {
  var gaet = Date.UTC(y, m - 1, d, h);
  var dele = kbhDele(gaet);
  var vist = Date.UTC(dele.y, dele.m - 1, dele.d, dele.h, dele.min);
  return gaet - (vist - gaet);
}
function naesteFredag18(fraMs) {
  for (var i = 0; i < 9; i++) {
    var dag = kbhDele(fraMs + i * 86400000);
    if (dag.wd === "Fri") {
      var t = kbhTilMs(dag.y, dag.m, dag.d, 18);
      if (t > fraMs + 3600000) return t;
    }
  }
  return fraMs + 4 * 86400000;
}
function visTid(ms) {
  var d = kbhDele(ms);
  var dage = { Mon: "man.", Tue: "tirs.", Wed: "ons.", Thu: "tors.", Fri: "fre.", Sat: "lør.", Sun: "søn." };
  return dage[d.wd] + " " + d.d + "/" + d.m + " kl. " + d.h + "." + ("0" + d.min).slice(-2);
}
function visVarighed(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  var t = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sek = s % 60;
  if (t >= 24) return Math.floor(t / 24) + "d " + (t % 24) + "t";
  if (t > 0) return t + ":" + ("0" + m).slice(-2) + ":" + ("0" + sek).slice(-2);
  return m + ":" + ("0" + sek).slice(-2);
}

// ---------- Ugens kampe og skader (fra data/kampe.json og data/skader.json) ----------
var DAGE_KORT = { Mon: "man", Tue: "tirs", Wed: "ons", Thu: "tors", Fri: "fre", Sat: "lør", Sun: "søn" };
function naesteKamp(klub) { return D.kampe[klub] || null; }
function kortKampTid(ms) { var d = kbhDele(ms); return DAGE_KORT[d.wd] + " " + d.h + "." + ("0" + d.min).slice(-2); }
function kampDato(ms, medTid) {
  var d = kbhDele(ms);
  return DAGE_KORT[d.wd] + " " + d.d + "/" + d.m + (medTid ? " kl. " + d.h + "." + ("0" + d.min).slice(-2) : "");
}
function kampLinje(klub) {
  var k = naesteKamp(klub);
  if (!k) return "";
  return '<div class="kamp">mod <b>' + esc(k.mod) + '</b> (' + (k.hjemme ? "h" : "u") + ')' + (k.tid ? ' · ' + kampDato(k.tid) : "") + '</div>';
}
var SKADE_TEKST = { skadet: "✚ Skadet", tvivl: "? Tvivlsom", karantaene: "■ Karantæne" };
function skadeFor(id) { var x = D.skader[id]; return x && SKADE_TEKST[x.status] ? x : null; }
function skadeBadge(id) {
  var x = skadeFor(id);
  return x ? '<span class="skade' + (x.status === "tvivl" ? " tvivl" : "") + '" title="' + esc(x.grund || "") + '">' + SKADE_TEKST[x.status] + '</span>' : "";
}
function visDato(iso) {
  var t = Date.parse(iso);
  if (isNaN(t)) return null;
  var d = kbhDele(t);
  return d.d + "/" + d.m;
}

// =====================================================
//  LOG IND
// =====================================================
function oversaetFejl(e) {
  var k = (e && e.code) || "";
  if (k === "auth/invalid-credential" || k === "auth/wrong-password" || k === "auth/user-not-found")
    return "E-mail eller kodeord er forkert.";
  if (k === "auth/email-already-in-use") return "Der findes allerede en konto med den e-mail. Log ind i stedet.";
  if (k === "auth/weak-password") return "Kodeordet skal være mindst 6 tegn.";
  if (k === "auth/invalid-email") return "E-mailadressen ser forkert ud.";
  if (k === "auth/popup-closed-by-user" || k === "auth/cancelled-popup-request") return "";
  if (k === "auth/too-many-requests") return "For mange forsøg. Vent lidt, og prøv igen.";
  if (k === "auth/unauthorized-domain") return "Siden er ikke godkendt i Firebase endnu (Authentication → Settings → Authorized domains).";
  return "Det lykkedes ikke: " + ((e && e.message) || "ukendt fejl");
}

function tegnLoginForm() {
  $("loginTitel").textContent = opretKonto ? "Opret konto" : "Log ind";
  $("loginKnap").textContent = opretKonto ? "Opret konto" : "Log ind";
  $("kodeInput").autocomplete = opretKonto ? "new-password" : "current-password";
  $("skiftLogin").textContent = opretKonto ? "Har du allerede en konto? Log ind" : "Har du ikke en konto? Opret en";
  $("glemtKode").hidden = opretKonto;
}

$("skiftLogin").addEventListener("click", function () { opretKonto = !opretKonto; $("loginFejl").textContent = ""; tegnLoginForm(); });

$("loginForm").addEventListener("submit", async function (e) {
  e.preventDefault();
  var mail = $("emailInput").value.trim(), kode = $("kodeInput").value;
  $("loginKnap").disabled = true;
  try {
    if (opretKonto) await auth.createUserWithEmailAndPassword(mail, kode);
    else await auth.signInWithEmailAndPassword(mail, kode);
    $("loginFejl").textContent = "";
  } catch (err) { $("loginFejl").textContent = oversaetFejl(err); }
  $("loginKnap").disabled = false;
});

$("googleKnap").addEventListener("click", async function () {
  var udbyder = new firebase.auth.GoogleAuthProvider();
  try { await auth.signInWithPopup(udbyder); }
  catch (err) {
    if (err && (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment")) {
      auth.signInWithRedirect(udbyder);
    } else $("loginFejl").textContent = oversaetFejl(err);
  }
});

$("glemtKode").addEventListener("click", async function () {
  var mail = $("emailInput").value.trim();
  if (!mail) { $("loginFejl").textContent = "Skriv din e-mail først, så sender vi et link."; return; }
  try { await auth.sendPasswordResetEmail(mail); $("loginFejl").textContent = "Vi har sendt et link til " + mail + ", så du kan vælge et nyt kodeord."; }
  catch (err) { $("loginFejl").textContent = oversaetFejl(err); }
});

$("logUdKnap").addEventListener("click", function () { auth.signOut(); });

// =====================================================
//  POINT
// =====================================================
function rundePoint(spillerId, pos, klub, runde) {
  if (!runde || !runde.spillere) return null;
  var r = runde.spillere[spillerId];
  if (!r) return { min: 0, g: 0, a: 0, y: 0, rd: 0, cs: false, point: 0 };
  var min = r[0], g = r[1], a = r[2], y = r[3], rd = r[4];
  var mod = runde.modtaget ? runde.modtaget[klub] : undefined;
  var cs = min >= 60 && mod === 0;
  var p = (min > 0 ? 1 : 0) + (min >= 60 ? 1 : 0) + g * MAALPOINT[pos] + a * 3 + (cs ? CSPOINT[pos] : 0) - y - 3 * rd;
  return { min: min, g: g, a: a, y: y, rd: rd, cs: cs, point: p };
}

// Kaptajnen tæller kun, hvis han blev valgt inden ugens deadline og er på holdet
function kaptajnFor(ugeNr, uid, picks) {
  var alle = ugeNr === aktivUgeNr ? D.kaptajner : (tidligereKaptajner[ugeNr] || {});
  var k = alle[uid], u = D.uger[ugeNr];
  if (!k || !u) return null;
  var t = k.tid && k.tid.toMillis ? k.tid.toMillis() : null;
  if (t !== null && t > Date.parse(u.deadline)) return null;
  if (picks && !picks.some(function (p) { return p.uid === uid && p.spillerId === k.spillerId; })) return null;
  return k.spillerId;
}
// Live-point (data/live.json) gælder kun den aktive uge, efter deadline og indtil tirsdagens runde er registreret
// Efter deadline og før de første tal er kommet, er runden "live" med 0 point til alle
var TOM_LIVE = { id: "live", live: true, tom: true, skrevet: null, spillere: {}, modtaget: {} };
function liveRunde(ugeNr) {
  var u = D.uger[ugeNr];
  if (!u || ugeNr !== aktivUgeNr || D.runder[ugeNr]) return null;
  var dl = Date.parse(u.deadline);
  if (D.live && D.live.skrevet && Date.parse(D.live.skrevet) > dl) return D.live;
  return Date.now() > dl ? TOM_LIVE : null;
}
function pointRunde(ugeNr) { return D.runder[ugeNr] || liveRunde(ugeNr); }
function spillerPoint(ugeNr, p, picks) {
  var runde = pointRunde(ugeNr);
  if (!runde) return null;
  var r = rundePoint(p.spillerId, p.pos, p.klub, runde);
  var gange = kaptajnFor(ugeNr, p.uid, picks) === p.spillerId ? 2 : 1;
  return { r: r, point: (r ? r.point : 0) * gange, kaptajn: gange === 2 };
}
function ugePointForHold(ugeNr, uid, picks) {
  if (!pointRunde(ugeNr)) return null;
  return picks.filter(function (p) { return p.uid === uid; }).reduce(function (s, p) {
    return s + spillerPoint(ugeNr, p, picks).point;
  }, 0);
}
function picksForUge(nr) { return nr === aktivUgeNr ? D.picks : tidligerePicks[nr]; }
// Færdige uger med point, nyeste først: [{ nr, hold: [{ uid, point }] sorteret, vinder }]
function afgjorteUger() {
  return Object.keys(D.uger).map(Number).filter(function (nr) { return D.runder[nr] && picksForUge(nr); })
    .sort(function (a, b) { return b - a; }).map(function (nr) {
      var picks = picksForUge(nr);
      var hold = (D.uger[nr].raekkefoelge || []).map(function (uid) { return { uid: uid, point: ugePointForHold(nr, uid, picks) || 0 }; })
        .sort(function (a, b) { return b.point - a.point; });
      var vindere = hold.filter(function (h) { return hold.length && h.point === hold[0].point; });
      return { nr: nr, picks: picks, hold: hold, vindere: vindere };
    });
}

// Hver runde (fra data/runder.json) hører til den første uge, hvis deadline lå før rundens tal blev skrevet
function kobRunderTilUger() {
  D.runder = {};
  var brugt = {};
  var numre = Object.keys(D.uger).map(Number).sort(function (a, b) { return a - b; });
  var liste = D.runderListe.slice().sort(function (a, b) { return Date.parse(a.skrevet) - Date.parse(b.skrevet); });
  numre.forEach(function (nr) {
    var dl = Date.parse(D.uger[nr].deadline);
    for (var i = 0; i < liste.length; i++) {
      if (!brugt[liste[i].id] && Date.parse(liste[i].skrevet) > dl) {
        D.runder[nr] = liste[i];
        brugt[liste[i].id] = true;
        break;
      }
    }
  });
}

function stilling() {
  var raekker = {};
  Object.keys(D.medlemmer).forEach(function (uid) { raekker[uid] = { uid: uid, total: 0, runder: 0, sidste: null }; });
  Object.keys(D.uger).map(Number).sort(function (a, b) { return a - b; }).forEach(function (nr) {
    if (!D.runder[nr]) return;
    var picks = picksForUge(nr);
    if (!picks) return;
    (D.uger[nr].raekkefoelge || []).forEach(function (uid) {
      var p = ugePointForHold(nr, uid, picks) || 0;
      if (!raekker[uid]) raekker[uid] = { uid: uid, total: 0, runder: 0, sidste: null };
      raekker[uid].total += p;
      raekker[uid].runder++;
      raekker[uid].sidste = p;
    });
  });
  return Object.keys(raekker).map(function (k) { return raekker[k]; })
    .sort(function (a, b) { return b.total - a.total || holdnavn(a.uid).localeCompare(holdnavn(b.uid), "da"); });
}

function holdnavn(uid) {
  var m = D.medlemmer[uid];
  return (m && m.holdnavn) || "Ukendt hold";
}

// =====================================================
//  UGENS DRAFT – regler
// =====================================================
function aktivUge() { return aktivUgeNr != null ? D.uger[aktivUgeNr] : null; }
function kolVed(k, n) { var r = Math.floor(k / n), p = k % n; return r % 2 === 0 ? p : n - 1 - p; }

function ugeStatus(u, picks, nu) {
  var n = u.raekkefoelge.length, total = n * SPILLERE_PR_HOLD, k = picks.length;
  var deadline = Date.parse(u.deadline);
  var live = u.type === "live";
  var startMs = u.start ? Date.parse(u.start) : deadline;
  if (k >= total) return { faerdig: true, total: total, k: k, deadline: deadline, live: live };
  var turStart = k === 0 ? startMs : Date.parse(picks[k - 1].tid);
  var turSlut = Math.min(turStart + u.sekPrPick * 1000, deadline);
  var kol = kolVed(k, n);
  return { faerdig: false, total: total, k: k, kol: kol, uid: u.raekkefoelge[kol], live: live,
    startMs: startMs, harStart: !!u.start, venter: k === 0 && nu < startMs,
    turStart: turStart, turSlut: turSlut, udloebet: nu >= turSlut, deadline: deadline };
}

function holdPicks(uid, picks) { return picks.filter(function (p) { return p.uid === uid; }); }
function antalPos(uid, pos, picks) { return holdPicks(uid, picks).filter(function (p) { return p.pos === pos; }).length; }
function brugt(uid, picks) { return holdPicks(uid, picks).reduce(function (s, p) { return s + p.pris; }, 0); }
function rest(u, uid, picks) { return u.budget - brugt(uid, picks); }
function taget(picks) { var t = {}; picks.forEach(function (p) { t[p.spillerId] = true; }); return t; }
function maaVaelges(uid, s, picks) { return antalPos(uid, s.pos, picks) < KVOTE[s.pos]; }

function harRaad() { return true; }
function harRaadGammel(u, uid, s, picks) {
  var t = taget(picks), reserve = 0;
  POS_RAEKKE.forEach(function (pos) {
    var mangler = KVOTE[pos] - antalPos(uid, pos, picks) - (pos === s.pos ? 1 : 0);
    if (mangler <= 0) return;
    var billige = D.spillere.filter(function (x) { return x.pos === pos && !t[x.id] && x !== s; })
      .map(function (x) { return x.pris; }).sort(function (a, b) { return a - b; });
    for (var i = 0; i < mangler; i++) reserve += billige[i] !== undefined ? billige[i] : 4;
  });
  return rest(u, uid, picks) - s.pris >= reserve - 0.001;
}

function autoValg(u, uid, picks) {
  var t = taget(picks);
  // Først holdets mock draft: dette valgs 1., 2. og 3. ønske, derefter ønskerne til de næste valg
  var plan = D.planer[uid];
  if (plan) {
    for (var i = holdPicks(uid, picks).length * MOCK_ANTAL; i < plan.length; i++) {
      var o = D.efterId[plan[i]];
      if (o && !t[o.id] && maaVaelges(uid, o, picks)) return o;
    }
  }
  var mulige = D.spillere.filter(function (s) { return !t[s.id] && maaVaelges(uid, s, picks); });
  // Automatisk valg springer spillere over, der står som skadet eller i karantæne
  var raske = mulige.filter(function (s) { var x = skadeFor(s.id); return !x || x.status === "tvivl"; });
  if (raske.length) mulige = raske;
  var raad = mulige.filter(function (s) { return harRaad(u, uid, s, picks); });
  var liste = raad.length ? raad : mulige;
  liste.sort(function (a, b) {
    return raad.length ? (b.pris - a.pris || (a.id < b.id ? -1 : 1)) : (a.pris - b.pris || (a.id < b.id ? -1 : 1));
  });
  return liste[0] || null;
}

function beregnBudget() {
  var sum = 0;
  POS_RAEKKE.forEach(function (pos) {
    var p = D.spillere.filter(function (s) { return s.pos === pos; }).map(function (s) { return s.pris; })
      .sort(function (a, b) { return a - b; });
    if (p.length) sum += p[Math.floor(p.length / 2)] * KVOTE[pos];
  });
  return Math.round(sum * BUDGET_FAKTOR * 2) / 2;
}

function draftform() { return D.info && D.info.drafttype === "live" ? "live" : "uge"; }

// =====================================================
//  SKRIVNING – hvert pick skrives i en transaktion, så to telefoner ikke kan tage samme tur
// =====================================================
function pickDoc(st, s, auto, tid) {
  return { nr: st.k, uid: st.uid, spillerId: s.id, pos: s.pos, klub: s.klub, pris: s.pris, tid: tid, auto: auto };
}

async function skrivPick(u, k, doc) {
  var ugeRef = ligaDoc("uger/" + u.nr);
  await db.runTransaction(async function (t) {
    var snap = await t.get(ugeRef);
    var antal = (snap.data() && snap.data().antalPicks) || 0;
    if (antal !== k) throw new Error("Draften har flyttet sig. Prøv igen.");
    t.set(ligaDoc("uger/" + u.nr + "/picks/" + k), doc);
    t.update(ugeRef, { antalPicks: antal + 1 });
  });
}

async function draftManuelt(s) {
  var u = aktivUge();
  if (!u) return;
  var picks = D.picks;
  var st = ugeStatus(u, picks, Date.now());
  if (st.venter) throw new Error("Draften er ikke startet endnu.");
  if (st.faerdig || st.uid !== MIG) throw new Error("Det er ikke din tur længere.");
  if (st.udloebet) throw new Error("Din tid løb ud, så der er valgt automatisk for dig.");
  if (taget(picks)[s.id]) throw new Error(fuldtNavn(s) + " er lige blevet taget. Vælg en anden.");
  if (!maaVaelges(MIG, s, picks)) throw new Error("Du har allerede nok på den position.");
  if (!harRaad(u, MIG, s, picks)) throw new Error("Du har ikke råd til " + fuldtNavn(s) + ".");
  await skrivPick(u, st.k, pickDoc(st, s, false, new Date().toISOString()));
}

async function indhentUdloebne() {
  var u = aktivUge();
  if (!u || arbejder || !MIG || !D.medlemmer[MIG] || !D.spillere.length) return;
  if ((u.antalPicks || 0) !== D.picks.length) return; // vent til vi har de nyeste picks
  var st = ugeStatus(u, D.picks, Date.now());
  if (st.faerdig || !st.udloebet) return;
  arbejder = true;
  try {
    var picks = D.picks.slice();
    for (var i = 0; i < 100; i++) {
      var s2 = ugeStatus(u, picks, Date.now());
      if (s2.faerdig || !s2.udloebet) break;
      var valg = autoValg(u, s2.uid, picks);
      if (!valg) break;
      var doc = pickDoc(s2, valg, true, new Date(s2.turSlut).toISOString());
      await skrivPick(u, s2.k, doc);
      picks.push(doc);
    }
  } catch (e) { /* en anden telefon var hurtigere – vi prøver igen ved næste tik */ }
  arbejder = false;
}

async function opretUge(nr, raekkefoelge, startMs) {
  var type = draftform();
  var deadline = naesteFredag18(startMs);
  var n = raekkefoelge.length;
  var ref = ligaDoc("uger/" + nr);
  await db.runTransaction(async function (t) {
    var snap = await t.get(ref);
    if (snap.exists) return;
    t.set(ref, {
      nr: nr,
      type: type,
      start: type === "live" ? null : new Date(startMs).toISOString(),
      deadline: new Date(deadline).toISOString(),
      raekkefoelge: raekkefoelge,
      budget: beregnBudget(),
      sekPrPick: type === "live" ? 120 : Math.max(60, Math.floor((deadline - startMs) / 1000 / (n * SPILLERE_PR_HOLD))),
      antalPicks: 0
    });
  });
}

async function saetLiveStart(ms) {
  var u = aktivUge();
  if (!u || u.type !== "live") throw new Error("Ugens draft er ikke en live draft.");
  if (D.picks.length) throw new Error("Draften er allerede i gang.");
  var varighed = u.raekkefoelge.length * SPILLERE_PR_HOLD * u.sekPrPick * 1000;
  if (ms + varighed > Date.parse(u.deadline)) {
    throw new Error("Draften tager op til " + Math.ceil(varighed / 60000) + " minutter og skal være færdig inden " +
      visTid(Date.parse(u.deadline)) + ". Vælg et tidligere tidspunkt.");
  }
  if (ms < Date.now() - 60000) throw new Error("Tidspunktet er allerede passeret.");
  await ligaDoc("uger/" + u.nr).update({ start: new Date(ms).toISOString() });
}

function naesteRaekkefoelge(forrigeNr) {
  var forrige = D.uger[forrigeNr];
  var picks = forrigeNr === aktivUgeNr ? D.picks : (tidligerePicks[forrigeNr] || []);
  var point = {};
  (forrige.raekkefoelge || []).forEach(function (uid) { point[uid] = ugePointForHold(forrigeNr, uid, picks) || 0; });
  var total = {};
  stilling().forEach(function (r) { total[r.uid] = r.total; });
  return Object.keys(D.medlemmer).sort(function (a, b) {
    var pa = point[a] !== undefined ? point[a] : 0, pb = point[b] !== undefined ? point[b] : 0;
    return pa - pb || (total[a] || 0) - (total[b] || 0) || (a < b ? -1 : 1);
  });
}

// Når rundens tal er kommet, starter næste uge – med det tidspunkt tallene kom som start
async function tjekNyUge() {
  var u = aktivUge();
  if (!u || !MIG || !D.medlemmer[MIG] || arbejder) return;
  var runde = D.runder[u.nr];
  if (!runde || Date.now() < Date.parse(u.deadline) || D.uger[u.nr + 1]) return;
  if (Object.keys(D.medlemmer).length < 2) return;
  arbejder = true;
  try {
    var start = Math.max(Date.parse(runde.skrevet), Date.parse(u.deadline));
    await opretUge(u.nr + 1, naesteRaekkefoelge(u.nr), start);
  } catch (e) {}
  arbejder = false;
}

// =====================================================
//  DATA
// =====================================================
async function hentDatafiler() {
  try {
    var r = await fetch("data/priser.json?v=" + Date.now(), { cache: "no-store" });
    if (r.ok) modtagPriser(await r.json());
  } catch (e) { $("tbOpdateret").textContent = "Stats utilgængelige"; }
  try {
    var r2 = await fetch("data/runder.json?v=" + Date.now(), { cache: "no-store" });
    if (r2.ok) { var j = await r2.json(); D.runderListe = j.runder || []; kobRunderTilUger(); }
  } catch (e) {}
  try {
    var r6 = await fetch("data/program.json?v=" + Date.now(), { cache: "no-store" });
    if (r6.ok) { var j6 = await r6.json(); D.program = j6.runder && j6.runder.length ? j6 : null; }
  } catch (e) {}
  try {
    var r5 = await fetch("data/live.json?v=" + Date.now(), { cache: "no-store" });
    if (r5.ok) { D.live = await r5.json(); D.live.id = "live"; D.live.live = true; }
  } catch (e) {}
  try {
    var r3 = await fetch("data/kampe.json?v=" + Date.now(), { cache: "no-store" });
    if (r3.ok) modtagKampe(await r3.json());
  } catch (e) {}
  try {
    var r4 = await fetch("data/skader.json?v=" + Date.now(), { cache: "no-store" });
    if (r4.ok) { var j4 = await r4.json(); D.skader = j4.spillere || {}; D.skaderDato = j4.opdateret || null; }
  } catch (e) {}
  planlaegTegning();
}

function modtagKampe(data) {
  D.kampe = {};
  D.kampeListe = [];
  var nu = Date.now();
  // Kun kampe, der ikke er spillet endnu (med 3 timers margin), så gamle kampe forsvinder af sig selv
  (data.kampe || []).forEach(function (k) {
    var t = Date.parse(k.tid);
    if (!isNaN(t) && t < nu - 3 * 3600000) return;
    D.kampeListe.push({ hjemme: k.hjemme, ude: k.ude, tid: isNaN(t) ? null : t });
    if (!D.kampe[k.hjemme]) D.kampe[k.hjemme] = { mod: k.ude, hjemme: true, tid: isNaN(t) ? null : t };
    if (!D.kampe[k.ude]) D.kampe[k.ude] = { mod: k.hjemme, hjemme: false, tid: isNaN(t) ? null : t };
  });
  D.kampeDato = data.opdateret || null;
}

function modtagPriser(data) {
  if (!data || !Array.isArray(data.spillere)) return;
  D.spillere = data.spillere.map(function (r) {
    return { id: r[0], fornavn: r[1], efternavn: r[2], pos: r[3], klub: r[4], pris: r[5], forrige: r[6],
      k: r[7], g: r[8], a: r[9], min: r[10] };
  });
  D.efterId = {};
  D.spillere.forEach(function (s) { D.efterId[s.id] = s; });
  D.prisDato = data.opdateret;
  var dele = String(data.opdateret || "").split("-");
  $("tbOpdateret").textContent = dele.length === 3 ? "Stats opdateret " + (+dele[2]) + "/" + (+dele[1]) : "";
}

function abonnerPaaUge(nr) {
  if (picksUnsub) picksUnsub();
  if (klarUnsub) klarUnsub();
  if (kaptajnUnsub) kaptajnUnsub();
  D.picks = []; D.klar = {}; D.kaptajner = {}; kaptajnTilstand = false;
  kaptajnUnsub = ligaCol("uger/" + nr + "/kaptajn").onSnapshot(function (qs) {
    D.kaptajner = {};
    qs.docs.forEach(function (d) { D.kaptajner[d.id] = d.data(); });
    planlaegTegning();
  }, function () {});
  picksUnsub = ligaCol("uger/" + nr + "/picks").onSnapshot(function (qs) {
    D.picks = qs.docs.map(function (d) { return d.data(); }).sort(function (a, b) { return a.nr - b.nr; });
    planlaegTegning();
  });
  klarUnsub = ligaCol("uger/" + nr + "/klar").onSnapshot(function (qs) {
    D.klar = {};
    qs.docs.forEach(function (d) { D.klar[d.id] = true; });
    planlaegTegning();
  });
}

async function hentTidligerePicks() {
  var numre = Object.keys(D.uger).map(Number).filter(function (n) { return n !== aktivUgeNr && !tidligerePicks[n]; });
  for (var i = 0; i < numre.length; i++) {
    try {
      var qs = await ligaCol("uger/" + numre[i] + "/picks").get();
      tidligerePicks[numre[i]] = qs.docs.map(function (d) { return d.data(); }).sort(function (a, b) { return a.nr - b.nr; });
    } catch (e) {}
    try {
      var ks = await ligaCol("uger/" + numre[i] + "/kaptajn").get();
      tidligereKaptajner[numre[i]] = {};
      ks.docs.forEach(function (d) { tidligereKaptajner[numre[i]][d.id] = d.data(); });
    } catch (e) {}
  }
  planlaegTegning();
}

function mistetAdgang() {
  // Fx hvis man er fjernet fra ligaen: tilbage til liga-vælgeren
  MINE_LIGAER = MINE_LIGAER.filter(function (l) { return l.id !== LIGA; });
  gemMineLigaer(null);
  lukLiga();
  $("ligaFejl").textContent = "Du har ikke længere adgang til den liga.";
}

function startLyttere() {
  stopLyttere();
  lyttere.push(db.doc("ligaer/" + LIGA).onSnapshot(function (s) {
    D.info = s.exists ? s.data() : null;
    D.infoHentet = true;
    ER_EJER = !!(D.info && D.info.ejer === MIG);
    planlaegTegning();
  }));
  lyttere.push(ligaCol("medlemmer").onSnapshot(function (qs) {
    D.medlemmer = {};
    qs.docs.forEach(function (d) { D.medlemmer[d.id] = d.data(); });
    if (!D.medlemmer[MIG] && qs.docs.length) { mistetAdgang(); return; }
    planlaegTegning();
  }, mistetAdgang));
  // Alle mock drafts hentes, så hvem som helst kan lave det automatiske valg ud fra ejerens ønsker.
  // Appen viser kun din egen.
  lyttere.push(ligaCol("plan").onSnapshot(function (qs) {
    D.planer = {};
    qs.docs.forEach(function (d) {
      var v = Array.isArray(d.data().valg) ? d.data().valg : [];
      D.planer[d.id] = tomPlan().map(function (x, i) { return typeof v[i] === "string" ? v[i] : ""; });
    });
    D.plan = D.planer[MIG] ? D.planer[MIG].slice() : tomPlan();
    planlaegTegning();
  }, function () {}));
  lyttere.push(ligaCol("uger").onSnapshot(function (qs) {
    D.uger = {};
    qs.docs.forEach(function (d) { var x = d.data(); if (x && x.nr) D.uger[x.nr] = x; });
    var numre = Object.keys(D.uger).map(Number);
    var nyeste = numre.length ? Math.max.apply(null, numre) : null;
    kobRunderTilUger();
    if (nyeste !== aktivUgeNr) {
      aktivUgeNr = nyeste;
      if (nyeste != null) abonnerPaaUge(nyeste);
      hentTidligerePicks();
    }
    planlaegTegning();
  }));
}
function stopLyttere() {
  lyttere.forEach(function (f) { f(); });
  lyttere = [];
  if (picksUnsub) picksUnsub();
  if (klarUnsub) klarUnsub();
  if (kaptajnUnsub) kaptajnUnsub();
  picksUnsub = klarUnsub = kaptajnUnsub = null;
  aktivUgeNr = null;
  tidligerePicks = {}; tidligereKaptajner = {}; kaptajnTilstand = false; aabenHistorik = null;
  valgt = null;
  D.medlemmer = {}; D.uger = {}; D.picks = []; D.klar = {}; D.info = null; D.infoHentet = false; D.runder = {}; D.kaptajner = {}; D.plan = tomPlan(); D.planer = {}; planSlot = null;
}

// =====================================================
//  LIGAER: mine, søg, opret, tilmeld
// =====================================================
function ligaId(navn) {
  return navn.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

async function hentMineLigaer() {
  try {
    var s = await db.doc("brugere/" + MIG).get();
    var d = s.exists ? s.data() : {};
    MINE_LIGAER = Array.isArray(d.ligaer) ? d.ligaer : [];
    return d.sidste || null;
  } catch (e) { MINE_LIGAER = []; return null; }
}

async function gemMineLigaer(sidste) {
  try { await db.doc("brugere/" + MIG).set({ ligaer: MINE_LIGAER, sidste: sidste || null }); } catch (e) {}
}

function aabnLiga(id) {
  LIGA = id;
  try { localStorage.setItem("superligaDraftLiga", id); } catch (e) {}
  $("ligaer").hidden = true;
  $("ligaFejl").textContent = "";
  startLyttere();
  kobRunderTilUger();
  gemMineLigaer(id);
  planlaegTegning();
}

function lukLiga() {
  stopLyttere();
  LIGA = null;
  planlaegTegning();
}

function tegnMineLigaer() {
  $("ligaerTitel").textContent = MINE_LIGAER.length ? "Dine ligaer" : "Kom i gang";
  $("mineLigaer").innerHTML = MINE_LIGAER.map(function (l) {
    return '<li><button type="button" class="liga-knap" data-liga="' + esc(l.id) + '"' + (l.id === LIGA ? ' aria-pressed="true"' : "") + '>' +
      '<span><b>' + esc(l.navn) + '</b><br><small>' + (l.id === LIGA ? "Åben nu" : "Åbn ligaen") + '</small></span><span class="pil">›</span></button></li>';
  }).join("");
}

var soegTimer = null;
async function soegLigaer() {
  var q = ligaId($("ligaSoeg").value.trim());
  $("tilmeldForm").hidden = true;
  if (q.length < 2) { $("soegResultater").innerHTML = ""; return; }
  try {
    var qs = await db.collection("ligaer").orderBy("navnSoeg").startAt(q).endAt(q + "").limit(10).get();
    var mine = {};
    MINE_LIGAER.forEach(function (l) { mine[l.id] = true; });
    $("soegResultater").innerHTML = qs.docs.length ? qs.docs.map(function (d) {
      var x = d.data();
      return '<li><button type="button" class="liga-knap" data-find="' + esc(d.id) + '" data-navn="' + esc(x.navn) + '">' +
        '<span><b>' + esc(x.navn) + '</b><br><small>' + (mine[d.id] ? "Du er med" : "Oprettet " + (x.oprettet ? new Date(x.oprettet).toLocaleDateString("da-DK") : "")) + '</small></span>' +
        '<span class="pil">›</span></button></li>';
    }).join("") : '<li class="tom-soeg">Ingen liga hedder sådan. Tjek stavningen, eller opret den selv.</li>';
  } catch (e) {
    $("soegResultater").innerHTML = '<li class="tom-soeg">Søgningen virker ikke lige nu. Prøv igen om lidt.</li>';
  }
}

var valgtLiga = null;
$("ligaSoeg").addEventListener("input", function () { clearTimeout(soegTimer); soegTimer = setTimeout(soegLigaer, 250); });
$("soegResultater").addEventListener("click", function (e) {
  var b = e.target.closest(".liga-knap");
  if (!b) return;
  if (MINE_LIGAER.some(function (l) { return l.id === b.dataset.find; })) { aabnLiga(b.dataset.find); return; }
  valgtLiga = { id: b.dataset.find, navn: b.dataset.navn };
  $("soegResultater").querySelectorAll(".liga-knap").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
  $("tilmeldNavn").textContent = "Gå med i " + valgtLiga.navn;
  $("tilmeldForm").hidden = false;
  $("tilmeldKode").focus();
});
$("mineLigaer").addEventListener("click", function (e) {
  var b = e.target.closest(".liga-knap");
  if (b) aabnLiga(b.dataset.liga);
});
$("ligaFaner").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b) return;
  $("ligaFaner").querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
  $("findFane").hidden = b.dataset.fane !== "find";
  $("opretFane").hidden = b.dataset.fane !== "opret";
  $("ligaFejl").textContent = "";
});

$("tilmeldForm").addEventListener("submit", async function (e) {
  e.preventDefault();
  if (!valgtLiga) return;
  var kode = $("tilmeldKode").value.trim(), hold = $("tilmeldHold").value.trim();
  if (!hold) { $("ligaFejl").textContent = "Skriv dit holdnavn."; return; }
  $("tilmeldKnap").disabled = true;
  try {
    await db.doc("ligaer/" + valgtLiga.id + "/medlemmer/" + MIG).set({
      holdnavn: hold, kode: kode, tilmeldt: new Date().toISOString()
    });
    MINE_LIGAER = MINE_LIGAER.filter(function (l) { return l.id !== valgtLiga.id; }).concat([{ id: valgtLiga.id, navn: valgtLiga.navn }]);
    aabnLiga(valgtLiga.id);
    $("tilmeldForm").reset();
    $("tilmeldForm").hidden = true;
  } catch (err) {
    $("ligaFejl").textContent = "Koden er forkert. Spørg den, der har oprettet ligaen, om den rigtige kode.";
  }
  $("tilmeldKnap").disabled = false;
});

$("opretFane").addEventListener("submit", async function (e) {
  e.preventDefault();
  var navn = $("opretNavn").value.trim(), kode = $("opretKode").value.trim(), hold = $("opretHold").value.trim();
  var id = ligaId(navn);
  if (id.length < 2) { $("ligaFejl").textContent = "Liganavnet skal have mindst 2 bogstaver eller tal."; return; }
  if (kode.length < 4) { $("ligaFejl").textContent = "Koden skal være mindst 4 tegn."; return; }
  if (!hold) { $("ligaFejl").textContent = "Skriv dit holdnavn."; return; }
  $("opretKnap").disabled = true;
  try {
    var findes = await db.doc("ligaer/" + id).get();
    if (findes.exists) throw new Error("taget");
    var batch = db.batch();
    batch.set(db.doc("ligaer/" + id), { navn: navn, navnSoeg: id, ejer: MIG, drafttype: "uge", oprettet: new Date().toISOString() });
    batch.set(db.doc("ligaer/" + id + "/privat/kode"), { kode: kode });
    batch.set(db.doc("ligaer/" + id + "/medlemmer/" + MIG), { holdnavn: hold, kode: kode, tilmeldt: new Date().toISOString() });
    await batch.commit();
    MINE_LIGAER = MINE_LIGAER.concat([{ id: id, navn: navn }]);
    aabnLiga(id);
    $("opretFane").reset();
  } catch (err) {
    $("ligaFejl").textContent = err.message === "taget" ?
      "Der findes allerede en liga, der hedder " + navn + ". Vælg et andet navn." : "Ligaen kunne ikke oprettes. Prøv igen.";
  }
  $("opretKnap").disabled = false;
});

$("skiftLigaKnap").addEventListener("click", function () {
  $("ligaFejl").textContent = "";
  tegnMineLigaer();
  $("lukLigaer").hidden = false;
  $("ligaer").hidden = false;
});
$("lukLigaer").addEventListener("click", function () { if (LIGA) $("ligaer").hidden = true; });

// =====================================================
//  TEGNING
// =====================================================
var tegnPlanlagt = false;
function planlaegTegning() {
  if (tegnPlanlagt) return;
  tegnPlanlagt = true;
  requestAnimationFrame(function () { tegnPlanlagt = false; tegnAlt(); });
}

function tegnAlt() {
  $("login").hidden = !!MIG;
  $("logUdKnap").hidden = !MIG;
  if (!MIG) { $("ligaer").hidden = true; document.title = "Superliga Draft – fantasy-draft for Superligaen"; return; }

  // Ingen liga åben: vis liga-vælgeren
  if (!LIGA) {
    $("ligaer").hidden = false;
    $("lukLigaer").hidden = true;
    tegnMineLigaer();
    document.title = "Superliga Draft";
    return;
  }

  var u = aktivUge();
  var st = u ? ugeStatus(u, D.picks, Date.now()) : null;
  var liganavn = (D.info && D.info.navn) || "Superliga Draft";

  $("tbTitel").textContent = liganavn;
  $("migChip").textContent = D.medlemmer[MIG] ? D.medlemmer[MIG].holdnavn : "";
  $("adminKnap").hidden = !ER_EJER;
  if (!$("ligaer").hidden) tegnMineLigaer();

  tegnTopbar(u, st);
  tegnStatus(u, st);
  tegnBoard(u, st);
  tegnStilling();
  tegnHistorik();
  tegnStatistik();
  tegnKampe(u);
  tegnMock(u, st);
  tegnTicker(u, st);
  if (!$("admin").hidden) tegnAdmin();

  var minTur = st && !st.faerdig && !st.venter && st.uid === MIG && !st.udloebet;
  document.title = (minTur ? "● Din tur – " : "") + liganavn;
}

function tegnTopbar(u, st) {
  if (!u) {
    $("tbUge").textContent = "Ingen draft endnu";
    $("tbPick").textContent = "";
    $("tbBar").style.width = "0%";
    $("tbDeadline").textContent = "";
    return;
  }
  $("tbUge").textContent = "Uge " + u.nr;
  $("tbPick").textContent = st.k + "/" + st.total;
  $("tbBar").style.width = (st.k / st.total * 100) + "%";
  $("tbDeadline").textContent = Date.now() < st.deadline ? "Deadline " + visTid(st.deadline) : "Draften er lukket";
}

function tegnLobby(u, st) {
  var lobby = $("liveLobby");
  if (!u || !st || st.faerdig || !st.live || !st.venter) { lobby.hidden = true; return; }
  lobby.hidden = false;
  var medIUgen = u.raekkefoelge.indexOf(MIG) !== -1;
  var klar = u.raekkefoelge.filter(function (uid) { return D.klar[uid]; });
  $("lobbyTitel").textContent = "Live draft · uge " + u.nr;
  if (st.harStart) {
    $("lobbyTekst").textContent = "Starter " + visTid(st.startMs) + " (om " + visVarighed(st.startMs - Date.now()) +
      "). Hver har 2 minutter pr. valg, " + Math.ceil(st.total * u.sekPrPick / 60) + " minutter i alt.";
  } else {
    $("lobbyTekst").textContent = ER_EJER ? "Aftal et tidspunkt med de andre, og sæt det under ⚙." :
      "Tidspunktet er ikke aftalt endnu. Aftal det med de andre; ejeren af ligaen sætter det.";
  }
  $("klarListe").innerHTML = u.raekkefoelge.map(function (uid) {
    return '<span class="' + (D.klar[uid] ? "klar" : "") + '">' + esc(holdnavn(uid)) + (D.klar[uid] ? " ✓" : "") + '</span>';
  }).join("");
  $("klarKnap").hidden = !medIUgen;
  $("klarKnap").textContent = D.klar[MIG] ? "Ikke klar alligevel" : "Jeg er klar";
  var alle = klar.length === u.raekkefoelge.length;
  $("lobbyStartNu").hidden = !ER_EJER;
  $("lobbyStartNu").textContent = alle ? "Alle er klar · start nu" : "Start nu (" + klar.length + "/" + u.raekkefoelge.length + " klar)";
}

function naesteTurFor(u, uid) {
  var n = u.raekkefoelge.length, total = n * SPILLERE_PR_HOLD;
  for (var k = D.picks.length; k < total; k++) if (u.raekkefoelge[kolVed(k, n)] === uid) return k - D.picks.length;
  return -1;
}

function tegnStatus(u, st) {
  var blok = $("blok");
  blok.className = "blok";
  $("dinTur").hidden = true;
  tegnLobby(u, st);

  var sidste = D.picks[D.picks.length - 1];
  if (sidste && D.efterId[sidste.spillerId]) {
    var s0 = D.efterId[sidste.spillerId];
    $("forrigeSpiller").innerHTML = troeje(s0.klub, 16) + ' ' + esc(fuldtNavn(s0)) + ' <span class="tag ' + s0.pos + '">' + s0.pos + '</span>';
    $("forrigeMgr").innerHTML = '<span>»</span> ' + esc(holdnavn(sidste.uid)) +
      (sidste.auto ? ' <small style="color:var(--daempet);font-weight:400">(automatisk)</small>' : "");
  } else {
    $("forrigeSpiller").textContent = "Ingen endnu";
    $("forrigeMgr").textContent = "";
  }

  var t = $("timer");
  if (!u) {
    blok.disabled = true;
    $("blokFoto").textContent = "?";
    $("blokNavn").textContent = "Venter på draft";
    $("blokInfo").textContent = ER_EJER ? "Åbn ⚙ og start ugens draft, når alle er med." : "Ugens draft er ikke startet endnu.";
    $("kmNavn").textContent = "–"; $("kmPick").textContent = ""; $("kmBudget").textContent = "";
    t.textContent = "–"; t.className = "timer";
    $("draftKnap").disabled = true;
    return;
  }

  if (st.faerdig) {
    blok.disabled = true;
    $("blokFoto").textContent = "✓";
    $("blokNavn").textContent = "Ugens draft er færdig";
    var lv = liveRunde(u.nr);
    $("blokInfo").textContent = D.runder[u.nr] ? "Point for runden er regnet ud. Se stillingen." :
      lv ? (lv.skrevet ? "Live-point på boardet, opdateret " + visTid(Date.parse(lv.skrevet)) + ". Endelige point kommer tirsdag." :
        "Live-point kommer på boardet ca. 2¼ time efter hver kampstart. Endelige point kommer tirsdag.") :
      "Point kommer tirsdag, når weekendens runde er spillet.";
    $("kmNavn").textContent = "Færdig";
    $("kmPick").textContent = st.total + " picks";
    $("kmBudget").textContent = "";
    t.textContent = "0:00"; t.className = "timer";
    $("draftKnap").disabled = true;
    return;
  }

  if (st.venter) {
    blok.disabled = true;
    valgt = null;
    $("blokFoto").textContent = "⏱";
    $("blokNavn").textContent = st.harStart ? "Draften starter snart" : "Live draft";
    $("blokInfo").textContent = st.harStart ? "Første valg: " + holdnavn(st.uid) + " · " + visTid(st.startMs) :
      "Venter på, at der bliver aftalt et tidspunkt.";
    $("kmNavn").textContent = holdnavn(st.uid);
    $("kmPick").textContent = "Vælger først";
    $("kmBudget").textContent = "1 MM · 2 FOR · 2 MID · 2 ANG";
    $("kmBudget").className = "km-budget";
    t.textContent = st.harStart ? visVarighed(st.startMs - Date.now()) : "–";
    t.className = "timer";
    $("draftKnap").disabled = true;
    return;
  }

  var minTur = st.uid === MIG && !st.udloebet;
  var venstre = st.turSlut - Date.now();
  var graense = Math.min(15 * 60000, u.sekPrPick * 250);
  $("kmNavn").textContent = holdnavn(st.uid);
  $("kmPick").textContent = "Pick " + (st.k + 1) + " af " + st.total;
  var mangler = POS_RAEKKE.filter(function (p) { return antalPos(st.uid, p, D.picks) < KVOTE[p]; })
    .map(function (p) { return (KVOTE[p] - antalPos(st.uid, p, D.picks)) + " " + p; });
  $("kmBudget").textContent = mangler.length ? "Mangler " + mangler.join(", ") : "";
  $("kmBudget").className = "km-budget";
  t.textContent = visVarighed(venstre);
  t.className = "timer" + (venstre < graense ? " kritisk" : "") + (venstre < Math.min(60000, graense / 3) ? " panik" : "");

  if (minTur) {
    $("dinTur").hidden = false;
    if (!$("dinTurTekst").dataset.fejl) {
      $("dinTurTekst").textContent = "Vælg din spiller inden " + visTid(st.turSlut) +
        ". Ellers vælger appen den spiller i bedst form, du mangler.";
    }
    blok.disabled = false;
    if (valgt && !taget(D.picks)[valgt.id]) {
      blok.classList.add("har-valg", valgt.pos);
      $("blokFoto").innerHTML = troeje(valgt.klub, 44);
      $("blokNavn").textContent = fuldtNavn(valgt);
      $("blokInfo").innerHTML = '<span class="tag ' + valgt.pos + '">' + valgt.pos + '</span><span class="klub">' +
        esc(KLUBBER[valgt.klub] || valgt.klub) + '</span><span class="prik">·</span>Form ' + form(valgt.pris) +
        '<span class="prik">·</span>Tryk ✓ for at drafte';
      $("draftKnap").disabled = false;
    } else {
      valgt = null;
      $("blokFoto").textContent = "?";
      $("blokNavn").textContent = "Vælg din spiller";
      $("blokInfo").textContent = "Klik her for at se de ledige spillere.";
      $("draftKnap").disabled = true;
    }
  } else {
    blok.disabled = true;
    valgt = null;
    $("blokFoto").textContent = holdnavn(st.uid).slice(0, 2).toUpperCase();
    $("blokNavn").textContent = holdnavn(st.uid);
    var minPlads = naesteTurFor(u, MIG);
    $("blokInfo").textContent = "Vælger nu." + (minPlads > 0 ? " Du er på om " + minPlads + " valg." : "");
    $("draftKnap").disabled = true;
  }
}

// ---------- Kaptajn ----------
function kanVaelgeKaptajn(u) {
  return !!(u && D.medlemmer[MIG] && Date.now() < Date.parse(u.deadline) && holdPicks(MIG, D.picks).length);
}
async function saetKaptajn(spillerId) {
  var u = aktivUge();
  if (!kanVaelgeKaptajn(u) || !holdPicks(MIG, D.picks).some(function (p) { return p.spillerId === spillerId; })) return;
  var gammel = D.kaptajner[MIG];
  D.kaptajner[MIG] = { spillerId: spillerId, tid: null };
  kaptajnTilstand = false;
  planlaegTegning();
  try {
    await ligaDoc("uger/" + u.nr + "/kaptajn/" + MIG).set({ spillerId: spillerId, tid: firebase.firestore.FieldValue.serverTimestamp() });
  } catch (e) {
    if (gammel) D.kaptajner[MIG] = gammel; else delete D.kaptajner[MIG];
    planlaegTegning();
  }
}

function tegnBoard(u, st) {
  var board = $("board");
  if (!u) {
    board.innerHTML = "";
    $("boardTom").hidden = false;
    var antal = Object.keys(D.medlemmer).length;
    $("boardTom").textContent = antal + " hold er med indtil videre. Boardet vises her, når ugens draft er startet.";
    return;
  }
  $("boardTom").hidden = true;
  var n = u.raekkefoelge.length;
  board.style.gridTemplateColumns = "repeat(" + n + ", minmax(205px, 1fr))";
  var runde = pointRunde(u.nr);
  var aktivRunde = st.faerdig ? -1 : Math.floor(st.k / n);

  var html = "";
  u.raekkefoelge.forEach(function (uid, c) {
    var aktiv = !st.faerdig && !st.venter && st.kol === c;
    var mine = holdPicks(uid, D.picks);
    var pt = ugePointForHold(u.nr, uid, D.picks);
    var kap = kaptajnFor(u.nr, uid, D.picks);
    var kapKnap = "";
    if (uid === MIG && kanVaelgeKaptajn(u)) {
      kapKnap = '<button type="button" class="kap-knap' + (kaptajnTilstand ? " aktiv" : "") + '" id="kapKnap">' +
        (kaptajnTilstand ? "Tryk på din kaptajn · annullér" : kap ? "Skift kaptajn" : "Vælg kaptajn") + '</button>';
    }
    html += '<div class="kol' + (aktiv ? " aktiv" : "") + (uid === MIG ? " mig-kol" : "") + '"><div class="kol-top">' +
      (uid === MIG ? '<div class="k-mig">Dit hold</div>' : "") +
      '<div class="k-navn">' + esc(holdnavn(uid)) + '</div>' +
      '<div class="k-tal">' + (pt !== null ? pt + '<small> point' + (runde && runde.live ? ' <span class="live-maerke">live</span>' : '') + '</small>' : mine.length + '<small>/' + SPILLERE_PR_HOLD + '</small>') + '</div>' +
      '<div class="k-sub">' + (st.faerdig ? "Færdig" : aktiv ? "På uret nu" : (!st.venter && st.kol !== undefined && kolVed(st.k + 1, n) === c && st.k + 1 < st.total ? "Næste" : "Valg " + (c + 1) + " i runde 1")) + '</div>' +
      '<div class="k-kvote">' + POS_RAEKKE.map(function (pos) {
        var a = antalPos(uid, pos, D.picks);
        return '<span class="' + pos + (a >= KVOTE[pos] ? " fuld" : "") + '" title="' + POSITIONER[pos] + '">' + pos + " " + a + "/" + KVOTE[pos] + '</span>';
      }).join("") + '</div>' + kapKnap + '</div>';

    for (var r = 0; r < SPILLERE_PR_HOLD; r++) {
      var pick = D.picks.filter(function (x) { return x.uid === uid && Math.floor(x.nr / n) === r; })[0];
      if (pick) {
        var s = D.efterId[pick.spillerId] || { id: pick.spillerId, fornavn: "", efternavn: pick.spillerId, pos: pick.pos, klub: pick.klub };
        var sp = runde ? spillerPoint(u.nr, pick, D.picks) : null;
        var hoejre = D.efterId[pick.spillerId] ? '<div class="c-hoejre">' + form(s.pris) + '<small>form</small></div>' : "";
        var midt = "", detaljer = "";
        if (sp && sp.r) {
          // Live: har klubben ikke spillet endnu, vises hvornår den spiller i stedet for 0 point
          var venter = runde.live && !sp.r.min && !(runde.modtaget && runde.modtaget[pick.klub] !== undefined);
          var pNoegle = pick.uid + "|" + pick.spillerId;
          var aaben = !!aabnePoint[pNoegle];
          midt = '<div class="c-midt"><button type="button" class="pboks' + (aaben ? " aaben" : "") + '" data-point="' + esc(pNoegle) + '" aria-expanded="' + aaben + '">' +
            '<b>' + (sp.point > 0 ? "+" : "") + sp.point + '</b><small>point' + (sp.kaptajn ? " · C ×2" : "") + '</small><i class="pil">' + (aaben ? "▴" : "▾") + '</i></button></div>';
          if (aaben && venter) {
            var nk = naesteKamp(pick.klub);
            detaljer = '<div class="point-detaljer"><p class="kup-tom">Ingen point endnu' + (nk && nk.tid ? " – spiller " + kampDato(nk.tid, true) + " mod " + esc(KLUBBER[nk.mod] || nk.mod) : " – kampen er ikke talt med endnu") + '.</p></div>';
          } else if (aaben) detaljer = '<div class="point-detaljer">' + pointLinjer(s, sp.r, runde, sp.kaptajn ? 2 : 1, "I alt") + '</div>';
        }
        var erKap = kap === pick.spillerId;
        var vaelgKap = kaptajnTilstand && uid === MIG;
        html += '<div class="cell klik ' + pick.pos + (vaelgKap ? " kap-valg" : "") + '" data-spiller="' + esc(pick.spillerId) + '" data-ejer="' + esc(uid) + '" tabindex="0" role="button">' +
          '<span class="c-nr">' + (r + 1) + '</span>' +
          (erKap ? '<span class="kaptajn" title="Kaptajn – dobbelt point">C</span>' : "") +
          '<span class="c-tr">' + troeje(pick.klub, 30) + '</span>' +
          '<div class="c-tx"><div class="c-for">' + esc(s.fornavn || "\u00a0") + '</div>' +
          '<div class="c-navn">' + esc(s.efternavn) + (runde && !runde.live ? "" : skadeBadge(pick.spillerId)) + '</div>' +
          '<div class="c-sub"><span class="c-pos">' + pick.pos + '</span>' + esc(pick.klub) + (pick.auto ? ' · automatisk' : '') + '</div>' +
          (runde && !runde.live ? "" : kampLinje(pick.klub)) + '</div>' +
          midt + hoejre + '</div>' + detaljer;
      } else if (aktiv && r === aktivRunde) {
        html += '<div class="cell nu"><span class="c-nr">' + (r + 1) + '</span><div class="c-tx"><div class="c-for">På uret</div><div class="c-navn">' +
          (uid === MIG ? "Din tur" : "Vælger nu") + '</div></div></div>';
      } else {
        html += '<div class="cell tom"><span class="c-nr">' + (r + 1) + '</span></div>';
      }
    }
    html += '</div>';
  });
  board.innerHTML = html;
}

// ---------- Statistik-siden: regnes ud fra de afgjorte uger ----------
function kortNavn(s) { return s ? (s.fornavn ? s.fornavn[0] + ". " : "") + s.efternavn : "?"; }
function tal1(x) { return String(Math.round(x * 10) / 10).replace(".", ","); }
function tegnStatistik() {
  var uger = afgjorteUger();
  var ind = $("statistikIndhold");
  if (!uger.length) {
    ind.innerHTML = "";
    $("statistikInfo").textContent = "Statistikken bliver regnet ud, når den første uge er afgjort. Point kommer hver tirsdag morgen.";
    return;
  }
  var hold = {}, spillere = {}, rekord = null, bedsteKap = null;
  uger.forEach(function (x) {
    var picks = x.picks;
    x.hold.forEach(function (h) {
      var o = hold[h.uid] = hold[h.uid] || { uid: h.uid, uger: 0, point: 0, brugt: 0, bedste: 0, kapPlus: 0, kapUger: 0, sejre: 0 };
      o.uger++; o.point += h.point; o.bedste = Math.max(o.bedste, h.point); o.brugt += brugt(h.uid, picks);
      if (x.vindere.some(function (v) { return v.uid === h.uid; })) o.sejre++;
      if (!rekord || h.point > rekord.point) rekord = { uid: h.uid, point: h.point, nr: x.nr };
      var mine = holdPicks(h.uid, picks).map(function (p) { var sp = spillerPoint(x.nr, p, picks); return { p: p, base: sp.r ? sp.r.point : 0, kap: sp.kaptajn }; });
      var kap = mine.filter(function (m) { return m.kap; })[0];
      if (kap) {
        var andre = mine.filter(function (m) { return !m.kap; }).map(function (m) { return m.base; });
        o.kapPlus += kap.base - (andre.length ? Math.max.apply(null, andre) : 0); o.kapUger++;
        if (!bedsteKap || kap.base * 2 > bedsteKap.point) bedsteKap = { id: kap.p.spillerId, uid: h.uid, nr: x.nr, point: kap.base * 2 };
      }
      mine.forEach(function (m) {
        var sp = spillere[m.p.spillerId] = spillere[m.p.spillerId] || { id: m.p.spillerId, point: 0, uger: 0, pris: 0, hos: {} };
        sp.point += m.base; sp.uger++; sp.pris += m.p.pris || 0; sp.hos[h.uid] = (sp.hos[h.uid] || 0) + 1;
      });
    });
  });
  var holdListe = Object.keys(hold).map(function (k) { var o = hold[k]; o.snit = o.point / o.uger; o.pr = o.brugt ? o.point / o.brugt : 0; return o; })
    .sort(function (a, b) { return b.snit - a.snit; });
  var spListe = Object.keys(spillere).map(function (k) {
    var o = spillere[k]; o.s = D.efterId[o.id];
    o.oftest = Object.keys(o.hos).sort(function (a, b) { return o.hos[b] - o.hos[a]; })[0];
    o.prMio = o.pris ? o.point / o.pris : 0; return o;
  });
  var top = spListe.slice().sort(function (a, b) { return b.point - a.point || a.uger - b.uger; });
  var bedsteHold = holdListe[0], bedsteSp = top[0];
  var tile = function (lab, stor, navn, sub, mig) {
    return '<div class="st-tile' + (mig ? " st-mig" : "") + '"><span class="st-lab">' + lab + '</span><b>' + stor + '</b><span class="st-navn">' + navn + '</span><small>' + sub + '</small></div>';
  };
  var html = '<div class="st-tiles">' +
    tile("Bedste drafter", tal1(bedsteHold.snit), esc(holdnavn(bedsteHold.uid)), "point pr. uge i snit", bedsteHold.uid === MIG) +
    (bedsteSp ? tile("Sæsonens spiller", bedsteSp.point, esc(kortNavn(bedsteSp.s)), "point for sine hold" + (bedsteSp.s ? " · " + bedsteSp.s.klub : ""), bedsteSp.oftest === MIG) : "") +
    tile("Ugens rekord", rekord.point, esc(holdnavn(rekord.uid)), "uge " + rekord.nr, rekord.uid === MIG) +
    (bedsteKap ? tile("Bedste kaptajn", bedsteKap.point, esc(kortNavn(D.efterId[bedsteKap.id])), esc(holdnavn(bedsteKap.uid)) + " · uge " + bedsteKap.nr + " (×2)", bedsteKap.uid === MIG) : "") +
    '</div>';
  html += '<div class="st-boks"><h3 class="kort-h3">Hvem drafter bedst</h3><div class="tabel-rul"><table class="stilling-tabel st-tabel">' +
    '<thead><tr><th>Hold</th><th class="tal">Snit pr. uge</th><th class="tal">Point pr. mio.</th><th class="tal">Bedste uge</th><th class="tal">Kaptajn +/-</th><th class="tal">Ugesejre</th></tr></thead><tbody>' +
    holdListe.map(function (o) {
      return '<tr' + (o.uid === MIG ? ' class="mig-raekke"' : "") + '><td class="hold-navn">' + esc(holdnavn(o.uid)) + '</td><td class="tal point">' + tal1(o.snit) +
        '</td><td class="tal">' + (Math.round(o.pr * 100) / 100).toFixed(2).replace(".", ",") + '</td><td class="tal">' + o.bedste +
        '</td><td class="tal' + (o.kapPlus < 0 ? " neg" : "") + '">' + (o.kapUger ? (o.kapPlus > 0 ? "+" : "") + o.kapPlus : "–") + '</td><td class="tal">' + o.sejre + '</td></tr>';
    }).join("") + '</tbody></table></div>' +
    '<p class="sp-hjaelp">Point pr. mio.: point delt med det budget, holdet brugte. Kaptajn +/-: hvor mange point kaptajnen fik mere (eller mindre) end holdets bedste anden spiller, lagt sammen for alle uger.</p></div>';
  html += '<div class="st-boks"><h3 class="kort-h3">Sæsonens bedste spillere i ligaen</h3><div class="tabel-rul"><table class="stilling-tabel st-tabel">' +
    '<thead><tr><th>#</th><th>Spiller</th><th class="tal">Point</th><th class="tal">Draftet</th><th>Oftest hos</th></tr></thead><tbody>' +
    top.slice(0, 10).map(function (o, i) {
      var s = o.s || { efternavn: o.id, klub: "", pos: "" };
      return '<tr' + (o.oftest === MIG ? ' class="mig-raekke"' : "") + '><td class="plads">' + (i + 1) + '</td><td><div class="st-spiller">' + troeje(s.klub, 24) +
        '<div><b>' + esc(fuldtNavn(s)) + '</b><small><span class="tag ' + s.pos + '">' + s.pos + '</span> ' + esc(s.klub) + '</small></div></div></td>' +
        '<td class="tal point">' + o.point + '</td><td class="tal">' + o.uger + (o.uger === 1 ? " uge" : " uger") + '</td><td>' + esc(holdnavn(o.oftest)) + '</td></tr>';
    }).join("") + '</tbody></table></div></div>';
  var liste = function (arr, vaerdi, ekstra) {
    return '<ol class="st-liste">' + arr.map(function (o) {
      return '<li><span>' + esc(fuldtNavn(o.s || { efternavn: o.id })) + (ekstra ? ' <small>· ' + ekstra(o) + '</small>' : "") + '</span><b>' + vaerdi(o) + '</b></li>';
    }).join("") + '</ol>';
  };
  var flest = spListe.slice().sort(function (a, b) { return b.uger - a.uger || b.point - a.point; }).slice(0, 5);
  var koeb = spListe.filter(function (o) { return o.pris > 0; }).sort(function (a, b) { return b.prMio - a.prMio || b.point - a.point; }).slice(0, 5);
  html += '<div class="st-to"><div class="st-boks"><h3 class="kort-h3">Flest gange draftet</h3>' +
    liste(flest, function (o) { return o.uger + (o.uger === 1 ? " uge" : " uger"); }) + '</div>' +
    '<div class="st-boks"><h3 class="kort-h3">Bedste køb (point pr. mio.)</h3>' +
    liste(koeb, function (o) { return tal1(o.prMio); }, function (o) { return tal1(o.pris / o.uger) + " mio."; }) + '</div></div>';
  ind.innerHTML = html;
  $("statistikInfo").textContent = "Regnet ud fra " + uger.length + " afgjort" + (uger.length === 1 ? " uge" : "e uger") + ". Opdateres hver tirsdag, når rundens point er talt.";
}

// Stillingen over tid: placering efter hver afgjort uge, dit hold i guld
var GRAF_FARVER = ["#38c6f4", "#1fd18a", "#ff4d6d", "#b48cff", "#3b9bff", "#ff9f43", "#5be3c4", "#f78fb3", "#9aa9c7", "#c3e65a"];
function tegnStillingGraf() {
  var uger = afgjorteUger().slice().reverse();
  var boks = $("stillingGraf");
  if (uger.length < 2) {
    boks.hidden = !uger.length;
    if (uger.length) $("stillingGrafSvg").innerHTML = '<p class="sp-hjaelp">Grafen kommer, når der er spillet to uger.</p>';
    return;
  }
  var total = {}, rk = {};
  var holdUid = Object.keys(D.medlemmer);
  uger.forEach(function (x) { x.hold.forEach(function (h) { if (holdUid.indexOf(h.uid) < 0) holdUid.push(h.uid); }); });
  uger.forEach(function (x, i) {
    x.hold.forEach(function (h) { total[h.uid] = (total[h.uid] || 0) + h.point; });
    var sorteret = holdUid.slice().sort(function (a, b) { return (total[b] || 0) - (total[a] || 0); });
    sorteret.forEach(function (uid, j) {
      var plads = j > 0 && (total[uid] || 0) === (total[sorteret[j - 1]] || 0) ? rk[sorteret[j - 1]][i] : j + 1;
      (rk[uid] = rk[uid] || [])[i] = plads;
    });
  });
  var n = holdUid.length, m = uger.length;
  var smal = window.innerWidth < 600;
  var V = 40, H = smal ? 132 : 150, T = 18, B = 30, rH = smal ? 26 : 30;
  var W = V + (smal ? Math.max(190, m * 55) : Math.max(560, m * 90)) + H, hoejde = T + (n - 1) * rH + B;
  var x = function (i) { return V + (m === 1 ? 0 : i * (W - V - H) / (m - 1)); };
  var y = function (p) { return T + (p - 1) * rH; };
  var svg = '<svg viewBox="0 0 ' + W + ' ' + hoejde + '" class="graf" style="min-width:' + Math.round(W * 0.8) + 'px" role="img" aria-label="Placering efter hver uge">';
  for (var p = 1; p <= n; p++) svg += '<line x1="' + V + '" x2="' + (W - H + 8) + '" y1="' + y(p) + '" y2="' + y(p) + '" class="g-linje"/><text x="' + (V - 14) + '" y="' + (y(p) + 4) + '" class="g-akse" text-anchor="end">' + p + '.</text>';
  uger.forEach(function (u, i) { svg += '<text x="' + x(i) + '" y="' + (hoejde - 8) + '" class="g-akse" text-anchor="middle">Uge ' + u.nr + '</text>'; });
  var mig = holdUid.indexOf(MIG) >= 0 ? MIG : null;
  holdUid.filter(function (uid) { return uid !== mig; }).concat(mig ? [mig] : []).forEach(function (uid, k) {
    var farve = uid === mig ? "var(--guld)" : GRAF_FARVER[holdUid.indexOf(uid) % GRAF_FARVER.length];
    var pts = rk[uid].map(function (pl, i) { return x(i) + "," + y(pl); }).join(" ");
    var sidste = rk[uid][m - 1];
    svg += '<g class="g-hold' + (uid === mig ? " mig" : "") + '" style="--f:' + farve + '"><polyline points="' + pts + '"/>' +
      rk[uid].map(function (pl, i) { return '<circle cx="' + x(i) + '" cy="' + y(pl) + '" r="' + (uid === mig ? 5 : 3.5) + '"><title>' + esc(holdnavn(uid)) + ': ' + pl + '. efter uge ' + uger[i].nr + '</title></circle>'; }).join("") +
      '<text x="' + (W - H + 16) + '" y="' + (y(sidste) + 4) + '" class="g-navn">' + esc(holdnavn(uid)) + '</text></g>';
  });
  $("stillingGrafSvg").innerHTML = svg + '</svg>';
  boks.hidden = false;
}

function tegnStilling() {
  var raekker = stilling();
  var uger = afgjorteUger();
  var seneste = uger[0];
  var sejre = {};
  uger.forEach(function (x) { x.vindere.forEach(function (h) { sejre[h.uid] = (sejre[h.uid] || 0) + 1; }); });
  var vinderUid = {};
  if (seneste) seneste.vindere.forEach(function (h) { vinderUid[h.uid] = true; });
  if (seneste && seneste.vindere.length) {
    $("vinderBaand").innerHTML = '<span class="stor">🏆</span><div><div class="b-label">Ugens vinder · uge ' + seneste.nr + '</div>' +
      seneste.vindere.map(function (h) { return '<b>' + esc(holdnavn(h.uid)) + '</b>'; }).join(" og ") +
      ' med ' + seneste.vindere[0].point + ' point</div>';
    $("vinderBaand").hidden = false;
  } else $("vinderBaand").hidden = true;
  $("stillingBody").innerHTML = raekker.map(function (r, i) {
    var titel = sejre[r.uid] ? sejre[r.uid] + " ugesejr" + (sejre[r.uid] === 1 ? "" : "e") : "";
    return '<tr' + (r.uid === MIG ? ' class="mig-raekke"' : "") + '><td class="plads">' + (i + 1) + '</td>' +
      '<td><div class="hold-navn">' + esc(holdnavn(r.uid)) + (vinderUid[r.uid] ? '<span class="trofae" title="Vandt uge ' + seneste.nr + (titel ? " · " + titel : "") + '">🏆</span>' : "") + '</div></td>' +
      '<td class="tal">' + (r.sidste === null ? "–" : r.sidste) + '</td>' +
      '<td class="tal">' + r.runder + '</td>' +
      '<td class="tal point">' + r.total + '</td></tr>';
  }).join("") || '<tr><td colspan="5" class="tom-tekst">Ingen hold endnu.</td></tr>';
  tegnStillingGraf();
  var antalRunder = Object.keys(D.runder).length;
  $("stillingInfo").textContent = antalRunder ? antalRunder + " runde" + (antalRunder === 1 ? "" : "r") + " er talt med." :
    "Stillingen bliver regnet ud efter første runde. Point kommer hver tirsdag morgen.";
}

function tegnHistorik() {
  var uger = afgjorteUger();
  if (!uger.length) {
    $("historikListe").innerHTML = "";
    $("historikInfo").textContent = "Historikken fyldes ud, når den første runde er spillet og talt op. Point kommer hver tirsdag morgen.";
    return;
  }
  $("historikInfo").textContent = "Tryk på en uge for at se hele boardet, hvem der tog hvem, og hvor mange point hver spiller gav.";
  $("historikListe").innerHTML = uger.map(function (x) {
    var bedste = x.picks.map(function (p) { return { p: p, sp: spillerPoint(x.nr, p, x.picks) }; })
      .filter(function (o) { return o.sp.r && o.sp.point > 0; })
      .sort(function (a, b) { return b.sp.point - a.sp.point; }).slice(0, 2)
      .map(function (o) { var s = D.efterId[o.p.spillerId]; return esc(s ? s.efternavn : o.p.spillerId) + " " + o.sp.point + " point"; });
    var aaben = aabenHistorik === x.nr;
    var html = '<button type="button" class="hist-raekke" data-uge="' + x.nr + '" aria-expanded="' + aaben + '">' +
      '<span class="uge">Uge ' + x.nr + '</span>' +
      '<span class="v">' + (x.vindere.length ? "🏆 " + x.vindere.map(function (h) { return esc(holdnavn(h.uid)); }).join(" og ") : "–") +
      '<small>' + (bedste.length ? "Bedste picks: " + bedste.join(" · ") : "Ingen point endnu") + '</small></span>' +
      '<span class="p">' + (x.vindere.length ? x.vindere[0].point + " p" : "") + '</span>' +
      '<span class="se">' + (aaben ? "Skjul ‹" : "Se board ›") + '</span></button>';
    if (aaben) {
      html += '<div class="hist-board">' + x.hold.map(function (h, i) {
        var kap = kaptajnFor(x.nr, h.uid, x.picks);
        return '<div class="hist-hold"><div class="hh-top"><span class="hh-plads">' + (i + 1) + '</span><b>' + esc(holdnavn(h.uid)) + '</b><span class="hh-point">' + h.point + ' p</span></div>' +
          holdPicks(h.uid, x.picks).map(function (p) {
            var s = D.efterId[p.spillerId] || { fornavn: "", efternavn: p.spillerId };
            var sp = spillerPoint(x.nr, p, x.picks);
            return '<div class="hh-spiller ' + p.pos + '"><span class="tag ' + p.pos + '">' + p.pos + '</span>' + troeje(p.klub, 16) +
              '<span class="hh-navn">' + esc(fuldtNavn(s)) + (kap === p.spillerId ? ' <span class="kap-mini">C</span>' : "") + '</span>' +
              '<span class="hh-p">' + (sp.point > 0 ? "+" : "") + sp.point + '</span></div>';
          }).join("") + '</div>';
      }).join("") + '</div>';
    }
    return html;
  }).join("");
}

// ---------- Kampe-siden ----------
var DAGE_LANG = { Mon: "Mandag", Tue: "Tirsdag", Wed: "Onsdag", Thu: "Torsdag", Fri: "Fredag", Sat: "Lørdag", Sun: "Søndag" };
// Hele sæsonen fra data/program.json: én runde ad gangen med pile, resultater og hændelser
var kampeRunde = null, aabneKampe = {};
function kampMs(k) {
  if (!k.tid) return null;
  return Date.parse(k.tid.indexOf("T") > 0 ? k.tid : k.tid + "T12:00:00Z");
}
function aktuelProgramRunde() {
  var r = D.program.runder, nu = Date.now();
  for (var i = 0; i < r.length; i++) {
    if (r[i].kampe.some(function (k) { var t = kampMs(k); return !k.res && (t === null || t > nu - 3 * 3600000); })) return i;
  }
  return r.length - 1;
}
function haendelseHtml(e, k) {
  var navn = esc(e.spiller), tekst;
  if (e.type === "maal" || e.type === "straffe" || e.type === "selvmaal") {
    tekst = '<span class="kh-ikon">⚽</span>' + navn + (e.type === "straffe" ? " <small>(str.)</small>" : e.type === "selvmaal" ? " <small>(selvmål)</small>" : "") +
      (e.assist ? '<small class="kh-assist">Assist: ' + esc(e.assist) + '</small>' : "");
  } else {
    var kort = e.type === "gult" ? "gul" : e.type === "roedt" ? "roed" : "gulroed";
    tekst = '<span class="kh-kort ' + kort + '"></span>' + navn + (e.type === "gultroedt" ? " <small>(2. gule)</small>" : "");
  }
  var hjemme = e.klub === k.hjemme;
  return '<div class="kh"><span class="kh-min">' + (e.min !== null && e.min !== undefined ? e.min + "'" : "") + '</span>' +
    '<span class="kh-h">' + (hjemme ? tekst : "") + '</span><span class="kh-u">' + (hjemme ? "" : tekst) + '</span></div>';
}
function tegnProgram(u) {
  var runder = D.program.runder, akt = aktuelProgramRunde();
  if (kampeRunde === null || kampeRunde >= runder.length) kampeRunde = akt;
  var rd = runder[kampeRunde];
  var tider = rd.kampe.map(kampMs).filter(function (t) { return t !== null; });
  var fra = tider.length ? kbhDele(Math.min.apply(null, tider)) : null, til = tider.length ? kbhDele(Math.max.apply(null, tider)) : null;
  var periode = fra ? fra.d + "/" + fra.m + (til.d + "/" + til.m !== fra.d + "/" + fra.m ? " – " + til.d + "/" + til.m : "") : "";
  var mine = u && kampeRunde === akt ? holdPicks(MIG, D.picks) : [];
  var html = '<div class="runde-nav">' +
    '<button type="button" class="rn-pil" data-runde="' + (kampeRunde - 1) + '"' + (kampeRunde === 0 ? " disabled" : "") + ' aria-label="Forrige runde">‹</button>' +
    '<div class="rn-midt"><b>Runde ' + rd.nr + '</b><small>' + periode + (kampeRunde === akt ? " · denne runde" : "") + '</small></div>' +
    '<button type="button" class="rn-pil" data-runde="' + (kampeRunde + 1) + '"' + (kampeRunde === runder.length - 1 ? " disabled" : "") + ' aria-label="Næste runde">›</button></div>';
  var dag = null;
  rd.kampe.slice().sort(function (a, b) { return (kampMs(a) || 0) - (kampMs(b) || 0); }).forEach(function (k) {
    var t = kampMs(k), d = t !== null ? kbhDele(t) : null, kunDato = k.tid && k.tid.indexOf("T") < 0;
    var dagNavn = d ? DAGE_LANG[d.wd] + " " + d.d + "/" + d.m : "Dato kommer";
    if (dagNavn !== dag) { html += '<h3 class="kamp-dag">' + dagNavn + '</h3>'; dag = dagNavn; }
    var noegle = rd.nr + "-" + k.hjemme + "-" + k.ude;
    var kanAabne = !!(k.res && k.haendelser), aaben = kanAabne && aabneKampe[noegle];
    var dine = mine.filter(function (p) { return p.klub === k.hjemme || p.klub === k.ude; })
      .map(function (p) { var s = D.efterId[p.spillerId]; return esc(s ? s.efternavn : p.spillerId); });
    html += '<div class="kamp-raekke prog' + (kanAabne ? " klik" : "") + (aaben ? " aaben" : "") + '"' +
      (kanAabne ? ' data-kamp="' + esc(noegle) + '" tabindex="0" role="button" aria-expanded="' + (aaben ? "true" : "false") + '"' : "") + '>' +
      '<span class="kr-tid">' + (k.res ? '<small>Slut</small>' : d && !kunDato ? d.h + "." + ("0" + d.min).slice(-2) : "–") + '</span>' +
      '<span class="kr-hold kr-h">' + esc(KLUBBER[k.hjemme] || k.hjemme) + troeje(k.hjemme, 26) + '</span>' +
      '<span class="kr-mod' + (k.res ? " res" : "") + '">' + (k.res ? k.res[0] + "–" + k.res[1] : "–") + '</span>' +
      '<span class="kr-hold kr-u">' + troeje(k.ude, 26) + esc(KLUBBER[k.ude] || k.ude) + '</span>' +
      (kanAabne ? '<span class="kr-pil">' + (aaben ? "▴" : "▾") + '</span>' : "") +
      (dine.length && !k.res ? '<span class="kr-dine">Dine: ' + dine.join(", ") + '</span>' : "") + '</div>';
    if (aaben) {
      html += '<div class="kamp-detaljer">' + (k.haendelser.length ? k.haendelser.map(function (e) { return haendelseHtml(e, k); }).join("") :
        '<p class="kh-tom">Ingen mål eller kort i kampen.</p>') + '</div>';
    }
  });
  $("kampeListe").innerHTML = html;
  $("kampeInfo").textContent = "Tiderne er dansk tid. Tryk på en spillet kamp for at se mål og kort (fra runde 13 og frem). " +
    "Resultater kommer ca. 2¼ time efter kampstart.";
}
$("kampeListe").addEventListener("click", function (e) {
  var pil = e.target.closest(".rn-pil");
  if (pil && !pil.disabled) { kampeRunde = Number(pil.dataset.runde); tegnKampe(aktivUge()); return; }
  var r = e.target.closest(".kamp-raekke.klik");
  if (r) { aabneKampe[r.dataset.kamp] = !aabneKampe[r.dataset.kamp]; tegnKampe(aktivUge()); }
});
$("kampeListe").addEventListener("keydown", function (e) {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("klik")) { e.preventDefault(); e.target.click(); }
});
function tegnKampe(u) {
  if (D.program) { tegnProgram(u); return; }
  var liste = D.kampeListe.slice().sort(function (a, b) { return (a.tid || 0) - (b.tid || 0); });
  if (!liste.length) {
    $("kampeListe").innerHTML = "";
    $("kampeInfo").textContent = "Næste rundes kampe bliver lagt ind tirsdag morgen.";
    return;
  }
  var mine = u ? holdPicks(MIG, D.picks) : [];
  var html = "", dag = null;
  liste.forEach(function (k) {
    var d = k.tid ? kbhDele(k.tid) : null;
    var dagNavn = d ? DAGE_LANG[d.wd] + " " + d.d + "/" + d.m : "Tidspunkt kommer";
    if (dagNavn !== dag) { html += '<h3 class="kamp-dag">' + dagNavn + '</h3>'; dag = dagNavn; }
    var dine = mine.filter(function (p) { return p.klub === k.hjemme || p.klub === k.ude; })
      .map(function (p) { var s = D.efterId[p.spillerId]; return esc(s ? s.efternavn : p.spillerId); });
    html += '<div class="kamp-raekke">' +
      '<span class="kr-tid">' + (d ? d.h + "." + ("0" + d.min).slice(-2) : "–") + '</span>' +
      '<span class="kr-hold kr-h">' + esc(KLUBBER[k.hjemme] || k.hjemme) + troeje(k.hjemme, 26) + '</span>' +
      '<span class="kr-mod">–</span>' +
      '<span class="kr-hold kr-u">' + troeje(k.ude, 26) + esc(KLUBBER[k.ude] || k.ude) + '</span>' +
      (dine.length ? '<span class="kr-dine">Dine: ' + dine.join(", ") + '</span>' : "") + '</div>';
  });
  $("kampeListe").innerHTML = html;
  $("kampeInfo").textContent = "Tiderne er dansk tid. Programmet opdateres tirsdag og torsdag" +
    (D.kampeDato && visDato(D.kampeDato) ? " (sidst " + visDato(D.kampeDato) + ")." : ".");
}

// ---------- Mock draft ----------
function planRaekke(r) { return D.plan.slice(r * MOCK_ANTAL, r * MOCK_ANTAL + MOCK_ANTAL); }
function ejere(picks) { var e = {}; picks.forEach(function (p) { e[p.spillerId] = p.uid; }); return e; }
// Første ønske i rækken, der stadig er ledigt og passer på en position, du mangler
function mockBud(r, picks) {
  var e = ejere(picks);
  return planRaekke(r).filter(function (id) {
    var s = D.efterId[id];
    return s && !e[id] && maaVaelges(MIG, s, picks);
  })[0] || null;
}
function naesteMockBud() {
  var u = aktivUge();
  if (!u) return null;
  var r = holdPicks(MIG, D.picks).length;
  return r < SPILLERE_PR_HOLD ? mockBud(r, D.picks) : null;
}
async function gemPlan() {
  try { await ligaDoc("plan/" + MIG).set({ valg: D.plan }); } catch (e) {}
}
function tegnMock(u, st) {
  var picks = u ? D.picks : [];
  var mine = holdPicks(MIG, picks);
  var e = ejere(picks);
  var n = u ? u.raekkefoelge.length : 0;
  var c = u ? u.raekkefoelge.indexOf(MIG) : -1;
  var html = "";
  for (var r = 0; r < SPILLERE_PR_HOLD; r++) {
    var pickNr = c >= 0 ? r * n + (r % 2 === 0 ? c : n - 1 - c) + 1 : null;
    var gjort = mine[r];
    var nu = u && !gjort && r === mine.length && st && !st.faerdig;
    var bud = nu ? mockBud(r, picks) : null;
    var tog = gjort && D.efterId[gjort.spillerId];
    html += '<div class="mock-raekke' + (nu ? " nu" : "") + (gjort ? " gjort" : "") + '">' +
      '<div class="mr-lab"><span class="mr-pick">' + (pickNr ? '<small>Pick</small>' + pickNr : '<small>Pick</small>?') + '</span>' +
      '<span class="mr-tx"><b>Valg ' + (r + 1) + '</b>' +
      '<small>' + (pickNr ? "Pick " + pickNr + " af " + n * SPILLERE_PR_HOLD : "Nummeret kommer, når ugens rækkefølge er klar") + '</small>' +
      (gjort ? '<small class="tog">Du tog ' + esc(tog ? tog.efternavn : gjort.spillerId) + '</small>' :
        nu && st.uid === MIG ? '<small class="nu-tekst">Din tur nu</small>' :
        pickNr && st && !st.faerdig ? '<small class="om">Om ' + (pickNr - 1 - st.k) + ' pick' + (pickNr - 1 - st.k === 1 ? "" : "s") + '</small>' : "") +
      '</span></div>';
    planRaekke(r).forEach(function (id, i) {
      var s = id && D.efterId[id];
      if (!s) {
        html += '<button type="button" class="mock-felt tom" data-r="' + r + '" data-c="' + i + '"><span class="mf-nr">' + (i + 1) + '</span>+ ' + (i + 1) + '. ønske</button>';
        return;
      }
      var status = "", kl = "";
      if (gjort && gjort.spillerId === id) { status = "Taget af dig"; kl = " din"; }
      else if (e[id] === MIG) { status = "Allerede på dit hold"; kl = " taget"; }
      else if (e[id]) { status = "Taget af " + esc(holdnavn(e[id])); kl = " taget"; }
      else if (bud === id) { status = "Dit bud"; kl = " bud"; }
      else if (nu && !maaVaelges(MIG, s, picks)) { status = "Positionen er fyldt"; kl = " taget"; }
      html += '<div class="mock-felt ' + s.pos + kl + '"><span class="mf-nr">' + (i + 1) + '</span>' + troeje(s.klub, 22) +
        '<span class="mf-tx"><span class="mf-navn">' + esc(fuldtNavn(s)) + skadeBadge(s.id) + '</span>' +
        '<small><span class="c-pos">' + s.pos + '</span>' + esc(s.klub) + ' · form ' + form(s.pris) + (status ? ' · <b>' + status + '</b>' : "") + '</small></span>' +
        '<button type="button" class="mf-fjern" data-r="' + r + '" data-c="' + i + '" aria-label="Fjern">×</button></div>';
    });
    html += '</div>';
  }
  $("mockListe").innerHTML = html;
}
function aabnPlanVaelger(r, c) {
  planSlot = { r: r, c: c };
  $("vaelgFor").textContent = "Mock draft · valg " + (r + 1) + " · " + (c + 1) + ". ønske";
  $("vaelgTitel").textContent = "Vælg et ønske";
  $("soeg").value = "";
  tegnFilter();
  tegnSpillerListe();
  $("vaelger").hidden = false;
  $("soeg").focus();
}

function tegnTicker(u, st) {
  var punkter = [];
  if (u && st && !st.faerdig && st.venter) {
    punkter.push("LIVE DRAFT · " + (st.harStart ? "starter " + visTid(st.startMs) : "tidspunkt ikke aftalt endnu"));
    punkter.push("VÆLGER FØRST · " + holdnavn(st.uid));
  } else if (u && st && !st.faerdig) {
    punkter.push("ON THE CLOCK · " + holdnavn(st.uid));
    punkter.push("DEADLINE · " + visTid(st.deadline));
  } else if (u) punkter.push("UGE " + u.nr + " · DRAFTEN ER FÆRDIG");
  D.picks.slice(-5).reverse().forEach(function (p) {
    var s = D.efterId[p.spillerId];
    if (s) punkter.push("DRAFTED · " + fuldtNavn(s) + " (" + s.pos + ") » " + holdnavn(p.uid));
  });
  var sejr = afgjorteUger()[0];
  if (sejr && sejr.vindere.length) punkter.push("UGENS VINDER · UGE " + sejr.nr + " · " + sejr.vindere.map(function (h) { return holdnavn(h.uid); }).join(" og ") + " med " + sejr.vindere[0].point + " point");
  var top = stilling()[0];
  if (top && top.total > 0) punkter.push("FØRER LIGAEN · " + holdnavn(top.uid) + " med " + top.total + " point");
  D.spillere.filter(function (s) { return s.forrige != null && s.pris > s.forrige; })
    .sort(function (a, b) { return (b.pris - b.forrige) - (a.pris - a.forrige); }).slice(0, 3)
    .forEach(function (s) { punkter.push("I FORM · " + fuldtNavn(s) + " ▲ " + form(s.pris)); });
  punkter.push(Object.keys(D.medlemmer).length + " hold i ligaen");
  var html = punkter.map(function (p) { return "<span>" + esc(p) + "</span>"; }).join("");
  $("ticker").innerHTML = html + html;
}

// =====================================================
//  SPILLERVÆLGER OG SPILLERKORT
// =====================================================
function aabnVaelger() {
  var u = aktivUge();
  if (!u) return;
  var st = ugeStatus(u, D.picks, Date.now());
  if (st.faerdig || st.venter || st.uid !== MIG) return;
  planSlot = null;
  $("vaelgFor").textContent = "Dit valg";
  $("vaelgTitel").textContent = "Ledige spillere";
  $("soeg").value = "";
  if (filterPos !== "ALLE" && antalPos(MIG, filterPos, D.picks) >= KVOTE[filterPos]) filterPos = "ALLE";
  tegnFilter();
  tegnSpillerListe();
  $("vaelger").hidden = false;
  $("soeg").focus();
}

function tegnFilter() {
  $("filter").querySelectorAll("button").forEach(function (b) {
    var pos = b.dataset.pos;
    if (pos !== "ALLE" && planSlot) {
      b.textContent = pos; b.disabled = false; b.classList.remove("fuld");
    } else if (pos !== "ALLE") {
      var a = antalPos(MIG, pos, D.picks), fuld = a >= KVOTE[pos];
      b.textContent = pos + " " + a + "/" + KVOTE[pos];
      b.disabled = fuld;
      b.classList.toggle("fuld", fuld);
    }
    b.setAttribute("aria-pressed", pos === filterPos ? "true" : "false");
  });
  var mangler = POS_RAEKKE.filter(function (p) { return antalPos(MIG, p, D.picks) < KVOTE[p]; })
    .map(function (p) { return (KVOTE[p] - antalPos(MIG, p, D.picks)) + " " + POSITIONER[p].toLowerCase(); });
  $("kvoteLinje").textContent = planSlot ? "Vælg en spiller til dit " + (planSlot.c + 1) + ". ønske. Spillere, der allerede er taget, vises ikke." :
    "Du mangler: " + mangler.join(", ") + ".";
  var bud = planSlot ? null : naesteMockBud(), bs = bud && D.efterId[bud];
  if (bs) {
    $("mockForslag").innerHTML = '<span class="mfs-lab">Fra din mock draft</span>' + troeje(bs.klub, 22) +
      '<span class="mfs-navn">' + esc(fuldtNavn(bs)) + ' <span class="c-pos ' + bs.pos + '">' + bs.pos + '</span></span>' +
      '<button type="button" class="kap-knap" data-id="' + esc(bs.id) + '">Vælg ham</button>';
    $("mockForslag").className = "mock-forslag " + bs.pos;
    $("mockForslag").hidden = false;
  } else $("mockForslag").hidden = true;
}

function trendHtml(s) {
  if (s.forrige == null || form(s.forrige) === form(s.pris)) return "<small>form</small>";
  var d = form(s.pris) - form(s.forrige);
  return '<small class="' + (d > 0 ? "op" : "ned") + '">form ' + (d > 0 ? "▲ +" : "▼ ") + d + '</small>';
}

function tegnSpillerListe() {
  var u = aktivUge();
  var t = taget(D.picks);
  var q = $("soeg").value.trim().toLowerCase();
  var liste = D.spillere.filter(function (s) {
    if (t[s.id]) return false;
    if (planSlot) { if (planRaekke(planSlot.r).indexOf(s.id) !== -1) return false; }
    else if (!maaVaelges(MIG, s, D.picks)) return false;
    if (filterPos !== "ALLE" && s.pos !== filterPos) return false;
    if (!q) return true;
    return (fuldtNavn(s) + " " + s.klub + " " + (KLUBBER[s.klub] || "")).toLowerCase().indexOf(q) !== -1;
  }).sort(function (a, b) { return b.pris - a.pris || a.efternavn.localeCompare(b.efternavn, "da"); });
  if (!liste.length) {
    $("spillerListe").innerHTML = '<li class="tom-tekst">Ingen ledige spillere passer til søgningen.</li>';
    return;
  }
  $("spillerListe").innerHTML = liste.slice(0, 150).map(function (s) {
    var raad = harRaad(u, MIG, s, D.picks);
    var info = s.k ? s.k + " kampe · " + s.g + " mål · " + s.a + " assists" : "Ingen kampe endnu";
    var sk = skadeFor(s.id);
    return '<li class="sp-raekke-wrap"><button type="button" class="sp-knap ' + s.pos + (sk && sk.status !== "tvivl" ? " ude" : "") + '" data-id="' + esc(s.id) + '"' + (raad ? "" : " disabled") + '>' +
      '<span class="tag ' + s.pos + '">' + s.pos + '</span>' +
      '<span class="sp-navn"><span class="navn-linje">' + troeje(s.klub, 18) + '<span>' + esc(fuldtNavn(s)) + '</span>' + skadeBadge(s.id) + '</span><small><span class="sp-klub-mobil">' + esc(KLUBBER[s.klub] || s.klub) + ' · </span>' + esc(info) + '</small>' + kampLinje(s.klub) + '</span>' +
      '<span class="sp-klub">' + esc(KLUBBER[s.klub] || s.klub) + '</span>' +
      '<span class="sp-pris" title="Form 0-100">' + form(s.pris) + trendHtml(s) + '</span></button>' +
      '<button type="button" class="sp-info-knap" data-info="' + esc(s.id) + '" aria-label="Se stats for ' + esc(fuldtNavn(s)) + '">i</button></li>';
  }).join("") + (liste.length > 150 ? '<li class="tom-tekst">Søg for at se flere spillere.</li>' : "");
}

// Hvor tit spilleren er blevet draftet i ligaen, og hvornår (kun færdige drafts tæller)
function draftStats(id) {
  var uger = 0, numre = [], runder = [], hold = {};
  Object.keys(D.uger).map(Number).forEach(function (nr) {
    var picks = picksForUge(nr), n = (D.uger[nr].raekkefoelge || []).length;
    if (!picks || !n || picks.length < n * SPILLERE_PR_HOLD) return;
    uger++;
    picks.forEach(function (p) {
      if (p.spillerId !== id) return;
      numre.push(p.nr + 1);
      runder.push(Math.floor(p.nr / n) + 1);
      hold[p.uid] = (hold[p.uid] || 0) + 1;
    });
  });
  if (!uger) return null;
  function typetal(liste) {
    var t = {};
    liste.forEach(function (x) { t[x] = (t[x] || 0) + 1; });
    return Object.keys(t).map(Number).sort(function (a, b) { return t[b] - t[a] || a - b; })[0];
  }
  var topHold = Object.keys(hold).sort(function (a, b) { return hold[b] - hold[a]; })[0];
  return { uger: uger, gange: numre.length, runde: typetal(runder),
    min: Math.min.apply(null, numre), max: Math.max.apply(null, numre),
    snit: numre.length ? numre.reduce(function (a, b) { return a + b; }, 0) / numre.length : null,
    hold: topHold || null, holdAntal: topHold ? hold[topHold] : 0 };
}

// Hvor attraktiv en spiller er: hans form blandet med, hvor tidligt ligaen plejer at tage ham.
// Jo flere færdige uger, jo mere vægt får ligaens vaner (fuld vægt efter 4 uger).
function attraktivitet() {
  var uger = [], hist = {};
  Object.keys(D.uger).map(Number).forEach(function (nr) {
    var picks = picksForUge(nr), n = (D.uger[nr].raekkefoelge || []).length;
    if (!picks || !n || picks.length < n * SPILLERE_PR_HOLD) return;
    uger.push(nr);
    var total = n * SPILLERE_PR_HOLD;
    picks.forEach(function (p) { hist[p.spillerId] = (hist[p.spillerId] || 0) + (1 - p.nr / total); });
  });
  var vaegt = Math.min(1, uger.length / 4) * 0.7;
  var res = {};
  POS_RAEKKE.forEach(function (pos) {
    var grp = D.spillere.filter(function (x) { return x.pos === pos; }).sort(function (a, b) { return a.pris - b.pris; });
    grp.forEach(function (x) {
      // Spillere med samme form får samme formtal
      var lavere = grp.filter(function (y) { return y.pris < x.pris; }).length;
      var f = grp.length > 1 ? lavere / (grp.length - 1) : 1;
      var h = uger.length ? (hist[x.id] || 0) / uger.length : 0;
      res[x.id] = (1 - vaegt) * f + vaegt * h;
    });
  });
  return { score: res, uger: uger.length, hist: hist };
}

// Skøn over chancen for, at spilleren stadig er ledig, når det er din tur næste gang.
// Bygger på hans form blandt de ledige på positionen, og hvor mange af holdene før dig der mangler positionen.
function chanceLedig(s) {
  var u = aktivUge();
  if (!u || !D.medlemmer[MIG] || u.raekkefoelge.indexOf(MIG) === -1) return null;
  var st = ugeStatus(u, D.picks, Date.now());
  var t = taget(D.picks);
  if (st.faerdig || t[s.id]) return null;
  if (!maaVaelges(MIG, s, D.picks)) return { fyldt: true };
  var n = u.raekkefoelge.length, mitK = -1;
  for (var k = st.k; k < st.total; k++) if (u.raekkefoelge[kolVed(k, n)] === MIG) { mitK = k; break; }
  if (mitK < 0) return null;
  var r = { pick: mitK + 1, om: mitK - st.k };
  if (mitK === st.k) { r.pct = 100; return r; }
  var foer = {};
  for (var j = st.k; j < mitK; j++) { var uid = u.raekkefoelge[kolVed(j, n)]; foer[uid] = (foer[uid] || 0) + 1; }
  var d = 0;
  Object.keys(foer).forEach(function (uid) {
    var aaben = KVOTE[s.pos] - antalPos(uid, s.pos, D.picks);
    var alle = SPILLERE_PR_HOLD - holdPicks(uid, D.picks).length;
    if (aaben > 0 && alle > 0) d += Math.min(aaben, foer[uid] * aaben / alle);
  });
  var at = attraktivitet();
  var mig = at.score[s.id];
  var rang = 1 + D.spillere.filter(function (x) { return x.pos === s.pos && !t[x.id] && at.score[x.id] > mig; }).length;
  r.ligaUger = at.uger;
  r.populaer = at.uger ? (at.hist[s.id] || 0) / at.uger : 0;
  var spred = Math.max(0.8, Math.sqrt(d) * 0.9);
  var taget_ = d <= 0 ? 0 : 1 / (1 + Math.exp((rang - 0.5 - d) / spred));
  r.pct = Math.max(1, Math.min(99, Math.round((1 - taget_) * 100)));
  r.foer = Object.keys(foer).filter(function (uid) { return KVOTE[s.pos] - antalPos(uid, s.pos, D.picks) > 0; }).length;
  return r;
}

// Spillerkortet: hvordan spillerens point i ugens runde (live eller endelige) er regnet ud
function tegnUgepoint(s, ejerUid) {
  var boks = $("kortUgepoint");
  var runde = aktivUgeNr != null ? pointRunde(aktivUgeNr) : null;
  if (!runde) { boks.hidden = true; return; }
  var r = rundePoint(s.id, s.pos, s.klub, runde);
  var gange = ejerUid && kaptajnFor(aktivUgeNr, ejerUid, D.picks) === s.id ? 2 : 1;
  boks.innerHTML = '<div class="kup-top"><span>Point i uge ' + aktivUgeNr + '</span>' + (runde.live ? '<span class="live-maerke">live</span>' : "") + '</div>' +
    pointLinjer(s, r, runde, gange, ejerUid ? "I alt for " + esc(holdnavn(ejerUid)) : "I alt <small>· ikke draftet i denne uge</small>");
  boks.hidden = false;
}
// Linjerne i en pointudregning (bruges i spillerkortet og på boardet)
function pointLinjer(s, r, runde, gange, sumTekst) {
  var posNavn = POSITIONER[s.pos].toLowerCase();
  var linje = function (tekst, lille, point, kl) {
    return '<div class="kup-r' + (kl ? " " + kl : "") + '"><span>' + tekst + (lille ? ' <small>· ' + lille + '</small>' : "") + '</span><b>' + point + '</b></div>';
  };
  var html = "";
  if (r.min > 0) html += linje("Spillede", r.min + " min." + (r.min >= 60 ? "" : " (under 60)"), "+" + ((r.min > 0 ? 1 : 0) + (r.min >= 60 ? 1 : 0)));
  if (r.g) html += linje("Mål", r.g + " × " + MAALPOINT[s.pos] + " (" + posNavn + ")", "+" + r.g * MAALPOINT[s.pos]);
  if (r.a) html += linje("Assist", r.a + " × 3", "+" + r.a * 3);
  if (r.cs && CSPOINT[s.pos]) html += linje("Clean sheet", posNavn, "+" + CSPOINT[s.pos]);
  if (r.y) html += linje("Gult kort", r.y > 1 ? r.y + " × 1" : "", "−" + r.y, "neg");
  if (r.rd) html += linje("Rødt kort", r.rd > 1 ? r.rd + " × 3" : "", "−" + 3 * r.rd, "neg");
  if (!r.min) html += '<p class="kup-tom">' + (runde.live ? "Ingen tal endnu – enten har han ikke spillet, eller kampen er ikke talt med endnu." : "Han spillede ikke i runden.") + '</p>';
  if (gange === 2) html += linje('<span class="kaptajn">C</span>Kaptajn · dobbelt point', "", "×2", "kap");
  return html + '<div class="kup-sum"><span>' + sumTekst + '</span><b>' + r.point * gange + '</b></div>';
}
function aabnSpillerKort(id, ejerUid) {
  var s = D.efterId[id];
  if (!s) return;
  document.querySelector("#spillerKort .kort-panel").className = "setup-panel kort-panel " + s.pos;
  $("kortFoto").textContent = initialer(s);
  $("kortKlub").textContent = KLUBBER[s.klub] || s.klub;
  $("kortNavn").textContent = fuldtNavn(s);
  $("kortFoto").innerHTML = troeje(s.klub, 44);
  $("kortInfo").innerHTML = '<span class="tag ' + s.pos + '">' + s.pos + '</span><span class="klub">' + POSITIONER[s.pos] +
    '</span><span class="prik">·</span>Form ' + form(s.pris) + ' ' + trendHtml(s).replace("<small", "<small style=\"display:inline\"");
  var sk = skadeFor(s.id);
  if (sk) {
    var retur = sk.retur && (/^\d{4}-\d\d-\d\d/.test(sk.retur) ? visDato(sk.retur) : sk.retur);
    $("kortStatus").innerHTML = '<b>' + SKADE_TEKST[sk.status] + '</b>' + (sk.grund ? " · " + esc(sk.grund) : "") +
      ' · Forventet retur: ' + (retur || "ukendt") +
      '<small>Kilde: skade- og karantænelister' + (D.skaderDato && visDato(D.skaderDato) ? ", opdateret " + visDato(D.skaderDato) : "") + '. Det er kun et fingerpeg – du kan stadig vælge ham.</small>';
    $("kortStatus").className = "status-boks" + (sk.status === "tvivl" ? " tvivl" : "");
    $("kortStatus").hidden = false;
  } else $("kortStatus").hidden = true;
  tegnUgepoint(s, ejerUid);
  var nk = naesteKamp(s.klub);
  if (nk) {
    $("kortKamp").innerHTML = '<span class="lab">Næste kamp</span><span class="mod">' + troeje(nk.mod, 22) + 'mod ' + esc(KLUBBER[nk.mod] || nk.mod) +
      ' <small>(' + (nk.hjemme ? "hjemme" : "ude") + ')</small></span><span class="tid">' + (nk.tid ? kampDato(nk.tid, true) : "") + '</span>';
    $("kortKamp").hidden = false;
  } else $("kortKamp").hidden = true;
  $("kortSaeson").innerHTML =
    '<div><b>' + s.k + '</b><span>kampe i sæsonen</span></div>' +
    '<div><b>' + s.g + '</b><span>mål</span></div>' +
    '<div><b>' + s.a + '</b><span>assists</span></div>' +
    '<div><b>' + s.min + '</b><span>minutter</span></div>';
  var ds = draftStats(s.id), ch = chanceLedig(s), dh = "";
  if (ch && ch.fyldt) {
    dh += '<p class="kd-tom">Du har ikke plads til flere ' + POSITIONER[s.pos].toLowerCase() + 'spillere denne uge.</p>';
  } else if (ch) {
    var farve = ch.pct >= 60 ? "god" : ch.pct >= 30 ? "mellem" : "lav";
    dh += '<div class="kort-chance ' + farve + '"><div class="kc-top"><b>' + ch.pct + ' %</b><span>' +
      (ch.om === 0 ? "Det er din tur – du kan tage ham nu." :
        "chance for, at han stadig er ledig ved dit næste pick (pick " + ch.pick + ", om " + ch.om + " pick" + (ch.om === 1 ? "" : "s") + ")") +
      '</span></div><div class="kc-bar"><i style="width:' + ch.pct + '%"></i></div>' +
      (ch.om ? '<small>Skøn ud fra hans form' + (ch.ligaUger ? ", hvor tidligt I plejer at tage ham" : "") + ' og at ' + ch.foer + ' af holdene før dig stadig mangler en ' + POSITIONER[s.pos].toLowerCase() + 'spiller.' +
        (ch.ligaUger >= 2 && ch.populaer >= 0.75 ? ' <b>Han bliver næsten altid taget tidligt i jeres liga.</b>' : ch.ligaUger >= 2 && ch.populaer >= 0.5 ? ' Han er populær i jeres liga.' : "") +
        (ch.ligaUger && ch.ligaUger < 4 ? ' Skønnet bliver bedre, jo flere uger I spiller.' : "") + '</small>' : "") + '</div>';
  }
  if (ds && ds.gange) {
    var snit = String(Math.round(ds.snit * 10) / 10).replace(".", ",");
    dh += '<div class="kort-saeson kort-draft">' +
      '<div><b>' + Math.round(ds.gange / ds.uger * 100) + ' %</b><span>draftet i ' + ds.gange + ' af ' + ds.uger + ' uger</span></div>' +
      '<div><b>Runde ' + ds.runde + '</b><span>typisk taget · ' + (ds.min === ds.max ? "pick " + ds.min : "pick " + ds.min + "–" + ds.max + ", snit " + snit) + '</span></div>' +
      '<div><b class="lille">' + esc(holdnavn(ds.hold)) + '</b><span>oftest valgt af' + (ds.holdAntal > 1 ? " (" + ds.holdAntal + " gange)" : "") + '</span></div></div>';
  } else if (ds) {
    dh += '<p class="kd-tom">Ingen har draftet ham ' + (ds.uger > 1 ? "i de " + ds.uger + " uger, I har spillet" : "i jeres første uge") + '.</p>';
  }
  $("kortDraft").innerHTML = dh;
  $("kortDraftBoks").hidden = !dh;
  var runder = D.runderListe.slice().sort(function (a, b) { return Date.parse(b.skrevet) - Date.parse(a.skrevet); }).slice(0, 5);
  if (runder.length) {
    $("kortRunder").innerHTML = runder.map(function (rd) {
      var r = rundePoint(s.id, s.pos, s.klub, rd);
      var kortTxt = (r.y ? r.y + " gult" : "") + (r.rd ? (r.y ? ", " : "") + r.rd + " rødt" : "");
      var d = kbhDele(Date.parse(rd.skrevet));
      return '<tr><td>' + d.d + '/' + d.m + '</td><td class="tal">' + r.min + '</td><td class="tal">' + r.g + '</td><td class="tal">' + r.a +
        '</td><td class="tal">' + (kortTxt || "–") + '</td><td class="tal">' + (r.cs ? "✓" : "–") + '</td><td class="tal point">' + r.point + '</td></tr>';
    }).join("");
    $("kortNote").textContent = runder.length < 5 ? "Der er kun " + runder.length + " runde" + (runder.length === 1 ? "" : "r") + " registreret indtil videre." : "";
  } else {
    $("kortRunder").innerHTML = '<tr><td colspan="7" class="tom-tekst">Ingen runder registreret endnu.</td></tr>';
    $("kortNote").textContent = "Runderne bliver registreret hver tirsdag fra nu af. Indtil da kan du se sæsontallene ovenfor.";
  }
  $("kortEjer").textContent = ejerUid ? "Draftet af " + holdnavn(ejerUid) + " i uge " + aktivUgeNr : "";
  var u = aktivUge();
  var kanKap = ejerUid === MIG && kanVaelgeKaptajn(u);
  var erKap = u && kaptajnFor(u.nr, MIG, D.picks) === s.id;
  $("kortKaptajn").hidden = !kanKap;
  $("kortKaptajn").disabled = !!erKap;
  $("kortKaptajn").textContent = erKap ? "C · Han er din kaptajn" : "Gør til kaptajn (dobbelt point)";
  $("kortKaptajn").dataset.id = s.id;
  $("spillerKort").hidden = false;
}

// =====================================================
//  ADMIN
// =====================================================
function tegnAdmin() {
  $("adminLiganavn").textContent = (D.info && D.info.navn) || "";
  $("delLink").value = location.origin + location.pathname;
  var ids = Object.keys(D.medlemmer);
  $("medlemAntal").textContent = ids.length;
  $("medlemListe").innerHTML = ids.map(function (uid) {
    var m = D.medlemmer[uid];
    return '<li><span>' + esc(m.holdnavn) + '</span>' + (uid === MIG ? '<small>Dig</small>' : "") + '</li>';
  }).join("") || '<li><small>Ingen endnu.</small></li>';

  var type = draftform();
  $("draftformValg").querySelectorAll("button").forEach(function (b) {
    b.setAttribute("aria-pressed", b.dataset.type === type ? "true" : "false");
  });
  $("draftformInfo").textContent = type === "live" ?
    "Live draft: Når en ny uge starter, aftaler I et tidspunkt. Hver har 2 minutter pr. valg. Gælder fra næste draft, der startes." :
    "Ugedraft: Valgene laves i løbet af ugen, og tiden pr. valg fordeles frem til fredag kl. 18. Gælder fra næste draft, der startes.";

  var u = aktivUge();
  var stU = u ? ugeStatus(u, D.picks, Date.now()) : null;
  var visLive = !!(u && u.type === "live" && stU && !stU.faerdig && stU.venter);
  $("liveFelt").hidden = !visLive;
  if (visLive) {
    $("liveUgeNr").textContent = u.nr;
    if (!$("liveStartInput").value) {
      var forslag = u.start ? Date.parse(u.start) : Date.now() + 3600000;
      var d = new Date(forslag - new Date(forslag).getTimezoneOffset() * 60000);
      $("liveStartInput").value = d.toISOString().slice(0, 16);
    }
    $("liveInfo").textContent = (u.start ? "Aftalt: " + visTid(Date.parse(u.start)) + ". " : "Intet tidspunkt endnu. ") +
      "Draften tager op til " + Math.ceil(u.raekkefoelge.length * SPILLERE_PR_HOLD * u.sekPrPick / 60) +
      " minutter og skal være færdig inden " + visTid(Date.parse(u.deadline)) +
      ". Sættes der ikke et tidspunkt, vælges alle spillere automatisk ved deadline.";
  }

  var knap = $("startUgeKnap");
  if (!u) {
    knap.textContent = "Start uge 1";
    knap.disabled = ids.length < 2 || !D.spillere.length;
    $("adminDraftInfo").textContent = ids.length < 2 ? "Der skal være mindst 2 hold med for at starte." :
      (type === "live" ? "Ugen oprettes nu, og derefter sætter du tidspunktet for live draften. Den skal være færdig inden " :
        "Draften starter nu og lukker ") + visTid(naesteFredag18(Date.now())) + ". Første uge trækkes rækkefølgen tilfældigt.";
  } else if (Date.now() >= Date.parse(u.deadline) && !D.uger[u.nr + 1]) {
    knap.textContent = "Start uge " + (u.nr + 1) + " nu";
    knap.disabled = ids.length < 2;
    $("adminDraftInfo").textContent = D.runder[u.nr] ? "Rundens point er klar, så næste uge starter normalt af sig selv." :
      "Rundens point er ikke kommet endnu. Starter du nu, bestemmes rækkefølgen af den samlede stilling.";
  } else {
    knap.textContent = "Uge " + u.nr + " er i gang";
    knap.disabled = true;
    $("adminDraftInfo").textContent = "Næste uges draft starter automatisk, når pointene er regnet ud tirsdag morgen.";
  }
}

async function gemLigaInfo(ekstra) {
  await db.doc("ligaer/" + LIGA).update(ekstra);
}

// =====================================================
//  HÆNDELSER
// =====================================================
$("blok").addEventListener("click", aabnVaelger);
$("draftKnap").addEventListener("click", async function () {
  if (!valgt) { aabnVaelger(); return; }
  this.disabled = true;
  try { await draftManuelt(valgt); valgt = null; delete $("dinTurTekst").dataset.fejl; }
  catch (e) {
    $("dinTurTekst").textContent = e.message;
    $("dinTurTekst").dataset.fejl = "1";
    setTimeout(function () { delete $("dinTurTekst").dataset.fejl; }, 5000);
  }
  planlaegTegning();
});

$("lukVaelger").addEventListener("click", function () { $("vaelger").hidden = true; });
$("soeg").addEventListener("input", tegnSpillerListe);
$("filter").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b || b.disabled) return;
  filterPos = b.dataset.pos;
  tegnFilter();
  tegnSpillerListe();
});
$("spillerListe").addEventListener("click", function (e) {
  var info = e.target.closest(".sp-info-knap");
  if (info) { aabnSpillerKort(info.dataset.info); return; }
  var knap = e.target.closest(".sp-knap");
  if (!knap || knap.disabled) return;
  if (planSlot) {
    D.plan[planSlot.r * MOCK_ANTAL + planSlot.c] = knap.dataset.id;
    planSlot = null;
    $("vaelger").hidden = true;
    gemPlan();
    planlaegTegning();
    return;
  }
  valgt = D.efterId[knap.dataset.id] || null;
  $("vaelger").hidden = true;
  planlaegTegning();
  $("draftKnap").focus();
});
var aabnePoint = {};
$("board").addEventListener("click", function (e) {
  var pb = e.target.closest(".pboks[data-point]");
  if (pb) { aabnePoint[pb.dataset.point] = !aabnePoint[pb.dataset.point]; tegnAlt(); return; }
  if (e.target.closest("#kapKnap")) { kaptajnTilstand = !kaptajnTilstand; tegnAlt(); return; }
  var c = e.target.closest(".cell.klik");
  if (!c) return;
  if (kaptajnTilstand && c.dataset.ejer === MIG) { saetKaptajn(c.dataset.spiller); return; }
  aabnSpillerKort(c.dataset.spiller, c.dataset.ejer);
});
$("board").addEventListener("keydown", function (e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  if (e.target.closest(".pboks")) return;
  var c = e.target.closest(".cell.klik");
  if (!c) return;
  e.preventDefault();
  if (kaptajnTilstand && c.dataset.ejer === MIG) saetKaptajn(c.dataset.spiller);
  else aabnSpillerKort(c.dataset.spiller, c.dataset.ejer);
});
$("lukKort").addEventListener("click", function () { $("spillerKort").hidden = true; });
$("mockForslag").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-id]");
  if (!b) return;
  valgt = D.efterId[b.dataset.id] || null;
  $("vaelger").hidden = true;
  planlaegTegning();
  $("draftKnap").focus();
});
$("mockListe").addEventListener("click", function (e) {
  var f = e.target.closest(".mf-fjern");
  if (f) { D.plan[+f.dataset.r * MOCK_ANTAL + +f.dataset.c] = ""; gemPlan(); planlaegTegning(); return; }
  var t = e.target.closest(".mock-felt.tom");
  if (t) aabnPlanVaelger(+t.dataset.r, +t.dataset.c);
});
$("mockRyd").addEventListener("click", function () { D.plan = tomPlan(); gemPlan(); planlaegTegning(); });
$("kortKaptajn").addEventListener("click", function () { saetKaptajn($("kortKaptajn").dataset.id); $("spillerKort").hidden = true; });
$("historikListe").addEventListener("click", function (e) {
  var b = e.target.closest("[data-uge]");
  if (!b) return;
  var nr = +b.dataset.uge;
  aabenHistorik = aabenHistorik === nr ? null : nr;
  tegnHistorik();
});
["vaelger", "spillerKort", "admin"].forEach(function (id) {
  $(id).addEventListener("click", function (e) { if (e.target === $(id)) $(id).hidden = true; });
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    ["vaelger", "spillerKort", "admin"].forEach(function (id) { $(id).hidden = true; });
    if (kaptajnTilstand) { kaptajnTilstand = false; planlaegTegning(); }
  }
});

$("hovedfaner").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b) return;
  $("hovedfaner").querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
  $("hovedfaner").querySelectorAll("button").forEach(function (x) { $(x.dataset.fane + "Fane").hidden = x !== b; });
});

$("adminKnap").addEventListener("click", async function () {
  $("liveStartInput").value = "";
  $("kodeInputAdmin").value = "";
  tegnAdmin();
  $("admin").hidden = false;
  try {
    var s = await ligaDoc("privat/kode").get();
    if (s.exists) $("kodeInputAdmin").value = s.data().kode;
  } catch (e) {}
});
$("lukAdmin").addEventListener("click", function () { $("admin").hidden = true; });
$("gemKode").addEventListener("click", async function () {
  var kode = $("kodeInputAdmin").value.trim();
  if (kode.length < 4) { $("adminFejl").textContent = "Koden skal være mindst 4 tegn."; return; }
  try { await ligaDoc("privat/kode").set({ kode: kode }); $("adminFejl").textContent = "Koden er skiftet. Nye medlemmer skal bruge den nye kode."; }
  catch (e) { $("adminFejl").textContent = "Koden kunne ikke gemmes."; }
});
$("kopierLink").addEventListener("click", async function () {
  try { await navigator.clipboard.writeText($("delLink").value); this.textContent = "Kopieret"; }
  catch (e) { $("delLink").select(); }
});
$("draftformValg").addEventListener("click", async function (e) {
  var b = e.target.closest("button");
  if (!b) return;
  try { await gemLigaInfo({ drafttype: b.dataset.type }); $("adminFejl").textContent = ""; }
  catch (err) { $("adminFejl").textContent = "Draftformen kunne ikke gemmes."; }
});
$("gemLiveStart").addEventListener("click", async function () {
  var v = $("liveStartInput").value;
  if (!v) { $("adminFejl").textContent = "Vælg dato og klokkeslæt."; return; }
  try { await saetLiveStart(new Date(v).getTime()); $("adminFejl").textContent = "Tidspunktet er gemt."; }
  catch (err) { $("adminFejl").textContent = err.message; }
});
async function startLiveNu(felt) {
  try { await saetLiveStart(Date.now() + 5000); felt.textContent = ""; $("admin").hidden = true; }
  catch (err) { felt.textContent = err.message; }
}
$("startLiveNu").addEventListener("click", function () { startLiveNu($("adminFejl")); });
$("lobbyStartNu").addEventListener("click", function () { startLiveNu($("lobbyTekst")); });
$("klarKnap").addEventListener("click", async function () {
  var u = aktivUge();
  if (!u) return;
  var ref = ligaDoc("uger/" + u.nr + "/klar/" + MIG);
  try { if (D.klar[MIG]) await ref.delete(); else await ref.set({ tid: new Date().toISOString() }); } catch (err) {}
});
$("startUgeKnap").addEventListener("click", async function () {
  var ids = Object.keys(D.medlemmer);
  if (ids.length < 2) return;
  this.disabled = true;
  try {
    var u = aktivUge();
    if (!u) {
      for (var i = ids.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
      await opretUge(1, ids, Date.now());
    } else {
      await opretUge(u.nr + 1, naesteRaekkefoelge(u.nr), Date.now());
    }
    $("admin").hidden = true;
  } catch (e) { $("adminFejl").textContent = "Ugen kunne ikke startes: " + (e.message || "ukendt fejl"); this.disabled = false; }
});

// Ur: nedtælling, automatiske valg og ny uge
setInterval(function () {
  if (!MIG || !LIGA) return;
  var u = aktivUge();
  if (u) { tegnStatus(u, ugeStatus(u, D.picks, Date.now())); indhentUdloebne(); }
  tjekNyUge();
}, 1000);

// Hent nye priser og runder hvert 10. minut
setInterval(hentDatafiler, 10 * 60000);

// =====================================================
//  START
// =====================================================
tegnLoginForm();
hentDatafiler();
auth.onAuthStateChanged(async function (bruger) {
  lukLiga();
  if (bruger) {
    MIG = bruger.uid;
    MIT_NAVN = bruger.displayName || (bruger.email ? bruger.email.split("@")[0] : "");
    var sidste = await hentMineLigaer();
    if (sidste && MINE_LIGAER.some(function (l) { return l.id === sidste; })) aabnLiga(sidste);
    else if (MINE_LIGAER.length === 1) aabnLiga(MINE_LIGAER[0].id);
  } else {
    MIG = null;
    MINE_LIGAER = [];
    lukLiga();
  }
  planlaegTegning();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
}
