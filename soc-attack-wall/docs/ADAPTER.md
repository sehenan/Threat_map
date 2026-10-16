# Adapter le mur à votre SOC

Tout se règle dans `config/wall.json`. Partez de la configuration d'exemple :

```bash
cp config/wall.example.json config/wall.json
```

`config/wall.json` et `config/local/` sont ignorés par git. Vous pouvez y
garder vos recherches, votre logo et vos photos sans risque de les publier.

## Langue

```json
"language": "fr"
```

`"fr"` (défaut) ou `"en"`. En anglais, le mur est à l'adresse `.../wall` au
lieu de `.../mur`. Point de départ anglais : `config/wall.example.en.json`.
Les traductions sont dans `i18n/en.json` ; ajouter une langue, c'est ajouter
`i18n/<langue>.json` et sa locale dans `i18n.py`.

## Identité

```json
"app":  { "id": "soc_attack_wall", "label": "SOC Attack Wall", "version": "1.0.0",
          "author": "Mon SOC", "roles_write": ["admin", "sc_admin", "soc_analyst"],
          "roles_config": ["*"] },
"page": { "title": "SOC", "subtitle": "Attack Wall", "logo": "local/logo.png",
          "accent": "#7fbc2a", "map_home": { "lon": 6, "lat": 25, "zoom": 1.5 } }
```

- `check_for_updates` : `true` (défaut) pour une appli publiée sur
  Splunkbase, qui refuse le paquet sinon ; `false` pour une version privée de
  votre SOC (AppInspect le recommande alors, sous forme d'avertissement).
- `roles_write` : qui peut modifier les analystes et le planning.
- `roles_config` : qui voit la page de configuration, vue d'accueil de
  l'appli (défaut `["*"]` : tout le monde ; les modifications restent
  réservées à `roles_write` et aux admins). Si vous la restreignez, les
  comptes exclus doivent ouvrir le mur par son adresse directe (`.../mur`).
- `logo` : PNG, SVG ou JPG, chemin relatif au fichier de configuration. Il est
  intégré à la page.
- `accent` : couleur réservée à vos sites sur la carte. Évitez le rouge,
  l'orange et le jaune, déjà pris par les sévérités.
- `map_home` : cadrage par défaut de la carte. La touche `R` y revient.

## Sites protégés

```json
"sites": [
  { "id": "DC1",   "label": "Datacenter", "lat": 48.85, "lon": 2.35, "label_dir": [-1, 1.1] },
  { "id": "CLOUD", "label": "Cloud",      "lat": 50.11, "lon": 8.68, "label_dir": [1, -1.1] }
],
"default_site": "DC1"
```

- Les attaques convergent vers ces points.
- `label_dir` oriente l'étiquette : `[-1, 1]` en bas à gauche, `[1, -1]` en
  haut à droite. C'est utile quand deux sites sont proches.
- Vos recherches désignent le site par son `id`, dans le champ `dc`.

Sans reconstruire l'appli : section **Sites protégés** de la page de
configuration (rôles `admin`, `sc_admin`). Identifiant, nom, latitude,
longitude et position de l'étiquette ; le site apparaît sur le mur dans les
10 minutes. Les sites de `config/wall.json` y sont listés en lecture seule ;
il en faut au moins un, le site par défaut.

## Sources

```json
{ "id": "waf", "label": "WAF", "color": "#00a7eb", "search_file": "local/sources/waf.spl" }
```

