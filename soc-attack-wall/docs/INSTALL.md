# Installation

## Prérequis

- Splunk Enterprise 8.1+ ou Splunk Cloud (Victoria ou Classic).
- Pour construire le paquet : Python 3.8+, rien d'autre.
- Un compte `admin` / `sc_admin` pour installer l'appli.
- L'index `summary` (présent par défaut), ou un autre index d'événements
  indiqué dans `summary_index`. Les recherches y copient leurs résultats : le
  summary indexing ne consomme pas de licence.

## 1. Construire le paquet

```bash
python3 build.py
```

Sans `config/wall.json`, la configuration de démonstration est utilisée. Le
paquet `dist/<app>-<version>.tgz` est prêt à installer, et `dist/apercu.html`
montre la page en simulation.

## 2. Installer

- **Splunk Enterprise** : *Applications > Gérer les applications > Installer
  une application depuis un fichier*, ou
  `splunk install app dist/soc_attack_wall-<version>.tgz`.
- **Splunk Cloud** : *Applications > Gérer les applications > Installer une
  application depuis un fichier*. Le paquet passe l'inspection AppInspect
  (tags `cloud` et `private_app`) : 0 erreur, 0 échec, 2 avertissements
  attendus (KV store et SplunkJS utilisés).

**Plusieurs search heads** : installez l'appli sur celui qui affichera le mur.
Si elle est aussi installée ailleurs, désactivez-y les recherches planifiées,
depuis la section *Recherches* de la page de configuration. Les compteurs
restent justes dans tous les cas, mais le calcul tournerait en double.

## 3. Page de configuration

L'appli s'ouvre sur sa page de configuration (`/app/soc_attack_wall/configuration`).
Le bouton « Ouvrir le mur » mène au mur.

La section **Démarrage** vérifie :
- la version installée ;
- les analystes et le planning ;
- les recherches planifiées ;
- l'écriture dans le summary ;
- la lecture du cumul par le mur ;
- la présence de données dans chaque source.

Chaque ligne indique l'action à mener. Juste après l'installation :

1. **Analystes** : « Créer 3 analystes d'exemple », ou ajoutez les vôtres,
   avec une photo recadrée automatiquement.
2. **Planning** : « Créer un planning d'exemple », ou saisissez-le. Un
   copier-coller depuis Excel est possible.
3. **Index summary** : les premières lignes arrivent 5 à 10 minutes après
   l'installation.

Une collection KV store neuve n'est parfois chargée qu'au redémarrage suivant
du search head. Si *Analystes* est en erreur juste après l'installation, le
mur fonctionne quand même, avec un bandeau d'équipe vide.

## 4. Afficher le mur

Sur l'écran, ouvrez directement l'adresse du mur (pas celle de l'appli, qui
mène à la configuration) :
```
https://<votre-splunk>/fr-FR/app/soc_attack_wall/mur
```

- **Compte d'affichage** : un rôle `user` suffit, s'il peut chercher dans
  l'index summary (`summary_index`). Le mur y relit les derniers lots copiés
  par les recherches planifiées, et le cumul par `| loadjob` : il ne relance
  aucun calcul. Donnez-lui le même
  fuseau horaire que l'équipe : les tranches horaires du cumul sont calculées
  dans le fuseau de l'utilisateur Splunk.
- **Plein écran** : touche `F`. Touche `R` pour recentrer la carte.
- **Disposition verticale** (deux écrans superposés) : automatique quand la
  hauteur dépasse la largeur. Le bouton en haut à droite bascule entre les
  deux dispositions, et le navigateur retient le choix. Si la jointure entre les deux écrans tombe mal,
  `?jointure=980` la force en pixels depuis le haut de la page ; `?debug=1` affiche un repère.
- **Thème clair ou sombre** : bouton soleil / lune en haut à droite, le
  navigateur retient le choix. `?theme=light` ou `?theme=dark` l'impose.
- **Rafraîchissement** : inutile, la page se met à jour seule. Un
  rafraîchissement du navigateur toutes les 30 min reste prudent sur un écran
  qui tourne jour et nuit.

## Mettre à jour

Augmentez `app.version` dans la configuration, reconstruisez, réinstallez.

Les fichiers de la page portent le numéro de version (`wall-1.0.1.js`) : un
rechargement suffit, sans `/_bump`. L'équipe et le planning, stockés dans le
KV store, ne sont pas touchés.
