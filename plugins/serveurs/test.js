// Essais du plugin Serveurs : `node test.js` (Node seul, aucune dépendance).
//
// main.js est chargé dans un contexte `vm` où il ne voit, comme dans Horizon, que l'objet
// `horizon` (et une horloge que l'essai pilote). Le faux `horizon` note ce que le script pose
// (ui.set, alertes, palette, liens, terminaux) et applique les règles d'Horizon qui comptent
// ici : réglages nettoyés d'après plugin.json, cibles refusées, 16 sondes à la fois, une alerte
// toutes les 5 s, propriétés et rappels déclarés dans les .slint.
//
// Les premiers essais reprennent ceux du widget d'origine
// (crates/horizon-core/src/homelab/tests.rs, natif/src/ui/time.rs).
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const lire = (nom) => fs.readFileSync(path.join(__dirname, nom), "utf8");
const SOURCE = lire("main.js");
const MANIFESTE = JSON.parse(lire("plugin.json"));
const CHAMPS = MANIFESTE.settings.find((s) => s.key === "hosts").fields;
const FICHIER_SSH = MANIFESTE.permissions.files[0];

// Propriétés (`in property`) et rappels (`callback`) du composant exporté d'un .slint.
function declare(nom) {
  const texte = lire(nom).split(/^export component /m)[1];
  const noms = (motif) => Array.from(texte.matchAll(motif), (m) => m[1]);
  return { proprietes: noms(/^\s*in property <[^>]+>\s*([\w-]+)/gm), rappels: noms(/^\s*callback\s+([\w-]+)/gm) };
}
const WIDGET = declare("widget.slint");
const PANNEAU = declare("panel.slint");
const PROPRIETES = new Set(WIDGET.proprietes.concat(PANNEAU.proprietes));
const RAPPELS = new Set(WIDGET.rappels.concat(PANNEAU.rappels));

// Copie par JSON : ce qu'Horizon garde d'une valeur, et de quoi comparer des objets nés dans
// le contexte du script.
const j = (v) => JSON.parse(JSON.stringify(v));

