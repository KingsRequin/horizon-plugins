// Essaim (curseur animé) : état poussé par l'appli (à chaque changement et au moins toutes les
// 2 s), pause, presets. Les presets demandent Essaim 0.13 (`preset` dans l'état) ; avec une
// version d'avant, il reste la pause et l'ouverture de config.toml.
const essaim = horizon.connect("ws://127.0.0.1:28670");
let id = 0;
let etat = null; // dernier état reçu ; null : Essaim absent
let presets = []; // [{ name, builtin, active }]
let demande = 0; // identifiant de la dernière demande de liste
let demandeLe = 0;

function commande(cmd, args) {
  essaim.send(Object.assign({ id: ++id, cmd }, args || {}));
  return id;
}

const avecPresets = () => !!etat && "preset" in etat;

function lister() {
  if (!avecPresets()) return;
  demande = commande("list_presets");
  demandeLe = Date.now();
}

// 1 en pause, 2 en veille (plein écran), 3 actif ; la pause l'emporte.
function code() {
  if (!etat) return 0;
  if (etat.paused) return 1;
  return etat.fullscreen || !etat.active ? 2 : 3;
}

function montrer() {
  const c = code();
  horizon.ui.set("connecte", c !== 0);
  horizon.ui.set("etat", c);
  horizon.ui.set("etat-texte", ["", "En pause", "En veille (plein écran)", "Actif"][c]);
  horizon.ui.set(
    "detail",
    etat
      ? (etat.gpu ? "Dessin par la carte graphique" : "Dessin par le processeur (secours)") +
          (etat.prisme ? " · couleur synchronisée sur Prisme" : "")
      : "",
  );
  horizon.ui.set("fenetre", avecPresets());
  horizon.ui.set("presets", presets.map((p) => ({ nom: p.name, fourni: !!p.builtin, actif: !!p.active })));
  horizon.palette.set(
    c === 0
      ? []
      : [{ id: "pause", label: c === 1 ? "Reprendre" : "Mettre en pause", icon: c === 1 ? "play" : "pause" }].concat(
          presets.slice(0, 48).map((p) => ({ id: "preset:" + p.name, label: "Preset " + p.name, icon: "atom" })),
        ),
  );
}

function basculer() {
  if (etat) commande("set_paused", { paused: !etat.paused });
}

function choisir(nom) {
  if (!etat) return;
  commande("apply_preset", { name: nom });
  // Coche tout de suite ; Essaim confirme par son état (la liste est alors redemandée).
  presets = presets.map((p) => Object.assign({}, p, { active: p.name === nom }));
  montrer();
}

essaim.onState((s) => {
  if (s === "closed") {
    etat = null;
    presets = [];
    montrer();
  }
});

essaim.onMessage((texte) => {
  let m;
  try {
    m = JSON.parse(texte);
  } catch (e) {
    return;
  }
  if (m.event === "state") {
    const avant = etat;
    etat = m.data || {};
    if (!avant || avant.preset !== etat.preset) lister();
    montrer();
    return;
  }
  if (m.ok === false) {
    horizon.log.warn("Essaim :", texte);
    return;
  }
  if (m.id === demande && Array.isArray(m.data)) {
    presets = m.data.filter((p) => p && typeof p.name === "string");
    montrer();
  }
});

horizon.ui.on("basculer", basculer);
horizon.ui.on("choisir", (inst, nom) => choisir(nom));
horizon.ui.on("ouvrir", () => {
  if (etat) commande(avecPresets() ? "open_settings" : "open_config");
});
// Panneau montré : un preset enregistré ou supprimé dans Essaim se voit dans les 5 s.
horizon.ui.on("tic", () => {
  if (Date.now() - demandeLe >= 5000) lister();
});
horizon.palette.on((cle) => {
  if (cle === "pause") basculer();
  else if (cle.startsWith("preset:")) choisir(cle.slice(7));
});

// Essaim ferme un client muet depuis 60 s : une demande toutes les 25 s garde la connexion.
horizon.timer.every(25000, () => {
  if (!etat) return;
  if (avecPresets()) lister();
  else commande("get_state");
});

montrer();
