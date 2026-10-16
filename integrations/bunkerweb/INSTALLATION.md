# Brancher BunkerWeb sur le mur

Guide reconstitué le 6 octobre 2026 à partir de l'installation en place
(fichiers du dépôt et état du Splunk), pour la refaire sur un autre BunkerWeb
ou un autre Splunk.

```
BunkerWeb (journal d'erreurs nginx) --syslog UDP 5514--> Splunk (index threatmap) -> recherche wall_bunkerweb -> le mur
```

Rien à installer sur BunkerWeb : il envoie son journal par syslog, une
fonction d'origine de nginx.

## Ce qu'il faut avoir avant de commencer

| Élément | Valeur |
|---|---|
| Adresse de la machine Splunk | `<ip-splunk>` |
| Port syslog réservé à BunkerWeb | 5514, UDP (TCP aussi ouvert) |
| Accès aux réglages de BunkerWeb | variables d'environnement, `docker-compose` ou interface web |
| Flux réseau BunkerWeb -> Splunk | UDP 5514 |

## 1. Côté Splunk : l'entrée syslog (une seule fois)

Trois choses sont nécessaires : l'index `threatmap`, une entrée sur le port
5514 qui pose le sourcetype `bunkerweb`, et une règle qui garde une ligne
par événement. Elles sont fournies par `docker/threatmap_inputs/`.

**Avec le `docker-compose.yml` du projet** (cas actuel) :

```bash
python docker/paquet.py
```

Ce script fabrique `dist/threatmap_inputs.tgz`, que le conteneur installe au
démarrage. Le port 5514 (UDP et TCP) est déjà publié par `docker-compose.yml`.

**Sur un Splunk installé autrement**, faites la même chose à la main :

1. *Settings > Indexes > New Index* : `threatmap`.
2. *Settings > Data inputs > UDP > New Local UDP* : port `5514`, sourcetype
   `bunkerweb` (à créer), index `threatmap`.
3. Dans `props.conf` : `[bunkerweb]` avec `SHOULD_LINEMERGE = false`.

Ouvrez UDP 5514 en entrée dans le pare-feu de la machine Splunk.

## 2. Côté BunkerWeb : envoyer le journal

Dans les réglages globaux de BunkerWeb :

```
ERROR_LOG=syslog:server=<ip-splunk>:5514,tag=bunkerweb
USE_MODSECURITY=yes
```

Puis rechargez ou redémarrez BunkerWeb pour appliquer les réglages.

Le mur ne lit que les lignes `ModSecurity:` du journal d'erreurs. Le journal
d'accès n'est pas utile.

## 3. Vérifier la réception

Dans Splunk, sur les 15 dernières minutes :

```
index=threatmap sourcetype=bunkerweb
```

Des lignes doivent arriver dès qu'il y a du trafic. Pour ne voir que les
attaques :

```
index=threatmap sourcetype=bunkerweb "ModSecurity:"
```

Pour provoquer une attaque d'essai, depuis un poste extérieur, sur un site
protégé par BunkerWeb :

```bash
curl -k "https://<votre-site>/?id=1%27%20OR%20%271%27=%271"
```

BunkerWeb doit répondre 403, et une ligne `ModSecurity:` arriver dans Splunk.

## 4. Côté mur : déclarer la source

La source fait partie du paquet de l'appli.

1. Copiez le modèle dans vos fichiers propres :

```bash
cp templates/sources/bunkerweb_waf/source.spl config/local/sources/bunkerweb.spl
```

2. Dans ce fichier, adaptez la ligne `dc = "DC-NORD"` : mettez l'identifiant
   du site que BunkerWeb protège.

3. Dans `config/wall.json`, ajoutez à `sources` :

```json
{ "id": "bunkerweb", "label": "BunkerWeb", "color": "#4dd0e1", "search_file": "local/sources/bunkerweb.spl", "demo_weight": 0 }
```

4. Augmentez `app.version` dans `config/wall.json`, et mettez la même valeur
   dans `WALL_VERSION` du fichier `.env`.

5. Reconstruisez et réinstallez :

```bash
python build.py
```

```bash
docker compose up -d
```

Utilisez bien `docker compose up -d` et non `docker restart` : c'est lui qui
fait prendre en compte la nouvelle version.

## 5. Vérifier sur le mur

- Page de configuration, section *Démarrage* : la version affichée est la
  nouvelle.
- Section *Sources d'attaque* : `BunkerWeb`, recherche `wall_bunkerweb`,
  état « Active ».
- Les attaques traitées par la recherche :

```
index=summary search_name=wall_bunkerweb NOT meta=1
| table _time, signature, severity, Country, src_ip, dest_host, action
```

Délais normaux après une attaque : 5 à 10 minutes pour l'arc et le flux
« En direct », 10 à 15 minutes pour le panneau « Par source ». Ce panneau
n'affiche une source que si elle a au moins une attaque comptée aujourd'hui.

## Brancher un deuxième BunkerWeb

Seule la partie 2 est à refaire, plus le flux réseau : même adresse, même
port, même source sur le mur. Les serveurs se distinguent par la cible
(`dest_host`, le nom du site attaqué).

## Ce que le mur affiche pour chaque attaque

| Champ du mur | D'où il vient |
|---|---|
| IP de l'attaquant | `[client x.x.x.x]` de la ligne |
| Pays, arc | géolocalisation de cette IP |
| Technique | famille de la règle (`attack-sqli` -> « SQL Injection », etc.) |
| Gravité | score d'anomalie CRS, ou nombre de règles déclenchées |
| Cible | `host:` de la requête, sinon `server:` |
| Action | « blocked » si la ligne contient `Access denied`, sinon « detect » |

Une requête produit plusieurs lignes (une par règle, puis le refus) : la
recherche les regroupe par `unique_id` pour n'en compter qu'une.

## Pannes rencontrées

| Symptôme | Cause | Remède |
|---|---|---|
| BunkerWeb disparaît du mur après un redémarrage du conteneur | le conteneur réinstalle le paquet de la version notée à sa création (ici 1.3.0, sans BunkerWeb) | `docker compose up -d` après tout changement de `WALL_VERSION` |
| BunkerWeb absent du panneau « Par source » alors que les journaux arrivent | aucune attaque comptée aujourd'hui, ou délai de 10 à 15 minutes | attendre le passage suivant du cumul |
| Rien n'arrive dans `index=threatmap` | port 5514 fermé, ou `ERROR_LOG` non appliqué | pare-feu de la machine Splunk ; recharger BunkerWeb |
| Le syslog en TCP ne répond pas juste après l'installation | l'entrée TCP n'écoute qu'après un redémarrage de Splunk | utiliser l'UDP, ou redémarrer Splunk une fois |
| Des journaux arrivent mais aucune attaque n'est comptée | pas de ligne `ModSecurity:` | `USE_MODSECURITY=yes` ; les autres protections de BunkerWeb (listes noires, pays, bad behavior) ne sont pas lues par ce modèle |
| Le champ `host` vaut `172.19.0.1` | Splunk tourne dans Docker : il voit l'adresse de la passerelle Docker, pas celle de BunkerWeb | sans effet sur le mur ; la cible vient du contenu de la ligne |

## À savoir

- `config/wall.json` et `config/local/` ne sont pas versionnés par git
  (fichiers propres à votre installation) : sauvegardez-les à part.
- Limitez la règle de pare-feu du port 5514 à l'adresse des serveurs
  BunkerWeb : le syslog n'a ni mot de passe ni chiffrement.
