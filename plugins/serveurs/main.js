// Serveurs (homelab) : hôtes de ~/.ssh/config complétés par les réglages de chaque exemplaire
// (renommer, masquer, ajouter, choisir le test), sondés toutes les 60 s (tout de suite au retour
// d'une absence, à l'ouverture d'un panneau et après un changement de réglages). Chute et retour
// d'un hôte annoncés une fois (deux échecs de suite avant de le dire hors ligne). Terminal SSH et
// interface web depuis le panneau et la palette.
//
// Seuls Host, HostName, Port et User sont lus dans ~/.ssh/config : les clés (IdentityFile…) et
// le reste ne sont jamais gardés.

const FICHIER = "%USERPROFILE%/.ssh/config";
const PERIODE = 60000;
// Deux sondages rapprochés (panneau rouvert) ne relancent pas les connexions.
const ECART = 5000;
const PORT_DEFAUT = 22;
// Latence (ms) à partir de laquelle un hôte joignable est « lent » (pastille orange).
const LENT = 300;
// Échecs de suite avant de dire un hôte hors ligne (un paquet perdu ne suffit pas).
const ECHECS = 2;
// Sondes en cours au plus (limite d'Horizon).
const PARALLELE = 16;
// Garde-fou : un sondage dont les réponses n'arrivent pas est abandonné après ce délai, plus
// un autre par lot de sondes (un nom introuvable peut faire attendre Windows longtemps).
const ABANDON = 120000;
const ABANDON_PAR_LOT = 15000;
// Horizon montre une alerte toutes les 5 s au plus : les suivantes attendent leur tour.
const ALERTE_ECART = 5500;
const ALERTES_MAX = 8;
const PALETTE_MAX = 50;
// Au-delà, la barre montre un compteur à la place des pastilles.
const PASTILLES_MAX = 8;
// État d'un hôte : 0 en attente, 1 en ligne, 2 lent, 3 hors ligne.
const ETATS = ["en attente", "en ligne", "lent", "hors ligne"];

// ── ~/.ssh/config ───────────────────────────────────────────────────────────────────────────

// Mots d'une ligne de configuration, guillemets retirés.
function mots(s) {
  const liste = [];
  let mot = "";
  let guillemets = false;
  for (const c of s) {
    if (c === '"') guillemets = !guillemets;
    else if (!guillemets && /\s/.test(c)) {
      if (mot) liste.push(mot);
      mot = "";
    } else mot += c;
  }
  if (mot) liste.push(mot);
  return liste;
}

// Mot-clé (en minuscules) et arguments : « Clé valeur » ou « Clé=valeur ». null : rien à lire.
function decouper(ligne) {
  const l = ligne.trim();
  if (!l || l.startsWith("#")) return null;
  const fin = l.search(/[\s=]/);
  if (fin < 0) return { cle: l.toLowerCase(), args: [] };
  const reste = l.slice(fin).trimStart();
  return { cle: l.slice(0, fin).toLowerCase(), args: mots(reste.startsWith("=") ? reste.slice(1) : reste) };
}

// Motif de ssh_config (« * », « ? »), sans tenir compte de la casse.
function motif(m, texte) {
  const p = Array.from(m.toLowerCase());
  const t = Array.from(texte.toLowerCase());
  let pi = 0;
  let ti = 0;
  let etoile = -1;
  let marque = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) {
      pi++;
      ti++;
    } else if (pi < p.length && p[pi] === "*") {
      etoile = pi;
      marque = ti;
      pi++;
    } else if (etoile >= 0) {
      pi = etoile + 1;
      marque++;
      ti = marque;
    } else return false;
  }
  return p.slice(pi).every((c) => c === "*");
}

// Le bloc s'applique à `alias` : un motif positif correspond et aucun motif « ! » ne l'exclut.
// Un bloc Match n'est jamais appliqué (ses conditions ne sont pas évaluées).
function applique(bloc, alias) {
  if (bloc.match) return false;
  let touche = false;
  for (const m of bloc.motifs) {
    if (m.startsWith("!")) {
      if (motif(m.slice(1), alias)) return false;
    } else if (motif(m, alias)) touche = true;
  }
  return touche;
}

