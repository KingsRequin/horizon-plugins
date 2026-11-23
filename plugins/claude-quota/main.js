// Quota Claude : quota de l'abonnement (session de 5 h, semaine, limites par modèle) lu à l'API
// d'Anthropic avec le jeton OAuth de Claude Code. Une lecture au chargement puis toutes les
// 5 minutes, au retour d'une absence et à l'ouverture du panneau (au plus une par minute). Le
// jeton est relu dans les identifiants de Claude Code à chaque lecture, envoyé seulement à cette
// adresse, jamais gardé, journalisé ni posé dans l'interface. Une lecture en échec garde le
// dernier quota connu et montre l'erreur.
const IDENTIFIANTS = "%USERPROFILE%/.claude/.credentials.json";
const ADRESSE = "https://api.anthropic.com/api/oauth/usage";
const BETA = "oauth-2025-04-20";
const MINUTE = 60000;
const HEURE = 60 * MINUTE;
const JOUR = 24 * HEURE;
const PERIODE = 5 * MINUTE;

let quota = null; // dernier quota lu (`lireUsage`) ; null : jamais reçu
let erreur = ""; // dernière erreur, sans jamais le jeton ; vide : aucune
let recuLe = 0; // heure de la dernière réponse exploitable
let essayeLe = 0; // heure de la dernière demande, réussie ou non
let absent = false; // session verrouillée ou écran éteint
let minuteurBarre = 0; // fait avancer les textes de la barre ; 0 : pas encore lancé

// --- Réponse de l'API ---

// Lecture tolérante : un champ absent ou d'un autre type vaut « rien », jamais une exception.
const objet = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {});
const liste = (v) => (Array.isArray(v) ? v : []);
const nombre = (v) => (typeof v === "number" ? v : null);
const chaine = (v) => (typeof v === "string" ? v : null);

// Quota tiré de la réponse JSON. Une fenêtre absente (`null`) est omise ; une réponse sans
// aucune fenêtre exploitable est une erreur (texte affichable). `fenetres` : `genre` vaut
// `five_hour`, `seven_day` ou `model` (limite hebdomadaire propre à un modèle), `gravite` est
// le niveau donné par l'API (`normal`, `warning`, `critical`…), `part` la part de la semaine
// générale consommée par le modèle et celle qui lui est allouée.
function lireUsage(json) {
  let v;
  try {
    v = objet(JSON.parse(json));
  } catch (e) {
    throw new Error("réponse illisible");
  }
  const limites = liste(v.limits);
  // Niveau de la limite générale de la semaine (la fenêtre `seven_day` n'en porte pas).
  const graviteSemaine = chaine(objet(limites.find((l) => objet(l).kind === "weekly_all")).severity);
  const fenetres = [];
  for (const [cle, nom] of [["five_hour", "5 h"], ["seven_day", "Semaine"]]) {
    const w = v[cle];
    if (w === null || w === undefined) continue;
    const pct = nombre(objet(w).utilization);
    if (pct === null) throw new Error(cle + ".utilization manquant");
    fenetres.push({
      nom,
      genre: cle,
      pct,
      remise: chaine(objet(w).resets_at),
      gravite: cle === "seven_day" ? graviteSemaine : null,
      part: null,
    });
  }
  // Limites propres à un modèle (Fable, Opus…), toutes : `is_active` dit seulement si c'est la
  // limite qui bloque en ce moment, pas si elle est consommée.
  const parts = liste(v.weekly_scoped_shares);
  limites.forEach((brut, i) => {
    const l = objet(brut);
    const nom = chaine(objet(objet(l.scope).model).display_name);
    const pct = nombre(l.percent);
    if (l.kind !== "weekly_scoped" || nom === null || pct === null) return;
    const p = objet(parts.find((s) => objet(s).limit_index === i));
    const utilise = nombre(p.used_percent_of_weekly);
    const alloue = nombre(p.allowance_percent_of_weekly);
    fenetres.push({
      nom,
      genre: "model",
      pct,
      remise: chaine(l.resets_at),
      gravite: chaine(l.severity),
      part: utilise !== null && alloue !== null ? { utilise, alloue } : null,
    });
  });
  if (fenetres.length === 0) throw new Error("aucune fenêtre d’usage dans la réponse");
  const semaine = objet(v.seven_day_breakdown);
  const repartition = [];
  for (const brut of liste(semaine.rows)) {
    const nom = chaine(objet(brut).display_name);
    const pct = nombre(objet(brut).percent);
    if (nom !== null && pct !== null) repartition.push({ nom, pct });
  }
  return {
    fenetres,
    // Début de la fenêtre hebdomadaire : sert à calculer le rythme.
    debutSemaine: chaine(semaine.window_started_at),
    repartition,
    credits: objet(v.extra_usage).is_enabled === true,
  };
}

