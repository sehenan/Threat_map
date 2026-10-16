# Contrat d'une source

Une source est une recherche SPL (`search_file` dans la configuration). Elle
tourne toutes les 5 minutes sur la fenêtre `-7m@m → -2m@m`. Elle doit rendre
**un événement par attaque** avec ces champs :

| Champ | Obligatoire | Contenu |
|---|---|---|
| `_time` | oui | heure de l'attaque |
| `src_ip` | oui | IP de l'attaquant (géolocalisée par `iplocation`) |
| `dc` | oui | id du site visé : un site de la configuration (`sites[].id`) ou ajouté dans la page de configuration. Vide ou inconnu : le mur le rattache à `default_site` |
| `severity` | oui | `critical`, `high`, `medium`, `low` ou `informational`, sans distinction de casse. Toute autre valeur compte en `medium` |
| `signature` | oui | type d'attaque affiché (« SQL Injection », « Password spray »…). Vide : le libellé de la source |
| `dest_host` | non | cible affichée dans le flux (hôte, domaine, application) |
| `action` | non | `blocked`, `allowed`, `alerted`, `detect`… (défaut : `alerted`) |
| `Country`, `src_lat`, `src_lon` | non | à fournir seulement pour imposer l'origine, voir plus bas |

Terminez la recherche par :

```
| fields _time, src_ip, Country, src_lat, src_lon, dc, severity, signature, dest_host, action
```

## Ce que `build.py` ajoute

À la suite de votre recherche, dans la recherche planifiée :

1. `source_tech` = le libellé de la source ;
2. `iplocation src_ip`, sauf si `Country` est déjà fourni ;
3. **suppression des événements non géolocalisables** (IP privées, adresses
   inconnues de la base GeoIP) et des pays de `origins.exclude_countries` ;
4. coordonnées du site (`dst_lat`, `dst_lon`) d'après `dc` ;
5. normalisation de `severity` et `action` ;
6. une ligne de contrôle (`meta=1`), qui date le lot pour la page et le cumul.

Le résultat est copié dans l'index summary, puis lu par le mur (lot de 5 min),
par le cumul du jour (`wall_cumul`) et par la relecture.

## Origine masquée

Quand l'IP vue n'est pas celle de l'attaquant (trafic relayé par un CDN ou un
proxy), la géolocaliser tracerait un arc trompeur. Imposez alors l'origine :

```
| eval masque = if(cidrmatch("198.18.0.0/15", src_ip), 1, 0)
| eval Country = if(masque == 1, "Origine masquée", Country),
       src_lat = if(masque == 1, "", src_lat), src_lon = if(masque == 1, "", src_lon)
```

- Ces événements sont comptés, mais sans arc sur la carte.
- Ajoutez le libellé à `origins.masked_labels` : il ne compte alors pas comme
  un pays et n'apparaît pas dans le classement.

## Une source qui regarde plus loin en arrière

Certains journaux répartissent une attaque sur plusieurs lignes : par exemple
l'IP à l'ouverture de session, le refus plus tard. Pour recoller les deux :

- mettez `"lookback_minutes": 10` sur la source : la recherche démarre 10 min
  plus tôt ;
- gardez seulement les événements du lot avec `| where _time >= $WINDOW_START$`.
  `build.py` remplace `$WINDOW_START$` par le début de la fenêtre.

Voir `templates/sources/f5_apm_vpn`.

## Rafales

Au-delà de `burst_cap` événements (même source, même signature, même IP) dans
un lot, les suivants sont comptés mais ne tracent plus d'arc. Sans ce plafond,
un seul scanner remplirait la carte.

## Vérifier une source

- **Page de configuration**, section *Recherches* :
  - « Valider » contrôle ces champs sur la dernière heure : IP manquante, site
    inconnu, sévérité hors liste, signature vide ;
  - « Tester » exécute la recherche complète, sans rien écrire.
- **Hors appli** : `python3 tests/splunk/run.py --seulement sources`.
