// Tests du plugin Quota Claude : `node test.js` (Node, sans dépendance). `main.js` est chargé
// dans un contexte à part avec un faux objet `horizon` : le test pilote l'horloge, le fichier
// d'identifiants et la réponse de l'API, et relit ce que le script pose sur l'interface. Les cas
// sont ceux des tests Rust du widget natif (quota.rs, claude_quota/, ui/time.rs). Ce fichier
// n'est pas livré dans le paquet du plugin.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const MANIFESTE = JSON.parse(fs.readFileSync(path.join(__dirname, "plugin.json"), "utf8"));

const ADRESSE = "https://api.anthropic.com/api/oauth/usage";
const FICHIER = "%USERPROFILE%/.claude/.credentials.json";
const JETON = "sk-ant-oat01-JETON-DE-TEST-0123456789";
const IDENTIFIANTS = JSON.stringify({ claudeAiOauth: { accessToken: JETON, expiresAt: 1 } });
const MINUTE = 60000;
const HEURE = 60 * MINUTE;
const JOUR = 24 * HEURE;
// En-têtes qu'Horizon laisse passer (PLUGINS.md §6, niveau 1 compris).
const EN_TETES = /^(accept|accept-language|authorization|content-type|if-none-match|if-modified-since|anthropic-beta|anthropic-version|x-[a-z0-9-]+)$/;
// Propriétés qu'Horizon pose lui-même (PLUGINS.md §3).
const STANDARD = ["compact", "bar-height", "limit", "hovered", "instance"];

// Extrait d'une vraie réponse (10 novembre 2026), sans donnée personnelle.
const REAL = `{
  "five_hour": null,
  "seven_day": { "utilization": 20.0, "resets_at": "2026-11-16T15:59:59.705734+01:00",
                 "limit_dollars": null, "locked_reason": null },
  "limits": [
    { "kind": "weekly_all", "percent": 20, "resets_at": "2026-11-16T15:59:59+01:00",
      "scope": null, "is_active": true },
    { "kind": "weekly_scoped", "percent": 0, "resets_at": "2026-11-16T16:00:00+01:00",
      "scope": { "model": { "id": null, "display_name": "Fable" } }, "is_active": false },
    { "kind": "weekly_scoped", "percent": 42.5, "resets_at": "2026-11-16T16:00:00+01:00",
      "scope": { "model": { "id": null, "display_name": "Opus" } }, "is_active": true }
  ]
}`;

// Extrait d'une vraie réponse (12 novembre 2026) : niveaux, parts, répartition, crédits.
const RICH = `{
  "five_hour": null,
  "seven_day": { "utilization": 88.0, "resets_at": "2026-11-16T15:00:00.174954+00:00" },
  "extra_usage": { "is_enabled": false, "user_disabled": true },
  "limits": [
    { "kind": "weekly_all", "group": "weekly", "percent": 88, "severity": "warning",
      "resets_at": "2026-11-16T15:00:00.174954+00:00", "scope": null, "is_active": true },
    { "kind": "weekly_scoped", "group": "weekly", "percent": 65, "severity": "normal",
      "resets_at": "2026-11-16T15:00:00.175089+00:00",
      "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null }, "is_active": false }
  ],
  "seven_day_breakdown": {
    "as_of": "2026-11-12T00:17:08.184877+00:00",
    "window_started_at": "2026-11-09T15:00:00.174954+00:00",
    "rows": [
      { "key": "claude_code", "display_name": "Claude Code", "percent": 100 },
      { "key": "chat", "display_name": "Chats", "percent": 0 }
    ]
  },
  "weekly_scoped_shares": [
    { "limit_index": 1, "used_percent_of_weekly": 33, "allowance_percent_of_weekly": 50 }
  ]
}`;
// Heure de cette réponse (`as_of`).
const T_RICH = Date.UTC(2026, 10, 12, 0, 17, 8);

// Session de 5 h et semaine, remises à zéro à 13:05 et le 20 ; chargée à T0 (10:00 UTC).
const T0 = Date.UTC(2026, 10, 17, 10, 0, 0);
const SESSION = JSON.stringify({
  five_hour: { utilization: 63.4, resets_at: "2026-11-17T13:05:00Z" },
  seven_day: { utilization: 21, resets_at: "2026-11-20T10:00:00+00:00" },
});

const reponse = (status, text) => ({ status, text });
// Copie d'une valeur du contexte du script (autres prototypes) pour la comparer ici.
const net = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// Laisse finir les promesses du script (réponse de `http.get` comprise).
const vider = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

const mondes = [];