// Réglage `hosts` nettoyé comme le fait Horizon : chaque champ déclaré, à sa valeur si elle
// convient à son type, sinon à son défaut ; ce qui n'est pas un objet est écarté.
function nettoyer(valeur) {
  if (!Array.isArray(valeur)) return [];
  const defaut = (c) => {
    if ("default" in c) return c.default;
    if (c.type === "bool") return false;
    if (c.type === "number") return c.min === undefined ? 0 : c.min;
    if (c.type === "choice") return typeof c.options[0] === "string" ? c.options[0] : c.options[0].value;
    return "";
  };
  const convient = (c, v) => {
    if (c.type === "bool") return typeof v === "boolean";
    if (c.type === "number") return typeof v === "number" && (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
    if (c.type === "choice") return c.options.some((o) => (typeof o === "string" ? o : o.value) === v);
    return typeof v === "string";
  };
  return valeur
    .filter((e) => e && typeof e === "object" && !Array.isArray(e))
    .slice(0, 64)
    .map((e) => Object.fromEntries(CHAMPS.map((c) => [c.key, convient(c, e[c.key]) ? e[c.key] : defaut(c)])));
}

// Cible de horizon.net.probe acceptée par Horizon : « hôte:port » ou adresse http(s) sans
// nom d'utilisateur.
function cibleValide(s) {
  if (/^https?:\/\//.test(s)) {
    try {
      const u = new URL(s);
      return u.hostname !== "" && u.username === "" && u.password === "";
    } catch (e) {
      return false;
    }
  }
  const i = s.lastIndexOf(":");
  if (i < 0) return false;
  const port = s.slice(i + 1);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return false;
  const hote = s.slice(0, i).replace(/^\[(.*)\]$/, "$1");
  return hote.length >= 1 && hote.length <= 253 && /^[A-Za-z0-9._:-]+$/.test(hote);
}

const vider = () => new Promise((fait) => setImmediate(fait));

// Un faux Horizon et le script chargé dedans. `exemplaires` : identifiant → réglage `hosts`
// (tel qu'enregistré, avant nettoyage) ; `ssh` : contenu de ~/.ssh/config (null : absent) ;
// `absent` : état de présence rejoué au chargement.
async function monde({ ssh = null, exemplaires = { w1: [] }, absent } = {}) {
  let t = 1_700_000_000_000;
  let suivant = 0;
  let alerteLe = -Infinity;
  const reglages = new Map(Object.entries(exemplaires).map(([inst, hosts]) => [inst, nettoyer(hosts)]));
  const minuteurs = [];
  const enAttente = [];
  const ecoutes = { ui: new Map(), evenements: new Map(), reglages: [], palette: [], fichier: null };
  const m = {
    auto: true, // les sondes répondent dès qu'elles partent
    pannes: new Set(), // cibles qui ne répondent pas
    latences: new Map(), // cible → ms (4 par défaut)
    sondes: [], // cibles sondées, dans l'ordre
    enVolMax: 0,
    poses: [], // { inst, prop, valeur }
    alertes: [],
    alertesIgnorees: 0,
    palette: [],
    liens: [],
    terminaux: [],
    reglagesOuverts: [],
    journal: [],
    get t() {
      return t;
    },
    get enAttente() {
      return enAttente.length;
    },
    get minuteurs() {
      return minuteurs.length;
    },
  };

  const horizon = {
    instances: () => Array.from(reglages.keys()),
    on(nom, fn) {
      assert.ok(["instances", "unload"].concat(MANIFESTE.permissions.events).includes(nom), `événement « ${nom} » non déclaré`);
      ecoutes.evenements.set(nom, (ecoutes.evenements.get(nom) || []).concat(fn));
    },
    ui: {
      set(prop, valeur, options) {
        assert.ok(PROPRIETES.has(prop), `ui.set("${prop}") : propriété absente des .slint`);
        assert.notEqual(valeur, undefined, `ui.set("${prop}") : valeur indéfinie`);
        m.poses.push({ inst: options && options.instance, prop, valeur: j(valeur) });
      },
      on(nom, fn) {
        assert.ok(RAPPELS.has(nom), `ui.on("${nom}") : rappel absent des .slint`);
        ecoutes.ui.set(nom, fn);
      },
    },
    settings: {
      get(cle, inst) {
        const hosts = reglages.get(inst === undefined ? horizon.instances()[0] : inst);
        return cle === "hosts" && hosts ? j(hosts) : undefined;
      },
      onChange: (fn) => ecoutes.reglages.push(fn),
      open: (inst) => m.reglagesOuverts.push(inst),
    },
    timer: {
      every(ms, fn) {
        assert.ok(ms >= 250 && ms <= 86_400_000, `minuteur de ${ms} ms`);
        assert.ok(minuteurs.length < 32, "trop de minuteurs");
        minuteurs.push({ id: ++suivant, ms, prochain: t + ms, fn });
        return suivant;
      },
      clear(id) {
        const i = minuteurs.findIndex((x) => x.id === id);
        if (i >= 0) minuteurs.splice(i, 1);
      },
    },
    log: Object.fromEntries(["info", "warn", "error"].map((niveau) => [niveau, (...args) => m.journal.push({ niveau, texte: args.join(" ") })])),
    alert(spec) {
      // Comme Horizon : une alerte toutes les 5 s, les autres sont perdues.
      if (t - alerteLe < 5000) m.alertesIgnorees++;
      else {
        alerteLe = t;
        m.alertes.push(Object.assign({ a: t }, j(spec)));
      }
    },
    palette: {
      set(entrees) {
        assert.ok(Array.isArray(entrees) && entrees.length <= 50, "palette : 50 entrées au plus");
        m.palette = j(entrees);
      },
      on: (fn) => ecoutes.palette.push(fn),
    },
    open(url) {
      let u = null;
      try {
        u = new URL(url);
      } catch (e) {
        u = null;
      }
      if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password) throw new TypeError(`permission manquante : http ${url} (pour open), ou system open`);
      m.liens.push(url);
    },
    ssh: {
      open(cible) {
        if (!/^(?!-)[A-Za-z0-9._@:[\]-]+$/.test(cible)) throw new TypeError("ssh.open : cible refusée (alias, hôte ou utilisateur@hôte)");
        m.terminaux.push(cible);
      },
    },
    net: {
      probe(cible) {
        if (!cibleValide(cible)) throw new TypeError(`net.probe : cible « ${cible} » refusée (hôte:port ou adresse http(s)://)`);
        if (enAttente.length >= 16) throw new RangeError("net.probe : trop de requêtes en cours");
        m.sondes.push(cible);
        return new Promise((resoudre) => {
          enAttente.push({ cible, resoudre });
          m.enVolMax = Math.max(m.enVolMax, enAttente.length);
        });
      },
    },
    files: {
      watch(chemin, fn) {
        assert.equal(chemin, FICHIER_SSH, "fichier non déclaré");
        ecoutes.fichier = fn;
      },
    },
  };

  // Les sondes en attente répondent (les `combien` plus anciennes, puis celles que leurs
  // réponses ont fait partir si `tout`).
  m.repondre = async (tout = true, combien = Infinity) => {
    do {
      for (const s of enAttente.splice(0, combien)) {
        s.resoudre(m.pannes.has(s.cible) ? { ok: false, ms: null, error: "délai dépassé" } : { ok: true, ms: m.latences.get(s.cible) ?? 4, error: null });
      }
      await vider();
    } while (tout && enAttente.length);
  };
  // Le temps passe : les minuteurs arrivés à échéance sonnent, dans l'ordre.
  m.avancer = async (ms) => {
    const fin = t + ms;
    for (;;) {
      const du = minuteurs.filter((x) => x.prochain <= fin).sort((a, b) => a.prochain - b.prochain)[0];
      if (!du) break;
      t = Math.max(t, du.prochain);
      du.prochain = t + du.ms;
      du.fn();
      await vider();
      if (m.auto) await m.repondre();
    }
    t = fin;
  };
  m.emettre = async (nom, donnees) => {
    for (const fn of ecoutes.evenements.get(nom) || []) fn(donnees);
    await vider();
  };
  m.rappel = async (nom, inst, ...args) => {
    assert.ok(ecoutes.ui.has(nom), `rappel « ${nom} » non écouté`);
    ecoutes.ui.get(nom)(inst, ...args);
    await vider();
  };
  // Réglages d'un exemplaire changés (ou exemplaire ajouté), comme Horizon les annonce.
  m.regler = async (inst, hosts) => {
    const nouveau = !reglages.has(inst);
    reglages.set(inst, nettoyer(hosts));
    for (const fn of ecoutes.reglages) fn(inst, { hosts: j(reglages.get(inst)) });
    if (nouveau) await m.emettre("instances", horizon.instances());
    await vider();
  };
  m.retirer = async (inst) => {
    reglages.delete(inst);
    await m.emettre("instances", horizon.instances());
  };
  m.ecrireSsh = async (contenu) => {
    ecoutes.fichier(contenu);
    await vider();
  };
  m.choisir = async (cle) => {
    for (const fn of ecoutes.palette) fn(cle);
    await vider();
  };
  // Valeurs posées sur un exemplaire (les dernières).
  m.ui = (inst) => {
    const vu = {};
    for (const p of m.poses) if (p.inst === undefined || p.inst === inst) vu[p.prop] = p.valeur;
    return vu;
  };
  // Un tic par seconde pendant `secondes` : le panneau de l'exemplaire est montré.
  m.panneau = async (inst, secondes) => {
    for (let i = 0; i < secondes; i++) {
      await m.avancer(1000);
      await m.rappel("tic", inst);
    }
  };

  // Le script ne voit que `horizon` et l'horloge : ni console, ni setTimeout, ni require.
  m.contexte = vm.createContext({ horizon, Date: { now: () => t } });
  vm.runInContext('"use strict";' + SOURCE, m.contexte, { filename: "main.js" });
  // Comme Horizon : première lecture du fichier surveillé, puis dernier état de présence.
  await m.ecrireSsh(ssh);
  if (absent !== undefined) await m.emettre("presence", { away: absent });
  return m;
}

