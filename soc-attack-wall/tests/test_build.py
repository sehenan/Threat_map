"""Tests hors ligne : configuration, recherches generees, paquet de l'appli.

    python3 -m unittest discover -s tests -v

Aucun Splunk requis. Les jeux de tests SPL (a executer sur un Splunk) sont dans
tests/splunk/run.py.
"""
import copy, datetime, glob, json, os, re, shutil, subprocess, sys, tarfile, tempfile, unittest

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RACINE)
sys.path.insert(0, os.path.join(RACINE, "tests", "splunk"))
import build  # noqa: E402
import i18n   # noqa: E402

EXEMPLE = os.path.join(RACINE, "config", "wall.example.json")


def lire_conf(texte):
    """Mini-lecteur de .conf Splunk : sections, cle = valeur, lignes continuees par \\."""
    sections, cour, cle = {}, None, None
    for l in texte.splitlines():
        if cle and cour is not None and sections[cour][cle].endswith("\\"):
            sections[cour][cle] = sections[cour][cle][:-1] + "\n" + l
            continue
        cle = None
        if not l.strip() or l.lstrip().startswith("#"):
            continue
        m = re.match(r"^\[(.+)\]$", l.strip())
        if m:
            cour = m.group(1); sections[cour] = {}; continue
        k, _, v = l.partition("=")
        cle = k.strip(); sections[cour][cle] = v.strip()
    return sections


class Configuration(unittest.TestCase):
    def setUp(self):
        self.cfg, self.dossier = build.charger(EXEMPLE)

    def test_exemple_valide(self):
        self.assertEqual(build.valider(self.cfg, self.dossier), [])

    def test_commentaires_ignores(self):
        self.assertNotIn("_lisez_moi", self.cfg)

    def erreurs(self, modif):
        c = copy.deepcopy(self.cfg); modif(c)
        return " ".join(build.valider(c, self.dossier))

    def test_site_en_double(self):
        self.assertIn("ids en double", self.erreurs(lambda c: c["sites"].append(dict(c["sites"][0]))))

    def test_site_par_defaut_inconnu(self):
        self.assertIn("default_site", self.erreurs(lambda c: c.update(default_site="NULLE-PART")))

    def test_couleur_invalide(self):
        self.assertIn("color", self.erreurs(lambda c: c["sources"][0].update(color="bleu")))

    def test_fichier_de_recherche_absent(self):
        self.assertIn("search_file", self.erreurs(lambda c: c["sources"][0].update(search_file="absent.spl")))

    def test_libelle_avec_guillemet(self):
        self.assertIn("label", self.erreurs(lambda c: c["sources"][0].update(label='W"AF')))

    def test_coordonnees_hors_limites(self):
        self.assertIn("lat/lon", self.erreurs(lambda c: c["sites"][0].update(lat=123)))

    def test_id_appli(self):
        self.assertIn("app.id", self.erreurs(lambda c: c["app"].update(id="Mon Appli")))


