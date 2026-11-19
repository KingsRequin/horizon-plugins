// Agent SharkApp : batteries (batteries.json) et appels (phone.json), relus quand ils changent.
const BATTERIES = "%LOCALAPPDATA%/KingsHub/batteries.json";
const TELEPHONE = "%LOCALAPPDATA%/KingsHub/phone.json";
const ANCIENNE_MS = 2 * 3600 * 1000; // mesure de plus de 2 h : atténuée
const APPEL_PERIME_MS = 2 * 60 * 1000; // fichier d'appel plus vieux : plus d'appel
const REARME = 5; // l'alerte revient quand la batterie remonte de 5 points

let mesures = { phone: null, watch: null };
const alerte = { phone: false, watch: false }; // alerte déjà donnée pour cette décharge
let appel = null;

function lire(texte) {
  if (!texte) return null;
  try {
    return JSON.parse(texte.replace(/^﻿/, ""));
  } catch (e) {
    horizon.log.warn("fichier illisible :", String(e));
    return null;
  }
}

function seuil() {
  const s = horizon.settings.get("seuil");
  return typeof s === "number" ? s : 15;
}

function montrerBatteries() {
  const maintenant = Date.now();
  const liste = [];
  for (const [cle, icone] of [["phone", "deviceMobile"], ["watch", "watch"]]) {
    const b = mesures[cle];
    if (!b) continue;
    const s = seuil();
    liste.push({
      icone,
      pourcent: Math.round(b.percent) + " %",
      charge: b.charging,
      faible: s > 0 && b.percent <= s && !b.charging,
      ancienne: maintenant - b.at > ANCIENNE_MS,
    });
  }
  horizon.ui.set("batteries", liste);
}

function surveillerAlertes() {
  const s = seuil();
  for (const [cle, nom] of [["phone", "Téléphone"], ["watch", "Montre"]]) {
    const b = mesures[cle];
    if (!b) continue;
    if (b.charging || b.percent >= s + REARME) {
      alerte[cle] = false;
    } else if (s > 0 && b.percent <= s && !alerte[cle] && Date.now() - b.at <= ANCIENNE_MS) {
      alerte[cle] = true;
      horizon.alert({ title: "Batterie faible", body: (b.name || nom) + " : " + Math.round(b.percent) + " %", icon: "batteryFull" });
    }
  }
}

function batterie(r) {
  if (!r || typeof r.percent !== "number") return null;
  const at = Date.parse(r.at);
  return { name: (r.name || "").trim(), percent: Math.max(0, Math.min(100, r.percent)), charging: !!r.charging, at: isNaN(at) ? 0 : at };
}

horizon.files.watch(BATTERIES, (texte) => {
  const f = lire(texte) || {};
  mesures = { phone: batterie(f.phone), watch: batterie(f.watch) };
  montrerBatteries();
  surveillerAlertes();
});

function montrerAppel() {
  const f = appel;
  const perime = !f || f.state === "idle" || Date.now() - (f.updated_ms || 0) > APPEL_PERIME_MS;
  if (perime || !horizon.settings.get("appels")) {
    horizon.island.hide("appel");
    return;
  }
  const nom = [f.name, f.number].map((s) => (s || "").trim()).find((s) => s) || "Appel";
  const depuis = f.since_ms > 0 ? f.since_ms : f.updated_ms;
  if (f.state === "ringing") {
    horizon.island.show({ id: "appel", icon: "phoneIncoming", title: nom, subtitle: "Appel entrant…", severity: "attention" });
  } else if (f.state === "active") {
    horizon.island.show({ id: "appel", icon: "phoneCall", title: nom, subtitle: "En appel", since: depuis });
  } else {
    horizon.island.show({ id: "appel", icon: "phoneDisconnect", title: nom, subtitle: "Appel terminé" });
  }
}

horizon.files.watch(TELEPHONE, (texte) => {
  appel = lire(texte);
  montrerAppel();
});

// Mesures qui vieillissent et appel qui se périme sans que les fichiers changent.
horizon.timer.every(30 * 1000, () => {
  montrerBatteries();
  montrerAppel();
});
horizon.settings.onChange(() => {
  montrerBatteries();
  montrerAppel();
});