// Un faux Horizon et le script chargé dedans. `fichier` : contenu des identifiants (null ou
// undefined : absent) ; `reponse` : `{ status, text }`, `{ rejet }` (promesse rejetée) ou
// `{ leve }` (exception de `http.get`). Les deux se changent en cours de test, comme `horloge`.
function monde(options) {
  const m = Object.assign({ fichier: IDENTIFIANTS, reponse: reponse(200, RICH), horloge: T0 }, options, {
    poses: [],
    journal: [],
    requetes: [],
    lectures: [],
    minuteurs: [],
    rappels: {},
    evenements: {},
  });

  class Horloge extends Date {
    constructor(...args) {
      if (args.length === 0) super(m.horloge);
      else super(...args);
    }
    static now() {
      return m.horloge;
    }
  }

  const journal = (...args) => m.journal.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  const horizon = {
    ui: {
      set(prop, valeur, opts) {
        m.poses.push({ prop, valeur: net(valeur), instance: opts && opts.instance });
      },
      on(nom, f) {
        m.rappels[nom] = f;
      },
    },
    on(nom, f) {
      assert.ok(["unload", "instances"].concat(MANIFESTE.permissions.events).includes(nom), "événement non déclaré : " + nom);
      (m.evenements[nom] = m.evenements[nom] || []).push(f);
    },
    timer: {
      every(ms, f) {
        assert.ok(ms >= 250 && ms <= 24 * HEURE, "minuteur hors bornes : " + ms);
        m.minuteurs.push({ id: m.minuteurs.length + 1, ms, f, prochain: m.horloge + ms });
        return m.minuteurs.length;
      },
      clear(id) {
        m.minuteurs = m.minuteurs.map((t) => (t.id === id ? Object.assign(t, { prochain: Infinity }) : t));
      },
    },
    log: { info: journal, warn: journal, error: journal },
    files: {
      read(chemin) {
        if (!MANIFESTE.permissions.files.includes(chemin)) throw new TypeError("permission manquante : files " + chemin);
        m.lectures.push(chemin);
        return m.fichier;
      },
    },
    http: {
      get(url, opts) {
        if (!MANIFESTE.permissions.http.some((p) => url.startsWith(p))) throw new TypeError("permission manquante : http " + url);
        const headers = net((opts && opts.headers) || {});
        for (const k of Object.keys(headers)) {
          if (!EN_TETES.test(k.toLowerCase())) throw new TypeError("http : en-tête « " + k + " » refusé");
        }
        m.requetes.push({ url, headers });
        const r = m.reponse;
        if (r.leve) throw new RangeError(r.leve);
        return r.rejet !== undefined ? Promise.reject(r.rejet) : Promise.resolve({ status: r.status, text: r.text });
      },
    },
    instances: () => ["w1"],
  };

  const contexte = vm.createContext({ horizon, Date: Horloge });
  m.contexte = contexte;
  // Dernière valeur posée sur une propriété.
  m.pose = (prop) => {
    const p = m.poses.filter((x) => x.prop === prop).pop();
    return p && p.valeur;
  };
  // Comme Horizon : mode strict, puis la dernière valeur des événements d'état est rejouée.
  m.charger = () => {
    vm.runInContext('"use strict";' + SOURCE, contexte, { filename: "main.js" });
    m.evenement("presence", { away: false });
  };
  m.evenement = (nom, donnees) => (m.evenements[nom] || []).forEach((f) => f(donnees));
  m.rappel = (nom, ...args) => m.rappels[nom]("w1", ...args);
  // Avance l'horloge de `ms` en lançant les minuteurs arrivés à échéance.
  m.avancer = async (ms) => {
    const fin = m.horloge + ms;
    for (;;) {
      const t = m.minuteurs.filter((x) => x.prochain <= fin).sort((a, b) => a.prochain - b.prochain)[0];
      if (!t) break;
      m.horloge = t.prochain;
      t.prochain += t.ms;
      t.f();
      await vider();
    }
    m.horloge = fin;
  };
  mondes.push(m);
  return m;
}

// Un monde chargé, première lecture finie.
async function charge(options) {
  const m = monde(options);
  m.charger();
  await vider();
  return m;
}

// Fenêtre de quota comme les fait `lireUsage`.
const fenetre = (genre, pct, gravite, remise) => ({
  nom: genre,
  genre,
  pct,
  remise: remise === undefined ? null : remise,
  gravite: gravite === undefined ? null : gravite,
  part: null,
});

// Propriétés, rappels et structures déclarés par un fichier .slint (composant exporté).
function declarations(fichier) {
  const texte = fs.readFileSync(path.join(__dirname, fichier), "utf8").replace(/\/\/.*$/gm, "");
  const composant = texte.slice(texte.indexOf("export component"));
  const structures = {};
  for (const s of texte.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g)) {
    structures[s[1]] = Object.fromEntries([...s[2].matchAll(/([\w-]+)\s*:\s*(\w+)/g)].map((c) => [c[1], c[2]]));
  }
  return {
    proprietes: Object.fromEntries([...composant.matchAll(/\bin property <([^>]+)>\s*([\w-]+)/g)].map((p) => [p[2], p[1]])),
    rappels: [...composant.matchAll(/\bcallback\s+([\w-]+)/g)].map((c) => c[1]),
    structures,
  };
}

const TYPES = { string: "string", bool: "boolean", int: "number", float: "number", length: "number" };

const tests = [];
const test = (nom, f) => tests.push({ nom, f });

// --- quota.rs ---

test("jeton lu dans les identifiants", async () => {
  const { lireJeton } = (await charge()).contexte;
  assert.equal(lireJeton('{"claudeAiOauth":{"accessToken":"abc","expiresAt":1}}'), "abc");
  assert.throws(() => lireJeton('{"claudeAiOauth":{}}'), (e) => e.message === "jeton absent");
  assert.throws(() => lireJeton('{"claudeAiOauth":{"accessToken":""}}'), (e) => e.message === "jeton absent");
  assert.throws(() => lireJeton("pas du json"), (e) => e.message === "identifiants illisibles");
});

test("vraie réponse du 10 novembre (REAL)", async () => {
  const q = net((await charge()).contexte.lireUsage(REAL));
  // Fable compte même quand ce n'est pas la limite qui bloque (`is_active: false`).
  assert.deepEqual(
    q.fenetres.map((f) => [f.nom, f.genre, f.pct]),
    [
      ["Semaine", "seven_day", 20],
      ["Fable", "model", 0],
      ["Opus", "model", 42.5],
    ],
  );
  assert.equal(q.fenetres[0].remise, "2026-11-16T15:59:59.705734+01:00");
  assert.equal(q.debutSemaine, null);
  assert.deepEqual(q.repartition, []);
  assert.equal(q.credits, false);
});

