// =====================================================
//  SUPERLIGA DRAFT – web-app (Firebase)
//
//  Firestore:
//   liga/info              { navn, ejer, drafttype }
//   medlemmer/<uid>        { holdnavn, navn, tilmeldt }
//   uger/<nr>              { nr, type, start, deadline, raekkefoelge, budget, sekPrPick, antalPicks }
//   uger/<nr>/picks/<k>    { nr, uid, spillerId, pos, klub, pris, tid, auto }
//   uger/<nr>/klar/<uid>   { tid }
//
//  Filer i repoet (opdateres hver tirsdag):
//   data/priser.json       priser + sæsontal
//   data/runder.json       { runder: [{ id, skrevet, spillere: {id: [min, mål, ass, gule, røde]}, modtaget: {klub: mål} }] }
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

firebase.initializeApp(window.FIREBASE_CONFIG);
var auth = firebase.auth();
var db = firebase.firestore();

var MIG = null, MIT_NAVN = "", ER_EJER = false;
var LIGA = null;            // id på den liga, der er åben
var MINE_LIGAER = [];       // [{ id, navn }]
function ligaDoc(sti) { return db.doc("ligaer/" + LIGA + "/" + sti); }
function ligaCol(sti) { return db.collection("ligaer/" + LIGA + "/" + sti); }
var D = { spillere: [], efterId: {}, prisDato: null, info: null, infoHentet: false, medlemmer: {},
  uger: {}, picks: [], klar: {}, runderListe: [], runder: {} };
var aktivUgeNr = null, picksUnsub = null, klarUnsub = null, lyttere = [];
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
function kr(x) { return (Math.round(x * 10) / 10).toFixed(1).replace(".", ",") + " mio"; }
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

function ugePointForHold(ugeNr, uid, picks) {
  var runde = D.runder[ugeNr];
  if (!runde) return null;
  return picks.filter(function (p) { return p.uid === uid; }).reduce(function (s, p) {
    var r = rundePoint(p.spillerId, p.pos, p.klub, runde);
    return s + (r ? r.point : 0);
  }, 0);
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
    var picks = nr === aktivUgeNr ? D.picks : tidligerePicks[nr];
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

function harRaad(u, uid, s, picks) {
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
  var mulige = D.spillere.filter(function (s) { return !t[s.id] && maaVaelges(uid, s, picks); });
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
  } catch (e) { $("tbOpdateret").textContent = "Priser utilgængelige"; }
  try {
    var r2 = await fetch("data/runder.json?v=" + Date.now(), { cache: "no-store" });
    if (r2.ok) { var j = await r2.json(); D.runderListe = j.runder || []; kobRunderTilUger(); }
  } catch (e) {}
  planlaegTegning();
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
  $("tbOpdateret").textContent = dele.length === 3 ? "Priser opdateret " + (+dele[2]) + "/" + (+dele[1]) : "";
}