class Recherches(unittest.TestCase):
    def setUp(self):
        self.cfg, self.dossier = build.charger(EXEMPLE)

    def test_pas_de_search_en_tete(self):
        for s in self.cfg["sources"]:
            spl = build.detail(self.cfg, s, self.dossier)
            self.assertFalse(re.match(r"^\s*search\s", spl), s["id"])

    def test_commentaires_retires(self):
        for s in self.cfg["sources"]:
            self.assertNotIn("```", build.detail(self.cfg, s, self.dossier))

    def test_normalisation_et_meta(self):
        for s in self.cfg["sources"]:
            spl = build.detail(self.cfg, s, self.dossier)
            self.assertIn('| iplocation src_ip prefix="wall_"', spl)
            self.assertIn("| table " + ", ".join(build.CHAMPS), spl)
            self.assertTrue(spl.rstrip().endswith("fields meta debut n _time ]"))
            self.assertIn('source_tech = "%s"' % s["label"], spl)

    def test_sites_dans_la_normalisation(self):
        n = build.normalisation(self.cfg, self.cfg["sources"][0])
        for site in self.cfg["sites"]:
            self.assertIn('dc == "%s", %s' % (site["id"], site["lat"]), n)
        self.assertIn('"%s")' % self.cfg["default_site"], n)

    def test_pays_exclus(self):
        c = copy.deepcopy(self.cfg); c["origins"]["exclude_countries"] = ["Atlantis"]
        self.assertIn('| where NOT in(Country, "Atlantis")', build.normalisation(c, c["sources"][0]))

    def test_debut_de_fenetre(self):
        d = tempfile.mkdtemp()
        try:
            build.ecrire(os.path.join(d, "s.spl"), "index=x | where _time >= $WINDOW_START$")
            c = copy.deepcopy(self.cfg); c["sources"] = [dict(c["sources"][0], search_file="s.spl")]
            spl = build.detail(c, c["sources"][0], d)
            self.assertIn('_time >= relative_time(now(), "-7m@m")', spl)
        finally:
            shutil.rmtree(d)

    def test_cumul_dedoublonne(self):
        spl = build.cumul(self.cfg)
        self.assertIn(build.UNIQUE_SH, spl)
        # toutes les recherches wall_*, y compris celles ajoutees depuis la configuration
        self.assertIn("search_name=wall_* search_name!=wall_cumul", spl)

    def test_modeles_proposes(self):
        m = build.modeles()
        self.assertEqual({x["id"] for x in m},
                         {os.path.basename(os.path.dirname(d)) for d in glob.glob(os.path.join(RACINE, "templates", "sources", "*", ""))})
        self.assertTrue(all(x["titre"] and x["spl"] for x in m))

    def test_guillemets_echappes(self):
        self.assertEqual(build.q('a"b'), '"a\\"b"')


