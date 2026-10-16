# Brancher un serveur UTMStack sur le mur

Procédure suivie le 6 octobre 2026 sur `srv-aptitude-1` (UTMStack v11), à
refaire telle quelle sur un autre serveur UTMStack.

```
UTMStack (OpenSearch, port 9200) -> relais.py (service) -> Splunk (HEC, port 8088) -> source du mur
```

Le relais ne fait que lire UTMStack. Il lui faut Python 3, rien d'autre.

## Ce qu'il faut avoir avant de commencer

| Élément | Où le trouver | Valeur sur le premier serveur |
|---|---|---|
| Adresse du HEC de Splunk | machine Splunk | `https://<ip-splunk>:8088/services/collector/event` |
| Jeton HEC | `SPLUNK_HEC_TOKEN` du `.env`, ou *Settings > Data inputs > HTTP Event Collector* | (secret) |
| Compte OpenSearch d'UTMStack | responsable UTMStack | identifiant `utmstack` |
| Accès SSH au serveur UTMStack, avec `sudo` | responsable UTMStack | |
| Flux réseau serveur UTMStack -> Splunk, TCP 8088 | équipe réseau, pare-feu de la machine Splunk | |

Le même jeton HEC et la même source du mur servent à tous les serveurs
UTMStack : côté Splunk et côté mur, il n'y a rien à refaire pour un deuxième
serveur (parties 1 et 6 déjà faites).

## 1. Côté Splunk (une seule fois)

Depuis la machine Splunk :

```bash
curl -k https://<ip-splunk>:8088/services/collector/health
```

Réponse attendue : `{"text":"HEC is healthy","code":17}`. Testez bien avec
l'adresse réseau, pas seulement `localhost`.

Envoi d'essai (invite de commandes Windows) :

```bash
curl -k https://<ip-splunk>:8088/services/collector/event -H "Authorization: Splunk <jeton>" -d "{\"index\":\"threatmap\",\"sourcetype\":\"test:connexion\",\"event\":{\"message\":\"test\"}}"
```

Réponse attendue : `{"text":"Success","code":0}`.

Ouvrez TCP 8088 en entrée dans le pare-feu de la machine Splunk.

## 2. Vérifier le réseau depuis le serveur UTMStack

```bash
curl -k https://<ip-splunk>:8088/services/collector/health
```

`HEC is healthy` : la liaison passe. Bloqué ou « timed out » : pare-feu.

## 3. Trouver la base d'UTMStack

Le service qui porte la base :

```bash
sudo docker service ls
```

Cherchez l'image `opensearch` (service `utmstack_node1`, port 9200, `1/1`).

Tester le compte (la base est en `https` et demande un mot de passe) :

```bash
curl -k -u utmstack https://localhost:9200
```

Trouver le nom des index d'alertes :

```bash
curl -k -u utmstack "https://localhost:9200/_cat/indices?v&s=index" | grep -i alert
```

Sur UTMStack v11 : `v11-alert-AAAA-MM-JJ`, donc `UTM_INDEX=v11-alert-*`.
Le script suppose `alert-*` par défaut : ce réglage est obligatoire.

Regarder une alerte, pour contrôler les champs (`@timestamp`, `id`, `name`,
`severityLabel`, `adversary.ip`, `dataSource`) :

```bash
curl -k -u utmstack "https://localhost:9200/v11-alert-*/_search?size=1&sort=@timestamp:desc&_source_excludes=logs,events&pretty"
```

## 4. Installer le relais

Créez le dossier et copiez-y `relais.py` (MobaXterm : glisser le fichier dans
le panneau de gauche de la session SSH) :

```bash
mkdir -p ~/Connexion-SPLUNK_OPENSEARCH
```

Créez le fichier de réglages :

```bash
nano ~/Connexion-SPLUNK_OPENSEARCH/relais.env
```

```
UTM_OPENSEARCH_URL=https://localhost:9200
UTM_INDEX=v11-alert-*
UTM_USER=utmstack
UTM_PASSWORD=<mot de passe du compte OpenSearch>
SPLUNK_HEC_URL=https://<ip-splunk>:8088/services/collector/event
SPLUNK_HEC_TOKEN=<jeton>
```

Pas de guillemets, pas d'espaces autour du `=`. Protégez-le :

```bash
chmod 600 ~/Connexion-SPLUNK_OPENSEARCH/relais.env
```

## 5. Essai à la main, puis service