function abonnerPaaUge(nr) {
  if (picksUnsub) picksUnsub();
  if (klarUnsub) klarUnsub();
  D.picks = []; D.klar = {};
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
  picksUnsub = klarUnsub = null;
  aktivUgeNr = null;
  tidligerePicks = {};
  valgt = null;
  D.medlemmer = {}; D.uger = {}; D.picks = []; D.klar = {}; D.info = null; D.infoHentet = false; D.runder = {};
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
      holdnavn: hold, navn: MIT_NAVN, kode: kode, tilmeldt: new Date().toISOString()
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
    batch.set(db.doc("ligaer/" + id + "/medlemmer/" + MIG), { holdnavn: hold, navn: MIT_NAVN, kode: kode, tilmeldt: new Date().toISOString() });
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
    $("forrigeSpiller").innerHTML = esc(fuldtNavn(s0)) + ' <span class="tag ' + s0.pos + '">' + s0.pos + '</span>';
    $("forrigeMgr").innerHTML = '<span>»</span> ' + esc(holdnavn(sidste.uid)) + ' · ' + kr(sidste.pris) +
      (sidste.auto ? ' <small style="color:var(--daempet);font-weight:400">(automatisk)</small>' : "");
  } else {
    $("forrigeSpiller").textContent = "Ingen endnu";
    $("forrigeMgr").textContent = "";
  }

  var t = $("timer");
  if (!u) {
    blok.disabled = true;
    $("blokFoto").textContent = "?";
    $("blokNavn").textContent = "VENTER PÅ DRAFT";
    $("blokInfo").textContent = ER_EJER ? "Åbn ⚙ og start ugens draft, når alle er med." : "Ugens draft er ikke startet endnu.";
    $("kmNavn").textContent = "–"; $("kmPick").textContent = ""; $("kmBudget").textContent = "";
    t.textContent = "–"; t.className = "timer";
    $("draftKnap").disabled = true;
    return;
  }

  if (st.faerdig) {
    blok.disabled = true;
    $("blokFoto").textContent = "✓";
    $("blokNavn").textContent = "UGENS DRAFT ER FÆRDIG";
    $("blokInfo").textContent = D.runder[u.nr] ? "Point for runden er regnet ud. Se stillingen." :
      "Point kommer tirsdag, når weekendens runde er spillet.";
    $("kmNavn").textContent = "Færdig";
    $("kmPick").textContent = st.total + " picks";
    $("kmBudget").textContent = u.raekkefoelge.indexOf(MIG) !== -1 ? "Du brugte " + kr(brugt(MIG, D.picks)) : "";
    t.textContent = "0:00"; t.className = "timer";
    $("draftKnap").disabled = true;
    return;
  }

  if (st.venter) {
    blok.disabled = true;
    valgt = null;
    $("blokFoto").textContent = "⏱";
    $("blokNavn").textContent = st.harStart ? "DRAFTEN STARTER SNART" : "LIVE DRAFT";
    $("blokInfo").textContent = st.harStart ? "Første valg: " + holdnavn(st.uid) + " · " + visTid(st.startMs) :
      "Venter på, at der bliver aftalt et tidspunkt.";
    $("kmNavn").textContent = holdnavn(st.uid);
    $("kmPick").textContent = "Vælger først";
    $("kmBudget").textContent = "Budget " + kr(u.budget);
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
  var r = rest(u, st.uid, D.picks);
  $("kmBudget").textContent = kr(r) + " tilbage";
  $("kmBudget").className = "km-budget" + (r < u.budget * 0.2 ? " lav" : "");
  t.textContent = visVarighed(venstre);
  t.className = "timer" + (venstre < graense ? " kritisk" : "") + (venstre < Math.min(60000, graense / 3) ? " panik" : "");

  if (minTur) {
    $("dinTur").hidden = false;
    if (!$("dinTurTekst").dataset.fejl) {
      $("dinTurTekst").textContent = "Vælg din spiller inden " + visTid(st.turSlut) +
        ". Ellers vælger appen den bedste spiller, du har råd til.";
    }
    blok.disabled = false;
    if (valgt && !taget(D.picks)[valgt.id]) {
      blok.classList.add("har-valg", valgt.pos);
      $("blokFoto").textContent = initialer(valgt);
      $("blokNavn").textContent = fuldtNavn(valgt).toUpperCase();
      $("blokInfo").innerHTML = '<span class="tag ' + valgt.pos + '">' + valgt.pos + '</span><span class="klub">' +
        esc(KLUBBER[valgt.klub] || valgt.klub) + '</span><span class="prik">·</span>' + kr(valgt.pris) +
        '<span class="prik">·</span>Tryk ✓ for at drafte';
      $("draftKnap").disabled = false;
    } else {
      valgt = null;
      $("blokFoto").textContent = "?";
      $("blokNavn").textContent = "VÆLG DIN SPILLER";
      $("blokInfo").textContent = "Klik her for at se de ledige spillere.";
      $("draftKnap").disabled = true;
    }
  } else {
    blok.disabled = true;
    valgt = null;
    $("blokFoto").textContent = holdnavn(st.uid).slice(0, 2).toUpperCase();
    $("blokNavn").textContent = holdnavn(st.uid).toUpperCase();
    var minPlads = naesteTurFor(u, MIG);
    $("blokInfo").textContent = "Vælger nu." + (minPlads > 0 ? " Du er på om " + minPlads + " valg." : "");
    $("draftKnap").disabled = true;
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
  board.style.gridTemplateColumns = "repeat(" + n + ", minmax(150px, 1fr))";
  var runde = D.runder[u.nr];
  var aktivRunde = st.faerdig ? -1 : Math.floor(st.k / n);

  var html = "";
  u.raekkefoelge.forEach(function (uid, c) {
    var aktiv = !st.faerdig && !st.venter && st.kol === c;
    var mine = holdPicks(uid, D.picks);
    var r0 = rest(u, uid, D.picks);
    var pt = ugePointForHold(u.nr, uid, D.picks);
    var m = D.medlemmer[uid];
    html += '<div class="kol' + (aktiv ? " aktiv" : "") + (uid === MIG ? " mig-kol" : "") + '"><div class="kol-top">' +
      (uid === MIG ? '<div class="k-mig">Dit hold</div>' : "") +
      '<div class="k-navn">' + esc(holdnavn(uid)) + '</div>' +
      (m && m.navn ? '<div class="k-pnavn">' + esc(m.navn) + '</div>' : "") +
      '<div class="k-tal">' + (pt !== null ? pt + '<small> point</small>' : mine.length + '<small>/' + SPILLERE_PR_HOLD + '</small>') + '</div>' +
      '<div class="k-budget' + (r0 < u.budget * 0.2 && !st.faerdig ? " lav" : "") + '">' + kr(r0) + ' tilbage</div>' +
      '<div class="k-sub">' + (st.faerdig ? "Færdig" : aktiv ? "På uret nu" : "Valg " + (c + 1) + " i runde 1") + '</div>' +
      '<div class="k-kvote">' + POS_RAEKKE.map(function (pos) {
        var a = antalPos(uid, pos, D.picks);
        return '<span class="' + pos + (a >= KVOTE[pos] ? " fuld" : "") + '" title="' + POSITIONER[pos] + '">' + pos + " " + a + "/" + KVOTE[pos] + '</span>';
      }).join("") + '</div></div>';

    for (var r = 0; r < SPILLERE_PR_HOLD; r++) {
      var pick = D.picks.filter(function (x) { return x.uid === uid && Math.floor(x.nr / n) === r; })[0];
      if (pick) {
        var s = D.efterId[pick.spillerId] || { id: pick.spillerId, fornavn: "", efternavn: pick.spillerId, pos: pick.pos, klub: pick.klub };
        var rp = runde ? rundePoint(pick.spillerId, pick.pos, pick.klub, runde) : null;
        html += '<div class="cell klik ' + pick.pos + '" data-spiller="' + esc(pick.spillerId) + '" data-ejer="' + esc(uid) + '" tabindex="0" role="button">' +
          '<div class="c-top"><span class="c-lab">' + esc(s.fornavn ? s.fornavn + " · " : "") + pick.pos + ' · ' + esc(pick.klub) + '</span>' +
          (rp ? '<span class="c-point">' + (rp.point > 0 ? "+" : "") + rp.point + '</span>' : '<span class="c-pris">' + kr(pick.pris).replace(" mio", "") + '</span>') +
          '</div><div class="c-navn">' + esc(s.efternavn) + '</div></div>';
      } else if (aktiv && r === aktivRunde) {
        html += '<div class="cell nu"><span>På uret</span></div>';
      } else {
        html += '<div class="cell tom"><span>' + (r + 1) + '</span></div>';
      }
    }
    html += '</div>';
  });
  board.innerHTML = html;
}

function tegnStilling() {
  var raekker = stilling();
  $("stillingBody").innerHTML = raekker.map(function (r, i) {
    var m = D.medlemmer[r.uid];
    return '<tr' + (r.uid === MIG ? ' class="mig-raekke"' : "") + '><td class="plads">' + (i + 1) + '</td>' +
      '<td><div class="hold-navn">' + esc(holdnavn(r.uid)) + (m && m.navn ? '<small>' + esc(m.navn) + '</small>' : "") + '</div></td>' +
      '<td class="tal">' + (r.sidste === null ? "–" : r.sidste) + '</td>' +
      '<td class="tal">' + r.runder + '</td>' +
      '<td class="tal point">' + r.total + '</td></tr>';
  }).join("") || '<tr><td colspan="5" class="tom-tekst">Ingen hold endnu.</td></tr>';
  var antalRunder = Object.keys(D.runder).length;
  $("stillingInfo").textContent = antalRunder ? antalRunder + " runde" + (antalRunder === 1 ? "" : "r") + " er talt med." :
    "Stillingen bliver regnet ud efter første runde. Point kommer hver tirsdag morgen.";
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
    if (s) punkter.push("DRAFTED · " + fuldtNavn(s) + " (" + s.pos + ", " + kr(p.pris) + ") » " + holdnavn(p.uid));
  });
  var top = stilling()[0];
  if (top && top.total > 0) punkter.push("FØRER LIGAEN · " + holdnavn(top.uid) + " med " + top.total + " point");
  D.spillere.filter(function (s) { return s.forrige != null && s.pris > s.forrige; })
    .sort(function (a, b) { return (b.pris - b.forrige) - (a.pris - a.forrige); }).slice(0, 3)
    .forEach(function (s) { punkter.push("PRISSTIGNING · " + fuldtNavn(s) + " ▲ " + kr(s.pris)); });
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
  $("vaelgFor").textContent = "Dit valg · " + kr(rest(u, MIG, D.picks)) + " tilbage";
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
    if (pos !== "ALLE") {
      var a = antalPos(MIG, pos, D.picks), fuld = a >= KVOTE[pos];
      b.textContent = pos + " " + a + "/" + KVOTE[pos];
      b.disabled = fuld;
      b.classList.toggle("fuld", fuld);
    }
    b.setAttribute("aria-pressed", pos === filterPos ? "true" : "false");
  });
  var mangler = POS_RAEKKE.filter(function (p) { return antalPos(MIG, p, D.picks) < KVOTE[p]; })
    .map(function (p) { return (KVOTE[p] - antalPos(MIG, p, D.picks)) + " " + POSITIONER[p].toLowerCase(); });
  $("kvoteLinje").textContent = "Du mangler: " + mangler.join(", ") + ".";
}