// Jeton OAuth des identifiants de Claude Code ; l'erreur est un texte court, sans rien du fichier.
function lireJeton(identifiants) {
  let v;
  try {
    v = JSON.parse(identifiants);
  } catch (e) {
    throw new Error("identifiants illisibles");
  }
  const jeton = objet(objet(v).claudeAiOauth).accessToken;
  if (typeof jeton !== "string" || jeton === "") throw new Error("jeton absent");
  return jeton;
}

// --- Calculs ---

// Niveau d'une limite : celui de l'API d'abord, sinon le pourcentage ; 0 accent, 1 attention,
// 2 alerte.
function niveau(f) {
  if (f.gravite === "critical" || f.gravite === "exceeded") return 2;
  if (f.gravite === "warning") return 1;
  return f.pct >= 90 ? 2 : f.pct >= 70 ? 1 : 0;
}

// Limites montrées dans la barre : les générales toujours, celle d'un modèle seulement quand
// elle approche de son plafond.
function fenetresBarre(fenetres) {
  return fenetres.filter((f) => f.genre !== "model" || f.pct >= 80);
}

// Date ISO 8601 (avec son décalage, comme les donne l'API) en ms Unix ; null si elle ne se lit
// pas. Lue ici plutôt que par `Date.parse`, qui ne promet rien au-delà de trois décimales.
const ISO = /^(\d{4})-(\d\d)-(\d\d)[Tt ](\d\d):(\d\d):(\d\d)(?:\.(\d+))?(?:[Zz]|([+-])(\d\d):(\d\d))$/;
function instant(iso) {
  const m = typeof iso === "string" ? ISO.exec(iso) : null;
  if (!m) return null;
  const [an, mois, jour, h, min, s] = m.slice(1, 7).map(Number);
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31 || h > 23 || min > 59 || s > 60) return null;
  const ms = m[7] ? Number((m[7] + "00").slice(0, 3)) : 0;
  const decalage = m[8] ? (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) : 0;
  const t = Date.UTC(an, mois - 1, jour, h, min, s, ms) - decalage * MINUTE;
  return t >= 0 ? t : null;
}

// Rythme d'une limite : part du temps écoulée (0 à 100) et instant où elle serait atteinte au
// rythme moyen (`plafond` null : elle tient jusqu'à la remise à zéro). null sans dates
// exploitables, ou hors de la fenêtre.
function rythme(f, debutSemaine, maintenant) {
  const fin = instant(f.remise);
  if (fin === null) return null;
  // Début de la fenêtre : 5 h avant la remise à zéro, ou le début de la semaine.
  const semaine = instant(debutSemaine);
  const debut = f.genre === "five_hour" ? fin - 5 * HEURE : semaine !== null ? semaine : fin - 7 * JOUR;
  if (debut < 0 || fin <= debut || maintenant <= debut || maintenant >= fin) return null;
  const ecoule = maintenant - debut;
  const ecoulePct = (ecoule / (fin - debut)) * 100;
  if (f.pct >= 100) return { ecoulePct, plafond: maintenant };
  if (f.pct <= 0) return { ecoulePct, plafond: null };
  const atteint = debut + (ecoule * 100) / f.pct;
  return { ecoulePct, plafond: atteint < fin ? Math.floor(atteint) : null };
}

// --- Durées, dates et textes ---

