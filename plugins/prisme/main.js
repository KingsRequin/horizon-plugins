// Prisme : état poussé par le moteur (au moins toutes les 2 s), commandes, et les signaux
// d'Horizon traduits en scènes : couleur de la pochette (set_accent), « Ne pas déranger »
// (scène focus tenue), Claude qui attend et fin du minuteur (scène « claude », ou « off »,
// un instant, puis la scène d'avant).
const NOMS = { idle: "Ambiance", video: "Ambilight", music: "Musique", off: "Éteint" };
const nom = (k) => NOMS[k] || (k ? k[0].toUpperCase() + k.slice(1) : "");

const prisme = horizon.connect("ws://127.0.0.1:28650");
let id = 0;
let etat = { connecte: false, scene: "", force: null, luminosite: 1, scenes: [] };
let accent = null; // couleur voulue [r, g, b] ou null
let envoyee; // dernière couleur envoyée
let signal = null; // signal en cours : { avant, scene }
let dnd = false;
let tenu = null; // focus tenu : { avant }

function commande(cmd, args) {
  prisme.send(Object.assign({ id: ++id, cmd }, args || {}));
}

function montrer() {
  const e = etat;
  const scenes = e.scenes.filter((s) => s !== "off");
  horizon.ui.set("connecte", e.connecte);
  horizon.ui.set("eteint", e.force === "off");
  horizon.ui.set("scene", nom(e.scene));
  horizon.ui.set("luminosite", e.luminosite);
  horizon.ui.set("scenes", scenes.map((s) => ({ cle: s, nom: nom(s), choisie: e.force === s })));
  horizon.palette.set(
    e.connecte
      ? [{ id: "", label: "Éclairage automatique", icon: "lightbulb" }].concat(
          scenes.map((s) => ({ id: s, label: "Éclairage : " + nom(s), icon: "lightbulbFill" })),
        )
      : [],
  );
}

function envoyerAccent() {
  const v = JSON.stringify(accent);
  if (etat.connecte && v !== envoyee) {
    envoyee = v;
    commande("set_accent", { rgb: accent });
  }
}

prisme.onState((s) => {
  if (s === "closed") {
    etat = { connecte: false, scene: "", force: null, luminosite: 1, scenes: [] };
    envoyee = undefined;
    signal = null;
    tenu = null;
    montrer();
  }
});

prisme.onMessage((texte) => {
  let m;
  try {
    m = JSON.parse(texte);
  } catch (e) {
    return;
  }
  if (m.ok === false) horizon.log.warn("Prisme :", texte);
  if (m.event !== "state") return;
  const d = (m.data && m.data.daemon) || {};
  const premier = !etat.connecte;
  etat = {
    connecte: true,
    scene: d.scene || "",
    force: d.override_scene == null ? null : d.override_scene,
    luminosite: typeof d.brightness === "number" ? d.brightness : 1,
    scenes: Array.isArray(d.scenes) ? d.scenes : [],
  };
  if (premier) envoyerAccent();
  synchroniserFocus();
  montrer();
});

// Signal : une scène forcée un instant (1,5 s), puis celle d'avant (si personne n'a changé).
function signaler() {
  if (!etat.connecte || !horizon.settings.get("signaux")) return;
  if (!signal && etat.force === "off") return; // lumières éteintes par l'utilisateur
  const scene = ["claude", "off"].find((s) => etat.scenes.includes(s));
  if (!scene) return;
  if (!signal) signal = { avant: etat.force, scene };
  commande("set_override", { scene });
  const ici = signal;
  const t = horizon.timer.every(1500, () => {
    horizon.timer.clear(t);
    if (signal !== ici) return;
    if (etat.force === ici.scene) commande("set_override", { scene: tenu ? "focus" : ici.avant });
    signal = null;
  });
}

// « Ne pas déranger » : scène focus tenue pendant toute sa durée.
function synchroniserFocus() {
  if (!etat.connecte) return;
  const voulu = dnd && horizon.settings.get("focus") && etat.scenes.includes("focus");
  if (voulu && tenu === null) {
    tenu = { avant: signal ? signal.avant : etat.force };
    if (!signal) commande("set_override", { scene: "focus" });
  } else if (!voulu && tenu !== null) {
    const avant = tenu.avant;
    tenu = null;
    if (signal) signal.avant = avant;
    else if (etat.force === "focus") commande("set_override", { scene: avant });
  }
}

horizon.on("accent", (a) => {
  const c = a && a.color;
  accent = c ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : null;
  envoyerAccent();
});
horizon.on("dnd", (d) => {
  dnd = !!(d && d.active && d.light);
  synchroniserFocus();
});
horizon.on("alert", (a) => {
  // `light` : signal lumineux voulu (réglage « Claude attend » d'Horizon).
  if (a && a.kind === "claude" && a.light !== false) signaler();
});
horizon.on("timer", () => signaler());
horizon.settings.onChange(() => synchroniserFocus());

// Commandes du panneau et de la palette.
horizon.ui.on("choisir", (inst, cle) => commande("set_override", { scene: cle || null }));
horizon.ui.on("basculer", () => commande("set_override", { scene: etat.force === "off" ? null : "off" }));
horizon.ui.on("lumiere", (inst, v) => commande("set_brightness", { value: Math.max(0, Math.min(1, v)) }));
horizon.ui.on("ouvrir", () => commande("open_window"));
horizon.palette.on((cle) => commande("set_override", { scene: cle || null }));

// Fermeture d'Horizon : Prisme reprend sa scène et sa palette.
horizon.on("unload", () => {
  if (!etat.connecte) return;
  if (signal && etat.force === signal.scene) commande("set_override", { scene: tenu ? tenu.avant : signal.avant });
  else if (tenu && etat.force === "focus") commande("set_override", { scene: tenu.avant });
  commande("set_accent", { rgb: null });
});

montrer();
