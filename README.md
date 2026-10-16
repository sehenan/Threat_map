<img src="splunk_app/assets/static/icon-512.png" alt="Icône de l'appli" width="96" align="right">

# SOC Attack Wall

Mur des attaques pour salle SOC, hébergé dans **Splunk** (Cloud ou Enterprise) :
carte des attaques en direct, compteurs du jour, flux des derniers événements,
équipe de permanence, et relecture de n'importe quel moment de la journée.

![Aperçu du mur](docs/apercu.png)

- **Sans serveur ni jeton** : une appli Splunk. Des recherches planifiées
  calculent, le tableau de bord affiche. Un calcul toutes les 5 minutes, quel
  que soit le nombre d'écrans.
- **Démarre sans données** : l'appli est livrée avec 5 sources de démonstration
  (générées par `makeresults`). Installez-la, le mur s'anime tout de suite.
  Remplacez ensuite les sources, une par une, par les vôtres.
- **Adaptable par configuration** : titre, logo, couleurs, sites protégés,
  sources et leurs recherches SPL tiennent dans un seul fichier,
  `config/wall.json`.
- **Des modèles de sources** pour des produits courants (WAF Ubika, IPS
  Check Point, Proofpoint, échecs de connexion Microsoft 365, VPN F5 APM),
  chacun avec son jeu de test.
- **Un tableau de bord de configuration** : vérifications après installation,
  sources d'attaque (ajout, validation, modification et suppression, sans
  reconstruire l'appli), analystes et photos, planning, état des recherches,
  dépannage.

Interface en français ou en anglais (`"language": "en"`, voir
[README.en.md](README.en.md)).

## Démarrage rapide

```bash
git clone <ce dépôt> && cd soc-attack-wall
python3 build.py                 # config/wall.example.json -> dist/soc_attack_wall-<version>.tgz
xdg-open dist/apercu.html        # la page seule, en simulation, sans Splunk
```

1. Installez `dist/soc_attack_wall-<version>.tgz` dans Splunk
   (*Applications > Gérer les applications > Installer depuis un fichier*).
2. Ouvrez **Configuration** dans l'appli et suivez la section *Démarrage*.
3. Attendez 10 minutes (deux passages des recherches), puis ouvrez **Mur**.

Le détail est dans [docs/INSTALL.md](docs/INSTALL.md).

## L'adapter à votre SOC

```bash
cp config/wall.example.json config/wall.json    # ignoré par git
$EDITOR config/wall.json                         # titre, sites, sources
python3 build.py --verifier                      # contrôle de la configuration
python3 build.py                                 # nouveau paquet
```

Une source, c'est une recherche SPL qui fournit 7 champs : `_time, src_ip, dc,
severity, signature, dest_host, action`. Le reste (géolocalisation,
coordonnées des sites, normalisation) est ajouté par `build.py`. Voir
[docs/ADAPTER.md](docs/ADAPTER.md) et [docs/CONTRAT.md](docs/CONTRAT.md).

## Tests

```bash
python3 -m unittest discover -s tests -v          # hors ligne, sans Splunk

export SPLUNK_URL=https://votre-splunk:8089 SPLUNK_TOKEN=...
python3 tests/splunk/run.py --sans-appli          # jeux de tests SPL (lecture seule)
```

Les jeux de tests SPL rejouent chaque modèle de source sur des événements
fictifs (`templates/sources/*/fixture.spl`) et comparent le résultat à
`attendu.json`. Ils vérifient aussi vos propres sources contre le contrat. Ils
ne lisent aucun index et n'écrivent rien.

## Organisation du dépôt

| Chemin | Contenu |
|---|---|
| `config/wall.example.json` | configuration de démonstration, point de départ de la vôtre |
| `config/sources/demo/` | sources de démonstration (générateurs `makeresults`) |
| `templates/sources/` | modèles de sources par produit, avec jeux de test |
| `web/index.html` | la page du mur (s'ouvre aussi seule, en simulation) |
| `splunk_app/src/` | lecture des recherches, tableau de bord de configuration |
| `splunk_app/assets/` | polices, lookups de démonstration |
| `build.py` | construit l'appli et l'aperçu |
| `tests/` | tests hors ligne et jeux de tests SPL |
| `docs/` | installation, adaptation, contrat, architecture, dépannage |

## Licences

Code sous licence MIT (voir [LICENSE](LICENSE)).
Police Barlow Semi Condensed : SIL Open Font License 1.1
(`splunk_app/assets/fonts/OFL-Barlow.txt`). Drapeaux : Twemoji,
CC-BY 4.0, © Twitter, Inc. et contributeurs. Frontières : Natural Earth
(domaine public).