const arrondi = (v) => Math.floor(v + 0.5);
const pourcent = (v) => arrondi(v) + " %";
const deux = (n) => String(n).padStart(2, "0");

// Temps écoulé : « à l’instant », « il y a 5 min », « il y a 3 h », « il y a 2 j ».
function ilYA(le, maintenant) {
  const s = Math.floor(Math.max(0, maintenant - le) / 1000);
  if (s < 60) return "à l’instant";
  if (s < 3600) return "il y a " + Math.floor(s / 60) + " min";
  if (s < 86400) return "il y a " + Math.floor(s / 3600) + " h";
  return "il y a " + Math.floor(s / 86400) + " j";
}

// Temps restant : « dans 45 min », « dans 3 h 05 », « dans 4 j 15 h ».
function dans(le, maintenant) {
  const s = Math.max(0, le - maintenant) / 1000;
  if (s < 3600) return "dans " + Math.max(1, Math.ceil(s / 60)) + " min";
  const e = Math.floor(s);
  if (s < 86400) return "dans " + Math.floor(e / 3600) + " h " + deux(Math.floor((e % 3600) / 60));
  return "dans " + Math.floor(e / 86400) + " j " + Math.floor((e % 86400) / 3600) + " h";
}

const JOURS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
// Rang du jour d'une date, en heure locale : sert à reconnaître aujourd'hui et demain.
const rangDuJour = (d) => Math.floor((d.getTime() - d.getTimezoneOffset() * MINUTE) / JOUR);

// « lun. 16 nov. à 16:00 », « aujourd’hui à 16:00 », « demain à 16:00 » (heure locale).
function quand(le, maintenant) {
  const d = new Date(le);
  const ecart = rangDuJour(d) - rangDuJour(new Date(maintenant));
  const jour =
    ecart === 0
      ? "aujourd’hui"
      : ecart === 1
        ? "demain"
        : JOURS[(d.getDay() + 6) % 7] + " " + d.getDate() + " " + MOIS[d.getMonth()];
  return jour + " à " + deux(d.getHours()) + ":" + deux(d.getMinutes());
}

// Prochaine remise à zéro des limites montrées dans la barre : « remise à zéro dans 4 j 15 h »
// (vide : aucune à venir).
function prochaineRemise(fenetres, maintenant) {
  const futures = fenetresBarre(fenetres)
    .map((f) => instant(f.remise))
    .filter((t) => t !== null && t > maintenant);
  return futures.length ? "remise à zéro " + dans(Math.min(...futures), maintenant) : "";
}

function titre(f) {
  if (f.genre === "seven_day") return "Semaine · tous modèles";
  return f.genre === "five_hour" ? "Session de 5 h" : f.nom;
}

function ligneRythme(f, debutSemaine, maintenant) {
  const r = rythme(f, debutSemaine, maintenant);
  if (!r) return "";
  const debut = pourcent(f.pct) + " utilisés pour " + pourcent(r.ecoulePct) + " du temps écoulé";
  if (r.plafond === null) return debut + " · tient jusqu’à la remise à zéro";
  if (r.plafond <= maintenant) return debut + " · plafond atteint";
  return debut + " · plafond vers " + quand(r.plafond, maintenant);
}

// Une limite du panneau (struct `Limite` de panel.slint).
function limite(f, debutSemaine, maintenant) {
  const fin = instant(f.remise);
  return {
    titre: titre(f),
    modele: f.genre === "model",
    pct: pourcent(f.pct),
    utilise: f.pct / 100,
    niveau: niveau(f),
    remise: fin === null ? "" : "Remise à zéro " + quand(fin, maintenant) + " · " + dans(fin, maintenant),
    part: f.part
      ? pourcent(f.part.utilise) + " de la semaine générale consommés sur " + pourcent(f.part.alloue) + " alloués"
      : "",
    rythme: ligneRythme(f, debutSemaine, maintenant),
  };
}

// --- Affichage ---

