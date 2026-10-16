# Brancher les sources

Chaque produit envoie ses journaux à Splunk par son mécanisme d'origine,
sans agent à installer. Tout arrive dans un seul index, `threatmap`, et le
sourcetype est fixé par le point d'entrée : il n'y a rien à choisir.

| Produit | Envoi | Vers | Sourcetype | Modèle de source |
|---|---|---|---|---|
| BunkerWeb | syslog (nginx) | `<splunk>:5514` UDP | `bunkerweb` | `bunkerweb_waf` |
| FortiWeb | syslog | `<splunk>:5515` UDP | `fortiweb` | `fortiweb_waf` |
| Zabbix | webhook (type de média) | HEC, port 8088 | `zabbix:problems` | `zabbix_problemes` |
| iTop | webhook (notification) | HEC, port 8088 | `itop:ticket` | `itop_incidents` |
| UTMStack | JSON | HEC, port 8088 | `utmstack:alert` | `utmstack_alertes` |
| tout autre outil | JSON | HEC, port 8088 | `threatmap:event` | `generique_json` |

`<splunk>` est l'adresse de la machine qui fait tourner `docker-compose.yml`.
L'index et les ports syslog viennent de `docker/threatmap_inputs/` ; le HEC
est activé par `SPLUNK_HEC_TOKEN` dans `.env`. Le syslog en UDP et le HEC
répondent dès l'installation ; le syslog en TCP (mêmes ports) n'écoute
qu'après un redémarrage de Splunk (`docker restart soc-attack-wall-splunk`).

Ensuite, dans l'appli : **Configuration > Sources d'attaque > Ajouter une
source**, choisissez le modèle, « Valider », enregistrez. La source apparaît
sur le mur dans les 5 à 10 minutes.

## Le HTTP Event Collector (HEC)

Adresse : `https://<splunk>:8088/services/collector/event`
En-tête : `Authorization: Splunk <SPLUNK_HEC_TOKEN>`

Le certificat du conteneur est auto-signé : désactivez la vérification TLS
côté émetteur, ou installez votre certificat dans Splunk.

Essai depuis n'importe quel poste :

```bash
curl -k https://<splunk>:8088/services/collector/event \
  -H "Authorization: Splunk <jeton>" \
  -d '{"index":"threatmap","sourcetype":"threatmap:event","event":{"src_ip":"203.0.113.60","signature":"Essai","severity":"high","dest_host":"essai"}}'
```

Puis dans Splunk : `index=threatmap` sur les 15 dernières minutes.

## BunkerWeb

Dans les variables de BunkerWeb (fichier d'environnement, `docker-compose`
ou interface web, réglages globaux) :

```
ERROR_LOG=syslog:server=<splunk>:5514,tag=bunkerweb
USE_MODSECURITY=yes
```

Le modèle lit les lignes `ModSecurity:` du journal d'erreurs. Le journal
d'accès n'est pas nécessaire.

## FortiWeb

1. *Log&Report > Log Policy > Syslog Policy* : créez une politique vers
   `<splunk>`, port 5515, UDP, format par défaut (champs `clé=valeur`).
2. *Log&Report > Log Config > Global Log Settings* : activez *Syslog*, niveau
   *Information*, et choisissez la politique.
3. *Log&Report > Log Config > Other Log Settings* : activez *Attack Log*.

Si vous utilisez déjà le *Fortinet FortiWeb Add-On for Splunk*, gardez-le :
le modèle accepte aussi son sourcetype `fwb_attack`.

## Zabbix

*Alertes > Types de média > Créer*, type **Webhook**.

Paramètres :

| Nom | Valeur |
|---|---|
| `url` | `https://<splunk>:8088/services/collector/event` |
| `token` | votre `SPLUNK_HEC_TOKEN` |
| `eventid` | `{EVENT.ID}` |
| `value` | `{EVENT.VALUE}` |
| `name` | `{EVENT.NAME}` |
| `severity` | `{EVENT.NSEVERITY}` |
| `host` | `{HOST.HOST}` |
| `hostname` | `{HOST.NAME}` |

Script :

```js
var p = JSON.parse(value);
var req = new HttpRequest();
req.addHeader('Authorization: Splunk ' + p.token);
req.addHeader('Content-Type: application/json');
var corps = JSON.stringify({
  index: 'threatmap', sourcetype: 'zabbix:problems',
  event: { eventid: p.eventid, value: p.value, name: p.name, severity: p.severity,
           hosts: [{ host: p.host, name: p.hostname }] }
});
var rep = req.post(p.url, corps);
if (req.getStatus() !== 200) { throw 'Splunk HEC ' + req.getStatus() + ' : ' + rep; }
return 'OK';
```

Puis affectez ce média à un utilisateur, et créez une action de déclencheur
(*Alertes > Actions > Actions de déclencheur*) qui lui envoie les problèmes.

## iTop

iTop 3.1 ou plus récent (notifications par webhook). *Configuration >
Notifications* :

1. **Action** de type *Webhook* : méthode `POST`, adresse
   `https://<splunk>:8088/services/collector/event`, en-tête
   `Authorization: Splunk <jeton>`, et ce contenu :

```json
{ "index": "threatmap", "sourcetype": "itop:ticket",
  "event": { "ref": "$this->ref$", "finalclass": "Incident", "title": "$this->title$",
             "priority": "$this->priority$", "status": "$this->status$",
             "service_name": "$this->service_name$", "org_name": "$this->org_name$" } }
```

2. **Déclencheur** *à la création d'un objet*, classe `Incident`, lié à
   cette action.

Dans la source du mur, mettez « regarder en arrière » à 15 minutes.

## UTMStack

UTMStack n'a pas d'envoi natif vers Splunk. Ses alertes sont dans son
OpenSearch (index `alert-*`) : il faut un relais qui les lit et les poste au
HEC, sourcetype `utmstack:alert`, telles quelles. Le modèle lit `id`, `name`,
`severity` ou `severityLabel`, et l'IP dans `adversary.ip` ou `source.ip`.
Ce relais reste à écrire, d'après votre version d'UTMStack.

## Un produit sans modèle

Faites-lui poster au HEC un objet JSON, sourcetype `threatmap:event` :

| Champ | Contenu |
|---|---|
| `signature` (ou `name`, `title`) | ce qui s'est passé. Obligatoire |
| `src_ip` (ou `src`) | IP de l'attaquant. Absente ou privée : origine « Interne », sans arc |
| `severity` | `critical`, `high`, `medium`, `low`, `informational` |
| `dest_host` (ou `dest`, `target`) | la cible |
| `action` | `blocked`, `allowed`, `alerted` |
| `dc` (ou `site`) | id du site visé ; sinon le site par défaut |