function trendHtml(s) {
  if (s.forrige == null || s.forrige === s.pris) return "<small>uændret</small>";
  var d = s.pris - s.forrige;
  return '<small class="' + (d > 0 ? "op" : "ned") + '">' + (d > 0 ? "▲ +" : "▼ ") + kr(d).replace(" mio", "") + '</small>';
}

function tegnSpillerListe() {
  var u = aktivUge();
  var t = taget(D.picks);
  var q = $("soeg").value.trim().toLowerCase();
  var liste = D.spillere.filter(function (s) {
    if (t[s.id] || !maaVaelges(MIG, s, D.picks)) return false;
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
    return '<li class="sp-raekke-wrap"><button type="button" class="sp-knap ' + s.pos + '" data-id="' + esc(s.id) + '"' + (raad ? "" : " disabled") + '>' +
      '<span class="tag ' + s.pos + '">' + s.pos + '</span>' +
      '<span class="sp-navn">' + esc(fuldtNavn(s)) + '<small>' + esc(info) + (raad ? "" : ' · <span class="for-dyr">For dyr</span>') + '</small></span>' +
      '<span class="sp-klub">' + esc(KLUBBER[s.klub] || s.klub) + '</span>' +
      '<span class="sp-pris">' + kr(s.pris) + trendHtml(s) + '</span></button>' +
      '<button type="button" class="sp-info-knap" data-info="' + esc(s.id) + '" aria-label="Se stats for ' + esc(fuldtNavn(s)) + '">i</button></li>';
  }).join("") + (liste.length > 150 ? '<li class="tom-tekst">Søg for at se flere spillere.</li>' : "");
}