test("vraie réponse du 12 novembre (RICH) : niveaux, parts, répartition, début de semaine", async () => {
  const q = net((await charge()).contexte.lireUsage(RICH));
  assert.equal(q.fenetres.length, 2);
  assert.equal(q.fenetres[0].gravite, "warning");
  const fable = q.fenetres[1];
  assert.deepEqual([fable.nom, fable.pct, fable.gravite], ["Fable", 65, "normal"]);
  assert.deepEqual(fable.part, { utilise: 33, alloue: 50 });
  assert.equal(q.debutSemaine, "2026-11-09T15:00:00.174954+00:00");
  assert.deepEqual(q.repartition, [
    { nom: "Claude Code", pct: 100 },
    { nom: "Chats", pct: 0 },
  ]);
  assert.equal(q.credits, false);
});

test("la fenêtre de 5 h vient en premier", async () => {
  const q = net(
    (await charge()).contexte.lireUsage(
      '{"five_hour":{"utilization":63.4,"resets_at":"2026-11-10T05:00:00Z"},"seven_day":{"utilization":21,"resets_at":null}}',
    ),
  );
  assert.equal(q.fenetres[0].nom, "5 h");
  assert.equal(q.fenetres[0].pct, 63.4);
  assert.equal(q.fenetres[1].remise, null);
});

test("champs manquants : erreur propre", async () => {
  const { lireUsage } = (await charge()).contexte;
  const erreur = (json) => {
    try {
      lireUsage(json);
    } catch (e) {
      return e.message;
    }
    return null;
  };
  assert.equal(erreur("{}"), "aucune fenêtre d’usage dans la réponse");
  assert.equal(erreur('{"five_hour":null,"seven_day":null}'), "aucune fenêtre d’usage dans la réponse");
  assert.equal(erreur("pas du json"), "réponse illisible");
  assert.equal(erreur('{"seven_day":{"resets_at":"x"}}'), "seven_day.utilization manquant");
  // Types inattendus : jamais d'exception autre que ces textes.
  assert.equal(erreur("[1, 2]"), "aucune fenêtre d’usage dans la réponse");
  assert.equal(erreur('{"seven_day":5}'), "seven_day.utilization manquant");
  assert.equal(erreur('{"seven_day":{"utilization":"12"}}'), "seven_day.utilization manquant");
  assert.equal(erreur('{"limits":"x","seven_day_breakdown":3,"weekly_scoped_shares":{}}'), "aucune fenêtre d’usage dans la réponse");
});

test("une limite de modèle sans nom ou sans pourcentage est écartée, une part incomplète aussi", async () => {
  const q = net(
    (await charge()).contexte.lireUsage(
      JSON.stringify({
        seven_day: { utilization: 10 },
        limits: [
          null,
          { kind: "weekly_scoped", percent: 5, scope: null },
          { kind: "weekly_scoped", scope: { model: { display_name: "Sans pourcentage" } } },
          { kind: "weekly_scoped", percent: 81, scope: { model: { display_name: "Opus" } } },
        ],
        weekly_scoped_shares: [{ limit_index: 3, used_percent_of_weekly: 12 }],
        seven_day_breakdown: { rows: [{ display_name: "Other", percent: 4 }, { percent: 3 }, "x"] },
        extra_usage: { is_enabled: true },
      }),
    ),
  );
  assert.deepEqual(
    q.fenetres.map((f) => [f.nom, f.pct, f.part, f.remise, f.gravite]),
    [
      ["Semaine", 10, null, null, null],
      ["Opus", 81, null, null, null],
    ],
  );
  assert.deepEqual(q.repartition, [{ nom: "Other", pct: 4 }]);
  assert.equal(q.credits, true);
});

// --- claude_quota/ui.rs ---

test("level : le niveau de l'API d'abord, sinon les seuils de 70 et 90 %", async () => {
  const { niveau } = (await charge()).contexte;
  assert.equal(niveau(fenetre("seven_day", 10, "critical")), 2);
  assert.equal(niveau(fenetre("seven_day", 10, "exceeded")), 2);
  assert.equal(niveau(fenetre("seven_day", 10, "warning")), 1);
  assert.equal(niveau(fenetre("seven_day", 95, "normal")), 2);
  assert.equal(niveau(fenetre("seven_day", 75)), 1);
  assert.equal(niveau(fenetre("seven_day", 30)), 0);
  assert.equal(niveau(fenetre("seven_day", 70)), 1);
  assert.equal(niveau(fenetre("seven_day", 90)), 2);
});

test("bar_windows : une limite de modèle seulement près de son plafond", async () => {
  const { fenetresBarre } = (await charge()).contexte;
  const f = [fenetre("five_hour", 10), fenetre("model", 79), fenetre("model", 85)];
  assert.deepEqual(net(fenetresBarre(f)).map((x) => x.pct), [10, 85]);
  assert.equal(fenetresBarre([fenetre("model", 80)]).length, 1);
});

