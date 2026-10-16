#!/usr/bin/env python3
"""Construit l'appli Splunk du mur a partir d'un fichier de configuration.

    python3 build.py                          # config/wall.json, sinon config/wall.example.json
    python3 build.py --config chemin/wall.json
    python3 build.py --verifier               # valide la configuration sans rien produire

Produit :
    build/<app>/                 l'appli, prete a etre inspectee
    dist/<app>-<version>.tgz     le paquet a installer dans Splunk
    dist/apercu.html             la page seule, en simulation, a ouvrir dans un navigateur

Aucune dependance hors de la bibliotheque standard de Python 3.8+.
"""
import argparse, base64, json, os, re, shutil, struct, sys, tarfile, textwrap, zlib

import i18n

RACINE = os.path.dirname(os.path.abspath(__file__))

# Fenetres alignees et jointives : le passage de hh:00 couvre [-7m@m, -2m@m],
# celui de hh:05 reprend a hh-2. Deux minutes de marge pour les journaux
# indexes en retard.
DEBUT, FIN = "-7m@m", "-2m@m"
SEVERITES = ["critical", "high", "medium", "low", "informational"]
# Champs d'un evenement, dans l'ordre ou la page les attend (docs/CONTRAT.md)
CHAMPS = ["_time", "t", "Country", "src_lat", "src_lon", "src_ip", "dc", "dst_lat", "dst_lon",
          "source_tech", "severity", "signature", "dest_host", "client", "action"]


def lire(chemin, mode="r"):
    with open(chemin, mode, **({} if "b" in mode else {"encoding": "utf-8"})) as f:
        return f.read()


def ecrire(chemin, contenu):
    with open(chemin, "wb" if isinstance(contenu, bytes) else "w", **({} if isinstance(contenu, bytes) else {"encoding": "utf-8"})) as f:
        f.write(contenu)


class ErreurConfig(Exception):
    def __init__(self, erreurs):
        super().__init__("\n".join(" - " + e for e in erreurs))
        self.erreurs = erreurs


# ------------------------------------------------------------------ configuration
def charger(chemin):
    """(config, dossier de la config). Les cles commencant par "_" sont des commentaires."""
    with open(chemin, encoding="utf-8") as f:
        brut = json.load(f)
    def nettoyer(x):
        if isinstance(x, dict):
            return {k: nettoyer(v) for k, v in x.items() if not k.startswith("_")}
        if isinstance(x, list):
            return [nettoyer(v) for v in x]
        return x
    return nettoyer(brut), os.path.dirname(os.path.abspath(chemin))


