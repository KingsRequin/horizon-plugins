# Bibliothèque de plugins d'Horizon

Les plugins proposés dans [Horizon](https://github.com/KingsRequin/horizon) (page *Plugins* des
réglages) : chacun s'installe d'un clic, se met à jour tout seul et ne joint que ce qu'il a
déclaré — et que tu as accepté.

> L'API des plugins est en préversion : elle peut encore changer. `"api"` est le niveau dont un
> plugin a besoin (`0` : le socle ; `1` : dossier de l'utilisateur, sonde d'une machine, terminal
> SSH, listes de réglages, à partir d'Horizon 0.7). Une version d'Horizon plus ancienne ne
> propose pas un plugin d'un niveau qu'elle ne connaît pas.

## Plugins

| Plugin | Ce qu'il fait | Demande |
|---|---|---|
| [Essaim (curseur)](plugins/essaim) | pause d'[Essaim](https://github.com/KingsRequin/essaim) d'un clic, choix du preset, ouverture de ses réglages (presets : Essaim 0.13 ou plus récent) | connexion à Essaim (port 28670) |
| [Quota Claude](plugins/claude-quota) | quota de l'abonnement Claude : session de 5 h, semaine, limites par modèle, rythme et répartition | lecture de la connexion de Claude Code, API d'Anthropic, verrouillage et veille |
| [Serveurs (homelab)](plugins/serveurs) | état des machines de `~/.ssh/config` et de celles ajoutées à la main, alerte à la chute et au retour, terminal SSH, interface web | lecture de `~/.ssh/config`, test des machines, terminal SSH, liens web, verrouillage et veille |

## Proposer un plugin

1. Écris-le avec [PLUGINS.md](https://github.com/KingsRequin/horizon/blob/master/docs/PLUGINS.md)
   (le guide, prêt à donner à une IA) ; vérifie-le avec `horizon.exe --check-plugin <dossier>`.
2. Ajoute son dossier dans `plugins/<id>/` et lance `python scripts/build.py` (paquet dans
   `dist/`, entrée dans `index.json`). Un `test.js` à côté de `main.js` (Node, sans dépendance :
   il charge le script avec un faux objet `horizon`) est lancé à chaque vérification ; il n'est
   pas livré dans le paquet.
3. Ouvre une pull request. Chaque plugin est relu avant d'être accepté : ses permissions
   doivent être justifiées par ce qu'il fait.

Une nouvelle version : change `version` dans son `plugin.json`, relance `scripts/build.py`.

## Comment Horizon s'en sert

Horizon lit `index.json` (au démarrage puis toutes les 6 heures), télécharge le paquet
`dist/<id>-<version>.json`, vérifie sa taille et son empreinte SHA-256, refuse tout chemin qui
sortirait du dossier du plugin, puis le met en place d'un coup. Un plugin qui demande une
nouvelle permission redemande l'accord.

## Licence

Chaque plugin a sa licence (MIT sauf mention contraire dans son dossier).
