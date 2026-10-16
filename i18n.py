"""Traduction de l'interface a la construction (build.py, "language" dans la configuration).

Le code source reste en francais. Pour une autre langue, i18n/<langue>.json associe
chaque texte francais affiche a sa traduction. La traduction ne touche que les
chaines de caracteres du JavaScript (pas les noms de fonctions ou de variables) et
les textes du balisage HTML ; tests/test_build.py verifie qu'aucun texte francais
ne reste dans l'appli construite et que chaque entree du dictionnaire sert encore.
"""
import json, os, re

ICI = os.path.dirname(os.path.abspath(__file__))
LOCALES = {"fr": "fr-FR", "en": "en-GB"}   # en-GB : heure sur 24 h, date jour/mois


def charger(langue):
    if langue == "fr":
        return {}
    with open(os.path.join(ICI, "i18n", langue + ".json"), encoding="utf-8") as f:
        return {k: v for k, v in json.load(f).items() if not k.startswith("_")}


# ------------------------------------------------------------------ analyse du JavaScript
def segments(src):
    """Positions (debut, fin, guillemet) du contenu de chaque chaine de caracteres :
    '...', "...", et le texte des gabarits `...${expr}...` (expressions analysees
    elles aussi). Commentaires et expressions regulieres sont sautes."""
    out = []
    n = len(src)

    def code(i, dans_expr):
        prec, mot, prof = "", "", 0
        while i < n:
            c = src[i]
            if dans_expr:
                if c == "{":
                    prof += 1
                elif c == "}":
                    if prof == 0:
                        return i + 1
                    prof -= 1
            if c == "/" and src[i + 1:i + 2] == "/":
                j = src.find("\n", i)
                i = n if j < 0 else j
                continue
            if c == "/" and src[i + 1:i + 2] == "*":
                j = src.find("*/", i + 2)
                i = n if j < 0 else j + 2
                continue
            if c in "\"'":
                j = i + 1
                while j < n and src[j] != c and src[j] != "\n":
                    j += 2 if src[j] == "\\" else 1
                out.append((i + 1, j, c))
                i, prec, mot = j + 1, "a", ""
                continue
            if c == "`":
                j, debut = i + 1, i + 1
                while j < n and src[j] != "`":
                    if src[j] == "\\":
                        j += 2
                        continue
                    if src[j:j + 2] == "${":
                        out.append((debut, j, "`"))
                        j = code(j + 2, True)
                        debut = j
                        continue
                    j += 1
                out.append((debut, j, "`"))
                i, prec, mot = j + 1, "a", ""
                continue
            if c == "/" and (prec in "(,=:[!&|?{};+-*%<>~^" or mot in ("return", "typeof", "case")):
                j, classe = i + 1, False
                while j < n and src[j] != "\n":
                    if src[j] == "\\":
                        j += 2
                        continue
                    if src[j] == "[":
                        classe = True
                    elif src[j] == "]":
                        classe = False
                    elif src[j] == "/" and not classe:
                        break
                    j += 1
                i = j + 1
                while i < n and src[i].isalpha():
                    i += 1
                prec, mot = "a", ""
                continue
            if c.isalnum() or c in "_$":
                mot = mot + c if prec == "w" else c
                prec = "w"
            elif not c.isspace():
                prec, mot = c, ""
            i += 1
        return i

    code(0, False)
    return out


def _remplacer(texte, dico, cles):
    """Cle "=texte" : seulement si la chaine entiere vaut texte. Autres cles : partout."""
    if "=" + texte in dico:
        return dico["=" + texte]
    for k in cles:
        if k in texte:
            texte = texte.replace(k, dico[k])
    return texte


def traduire_js(src, dico):
    """Traduit les chaines d'un source JavaScript. Les cles et valeurs du dictionnaire
    sont ecrites sans echappement ; l'apostrophe ou le guillemet delimitant la chaine
    est re-echappe au besoin."""
    if not dico:
        return src
    cles = sorted((k for k in dico if not k.startswith("=")), key=len, reverse=True)
    morceaux, pos = [], 0
    for a, b, q in segments(src):
        brut = src[a:b]
        texte = brut.replace("\\" + q, q) if q != "`" else brut
        trad = _remplacer(texte, dico, cles)
        if trad != texte:
            brut = trad.replace(q, "\\" + q) if q != "`" else trad.replace("`", "\\`")
        morceaux.append(src[pos:a]); morceaux.append(brut); pos = b
    morceaux.append(src[pos:])
    return "".join(morceaux)


def traduire_texte(texte, dico):
    """Balisage HTML ou texte simple : remplacement direct (cles specifiques)."""
    if not dico:
        return texte
    for k in sorted((k for k in dico if not k.startswith("=")), key=len, reverse=True):
        texte = texte.replace(k, dico[k])
    return texte


def locale(src, langue):
    """Formats de date et de nombre, langue du document."""
    if langue == "fr":
        return src
    return src.replace('"fr-FR"', '"%s"' % LOCALES[langue]).replace('<html lang="fr"', '<html lang="%s"' % langue)


# ------------------------------------------------------------------ controle
# Mots qui n'existent pas en anglais : un texte qui en contient est reste en francais.
FRANCAIS = re.compile(
    r"[éèêëàâùûçôîïœÉÈÀÇ]|\b(le|la|les|des|du|une|et|pour|sur|avec|sans|dans|aux|au|est|sont|pas|ou|"
    r"jours?|heures?|aucune?|depuis|analystes?|recherches?|appli|mur|enregistr\w*|supprim\w*|ajout\w*|"
    r"attaques?|pays|cible|bloqu\w*|semaine|astreinte|planifi\w*|passages?|ligne|lignes|fichier|photo prête|"
    r"relecture|vide|nouveau|dernier|derniers|prochain|erreur|erreurs|chargement|voir|saisir|fermer|annuler|"
    r"modifier|valider|tester|activer|ouvrir|retirer|choisir|importer|actualiser|relancer|il y a|jamais)\b", re.I)


def restes_francais(src, permis=()):
    """Textes d'un source JavaScript encore en francais (hors recherches SPL et permis)."""
    out = []
    for a, b, _ in segments(src):
        t = src[a:b]
        if re.fullmatch(r"[a-z0-9_\-\.:#\[\]]+|[A-Z]{2}", t):
            continue                                  # identifiant, classe, code pays
        # balises, y compris coupees entre deux chaines (<button ... ou ...">)
        t_vis = re.sub(r"<[^>]*>|<[^>]*$|^[^<>]*>", " ", t)
        if not FRANCAIS.search(t_vis):
            continue
        if re.search(r"(\| (eval|stats|where|table|fields|search|rex|sort|lookup|eventstats|appendpipe|iplocation)\b|index=|"
                     r"search_name|savedsearch|sourcetype=)", t):
            continue                                  # recherche SPL : pas de l'interface
        if any(p in t for p in permis):
            continue
        out.append(t)
    return out
