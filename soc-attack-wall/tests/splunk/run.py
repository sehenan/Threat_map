#!/usr/bin/env python3
"""Jeux de tests SPL, executes sur un Splunk (lecture seule : rien n'est ecrit).

    export SPLUNK_URL=https://splunk.example.org:8089 SPLUNK_TOKEN=...
    python3 tests/splunk/run.py                       # modeles + sources de la config
    python3 tests/splunk/run.py --seulement modeles   # templates/sources/*/ avec leurs fixtures
    python3 tests/splunk/run.py --seulement sources   # recherches de la config (demo ou les votres)
    python3 tests/splunk/run.py --sans-appli          # sans l'appli installee : lookups de demo integres
    python3 tests/splunk/run.py --cumul               # en plus, la recherche de cumul (lit l'index summary)

Modeles : la recherche de base (index, filtres) est remplacee par fixture.spl,
la suite du modele et la normalisation de build.py s'appliquent, le resultat
est compare a attendu.json. Aucun index n'est lu.
Sources : chaque recherche de la configuration tourne sur une fenetre de 5 min
(-7m@m -> -2m@m) et doit respecter le contrat (docs/CONTRAT.md).
"""
import argparse, csv, glob, io, json, os, re, ssl, sys, time, urllib.error, urllib.parse, urllib.request

ICI = os.path.dirname(os.path.abspath(__file__))
RACINE = os.path.dirname(os.path.dirname(ICI))
sys.path.insert(0, RACINE)
import build  # noqa: E402

REQUIS = ["t", "src_ip", "Country", "dc", "dst_lat", "dst_lon", "source_tech", "severity", "signature", "action"]


class Splunk:
    def __init__(self, url, token, app=None, verifier_tls=True):
        self.url, self.token, self.app = url.rstrip("/"), token, app
        self.ctx = ssl.create_default_context()
        if not verifier_tls:
            self.ctx.check_hostname = False
            self.ctx.verify_mode = ssl.CERT_NONE

    def chercher(self, spl, earliest="-24h", latest="now"):
        spl = spl.strip()
        if not spl.startswith("|") and not spl.startswith("search "):
            spl = "search " + spl
        chemin = "/servicesNS/nobody/%s/search/jobs/export" % self.app if self.app else "/services/search/jobs/export"
        donnees = urllib.parse.urlencode({"search": spl, "earliest_time": earliest, "latest_time": latest,
                                          "output_mode": "json"}).encode()
        req = urllib.request.Request(self.url + chemin, data=donnees, method="POST",
                                     headers={"Authorization": "Bearer " + self.token})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=300, context=self.ctx) as r:
                corps = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            corps = e.read().decode("utf-8", "replace")
            raise RuntimeError("HTTP %d : %s" % (e.code, message(corps) or corps[:300]))
        lignes, erreurs = [], []
        for l in corps.splitlines():
            if not l.strip():
                continue
            try:
                j = json.loads(l)
            except ValueError:
                continue
            if j.get("preview") is True:
                continue
            if "result" in j:
                lignes.append(j["result"])
            erreurs += [m["text"] for m in j.get("messages", []) if m.get("type") in ("ERROR", "FATAL")]
        if erreurs:
            raise RuntimeError(" ; ".join(erreurs))
        return lignes, time.time() - t0


def message(corps):
    try:
        return " ; ".join(m["text"] for m in json.loads(corps).get("messages", []))
    except (ValueError, AttributeError):
        return ""


def lookups_integres(spl):
    """| lookup wall_demo_x cles OUTPUT champs  ->  | join type=left cles [| makeresults format=csv data="..."]
    Permet de tester les sources de demo sans installer l'appli."""
    def remplacer(m):
        nom, cles, sorties = m.group(1), m.group(2), m.group(3)
        f = os.path.join(RACINE, "splunk_app", "assets", "lookups", nom + ".csv")
        data = build.lire(f).strip().replace('"', "")
        cles = ", ".join(c.strip() for c in cles.split(","))
        return '| join type=left %s [| makeresults format=csv data="%s" | fields %s, %s]' % (cles, data, cles, sorties.strip())
    return re.sub(r"\|\s*lookup\s+(wall_demo_\w+)\s+(.+?)\s+OUTPUT\s+(.+)", remplacer, spl)


def controler_contrat(lignes, cfg):
    """Problemes de contrat sur des lignes normalisees (hors ligne meta)."""
    pb = []
    sites = {s["id"] for s in cfg["sites"]}
    for i, r in enumerate(lignes):
        manque = [c for c in REQUIS if r.get(c) in (None, "")]
        if manque:
            pb.append("ligne %d : champs vides %s" % (i + 1, ", ".join(manque)))
        if r.get("dc") not in sites:
            pb.append("ligne %d : site inconnu %r" % (i + 1, r.get("dc")))
        if r.get("severity") not in build.SEVERITES:
            pb.append("ligne %d : severite %r" % (i + 1, r.get("severity")))
        if len(pb) > 5:
            break
    return pb


