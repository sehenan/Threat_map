# Modèles de sources

Des recherches éprouvées en production, pour des produits courants. **Elles
sont à adapter** : noms d'index, ids de vos sites, plages d'adresses. Elles
supposent les add-ons Splunk officiels de chaque produit (extraction des
champs).

| Modèle | Produit | Add-on supposé | Signale |
|---|---|---|---|
| `ubika_waf` | WAF Ubika (WAAP, ICX Engine) | journaux JSON Ubika | attaques applicatives bloquées ; gravité selon la rafale |
| `checkpoint_ips` | IPS Check Point | Splunk Add-on for Check Point | alertes IPS, sans les `informational` |
| `proofpoint` | Proofpoint | add-on Proofpoint | messages entrants rejetés (hameçonnage, usurpation…) |
| `o365_echecs_connexion` | Microsoft 365 / Entra ID | Splunk Add-on for Microsoft Office 365 | échecs de connexion (compte verrouillé, mot de passe invalide…) |
| `f5_apm_vpn` | F5 BIG-IP APM | Splunk Add-on for F5 BIG-IP | refus de connexion VPN, IP retrouvée dans la session |
| `bunkerweb_waf` | WAF BunkerWeb | aucun : journal d'erreurs nginx (ModSecurity / OWASP CRS) | requêtes refusées ou détectées par ModSecurity ; gravité selon le score d'anomalie |
| `fortiweb_waf` | WAF Fortinet FortiWeb | Fortinet FortiWeb Add-On for Splunk | journal d'attaques, sans les `Info` |
| `utmstack_alertes` | UTMStack (SIEM / XDR) | aucun : alertes envoyées en JSON (HEC) | alertes ; sans IP externe, origine « Interne » |
| `zabbix_problemes` | Zabbix | aucun : export temps réel ou webhook, en JSON | problèmes ouverts, origine « Interne » (pas d'arc) |
| `itop_incidents` | iTop (ITSM) | aucun : tickets exportés en JSON (API REST) | nouveaux incidents, origine « Interne » (pas d'arc) |
| `generique_json` | tout outil | aucun : objet JSON envoyé au HEC | ce que l'outil envoie (`signature`, `src_ip`, `severity`…) |

Ces six modèles lisent l'index `threatmap` avec un sourcetype fixe par
produit : voir [docs/INTEGRATIONS.md](../docs/INTEGRATIONS.md) pour l'envoi
depuis chaque produit.

Zabbix et iTop ne signalent pas des attaques : leurs événements n'ont pas
d'adresse d'origine. Les modèles imposent l'origine « Interne » (voir *Origine
masquée* dans [docs/CONTRAT.md](../docs/CONTRAT.md)) : ajoutez `"Interne"` à
`origins.masked_labels`. Ils sont comptés avec les attaques dans les totaux du
mur.

## Contenu d'un modèle

| Fichier | Rôle |
|---|---|
| `source.spl` | la recherche. Première commande : index et filtres, ensuite le traitement |
| `fixture.spl` | des événements fictifs (`makeresults`), tels que la première commande les ramènerait |
| `attendu.json` | ce que doit rendre le modèle sur ces événements, après normalisation |

`tests/splunk/run.py` remplace la première commande de `source.spl` par
`fixture.spl`, applique la suite et la normalisation de `build.py`, puis
compare le résultat à `attendu.json`. Aucun index n'est lu.

## Utiliser un modèle

```bash
mkdir -p config/local/sources
cp templates/sources/proofpoint/source.spl config/local/sources/mail.spl
# adapter l'index et les ids de sites, puis dans config/wall.json :
#   { "id": "mail", "label": "Proofpoint", "color": "#00b891", "search_file": "local/sources/mail.spl" }
```

## Proposer un modèle

Un nouveau modèle est le bienvenu : un dossier avec ses trois fichiers, et
`python3 tests/splunk/run.py --seulement modeles` qui passe. Utilisez des
adresses des plages de documentation (`192.0.2.0/24`, `198.51.100.0/24`,
`203.0.113.0/24`) et des domaines `example.org` dans les jeux de test.
Voir [CONTRIBUTING.md](../CONTRIBUTING.md).