// Pose tout l'état sur la barre et le panneau. Les textes dépendent de l'heure : rappelé chaque
// minute (barre) et par le panneau montré ; une valeur inchangée ne coûte rien.
function montrer() {
  const maintenant = Date.now();
  const fenetres = quota ? quota.fenetres : [];
  const repartition = quota ? quota.repartition : [];

  horizon.ui.set("connu", quota !== null || erreur !== "");
  horizon.ui.set("illisible", quota === null);
  horizon.ui.set("perime", quota !== null && erreur !== "");
  horizon.ui.set(
    "jauges",
    fenetresBarre(fenetres).map((f) => ({ nom: f.nom, valeur: f.pct / 100, texte: pourcent(f.pct), niveau: niveau(f) })),
  );
  horizon.ui.set("remise", prochaineRemise(fenetres, maintenant));

  horizon.ui.set("maj", quota ? "mis à jour " + ilYA(recuLe, maintenant) : "");
  horizon.ui.set("erreur", erreur);
  horizon.ui.set("a-quota", quota !== null);
  horizon.ui.set("limites", fenetres.map((f) => limite(f, quota.debutSemaine, maintenant)));
  horizon.ui.set("a-repartition", repartition.some((r) => r.pct > 0));
  horizon.ui.set(
    "repartition",
    repartition.map((r) => ({
      nom: r.nom === "Other" ? "Autre" : r.nom,
      pct: pourcent(r.pct),
      valeur: r.pct / 100,
      nulle: r.pct <= 0,
    })),
  );
  horizon.ui.set(
    "credits",
    quota
      ? "Crédits supplémentaires " +
          (quota.credits ? "activés : l’usage continue au-delà des limites" : "désactivés")
      : "",
  );
}

// --- Lecture ---

// En-têtes de la demande. Le jeton, relu à chaque fois, n'existe que dans cet objet.
function enTetes() {
  const identifiants = horizon.files.read(IDENTIFIANTS);
  if (typeof identifiants !== "string") throw new Error("Claude Code n’est pas connecté");
  return { Authorization: "Bearer " + lireJeton(identifiants), "anthropic-beta": BETA };
}

// Interroge l'API : `{ quota }` ou `{ erreur }` (texte court affichable), jamais d'exception.
async function demander() {
  let attente;
  try {
    attente = horizon.http.get(ADRESSE, { headers: enTetes() });
  } catch (e) {
    return { erreur: e.message };
  }
  let reponse;
  try {
    reponse = await attente;
  } catch (e) {
    // Horizon rejette avec un texte : serveur injoignable, ou réponse illisible ou trop grosse.
    return { erreur: String(e).includes("illisible") ? "réponse illisible" : "API injoignable" };
  }
  if (reponse.status === 401) return { erreur: "jeton expiré : relance Claude Code" };
  if (reponse.status < 200 || reponse.status > 299) return { erreur: "réponse " + reponse.status + " de l’API" };
  try {
    return { quota: lireUsage(reponse.text) };
  } catch (e) {
    return { erreur: e.message };
  }
}

async function lire() {
  essayeLe = Date.now();
  const r = await demander();
  if (r.quota) {
    quota = r.quota;
    erreur = "";
    recuLe = Date.now();
    // « dans 3 h 05 » avance chaque minute, dès qu'il y a un quota à montrer.
    if (!minuteurBarre) minuteurBarre = horizon.timer.every(MINUTE, montrer);
  } else {
    // Le dernier quota connu reste affiché, estompé.
    erreur = r.erreur;
    horizon.log.info("lecture du quota impossible : " + erreur);
  }
  montrer();
}

// Au plus une demande par minute hors du rythme régulier (retour d'absence, panneau rouvert).
function lireSiAncien() {
  if (Date.now() - essayeLe >= MINUTE) lire();
}

horizon.on("presence", (p) => {
  const retour = absent && !(p && p.away);
  absent = !!(p && p.away);
  if (retour) lireSiAncien();
});

// Panneau : `ouverture` au premier tic après sa création, puis un tic toutes les 30 s pour les
// textes relatifs (« mis à jour il y a… », rythme).
horizon.ui.on("tic", (inst, ouverture) => {
  if (ouverture) lireSiAncien();
  montrer();
});

horizon.timer.every(PERIODE, () => {
  lire();
});

montrer();
lire();
