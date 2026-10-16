# Journal des versions

## 1.3.0

- **Filtre par source** : clic sur une source du panneau « Par source » ou sur l'étiquette d'une ligne du
  flux. Le flux et la carte n'affichent plus que cette source ; les compteurs du jour restent globaux. Un
  bouton dans le titre du flux retire le filtre.
- **Flux déroulable** : 200 lignes (au lieu de 24), tampon de 3 000 événements, en-tête fixe. Le flux se
  met en pause pendant la lecture et reprend au retour en haut.
- **Disposition verticale sur écran étroit** (forte mise à l'échelle) : la courbe du jour reste affichée à
  côté du flux ; la colonne Pays n'affiche que le drapeau (nom au survol) ; les boutons de relecture
  tiennent sur une ligne.
- **Panneau « Aujourd'hui » extensible** : une source de données peut ajouter ses propres vues
  (`cb.vue(id, titre, html)`), affichées en rotation toutes les 10 s, avec une pause au survol. Sans vue
  ajoutée, rien ne change.

## 1.2.3

- Double-clic sur la courbe du jour (appli Splunk) : ouvre dans un nouvel
  onglet une recherche listant les attaques de la tranche de 5 min (heure,
  source, gravité, signature, IP, pays, cible, action, site). Le simple clic
  relance toujours la relecture.
- Recherches planifiées confiées à un autre propriétaire que `nobody` (compte
  de service) : le mur et la configuration retrouvent leur propriétaire réel.
  Auparavant `loadjob` ne trouvait plus le cumul (mur à zéro) et
  l'activation, la modification ou la suppression d'une source échouaient.

## 1.2.2

- Courbe du jour décalée de plusieurs heures quand le propriétaire des
  recherches planifiées (`nobody`) n'est pas dans le fuseau de l'écran (UTC
  en Splunk Cloud) : un pic de 14:20 s'affichait à 12:20, et la relecture
  d'un pic relisait la mauvaise tranche. Le cumul fournit désormais chaque
  tranche en horodatage absolu (`t5`), converti par la page dans l'heure du
  poste.

## 1.2.1

- Icône de l'appli (`splunk_app/assets/static/`, 36 et 72 px, et
  `icon-512.png` pour la page Splunkbase).
- `app.conf` : `check_for_updates = true` par défaut. Splunkbase refusait le
  paquet (« The "check_for_updates" field found in app.conf must not be
  disabled »). Option `app.check_for_updates: false` pour une version privée.

## 1.2.0

- **Version anglaise** : `"language": "en"` dans la configuration (exemple
  prêt à l'emploi : `config/wall.example.en.json`). Mur, page de configuration,
  messages, formats de date et de nombre, données de démonstration, adresse du
  mur (`.../wall`). README en anglais : `README.en.md`.
- Traduction à la construction (`i18n.py`, `i18n/en.json`) : seules les
  chaînes de caractères sont traduites, jamais le code. Les tests échouent si
  un texte français reste dans la version anglaise ou si une entrée du
  dictionnaire ne sert plus.
- L'import du planning depuis Excel reconnaît aussi les jours en anglais.

## 1.1.0

- **Sources d'attaque** : nouvelle section de la page de configuration.
  - Ajouter une source, à partir d'un modèle ou d'une recherche vierge, sans
    reconstruire l'appli.
  - La valider sur la dernière heure avant de l'enregistrer.
  - La modifier, la désactiver ou la supprimer.
  - La page crée la recherche planifiée `wall_<id>`, avec la même
    normalisation que `build.py`, et range libellé et couleur dans le KV store
    `wall_sources`.
- Le mur lit les lots dans l'index summary au lieu d'enchaîner des
  `| loadjob`. Une source sans résultat (ajoutée, pas encore passée) vidait
  toute la lecture. Désormais, une source apparaît à son premier passage et
  disparaît quand on la retire.
- Le cumul et la relecture prennent toutes les recherches `wall_*`.
- La ligne de contrôle de chaque lot est datée du début du lot. Sans cela,
  celle d'une source qui regarde plus loin en arrière (`lookback_minutes`)
  sortait de la fenêtre de lecture.
- **Compte d'affichage** : il doit pouvoir chercher dans l'index summary.

## 1.0.1

- L'appli s'ouvre sur la page de configuration (vue par défaut), et non plus
  sur le mur. Le mur reste à son adresse directe `.../mur`, à utiliser sur
  l'écran d'affichage.
- `roles_config` vaut `["*"]` par défaut : la vue d'accueil est lisible par
  tous les comptes, dont celui de l'écran.

## 1.0.0

Première version publique.

- Mur : carte des attaques en direct, compteurs du jour, flux des derniers
  événements, équipe de permanence, disposition verticale pour deux écrans
  superposés.
- Relecture : clic sur la courbe du jour pour rejouer une tranche de 5 min
  (×5), navigation par tranche, retour au direct.
- Page de configuration : vérifications après installation, analystes et
  photos, planning (copier-coller depuis Excel), état, validation et test des
  recherches, dépannage.
- Configuration unique (`config/wall.json`) : identité, sites, sources,
  origines. `build.py` produit l'appli et un aperçu hors ligne.
- 5 sources de démonstration (`makeresults`), 5 modèles de sources avec jeux
  de test, tests hors ligne et jeux de tests SPL.
