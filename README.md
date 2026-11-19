# Bibliothèque de plugins d'Horizon

Les plugins proposés dans [Horizon](https://github.com/KingsRequin/horizon) (page *Plugins* des
réglages) : chacun s'installe d'un clic, se met à jour tout seul et ne joint que ce qu'il a
déclaré — et que tu as accepté.

> L'API des plugins est en préversion (`"api": 0`) : elle sera figée en `1` à l'ouverture de la
> bibliothèque.

## Plugins

| Plugin | Ce qu'il fait | Demande |
|---|---|---|
| [Éclairage (Prisme)](plugins/prisme) | scène et luminosité de Prisme ; pochette, « Ne pas déranger », Claude et minuteur sur les LED | connexion à Prisme (port 28650), événements d'Horizon |
| [Batteries (SharkApp)](plugins/sharkapp) | batteries du téléphone et de la montre, alerte batterie faible, appel dans l'îlot | lecture des fichiers de l'agent SharkApp |

## Proposer un plugin

1. Écris-le avec [PLUGINS.md](https://github.com/KingsRequin/horizon/blob/master/docs/PLUGINS.md)
   (le guide, prêt à donner à une IA) ; vérifie-le avec `horizon.exe --check-plugin <dossier>`.
2. Ajoute son dossier dans `plugins/<id>/` et lance `python scripts/build.py` (paquet dans
   `dist/`, entrée dans `index.json`).
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