// Fonctions pures du script, pour les essais repris du widget d'origine.
let pur;
const constante = (nom) => vm.runInContext(nom, pur.contexte);

const CONFIG = `
# commentaire
Host *.lan
User admin

Host website web
HostName 192.168.1.20
Port 2222
IdentityFile ~/.ssh/cle_secrete

Host nas
  HostName=nas.lan
  User "moi"

Host * !nas
Port 22
User defaut

Host jump-?? bastion*
HostName 10.0.0.1

Match host truc
HostName 1.2.3.4
Host truc
`;
const DEUX = "Host website\n HostName 192.168.1.20\n Port 2222\nHost nas\n HostName nas.lan\n";
const cibles = (config, hosts) => j(pur.contexte.cibles(pur.contexte.lireSsh(config), pur.contexte.normaliser(nettoyer(hosts))));

const essais = [];
const essai = (nom, fn) => essais.push({ nom, fn });

// ── Repris de homelab/tests.rs ──────────────────────────────────────────────────────────────

essai("ssh : hôtes sans joker, dans l'ordre du fichier", () => {
  const h = j(pur.contexte.lireSsh(CONFIG));
  assert.deepEqual(h.map((x) => x.alias), ["website", "web", "nas", "truc"]);
});

essai("ssh : la première valeur l'emporte, les blocs génériques s'appliquent", () => {
  const h = j(pur.contexte.lireSsh(CONFIG));
  const web = h[0];
  assert.equal(web.hostname, "192.168.1.20");
  assert.equal(web.port, 2222);
  assert.equal(web.user, "defaut");
  assert.equal(h[1].hostname, web.hostname);
  // `nas` : « Host * !nas » ne s'applique pas ; « HostName= » et guillemets acceptés.
  const nas = h[2];
  assert.equal(nas.hostname, "nas.lan");
  assert.equal(nas.port, null);
  assert.equal(nas.user, "moi");
  // Le bloc Match n'est pas évalué.
  assert.equal(h[3].hostname, null);
});

essai("ssh : lignes d'avant tout Host, et %h", () => {
  const h = j(pur.contexte.lireSsh("Port 2200\nHost box\n  HostName %h.maison\n"));
  assert.deepEqual(h, [{ alias: "box", hostname: "box.maison", port: 2200, user: null }]);
});

essai("ssh : les clés ne sont jamais gardées", () => {
  assert.ok(!JSON.stringify(pur.contexte.lireSsh(CONFIG)).includes("cle_secrete"));
});

essai("ssh : configuration vide ou illisible", () => {
  assert.deepEqual(j(pur.contexte.lireSsh("")), []);
  assert.deepEqual(j(pur.contexte.lireSsh("Host *\n  User x\n")), []);
  assert.equal(pur.contexte.lireSsh("Host a\n Port pas-un-nombre\n")[0].port, null);
  // Fins de ligne de Windows.
  assert.deepEqual(j(pur.contexte.lireSsh("Host a\r\n  HostName b\r\n")), [{ alias: "a", hostname: "b", port: null, user: null }]);
});

essai("ssh : motifs", () => {
  const { motif } = pur.contexte;
  assert.ok(motif("*.lan", "nas.LAN"));
  assert.ok(motif("jump-??", "jump-01"));
  assert.ok(!motif("jump-??", "jump-1"));
  assert.ok(motif("*", ""));
  assert.ok(motif("a*b*c", "axxbyyc"));
  assert.ok(!motif("a*b", "ac"));
});

essai("hôtes : ceux de ssh, avec les défauts", () => {
  const c = cibles(DEUX, []);
  assert.equal(c.length, 2);
  assert.equal(c[0].sonde, "192.168.1.20:2222");
  assert.equal(c[0].ssh, "website");
  assert.equal(c[1].sonde, "nas.lan:" + constante("PORT_DEFAUT"));
  assert.equal(c[1].nom, "nas");
  assert.ok(!c[0].masque);
});

essai("réglages : renommer, masquer, choisir le test, ajouter", () => {
  const c = cibles(DEUX, [
    { id: "website", label: "Site", check: "http", url: "https://site.lan" },
    { id: "nas", hidden: true, port: 5000 },
    { id: "pi", address: "192.168.1.30", url: "javascript:alert(1)" },
    { id: "vide", address: "  " },
  ]);
  assert.equal(c.length, 3);
  assert.equal(c[0].nom, "Site");
  assert.equal(c[0].sonde, "https://site.lan");
  assert.equal(c[0].test, "HTTPS");
  assert.ok(c[1].masque);
  assert.equal(c[1].sonde, "nas.lan:5000");
  // Ajouté à la main : ssh vise son adresse.
  assert.equal(c[2].id, "pi");
  assert.equal(c[2].ssh, "192.168.1.30");
  assert.equal(c[2].url, null);
});