def valider(cfg, dossier):
    """Liste des erreurs (vide si la configuration est utilisable)."""
    err = []
    hexa = re.compile(r"^#[0-9a-fA-F]{6}$")
    app = cfg.get("app", {})
    if not re.match(r"^[a-z][a-z0-9_]{2,40}$", str(app.get("id", ""))):
        err.append("app.id : minuscules, chiffres et _ (3 a 41 caracteres), ex. soc_attack_wall")
    if not re.match(r"^\d+\.\d+\.\d+$", str(app.get("version", ""))):
        err.append("app.version : de la forme 1.2.3")
    if not isinstance(app.get("check_for_updates", True), bool):
        err.append("app.check_for_updates : true (Splunkbase) ou false (appli privee)")
    for r in ("roles_write", "roles_config"):
        if not isinstance(app.get(r, []), list) or not all(re.match(r"^([a-z0-9_-]+|\*)$", str(x)) for x in app.get(r, [])):
            err.append("app.%s : liste de noms de roles Splunk" % r)
    page = cfg.get("page", {})
    if not hexa.match(str(page.get("accent", ""))):
        err.append("page.accent : couleur #rrggbb")
    if page.get("logo") and not os.path.isfile(os.path.join(dossier, page["logo"])):
        err.append("page.logo : fichier introuvable (%s)" % page["logo"])
    mh = page.get("map_home", {})
    if not all(isinstance(mh.get(k), (int, float)) for k in ("lon", "lat", "zoom")):
        err.append("page.map_home : lon, lat et zoom numeriques")

    sites = cfg.get("sites", [])
    ids = [s.get("id") for s in sites]
    if not sites:
        err.append("sites : au moins un site")
    for s in sites:
        if not re.match(r"^[A-Za-z0-9_-]{1,30}$", str(s.get("id", ""))):
            err.append("sites : id invalide %r (lettres, chiffres, _ et -)" % s.get("id"))
        if not (isinstance(s.get("lat"), (int, float)) and -90 <= s["lat"] <= 90 and
                isinstance(s.get("lon"), (int, float)) and -180 <= s["lon"] <= 180):
            err.append("sites[%s] : lat/lon hors limites" % s.get("id"))
        d = s.get("label_dir", [1, -1])
        if not (isinstance(d, list) and len(d) == 2 and all(isinstance(x, (int, float)) for x in d)):
            err.append("sites[%s].label_dir : deux nombres [dx, dy]" % s.get("id"))
    if len(set(ids)) != len(ids):
        err.append("sites : ids en double")
    if cfg.get("default_site") not in ids:
        err.append("default_site : doit etre l'id d'un site")

    srcs = cfg.get("sources", [])
    if not srcs:
        err.append("sources : au moins une source")
    for s in srcs:
        sid = str(s.get("id", ""))
        if not re.match(r"^[a-z0-9_]{1,20}$", sid):
            err.append("sources : id invalide %r (minuscules, chiffres, _)" % sid)
        if not str(s.get("label", "")).strip() or '"' in str(s.get("label", "")):
            err.append("sources[%s].label : obligatoire, sans guillemet" % sid)
        if not hexa.match(str(s.get("color", ""))):
            err.append("sources[%s].color : couleur #rrggbb" % sid)
        f = os.path.join(dossier, str(s.get("search_file", "")))
        if not os.path.isfile(f):
            err.append("sources[%s].search_file : fichier introuvable (%s)" % (sid, s.get("search_file")))
        lb = s.get("lookback_minutes", 0)
        if not isinstance(lb, int) or lb < 0 or lb > 1440:
            err.append("sources[%s].lookback_minutes : entier entre 0 et 1440" % sid)
    for k in ("id", "label"):
        v = [s.get(k) for s in srcs]
        if len(set(v)) != len(v):
            err.append("sources : %s en double" % k)
    if not isinstance(cfg.get("burst_cap", 20), int) or cfg.get("burst_cap", 20) < 1:
        err.append("burst_cap : entier >= 1")
    if not re.match(r"^[a-z0-9_-]+$", str(cfg.get("summary_index", "summary"))):
        err.append("summary_index : nom d'index")
    if cfg.get("language", "fr") not in i18n.LOCALES:
        err.append("language : %s" % " ou ".join(i18n.LOCALES))
    team = cfg.get("team_dir")
    if team and not os.path.isdir(os.path.join(dossier, team)):
        err.append("team_dir : dossier introuvable (%s)" % team)
    return err


# ------------------------------------------------------------------ recherches
def lire_spl(chemin):
    """Texte d'une recherche : commentaires ``` ``` retires, sans "search" en tete.
    Splunk ajoute lui-meme "search" devant une recherche enregistree : le garder
    donnerait "search search index=...", qui exige le MOT "search" dans chaque
    evenement - la recherche ne ramene alors presque rien."""
    spl = lire(chemin)
    spl = re.sub(r"```.*?```", "", spl, flags=re.S)
    lignes = [l.rstrip() for l in spl.splitlines() if l.strip()]
    spl = "\n".join(lignes)
    return re.sub(r"^\s*search\s+", "", spl, count=1).strip()


def base(spl):
    """Premiere commande (index et filtres), pour l'affichage et le controle des donnees."""
    return spl.split("\n|", 1)[0].strip()


def q(s):
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def normalisation(cfg, src):
    """Suite ajoutee a la recherche de chaque source : ce que la page attend.
    La source fournit _time, src_ip, dc, severity, signature, dest_host, action,
    et peut imposer Country / src_lat / src_lon (ex. origine masquee)."""
    sites = cfg["sites"]
    defaut = [s for s in sites if s["id"] == cfg["default_site"]][0]
    coord = lambda k: "case(" + ", ".join("dc == %s, %s" % (q(s["id"]), s[k]) for s in sites) + ")"
    exclus = cfg.get("origins", {}).get("exclude_countries", [])
    l = [
        "| eval source_tech = %s, src_ip = trim(src_ip)" % q(src["label"]),
        '| iplocation src_ip prefix="wall_"',
        "| eval Country = coalesce(Country, wall_Country), src_lat = coalesce(src_lat, wall_lat), src_lon = coalesce(src_lon, wall_lon)",
        '| where isnotnull(Country) AND Country != ""',
    ]
    if exclus:
        l.append("| where NOT in(Country, %s)" % ", ".join(q(c) for c in exclus))
    l += [
        # un id de site absent de la configuration est garde tel quel : il peut etre
        # declare dans la page de configuration (KV store wall_sites). Le mur le
        # place, ou le rattache au site par defaut s'il est inconnu.
        "| eval dc = coalesce(nullif(dc, \"\"), %s)" % q(cfg["default_site"]),
        "| eval dst_lat = coalesce(%s, %s), dst_lon = coalesce(%s, %s)"
        % (coord("lat"), defaut["lat"], coord("lon"), defaut["lon"]),
        "| eval severity = lower(severity), severity = if(in(severity, %s), severity, \"medium\")"
        % ", ".join(q(x) for x in SEVERITES),
        "| eval action = lower(coalesce(action, \"alerted\")), signature = coalesce(signature, %s), dest_host = coalesce(dest_host, \"\")"
        % q(src["label"]),
        # client : pose par la source (ex. UTMStack), sinon table site (dest_host) -> client
        # (KV store wall_clients, jokers autorises). Vide = "a renseigner", affiche par la page.
        '| eval wall_h = lower(dest_host)',
        "| lookup wall_clients host AS wall_h OUTPUT client AS wall_client",
        '| eval client = coalesce(nullif(client, ""), nullif(wall_client, ""), "")',
        "| eval t = _time",
        "| table " + ", ".join(CHAMPS),
    ]
    return "\n".join(l)