Le relais ne prend au premier lancement que les 15 dernières minutes. Pour
avoir des alertes à envoyer pendant l'essai, donnez-lui un point de départ
(ici : aujourd'hui à 00h00 UTC, adaptez la date) :

```bash
cd ~/Connexion-SPLUNK_OPENSEARCH
```

```bash
echo "2026-10-06T00:00:00.000Z" > relais.etat
```

Un seul passage :

```bash
env $(grep -v '^#' relais.env | xargs -d '\n') python3 relais.py --une-fois
```

Attendu : `N alerte(s) envoyee(s)`. Vérifiez dans Splunk, sur 24 heures :

```
index=threatmap sourcetype="utmstack:alert"
```

Puis le service, pour qu'il tourne en continu et redémarre avec le serveur :

```bash
sudo nano /etc/systemd/system/relais-utmstack.service
```

```ini
[Unit]
Description=Relais UTMStack vers Splunk
After=network-online.target docker.service

[Service]
User=ivan
WorkingDirectory=/home/ivan/Connexion-SPLUNK_OPENSEARCH
EnvironmentFile=/home/ivan/Connexion-SPLUNK_OPENSEARCH/relais.env
ExecStart=/usr/bin/python3 /home/ivan/Connexion-SPLUNK_OPENSEARCH/relais.py
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

Adaptez `User` et les chemins si le compte n'est pas `ivan`.

```bash
sudo systemctl daemon-reload
```

```bash
sudo systemctl enable --now relais-utmstack
```

```bash
systemctl status relais-utmstack --no-pager
```

```bash
journalctl -u relais-utmstack -n 20 --no-pager
```

Attendu : `active (running)`, une ligne `lecture de https://localhost:9200/...`
et aucun `echec`. Le journal reste ensuite muet tant qu'il n'y a pas d'alerte.

## 6. Côté mur (une seule fois)

Page de configuration de l'appli, *Sources d'attaque > Ajouter une source* :

- identifiant `utmstack` (minuscules), libellé libre, « regarder en arrière » 0 ;
- recherche : le contenu de `templates/sources/utmstack_alertes/source.spl` ;
- « Valider sur la dernière heure », puis « Ajouter la source ».

`Interne` doit figurer dans `origins.masked_labels` de `config/wall.json`.

Une alerte sans IP d'attaquant publique (absente, `-`, ou adresse privée) est
comptée sous « Interne », sans arc. La cible affichée est `dataSource` quand
UTMStack ne donne pas de cible.

## Gérer le service

| Action | Commande |
|---|---|
| Arrêter | `sudo systemctl stop relais-utmstack` |
| Redémarrer (après modification de `relais.env` ou de `relais.py`) | `sudo systemctl restart relais-utmstack` |
| Arrêter et ne plus démarrer avec le serveur | `sudo systemctl disable --now relais-utmstack` |
| Après modification du fichier `.service` | `sudo systemctl daemon-reload`, puis `restart` |

Un arrêt ne perd rien : au redémarrage, le relais reprend à la date notée
dans `relais.etat`. Ne supprimez pas ce fichier.

## Pannes rencontrées

| Symptôme | Cause | Remède |
|---|---|---|
| `HEC is healthy` sur `localhost`, « Connection was reset » sur l'adresse réseau | deux Splunk sur la même machine (Windows et Docker) se partageant le port 8088 | n'en garder qu'un ; `netstat -ano \| findstr :8088` puis `tasklist /FI "PID eq <pid>"` pour les identifier |
| `curl http://localhost:9200` : « Empty reply from server » | la base attend du `https` | `curl -k https://localhost:9200` |
| `Unauthorized` sur le port 9200 | compte OpenSearch requis (ni compte Linux, ni compte de l'interface UTMStack) | `-u utmstack` |
| Recherche sur `alert-*` : 0 résultat, 0 shard | les index s'appellent `v11-alert-*` | `UTM_INDEX=v11-alert-*` |
| Relais : `HTTP Error 401` | le mot de passe n'arrive pas au script (variable vide ou saisie dans un autre onglet) | le mettre dans `relais.env` |
| Relais : `0 alerte(s)` à l'essai | pas de `relais.etat`, donc seulement les 15 dernières minutes | créer `relais.etat` avec une date de départ |
| Relais : `SPLUNK_HEC_URL et SPLUNK_HEC_TOKEN sont obligatoires` | réglages écrits dans l'en-tête du script, qui n'est qu'un commentaire | les passer par `relais.env` |
| Page de configuration : « identifiant : minuscules… » | majuscule dans l'identifiant de la source | `utmstack` |

Pour savoir quel côté refuse quand le relais affiche une erreur HTTP : testez
UTMStack avec `curl -k -u utmstack https://localhost:9200`, puis Splunk avec
l'envoi d'essai de la partie 1.

## Sécurité

- `relais.env` contient le mot de passe et le jeton en clair : `chmod 600`,
  jamais dans git, jamais dans l'en-tête de `relais.py`.
- Préférez un compte OpenSearch en lecture seule sur `v11-alert-*` au compte
  `utmstack`.
- Limitez la règle de pare-feu du port 8088 aux adresses des serveurs UTMStack.