essai("réglages : la forme du widget d'origine est reprise telle quelle", () => {
  // Champs à null de l'ancien widget : Horizon leur donne le défaut du champ.
  const c = cibles(DEUX, [
    { id: "nas", address: null, label: "Stockage", hidden: false, check: "http", port: null, url: "http://nas.lan:5000" },
    { id: "pi", address: "192.168.1.30", label: null, hidden: false, check: "tcp", port: 8080, url: null },
    { id: "", address: "10.0.0.7", label: null, hidden: false, check: "tcp", port: null, url: null },
    { id: "website", address: "1.2.3.4", label: "Doublon", hidden: false, check: "tcp", port: null, url: null },
  ]);
  assert.deepEqual(c.map((x) => x.id), ["website", "nas", "pi", "10.0.0.7"]);
  assert.deepEqual([c[1].nom, c[1].sonde, c[1].test, c[1].ssh], ["Stockage", "http://nas.lan:5000", "HTTP", "nas"]);
  assert.deepEqual([c[2].nom, c[2].sonde, c[2].ssh], ["pi", "192.168.1.30:8080", "192.168.1.30"]);
  // Sans alias, l'identifiant d'un hôte ajouté à la main est son adresse.
  assert.deepEqual([c[3].nom, c[3].sonde, c[3].ssh], ["10.0.0.7", "10.0.0.7:22", "10.0.0.7"]);
  // Un hôte ajouté sous l'alias d'un hôte de ssh ne le remplace pas.
  assert.deepEqual([c[0].nom, c[0].sonde], ["website", "192.168.1.20:2222"]);
});

essai("réglages : HTTP sans adresse web revient à TCP, les réglages illisibles sont ignorés", () => {
  assert.equal(cibles(DEUX, [{ id: "nas", check: "http" }])[1].test, "TCP 22");
  assert.deepEqual(j(pur.contexte.normaliser("n'importe quoi")), []);
  assert.deepEqual(j(pur.contexte.normaliser(null)), []);
  assert.deepEqual(j(pur.contexte.normaliser(undefined)), []);
});

essai("ssh : une cible ne peut pas porter d'option", () => {
  const { sshSur } = pur.contexte;
  for (const bon of ["website", "moi@192.168.1.2", "[fe80::1]", "srv-1.local"]) assert.ok(sshSur(bon), bon);
  for (const faux of ["-oProxyCommand=calc", "a b", 'a"b', "", "nas; calc", "a`b", "a$b", "nas\n"]) assert.ok(!sshSur(faux), faux);
  assert.equal(cibles("Host -oProxyCommand=x\n", [])[0].ssh, null);
});

essai("état : un échec ne suffit pas", () => {
  const { observer, etat, santeNeuve } = pur.contexte;
  const s = santeNeuve();
  assert.equal(etat(s), 0);
  assert.equal(observer(s, 4, 0), null);
  assert.equal(etat(s), 1);
  assert.equal(observer(s, null, 60), null);
  assert.equal(etat(s), 1);
  assert.equal(observer(s, 5, 120), null);
  assert.equal(observer(s, null, 180), null);
  assert.equal(etat(s), 1);
});

essai("état : deux échecs puis le retour sont annoncés une fois", () => {
  const { observer, etat, santeNeuve } = pur.contexte;
  const s = santeNeuve();
  observer(s, 4, 0);
  assert.equal(observer(s, null, 60), null);
  assert.equal(observer(s, null, 120), "chute");
  assert.equal(etat(s), 3);
  assert.equal(s.depuis, 120);
  assert.equal(s.latence, null);
  assert.equal(observer(s, null, 180), null);
  assert.equal(observer(s, 7, 240), "retour");
  assert.equal(s.depuis, 240);
  assert.equal(observer(s, 7, 300), null);
});

essai("état : un hôte absent au démarrage n'est pas annoncé", () => {
  const { observer, etat, santeNeuve } = pur.contexte;
  const s = santeNeuve();
  assert.equal(observer(s, null, 0), null);
  assert.equal(etat(s), 0);
  assert.equal(observer(s, null, 60), null);
  assert.equal(etat(s), 3);
  assert.equal(observer(s, 3, 120), null);
  assert.equal(etat(s), 1);
});

essai("état : latence lente", () => {
  const { observer, etat, santeNeuve } = pur.contexte;
  const lent = constante("LENT");
  assert.equal(lent, 300);
  const s = santeNeuve();
  observer(s, lent, 0);
  assert.equal(etat(s), 2);
  observer(s, lent - 1, 1);
  assert.equal(etat(s), 1);
});

essai("durées : comme time.rs", () => {
  const { duree } = pur.contexte;
  const t = 10_000_000_000;
  assert.equal(duree(t - 12_000, t), "12 s");
  assert.equal(duree(t - 95_000, t), "1 min");
  assert.equal(duree(t - (3600 + 5 * 60) * 1000, t), "1 h 05");
  assert.equal(duree(t - 2 * 86_400_000 - 5, t), "2 j");
  assert.equal(duree(t + 5000, t), "0 s");
});

// ── Le script dans Horizon ──────────────────────────────────────────────────────────────────