// Port lu (0 à 65535 ; un port 0 vaudra le port par défaut), ou null.
function portLu(s) {
  if (!/^\+?\d+$/.test(s)) return null;
  const n = Number(s);
  return n <= 65535 ? n : null;
}

// Hôtes d'un ssh_config : un par nom de bloc Host sans joker, dans l'ordre du fichier. Comme
// ssh, la première valeur trouvée pour un hôte l'emporte (blocs génériques compris : « Host * »
// en tête du fichier s'applique à tous). Include n'est pas suivi.
function lireSsh(texte) {
  const bloc = (motifs, match) => ({ motifs, match, hostname: null, port: null, user: null });
  // Lignes avant tout Host : valables pour tous les hôtes.
  const blocs = [bloc(["*"], false)];
  for (const ligne of texte.split("\n")) {
    const l = decouper(ligne);
    if (!l) continue;
    const premier = l.args.length ? l.args[0] : null;
    const b = blocs[blocs.length - 1];
    if (l.cle === "host") blocs.push(bloc(l.args, false));
    else if (l.cle === "match") blocs.push(bloc([], true));
    else if (l.cle === "hostname" && b.hostname === null) b.hostname = premier;
    else if (l.cle === "port" && b.port === null) b.port = premier === null ? null : portLu(premier);
    else if (l.cle === "user" && b.user === null) b.user = premier;
  }
  const alias = [];
  for (const b of blocs) {
    if (b.match) continue;
    for (const m of b.motifs) {
      const litteral = m !== "" && !m.startsWith("!") && !/[*?]/.test(m);
      if (litteral && !alias.some((a) => a.toLowerCase() === m.toLowerCase())) alias.push(m);
    }
  }
  return alias.map((a) => {
    const h = { alias: a, hostname: null, port: null, user: null };
    for (const b of blocs) {
      if (!applique(b, a)) continue;
      if (h.hostname === null) h.hostname = b.hostname;
      if (h.port === null) h.port = b.port;
      if (h.user === null) h.user = b.user;
    }
    // « %h » = le nom demandé (ici l'alias).
    if (h.hostname !== null) h.hostname = h.hostname.split("%h").join(a);
    return h;
  });
}

// ── Réglages et hôtes à surveiller ──────────────────────────────────────────────────────────

const texte = (v) => (typeof v === "string" ? v.trim() : "");

// Réglage `hosts` d'un exemplaire, mis en forme. Sans adresse, une ligne complète l'hôte `id`
// de ~/.ssh/config ; avec, c'est un hôte ajouté à la main.
function normaliser(brut) {
  if (!Array.isArray(brut)) return [];
  return brut
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      id: texte(r.id),
      adresse: texte(r.address),
      nom: texte(r.label),
      masque: r.hidden === true,
      http: r.check === "http",
      // 0 : le port de ssh, sinon 22.
      port: Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 ? r.port : 0,
      url: texte(r.url),
    }));
}

// Adresse web acceptée (http ou https seulement), ou null.
function urlWeb(u) {
  return u.startsWith("https://") || u.startsWith("http://") ? u : null;
}

// Nom transmissible tel quel à ssh : pas d'option déguisée (« -oProxyCommand=… »), ni espace,
// ni guillemet, ni caractère de contrôle. La même règle que horizon.ssh.open.
function sshSur(s) {
  return /^(?!-)[A-Za-z0-9._@:\[\]-]+$/.test(s);
}

// Hôte à surveiller, réglage `r` appliqué. `sonde` : la cible de horizon.net.probe, qui sert
// aussi à reconnaître deux hôtes au même test (sondés une seule fois).
function cible(id, adresse, portSsh, r, manuel) {
  const url = r ? urlWeb(r.url) : null;
  const port = (r && r.port) || portSsh || PORT_DEFAUT;
  // HTTP sans adresse web : retour au test TCP.
  const http = !!r && r.http && url !== null;
  const nomSsh = manuel ? adresse : id;
  return {
    id,
    nom: (r && r.nom) || id,
    adresse,
    // Argument de ssh (alias de ~/.ssh/config, ou adresse d'un hôte ajouté à la main) ; null
    // si ce nom ne peut pas être passé sans risque à ssh.
    ssh: sshSur(nomSsh) ? nomSsh : null,
    url,
    sonde: http ? url : adresse + ":" + port,
    test: http ? (url.startsWith("https://") ? "HTTPS" : "HTTP") : "TCP " + port,
    masque: !!r && r.masque,
  };
}