# Ligne de controle de chaque lot : sa date (debut de fenetre) et son volume.
# _time = debut : copiee dans le summary a cette heure-la, le mur la retrouve
# en relisant les 20 dernieres minutes, quelle que soit la source.
META = ('| appendpipe [ stats count as n | eval meta = 1, debut = relative_time(now(), "%s"), _time = debut'
        ' | fields meta debut n _time ]' % DEBUT)


def detail(cfg, src, dossier):
    spl = lire_spl(os.path.join(dossier, src["search_file"]))
    # $WINDOW_START$ : debut de la fenetre du lot, pour les sources qui regardent
    # plus loin en arriere (lookback_minutes) mais ne doivent garder que le lot
    spl = spl.replace("$WINDOW_START$", 'relative_time(now(), "%s")' % DEBUT)
    return spl + "\n" + normalisation(cfg, src) + "\n" + META


def modeles(langue="fr"):
    """Modeles de sources (templates/sources/*/source.spl), proposes dans la page de
    configuration. Titre : commentaire "Modele :" (fr) ou "Template:" (en). Les
    commentaires, en francais, sont retires de la recherche proposee en anglais."""
    out = []
    for d in sorted(os.listdir(os.path.join(RACINE, "templates", "sources"))):
        f = os.path.join(RACINE, "templates", "sources", d, "source.spl")
        if not os.path.isfile(f):
            continue
        brut = lire(f)
        m = re.search(r"Template\s*:\s*(.+?)\.\s*```" if langue == "en" else r"Modele\s*:\s*([^.\n]+)", brut)
        spl = brut
        if langue == "en":
            spl = "\n".join(l for l in re.sub(r"```.*?```", "", brut, flags=re.S).split("\n") if l.strip())
            spl = spl.replace("Origine masquée", "Masked origin")   # libelle de la config anglaise
        else:
            spl = re.sub(r"``` Template:[^`]*```\n?", "", brut)
        out.append({"id": d, "titre": m.group(1).strip() if m else d, "spl": spl.strip()})
    return out


def nom_recherche(src):
    return "wall_" + src["id"]


# L'appli peut etre installee sur plusieurs search heads : chacun planifie les
# recherches et ecrit dans le summary, chaque tranche y figure en double. Pour
# chaque passage (search_now, identique partout avec allow_skew = 0), on ne
# garde que le search head au plus petit nom.
UNIQUE_SH = "| eventstats min(host) as sh_retenu by search_name, search_now | where host == sh_retenu"


def cumul(cfg):
    # toutes les recherches wall_* : celles de la configuration et celles
    # ajoutees depuis la page de configuration
    # tranche de 5 min en horodatage absolu (t5) : strftime dependrait du fuseau
    # du proprietaire de la recherche planifiee (nobody = souvent UTC) ; la page
    # la convertit dans l'heure du poste
    dims = "action, source_tech, severity, Country, signature, dc, t5"
    return "\n".join([
        "index=%s search_name=wall_* search_name!=wall_cumul NOT meta=1" % cfg.get("summary_index", "summary"),
        '| eval t5 = _time - (_time % 300)',
        '| fillnull value="" Country signature',
        "| stats count by host, search_name, search_now, " + dims,
        UNIQUE_SH,
        "| stats sum(count) as count by " + dims,
        '| appendpipe [ stats count as n | eval meta = 1, fin = relative_time(now(), "-9m@m") | fields meta fin n ]',
    ])