essai("chargement : hôtes montrés, premier sondage, un hôte commun sondé une fois", async () => {
  const m = await monde({
    ssh: DEUX,
    exemplaires: { w1: [], w2: [{ id: "pi", address: "192.168.1.30", check: "http", url: "http://pi.lan" }] },
  });
  assert.equal(m.sondes.length, 0);
  assert.deepEqual([m.ui("w1").charge, m.ui("w1").total, m.ui("w2").total], [true, 2, 3]);
  assert.deepEqual(m.ui("w1").hotes, [{ nom: "website", etat: 0 }, { nom: "nas", etat: 0 }]);
  assert.equal(m.ui("w1").lignes[0].latence, "en attente");

  await m.avancer(250);
  assert.deepEqual(m.sondes, ["192.168.1.20:2222", "nas.lan:22", "http://pi.lan"]);
  const w1 = m.ui("w1");
  assert.deepEqual([w1.total, w1["en-ligne"], w1["hors-ligne"]], [2, 2, 0]);
  assert.deepEqual(w1.lignes[0], {
    id: "website",
    nom: "website",
    meta: "192.168.1.20 · TCP 2222",
    etat: 1,
    latence: "4 ms",
    depuis: "0 s",
    url: "",
    ssh: true,
  });
  const pi = m.ui("w2").lignes[2];
  assert.deepEqual([pi.meta, pi.url, pi.ssh], ["192.168.1.30 · HTTP", "http://pi.lan", true]);

  // Puis toutes les 60 s, pas avant.
  await m.avancer(59_900);
  assert.equal(m.sondes.length, 3);
  await m.avancer(100);
  assert.equal(m.sondes.length, 6);
  await m.avancer(60_000);
  assert.equal(m.sondes.length, 9);
  assert.equal(m.minuteurs, 1);
});

essai("barre : aucun serveur, compteur au-delà de 8, hôtes masqués, lenteur", async () => {
  const m = await monde({ ssh: null, exemplaires: { w1: [] } });
  assert.deepEqual([m.ui("w1").charge, m.ui("w1").total, m.ui("w1").hotes], [true, 0, []]);
  await m.rappel("reglages", "w1");
  assert.deepEqual(m.reglagesOuverts, ["w1"]);

  const neuf = Array.from({ length: 9 }, (_, i) => ({ label: "srv" + i, address: "10.0.0." + i }));
  await m.regler("w1", neuf.concat({ label: "caché", address: "10.0.0.99", hidden: true }));
  m.pannes.add("10.0.0.3:22");
  m.latences.set("10.0.0.4:22", 300);
  await m.avancer(250);
  assert.ok(!m.sondes.includes("10.0.0.99:22"), "un hôte masqué n'est pas sondé");
  await m.avancer(60_000);
  const w = m.ui("w1");
  assert.deepEqual([w.total, w["en-ligne"], w["hors-ligne"], w.hotes], [9, 8, 1, []]);
  assert.deepEqual(w.lignes.map((l) => l.etat), [1, 1, 1, 3, 2, 1, 1, 1, 1]);
  assert.deepEqual([w.lignes[3].latence, w.lignes[4].latence], ["hors ligne", "300 ms"]);
  assert.equal(m.alertes.length, 0);

  await m.regler("w1", neuf.slice(0, 8));
  assert.equal(m.ui("w1").hotes.length, 8);
  assert.deepEqual(m.ui("w1").hotes[3], { nom: "srv3", etat: 3 });
});

essai("sondage : jamais à moins de 5 s du précédent, relancé par les réglages", async () => {
  const m = await monde({ ssh: DEUX });
  await m.avancer(250);
  assert.equal(m.sondes.length, 2);
  // Réglages changés une seconde après : le sondage attend que 5 s soient passées.
  await m.avancer(1000);
  await m.regler("w1", [{ label: "pi", address: "192.168.1.30" }]);
  assert.equal(m.ui("w1").lignes[2].latence, "en attente");
  await m.avancer(3900);
  assert.equal(m.sondes.length, 2);
  await m.avancer(100);
  assert.deepEqual(m.sondes.slice(2), ["192.168.1.20:2222", "nas.lan:22", "192.168.1.30:22"]);
  assert.equal(m.ui("w1").lignes[2].latence, "4 ms");
  // La période repart de ce sondage.
  await m.avancer(59_900);
  assert.equal(m.sondes.length, 5);
  await m.avancer(100);
  assert.equal(m.sondes.length, 8);
  // Plusieurs changements de suite : un seul sondage.
  await m.avancer(10_000);
  await m.regler("w1", [{ label: "a", address: "10.0.0.1" }]);
  await m.regler("w1", [{ label: "b", address: "10.0.0.2" }]);
  await m.avancer(250);
  assert.deepEqual(m.sondes.slice(8), ["192.168.1.20:2222", "nas.lan:22", "10.0.0.2:22"]);
});

essai("absence : pas de sondage, puis tout de suite au retour", async () => {
  const m = await monde({ ssh: DEUX, absent: false });
  await m.avancer(250);
  assert.equal(m.sondes.length, 2);
  await m.emettre("presence", { away: true });
  assert.equal(m.minuteurs, 0, "rien ne tourne pendant l'absence");
  await m.avancer(600_000);
  assert.equal(m.sondes.length, 2);
  await m.emettre("presence", { away: false });
  await m.avancer(250);
  assert.equal(m.sondes.length, 4);
  // Aller-retour éclair : pas à moins de 5 s du sondage précédent.
  await m.avancer(1000);
  await m.emettre("presence", { away: true });
  await m.emettre("presence", { away: false });
  await m.avancer(3900);
  assert.equal(m.sondes.length, 4);
  await m.avancer(100);
  assert.equal(m.sondes.length, 6);

  // Absent dès le chargement : le premier sondage attend le retour.
  const n = await monde({ ssh: DEUX, absent: true });
  await n.avancer(120_000);
  assert.equal(n.sondes.length, 0);
  assert.equal(n.ui("w1").total, 2);
  await n.emettre("presence", { away: false });
  await n.avancer(250);
  assert.equal(n.sondes.length, 2);
});