def valeurs(lignes, champ):
    v = set()
    for r in lignes:
        x = r.get(champ)
        for y in (x if isinstance(x, list) else [x]):
            if y is not None:
                v.add(str(y))
    return v


def tester_modeles(sp, cfg):
    ok = True
    for d in sorted(glob.glob(os.path.join(RACINE, "templates", "sources", "*", ""))):
        nom = os.path.basename(os.path.dirname(d))
        spl = build.lire_spl(os.path.join(d, "source.spl")).replace("$WINDOW_START$", "0")
        fixture = build.lire_spl(os.path.join(d, "fixture.spl"))
        suite = spl.split("\n|", 1)[1] if "\n|" in spl else ""
        test = fixture + "\n|" + suite + "\n" + build.normalisation(cfg, {"label": "TEST"})
        attendu = json.loads(build.lire(os.path.join(d, "attendu.json")))
        try:
            lignes, duree = sp.chercher(test)
        except RuntimeError as e:
            print("ECHEC  modele %-24s %s" % (nom, e)); ok = False; continue
        pb = controler_contrat(lignes, cfg)
        if len(lignes) != attendu["lignes"]:
            pb.insert(0, "%d lignes au lieu de %d" % (len(lignes), attendu["lignes"]))
        for champ, v in attendu.get("valeurs", {}).items():
            obtenu = valeurs(lignes, champ)
            if obtenu != set(map(str, v)):
                pb.append("%s = %s, attendu %s" % (champ, sorted(obtenu), sorted(v)))
        if pb:
            ok = False
            print("ECHEC  modele %-24s %s" % (nom, " | ".join(pb)))
        else:
            print("OK     modele %-24s %d lignes, %.1f s" % (nom, len(lignes), duree))
    return ok


def tester_sources(sp, cfg, dossier, sans_appli):
    ok = True
    for s in cfg["sources"]:
        spl = build.detail(cfg, s, dossier)
        if sans_appli:
            spl = lookups_integres(spl)
        try:
            lignes, duree = sp.chercher(spl, "-%dm@m" % (7 + s.get("lookback_minutes", 0)), build.FIN)
        except RuntimeError as e:
            print("ECHEC  source %-24s %s" % (build.nom_recherche(s), e)); ok = False; continue
        meta = [r for r in lignes if r.get("meta") == "1"]
        ev = [r for r in lignes if r.get("meta") != "1"]
        pb = controler_contrat(ev, cfg)
        if len(meta) != 1:
            pb.append("ligne meta absente")
        if pb:
            ok = False
            print("ECHEC  source %-24s %s" % (build.nom_recherche(s), " | ".join(pb)))
        else:
            print("%s source %-24s %d evenements sur 5 min, %.1f s%s" % (
                "OK    " if ev else "VIDE  ", build.nom_recherche(s), len(ev), duree,
                "" if ev else " (aucune donnee sur la fenetre : verifier index et filtres)"))
    return ok


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("--url", default=os.environ.get("SPLUNK_URL"), help="https://hote:8089 (ou SPLUNK_URL)")
    a.add_argument("--token", default=os.environ.get("SPLUNK_TOKEN"), help="jeton d'authentification (ou SPLUNK_TOKEN)")
    a.add_argument("--config", help="configuration (defaut : celle de build.py)")
    a.add_argument("--app", help="espace de l'appli installee (ex. soc_attack_wall) : lookups de demo disponibles")
    a.add_argument("--sans-appli", action="store_true", help="integrer les lookups de demo dans les recherches")
    a.add_argument("--seulement", choices=["modeles", "sources"])
    a.add_argument("--cumul", action="store_true", help="tester aussi la recherche de cumul (lit l'index summary)")
    a.add_argument("--tls-non-verifie", action="store_true", help="certificat auto-signe (environnement de test)")
    o = a.parse_args()
    if not o.url or not o.token:
        a.error("--url et --token (ou SPLUNK_URL et SPLUNK_TOKEN) sont requis")
    chemin = o.config or next(p for p in (os.path.join(RACINE, "config", "wall.json"),
                                          os.path.join(RACINE, "config", "wall.example.json")) if os.path.exists(p))
    cfg, dossier = build.charger(chemin)
    e = build.valider(cfg, dossier)
    if e:
        print("Configuration invalide :\n" + "\n".join(" - " + x for x in e)); return 2
    sp = Splunk(o.url, o.token, o.app, not o.tls_non_verifie)
    ok = True
    if o.seulement in (None, "modeles"):
        ok &= tester_modeles(sp, cfg)
    if o.seulement in (None, "sources"):
        ok &= tester_sources(sp, cfg, dossier, o.sans_appli or not o.app)
    if o.cumul:
        try:
            lignes, duree = sp.chercher(build.cumul(cfg), "@d", "now")
            meta = [r for r in lignes if r.get("meta") == "1"]
            print("%s cumul  %d lignes, %.1f s" % ("OK    " if meta else "ECHEC ", len(lignes), duree))
            ok &= bool(meta)
        except RuntimeError as x:
            print("ECHEC  cumul", x); ok = False
    print("\nRESULTAT :", "tout est conforme" if ok else "des tests echouent")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