function aabnSpillerKort(id, ejerUid) {
  var s = D.efterId[id];
  if (!s) return;
  document.querySelector("#spillerKort .kort-panel").className = "setup-panel kort-panel " + s.pos;
  $("kortFoto").textContent = initialer(s);
  $("kortKlub").textContent = KLUBBER[s.klub] || s.klub;
  $("kortNavn").textContent = fuldtNavn(s);
  $("kortInfo").innerHTML = '<span class="tag ' + s.pos + '">' + s.pos + '</span><span class="klub">' + POSITIONER[s.pos] +
    '</span><span class="prik">·</span>' + kr(s.pris) + ' ' + trendHtml(s).replace("<small", "<small style=\"display:inline\"");
  $("kortSaeson").innerHTML =
    '<div><b>' + s.k + '</b><span>kampe i sæsonen</span></div>' +
    '<div><b>' + s.g + '</b><span>mål</span></div>' +
    '<div><b>' + s.a + '</b><span>assists</span></div>' +
    '<div><b>' + s.min + '</b><span>minutter</span></div>';
  var runder = D.runderListe.slice().sort(function (a, b) { return Date.parse(b.skrevet) - Date.parse(a.skrevet); }).slice(0, 5);
  if (runder.length) {
    $("kortRunder").innerHTML = runder.map(function (rd) {
      var r = rundePoint(s.id, s.pos, s.klub, rd);
      var kortTxt = (r.y ? r.y + " gult" : "") + (r.rd ? (r.y ? ", " : "") + r.rd + " rødt" : "");
      var d = kbhDele(Date.parse(rd.skrevet));
      return '<tr><td>Uge til ' + d.d + '/' + d.m + '</td><td class="tal">' + r.min + '</td><td class="tal">' + r.g + '</td><td class="tal">' + r.a +
        '</td><td class="tal">' + (kortTxt || "–") + '</td><td class="tal">' + (r.cs ? "✓" : "–") + '</td><td class="tal point">' + r.point + '</td></tr>';
    }).join("");
    $("kortNote").textContent = runder.length < 5 ? "Der er kun " + runder.length + " runde" + (runder.length === 1 ? "" : "r") + " registreret indtil videre." : "";
  } else {
    $("kortRunder").innerHTML = '<tr><td colspan="7" class="tom-tekst">Ingen runder registreret endnu.</td></tr>';
    $("kortNote").textContent = "Runderne bliver registreret hver tirsdag fra nu af. Indtil da kan du se sæsontallene ovenfor.";
  }
  $("kortEjer").textContent = ejerUid ? "Draftet af " + holdnavn(ejerUid) + " i uge " + aktivUgeNr : "";
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
    return '<li><span>' + esc(m.holdnavn) + '</span><small>' + esc(m.navn || "") + '</small></li>';
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
  valgt = D.efterId[knap.dataset.id] || null;
  $("vaelger").hidden = true;
  planlaegTegning();
  $("draftKnap").focus();
});
$("board").addEventListener("click", function (e) {
  var c = e.target.closest(".cell.klik");
  if (c) aabnSpillerKort(c.dataset.spiller, c.dataset.ejer);
});
$("board").addEventListener("keydown", function (e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  var c = e.target.closest(".cell.klik");
  if (c) { e.preventDefault(); aabnSpillerKort(c.dataset.spiller, c.dataset.ejer); }
});
$("lukKort").addEventListener("click", function () { $("spillerKort").hidden = true; });
["vaelger", "spillerKort", "admin"].forEach(function (id) {
  $(id).addEventListener("click", function (e) { if (e.target === $(id)) $(id).hidden = true; });
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") ["vaelger", "spillerKort", "admin"].forEach(function (id) { $(id).hidden = true; });
});

$("hovedfaner").addEventListener("click", function (e) {
  var b = e.target.closest("button");
  if (!b) return;
  $("hovedfaner").querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
  $("boardFane").hidden = b.dataset.fane !== "board";
  $("stillingFane").hidden = b.dataset.fane !== "stilling";
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