essai("panneau : sondage à l'ouverture si le dernier a plus de 5 s, durées tenues à jour", async () => {
  const m = await monde({ ssh: DEUX });
  await m.avancer(250);
  // Ouvert 2 s après un sondage : celui-ci vaut encore.
  await m.panneau("w1", 2);
  assert.equal(m.sondes.length, 2);
  assert.equal(m.ui("w1").lignes[0].depuis, "2 s");
  // Fermé, puis rouvert 10 s plus tard : nouveau sondage, une seule fois tant qu'il reste montré.
  await m.avancer(10_000);
  await m.panneau("w1", 1);
  await m.avancer(250);
  assert.equal(m.sondes.length, 4);
  await m.panneau("w1", 30);
  assert.equal(m.sondes.length, 4);
  assert.equal(m.ui("w1").lignes[0].depuis, "43 s");
  // Une tuile (panneau toujours montré) suit la période, sans relancer.
  await m.panneau("w1", 120);
  assert.equal(m.sondes.length, 8);
  assert.equal(m.ui("w1").lignes[0].depuis, "2 min");
  // Entre deux changements, un tic ne pose rien.
  const avant = m.poses.length;
  await m.panneau("w1", 5);
  assert.equal(m.poses.length, avant);
  // Pendant une absence, les tics d'une tuile ne font rien.
  await m.emettre("presence", { away: true });
  await m.panneau("w1", 200);
  assert.equal(m.sondes.length, 8);
  assert.equal(m.poses.length, avant);
});

essai("alertes : chute puis retour annoncés une fois, avec les textes d'origine", async () => {
  const m = await monde({ ssh: "Host nas\n HostName nas.lan\n" });
  await m.avancer(250);
  m.pannes.add("nas.lan:22");
  await m.avancer(60_000);
  // Un échec : toujours en ligne, dernière latence gardée.
  assert.deepEqual([m.ui("w1").lignes[0].etat, m.ui("w1").lignes[0].latence, m.alertes.length], [1, "4 ms", 0]);
  await m.avancer(60_000);
  assert.deepEqual(m.alertes.map((a) => [a.title, a.body, a.icon]), [["nas est hors ligne", "Injoignable deux fois de suite", "hardDrives"]]);
  const l = m.ui("w1").lignes[0];
  assert.deepEqual([l.etat, l.latence, l.depuis, m.ui("w1")["hors-ligne"]], [3, "hors ligne", "0 s", 1]);
  await m.avancer(60_000);
  assert.equal(m.alertes.length, 1);
  assert.equal(m.ui("w1").lignes[0].depuis, "1 min");
  m.pannes.clear();
  m.latences.set("nas.lan:22", 7);
  await m.avancer(60_000);
  assert.deepEqual([m.alertes[1].title, m.alertes[1].body], ["nas est de nouveau en ligne", "Répond en 7 ms"]);
  assert.deepEqual([m.ui("w1").lignes[0].etat, m.ui("w1")["hors-ligne"], m.ui("w1")["en-ligne"]], [1, 0, 1]);
  await m.avancer(180_000);
  assert.equal(m.alertes.length, 2);
  assert.equal(m.alertesIgnorees, 0);
});

essai("alertes : un hôte absent au démarrage n'est jamais annoncé", async () => {
  const m = await monde({ ssh: "Host nas\n" });
  m.pannes.add("nas:22");
  await m.avancer(250);
  assert.equal(m.ui("w1").lignes[0].etat, 0);
  await m.avancer(60_000);
  assert.equal(m.ui("w1").lignes[0].etat, 3);
  m.pannes.clear();
  await m.avancer(60_000);
  assert.equal(m.ui("w1").lignes[0].etat, 1);
  assert.equal(m.alertes.length, 0);
});

essai("alertes : plusieurs au même tour regroupées, aucune perdue", async () => {
  const hosts = ["a", "b", "c", "d"].map((n) => ({ label: n, address: n + ".lan" }));
  const m = await monde({ ssh: null, exemplaires: { w1: hosts, w2: hosts.slice(0, 2) } });
  await m.avancer(250);
  assert.equal(m.sondes.length, 4);
  for (const n of ["a", "b", "c"]) m.pannes.add(n + ".lan:22");
  await m.avancer(120_000);
  assert.deepEqual(m.alertes.map((a) => [a.title, a.body]), [["3 serveurs sont hors ligne", "a, b, c"]]);
  // Un seul retour : l'alerte d'origine (et un seul échec de `d` : rien encore).
  m.pannes.delete("a.lan:22");
  m.pannes.add("d.lan:22");
  await m.avancer(60_000);
  assert.deepEqual([m.alertes.length, m.alertes[1].title], [2, "a est de nouveau en ligne"]);
  // Au même tour : une chute et un retour. La seconde alerte attend son tour (5 s).
  m.pannes.delete("b.lan:22");
  await m.avancer(60_000);
  assert.deepEqual([m.alertes.length, m.alertes[2].title], [3, "d est hors ligne"]);
  await m.avancer(5400);
  assert.equal(m.alertes.length, 3);
  await m.avancer(100);
  assert.deepEqual([m.alertes[3].title, m.alertes[3].body], ["b est de nouveau en ligne", "Répond en 4 ms"]);
  assert.equal(m.alertesIgnorees, 0);
  await m.avancer(120_000);
  m.pannes.clear();
  await m.avancer(60_000);
  assert.deepEqual([m.alertes.at(-1).title, m.alertes.at(-1).body], ["2 serveurs sont de nouveau en ligne", "c, d"]);
  assert.equal(m.alertesIgnorees, 0);
  assert.equal(m.minuteurs, 1, "le minuteur des alertes s'arrête quand tout est dit");
});