test("dates ISO 8601", async () => {
  const { instant } = (await charge()).contexte;
  assert.equal(instant("2026-11-17T10:00:00Z"), T0);
  assert.equal(instant("2026-11-17T11:00:00+01:00"), T0);
  assert.equal(instant("2026-11-17T04:30:00-05:30"), T0);
  assert.equal(instant("2026-11-16T15:59:59.705734+01:00"), Date.UTC(2026, 10, 16, 14, 59, 59, 705));
  assert.equal(instant("2026-11-17T10:00:00.5Z"), T0 + 500);
  for (const faux of ["x", "", "2026-11-17T10:00:00", "2026-13-17T10:00:00Z", "2026-11-17", null, undefined, 12]) {
    assert.equal(instant(faux), null, String(faux));
  }
});

test("next_reset : la remise à zéro à venir la plus proche, parmi les limites montrées", async () => {
  const { prochaineRemise, instant } = (await charge()).contexte;
  const maintenant = instant("2026-11-17T10:00:00Z");
  const f = [
    fenetre("five_hour", 10, null, "2026-11-17T13:05:00Z"),
    fenetre("seven_day", 10, null, "2026-11-20T10:00:00+00:00"),
    // La limite du modèle, cachée, ne compte pas.
    fenetre("model", 10, null, "2026-11-17T10:30:00Z"),
  ];
  assert.equal(prochaineRemise(f, maintenant), "remise à zéro dans 3 h 05");
  assert.equal(prochaineRemise([], maintenant), "");
  // Une remise à zéro passée ne compte plus.
  assert.equal(prochaineRemise(f, instant("2026-11-17T13:05:00Z")), "remise à zéro dans 2 j 20 h");
  assert.equal(prochaineRemise(f, instant("2026-11-21T00:00:00Z")), "");
});

// --- claude_quota/panel.rs ---

test("pace : part du temps écoulée et instant du plafond", async () => {
  const { rythme, instant } = (await charge()).contexte;
  const remise = "2026-11-17T15:00:00Z";
  const r = instant(remise);
  const f = (genre, pct) => fenetre(genre, pct, null, remise);
  // Session de 5 h : commencée à 10:00 ; à 12:30, moitié du temps.
  const maintenant = r - 2 * HEURE - HEURE / 2;
  let p = net(rythme(f("five_hour", 25), null, maintenant));
  assert.ok(Math.abs(p.ecoulePct - 50) < 1e-9);
  assert.equal(p.plafond, null, "25 % pour 50 % du temps : tient");
  p = net(rythme(f("five_hour", 100), null, maintenant));
  assert.equal(p.plafond, maintenant);
  // 80 % en 2 h 30 : plafond 3 h 07 30 après le début.
  p = net(rythme(f("five_hour", 80), null, maintenant));
  assert.equal(p.plafond, r - 5 * HEURE + 3 * HEURE + 7 * MINUTE + 30000);
  // Rien de consommé : tient.
  assert.equal(net(rythme(f("five_hour", 0), null, maintenant)).plafond, null);
  // Hors de la fenêtre, ou sans date : rien.
  assert.equal(rythme(f("five_hour", 10), null, r + 1), null);
  assert.equal(rythme(f("five_hour", 10), null, r - 5 * HEURE), null);
  assert.equal(rythme(fenetre("five_hour", 10), null, maintenant), null);
  assert.equal(rythme(fenetre("five_hour", 10, null, "x"), null, maintenant), null);
  // Semaine : début donné.
  p = net(rythme(f("seven_day", 10), "2026-11-10T15:00:00Z", r - (JOUR * 7) / 2));
  assert.ok(Math.abs(p.ecoulePct - 50) < 1e-9);
  // Semaine sans début donné, et limite d'un modèle : sept jours avant la remise à zéro.
  p = net(rythme(f("seven_day", 10), null, r - JOUR));
  assert.ok(Math.abs(p.ecoulePct - (6 / 7) * 100) < 1e-9);
  p = net(rythme(f("model", 10), "illisible", r - JOUR));
  assert.ok(Math.abs(p.ecoulePct - (6 / 7) * 100) < 1e-9);
});

test("ligne du rythme", async () => {
  const { ligneRythme, instant, quand } = (await charge()).contexte;
  const remise = "2026-11-17T15:00:00Z";
  const r = instant(remise);
  const maintenant = r - 2 * HEURE - HEURE / 2;
  const f = (pct) => fenetre("five_hour", pct, null, remise);
  assert.equal(ligneRythme(f(25), null, maintenant), "25 % utilisés pour 50 % du temps écoulé · tient jusqu’à la remise à zéro");
  assert.equal(ligneRythme(f(100), null, maintenant), "100 % utilisés pour 50 % du temps écoulé · plafond atteint");
  const plafond = r - 5 * HEURE + 3 * HEURE + 7 * MINUTE + 30000;
  assert.equal(ligneRythme(f(80), null, maintenant), "80 % utilisés pour 50 % du temps écoulé · plafond vers " + quand(plafond, maintenant));
  assert.equal(ligneRythme(f(80), null, r + 1), "");
});

test("when : aujourd’hui, demain, puis le jour et la date (heure locale)", async () => {
  const { quand } = (await charge()).contexte;
  const le = (jour, heure, minute) => new Date(2026, 10, jour, heure, minute || 0).getTime();
  const maintenant = le(17, 9);
  assert.equal(quand(le(17, 16), maintenant), "aujourd’hui à 16:00");
  assert.equal(quand(le(18, 3), maintenant), "demain à 03:00");
  assert.equal(quand(le(20, 10), maintenant), "ven. 20 nov. à 10:00");
  assert.equal(quand(le(17, 23, 59), le(17, 0)), "aujourd’hui à 23:59");
  assert.equal(quand(le(18, 0, 5), le(17, 23, 55)), "demain à 00:05");
  assert.equal(quand(le(19, 0), le(17, 23, 55)), "jeu. 19 nov. à 00:00");
  assert.equal(quand(le(16, 8, 7), maintenant), "lun. 16 nov. à 08:07");
  assert.equal(quand(new Date(2027, 0, 3, 12).getTime(), maintenant), "dim. 3 janv. à 12:00");
  assert.equal(quand(new Date(2027, 1, 1, 12).getTime(), new Date(2027, 0, 31, 12).getTime()), "demain à 12:00");
});

