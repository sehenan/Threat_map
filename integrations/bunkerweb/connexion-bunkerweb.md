# Connexion BunkerWeb → Splunk (Threat Map)

Guide pour envoyer les attaques bloquées par BunkerWeb vers le mur, sans perdre
le journal local du WAF. Testé sur **BunkerWeb 1.6.10**.

## Principe

BunkerWeb écrit ses blocages ModSecurity dans son journal d'erreurs nginx. On
ajoute une **seconde destination** à ce journal, en syslog, vers Splunk. Le
fichier local reste alimenté ; Splunk reçoit une copie.

```
BunkerWeb ──(syslog UDP 5514)──► Splunk (index threatmap, sourcetype bunkerweb)
   │                                      │
   └──► /var/log/bunkerweb/error.log      └──► recherche wall_bunkerweb ──► mur
         (journal local conservé)
```

## Valeurs de cette installation

| Élément | Valeur |
|---|---|
| Interface BunkerWeb | `http://waf.aptitudes.local:7000/` |
| Adresse de Splunk vue du WAF | `172.16.160.202` |
| Port d'écoute Splunk | `5514/udp` |
| Index Splunk | `threatmap` |
| Sourcetype | `bunkerweb` |
| Sites protégés testés | `soc.aptitudes.net`, `zerodays.local` |

> `172.16.160.202` est l'adresse du poste qui héberge Splunk. Si ce poste
> change d'adresse ou est éteint, les journaux n'arrivent plus. Pour un usage
> durable, placez Splunk sur une machine à adresse fixe et reportez la nouvelle
> adresse à l'étape 1 et à l'étape 3.

## 1. Côté BunkerWeb : ajouter l'envoi vers Splunk

Ne modifiez **pas** `ERROR_LOG` dans *Global Settings* : ce champ n'accepte
qu'une seule destination, vous perdriez le journal local. Passez par une
configuration personnalisée.

1. Menu **Configs** → nouvelle configuration.
2. Renseignez :
   - **Type** : `http`
   - **Service** : global (aucun service particulier)
   - **Nom** : `splunk_syslog`
3. Contenu, exactement ces deux lignes :

   ```nginx
   error_log /var/log/bunkerweb/error.log notice;
   error_log syslog:server=172.16.160.202:5514,tag=bunkerweb notice;
   ```

4. Enregistrez. BunkerWeb recharge sa configuration tout seul.

La première ligne conserve le journal local actuel, la seconde ajoute l'envoi
vers Splunk. Ne mettez jamais la seconde ligne seule.

## 2. Côté Windows (poste Splunk) : ouvrir le pare-feu

Dans un PowerShell **administrateur** :

```powershell
New-NetFirewallRule -DisplayName "Threat Map - syslog BunkerWeb" `
  -Direction Inbound -Protocol UDP -LocalPort 5514 `
  -RemoteAddress 10.10.1.139 -Action Allow
```

`10.10.1.139` est l'adresse du WAF : la règle n'autorise que lui.

## 3. Côté Splunk : déjà prêt

L'entrée syslog et la source du mur sont livrées avec l'appli :

- entrée `udp://5514` → index `threatmap`, sourcetype `bunkerweb`
  (paquet `threatmap_inputs`, fichier `docker/threatmap_inputs/default/inputs.conf`) ;
- source `wall_bunkerweb` (recherche planifiée toutes les 5 min), modèle
  `templates/sources/bunkerweb_waf/`.

Rien à faire ici, sauf si vous ajoutez la source à la main depuis
*Configuration → Sources d'attaque* (choisir le modèle « BunkerWeb »).

## 4. Vérifier

1. Depuis une connexion **extérieure** (pour avoir une IP publique), envoyez une
   requête d'attaque inoffensive à un site protégé :

   ```
   https://soc.aptitudes.net/?id=1' OR '1'='1
   ```

   BunkerWeb doit répondre **403**.

2. Dans Splunk, sur les 15 dernières minutes :

   ```spl
   index=threatmap sourcetype=bunkerweb "ModSecurity:"
   ```

   La ligne du blocage doit apparaître.

3. Sur le mur (dans les 5 à 10 min) : cliquez sur **BunkerWeb** dans le panneau
   « Par source » pour n'afficher que cette source. L'attaque apparaît en arc
   depuis le pays d'origine.

## Ce que le mur affiche

Le modèle regroupe les lignes d'une même requête (reliées par `unique_id`),
déduit le type d'attaque et calcule la gravité :

| Champ du mur | D'où il vient |
|---|---|
| Technique | famille d'attaque CRS (SQL Injection, XSS, LFI, RCE…) |
| Sévérité | score d'anomalie CRS, ou nombre de règles déclenchées |
| Action | `bloquée` (403) ou `détectée` (règle sans blocage) |
| Cible | `host` de la requête (ex. `soc.aptitudes.net`) |
| Origine | IP cliente, géolocalisée |

## Points à connaître

- **ModSecurity seulement.** Les autres protections de BunkerWeb (bad behavior,
  listes noires, blocage par pays) ont un autre format de ligne et ne sont pas
  encore lues.
- **Attaques internes invisibles sur la carte.** Une attaque venant d'une IP
  privée n'a pas de pays d'origine : elle est comptée mais sans arc. Pour voir
  un essai sur la carte, lancez-le depuis une connexion extérieure (4G, etc.).
- **Le site de destination.** Par défaut les attaques pointent sur le site de
  démonstration « DC Nord ». Déclarez votre vrai site dans *Configuration →
  Sites protégés*, puis indiquez son identifiant pour l'inscrire dans la source.
- **La démo noie les vraies attaques.** Tant que les 5 sources de démonstration
  tournent, le volume BunkerWeb (quelques attaques) est noyé. Filtrez sur
  « BunkerWeb », ou désactivez la démo (*Configuration → Recherches*).

## Dépannage

| Symptôme | Cause / solution |
|---|---|
| Rien n'arrive dans `index=threatmap sourcetype=bunkerweb` | Pare-feu (étape 2) absent, ou mauvaise adresse Splunk dans la config BunkerWeb. Vérifier avec `index=threatmap sourcetype=bunkerweb` sans filtre. |
| Des lignes arrivent, mais **aucune `ModSecurity:`** | Aucune requête n'a été bloquée. Tester une vraie requête d'attaque (étape 4), vérifier que c'est bien un site protégé par le WAF (pas l'interface 7000). |
| Syslog en **TCP** silencieux | L'entrée TCP n'écoute qu'après un redémarrage de Splunk : `docker restart soc-attack-wall-splunk`. L'UDP marche sans redémarrage. |
| Journal `crowdsec:access() failed … bouncer.lua:610` | Problème du plugin CrowdSec de BunkerWeb, **sans rapport avec Splunk**. À regarder dans les réglages CrowdSec. |
| Attaques visibles dans Splunk, pas sur le mur | Démo trop volumineuse (filtrer sur BunkerWeb), ou attente du prochain lot (~7 min de décalage voulu). |

## Annuler

Supprimez la configuration `splunk_syslog` dans **Configs** : BunkerWeb revient
à l'état d'avant, le journal local continue, plus rien ne part vers Splunk.