essai("palette : SSH et Web de chaque hôte connu, sans doublon, 50 au plus", async () => {
  const m = await monde({
    ssh: DEUX + "Host -oProxyCommand=x\n",
    exemplaires: {
      w1: [{ id: "website", label: "Site", url: "https://site.lan" }, { id: "nas", hidden: true }],
      w2: [{ label: "pi", address: "192.168.1.30" }],
    },
  });
  assert.deepEqual(m.palette, [
    { id: "ssh:website", label: "SSH : Site", icon: "terminalWindow" },
    { id: "web:website", label: "Web : Site", icon: "globeSimple" },
    // Masqué dans w1, visible dans w2 ; l'alias dangereux n'a pas d'entrée SSH.
    { id: "ssh:nas", label: "SSH : nas", icon: "terminalWindow" },
    { id: "ssh:192.168.1.30", label: "SSH : pi", icon: "terminalWindow" },
  ]);
  await m.choisir("ssh:nas");
  await m.choisir("web:website");
  await m.choisir("ssh:inconnu");
  assert.deepEqual([m.terminaux, m.liens], [["nas"], ["https://site.lan"]]);

  const beaucoup = Array.from({ length: 40 }, (_, i) => ({ label: "srv" + i, address: "10.0.1." + i, url: "http://10.0.1." + i }));
  await m.regler("w1", beaucoup);
  assert.equal(m.palette.length, 50);

  // Sans exemplaire : les hôtes de ssh.
  const vide = await monde({ ssh: DEUX, exemplaires: {} });
  assert.deepEqual(vide.palette.map((e) => e.label), ["SSH : website", "SSH : nas"]);
  await vide.avancer(120_000);
  assert.equal(vide.sondes.length, 0, "sans exemplaire, rien n'est sondé");
});

essai("panneau : terminal, interface web, erreur montrée puis effacée", async () => {
  const m = await monde({
    ssh: DEUX + "Host -oProxyCommand=x\n",
    exemplaires: { w1: [{ id: "website", url: "https://site.lan" }, { id: "nas", label: "Stockage", url: "https://moi:secret@nas.lan" }] },
  });
  assert.deepEqual(m.ui("w1").lignes.map((l) => l.ssh), [true, true, false]);
  await m.rappel("ssh", "w1", "website");
  await m.rappel("web", "w1", "website");
  assert.deepEqual([m.terminaux, m.liens, m.ui("w1").erreur], [["website"], ["https://site.lan"], ""]);
  // Lien qu'Horizon refuse (mot de passe dans l'adresse).
  await m.rappel("web", "w1", "nas");
  assert.ok(m.ui("w1").erreur.startsWith("Stockage : "), m.ui("w1").erreur);
  await m.rappel("ssh", "w1", "nas");
  assert.deepEqual([m.terminaux, m.ui("w1").erreur], [["website", "nas"], ""]);
  // Hôte sans cible sûre, hôte inconnu : rien n'est ouvert.
  await m.rappel("ssh", "w1", "-oProxyCommand=x");
  assert.equal(m.ui("w1").erreur, "-oProxyCommand=x : hôte inconnu");
  await m.rappel("web", "w1", "disparu");
  assert.equal(m.ui("w1").erreur, "disparu : hôte inconnu");
  assert.equal(m.terminaux.length, 2);
  // L'erreur part à la réouverture du panneau.
  await m.avancer(10_000);
  await m.panneau("w1", 1);
  assert.equal(m.ui("w1").erreur, "");
});

essai("~/.ssh/config : relu quand il change, absent = hôtes ajoutés à la main seulement", async () => {
  const m = await monde({ ssh: DEUX, exemplaires: { w1: [{ label: "pi", address: "192.168.1.30" }] } });
  await m.avancer(250);
  assert.equal(m.ui("w1").total, 3);
  await m.avancer(10_000);
  await m.ecrireSsh(DEUX + "Host neuf\n HostName 10.0.0.5\n");
  assert.deepEqual(m.ui("w1").lignes.map((l) => l.id), ["website", "nas", "neuf", "192.168.1.30"]);
  await m.avancer(250);
  assert.equal(m.ui("w1").lignes[2].latence, "4 ms");
  await m.avancer(10_000);
  await m.ecrireSsh(null);
  assert.deepEqual(m.ui("w1").lignes.map((l) => l.id), ["192.168.1.30"]);
  assert.deepEqual(m.palette.map((e) => e.label), ["SSH : pi"]);
  await m.avancer(250);
  assert.deepEqual(m.sondes.slice(-1), ["192.168.1.30:22"]);
});

essai("exemplaires : ajoutés et retirés, état des sondes abandonnées oublié", async () => {
  const m = await monde({ ssh: null, exemplaires: { w1: [{ label: "a", address: "a.lan" }] } });
  await m.avancer(250);
  await m.avancer(10_000);
  await m.regler("w2", [{ label: "b", address: "b.lan" }, { label: "a bis", address: "a.lan" }]);
  // L'hôte commun garde son état, le nouveau attend son premier sondage.
  assert.deepEqual(m.ui("w2").lignes.map((l) => l.latence), ["en attente", "4 ms"]);
  await m.avancer(250);
  assert.deepEqual(m.sondes, ["a.lan:22", "a.lan:22", "b.lan:22"]);
  await m.retirer("w1");
  await m.avancer(5000);
  assert.deepEqual(m.sondes.slice(3), ["b.lan:22", "a.lan:22"]);
  await m.regler("w2", [{ label: "b", address: "b.lan" }]);
  await m.avancer(5000);
  // `a` n'est plus voulu : rajouté plus tard, il repart de « en attente ».
  await m.avancer(5000);
  await m.regler("w2", [{ label: "b", address: "b.lan" }, { label: "a", address: "a.lan" }]);
  assert.deepEqual(m.ui("w2").lignes.map((l) => l.latence), ["4 ms", "en attente"]);
});

