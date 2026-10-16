#!/usr/bin/env python3
"""Relais UTMStack -> Splunk : lit les nouvelles alertes dans l'OpenSearch d'UTMStack
(index alert-*) et les poste au HTTP Event Collector de Splunk, sourcetype utmstack:alert.

UTMStack n'a pas d'envoi natif vers Splunk. Ce script se lance sur le serveur UTMStack,
la ou son OpenSearch repond (http://localhost:9200). Python 3 seul, aucune dependance.
Il ne fait que lire UTMStack.

Reglages, par variables d'environnement :
  SPLUNK_HEC_URL        https://<splunk>:8088/services/collector/event      (obligatoire)
  SPLUNK_HEC_TOKEN      jeton du HEC                                         (obligatoire)
  SPLUNK_HEC_VERIFIER   1 pour verifier le certificat de Splunk (defaut 0 : auto-signe)
  SPLUNK_INDEX          defaut threatmap
  UTM_OPENSEARCH_URL    defaut http://localhost:9200
  UTM_INDEX             defaut alert-*
  UTM_USER, UTM_PASSWORD  si l'OpenSearch demande un compte
  UTM_INTERVALLE        secondes entre deux releves, defaut 60
  UTM_ETAT              fichier qui retient la derniere alerte envoyee, defaut ./relais.etat

  python3 relais.py            en continu
  python3 relais.py --une-fois un seul releve, puis s'arrete (essai, cron)
"""
import base64, datetime, json, os, ssl, sys, time, urllib.error, urllib.request

E = os.environ.get
OS_URL = E("UTM_OPENSEARCH_URL", "http://localhost:9200").rstrip("/")
OS_INDEX = E("UTM_INDEX", "alert-*")
HEC_URL, HEC_TOKEN = E("SPLUNK_HEC_URL"), E("SPLUNK_HEC_TOKEN")
INDEX = E("SPLUNK_INDEX", "threatmap")
INTERVALLE = int(E("UTM_INTERVALLE", "60"))
ETAT = E("UTM_ETAT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "relais.etat"))
LOT = 500
# champs volumineux inutiles au mur : les journaux bruts rattaches a l'alerte
LOURDS = ("logs", "events")

SANS_VERIF = ssl.create_default_context()
SANS_VERIF.check_hostname = False
SANS_VERIF.verify_mode = ssl.CERT_NONE


def journal(msg):
    print("%s relais utmstack : %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg), flush=True)


def appel(url, corps, entetes, verifier=True):
    req = urllib.request.Request(url, data=corps, method="POST", headers=entetes)
    ctx = None if not url.startswith("https") else (ssl.create_default_context() if verifier else SANS_VERIF)
    with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
        return r.read().decode()


def lire_alertes(depuis):
    """Alertes plus recentes que `depuis` (horodatage ISO), de la plus ancienne a la plus recente."""
    entetes = {"Content-Type": "application/json"}
    if E("UTM_USER"):
        entetes["Authorization"] = "Basic " + base64.b64encode(
            ("%s:%s" % (E("UTM_USER"), E("UTM_PASSWORD", ""))).encode()).decode()
    requete = {"size": LOT, "sort": [{"@timestamp": {"order": "asc"}}],
               "query": {"range": {"@timestamp": {"gt": depuis}}}}
    url = "%s/%s/_search?ignore_unavailable=true" % (OS_URL, OS_INDEX)
    rep = json.loads(appel(url, json.dumps(requete).encode(), entetes, verifier=False))
    return rep.get("hits", {}).get("hits", [])


def epoch(iso):
    try:
        return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


def envoyer(alertes):
    corps = []
    for h in alertes:
        a = {k: v for k, v in h.get("_source", {}).items() if k not in LOURDS}
        a.setdefault("id", h.get("_id"))
        corps.append(json.dumps({"time": epoch(a.get("@timestamp")), "index": INDEX,
                                 "sourcetype": "utmstack:alert", "source": "utmstack", "event": a}))
    appel(HEC_URL, "\n".join(corps).encode(),
          {"Authorization": "Splunk " + HEC_TOKEN, "Content-Type": "application/json"},
          verifier=E("SPLUNK_HEC_VERIFIER", "0") == "1")


def releve():
    """Un passage : toutes les alertes apparues depuis le dernier envoi reussi."""
    try:
        depuis = open(ETAT).read().strip()
    except OSError:
        depuis = ""
    if not depuis:   # premier lancement : les 15 dernieres minutes, pas tout l'historique
        depuis = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    total = 0
    while True:
        alertes = lire_alertes(depuis)
        if not alertes:
            break
        envoyer(alertes)
        depuis = alertes[-1]["_source"]["@timestamp"]
        with open(ETAT, "w") as f:      # retenu seulement apres un envoi reussi
            f.write(depuis)
        total += len(alertes)
        if len(alertes) < LOT:
            break
    return total


def main():
    if not HEC_URL or not HEC_TOKEN:
        sys.exit("SPLUNK_HEC_URL et SPLUNK_HEC_TOKEN sont obligatoires (voir l'en-tete du script)")
    une_fois = "--une-fois" in sys.argv
    journal("lecture de %s/%s, envoi vers %s" % (OS_URL, OS_INDEX, HEC_URL))
    while True:
        try:
            n = releve()
            if n or une_fois:
                journal("%d alerte(s) envoyee(s)" % n)
        except (urllib.error.URLError, OSError, ValueError, KeyError) as e:
            journal("echec, nouvel essai au prochain releve : %s" % e)
            if une_fois:
                sys.exit(1)
        if une_fois:
            return
        time.sleep(INTERVALLE)


if __name__ == "__main__":
    main()