// Hôtes d'un exemplaire : ceux de ~/.ssh/config dans l'ordre du fichier (avec leurs réglages),
// puis les hôtes ajoutés à la main (identifiant : l'alias donné, sinon l'adresse).
function cibles(ssh, reglages) {
  const reglage = (id) => reglages.find((r) => r.adresse === "" && r.id === id);
  const liste = ssh.map((h) => cible(h.alias, h.hostname || h.alias, h.port, reglage(h.alias), false));
  for (const r of reglages) {
    if (r.adresse === "") continue;
    const id = r.id || r.adresse;
    if (!liste.some((c) => c.id === id)) liste.push(cible(id, r.adresse, null, r, true));
  }
  return liste;
}

// ── État d'un hôte ──────────────────────────────────────────────────────────────────────────

// Suivi d'une sonde : un succès suffit à la dire en ligne, il faut ECHECS échecs de suite pour
// la dire hors ligne. `enLigne` : dernier verdict (null : pas encore) ; `depuis` : instant du
// dernier changement de verdict ; `annonce` : la chute a été annoncée, le retour le sera aussi.
function santeNeuve() {
  return { enLigne: null, echecs: 0, latence: null, depuis: null, annonce: false };
}

// Résultat d'un sondage (latence en ms, ou null : injoignable). Renvoie le changement à
// annoncer : "chute" d'un hôte qui était en ligne, "retour" d'un hôte dont la chute a été
// annoncée, sinon null. Un hôte déjà absent au démarrage n'est pas annoncé.
function observer(s, resultat, maintenant) {
  if (resultat !== null) {
    s.echecs = 0;
    s.latence = resultat;
    if (s.enLigne === true) return null;
    const retour = s.enLigne === false && s.annonce;
    s.enLigne = true;
    s.depuis = maintenant;
    s.annonce = false;
    return retour ? "retour" : null;
  }
  s.echecs = Math.min(255, s.echecs + 1);
  if (s.echecs < ECHECS || s.enLigne === false) return null;
  const etaitEnLigne = s.enLigne === true;
  s.enLigne = false;
  s.depuis = maintenant;
  s.latence = null;
  s.annonce = etaitEnLigne;
  return etaitEnLigne ? "chute" : null;
}

// 0 en attente (démarrage, ou un seul échec), 1 en ligne, 2 lent, 3 hors ligne.
function etat(s) {
  if (!s || s.enLigne === null) return 0;
  if (!s.enLigne) return 3;
  return s.latence !== null && s.latence >= LENT ? 2 : 1;
}

// Durée courte depuis un instant : « 12 s », « 4 min », « 1 h 05 », « 2 j ».
function duree(depuis, maintenant) {
  const s = Math.floor(Math.max(0, maintenant - depuis) / 1000);
  if (s < 60) return s + " s";
  if (s < 3600) return Math.floor(s / 60) + " min";
  if (s < 86400) return Math.floor(s / 3600) + " h " + String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return Math.floor(s / 86400) + " j";
}

// ── Ce que le script sait ───────────────────────────────────────────────────────────────────

let ssh = []; // hôtes de ~/.ssh/config
let pret = false; // ~/.ssh/config a été lu (avant : « Chargement… »)
let visibles = new Map(); // exemplaire → ses hôtes non masqués
const sante = new Map(); // sonde → suivi
const erreurs = new Map(); // exemplaire → échec d'un terminal ou d'un lien
const tics = new Map(); // exemplaire → dernier tic de son panneau
const poses = new Map(); // exemplaire → propriété → dernière valeur posée (JSON)
let actions = new Map(); // entrée de palette → { ssh } ou { url }

let absent = false; // session verrouillée ou écran éteint
let dernier = 0; // début du dernier sondage
let voulu = false; // un sondage est demandé sans attendre la période
let tour = null; // sondage en cours
let minuteur = 0;