test("titres des limites", async () => {
  const { titre } = (await charge()).contexte;
  assert.equal(titre(fenetre("seven_day", 0)), "Semaine · tous modèles");
  assert.equal(titre(fenetre("five_hour", 0)), "Session de 5 h");
  assert.equal(titre(Object.assign(fenetre("model", 0), { nom: "x" })), "x");
});

// --- ui/time.rs ---

test("ago : temps écoulé", async () => {
  const { ilYA } = (await charge()).contexte;
  const maintenant = 10000000000;
  assert.equal(ilYA(maintenant - 30000, maintenant), "à l’instant");
  assert.equal(ilYA(maintenant - 5 * 60000, maintenant), "il y a 5 min");
  assert.equal(ilYA(maintenant - 3 * 3600000 - 5, maintenant), "il y a 3 h");
  assert.equal(ilYA(maintenant - 2 * 86400000, maintenant), "il y a 2 j");
  assert.equal(ilYA(maintenant + 5000, maintenant), "à l’instant", "instant à venir");
});

test("until : temps restant", async () => {
  const { dans } = (await charge()).contexte;
  const maintenant = 10000000000;
  assert.equal(dans(maintenant + 10000, maintenant), "dans 1 min");
  assert.equal(dans(maintenant + 45 * 60000, maintenant), "dans 45 min");
  assert.equal(dans(maintenant + (3 * 3600 + 5 * 60) * 1000, maintenant), "dans 3 h 05");
  assert.equal(dans(maintenant + (4 * 86400 + 15 * 3600) * 1000, maintenant), "dans 4 j 15 h");
  assert.equal(dans(maintenant - 5000, maintenant), "dans 1 min", "instant passé");
  assert.equal(dans(maintenant + 3600000, maintenant), "dans 1 h 00");
});

// --- Service (claude_quota/mod.rs) et affichage ---

test("au chargement : rien n'est montré, puis le quota de la première lecture", async () => {
  const m = monde({ horloge: T_RICH });
  m.charger();
  // Avant la réponse : le widget ne prend pas de place.
  assert.equal(m.pose("connu"), false);
  assert.equal(m.pose("a-quota"), false);
  assert.equal(m.pose("erreur"), "");
  assert.deepEqual(m.lectures, [FICHIER]);
  assert.deepEqual(m.requetes, [{ url: ADRESSE, headers: { Authorization: "Bearer " + JETON, "anthropic-beta": "oauth-2025-04-20" } }]);
  await vider();

  assert.equal(m.pose("connu"), true);
  assert.equal(m.pose("illisible"), false);
  assert.equal(m.pose("perime"), false);
  // Fable (65 %) reste hors de la barre ; la semaine est en « attention » d'après l'API.
  assert.deepEqual(m.pose("jauges"), [{ nom: "Semaine", valeur: 0.88, texte: "88 %", niveau: 1 }]);
  assert.equal(m.pose("remise"), "remise à zéro dans 4 j 14 h");

  const { quand, instant } = m.contexte;
  const fin = instant("2026-11-16T15:00:00.174954+00:00");
  const debut = instant("2026-11-09T15:00:00.174954+00:00");
  const plafond = (pct) => Math.floor(debut + ((T_RICH - debut) * 100) / pct);
  assert.equal(m.pose("maj"), "mis à jour à l’instant");
  assert.equal(m.pose("erreur"), "");
  assert.equal(m.pose("a-quota"), true);
  assert.deepEqual(m.pose("limites"), [
    {
      titre: "Semaine · tous modèles",
      modele: false,
      pct: "88 %",
      utilise: 0.88,
      niveau: 1,
      remise: "Remise à zéro " + quand(fin, T_RICH) + " · dans 4 j 14 h",
      part: "",
      rythme: "88 % utilisés pour 34 % du temps écoulé · plafond vers " + quand(plafond(88), T_RICH),
    },
    {
      titre: "Fable",
      modele: true,
      pct: "65 %",
      utilise: 0.65,
      niveau: 0,
      remise: "Remise à zéro " + quand(fin, T_RICH) + " · dans 4 j 14 h",
      part: "33 % de la semaine générale consommés sur 50 % alloués",
      rythme: "65 % utilisés pour 34 % du temps écoulé · plafond vers " + quand(plafond(65), T_RICH),
    },
  ]);
  assert.equal(m.pose("a-repartition"), true);
  assert.deepEqual(m.pose("repartition"), [
    { nom: "Claude Code", pct: "100 %", valeur: 1, nulle: false },
    { nom: "Chats", pct: "0 %", valeur: 0, nulle: true },
  ]);
  assert.equal(m.pose("credits"), "Crédits supplémentaires désactivés");
  assert.deepEqual(m.journal, []);
});