def conf_search(spl):
    return " \\\n".join(l.rstrip() for l in spl.strip().splitlines() if l.strip())


def savedsearches(cfg, dossier):
    idx = cfg.get("summary_index", "summary")
    out = ["# Genere par build.py - ne pas modifier a la main.",
           "# Detail : toutes les 5 min, resultats copies dans l'index %s" % idx,
           "# (pas de consommation de licence) pour alimenter le cumul et la relecture.", ""]
    for s in cfg["sources"]:
        out += ["[%s]" % nom_recherche(s), "description = Mur - source %s" % s["label"],
                "search = " + conf_search(detail(cfg, s, dossier)),
                "cron_schedule = */5 * * * *", "enableSched = 1",
                "dispatch.earliest_time = -%dm@m" % (7 + s.get("lookback_minutes", 0)),
                "dispatch.latest_time = %s" % FIN,
                "dispatch.ttl = 2p", "schedule_window = 0",
                # sinon Splunk Cloud decale les passages pour etaler la charge
                "allow_skew = 0",
                "action.summary_index = 1", "action.summary_index._name = %s" % idx,
                "is_visible = true", ""]
    out += ["# Cumul depuis minuit, jusqu'au debut du lot que la page rejoue.",
            "# Passe 2 min apres le detail, quand le summary est a jour.",
            "[wall_cumul]", "description = Mur - cumul du jour",
            "search = " + conf_search(cumul(cfg)),
            "cron_schedule = 2-59/5 * * * *", "enableSched = 1",
            "dispatch.earliest_time = @d", "dispatch.latest_time = -9m@m",
            "dispatch.ttl = 2p", "schedule_window = 0", "allow_skew = 0", "is_visible = true", ""]
    return "\n".join(out)


# ------------------------------------------------------------------ fichiers
def png_uni(taille, hexa):
    """Icone PNG d'une couleur (pas de dependance a une bibliotheque d'image)."""
    r, g, b = (int(hexa[i:i + 2], 16) for i in (1, 3, 5))
    ligne = b"\x00" + bytes([r, g, b]) * taille
    brut = zlib.compress(ligne * taille, 9)
    def bloc(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + bloc(b"IHDR", struct.pack(">IIBBBBB", taille, taille, 8, 2, 0, 0, 0)) +
            bloc(b"IDAT", brut) + bloc(b"IEND", b""))