const alertes = [];
let alerteLe = 0;
let minuteurAlerte = 0;

// ── Interface ───────────────────────────────────────────────────────────────────────────────

// Pose une valeur sur un exemplaire, si elle a changé. Les exemplaires se partagent les noms de
// propriété : sans ce filtre, chacun redessinerait à chaque tic du panneau d'un autre.
function poser(inst, prop, valeur) {
  let vues = poses.get(inst);
  if (!vues) poses.set(inst, (vues = new Map()));
  const json = JSON.stringify(valeur);
  if (vues.get(prop) === json) return;
  vues.set(prop, json);
  horizon.ui.set(prop, valeur, { instance: inst });
}

// Barre et panneau d'un exemplaire.
function montrer(inst) {
  const maintenant = Date.now();
  let enLigne = 0;
  let horsLigne = 0;
  const lignes = (visibles.get(inst) || []).map((c) => {
    const s = sante.get(c.sonde);
    const e = etat(s);
    if (e === 3) horsLigne++;
    else if (e !== 0) enLigne++;
    return {
      id: c.id,
      nom: c.nom,
      meta: c.adresse + " · " + c.test,
      etat: e,
      latence: s && s.latence !== null ? s.latence + " ms" : ETATS[e],
      depuis: s && s.depuis !== null ? duree(s.depuis, maintenant) : "",
      url: c.url || "",
      ssh: c.ssh !== null,
    };
  });
  poser(inst, "charge", pret);
  poser(inst, "total", lignes.length);
  poser(inst, "en-ligne", enLigne);
  poser(inst, "hors-ligne", horsLigne);
  poser(inst, "hotes", lignes.length <= PASTILLES_MAX ? lignes.map((l) => ({ nom: l.nom, etat: l.etat })) : []);
  poser(inst, "lignes", lignes);
  poser(inst, "erreur", erreurs.get(inst) || "");
}

// Hôtes visibles de tous les exemplaires, sans doublon (sans exemplaire : ceux de ssh).
function connus() {
  const insts = horizon.instances();
  if (!insts.length) return cibles(ssh, []);
  const vus = new Set();
  const liste = [];
  for (const inst of insts) {
    for (const c of visibles.get(inst) || []) {
      if (!vus.has(c.id)) liste.push(c);
      vus.add(c.id);
    }
  }
  return liste;
}

// Palette : terminal SSH et interface web de chaque hôte connu.
function palette() {
  // Horizon coupe l'identifiant d'une entrée à 64 caractères : le même ici, pour la retrouver.
  const cle = (k) => Array.from(k).slice(0, 64).join("");
  const entrees = [];
  actions = new Map();
  const ajouter = (id, label, icon, action) => {
    if (entrees.length >= PALETTE_MAX || actions.has(cle(id))) return;
    actions.set(cle(id), action);
    entrees.push({ id: cle(id), label, icon });
  };
  for (const c of connus()) {
    if (c.ssh !== null) ajouter("ssh:" + c.id, "SSH : " + c.nom, "terminalWindow", { ssh: c.ssh });
    if (c.url !== null) ajouter("web:" + c.id, "Web : " + c.nom, "globeSimple", { url: c.url });
  }
  horizon.palette.set(entrees);
}

// ~/.ssh/config, les réglages ou les exemplaires ont changé : hôtes recalculés, sondage demandé.
function actualiser() {
  const insts = horizon.instances();
  visibles = new Map(
    insts.map((inst) => [inst, cibles(ssh, normaliser(horizon.settings.get("hosts", inst))).filter((c) => !c.masque)]),
  );
  for (const m of [erreurs, tics, poses]) {
    for (const inst of Array.from(m.keys())) if (!visibles.has(inst)) m.delete(inst);
  }
  palette();
  insts.forEach(montrer);
  demander();
}

// ── Alertes ─────────────────────────────────────────────────────────────────────────────────