class Paquet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cfg, dossier = build.charger(EXEMPLE)
        cls.tgz, cls.apercu = build.construire(cls.cfg, dossier, cls.tmp)
        cls.app = os.path.join(cls.tmp, "build", cls.cfg["app"]["id"])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def test_fichiers(self):
        v = self.cfg["app"]["version"]
        for f in ["default/app.conf", "default/savedsearches.conf", "default/collections.conf",
                  "default/transforms.conf", "metadata/default.meta", "default/data/ui/views/mur.xml",
                  "default/data/ui/views/configuration.xml", "appserver/static/wall-%s.js" % v,
                  "appserver/static/config-%s.js" % v, "lookups/wall_demo_origins.csv", "static/appIcon.png"]:
            self.assertTrue(os.path.isfile(os.path.join(self.app, f)), f)

    def test_recherches_planifiees(self):
        conf = lire_conf(build.lire(os.path.join(self.app, "default", "savedsearches.conf")))
        attendues = {"wall_" + s["id"] for s in self.cfg["sources"]} | {"wall_cumul"}
        self.assertEqual(set(conf), attendues)
        for nom, c in conf.items():
            self.assertEqual(c["allow_skew"], "0", nom)
            self.assertEqual(c["enableSched"], "1", nom)
            self.assertFalse(c["search"].startswith("search "), nom)
            if nom != "wall_cumul":
                self.assertEqual(c["action.summary_index._name"], self.cfg.get("summary_index", "summary"))

    def test_icones(self):
        import struct
        for nom, t in (("appIcon.png", 36), ("appIcon_2x.png", 72), ("appIconAlt.png", 36), ("appIconAlt_2x.png", 72)):
            png = build.lire(os.path.join(self.app, "static", nom), "rb")
            self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n", nom)
            self.assertEqual(struct.unpack(">II", png[16:24]), (t, t), nom)

    def test_splunkbase(self):
        # Splunkbase refuse check_for_updates = false
        self.assertIn("check_for_updates = true", build.lire(os.path.join(self.app, "default", "app.conf")))

    def test_accueil_sur_la_configuration(self):
        nav = build.lire(os.path.join(self.app, "default", "data", "ui", "nav", "default.xml"))
        self.assertIn('<view name="configuration" default="true" />', nav)
        self.assertEqual(nav.count('default="true"'), 1)
        meta = build.lire(os.path.join(self.app, "metadata", "default.meta"))
        # vue d'accueil lisible par tous par defaut (dont le compte de l'ecran)
        self.assertRegex(meta, r"\[views/configuration\]\naccess = read : \[ \* \]")

    def test_paquet(self):
        with tarfile.open(self.tgz) as t:
            noms = t.getnames()
            self.assertTrue(all(n.startswith(self.cfg["app"]["id"]) for n in noms))
            self.assertTrue(all(m.uid == 0 and m.uname == "" for m in t.getmembers()))

    def test_apercu(self):
        html = build.lire(self.apercu)
        self.assertIn("window.WALL_CONFIG = ", html)
        self.assertNotIn("search_file", html)       # les recherches ne partent pas dans la page

    @unittest.skipUnless(shutil.which("node"), "node absent")
    def test_javascript(self):
        for f in glob.glob(os.path.join(self.app, "appserver", "static", "*.js")):
            r = subprocess.run(["node", "--check", f], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)

    @unittest.skipUnless(shutil.which("node"), "node absent")
    def test_javascript_page_seule(self):
        page = build.lire(os.path.join(RACINE, "web", "index.html"))
        js = page[page.index("<script>") + 8: page.rindex("</script>")]
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(js)
        try:
            r = subprocess.run(["node", "--check", f.name], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
        finally:
            os.unlink(f.name)


class SourceAjoutee(unittest.TestCase):
    """Une source ajoutee depuis la page de configuration doit donner exactement
    la recherche que build.py produit pour la meme source."""

    @unittest.skipUnless(shutil.which("node"), "node absent")
    def test_meme_recherche_que_build(self):
        cfg, dossier = build.charger(EXEMPLE)
        js = build.lire(os.path.join(RACINE, "splunk_app", "src", "config.js"))
        fonctions = "".join(re.search(r"(function %s\(.*?\n\})" % n, js, re.S).group(1) + "\n"
                            for n in ("nettoyerSpl", "splComplete"))
        entree = [{"label": s["label"], "spl": build.lire(os.path.join(dossier, s["search_file"]))} for s in cfg["sources"]]
        prog = ("var FENETRE = %s, META = %s, NORMALISATION = %s;\n%s"
                "var e = %s; process.stdout.write(JSON.stringify(e.map(function (x) { return splComplete(x.label, x.spl); })));"
                % (json.dumps({"debut": build.DEBUT, "fin": build.FIN}), json.dumps(build.META),
                   json.dumps(build.normalisation(cfg, {"label": "__LIBELLE__"}).replace('"__LIBELLE__"', "__LIBELLE__")),
                   fonctions, json.dumps(entree)))
        r = subprocess.run(["node", "-e", prog], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        for s, obtenu in zip(cfg["sources"], json.loads(r.stdout)):
            self.assertEqual(obtenu, build.detail(cfg, s, dossier), s["id"])

    def test_fenetre_de_lot(self):
        d = tempfile.mkdtemp()
        try:
            build.ecrire(os.path.join(d, "s.spl"), "``` commentaire ```\nsearch index=x\n| where _time >= $WINDOW_START$")
            cfg, _ = build.charger(EXEMPLE)
            c = copy.deepcopy(cfg); c["sources"] = [dict(c["sources"][0], search_file="s.spl")]
            spl = build.detail(c, c["sources"][0], d)
            self.assertTrue(spl.startswith("index=x\n| where _time >= relative_time"))
        finally:
            shutil.rmtree(d)


class Anglais(unittest.TestCase):
    """Version anglaise : config/wall.example.en.json ("language": "en")."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cfg, dossier = build.charger(os.path.join(RACINE, "config", "wall.example.en.json"))
        cls.tgz, cls.apercu = build.construire(cls.cfg, dossier, cls.tmp)
        cls.app = os.path.join(cls.tmp, "build", cls.cfg["app"]["id"])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def js(self, prefixe):
        f = glob.glob(os.path.join(self.app, "appserver", "static", prefixe + "-*.js"))[0]
        # la table des pays (noms anglais de la base GeoIP) n'est pas de l'interface
        return "\n".join(l for l in build.lire(f).split("\n") if not l.startswith("const ISO = "))

    def test_aucun_texte_francais(self):
        for p in ("wall", "config"):
            restes = i18n.restes_francais(self.js(p), permis=("Chloé", "sans-serif"))
            self.assertEqual(restes, [], "%s : textes non traduits (ajouter a i18n/en.json)" % p)

    def test_fichiers_de_l_appli(self):
        for f in ("default/data/ui/views/wall.xml", "default/data/ui/views/configuration.xml",
                  "default/data/ui/nav/default.xml", "default/app.conf"):
            texte = re.sub(r"<[^>]+>", " ", build.lire(os.path.join(self.app, f)))
            self.assertFalse(i18n.FRANCAIS.search(texte), f)
        self.assertIn('<view name="wall" />', build.lire(os.path.join(self.app, "default", "data", "ui", "nav", "default.xml")))
        self.assertFalse(os.path.exists(os.path.join(self.app, "default", "data", "ui", "views", "mur.xml")))

    def test_formats_et_donnees_de_demo(self):
        for p in ("wall", "config"):
            self.assertNotIn('"fr-FR"', self.js(p))
            self.assertIn('"en-GB"', self.js(p))
        sig = build.lire(os.path.join(self.app, "lookups", "wall_demo_signatures.csv"))
        self.assertIn("Phishing", sig)
        self.assertFalse(i18n.FRANCAIS.search(sig))
        self.assertIn('<html lang="en"', build.lire(self.apercu))

    @unittest.skipUnless(shutil.which("node"), "node absent")
    def test_javascript(self):
        for f in glob.glob(os.path.join(self.app, "appserver", "static", "*.js")):
            r = subprocess.run(["node", "--check", f], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)

    def test_modeles_en_anglais(self):
        for m in build.modeles("en"):
            self.assertFalse(i18n.FRANCAIS.search(m["titre"]), m["titre"])
            self.assertNotIn("```", m["spl"])
            self.assertNotIn("Origine masquée", m["spl"])
        self.assertTrue(all("Template:" not in m["spl"] for m in build.modeles("fr")))

    def test_recherches_intactes(self):
        # la traduction ne touche que les descriptions, jamais le SPL
        fr_cfg, d = build.charger(EXEMPLE)
        en = lire_conf(build.lire(os.path.join(self.app, "default", "savedsearches.conf")))
        self.assertEqual(en["wall_waf"]["search"].split("| eval source_tech")[0],
                         build.detail(fr_cfg, fr_cfg["sources"][0], d).split("| eval source_tech")[0].replace("\n", " \n"))
        self.assertEqual(en["wall_waf"]["description"], "Wall - source WAF")


class Dictionnaire(unittest.TestCase):
    def test_chaque_entree_sert(self):
        """Une entree qui ne correspond plus a aucun texte du code est une traduction perdue."""
        d = i18n.charger("en")
        page = build.lire(os.path.join(RACINE, "web", "index.html"))
        sources = [page, build.lire(os.path.join(RACINE, "splunk_app", "src", "config.js")),
                   build.lire(os.path.join(RACINE, "splunk_app", "src", "source_splunk.js")),
                   build.lire(os.path.join(RACINE, "build.py"))]
        segs = set()
        for src in sources[:3]:
            for a, b, q in i18n.segments(src):
                segs.add(src[a:b].replace("\\" + q, q) if q != "`" else src[a:b])
        inutiles = [k for k in d if (k[1:] not in segs if k.startswith("=")
                                     else not any(k in s.replace("\\'", "'") for s in sources))]
        self.assertEqual(inutiles, [])

    def test_segments_js(self):
        src = 'var a = "x\\"y", r = /["\']/g; b(`t ${c ? `u` : "v"} w`); // "commentaire"'
        self.assertEqual([src[a:b] for a, b, _ in i18n.segments(src)], ['x\\"y', "t ", "u", "v", " w"])

    def test_cle_chaine_entiere(self):
        self.assertEqual(i18n.traduire_js('f("vide", "<tr class=\\"vide\\">")', {"=vide": "empty"}),
                         'f("empty", "<tr class=\\"vide\\">")')

    def test_apostrophe_reechappee(self):
        self.assertEqual(i18n.traduire_js("x = 'Aujourd\\'hui';", {"=Aujourd'hui": "Today's"}), "x = 'Today\\'s';")


class TranchesHoraires(unittest.TestCase):
    """Le cumul fournit des horodatages absolus (t5) : la tranche affichee est
    celle de l'heure du poste, quel que soit le fuseau du compte Splunk."""

    @unittest.skipUnless(shutil.which("node"), "node absent")
    def test_conversion_dans_l_heure_du_poste(self):
        js = build.lire(os.path.join(RACINE, "splunk_app", "src", "source_splunk.js"))
        f = "".join(re.search(r"(%s.*?\n\}\);?\n|%s.*?\n\}\n)" % (re.escape(n), re.escape(n)), js, re.S).group(0)
                    for n in ("var vide = function", "function versDims("))
        t5 = int(datetime.datetime(2026, 9, 27, 12, 20, tzinfo=datetime.timezone.utc).timestamp())   # 14:20 a Paris
        prog = f + "process.stdout.write(JSON.stringify(versDims([{count:'7', t5:'%d.000'}])));" % t5
        r = subprocess.run(["node", "-e", prog], capture_output=True, text=True, env=dict(os.environ, TZ="Europe/Paris"))
        self.assertEqual(r.returncode, 0, r.stderr)
        dims = {d["dim"]: d["count"] for d in json.loads(r.stdout)}
        self.assertEqual(dims.get("m5|1420"), "7")
        self.assertEqual(dims.get("hour|14"), "7")

    def test_cumul_sans_strftime(self):
        cfg, _ = build.charger(EXEMPLE)
        spl = build.cumul(cfg)
        self.assertIn("t5 = _time - (_time % 300)", spl)
        self.assertNotIn("strftime", spl.split("| appendpipe")[0])


class Modeles(unittest.TestCase):
    def test_chaque_modele_a_son_jeu_de_test(self):
        dossiers = glob.glob(os.path.join(RACINE, "templates", "sources", "*", ""))
        self.assertTrue(dossiers)
        for d in dossiers:
            for f in ("source.spl", "fixture.spl", "attendu.json"):
                self.assertTrue(os.path.isfile(os.path.join(d, f)), d + f)
            a = json.loads(build.lire(os.path.join(d, "attendu.json")))
            self.assertIsInstance(a["lignes"], int)
            spl = build.lire_spl(os.path.join(d, "source.spl"))
            self.assertIn("\n|", spl, "une recherche de base puis au moins une commande")
            self.assertRegex(spl, r"\| fields _time, src_ip", d)

    def test_lookups_integres(self):
        import run
        spl = run.lookups_integres("| lookup wall_demo_signatures source, s OUTPUT signature, severity")
        self.assertTrue(spl.startswith("| join type=left source, s [| makeresults format=csv data=\"source,s,"))
        self.assertIn("| fields source, s, signature, severity]", spl)


if __name__ == "__main__":
    unittest.main()