def data_uri(chemin):
    ext = os.path.splitext(chemin)[1].lower()
    mime = {".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}.get(ext)
    if not mime:
        raise ErreurConfig(["page.logo : png, svg ou jpg"])
    return "data:%s;base64,%s" % (mime, base64.b64encode(lire(chemin, "rb")).decode())


DANS_SPLUNK = """
/* ---- dans Splunk : le mur recouvre tout le tableau de bord ---- */
#wall{position:fixed;top:0;left:0;z-index:2000;background:var(--nuit)}
#seam{z-index:2100}
/* Splunk a sa propre classe .panel (bordure, marges, largeur) : on l'annule */
#wall .panel{border:0!important;box-shadow:none!important;margin:0!important;
  width:auto!important;max-width:none!important;float:none!important;display:block}
#wall #lf,#wall #rt{float:none}
/* Splunk Web embarque Bootstrap 2 : .row (marge negative, pseudo-elements),
   titres (marges, interligne 40 px), dt en gras. Remise a zero sous #wall. */
#wall{line-height:normal;font-size:16px}
#wall .row{margin:0!important}
#wall .row::before,#wall .row::after{content:none!important;display:none!important}
#wall h1,#wall h2,#wall h3,#wall p,#wall dl,#wall dd,#wall dt,#wall figure{margin:0;padding:0;line-height:normal}
#wall dt{font-weight:normal}
#wall img{max-width:none;vertical-align:baseline}
#wall table{max-width:none;background:transparent}
#wall a{color:inherit}
#wall .ttl{margin-bottom:10px}
#wall .grp{margin-bottom:6px}
#wall .sub{margin-top:16px;padding-top:14px}
#wall .sub dt{margin-top:2px}
"""


def construire(cfg, dossier, sortie=None):
    erreurs = valider(cfg, dossier)
    if erreurs:
        raise ErreurConfig(erreurs)
    sortie = sortie or RACINE
    APP, VERSION = cfg["app"]["id"], cfg["app"]["version"]
    OUT, DIST = os.path.join(sortie, "build", APP), os.path.join(sortie, "dist")
    page_cfg = cfg["page"]
    LANGUE = cfg.get("language", "fr")
    dico = i18n.charger(LANGUE)
    VUE = "wall" if LANGUE == "en" else "mur"         # adresse du mur : /app/<appli>/<VUE>
    tjs = lambda src: i18n.locale(i18n.traduire_js(src, dico), LANGUE)
    ttx = lambda txt: i18n.traduire_texte(txt, dico)

    # configuration transmise a la page (sans les recherches)
    wall_config = {
        "page": dict(page_cfg, logo=data_uri(os.path.join(dossier, page_cfg["logo"])) if page_cfg.get("logo") else None),
        "sites": cfg["sites"],
        "default_site": cfg["default_site"],
        "sources": [{k: s[k] for k in ("id", "label", "color", "priority", "demo_weight") if k in s} for s in cfg["sources"]],
        "origins": {"ranking_exclude_countries": cfg.get("origins", {}).get("ranking_exclude_countries", []),
                    "masked_labels": cfg.get("origins", {}).get("masked_labels", [])},
    }
    team = os.path.join(dossier, cfg["team_dir"]) if cfg.get("team_dir") else None
    photos = sorted(os.path.splitext(f)[0] for f in os.listdir(team) if f.lower().endswith(".jpg")) if team else []

    page = lire(os.path.join(RACINE, "web", "index.html"))
    css = page[page.index("<style>") + 7: page.index("</style>")]
    css = re.sub(r"@font-face\{font-family:'Twemoji Country Flags';src:url\(data:font/woff2;base64,[^)]+\)",
                 "@font-face{font-family:'Twemoji Country Flags';src:url(fonts/twemoji-country-flags.woff2)", css)
    assert "base64" not in css, "police de drapeaux encore embarquee"
    polices = "".join(
        "@font-face{font-family:'Barlow Semi Condensed';font-weight:%d;font-style:normal;font-display:swap;"
        "src:url(fonts/barlow-semi-condensed-%d.woff2) format('woff2')}\n" % (w, w) for w in (400, 500, 600, 700))
    balisage = ttx(page[page.index('<div id="wall">'): page.index("<script>")].strip())
    script = tjs(page[page.index("<script>") + 8: page.rindex("</script>")])
    source = tjs(lire(os.path.join(RACINE, "splunk_app", "src", "source_splunk.js")))
    entete = ('require([\n  "splunkjs/mvc",\n  "splunkjs/mvc/searchmanager",\n'
              '  "splunk.util",\n  "splunkjs/mvc/simplexml/ready!"\n'
              "], function (mvc, SearchManager, splunkUtil) {\n\"use strict\";\n")
    j = lambda x: json.dumps(x, ensure_ascii=False)
    wall_js = (
        "/* %s - mur. Genere par build.py. */\n" % cfg["app"]["label"] + entete +
        "var APP = %s;\nvar PHOTOS = %s;\nvar SOURCES = %s;\nvar BURST_CAP = %d;\nvar UNIQUE_SH = %s;\nvar SUMMARY = %s;\n"
        % (j(APP), j(photos), j([nom_recherche(s) for s in cfg["sources"]]), cfg.get("burst_cap", 20),
           j(UNIQUE_SH), j(cfg.get("summary_index", "summary"))) +
        "window.WALL_CONFIG = %s;\n\n" % j(wall_config) +
        "/* le mur remplace le contenu du tableau de bord */\n"
        "var hote = document.createElement(\"div\");\nhote.innerHTML = %s;\n" % j(balisage) +
        "while (hote.firstChild) document.body.appendChild(hote.firstChild);\n\n" +
        source + "\n\n/* ---- page du mur (web/index.html) ---- */\n" + script +
        "\n/* etat interne en lecture seule, pour le diagnostic (console : __mur.etat()) */\n"
        "window.__mur = { version: %s, etat: function () { return { total: DAILY.total, fin: DAILY_END, live: LIVE.length,\n"
        "  arcs: arcs.length, fileRejeu: queue.length, fenetre5min: EV.length }; } };\n});\n" % j(VERSION))

    details = []
    for s in cfg["sources"]:
        spl = lire_spl(os.path.join(dossier, s["search_file"])).replace("$WINDOW_START$", "0")
        details.append({"nom": nom_recherche(s), "libelle": s["label"], "couleur": s["color"], "base": base(spl),
                        "source": spl if spl.startswith("|") else "search " + spl,
                        "demo": bool(s.get("demo", "/demo/" in s["search_file"].replace("\\", "/")))})
    config_js = (
        "/* %s - configuration. Genere par build.py. */\n" % cfg["app"]["label"] + entete +
        "var APP = %s;\nvar VERSION = %s;\nvar TITRE = %s;\nvar SUMMARY = %s;\nvar PHOTOS = %s;\n"
        "var DETAILS = %s;\nvar RECHERCHES = %s;\nvar SITES = %s;\n"
        "var FENETRE = %s;\nvar NORMALISATION = %s;\nvar META = %s;\nvar MODELES = %s;\n\n"
        % (j(APP), j(VERSION), j(" ".join(x for x in (page_cfg.get("title"), page_cfg.get("subtitle")) if x)),
           j(cfg.get("summary_index", "summary")), j(photos), j(details),
           j([d["nom"] for d in details] + ["wall_cumul"]), j([s["id"] for s in cfg["sites"]]),
           j({"debut": DEBUT, "fin": FIN}),
           # la meme normalisation que les sources de la configuration ; __LIBELLE__
           # est remplace par le libelle (entre guillemets) de la source ajoutee
           j(normalisation(cfg, {"label": "__LIBELLE__"}).replace('"__LIBELLE__"', "__LIBELLE__")),
           j(META), j(modeles(LANGUE))) +
        "var SITES_CFG = %s;\nvar SITE_DEFAUT = %s;\n\n" % (j(cfg["sites"]), j(cfg["default_site"])) +
        tjs(lire(os.path.join(RACINE, "splunk_app", "src", "config.js"))) + "\n});\n")

    JS, CSS = "wall-%s.js" % VERSION, "wall-%s.css" % VERSION
    CJS, CCSS = "config-%s.js" % VERSION, "config-%s.css" % VERSION
    ecriture = ", ".join(cfg["app"].get("roles_write", ["admin", "sc_admin"]))
    conf_roles = ", ".join(cfg["app"].get("roles_config", ["*"]))
    lookups = sorted(f for f in os.listdir(os.path.join(RACINE, "splunk_app", "assets", "lookups")) if f.endswith(".csv"))

    fichiers = {
        "default/app.conf": textwrap.dedent("""\
            [install]
            state = enabled

            [ui]
            is_visible = true
            label = %s

            [launcher]
            author = %s
            description = Mur des attaques du SOC : carte, cumuls du jour, flux en direct et relecture.
            version = %s

            [id]
            name = %s
            version = %s

            [package]
            id = %s
            check_for_updates = %s
            """) % (cfg["app"]["label"], cfg["app"].get("author", "SOC"), VERSION, APP, VERSION, APP,
                    # Splunkbase refuse une appli qui desactive la verification des mises a jour ;
                    # AppInspect conseille de la desactiver pour une appli privee (avertissement)
                    "true" if cfg["app"].get("check_for_updates", True) else "false"),
        "default/data/ui/nav/default.xml": ('<nav search_view="search">\n  <view name="configuration" default="true" />\n'
                                            '  <view name="%s" />\n  <view name="search" />\n</nav>\n' % VUE),
        "default/data/ui/views/%s.xml" % VUE: textwrap.dedent("""\
            <dashboard version="1.1" script="%s" stylesheet="%s"
                       hideChrome="true" hideSplunkBar="true" hideAppBar="true" hideEdit="true"
                       hideFilters="true" hideTitle="true" hideFooter="true">
              <label>Mur</label>
              <row><panel><html><div id="wall-root">Chargement du mur…</div></html></panel></row>
            </dashboard>
            """) % (JS, CSS),
        "default/data/ui/views/configuration.xml": textwrap.dedent("""\
            <dashboard version="1.1" script="%s" stylesheet="%s" theme="dark"
                       hideEdit="true" hideFilters="true" hideTitle="true">
              <label>Configuration</label>
              <row><panel><html><div id="config-root">Chargement de la configuration…</div></html></panel></row>
            </dashboard>
            """) % (CJS, CCSS),
        "default/savedsearches.conf": savedsearches(cfg, dossier),
        "default/collections.conf": textwrap.dedent("""\
            # KV store plutot que des CSV livres dans l'appli, qu'une mise a jour ecraserait.
            [wall_planning]
            field.date = string
            field.en_service_1 = string
            field.en_service_2 = string
            field.astreinte = string

            # Analystes : nom affiche et photo (data URI JPEG 200 x 200), cle = prenom normalise.
            [wall_analystes]
            field.nom = string
            field.photo = string

            # Sources ajoutees depuis la page de configuration (cle = id ; la recherche
            # planifiee s'appelle wall_<id>) : libelle, couleur, recherche de la source.
            [wall_sources]
            field.label = string
            field.color = string
            field.search = string
            field.lookback = number
            field.priority = bool

            # Sites ajoutes depuis la page de configuration (cle = id, la valeur du champ dc).
            [wall_sites]
            field.label = string
            field.lat = number
            field.lon = number
            field.dx = number
            field.dy = number

            # Clients : table site (host) -> client, pour la colonne Client du flux.
            [wall_clients]
            field.host = string
            field.client = string
            """),
        "default/transforms.conf": textwrap.dedent("""\
            [wall_planning]
            external_type = kvstore
            collection = wall_planning
            fields_list = _key, date, en_service_1, en_service_2, astreinte

            [wall_analystes]
            external_type = kvstore
            collection = wall_analystes
            fields_list = _key, nom, photo

            [wall_sources]
            external_type = kvstore
            collection = wall_sources
            fields_list = _key, label, color, search, lookback, priority

            [wall_sites]
            external_type = kvstore
            collection = wall_sites
            fields_list = _key, label, lat, lon, dx, dy

            # lookup site -> client (joker : *.client.example.org)
            [wall_clients]
            external_type = kvstore
            collection = wall_clients
            fields_list = _key, host, client
            """) + "".join("\n[%s]\nfilename = %s\n" % (os.path.splitext(f)[0], f) for f in lookups),
        "metadata/default.meta": textwrap.dedent("""\
            # Lecture pour tous (dont le compte d'affichage), ecriture pour les admins.
            []
            access = read : [ * ], write : [ admin, sc_admin ]
            export = none

            # Equipe : modifiable par les roles de app.roles_write
            [collections/wall_planning]
            access = read : [ * ], write : [ %s ]
            [transforms/wall_planning]
            access = read : [ * ], write : [ %s ]
            [collections/wall_analystes]
            access = read : [ * ], write : [ %s ]
            [transforms/wall_analystes]
            access = read : [ * ], write : [ %s ]

            # Sources : lisibles par tous (le mur y prend libelles et couleurs),
            # modifiables par les admins (ajouter une source cree une recherche planifiee)
            [collections/wall_sources]
            access = read : [ * ], write : [ admin, sc_admin ]
            [transforms/wall_sources]
            access = read : [ * ], write : [ admin, sc_admin ]
            [collections/wall_sites]
            access = read : [ * ], write : [ admin, sc_admin ]
            [transforms/wall_sites]
            access = read : [ * ], write : [ admin, sc_admin ]
            [collections/wall_clients]
            access = read : [ * ], write : [ admin, sc_admin ]
            [transforms/wall_clients]
            access = read : [ * ], write : [ admin, sc_admin ]

            # Configuration : vue par defaut de l'appli, lisible par les roles de
            # app.roles_config (defaut : tous). Les ecritures restent limitees par
            # les droits sur les collections et les recherches.
            [views/configuration]
            access = read : [ %s ], write : [ admin, sc_admin ]
            """) % (ecriture, ecriture, ecriture, ecriture, conf_roles),
        "README.txt": (textwrap.dedent("""\
            %s
            %s

            SOC attack wall, hosted in Splunk.
            Dashboards: "wall" (to display) and "configuration" (checks, sources,
            analysts, schedule, search status, troubleshooting).

            Scheduled searches (every 5 min): wall_<source> copy each slice into
            the %s index; wall_cumul derives today's counters from it.

            Source project and documentation: see the project repository (README.en.md).
            Fonts: Barlow Semi Condensed (SIL OFL 1.1, appserver/static/fonts),
            Twemoji flags (CC-BY 4.0, Twitter, Inc. and contributors).
            """) if LANGUE == "en" else textwrap.dedent("""\
            %s
            %s

            Mur des attaques du SOC, heberge dans Splunk.
            Tableaux de bord : "mur" (a afficher) et "configuration" (verifications,
            analystes, planning, etat des recherches, depannage).

            Recherches planifiees (toutes les 5 min) : wall_<source> copient chaque
            tranche dans l'index %s ; wall_cumul en tire les compteurs du jour.

            Projet source et documentation : voir le depot du projet (README.md).
            Polices : Barlow Semi Condensed (SIL OFL 1.1, appserver/static/fonts),
            drapeaux Twemoji (CC-BY 4.0, Twitter, Inc. et contributeurs).
            """)) % (cfg["app"]["label"], "=" * len(cfg["app"]["label"]), cfg.get("summary_index", "summary")),
        "appserver/static/" + CSS: polices + css + DANS_SPLUNK,
        "appserver/static/" + JS: wall_js,
        "appserver/static/" + CJS: config_js,
        "appserver/static/" + CCSS: polices + lire(os.path.join(RACINE, "splunk_app", "src", "config.css")) +
                                    ":root{--accent:%s}\n" % page_cfg["accent"],
    }

    if os.path.exists(os.path.join(sortie, "build")):
        shutil.rmtree(os.path.join(sortie, "build"))
    for chemin, contenu in fichiers.items():
        p = os.path.join(OUT, chemin)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if chemin.startswith("default/") and not chemin.endswith("savedsearches.conf"):
            contenu = ttx(contenu)
        elif chemin.endswith("savedsearches.conf"):          # descriptions seulement, jamais les recherches
            contenu = "\n".join(ttx(l) if l.startswith("description = ") else l for l in contenu.split("\n"))
        ecrire(p, contenu)
    shutil.copytree(os.path.join(RACINE, "splunk_app", "assets", "fonts"), os.path.join(OUT, "appserver", "static", "fonts"))
    os.makedirs(os.path.join(OUT, "lookups"))
    for f in lookups:
        traduit = os.path.join(RACINE, "splunk_app", "assets", "lookups", LANGUE, f)
        shutil.copy(traduit if os.path.isfile(traduit) else os.path.join(RACINE, "splunk_app", "assets", "lookups", f),
                    os.path.join(OUT, "lookups", f))
    os.makedirs(os.path.join(OUT, "appserver", "static", "team"))
    for n in photos:
        shutil.copy(os.path.join(team, n + ".jpg"), os.path.join(OUT, "appserver", "static", "team"))
    # icones de l'appli : splunk_app/assets/static/appIcon*.png (36 x 36 et 72 x 72,
    # tailles controlees par AppInspect), sinon un carre de la couleur d'accent
    os.makedirs(os.path.join(OUT, "static"))
    icones = os.path.join(RACINE, "splunk_app", "assets", "static")
    for nom, t in (("appIcon.png", 36), ("appIcon_2x.png", 72), ("appIconAlt.png", 36), ("appIconAlt_2x.png", 72)):
        if os.path.isfile(os.path.join(icones, nom)):
            shutil.copy(os.path.join(icones, nom), os.path.join(OUT, "static", nom))
        elif not nom.startswith("appIconAlt"):
            ecrire(os.path.join(OUT, "static", nom), png_uni(t, page_cfg["accent"]))

    for d, _, fs in os.walk(OUT):
        os.chmod(d, 0o755)
        for f in fs:
            os.chmod(os.path.join(d, f), 0o644)
    os.makedirs(DIST, exist_ok=True)
    tgz = os.path.join(DIST, "%s-%s.tgz" % (APP, VERSION))
    with tarfile.open(tgz, "w:gz", format=tarfile.USTAR_FORMAT) as t:
        def neutre(ti):
            ti.uid = ti.gid = 0; ti.uname = ti.gname = ""; ti.mtime = 0
            return ti
        t.add(OUT, arcname=APP, filter=neutre)

    # apercu autonome : la page en simulation, avec cette configuration
    tete = i18n.locale(page[:page.index('<div id="wall">')], LANGUE)
    apercu = (tete + balisage + "\n<script>window.WALL_CONFIG = %s;</script>\n<script>" % j(wall_config) +
              script + "</script>\n</body>\n</html>\n")
    ap = os.path.join(DIST, "apercu.html")
    ecrire(ap, apercu)
    return tgz, ap


def main(argv=None):
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("--config", help="fichier de configuration (defaut : config/wall.json, sinon config/wall.example.json)")
    a.add_argument("--sortie", help="dossier ou ecrire build/ et dist/ (defaut : racine du projet)")
    a.add_argument("--verifier", action="store_true", help="valider la configuration sans rien produire")
    o = a.parse_args(argv)
    chemin = o.config or next(p for p in (os.path.join(RACINE, "config", "wall.json"),
                                          os.path.join(RACINE, "config", "wall.example.json")) if os.path.exists(p))
    cfg, dossier = charger(chemin)
    try:
        if o.verifier:
            e = valider(cfg, dossier)
            if e:
                raise ErreurConfig(e)
            print("configuration valide :", os.path.relpath(chemin))
            return 0
        tgz, ap = construire(cfg, dossier, o.sortie)
    except ErreurConfig as e:
        print("Configuration invalide (%s) :\n%s" % (os.path.relpath(chemin), e), file=sys.stderr)
        return 2
    print("configuration :", os.path.relpath(chemin))
    print("appli         :", os.path.relpath(tgz), os.path.getsize(tgz) // 1024, "Ko")
    print("apercu        :", os.path.relpath(ap))
    return 0


if __name__ == "__main__":
    sys.exit(main())