// Montre l'alerte suivante, à ALERTE_ECART au moins de la précédente (Horizon ignore les
// alertes trop rapprochées).
function alerter() {
  if (minuteurAlerte) horizon.timer.clear(minuteurAlerte);
  minuteurAlerte = 0;
  if (!alertes.length) return;
  let attente = ALERTE_ECART - Math.abs(Date.now() - alerteLe);
  if (attente <= 0) {
    alerteLe = Date.now();
    horizon.alert(alertes.shift());
    attente = ALERTE_ECART;
  }
  if (alertes.length) minuteurAlerte = horizon.timer.every(Math.max(250, attente), alerter);
}

function annoncer(title, body) {
  if (alertes.length >= ALERTES_MAX) alertes.shift();
  alertes.push({ title, body, icon: "hardDrives" });
  alerter();
}

// ── Sondage ─────────────────────────────────────────────────────────────────────────────────

// Arme le minuteur du prochain sondage : à la période, ou dès que l'écart minimal est passé
// s'il est demandé. Pendant un sondage, il sert de garde-fou ; pendant une absence, rien ne
// tourne. Un sondage ne part que de ce minuteur : plusieurs demandes de suite n'en font qu'un.
function planifier() {
  if (minuteur) horizon.timer.clear(minuteur);
  minuteur = 0;
  let attente;
  if (tour) attente = tour.limite - Date.now();
  else if (absent) return;
  else attente = (voulu ? ECART : PERIODE) - Math.abs(Date.now() - dernier);
  minuteur = horizon.timer.every(Math.min(PERIODE, Math.max(250, attente)), battre);
}

function demander() {
  voulu = true;
  planifier();
}

function battre() {
  const maintenant = Date.now();
  if (tour && maintenant >= tour.limite) {
    horizon.log.warn("sondage sans réponse : abandonné");
    tour = null;
  }
  if (!tour && !absent && Math.abs(maintenant - dernier) >= (voulu ? ECART : PERIODE)) sonder();
  else planifier();
}

// Sonde tous les hôtes visibles, une fois par façon de les joindre, avec le nom à annoncer.
function sonder() {
  voulu = false;
  dernier = Date.now();
  const voulues = [];
  const vues = new Set();
  for (const inst of horizon.instances()) {
    for (const c of visibles.get(inst) || []) {
      if (!vues.has(c.sonde)) voulues.push({ sonde: c.sonde, nom: c.nom });
      vues.add(c.sonde);
    }
  }
  const n = voulues.length;
  tour = {
    voulues,
    resultats: new Array(n), // latence, null : injoignable, rien : pas de verdict
    suivante: 0,
    enCours: 0,
    restant: n,
    limite: dernier + ABANDON + Math.ceil(n / PARALLELE) * ABANDON_PAR_LOT,
  };
  lancer(tour);
  if (tour) planifier();
}

// Lance les sondes suivantes du tour `t` (PARALLELE à la fois), puis conclut quand toutes ont
// répondu. Une cible qu'Horizon refuse (adresse mal formée) compte comme injoignable ; une
// sonde refusée faute de place (celles d'un tour abandonné courent encore) reste sans verdict.
function lancer(t) {
  while (t === tour && t.enCours < PARALLELE && t.suivante < t.voulues.length) {
    const i = t.suivante++;
    let promesse;
    try {
      promesse = horizon.net.probe(t.voulues[i].sonde);
    } catch (e) {
      if (!e || e.name !== "RangeError") t.resultats[i] = null;
      t.restant--;
      continue;
    }
    t.enCours++;
    promesse.then((r) => {
      t.enCours--;
      t.restant--;
      t.resultats[i] = r && r.ok ? (typeof r.ms === "number" ? Math.max(0, Math.round(r.ms)) : 0) : null;
      lancer(t);
    });
  }
  if (t === tour && t.restant === 0) conclure(t);
}