| Clé | Rôle |
|---|---|
| `id` | nom court (minuscules). La recherche planifiée s'appelle `wall_<id>` |
| `label` | affiché sur le mur. C'est aussi la valeur de `source_tech` |
| `color` | couleur de la source (évitez rouge, orange, jaune et l'accent) |
| `search_file` | la recherche SPL, voir [CONTRAT.md](CONTRAT.md) |
| `priority` | `true` pour une source rare mais importante (un IDS, par exemple) : ses alertes sont épinglées en tête du flux pendant 30 min et tracées en premier |
| `lookback_minutes` | pour recoller des journaux étalés dans le temps (voir le contrat) |
| `demo_weight` | poids de la source dans la simulation (`dist/apercu.html`) |

Changer de source en cours de route :

1. Copiez un modèle de `templates/sources/`, ou écrivez votre recherche.
2. Testez-la dans *Rechercher* sur 5 minutes. Elle doit rendre les champs du
   contrat.
3. Remplacez `search_file` de la source de démonstration correspondante.
4. `python3 build.py`, puis réinstallez le paquet.
5. Dans la page de configuration, « Valider » sur la source.

Retirer une source de démonstration : enlevez-la de `sources`. Sa recherche
disparaît avec la réinstallation.

## Ajouter ou retirer une source sans reconstruire l'appli

Section **Sources d'attaque** de la page de configuration (rôles `admin`,
`sc_admin`) :

- **Ajouter une source** :
  1. Partez d'un modèle, ou collez votre recherche.
  2. Choisissez un identifiant, un libellé, une couleur et, au besoin, un
     délai « regarder en arrière ».
  3. « Valider sur la dernière heure » contrôle le contrat de champs sur vos
     données.
  4. À l'enregistrement, la page crée la recherche planifiée `wall_<id>`,
     avec la même normalisation que `build.py`. La source apparaît sur le mur
     à son premier passage, dans les 5 à 10 minutes.
- **Modifier** une source ajoutée : libellé, couleur, recherche, délai.
- **Désactiver / Activer** : n'importe quelle source, y compris celles de la
  configuration.
- **Supprimer** une source ajoutée : sa recherche planifiée et son entrée
  dans le registre. Ses attaques déjà comptées aujourd'hui restent dans le
  cumul et la relecture.

Les sources de `config/wall.json` font partie du paquet : on ne peut que les
désactiver depuis la page. Pour les retirer, enlevez-les de la configuration,
reconstruisez et réinstallez.

Une source ajoutée depuis la page vit dans Splunk (recherche planifiée et KV
store `wall_sources`), pas dans ce dépôt. Pour la conserver dans votre
configuration, recopiez sa recherche dans un fichier et ajoutez-la à
`sources`, avec le même `id`.

## Origines

```json
"origins": {
  "exclude_countries": ["<pays>"],
  "ranking_exclude_countries": ["France"],
  "masked_labels": ["Origine masquée"]
}
```

- `exclude_countries` : événements écartés dès la recherche. C'est utile pour
  un pays qui n'est que du bruit dans votre contexte, par exemple celui d'un
  prestataire qui teste vos applications.
- `ranking_exclude_countries` : comptés, mais absents du classement des pays.
  C'est typiquement votre propre pays, dont le volume vient surtout
  d'infrastructures légitimes.
- `masked_labels` : origines imposées par vos recherches (voir le contrat).
  Elles ne sont comptées ni comme pays ni dans le classement.

## Photos livrées avec l'appli (facultatif)

```json
"team_dir": "local/team"
```

- Ce dossier contient des photos `prenom.jpg`, carrées, d'environ 200 × 200.
- Elles servent tant qu'un analyste n'a pas de photo enregistrée dans la page
  de configuration.
- Le plus simple reste de tout gérer depuis la page de configuration, sans
  photo dans le dépôt.

## Divers

| Clé | Défaut | Rôle |
|---|---|---|
| `burst_cap` | 20 | événements tracés par rafale et par lot |
| `summary_index` | `summary` | index de copie des résultats |

## Vérifier et construire

```bash
python3 build.py --verifier      # erreurs de configuration, en clair
python3 build.py                 # dist/<app>-<version>.tgz et dist/apercu.html
python3 tests/splunk/run.py      # vos sources contre le contrat (SPLUNK_URL, SPLUNK_TOKEN)
```
