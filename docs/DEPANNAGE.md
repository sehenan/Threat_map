# Dépannage

Commencez toujours par la page **Configuration** de l'appli.
- La section *Démarrage* situe le problème.
- La section *Dépannage* liste les passages du planificateur qui ont échoué ou
  ont été sautés, et les erreurs Splunk liées à l'appli. Les cas connus sont
  expliqués.

## Le mur reste à zéro

| Symptôme | Cause probable | Que faire |
|---|---|---|
| Rien pendant 10 min après l'installation | aucun passage encore | attendre deux passages (xx:00, xx:05) |
| *Index summary* rouge | recherches désactivées, ou summary non autorisé au propriétaire des recherches | section *Recherches* : état, « Tester » |
| *Données <source>* rouge | index vide ou non autorisé, mauvais sourcetype | « Ouvrir dans Rechercher » sur la ligne |
| *Lecture par le mur* : « Cannot find artifacts » | pas de passage du cumul depuis 20 min | vérifier `wall_cumul` dans *Recherches* |
| Mur vide, configuration au vert | le compte d'affichage ne peut pas chercher dans l'index summary | lui donner l'accès à `summary_index` |
| Source ajoutée absente du mur | premier passage pas encore fait, ou recherche en échec | attendre 10 min ; section *Recherches* : « Tester » |
| Compteurs justes mais aucun arc | événements sans géolocalisation (IP privées) ou origine masquée | « Valider » sur la source |

## Chiffres incohérents

- **Compteurs deux fois trop hauts**, sur une version modifiée de l'appli :
  plusieurs search heads écrivent dans le summary. La section *Recherches*
  l'indique. L'appli ne garde qu'un search head par passage : vérifiez que
  `UNIQUE_SH` figure toujours dans la recherche de cumul.
- **Moins d'attaques que dans vos recherches habituelles** :
  - les événements non géolocalisables sont écartés, par exemple les IP
    privées vues par un WAF interne ;
  - les pays de `origins.exclude_countries` aussi ;
  - « Valider » montre ce que votre source rend avant cette étape.
- **Courbe décalée d'une ou deux heures** : le fuseau du compte Splunk
  d'affichage diffère de celui de l'écran. Alignez-le dans les préférences du
  compte.

## Relecture

- **Rien avant une certaine heure** : le summary ne contient que ce qui a été
  copié depuis l'installation.
- **Les 10 dernières minutes ne sont pas relisibles** : c'est normal, elles
  ne sont pas encore dans le summary.

## Mise à jour non prise en compte

Rechargez la page. Les fichiers portent le numéro de version : si
`app.version` n'a pas changé, le navigateur garde l'ancien fichier en cache.
Augmentez la version à chaque livraison.

Dans la console du navigateur, `__mur.version` et `__mur.etat()` donnent la
version chargée et l'état interne du mur.

## Recherche dans les journaux internes

```
index=_internal sourcetype=scheduler app=soc_attack_wall savedsearch_name=wall_*
| stats count(eval(status="success")) as ok, count as total, latest(status) by savedsearch_name, host
```