// Fin d'un tour : état de chaque sonde mis à jour, changements annoncés, interface reposée.
function conclure(t) {
  tour = null;
  const maintenant = Date.now();
  // L'état des sondes qui ne sont plus voulues est oublié.
  const gardees = new Set(t.voulues.map((v) => v.sonde));
  for (const sonde of Array.from(sante.keys())) if (!gardees.has(sonde)) sante.delete(sonde);
  const tombes = [];
  const revenus = [];
  t.voulues.forEach((v, i) => {
    if (t.resultats[i] === undefined) return;
    let s = sante.get(v.sonde);
    if (!s) sante.set(v.sonde, (s = santeNeuve()));
    const changement = observer(s, t.resultats[i], maintenant);
    if (changement === "chute") tombes.push(v.nom);
    else if (changement === "retour") revenus.push({ nom: v.nom, ms: t.resultats[i] });
  });
  // Un changement : l'alerte du widget d'origine. Plusieurs au même tour (réseau coupé) : une
  // seule alerte pour tous, Horizon n'en montrant qu'une toutes les 5 s.
  if (tombes.length === 1) annoncer(tombes[0] + " est hors ligne", "Injoignable deux fois de suite");
  else if (tombes.length > 1) annoncer(tombes.length + " serveurs sont hors ligne", tombes.join(", "));
  if (revenus.length === 1) annoncer(revenus[0].nom + " est de nouveau en ligne", "Répond en " + revenus[0].ms + " ms");
  else if (revenus.length > 1) annoncer(revenus.length + " serveurs sont de nouveau en ligne", revenus.map((r) => r.nom).join(", "));
  // Tout est reposé : une valeur qu'Horizon n'aurait pas gardée (interface pas encore prête)
  // se rattrape ici.
  poses.clear();
  horizon.instances().forEach(montrer);
  planifier();
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────

// Terminal SSH (`web` faux) ou interface web d'un hôte de l'exemplaire ; l'échec se lit dans
// le panneau.
function ouvrir(inst, id, web) {
  const c = (visibles.get(inst) || []).find((x) => x.id === id);
  let erreur = "";
  try {
    if (!c || (web ? c.url : c.ssh) === null) erreur = (c ? c.nom : id) + " : hôte inconnu";
    else if (web) horizon.open(c.url);
    else horizon.ssh.open(c.ssh);
  } catch (e) {
    erreur = c.nom + " : " + (e && e.message ? e.message : String(e));
  }
  erreurs.set(inst, erreur);
  poser(inst, "erreur", erreur);
}

horizon.ui.on("ssh", (inst, id) => ouvrir(inst, id, false));
horizon.ui.on("web", (inst, id) => ouvrir(inst, id, true));
// Aucun serveur : le clic sur le widget ouvre ses réglages.
horizon.ui.on("reglages", (inst) => horizon.settings.open(inst));

// Chaque seconde tant qu'un panneau est montré : « depuis … » tenu à jour. Le premier tic après
// un silence est l'ouverture du panneau : erreur effacée, sondage relancé si le dernier date.
horizon.ui.on("tic", (inst) => {
  if (absent || !visibles.has(inst)) return;
  const maintenant = Date.now();
  const ouverture = Math.abs(maintenant - (tics.get(inst) || 0)) > 2500;
  tics.set(inst, maintenant);
  if (ouverture) {
    erreurs.delete(inst);
    poses.delete(inst);
    if (Math.abs(maintenant - dernier) >= ECART) demander();
  }
  montrer(inst);
});

horizon.palette.on((cle) => {
  const a = actions.get(cle);
  if (!a) return;
  try {
    if (a.ssh) horizon.ssh.open(a.ssh);
    else horizon.open(a.url);
  } catch (e) {
    horizon.log.warn("palette :", cle, e && e.message ? e.message : String(e));
  }
});

// ── Ce qui change ───────────────────────────────────────────────────────────────────────────

horizon.settings.onChange(() => actualiser());
horizon.on("instances", () => actualiser());

// Session verrouillée ou écran éteint : pas de sondage ; au retour, tout de suite.
horizon.on("presence", (p) => {
  const avant = absent;
  absent = !!(p && p.away);
  if (avant && !absent) voulu = true;
  planifier();
});

// Lu au chargement puis à chaque changement du fichier (null : il n'existe pas).
horizon.files.watch(FICHIER, (contenu) => {
  ssh = lireSsh(typeof contenu === "string" ? contenu : "");
  pret = true;
  horizon.log.info("configuration ssh : " + ssh.length + " hôte(s)");
  actualiser();
});

// Hôtes ajoutés à la main montrés tout de suite ; le premier sondage part un quart de seconde
// plus tard, ~/.ssh/config et l'état de présence arrivés.
actualiser();