test("REAL dans la barre et le panneau : limites de modèle cachées dans la barre, pas de répartition", async () => {
  const m = await charge({ reponse: reponse(200, REAL), horloge: Date.UTC(2026, 10, 10, 12, 0, 0) });
  assert.deepEqual(m.pose("jauges"), [{ nom: "Semaine", valeur: 0.2, texte: "20 %", niveau: 0 }]);
  assert.equal(m.pose("remise"), "remise à zéro dans 6 j 2 h");
  assert.deepEqual(
    m.pose("limites").map((l) => [l.titre, l.modele, l.pct, l.niveau]),
    [
      ["Semaine · tous modèles", false, "20 %", 0],
      ["Fable", true, "0 %", 0],
      ["Opus", true, "43 %", 0],
    ],
  );
  // Sans début de semaine : sept jours avant la remise à zéro. Fable n'a rien consommé.
  assert.ok(m.pose("limites")[1].rythme.endsWith(" · tient jusqu’à la remise à zéro"), m.pose("limites")[1].rythme);
  assert.equal(m.pose("a-repartition"), false);
  assert.deepEqual(m.pose("repartition"), []);
});

test("crédits activés, « Other » traduit, modèle montré dans la barre à partir de 80 %", async () => {
  const m = await charge({
    reponse: reponse(
      200,
      JSON.stringify({
        seven_day: { utilization: 95 },
        limits: [{ kind: "weekly_scoped", percent: 80, severity: "critical", scope: { model: { display_name: "Opus" } } }],
        seven_day_breakdown: { rows: [{ display_name: "Other", percent: 12.5 }] },
        extra_usage: { is_enabled: true },
      }),
    ),
  });
  assert.deepEqual(m.pose("jauges"), [
    { nom: "Semaine", valeur: 0.95, texte: "95 %", niveau: 2 },
    { nom: "Opus", valeur: 0.8, texte: "80 %", niveau: 2 },
  ]);
  assert.equal(m.pose("remise"), "");
  assert.deepEqual(m.pose("limites").map((l) => [l.remise, l.part, l.rythme]), [
    ["", "", ""],
    ["", "", ""],
  ]);
  assert.deepEqual(m.pose("repartition"), [{ nom: "Autre", pct: "13 %", valeur: 0.125, nulle: false }]);
  assert.equal(m.pose("credits"), "Crédits supplémentaires activés : l’usage continue au-delà des limites");
});

test("jeton absent ou illisible, erreurs 401 et autres : l'erreur est montrée, sans quota", async () => {
  const cas = [
    [{ fichier: null }, "Claude Code n’est pas connecté", 0],
    [{ fichier: undefined }, "Claude Code n’est pas connecté", 0],
    [{ fichier: "pas du json" }, "identifiants illisibles", 0],
    [{ fichier: '{"claudeAiOauth":{}}' }, "jeton absent", 0],
    [{ fichier: '{"claudeAiOauth":{"accessToken":""}}' }, "jeton absent", 0],
    [{ fichier: "[]" }, "jeton absent", 0],
    [{ reponse: reponse(401, '{"error":"unauthorized"}') }, "jeton expiré : relance Claude Code", 1],
    [{ reponse: reponse(500, "") }, "réponse 500 de l’API", 1],
    [{ reponse: reponse(429, RICH) }, "réponse 429 de l’API", 1],
    [{ reponse: reponse(302, "") }, "réponse 302 de l’API", 1],
    [{ reponse: { rejet: "serveur injoignable" } }, "API injoignable", 1],
    [{ reponse: { rejet: "réponse illisible ou trop grosse" } }, "réponse illisible", 1],
    [{ reponse: reponse(200, "pas du json") }, "réponse illisible", 1],
    [{ reponse: reponse(200, "{}") }, "aucune fenêtre d’usage dans la réponse", 1],
    [{ reponse: reponse(200, '{"seven_day":{"resets_at":"x"}}') }, "seven_day.utilization manquant", 1],
    [{ reponse: { leve: "http : trop de requêtes en cours" } }, "http : trop de requêtes en cours", 1],
  ];
  for (const [options, erreur, requetes] of cas) {
    const m = await charge(options);
    assert.equal(m.pose("erreur"), erreur);
    assert.equal(m.requetes.length, requetes, erreur);
    // « — » et l'avertissement dans la barre, l'erreur seule dans le panneau.
    assert.equal(m.pose("connu"), true, erreur);
    assert.equal(m.pose("illisible"), true, erreur);
    assert.equal(m.pose("perime"), false, erreur);
    assert.equal(m.pose("a-quota"), false, erreur);
    assert.deepEqual(m.pose("jauges"), [], erreur);
    assert.deepEqual(m.pose("limites"), [], erreur);
    assert.equal(m.pose("maj"), "", erreur);
    assert.equal(m.pose("credits"), "", erreur);
    assert.deepEqual(m.journal, ["lecture du quota impossible : " + erreur]);
    // Sans quota, rien ne dépend de l'heure : seule la lecture régulière tourne.
    assert.deepEqual(m.minuteurs.map((t) => t.ms), [5 * MINUTE]);
  }
});

