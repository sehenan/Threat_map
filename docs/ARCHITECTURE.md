# Architecture

```
 journaux (vos index)                 index summary                     navigateur (mur)
 ────────────────────                 ─────────────                     ────────────────
 wall_<source>  toutes les 5 min ──►  une copie par tranche  ──►  wall_cumul (xx:02, xx:07…)
   fenêtre -7m@m → -2m@m               (meta=1 : date du lot)       cumul depuis minuit
   + normalisation (build.py)                  │                            │
          │                                    ├─ dernier lot de chaque wall_* ─────────► page (chaque minute)
          │                                    │                            │ | loadjob
          │                                    │                            └──────────► page (cumul)
          │                                    └─ tranche choisie ─────────────────────► relecture (clic)
                                          KV store wall_analystes, wall_planning ──► bandeau équipe (REST)
```

## Pourquoi ce découpage

- **Un calcul, N écrans.** Les recherches sont planifiées. La page relit
  leurs derniers lots dans le summary, et le cumul avec `| loadjob` : rien
  n'est recalculé. Dix écrans ouverts ne coûtent pas plus qu'un.
- **Sources dynamiques.** Les lots sont lus dans le summary, en gardant le
  dernier passage (`search_now`) de chaque recherche `wall_*`. Une source
  ajoutée depuis la page de configuration apparaît donc à son premier passage.
  Des `| loadjob` enchaînés auraient tout vidé tant qu'une source n'avait pas
  de résultat : c'est vérifié, la recherche entière ne rend alors plus rien.
- **Le cumul du jour sans relire les journaux.** Chaque lot est copié dans
  l'index summary (sans consommation de licence). Le cumul additionne ces
  copies en quelques secondes, au lieu de relire toute la journée des index
  bruts.
- **Pas de double comptage.**
  - Le cumul s'arrête au début du lot que la page est en train de rejouer. La
    page compte ce lot elle-même, à mesure qu'elle l'affiche.
  - Si l'appli tourne sur plusieurs search heads, chaque tranche est en double
    dans le summary. On ne garde alors qu'un search head par passage
    (`search_now`).
- **Fenêtres jointives, sans décalage.** Chaque passage couvre exactement les
  5 minutes qui suivent le précédent. `allow_skew = 0` : sans cela, Splunk
  Cloud étale les passages de plusieurs minutes.
- **Le lot est rejoué, pas affiché d'un bloc.** Les événements d'un lot sont
  étalés sur les 5 minutes suivantes, à leur rythme d'origine : le mur vit en
  continu. Il a donc environ 7 minutes de retard sur le réel.
- **Relecture.** Un clic sur la courbe relit la tranche choisie dans le
  summary, en 2 secondes environ, et la rejoue en accéléré ×5.
- **Équipe par l'API REST du KV store**, pas par une recherche. Un compte
  d'affichage a peu de recherches simultanées (3 pour le rôle `user`) : on les
  garde pour les données.

## Fichiers générés (build/<app>/)

| Fichier | Rôle |
|---|---|
| `default/savedsearches.conf` | `wall_<source>` (une par source) et `wall_cumul` |
| `default/data/ui/views/mur.xml` | le mur, plein écran, sans barres Splunk |
| `default/data/ui/views/configuration.xml` | la page de configuration |
| `appserver/static/wall-<v>.js` | page + lecture des recherches (`splunk_app/src/source_splunk.js`) + configuration |
| `appserver/static/config-<v>.js` | page de configuration (`splunk_app/src/config.js`) |
| `default/collections.conf` | KV store `wall_analystes`, `wall_planning`, `wall_sources` (sources ajoutées) |
| `lookups/wall_demo_*.csv` | données des sources de démonstration |

## La page

`web/index.html` est autonome : carte vectorielle (Natural Earth, embarquée),
police des drapeaux embarquée, aucune dépendance. Elle ne sait pas d'où
viennent ses données : elle utilise `window.WALL_SOURCE` si l'appli le
fournit, sinon elle simule. Interface de `WALL_SOURCE` :

```
start({batch, daily, state, sources, sites})
                              batch(événements) toutes les 5 min,
                              daily(lignes "préfixe|valeur", fin en ms), state(ok, message),
                              sources([{label, color, priority}]) sources ajoutées,
                              sites([{id, label, lat, lon, label_dir}]) sites ajoutés
team()                        -> {analystes, planning: {date: {service, astreinte}}, noms}
photo(clé)                    -> URL de la photo
replay(débutMs)               -> événements d'une tranche passée (facultatif)
replayMax()                   -> fin des données relisibles (facultatif)
periode(earliest, latest, parJour)
                              -> bilan d'une période passée (sélecteur du mur :
                                 24 h, 7 j, 30 j). {dims, courbe:[{t,count}], feed}
                                 (facultatif ; sans lui, le sélecteur est masqué)
```

Une autre source que Splunk (Elastic, Sentinel…) peut donc alimenter la même
page. Il suffit d'écrire un `WALL_SOURCE`.
