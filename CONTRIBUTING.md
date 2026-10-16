# Contribuer

Les contributions sont les bienvenues, en particulier de **nouveaux modèles de
sources** (voir [templates/README.md](templates/README.md)).

## Avant de proposer une modification

```bash
python3 -m unittest discover -s tests -v              # doit passer (sans Splunk)
python3 build.py                                      # le paquet se construit
python3 tests/splunk/run.py --sans-appli              # si vous avez un Splunk de test
```

## Règles

- **Aucune donnée réelle** dans le dépôt : ni IP, ni nom de domaine, ni nom
  d'index, de serveur ou de personne de votre organisation. Dans les jeux de
  test, utilisez les plages de documentation (`192.0.2.0/24`,
  `198.51.100.0/24`, `203.0.113.0/24`) et `example.org`.
- **Pas de dépendance** : `build.py` et les tests n'utilisent que la
  bibliothèque standard de Python ; la page n'utilise aucune bibliothèque.
- **Splunk Cloud** : le paquet doit passer AppInspect avec les tags `cloud` et
  `private_app` (pas de script Python dans l'appli, pas d'appel réseau
  externe depuis la page).
- Une recherche enregistrée ne commence **jamais** par `search` : Splunk
  l'ajoute, et `search search index=...` cherche le mot « search » dans chaque
  événement. `build.py` le retire.
- Les valeurs venant des journaux passent par `esc()` avant d'entrer dans le
  HTML : une partie est choisie par l'attaquant.

## Signaler un problème

Joignez :
- la version (`__mur.version` dans la console du navigateur) ;
- la section *Démarrage* de la page de configuration ;
- le cas échéant, les lignes de la section *Dépannage*.

Retirez-en toute donnée propre à votre organisation.