essai("sondes : 16 à la fois au plus, une cible refusée compte comme injoignable", async () => {
  const hosts = Array.from({ length: 40 }, (_, i) => ({ label: "srv" + i, address: "10.0.2." + i }));
  const m = await monde({ ssh: null, exemplaires: { w1: hosts.concat({ label: "faux", address: "pas une adresse" }) } });
  m.auto = false;
  await m.avancer(250);
  assert.equal(m.enAttente, 16);
  await m.repondre(false);
  assert.deepEqual([m.enAttente, m.sondes.length], [16, 32]);
  // Tant que le tour n'est pas fini, rien n'est conclu.
  assert.equal(m.ui("w1").lignes[0].etat, 0);
  await m.repondre();
  assert.deepEqual([m.enAttente, m.sondes.length, m.enVolMax], [0, 40, 16]);
  assert.deepEqual([m.ui("w1")["en-ligne"], m.ui("w1")["hors-ligne"]], [40, 0]);
  m.auto = true;
  await m.avancer(60_000);
  const faux = m.ui("w1").lignes[40];
  assert.deepEqual([faux.nom, faux.etat, m.ui("w1")["hors-ligne"]], ["faux", 3, 1]);
});

essai("sondes : un tour sans réponse est abandonné, le suivant repart", async () => {
  const m = await monde({ ssh: DEUX });
  m.auto = false;
  await m.avancer(250);
  assert.equal(m.enAttente, 2);
  const abandon = () => m.journal.some((l) => l.niveau === "warn" && l.texte.includes("abandonné"));
  // Pas de second tour pendant le premier, même la période passée.
  await m.avancer(134_000);
  assert.ok(!abandon());
  assert.equal(m.sondes.length, 2);
  // Abandonné : le tour suivant part aussitôt (la période est passée).
  await m.avancer(1000);
  assert.ok(abandon());
  assert.deepEqual([m.sondes.length, m.enAttente], [4, 4]);
  // Les réponses tardives du tour abandonné sont ignorées.
  await m.repondre(false, 2);
  assert.deepEqual([m.enAttente, m.ui("w1").lignes[0].etat], [2, 0]);
  // Une demande faite pendant qu'un tour court attend sa fin.
  await m.regler("w1", []);
  await m.avancer(6000);
  assert.equal(m.sondes.length, 4, "pas de second tour pendant le premier");
  await m.repondre();
  assert.equal(m.ui("w1").lignes[0].etat, 1);
  await m.avancer(250);
  assert.equal(m.sondes.length, 6);
});

essai("sondes : refusées faute de place, elles ne disent pas un hôte hors ligne", async () => {
  const hosts = Array.from({ length: 16 }, (_, i) => ({ label: "srv" + i, address: "10.0.3." + i }));
  const m = await monde({ ssh: null, exemplaires: { w1: hosts } });
  await m.avancer(250);
  assert.equal(m.ui("w1")["en-ligne"], 16);
  // Un tour reste sans réponse : ses 16 sondes occupent toute la place qu'Horizon donne.
  m.auto = false;
  await m.avancer(60_000);
  assert.equal(m.enAttente, 16);
  await m.avancer(300_000);
  assert.deepEqual([m.sondes.length, m.ui("w1")["en-ligne"], m.ui("w1")["hors-ligne"], m.alertes.length], [32, 16, 0, 0]);
  await m.repondre();
  m.auto = true;
  await m.avancer(60_000);
  assert.deepEqual([m.sondes.length, m.ui("w1")["en-ligne"], m.alertes.length], [48, 16, 0]);
});

essai("manifeste : ce que le script utilise est déclaré, et rien de plus", () => {
  assert.equal(MANIFESTE.id, path.basename(__dirname));
  assert.equal(MANIFESTE.api, 1);
  assert.deepEqual(MANIFESTE.permissions, { files: ["%USERPROFILE%/.ssh/config"], events: ["presence"], system: ["probe", "ssh", "open"] });
  assert.deepEqual(CHAMPS.map((c) => c.key), ["label", "id", "address", "check", "port", "url", "hidden"]);
  // Chaque rappel des .slint est écouté par le script, chaque propriété posée.
  for (const r of RAPPELS) assert.ok(SOURCE.includes(`horizon.ui.on("${r}"`), `rappel « ${r} » sans écoute`);
  const posees = new Set(pur.poses.map((p) => p.prop));
  for (const p of PROPRIETES) if (p !== "compact") assert.ok(posees.has(p), `propriété « ${p} » jamais posée`);
});

(async () => {
  pur = await monde({ ssh: DEUX });
  let rates = 0;
  for (const { nom, fn } of essais) {
    try {
      await fn();
      console.log("ok    " + nom);
    } catch (e) {
      rates++;
      console.log("RATÉ  " + nom);
      console.log(String(e && e.stack ? e.stack : e).replace(/^/gm, "      "));
    }
  }
  console.log(rates ? `${rates} essai(s) raté(s) sur ${essais.length}` : `${essais.length} essais réussis`);
  process.exit(rates ? 1 : 0);
})();