test("une lecture toutes les 5 minutes ; en cas d'erreur le dernier quota est gardé, estompé", async () => {
  const m = await charge({ reponse: reponse(200, SESSION) });
  const jauges = [
    { nom: "5 h", valeur: 0.634, texte: "63 %", niveau: 0 },
    { nom: "Semaine", valeur: 0.21, texte: "21 %", niveau: 0 },
  ];
  assert.deepEqual(m.pose("jauges"), jauges);
  assert.equal(m.requetes.length, 1);

  m.reponse = reponse(500, "");
  await m.avancer(5 * MINUTE - 1);
  assert.equal(m.requetes.length, 1);
  await m.avancer(1);
  assert.equal(m.requetes.length, 2);
  assert.equal(m.pose("connu"), true);
  assert.equal(m.pose("illisible"), false);
  assert.equal(m.pose("perime"), true);
  assert.deepEqual(m.pose("jauges"), jauges);
  assert.equal(m.pose("erreur"), "réponse 500 de l’API");
  assert.equal(m.pose("a-quota"), true);
  assert.equal(m.pose("limites").length, 2);
  // L'heure de la dernière réponse exploitable, pas celle de l'échec.
  assert.equal(m.pose("maj"), "mis à jour il y a 5 min");
  assert.equal(m.pose("remise"), "remise à zéro dans 3 h 00");

  // L'erreur change : montrée, le quota toujours gardé.
  m.fichier = null;
  await m.avancer(5 * MINUTE);
  assert.equal(m.requetes.length, 2);
  assert.equal(m.pose("erreur"), "Claude Code n’est pas connecté");
  assert.equal(m.pose("perime"), true);
  assert.deepEqual(m.pose("jauges"), jauges);

  // Une lecture réussie efface l'erreur.
  m.fichier = IDENTIFIANTS;
  m.reponse = reponse(200, RICH);
  await m.avancer(5 * MINUTE);
  assert.equal(m.requetes.length, 3);
  assert.equal(m.pose("erreur"), "");
  assert.equal(m.pose("perime"), false);
  assert.equal(m.pose("maj"), "mis à jour à l’instant");
  assert.deepEqual(m.pose("jauges").map((j) => j.nom), ["Semaine"]);
});

test("le jeton est relu à chaque lecture", async () => {
  const m = await charge();
  m.fichier = JSON.stringify({ claudeAiOauth: { accessToken: JETON + "-renouvelé" } });
  await m.avancer(5 * MINUTE);
  assert.deepEqual(m.lectures, [FICHIER, FICHIER]);
  assert.equal(m.requetes[1].headers.Authorization, "Bearer " + JETON + "-renouvelé");
});

test("la barre avance chaque minute tant qu'un quota existe", async () => {
  const m = await charge({ reponse: reponse(200, SESSION) });
  assert.equal(m.pose("remise"), "remise à zéro dans 3 h 05");
  assert.deepEqual(m.minuteurs.map((t) => t.ms).sort((a, b) => a - b), [MINUTE, 5 * MINUTE]);
  await m.avancer(MINUTE);
  assert.equal(m.pose("remise"), "remise à zéro dans 3 h 04");
  assert.equal(m.pose("maj"), "mis à jour il y a 1 min");
  // Un seul minuteur de barre, même après d'autres lectures.
  await m.avancer(10 * MINUTE);
  assert.equal(m.minuteurs.length, 2);
  assert.equal(m.requetes.length, 3);
});

test("retour d'absence : une lecture si la dernière a plus d'une minute", async () => {
  const m = await charge();
  assert.equal(m.requetes.length, 1, "l'état rejoué au chargement ne relance rien");
  m.evenement("presence", { away: true });
  await m.avancer(30000);
  m.evenement("presence", { away: false });
  await vider();
  assert.equal(m.requetes.length, 1, "dernière lecture trop récente");

  m.evenement("presence", { away: true });
  await m.avancer(2 * MINUTE);
  assert.equal(m.requetes.length, 1, "rien pendant l'absence hors du rythme régulier");
  m.evenement("presence", { away: false });
  await vider();
  assert.equal(m.requetes.length, 2);
  // Présent deux fois de suite : pas un retour.
  await m.avancer(90000);
  m.evenement("presence", { away: false });
  await vider();
  assert.equal(m.requetes.length, 2);
});

test("panneau : une lecture par minute au plus, à l'ouverture seulement", async () => {
  const m = await charge({ reponse: reponse(200, SESSION) });
  assert.equal(m.requetes.length, 1);
  m.horloge += 10000;
  m.rappel("tic", true);
  await vider();
  assert.equal(m.requetes.length, 1, "ouverture rapprochée");
  m.horloge += 50000;
  m.rappel("tic", true);
  await vider();
  assert.equal(m.requetes.length, 2, "une minute après");
  m.rappel("tic", true);
  m.rappel("tic", true);
  await vider();
  assert.equal(m.requetes.length, 2, "deux ouvertures de suite");
  // Panneau resté ouvert : les tics suivants ne redemandent rien.
  m.horloge += 3 * MINUTE;
  m.rappel("tic", false);
  await vider();
  assert.equal(m.requetes.length, 2);
  // Une lecture en échec compte aussi.
  m.reponse = { rejet: "serveur injoignable" };
  m.horloge += MINUTE;
  m.rappel("tic", true);
  await vider();
  assert.equal(m.requetes.length, 3);
  m.horloge += 59000;
  m.rappel("tic", true);
  await vider();
  assert.equal(m.requetes.length, 3);
});

test("panneau : les textes relatifs avancent à chaque tic", async () => {
  const m = await charge({ reponse: reponse(200, SESSION) });
  const { quand, instant } = m.contexte;
  const fin = instant("2026-11-17T13:05:00Z");
  assert.equal(m.pose("limites")[0].titre, "Session de 5 h");
  assert.equal(m.pose("limites")[0].remise, "Remise à zéro " + quand(fin, T0) + " · dans 3 h 05");
  m.horloge += 30000;
  m.rappel("tic", false);
  assert.equal(m.pose("limites")[0].remise, "Remise à zéro " + quand(fin, T0) + " · dans 3 h 04");
  assert.equal(m.pose("maj"), "mis à jour à l’instant");
  m.horloge += 30000;
  m.rappel("tic", true);
  assert.equal(m.pose("maj"), "mis à jour il y a 1 min", "l'ouverture rafraîchit aussi les textes");
});

test("le jeton n'apparaît ni dans l'interface ni dans le journal", async () => {
  // Une API qui renverrait le jeton dans ses réponses, des identifiants abîmés qui le contiennent.
  const echo = JSON.stringify({ error: { message: "invalid bearer token " + JETON }, token: JETON });
  const m = await charge();
  for (const r of [reponse(401, echo), reponse(403, echo), reponse(200, echo), reponse(200, "{" + JETON), { rejet: "serveur injoignable" }]) {
    m.reponse = r;
    await m.avancer(5 * MINUTE);
  }
  m.fichier = IDENTIFIANTS.slice(0, -2);
  await m.avancer(5 * MINUTE);
  m.fichier = JSON.stringify({ claudeAiOauth: { accessToken: 12, refreshToken: JETON } });
  await m.avancer(5 * MINUTE);
  assert.equal(m.requetes.length, 6);
  assert.equal(m.journal.length, 7);
  // Rien n'est gardé non plus dans les variables du script.
  const etat = vm.runInContext("JSON.stringify([quota, erreur, recuLe, essayeLe, absent, minuteurBarre])", m.contexte);
  assert.ok(!etat.includes(JETON), etat);
});

test("le jeton ne part qu'à l'adresse de l'API, dans Authorization", async () => {
  const m = await charge();
  await m.avancer(11 * MINUTE);
  m.rappel("tic", true);
  await vider();
  assert.equal(m.requetes.length, 4);
  for (const r of m.requetes) {
    assert.equal(r.url, ADRESSE);
    assert.deepEqual(Object.keys(r.headers).sort(), ["Authorization", "anthropic-beta"]);
  }
});

// --- Contrat (PLUGINS.md §12) ---

test("chaque valeur posée vise une propriété déclarée, du bon type ; chaque rappel est déclaré", async () => {
  const fichiers = [declarations("widget.slint"), declarations("panel.slint")];
  const type = (prop) => fichiers.map((d) => d.proprietes[prop]).find((t) => t !== undefined);
  const structure = (nom) => fichiers.map((d) => d.structures[nom]).find((s) => s !== undefined);
  // Tous les états : rien, quota, quota périmé, erreur seule.
  const m = await charge();
  m.reponse = reponse(500, "");
  await m.avancer(5 * MINUTE);
  const autre = await charge({ fichier: null });
  const poses = m.poses.concat(autre.poses);

  for (const { prop, valeur, instance } of poses) {
    const t = type(prop);
    assert.ok(t, "propriété non déclarée : " + prop);
    assert.equal(instance, undefined);
    const champs = t.startsWith("[") ? structure(t.slice(1, -1)) : null;
    if (!champs) {
      assert.equal(typeof valeur, TYPES[t], prop + " : " + JSON.stringify(valeur));
      continue;
    }
    assert.ok(Array.isArray(valeur), prop);
    for (const element of valeur) {
      assert.deepEqual(Object.keys(element).sort(), Object.keys(champs).sort(), prop);
      for (const [champ, v] of Object.entries(element)) {
        assert.equal(typeof v, TYPES[champs[champ]], prop + "." + champ);
        // Dans un tableau, Horizon lirait une telle chaîne comme une couleur.
        assert.ok(typeof v !== "string" || !/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(v), prop + "." + champ);
      }
    }
  }
  const posees = new Set(poses.map((p) => p.prop));
  for (const d of fichiers) {
    for (const prop of Object.keys(d.proprietes)) {
      assert.ok(posees.has(prop) || STANDARD.includes(prop), "propriété jamais posée : " + prop);
    }
  }
  const rappels = fichiers.flatMap((d) => d.rappels);
  assert.deepEqual(Object.keys(m.rappels).sort(), rappels.sort());
});

test("le manifeste déclare le strict nécessaire, et tout ce qui est déclaré sert", async () => {
  assert.equal(MANIFESTE.id, path.basename(__dirname));
  assert.equal(MANIFESTE.api, 1);
  assert.deepEqual(MANIFESTE.permissions, { files: [FICHIER], http: [ADRESSE], events: ["presence"] });
  const m = await charge();
  assert.deepEqual(m.lectures, [FICHIER]);
  assert.equal(m.requetes[0].url, ADRESSE);
  assert.deepEqual(Object.keys(m.evenements), ["presence"]);
});

(async () => {
  let echecs = 0;
  for (const { nom, f } of tests) {
    const debut = mondes.length;
    try {
      await f();
      // Dans tous les tests : le jeton ne sort jamais du script, sauf dans l'en-tête de la requête.
      for (const m of mondes.slice(debut)) {
        const sorti = JSON.stringify(m.poses) + "\n" + m.journal.join("\n");
        assert.ok(!sorti.includes(JETON) && !sorti.includes("Bearer"), "jeton dans l'interface ou le journal");
      }
      console.log("ok      " + nom);
    } catch (e) {
      echecs++;
      console.log("ÉCHEC   " + nom + "\n" + (e && e.stack ? e.stack : e));
    }
  }
  console.log(echecs ? echecs + " test(s) en échec sur " + tests.length : tests.length + " tests réussis");
  process.exitCode = echecs ? 1 : 0;
})();
