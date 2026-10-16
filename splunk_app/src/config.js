/* =====================================================================
   Tableau de bord "configuration" du mur

   Demarrage   verifications apres installation, initialisation des analystes
               et du planning
   Analystes   noms et photos (KV store wall_analystes, photo en data URI
               200 x 200 : pas de fichier a deposer dans l'appli)
   Planning    2 en service + 1 d'astreinte par jour (KV store wall_planning)
   Recherches  etat des recherches planifiees de CE search head, activation,
               test a la demande
   Depannage   passages en echec, erreurs Splunk liees a l'appli

   Fournis par build.py : APP, VERSION, TITRE, SUMMARY (index), PHOTOS
   (photos livrees), DETAILS ({nom, libelle, base, demo} des recherches
   d'alimentation), RECHERCHES (toutes les recherches planifiees), SITES (ids).
   ===================================================================== */
"use strict";
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
};
function cle(nom) {                      // prenom -> identifiant (meme regle que le mur)
  return String(nom || "").trim().toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9_-]/g, "");
}
function dateIso(txt) {                  // 2026-09-28, ou 28/09/2026 saisi a la main
  txt = String(txt || "").trim();
  var m = txt.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return txt;
  m = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    var a = m[3].length === 2 ? "20" + m[3] : m[3];
    return a + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
  }
  return null;
}
var iso = function (d) {
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
};
var capital = function (k) { return k ? k.charAt(0).toUpperCase() + k.slice(1) : ""; };
var nf = new Intl.NumberFormat("fr-FR");
var LIBELLE = { wall_cumul: "Cumul du jour" };
DETAILS.forEach(function (d) { LIBELLE[d.nom] = d.libelle; });
var LIVREE = function (k) { return PHOTOS.indexOf(k) >= 0; };
var urlVignette = function (k) {
  return splunkUtil.make_url("/static/app/" + APP + "/team/" + encodeURIComponent(k) + ".jpg");
};

function heure(t) {                     // epoch (s) -> "26/09 10:02"
  if (!t) return "";
  var d = new Date(t * 1000);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) + " " +
         d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function age(t) {                       // epoch (s) -> "il y a 3 min"
  if (!t) return "jamais";
  var s = Math.max(0, Date.now() / 1000 - t);
  // gabarits complets : l'ordre des mots change d'une langue a l'autre (i18n/)
  if (s < 90) return "il y a {n} s".replace("{n}", Math.round(s));
  if (s < 5400) return "il y a {n} min".replace("{n}", Math.round(s / 60));
  if (s < 172800) return "il y a {n} h".replace("{n}", Math.round(s / 3600));
  return "il y a {n} j".replace("{n}", Math.round(s / 86400));
}
function toast(msg, genre) {
  var t = $("cf-toast");
  t.className = "cf-toast vu " + (genre || "");
  t.textContent = msg;
  clearTimeout(toast.h);
  toast.h = setTimeout(function () { t.className = "cf-toast"; }, genre === "err" ? 9000 : 4000);
}
function lienRecherche(spl, earliest) {
  var q = /^\s*(\||search\s)/.test(spl) ? spl : "search " + spl;   // pas de "search search"
  return splunkUtil.make_url("/app/" + APP + "/search") + "?q=" + encodeURIComponent(q) +
         "&earliest=" + encodeURIComponent(earliest || "-24h") + "&latest=now";
}

/* ---------------------------------------------------------------- REST
   Appels a splunkd par le proxy de Splunk Web (/splunkd/__raw), avec le
   jeton anti-CSRF de la session pour les ecritures. */
function formKey() {
  try { if (splunkUtil.getFormKey) { var k = splunkUtil.getFormKey(); if (k) return k; } } catch (e) {}
  var m = document.cookie.match(/splunkweb_csrf_token_\d+=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
/* une recherche planifiee se modifie sous son proprietaire (nobody a
   l'installation, ou le compte de service auquel le SOC l'a confiee) */
var PROPRIO = {};
function cheminRecherche(nom) {
  return "/servicesNS/" + encodeURIComponent(PROPRIO[nom] || "nobody") + "/" + APP + "/saved/searches/" + encodeURIComponent(nom);
}
function rest(methode, chemin, corps, formulaire) {
  var abs = chemin.charAt(0) === "/" ? chemin : "/servicesNS/nobody/" + APP + "/" + chemin;
  var url = splunkUtil.make_url("/splunkd/__raw" + abs);
  url += (url.indexOf("?") < 0 ? "?" : "&") + "output_mode=json";
  var h = { "X-Splunk-Form-Key": formKey(), "X-Requested-With": "XMLHttpRequest" }, b;
  if (formulaire) { h["Content-Type"] = "application/x-www-form-urlencoded"; b = new URLSearchParams(formulaire).toString(); }
  else if (corps !== undefined) { h["Content-Type"] = "application/json"; b = JSON.stringify(corps); }
  return fetch(url, { method: methode, headers: h, body: b, credentials: "same-origin" }).then(function (r) {
    return r.text().then(function (txt) {
      var j = null;
      try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
      if (!r.ok) {
        var m = j && j.messages && j.messages[0] && j.messages[0].text;
        var err = new Error(m || ("HTTP " + r.status));
        err.status = r.status;
        throw err;
      }
      return j;
    });
  });
}
var kv = {
  lire: function (c) { return rest("GET", "storage/collections/data/" + c); },
  ecrire: function (c, docs) { return rest("POST", "storage/collections/data/" + c + "/batch_save", docs); },
  suppr: function (c, k) { return rest("DELETE", "storage/collections/data/" + c + "/" + encodeURIComponent(k)); }
};

/* ---------------------------------------------------------------- recherches */
function lignes(res) {
  var d = res.data(), out = [];
  if (!d || !d.rows) return out;
  for (var i = 0; i < d.rows.length; i++) {
    var o = {};
    for (var j = 0; j < d.fields.length; j++) o[d.fields[j]] = d.rows[i][j];
    out.push(o);
  }
  return out;
}
var nRech = 0;
function chercher(spl, earliest, latest) {
  return new Promise(function (ok, ko) {
    var id = "cfg-" + (++nRech), t0 = performance.now(), fini = false, msgs = [];
    var sm = new SearchManager({
      id: id, search: spl, earliest_time: earliest || "-24h", latest_time: latest || "now",
      cache: false, preview: false, autostart: false
    });
    var res = sm.data("results", { count: 0, output_mode: "json_rows" });
    function fin(err, rows) {
      if (fini) return; fini = true;
      try { mvc.Components.revokeInstance(id); } catch (e) {}
      var d = (performance.now() - t0) / 1000;
      if (err) { err.duree = d; ko(err); } else ok({ rows: rows, duree: d, messages: msgs });
    }
    sm.on("search:done", function (p) {
      var c = (p && p.content) || {};
      msgs = (c.messages || []).filter(function (m) { return /ERROR|FATAL|WARN/.test(m.type); })
                               .map(function (m) { return m.text; });
      if (!c.resultCount) fin(null, []);
    });
    res.on("data", function () { if (res.hasData()) fin(null, lignes(res)); });
    sm.on("search:error", function (m) { fin(new Error(typeof m === "string" ? m : (m && m.message) || "erreur de recherche")); });
    sm.on("search:fail", function (p) {
      var c = (p && p.content) || {};
      fin(new Error((c.messages || []).map(function (m) { return m.text; }).join(" ; ") || "recherche en échec"));
    });
    sm.startSearch();
  });
}
/* au plus n recherches a la fois : le quota de recherches simultanees de
   l'utilisateur est partage avec le reste de Splunk Web */
function parLots(taches, n) {
  var i = 0;
  function suivante() {
    if (i >= taches.length) return Promise.resolve();
    var t = taches[i++];
    return Promise.resolve().then(t).catch(function () {}).then(suivante);
  }
  var fils = [];
  for (var k = 0; k < n; k++) fils.push(suivante());
  return Promise.all(fils);
}

/* ---------------------------------------------------------------- squelette */
var racine = document.createElement("div");
racine.id = "cf";
racine.innerHTML = [
  '<header class="cf-tete"><div><h1>Configuration du mur <span>' + esc(TITRE) + '</span></h1>',
  '<p class="cf-sous">Appli <b>' + esc(APP) + '</b> v' + esc(VERSION) + ' · search head <b id="cf-sh">…</b></p></div>',
  '<nav class="cf-nav" aria-label="Sections"><a href="#cf-demarrage">Démarrage</a><a href="#cf-sources">Sources</a><a href="#cf-sites">Sites</a><a href="#cf-clients">Clients</a><a href="#cf-analystes">Analystes</a>',
  '<a href="#cf-planning">Planning</a><a href="#cf-recherches">Recherches</a><a href="#cf-depannage">Dépannage</a>',
  '<a class="cf-btn prim" href="mur">Ouvrir le mur</a></nav></header>',

  '<section class="cf-bloc" id="cf-demarrage"><div class="cf-bloc-t"><div><h2>Démarrage</h2>',
  '<p>Vérifications à faire après l\'installation ou une mise à jour : équipe, recherches d\'alimentation, index summary, données sources.</p></div>',
  '<div class="cf-resume" id="cf-resume"></div><button id="cf-reverif" type="button">Relancer les vérifications</button></div>',
  '<ol class="cf-carte cf-checks" id="cf-checks"></ol></section>',

  '<section class="cf-bloc" id="cf-sources"><div class="cf-bloc-t"><div><h2>Sources d\'attaque</h2>',
  '<p>Chaque source est une recherche planifiée toutes les 5 minutes. Celles de la configuration de l\'appli peuvent être ',
  'désactivées ; celles ajoutées ici peuvent aussi être modifiées ou supprimées. Une source ajoutée apparaît sur le mur ',
  'à son premier passage (5 à 10 minutes).</p></div>',
  '<button id="cf-src-ajout" type="button" class="prim">Ajouter une source</button></div>',
  '<div class="cf-carte cf-form" id="cf-src-form"></div>',
  '<div class="cf-carte"><div class="cf-defil"><table class="cf-tab" id="cf-src"></table></div></div></section>',

  '<section class="cf-bloc" id="cf-sites"><div class="cf-bloc-t"><div><h2>Sites protégés</h2>',
  '<p>Les points de la carte vers lesquels convergent les attaques. Une source désigne son site par son identifiant, dans le champ ',
  '<span class="mono">dc</span> ; un identifiant inconnu est rattaché au site par défaut. Un site ajouté ici apparaît sur le mur ',
  'dans les 10 minutes.</p></div>',
  '<button id="cf-site-ajout" type="button" class="prim">Ajouter un site</button></div>',
  '<div class="cf-carte cf-form" id="cf-site-form"></div>',
  '<div class="cf-carte"><div class="cf-defil"><table class="cf-tab" id="cf-site"></table></div></div></section>',

  '<section class="cf-bloc" id="cf-clients"><div class="cf-bloc-t"><div><h2>Clients</h2>',
  '<p>À qui appartient chaque site protégé. La colonne « Client » du flux en découle. Le ',
  '<span class="mono">host</span> est le nom exact du site, tel que le WAF le journalise. ',
  'Un site vu sans client s\'affiche « à renseigner ».</p></div>',
  '<button id="cf-cl-detect" type="button">Détecter les sites non attribués</button>',
  '<button id="cf-cl-ajout" type="button" class="prim">Ajouter</button></div>',
  '<div class="cf-carte cf-form" id="cf-cl-form"></div><div id="cf-cl-nonattr"></div>',
  '<div class="cf-carte"><div class="cf-defil"><table class="cf-tab" id="cf-cl"></table></div></div></section>',

  '<section class="cf-bloc" id="cf-analystes"><div class="cf-bloc-t"><div><h2>Analystes</h2>',
  '<p>Nom affiché sur le mur et photo (recadrée en carré, 200 × 200). L\'identifiant sert à les désigner dans le planning.</p></div></div>',
  '<div id="cf-an-alerte"></div><div class="cf-analystes" id="cf-an"></div></section>',

  '<section class="cf-bloc" id="cf-planning"><div class="cf-bloc-t"><div><h2>Planning</h2>',
  '<p>Deux analystes en service et un d\'astreinte par jour. Le mur relit le planning toutes les 10 minutes.</p></div></div>',
  '<div class="cf-outils"><button id="cf-pl-prec" type="button" aria-label="Semaine précédente">‹ Semaine</button>',
  '<button id="cf-pl-auj" type="button">Cette semaine</button><button id="cf-pl-suiv" type="button" aria-label="Semaine suivante">Semaine ›</button>',
  '<span class="dis" id="cf-pl-per"></span><span class="sep"></span>',
  '<button id="cf-pl-imp" type="button">Coller depuis Excel</button>',
  '<button id="cf-pl-annul" type="button" disabled>Annuler</button>',
  '<button id="cf-pl-enr" type="button" class="prim" disabled>Enregistrer</button></div>',
  '<div class="cf-carte cf-import" id="cf-import"><p>Une ligne par jour : <b>date</b>, en service 1, en service 2, astreinte ',
  '(colonne « jour » facultative). Séparateur tabulation (copier-coller d\'Excel), point-virgule ou virgule. ',
  'Dates <span class="mono">2026-09-28</span> ou <span class="mono">28/09/2026</span>.</p>',
  '<textarea id="cf-imp-txt" spellcheck="false" placeholder="28/09/2026&#9;alice&#9;bruno&#9;chloe"></textarea>',
  '<div class="cf-outils"><button id="cf-imp-ok" type="button" class="prim">Importer dans le tableau</button>',
  '<button id="cf-imp-ferme" type="button">Fermer</button><span class="dis" id="cf-imp-res"></span></div></div>',
  '<div class="cf-carte cf-defil"><table class="cf-plan" id="cf-plan"></table></div></section>',

  '<section class="cf-bloc" id="cf-recherches"><div class="cf-bloc-t"><div><h2>Recherches planifiées</h2>',
  '<p>État sur ce search head. Les recherches d\'alimentation copient chaque tranche de 5 min dans l\'index summary ; ',
  'le cumul en tire les compteurs du jour. « Valider » contrôle les champs fournis par une source (dernière heure), ',
  '« Tester » exécute la recherche complète sur sa fenêtre, sans rien écrire.</p></div>',
  '<button id="cf-re-maj" type="button">Actualiser</button></div>',
  '<div class="cf-carte"><div class="cf-defil"><table class="cf-tab" id="cf-re"></table></div><div class="cf-note" id="cf-re-note"></div></div></section>',

  '<section class="cf-bloc" id="cf-depannage"><div class="cf-bloc-t"><div><h2>Dépannage</h2>',
  '<p>Journaux internes de Splunk : passages du planificateur qui n\'ont pas abouti, erreurs et avertissements liés à l\'appli.</p></div>',
  '<select id="cf-dp-per" aria-label="Période"><option value="-4h">4 dernières heures</option>',
  '<option value="-24h" selected>24 dernières heures</option><option value="-7d">7 derniers jours</option></select>',
  '<button id="cf-dp-maj" type="button">Actualiser</button></div>',
  '<div class="cf-grille2">',
  '<div class="cf-carte"><div class="cf-carte-t"><h3>Passages non réussis</h3><a id="cf-dp-l1" target="_blank" rel="noopener">Ouvrir dans Rechercher</a></div>',
  '<div class="cf-defil"><table class="cf-tab" id="cf-dp1"></table></div></div>',
  '<div class="cf-carte"><div class="cf-carte-t"><h3>Erreurs et avertissements Splunk</h3><a id="cf-dp-l2" target="_blank" rel="noopener">Ouvrir dans Rechercher</a></div>',
  '<div class="cf-defil"><table class="cf-tab" id="cf-dp2"></table></div></div>',
  '</div></section>',
  '<div class="cf-toast" id="cf-toast" role="status" aria-live="polite"></div>'
].join("");

var hote = document.querySelector(".dashboard-body") || document.body;
hote.innerHTML = "";
hote.appendChild(racine);

/* ---------------------------------------------------------------- etat partage */
var SH = null;                   // nom de ce search head (serverName)
var ANALYSTES = [];              // [{_key, nom, photo}]
var AN_OK = true;                // collection des analystes joignable
var PLAN = {};                   // date -> {keys:[_key...], en_service_1, en_service_2, astreinte}
var MODIFS = {};                 // date -> valeurs saisies, pas encore enregistrees
var SAVED = {};                  // nom -> contenu REST de la recherche planifiee

var infoServeur = rest("GET", "/services/server/info").then(function (j) {
  SH = j.entry[0].content.serverName;
  $("cf-sh").textContent = SH;
  return j.entry[0].content;
});

/* ================================================================ ANALYSTES */
function libInit() {
  return PHOTOS.length ? "Reprendre les " + PHOTOS.length + " analystes livrés" : "Créer 3 analystes d'exemple";
}
function photoDe(a) { return a.photo || (LIVREE(a._key) ? urlVignette(a._key) : ""); }
function vignette(src, nom) {
  return src ? '<img class="ph" src="' + esc(src) + '" alt="">'
             : '<span class="ph" aria-hidden="true">' + esc(capital(cle(nom)).slice(0, 2)) + '</span>';
}

function chargerAnalystes() {
  return kv.lire("wall_analystes").then(function (docs) {
    AN_OK = true;
    ANALYSTES = docs.filter(function (a) { return a._key; })
      .sort(function (a, b) { return String(a.nom).localeCompare(String(b.nom), "fr"); });
  }).catch(function (e) {
    AN_OK = false; ANALYSTES = [];
    throw e;
  }).then(rendreAnalystes, function (e) { rendreAnalystes(e); throw e; });
}

function rendreAnalystes(err) {
  var al = $("cf-an-alerte");
  if (err) {
    al.innerHTML = '<div class="cf-alerte err"><b>Collection wall_analystes injoignable</b> (' + esc(err.message) + '). ' +
      'Après une installation ou une mise à jour, Splunk doit recharger les collections KV store de l\'appli : ' +
      'cela se fait au prochain redémarrage du search head. En attendant, le mur utilise les photos livrées.</div>';
  } else if (!ANALYSTES.length) {
    al.innerHTML = '<div class="cf-alerte">Aucun analyste enregistré. Ajoutez-les ci-dessous, ou ' +
      '<button type="button" class="petit prim" id="cf-an-init">' + esc(libInit()) + '</button></div>';
    $("cf-an-init").onclick = initialiserAnalystes;
  } else al.innerHTML = "";

  var html = ANALYSTES.map(function (a) {
    var src = photoDe(a);
    return '<div class="cf-carte cf-av" data-k="' + esc(a._key) + '">' + vignette(src, a.nom) +
      '<div><div class="nom">' + esc(a.nom) + '</div><div class="cle">' + esc(a._key) +
      (a.photo ? "" : LIVREE(a._key) ? " · photo livrée" : " · sans photo") + '</div></div>' +
      '<div class="bt"><label class="cf-btn petit" style="height:26px;padding:0 9px;font-size:13px">Photo…' +
      '<input type="file" accept="image/*" data-photo="' + esc(a._key) + '"></label>' +
      '<button type="button" class="petit dang" data-suppr="' + esc(a._key) + '">Retirer</button></div></div>';
  }).join("");
  html += '<div class="cf-carte cf-av cf-ajout"><b>Ajouter un analyste</b>' +
    '<input type="text" id="cf-an-nom" placeholder="Prénom" autocomplete="off" aria-label="Prénom"' + (AN_OK ? "" : " disabled") + '>' +
    '<div class="apercu" id="cf-an-apercu">Pas de photo</div>' +
    '<div class="bt"><label class="cf-btn petit" style="height:26px;padding:0 9px;font-size:13px">Choisir une photo…' +
    '<input type="file" accept="image/*" id="cf-an-fic"' + (AN_OK ? "" : " disabled") + '></label>' +
    '<button type="button" class="petit prim" id="cf-an-ajout"' + (AN_OK ? "" : " disabled") + '>Ajouter</button></div></div>';
  $("cf-an").innerHTML = html;

  var photoNouvelle = "";
  $("cf-an-fic").onchange = function () {
    var f = this.files[0]; if (!f) return;
    carre(f).then(function (d) {
      photoNouvelle = d;
      $("cf-an-apercu").innerHTML = '<img src="' + d + '" alt=""> Photo prête';
    }).catch(function (e) { toast(e.message, "err"); });
  };
  $("cf-an-ajout").onclick = function () {
    var nom = $("cf-an-nom").value.trim(), k = cle(nom);
    if (!k) { toast("Indiquez un prénom.", "err"); $("cf-an-nom").focus(); return; }
    if (ANALYSTES.some(function (a) { return a._key === k; })) { toast("« " + k + " » existe déjà.", "err"); return; }
    var photo = photoNouvelle;
    var prete = photo ? Promise.resolve(photo) : (LIVREE(k) ? depuisUrl(urlVignette(k)) : Promise.resolve(""));
    prete.then(function (p) { return kv.ecrire("wall_analystes", [{ _key: k, nom: nom, photo: p }]); })
      .then(function () { toast(nom + " ajouté.", "ok"); return chargerAnalystes(); })
      .then(rendrePlanning)
      .catch(function (e) { toast("Ajout impossible : " + e.message, "err"); });
  };
  Array.prototype.forEach.call($("cf-an").querySelectorAll("input[data-photo]"), function (inp) {
    inp.onchange = function () {
      var k = inp.getAttribute("data-photo"), f = inp.files[0], a = ANALYSTES.filter(function (x) { return x._key === k; })[0];
      if (!f || !a) return;
      carre(f).then(function (d) {
        return kv.ecrire("wall_analystes", [{ _key: k, nom: a.nom, photo: d }]);
      }).then(function () { toast("Photo de " + a.nom + " enregistrée.", "ok"); return chargerAnalystes(); })
        .catch(function (e) { toast("Photo non enregistrée : " + e.message, "err"); });
    };
  });
  Array.prototype.forEach.call($("cf-an").querySelectorAll("button[data-suppr]"), function (b) {
    b.onclick = function () {
      var k = b.getAttribute("data-suppr"), a = ANALYSTES.filter(function (x) { return x._key === k; })[0];
      var auj = iso(new Date()), futurs = Object.keys(PLAN).filter(function (d) {
        var p = PLAN[d]; return d >= auj && [p.en_service_1, p.en_service_2, p.astreinte].indexOf(k) >= 0;
      }).length;
      if (!confirm("Retirer " + a.nom + " ?" + (futurs ? "\n\nIl apparaît encore dans " + futurs +
          " jour(s) à venir du planning : le mur y affichera ses initiales." : ""))) return;
      kv.suppr("wall_analystes", k)
        .then(function () { toast(a.nom + " retiré.", "ok"); return chargerAnalystes(); })
        .then(rendrePlanning)
        .catch(function (e) { toast("Suppression impossible : " + e.message, "err"); });
    };
  });
}

/* photo -> carre 200 x 200, JPEG : ~15 Ko en data URI */
function carre(fichier) {
  return new Promise(function (ok, ko) {
    if (!/^image\//.test(fichier.type)) return ko(new Error("Ce fichier n'est pas une image."));
    var url = URL.createObjectURL(fichier);
    depuisUrl(url).then(function (d) { URL.revokeObjectURL(url); ok(d); },
                        function (e) { URL.revokeObjectURL(url); ko(e); });
  });
}
function depuisUrl(url) {
  return new Promise(function (ok, ko) {
    var img = new Image();
    img.onload = function () {
      var c = document.createElement("canvas"), T = 200, s = Math.min(img.naturalWidth, img.naturalHeight);
      c.width = c.height = T;
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#0f1e2b"; ctx.fillRect(0, 0, T, T);
      // recadrage centre, legerement remonte : le visage est dans le haut du portrait
      var sx = (img.naturalWidth - s) / 2, sy = Math.max(0, (img.naturalHeight - s) * 0.3);
      ctx.drawImage(img, sx, sy, s, s, 0, 0, T, T);
      ok(c.toDataURL("image/jpeg", 0.86));
    };
    img.onerror = function () { ko(new Error("Image illisible.")); };
    img.src = url;
  });
}

/* analystes de depart : les photos livrees avec l'appli (config team_dir),
   sinon trois analystes d'exemple, sans photo, a renommer ou retirer */
var EXEMPLES = [["alice", "Alice"], ["bruno", "Bruno"], ["chloe", "Chloé"]];
function initialiserAnalystes() {
  var b = $("cf-an-init"); if (b) b.disabled = true;
  var base = PHOTOS.length ? PHOTOS.map(function (k) { return [k, capital(k)]; }) : EXEMPLES;
  return Promise.all(base.map(function (x) {
    return (LIVREE(x[0]) ? depuisUrl(urlVignette(x[0])).catch(function () { return ""; }) : Promise.resolve(""))
      .then(function (p) { return { _key: x[0], nom: x[1], photo: p }; });
  })).then(function (docs) { return kv.ecrire("wall_analystes", docs); })
    .then(function () { toast(base.length + " analystes enregistrés.", "ok"); return chargerAnalystes(); })
    .then(function () { rendrePlanning(); verifier(); })
    .catch(function (e) { if (b) b.disabled = false; toast("Initialisation impossible : " + e.message, "err"); });
}

/* ================================================================ PLANNING */
var debutVue = lundi(new Date());
function lundi(d) { d = new Date(d); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
var CHAMPS = ["en_service_1", "en_service_2", "astreinte"];

function chargerPlanning() {
  return kv.lire("wall_planning").then(function (docs) {
    PLAN = {};
    docs.forEach(function (r) {
      var d = dateIso(r.date); if (!d) return;
      var p = PLAN[d];
      if (p) { p.keys.push(r._key); return; }             // doublon de date : fusionne a l'enregistrement
      PLAN[d] = { keys: [r._key], en_service_1: cle(r.en_service_1), en_service_2: cle(r.en_service_2), astreinte: cle(r.astreinte) };
    });
    rendrePlanning();
  });
}
function valeurs(d) {
  if (MODIFS[d]) return MODIFS[d];
  var p = PLAN[d] || {};
  return { en_service_1: p.en_service_1 || "", en_service_2: p.en_service_2 || "", astreinte: p.astreinte || "" };
}
function identique(d, v) {
  var p = PLAN[d] || {};
  return CHAMPS.every(function (c) { return (p[c] || "") === (v[c] || ""); });
}
function rendrePlanning() {
  var auj = iso(new Date()), noms = {};
  ANALYSTES.forEach(function (a) { noms[a._key] = a.nom; });
  if (!ANALYSTES.length) PHOTOS.forEach(function (k) { noms[k] = capital(k); });
  var cles = Object.keys(noms).sort(function (a, b) { return noms[a].localeCompare(noms[b], "fr"); });
  var html = '<thead><tr><th>Jour</th><th>En service</th><th>En service</th><th>Astreinte</th></tr></thead><tbody>';
  for (var i = 0; i < 14; i++) {
    var j = new Date(debutVue); j.setDate(j.getDate() + i);
    var d = iso(j), v = valeurs(d), wd = j.getDay();
    var cls = [wd === 0 || wd === 6 ? "we" : "", d === auj ? "auj" : "", MODIFS[d] ? "modif" : ""].join(" ").trim();
    html += '<tr class="' + cls + '" data-d="' + d + '"><td class="jr"><b>' +
      esc(j.toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" })) + '</b>' +
      (d === auj ? "<span>aujourd'hui</span>" : "") + '</td>';
    CHAMPS.forEach(function (c) {
      var val = v[c] || "", inconnu = val && !noms[val];
      html += '<td><select data-c="' + c + '" aria-label="' + (c === "astreinte" ? "Astreinte" : "En service") + ' le ' + d + '"' +
        (inconnu ? ' class="inconnu" title="Analyste inconnu : pas de photo sur le mur"' : "") + '><option value="">—</option>' +
        cles.map(function (k) { return '<option value="' + esc(k) + '"' + (k === val ? " selected" : "") + '>' + esc(noms[k]) + '</option>'; }).join("") +
        (inconnu ? '<option value="' + esc(val) + '" selected>' + esc(val) + ' (inconnu)</option>' : "") + '</select></td>';
    });
    html += '</tr>';
  }
  $("cf-plan").innerHTML = html + '</tbody>';
  var fin = new Date(debutVue); fin.setDate(fin.getDate() + 13);
  $("cf-pl-per").textContent = "du " + debutVue.toLocaleDateString("fr-FR", { day: "numeric", month: "long" }) +
    " au " + fin.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  Array.prototype.forEach.call($("cf-plan").querySelectorAll("select"), function (s) {
    s.onchange = function () {
      var tr = s.closest("tr"), d = tr.getAttribute("data-d"), v = {};
      Array.prototype.forEach.call(tr.querySelectorAll("select"), function (x) { v[x.getAttribute("data-c")] = x.value; });
      if (identique(d, v)) delete MODIFS[d]; else MODIFS[d] = v;
      tr.classList.toggle("modif", !!MODIFS[d]);
      etatBoutons();
    };
  });
  etatBoutons();
}
function etatBoutons() {
  var n = Object.keys(MODIFS).length;
  $("cf-pl-enr").disabled = !n;
  $("cf-pl-annul").disabled = !n;
  $("cf-pl-enr").textContent = n ? "Enregistrer (" + n + " jour" + (n > 1 ? "s" : "") + ")" : "Enregistrer";
}
function enregistrerPlanning() {
  var docs = [], suppr = [];
  Object.keys(MODIFS).forEach(function (d) {
    var m = MODIFS[d], keys = PLAN[d] ? PLAN[d].keys : [];
    if (!m.en_service_1 && !m.en_service_2 && !m.astreinte) { suppr = suppr.concat(keys); return; }
    var doc = { date: d, en_service_1: m.en_service_1, en_service_2: m.en_service_2, astreinte: m.astreinte };
    if (keys[0]) doc._key = keys[0];
    docs.push(doc);
    suppr = suppr.concat(keys.slice(1));
  });
  $("cf-pl-enr").disabled = true;
  (docs.length ? kv.ecrire("wall_planning", docs) : Promise.resolve())
    .then(function () { return Promise.all(suppr.map(function (k) { return kv.suppr("wall_planning", k); })); })
    .then(function () {
      var n = Object.keys(MODIFS).length;
      MODIFS = {};
      toast("Planning enregistré (" + n + " jour" + (n > 1 ? "s" : "") + "). Le mur l'affichera d'ici 10 minutes.", "ok");
      return chargerPlanning();
    })
    .catch(function (e) { etatBoutons(); toast("Planning non enregistré : " + e.message, "err"); });
}

// colonne "jour" facultative d'un collage Excel, en francais ou en anglais
var JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche", "lun", "mar", "mer", "jeu", "ven", "sam", "dim",
             "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function importerTexte(txt) {
  var n = 0, rejets = [], premier = null;
  txt.split(/\r?\n/).forEach(function (l) {
    if (!l.trim()) return;
    var c = l.split(/\t|;|,/).map(function (x) { return x.trim(); });
    var d = dateIso(c[0]);
    if (!d) { if (!/date/i.test(c[0])) rejets.push(l.trim()); return; }   // en-tete ignore
    var r = c.slice(1);
    if (r.length && JOURS.indexOf(r[0].toLowerCase().replace(/\.$/, "")) >= 0) r = r.slice(1);
    var v = { en_service_1: cle(r[0]), en_service_2: cle(r[1]), astreinte: cle(r[2]) };
    if (identique(d, v)) delete MODIFS[d]; else MODIFS[d] = v;
    if (!premier || d < premier) premier = d;
    n++;
  });
  return { n: n, rejets: rejets, premier: premier };
}
/* planning d'exemple : 14 jours a partir de lundi, deux analystes en service
   par roulement, l'astreinte change chaque semaine */
function planningExemple() {
  var cles = ANALYSTES.map(function (a) { return a._key; });
  if (!cles.length) { toast("Créez d'abord des analystes.", "err"); return; }
  var l = lundi(new Date());
  for (var i = 0; i < 14; i++) {
    var j = new Date(l); j.setDate(j.getDate() + i);
    var we = j.getDay() === 0 || j.getDay() === 6;
    // l'astreinte de la semaine n'est pas aussi en service
    var astr = cles[Math.floor(i / 7) % cles.length];
    var autres = cles.length > 1 ? cles.filter(function (k) { return k !== astr; }) : cles, m = autres.length;
    var v = { en_service_1: we ? "" : autres[i % m], en_service_2: we || m < 2 ? "" : autres[(i + 1) % m],
              astreinte: astr };
    if (!identique(iso(j), v)) MODIFS[iso(j)] = v;
  }
  enregistrerPlanning();
}

$("cf-pl-prec").onclick = function () { debutVue.setDate(debutVue.getDate() - 7); rendrePlanning(); };
$("cf-pl-suiv").onclick = function () { debutVue.setDate(debutVue.getDate() + 7); rendrePlanning(); };
$("cf-pl-auj").onclick = function () { debutVue = lundi(new Date()); rendrePlanning(); };
$("cf-pl-enr").onclick = enregistrerPlanning;
$("cf-pl-annul").onclick = function () { MODIFS = {}; rendrePlanning(); };
$("cf-pl-imp").onclick = function () { $("cf-import").classList.add("ouvert"); $("cf-imp-txt").focus(); };
$("cf-imp-ferme").onclick = function () { $("cf-import").classList.remove("ouvert"); };
$("cf-imp-ok").onclick = function () {
  var r = importerTexte($("cf-imp-txt").value);
  if (r.premier) { debutVue = lundi(new Date(r.premier + "T12:00:00")); }
  rendrePlanning();
  $("cf-imp-res").textContent = r.n + (r.n > 1 ? " jours importés" : " jour importé") +
    " dans le tableau, à enregistrer" + (r.rejets.length ? " · " + r.rejets.length + " ligne(s) sans date reconnue ignorée(s)" : "");
};
addEventListener("beforeunload", function (e) {
  if (Object.keys(MODIFS).length) { e.preventDefault(); e.returnValue = ""; }
});

/* ================================================================ SOURCES
   Sources de la configuration (build.py, DETAILS) : desactivables.
   Sources ajoutees ici : une recherche planifiee wall_<id> creee par l'API REST,
   avec la meme normalisation que build.py (NORMALISATION, META), et leur
   description dans le KV store wall_sources (le mur y prend libelle et couleur). */
var LIVREES = DETAILS.map(function (d) { return d.nom; });
var SOURCES_KV = {};             // id -> {label, color, search, lookback, priority}
var PALETTE = ["#00a7eb", "#7770d5", "#00b891", "#d0b8ff", "#83e3c9", "#5aa2e0", "#c792ea", "#4dd0e1", "#9fb3ff", "#62d2a2"];
var HEXA = /^#[0-9a-fA-F]{6}$/;

function nettoyerSpl(spl) {      // comme build.lire_spl : sans commentaires ni "search" en tete
  spl = String(spl || "").replace(/```[\s\S]*?```/g, "");
  spl = spl.split("\n").map(function (l) { return l.replace(/\s+$/, ""); })
           .filter(function (l) { return l.trim(); }).join("\n");
  return spl.replace(/^\s*search\s+/, "").trim();
}
function splComplete(label, spl) {  // comme build.detail
  spl = nettoyerSpl(spl).split("$WINDOW_START$").join('relative_time(now(), "' + FENETRE.debut + '")');
  return spl + "\n" + NORMALISATION.split("__LIBELLE__").join('"' + label + '"') + "\n" + META;
}
function splSource(spl) {        // la recherche de la source seule, executable telle quelle
  spl = nettoyerSpl(spl).split("$WINDOW_START$").join("0");
  return /^\|/.test(spl) ? spl : "search " + spl;
}
function integrerSourcesKV(docs) {
  SOURCES_KV = {};
  docs.forEach(function (d) { if (d._key && LIVREES.indexOf("wall_" + d._key) < 0) SOURCES_KV[d._key] = d; });
  DETAILS = DETAILS.filter(function (d) { return LIVREES.indexOf(d.nom) >= 0; });
  Object.keys(SOURCES_KV).sort().forEach(function (k) {
    var d = SOURCES_KV[k], src = splSource(d.search);
    DETAILS.push({ nom: "wall_" + k, libelle: d.label, couleur: d.color, base: src.replace(/^search\s+/, "").split("\n|")[0].trim(),
                   source: src, demo: false, ajoutee: true });
  });
  RECHERCHES = DETAILS.map(function (d) { return d.nom; }).concat(["wall_cumul"]);
  DETAILS.forEach(function (d) { LIBELLE[d.nom] = d.libelle; });
}
function chargerSources() {
  return kv.lire("wall_sources").then(integrerSourcesKV, function (e) { integrerSourcesKV([]); throw e; });
}

function rendreSources(err) {
  var html = '<thead><tr><th>Source</th><th>Recherche</th><th>Origine</th><th>État</th><th></th></tr></thead><tbody>';
  DETAILS.forEach(function (d) {
    var s = SAVED[d.nom], id = d.nom.slice(5);
    var etat = !Object.keys(SAVED).length ? '<span class="dis">…</span>'
      : !s ? '<span class="e e-err">Recherche absente</span>'
      : s.disabled ? '<span class="e e-att">Désactivée</span>' : '<span class="e e-ok">Active</span>';
    html += '<tr data-n="' + esc(d.nom) + '"><td><i class="cf-sw" style="background:' + (HEXA.test(d.couleur || "") ? d.couleur : "var(--encre-3)") +
      '"></i><b>' + esc(d.libelle) + '</b></td><td class="mono">' + esc(d.nom) + '<div class="sous">' + esc(d.demo ? "démonstration (makeresults)" : d.base) + '</div></td>' +
      '<td>' + (d.ajoutee ? "ajoutée ici" : d.demo ? "configuration (démo)" : "configuration") + '</td><td>' + etat + '</td>' +
      '<td style="white-space:nowrap"><button type="button" class="petit" data-s-valider="' + esc(d.nom) + '">Valider</button> ' +
      (d.ajoutee ? '<button type="button" class="petit" data-s-modifier="' + esc(id) + '">Modifier</button> ' : "") +
      (s ? '<button type="button" class="petit' + (s.disabled ? "" : " dang") + '" data-s-bascule="' + esc(d.nom) + '">' + (s.disabled ? "Activer" : "Désactiver") + '</button> ' : "") +
      (d.ajoutee ? '<button type="button" class="petit dang" data-s-suppr="' + esc(id) + '">Supprimer</button>' : "") + '</td></tr>';
  });
  if (err) html += '<tr class="vide"><td colspan="5"><span class="e e-err">Collection wall_sources injoignable</span> ' + esc(err.message) +
    ' : les sources ajoutées ne sont pas listées (collection chargée au prochain redémarrage du search head).</td></tr>';
  $("cf-src").innerHTML = html + '</tbody>';
  var t = $("cf-src"), sur = function (sel, f) {
    Array.prototype.forEach.call(t.querySelectorAll("button[" + sel + "]"), function (b) { b.onclick = function () { f(b.getAttribute(sel), b); }; });
  };
  sur("data-s-valider", valider);
  sur("data-s-modifier", function (id) { ouvrirForm(SOURCES_KV[id], id); });
  sur("data-s-bascule", function (nom) { basculer(nom); });
  sur("data-s-suppr", supprimerSource);
}

function ouvrirForm(doc, id) {
  var f = $("cf-src-form"), edition = !!doc;
  var prises = DETAILS.map(function (d) { return (d.couleur || "").toLowerCase(); });
  var couleur = edition ? doc.color : PALETTE.filter(function (c) { return prises.indexOf(c) < 0; })[0] || PALETTE[0];
  f.innerHTML =
    '<h3>' + (edition ? "Modifier la source " + esc(doc.label) : "Nouvelle source") + '</h3>' +
    '<div class="cf-champs">' +
    (edition ? "" : '<label>Partir d\'un modèle<select id="f-modele"><option value="">Recherche vierge</option>' +
      MODELES.map(function (m, i) { return '<option value="' + i + '">' + esc(m.titre) + '</option>'; }).join("") + '</select></label>') +
    '<label>Identifiant<input type="text" id="f-id" maxlength="20" placeholder="ex. waf_interne"' + (edition ? " disabled" : "") + '></label>' +
    '<label>Libellé sur le mur<input type="text" id="f-label" maxlength="40" placeholder="ex. WAF interne"></label>' +
    '<label>Couleur<input type="color" id="f-color"></label>' +
    '<label>Regarder en arrière (min)<input type="text" id="f-lookback" inputmode="numeric" value="0"></label>' +
    '<label class="coche"><input type="checkbox" id="f-prio"> Prioritaire (épinglée en tête du flux)</label></div>' +
    '<label class="bloc">Recherche de la source<textarea id="f-spl" spellcheck="false" placeholder="index=... sourcetype=...\n| eval ...\n| fields _time, src_ip, Country, src_lat, src_lon, dc, severity, signature, dest_host, action"></textarea></label>' +
    '<p class="cf-conseil">Elle doit fournir <span class="mono">_time, src_ip, dc, severity, signature, dest_host, action</span> ' +
    '(docs/CONTRAT.md). Sites (champ dc) : <span class="mono">' + esc(SITES.join(", ")) + '</span>. La géolocalisation, ' +
    'les coordonnées des sites et la normalisation sont ajoutées automatiquement.</p>' +
    '<div id="f-res"></div>' +
    '<div class="cf-outils"><button type="button" id="f-valider">Valider sur la dernière heure</button><span class="sep"></span>' +
    '<button type="button" id="f-annuler">Annuler</button><button type="button" class="prim" id="f-enr">' +
    (edition ? "Enregistrer les modifications" : "Ajouter la source") + '</button></div>';
  f.classList.add("ouvert");
  $("f-id").value = edition ? id : "";
  $("f-label").value = edition ? doc.label : "";
  $("f-color").value = HEXA.test(couleur || "") ? couleur : PALETTE[0];
  $("f-lookback").value = edition ? (doc.lookback || 0) : 0;
  $("f-prio").checked = edition && (doc.priority === true || doc.priority === "true");
  $("f-spl").value = edition ? doc.search : "";
  if (!edition) $("f-modele").onchange = function () {
    var m = MODELES[this.value]; if (!m) return;
    $("f-spl").value = m.spl;
    if (!$("f-id").value) $("f-id").value = m.id.split("_")[0].slice(0, 20);
    if (!$("f-label").value) $("f-label").value = m.titre.split(" (")[0].slice(0, 40);
    $("f-lookback").value = /\$WINDOW_START\$/.test(m.spl) ? 10 : 0;
  };
  var valide = null;              // resultat de la derniere validation de CETTE recherche
  $("f-spl").oninput = function () { valide = null; };
  $("f-valider").onclick = function () {
    var b = this; b.disabled = true;
    $("f-res").innerHTML = '<span class="e e-run">Contrôle sur la dernière heure…</span>';
    controleContrat(splSource($("f-spl").value)).then(function (r) {
      valide = r; $("f-res").innerHTML = r.html; b.disabled = false;
    });
  };
  $("f-annuler").onclick = fermerForm;
  $("f-enr").onclick = function () { enregistrerSource(edition, valide); };
  f.scrollIntoView({ behavior: "smooth", block: "start" });
  (edition ? $("f-label") : $("f-modele")).focus();
}
function fermerForm() { var f = $("cf-src-form"); f.classList.remove("ouvert"); f.innerHTML = ""; }

function enregistrerSource(edition, valide) {
  var id = $("f-id").value.trim(), label = $("f-label").value.trim(), color = $("f-color").value;
  var lb = $("f-lookback").value.trim(), prio = $("f-prio").checked, spl = $("f-spl").value;
  var err = [];
  if (!/^[a-z0-9_]{1,20}$/.test(id)) err.push("identifiant : minuscules, chiffres et _ (20 caractères au plus)");
  if (!edition && (RECHERCHES.indexOf("wall_" + id) >= 0 || SOURCES_KV[id])) err.push("l'identifiant « " + id + " » est déjà pris");
  if (!label || /["\\]/.test(label)) err.push("libellé obligatoire, sans guillemet ni barre oblique inverse");
  if (DETAILS.some(function (d) { return d.libelle === label && d.nom !== "wall_" + id; })) err.push("libellé déjà utilisé par une autre source");
  if (!HEXA.test(color)) err.push("couleur #rrggbb");
  if (!/^\d+$/.test(lb) || +lb > 1440) err.push("regarder en arrière : entier entre 0 et 1440");
  if (!nettoyerSpl(spl)) err.push("la recherche est vide");
  if (err.length) { toast("À corriger : " + err.join(" ; "), "err"); return; }
  if (valide && valide.echec) { toast("La recherche échoue : corrigez-la avant de l'enregistrer.", "err"); return; }
  if (!valide && !confirm("La recherche n'a pas été validée. L'enregistrer quand même ?")) return;
  if (valide && valide.erreurs && !confirm("La validation signale des erreurs de contrat. L'enregistrer quand même ?")) return;

  var nom = "wall_" + id;
  var champs = {
    search: splComplete(label, spl), description: "Mur - source " + label + " (ajoutée depuis la configuration)",
    cron_schedule: "*/5 * * * *", is_scheduled: "1",
    "dispatch.earliest_time": "-" + (7 + (+lb)) + "m@m", "dispatch.latest_time": FENETRE.fin,
    "dispatch.ttl": "2p", schedule_window: "0", allow_skew: "0",
    // Splunk 10 ignore action.summary_index=1 envoyé par REST : c'est actions qui active la copie
    actions: "summary_index", "action.summary_index": "1", "action.summary_index._name": SUMMARY
  };
  if (!edition) { champs.name = nom; champs.disabled = "0"; }
  $("f-enr").disabled = true;
  rest("POST", edition ? cheminRecherche(nom) : "saved/searches", undefined, champs)
    .then(function () {
      return kv.ecrire("wall_sources", [{ _key: id, label: label, color: color, search: spl, lookback: +lb, priority: prio }]);
    })
    .then(function () {
      toast(edition ? "Source « " + label + " » modifiée." : "Source « " + label + " » ajoutée : elle apparaîtra sur le mur à son premier passage (5 à 10 min).", "ok");
      fermerForm();
      return rechargerSources();
    })
    .catch(function (e) {
      $("f-enr").disabled = false;
      toast("Source non enregistrée : " + e.message, "err");
    });
}

function supprimerSource(id) {
  var d = SOURCES_KV[id]; if (!d) return;
  if (!confirm("Supprimer la source « " + d.label + " » et sa recherche planifiée wall_" + id + " ?\n\n" +
      "Ses attaques déjà comptées aujourd'hui restent dans le cumul et la relecture.")) return;
  rest("DELETE", cheminRecherche("wall_" + id))
    .catch(function (e) { if (e.status !== 404) throw e; })     // deja supprimee : on nettoie le registre
    .then(function () { return kv.suppr("wall_sources", id); })
    .then(function () { toast("Source « " + d.label + " » supprimée.", "ok"); return rechargerSources(); })
    .catch(function (e) { toast("Suppression impossible : " + e.message, "err"); });
}

function rechargerSources() {
  return chargerSources().catch(function () {}).then(function () {
    return chargerSaved().catch(function () {});
  }).then(function () { rendreSources(); chargerRecherches(); verifier(); });
}
$("cf-src-ajout").onclick = function () { ouvrirForm(null); };

/* ================================================================ SITES
   Sites de la configuration (build.py, SITES_CFG) : en lecture seule.
   Sites ajoutes ici : KV store wall_sites (cle = id, la valeur du champ dc des
   sources). Le mur les relit toutes les 10 minutes. */
var SITES_KV = {};               // id -> {label, lat, lon, dx, dy}
var POSITIONS = [["1,-1", "en haut à droite"], ["-1,-1", "en haut à gauche"], ["1,1", "en bas à droite"], ["-1,1", "en bas à gauche"]];

function integrerSites(docs) {
  var livres = SITES_CFG.map(function (s) { return s.id; });
  SITES_KV = {};
  docs.forEach(function (d) { if (d._key && livres.indexOf(d._key) < 0) SITES_KV[d._key] = d; });
  SITES = livres.concat(Object.keys(SITES_KV).sort());
}
function chargerSites() {
  return kv.lire("wall_sites").then(integrerSites, function (e) { integrerSites([]); throw e; });
}

function rendreSites(err) {
  var ligne = function (id, label, lat, lon, ajoute) {
    return '<tr><td><b>' + esc(label || id) + '</b>' + (id === SITE_DEFAUT ? ' <span class="dis">site par défaut</span>' : "") + '</td>' +
      '<td class="mono">' + esc(id) + '</td><td class="mono">' + esc(lat) + ', ' + esc(lon) + '</td>' +
      '<td>' + (ajoute ? "ajouté ici" : "configuration") + '</td><td style="white-space:nowrap">' +
      (ajoute ? '<button type="button" class="petit" data-si-modifier="' + esc(id) + '">Modifier</button> ' +
                '<button type="button" class="petit dang" data-si-suppr="' + esc(id) + '">Supprimer</button>' : "") + '</td></tr>';
  };
  var html = '<thead><tr><th>Site</th><th>Identifiant</th><th>Latitude, longitude</th><th>Origine</th><th></th></tr></thead><tbody>';
  SITES_CFG.forEach(function (s) { html += ligne(s.id, s.label, s.lat, s.lon, false); });
  Object.keys(SITES_KV).sort().forEach(function (k) { var d = SITES_KV[k]; html += ligne(k, d.label, d.lat, d.lon, true); });
  if (err) html += '<tr class="vide"><td colspan="5"><span class="e e-err">Collection wall_sites injoignable</span> ' + esc(err.message) +
    ' : les sites ajoutés ne sont pas listés (collection chargée au prochain redémarrage du search head).</td></tr>';
  $("cf-site").innerHTML = html + '</tbody>';
  var t = $("cf-site"), sur = function (sel, f) {
    Array.prototype.forEach.call(t.querySelectorAll("button[" + sel + "]"), function (b) { b.onclick = function () { f(b.getAttribute(sel)); }; });
  };
  sur("data-si-modifier", function (id) { ouvrirSite(SITES_KV[id], id); });
  sur("data-si-suppr", supprimerSite);
}

function ouvrirSite(doc, id) {
  var f = $("cf-site-form"), edition = !!doc;
  f.innerHTML =
    '<h3>' + (edition ? "Modifier le site " + esc(doc.label || id) : "Nouveau site") + '</h3>' +
    '<div class="cf-champs">' +
    '<label>Identifiant<input type="text" id="s-id" maxlength="20" placeholder="ex. SIEGE"' + (edition ? " disabled" : "") + '></label>' +
    '<label>Nom sur la carte<input type="text" id="s-label" maxlength="40" placeholder="ex. Siège"></label>' +
    '<label>Latitude<input type="text" id="s-lat" inputmode="decimal" placeholder="ex. 48.8566"></label>' +
    '<label>Longitude<input type="text" id="s-lon" inputmode="decimal" placeholder="ex. 2.3522"></label>' +
    '<label>Étiquette<select id="s-dir">' + POSITIONS.map(function (p) { return '<option value="' + p[0] + '">' + p[1] + '</option>'; }).join("") +
    '</select></label></div>' +
    '<p class="cf-conseil">Coordonnées en degrés décimaux : latitude positive au nord, longitude positive à l\'est. ' +
    'L\'identifiant est la valeur que les sources mettent dans le champ <span class="mono">dc</span>.</p>' +
    '<div class="cf-outils"><span class="sep"></span><button type="button" id="s-annuler">Annuler</button>' +
    '<button type="button" class="prim" id="s-enr">' + (edition ? "Enregistrer les modifications" : "Ajouter le site") + '</button></div>';
  f.classList.add("ouvert");
  $("s-id").value = edition ? id : "";
  $("s-label").value = edition ? (doc.label || "") : "";
  $("s-lat").value = edition ? doc.lat : "";
  $("s-lon").value = edition ? doc.lon : "";
  if (edition) $("s-dir").value = ((+doc.dx < 0) ? "-1" : "1") + "," + ((+doc.dy > 0) ? "1" : "-1");
  $("s-annuler").onclick = fermerSite;
  $("s-enr").onclick = function () { enregistrerSite(edition); };
  f.scrollIntoView({ behavior: "smooth", block: "start" });
  (edition ? $("s-label") : $("s-id")).focus();
}
function fermerSite() { var f = $("cf-site-form"); f.classList.remove("ouvert"); f.innerHTML = ""; }

function enregistrerSite(edition) {
  var id = $("s-id").value.trim(), label = $("s-label").value.trim();
  var lat = parseFloat($("s-lat").value.replace(",", ".")), lon = parseFloat($("s-lon").value.replace(",", "."));
  var dir = $("s-dir").value.split(","), err = [];
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(id)) err.push("identifiant : lettres, chiffres, - et _ (20 caractères au plus)");
  if (!edition && SITES.indexOf(id) >= 0) err.push("l'identifiant « " + id + " » est déjà pris");
  if (!label) err.push("nom obligatoire");
  if (!(lat >= -90 && lat <= 90)) err.push("latitude entre -90 et 90");
  if (!(lon >= -180 && lon <= 180)) err.push("longitude entre -180 et 180");
  if (err.length) { toast("À corriger : " + err.join(" ; "), "err"); return; }
  $("s-enr").disabled = true;
  kv.ecrire("wall_sites", [{ _key: id, label: label, lat: lat, lon: lon, dx: +dir[0], dy: +dir[1] }])
    .then(function () {
      toast(edition ? "Site « " + label + " » modifié." : "Site « " + label + " » ajouté : il apparaîtra sur le mur dans les 10 minutes.", "ok");
      fermerSite();
      return rechargerSites();
    })
    .catch(function (e) { $("s-enr").disabled = false; toast("Site non enregistré : " + e.message, "err"); });
}

function supprimerSite(id) {
  var d = SITES_KV[id]; if (!d) return;
  if (!confirm("Supprimer le site « " + (d.label || id) + " » ?\n\nLes attaques qui le visent seront rattachées au site par défaut.")) return;
  kv.suppr("wall_sites", id)
    .then(function () { toast("Site « " + (d.label || id) + " » supprimé.", "ok"); return rechargerSites(); })
    .catch(function (e) { toast("Suppression impossible : " + e.message, "err"); });
}

function rechargerSites() {
  return chargerSites().then(function () { rendreSites(); }, function (e) { rendreSites(e); });
}
$("cf-site-ajout").onclick = function () { ouvrirSite(null); };

/* ================================================================ CLIENTS
   À qui appartient chaque site (host) protégé : table site -> client (KV store
   wall_clients, jokers autorisés). Le mur en tire la colonne Client du flux. */
var CLIENTS_KV = {};             // _key -> {host, client}
function chargerClients() {
  return kv.lire("wall_clients").then(function (docs) {
    CLIENTS_KV = {}; docs.forEach(function (d) { if (d._key) CLIENTS_KV[d._key] = d; });
  }, function (e) { CLIENTS_KV = {}; throw e; });
}
function rendreClients(err) {
  var rows = Object.keys(CLIENTS_KV).map(function (k) { return CLIENTS_KV[k]; })
    .sort(function (a, b) { return (a.host || "").localeCompare(b.host || ""); });
  var html = '<thead><tr><th>Site (host)</th><th>Client</th><th></th></tr></thead><tbody>';
  if (!rows.length && !err) html += '<tr class="vide"><td colspan="3" class="dis">Aucun client. « Ajouter », ou « Détecter les sites non attribués ».</td></tr>';
  rows.forEach(function (d) {
    html += '<tr><td class="mono">' + esc(d.host) + '</td><td><b>' + esc(d.client) + '</b></td>' +
      '<td style="white-space:nowrap"><button type="button" class="petit" data-cl-mod="' + esc(d._key) + '">Modifier</button> ' +
      '<button type="button" class="petit dang" data-cl-suppr="' + esc(d._key) + '">Supprimer</button></td></tr>';
  });
  if (err) html += '<tr class="vide"><td colspan="3"><span class="e e-err">Collection wall_clients injoignable</span> ' + esc(err.message) + '</td></tr>';
  $("cf-cl").innerHTML = html + '</tbody>';
  var t = $("cf-cl");
  Array.prototype.forEach.call(t.querySelectorAll("button[data-cl-mod]"), function (b) { b.onclick = function () { ouvrirClient(CLIENTS_KV[b.getAttribute("data-cl-mod")]); }; });
  Array.prototype.forEach.call(t.querySelectorAll("button[data-cl-suppr]"), function (b) { b.onclick = function () { supprimerClient(b.getAttribute("data-cl-suppr")); }; });
}
function ouvrirClient(doc) {
  var f = $("cf-cl-form"), edition = !!doc;
  f.innerHTML =
    '<h3>' + (edition ? "Modifier" : "Nouveau client") + '</h3>' +
    '<div class="cf-champs">' +
    '<label>Site (host)<input type="text" id="c-host" maxlength="120" placeholder="ex. vpn.durand.example.org"></label>' +
    '<label>Client<input type="text" id="c-client" maxlength="60" placeholder="ex. Durand"></label></div>' +
    '<p class="cf-conseil">Le <span class="mono">host</span> est la cible de l\'attaque (ce que BunkerWeb / FortiWeb journalisent). ' +
    'Nom exact du site (insensible à la casse).</p>' +
    '<div class="cf-outils"><span class="sep"></span><button type="button" id="c-annuler">Annuler</button>' +
    '<button type="button" class="prim" id="c-enr">' + (edition ? "Enregistrer" : "Ajouter") + '</button></div>';
  f.classList.add("ouvert");
  f.setAttribute("data-key", edition ? doc._key : "");
  $("c-host").value = edition ? (doc.host || "") : "";
  $("c-client").value = edition ? (doc.client || "") : "";
  $("c-annuler").onclick = fermerClient;
  $("c-enr").onclick = enregistrerClient;
  f.scrollIntoView({ behavior: "smooth", block: "start" });
  $("c-host").focus();
}
function fermerClient() { var f = $("cf-cl-form"); f.classList.remove("ouvert"); f.innerHTML = ""; }
function enregistrerClient() {
  var f = $("cf-cl-form"), key = f.getAttribute("data-key");
  var host = $("c-host").value.trim().toLowerCase(), client = $("c-client").value.trim(), err = [];
  if (!host) err.push("site (host) obligatoire");
  if (!client) err.push("client obligatoire");
  if (err.length) { toast("À corriger : " + err.join(" ; "), "err"); return; }
  var doc = { host: host, client: client }; if (key) doc._key = key;
  $("c-enr").disabled = true;
  kv.ecrire("wall_clients", [doc])
    .then(function () { toast("Client « " + client + " » enregistré.", "ok"); fermerClient(); return rechargerClients(); })
    .catch(function (e) { $("c-enr").disabled = false; toast("Non enregistré : " + e.message, "err"); });
}
function supprimerClient(key) {
  var d = CLIENTS_KV[key]; if (!d) return;
  if (!confirm("Retirer « " + d.host + " → " + d.client + " » ?")) return;
  kv.suppr("wall_clients", key)
    .then(function () { toast("Attribution retirée.", "ok"); return rechargerClients(); })
    .catch(function (e) { toast("Suppression impossible : " + e.message, "err"); });
}
function rechargerClients() {
  return chargerClients().then(function () { rendreClients(); }, function (e) { rendreClients(e); });
}
function detecterNonAttribues() {
  var z = $("cf-cl-nonattr"); z.innerHTML = '<span class="e e-run">Recherche des sites sans client (24 h)…</span>';
  var spl = 'search index=' + SUMMARY + ' search_name=wall_* search_name!=wall_cumul NOT meta=1 (isnull(client) OR client="") dest_host!="" ' + UNIQUE_SH +
    ' | stats count by dest_host | sort -count | head 40';
  chercher(spl, "-24h", "now").then(function (r) {
    var rows = r.rows || [];
    if (!rows.length) { z.innerHTML = '<p class="cf-carte"><span class="e e-ok">Tous les sites vus ont un client.</span></p>'; return; }
    z.innerHTML = '<div class="cf-carte"><p>Sites vus sans client (24 h) — cliquez pour attribuer :</p>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">' +
      rows.map(function (x) { return '<button type="button" class="petit" data-host="' + esc(x.dest_host) + '">' + esc(x.dest_host) + ' <span class="dis">' + esc(x.count) + '</span></button>'; }).join("") +
      '</div></div>';
    Array.prototype.forEach.call(z.querySelectorAll("button[data-host]"), function (b) {
      b.onclick = function () { ouvrirClient(null); $("c-host").value = b.getAttribute("data-host"); $("c-client").focus(); };
    });
  }).catch(function (e) { z.innerHTML = '<span class="e e-err">Erreur : ' + esc(e.message) + '</span>'; });
}
$("cf-cl-ajout").onclick = function () { ouvrirClient(null); };
$("cf-cl-detect").onclick = detecterNonAttribues;

/* ================================================================ RECHERCHES */
function chargerSaved() {
  // "-" : toutes les recherches de l'appli, quel que soit leur proprietaire
  return rest("GET", "/servicesNS/-/" + APP + "/saved/searches?count=0&search=wall_").then(function (j) {
    SAVED = {};
    (j.entry || []).forEach(function (e) {
      if (!e.acl || e.acl.app !== APP) return;
      PROPRIO[e.name] = e.acl.owner;
      if (RECHERCHES.indexOf(e.name) >= 0) SAVED[e.name] = e.content;
    });
    return SAVED;
  });
}
function splPassages(hote) {
  return 'search index=_internal sourcetype=scheduler app=' + APP + ' savedsearch_name=wall_*' +
    (hote ? ' host="' + hote + '"' : '') +
    ' | stats count as passages count(eval(status="success")) as ok count(eval(status="skipped")) as sautes' +
    ' max(_time) as dernier latest(status) as statut avg(run_time) as duree latest(result_count) as resultats by savedsearch_name';
}
var SPL_LOTS = 'search index=' + SUMMARY + ' search_name=wall_* meta=1 | stats dc(search_now) as lots by search_name';

function chargerRecherches() {
  var tab = $("cf-re");
  tab.innerHTML = '<tbody><tr class="vide"><td><span class="e e-run">Lecture de l\'état…</span></td></tr></tbody>';
  return infoServeur.then(function () {
    return Promise.all([
      chargerSaved(),
      chercher(splPassages(SH), "-24h").then(function (r) { return r.rows; }).catch(function () { return null; }),
      chercher(SPL_LOTS, "-24h").then(function (r) { return r.rows; }).catch(function () { return null; }),
      chercher('search index=_internal sourcetype=scheduler app=' + APP + ' savedsearch_name=wall_* host!="' + SH +
               '" | stats max(_time) as dernier by host', "-24h").then(function (r) { return r.rows; }).catch(function () { return []; })
    ]);
  }).then(function (r) {
    var pass = {}, lots = {};
    (r[1] || []).forEach(function (x) { pass[x.savedsearch_name] = x; });
    (r[2] || []).forEach(function (x) { lots[x.search_name] = +x.lots; });
    var html = '<thead><tr><th>Recherche</th><th>État</th><th>Planification</th><th>Dernier passage</th>' +
      '<th class="num">Passages 24 h</th><th class="num">Durée moy.</th><th class="num">Résultats</th>' +
      '<th class="num">Lots au summary 24 h</th><th>Prochain</th><th></th></tr></thead><tbody>';
    RECHERCHES.forEach(function (nom) {
      var s = SAVED[nom], p = pass[nom] || {};
      if (!s) {
        html += '<tr><td><b>' + esc(LIBELLE[nom]) + '</b><div class="sous mono">' + esc(nom) + '</div></td>' +
          '<td colspan="9"><span class="e e-err">Introuvable sur ce search head</span></td></tr>';
        return;
      }
      var actif = !s.disabled && s.is_scheduled !== false && s.is_scheduled !== "0";
      var derniere = +p.dernier || 0, retard = actif && (!derniere || Date.now() / 1000 - derniere > 12 * 60);
      var etat = !actif ? '<span class="e e-att">Désactivée</span>'
        : p.statut && p.statut !== "success" ? '<span class="e e-err">' + esc(p.statut) + '</span>'
        : retard ? '<span class="e e-err">En retard</span>' : '<span class="e e-ok">Active</span>';
      var nLots = lots[nom];
      html += '<tr data-n="' + esc(nom) + '"><td><b>' + esc(LIBELLE[nom]) + '</b><div class="sous mono">' + esc(nom) + '</div></td>' +
        '<td>' + etat + '</td>' +
        '<td class="mono">' + esc(s.cron_schedule) + '<div class="sous">skew ' + esc(s.allow_skew) + '</div></td>' +
        '<td>' + (derniere ? esc(heure(derniere)) + '<div class="sous">' + esc(age(derniere)) + '</div>' : '<span class="dis">aucun en 24 h</span>') + '</td>' +
        '<td class="num">' + (p.passages ? esc(p.ok) + ' / ' + esc(p.passages) + (+p.sautes ? '<div class="sous">' + esc(p.sautes) + ' sautés</div>' : "") : "—") + '</td>' +
        '<td class="num">' + (p.duree ? (+p.duree).toFixed(1) + ' s' : "—") + '</td>' +
        '<td class="num">' + (p.resultats != null ? nf.format(+p.resultats) : "—") + '</td>' +
        '<td class="num">' + (nom === "wall_cumul" ? '<span class="dis">sans objet</span>' : nLots != null ? nf.format(nLots) + ' / 288' : "—") + '</td>' +
        '<td>' + (actif && s.next_scheduled_time ? esc(String(s.next_scheduled_time).replace(/^\d{4}-\d{2}-\d{2} /, "")) : "—") + '</td>' +
        '<td style="white-space:nowrap">' + (nom === "wall_cumul" ? "" : '<button type="button" class="petit" data-valider="' + esc(nom) + '">Valider</button> ') +
        '<button type="button" class="petit" data-test="' + esc(nom) + '">Tester</button> ' +
        '<button type="button" class="petit' + (actif ? ' dang' : '') + '" data-bascule="' + esc(nom) + '">' + (actif ? "Désactiver" : "Activer") + '</button></td></tr>';
    });
    tab.innerHTML = html + '</tbody>';
    var autres = (r[3] || []).filter(function (x) { return Date.now() / 1000 - (+x.dernier) < 15 * 60; });
    var arretes = (r[3] || []).filter(function (x) { return Date.now() / 1000 - (+x.dernier) >= 15 * 60; });
    $("cf-re-note").innerHTML = (r[1] === null ? '<span class="e e-att">Journaux du planificateur illisibles</span> (index _internal non autorisé pour ce compte ?) ' : "") +
      (autres.length ? '<span class="e e-att">Aussi planifiées ailleurs</span> ' + autres.map(function (x) {
        return '<b class="mono">' + esc(x.host) + '</b> (dernier passage ' + esc(heure(+x.dernier)) + ')';
      }).join(", ") + '. Le summary reçoit alors chaque tranche en double : le mur n\'en compte qu\'une, mais le calcul tourne deux fois. ' +
      'Désactivez les recherches sur le search head qui n\'affiche pas le mur.' : "") +
      (arretes.length ? ' <span class="e e-info">Arrêtées ailleurs</span> ' + arretes.map(function (x) {
        return '<b class="mono">' + esc(x.host) + '</b> (dernier passage ' + esc(heure(+x.dernier)) + ')';
      }).join(", ") + '.' : "");
    Array.prototype.forEach.call(tab.querySelectorAll("button[data-test]"), function (b) { b.onclick = function () { tester(b.getAttribute("data-test"), b); }; });
    rendreSources();
    Array.prototype.forEach.call(tab.querySelectorAll("button[data-valider]"), function (b) { b.onclick = function () { valider(b.getAttribute("data-valider"), b); }; });
    Array.prototype.forEach.call(tab.querySelectorAll("button[data-bascule]"), function (b) { b.onclick = function () { basculer(b.getAttribute("data-bascule")); }; });
  }).catch(function (e) {
    tab.innerHTML = '<tbody><tr class="vide"><td><span class="e e-err">État illisible</span> ' + esc(e.message) + '</td></tr></tbody>';
  });
}

function tester(nom, bouton) {
  var s = SAVED[nom] || {}, tr = bouton.closest("tr"), suiv = tr.nextElementSibling;
  if (suiv && suiv.classList.contains("test")) suiv.remove();
  var ligne = document.createElement("tr"); ligne.className = "test";
  ligne.innerHTML = '<td colspan="10"><span class="e e-run">Exécution de ' + esc(nom) + ' sur sa fenêtre (' +
    esc(s["dispatch.earliest_time"]) + ' → ' + esc(s["dispatch.latest_time"]) + ')…</span></td>';
  tr.after(ligne);
  bouton.disabled = true;
  chercher('| savedsearch "' + nom + '"', s["dispatch.earliest_time"] || "-7m@m", s["dispatch.latest_time"] || "-2m@m")
    .then(function (r) {
      var ev = r.rows.filter(function (x) { return x.meta != 1; }).length;
      var txt = nom === "wall_cumul"
        ? nf.format(r.rows.length - 1) + " lignes de cumul"
        : nf.format(ev) + " événement" + (ev > 1 ? "s" : "") + " sur la fenêtre";
      ligne.innerHTML = '<td colspan="10"><span class="e ' + (r.messages.length ? "e-att" : "e-ok") + '">Réussi</span> ' +
        esc(txt) + ' en ' + r.duree.toFixed(1) + ' s' +
        (r.messages.length ? '<div class="cf-conseil">' + r.messages.map(esc).join("<br>") + '</div>' : "") + '</td>';
    }, function (e) {
      ligne.innerHTML = '<td colspan="10"><span class="e e-err">Échec</span> ' + esc(e.message) +
        '<div class="cf-conseil">' + esc(conseil(e.message)) + '</div></td>';
    }).then(function () { bouton.disabled = false; });
}

/* Contrat d'une source (docs/CONTRAT.md) : la recherche de l'equipe, AVANT la
   normalisation ajoutee par build.py, doit fournir _time, src_ip, dc (un id de
   site), severity, signature, dest_host, action. Controle sur la derniere heure. */
function controleContrat(source) {
  var sites = SITES.map(function (x) { return '"' + x + '"'; }).join(", ");
  var spl = source + ' | eval _ip = if(isnull(src_ip) OR src_ip="", 1, 0), _site = if(in(dc, ' + sites + '), 0, 1),' +
    ' _sev = if(in(lower(severity), "critical", "high", "medium", "low", "informational"), 0, 1),' +
    ' _sig = if(isnull(signature) OR signature="", 1, 0), _cible = if(isnull(dest_host) OR dest_host="", 1, 0)' +
    ' | stats count, sum(_ip) as sans_ip, sum(_site) as site_inconnu, values(eval(if(_site=1, dc, null()))) as sites_inconnus,' +
    ' sum(_sev) as sev_invalide, values(severity) as severites, sum(_sig) as sans_sig, sum(_cible) as sans_cible, dc(src_ip) as ips';
  return chercher(/^\s*(\||search\s)/.test(spl) ? spl : "search " + spl, "-60m", "now").then(function (r) {
    var x = r.rows[0] || {}, n = +x.count || 0, pb = [];
    var pct = function (k) { return n ? Math.round(100 * (+x[k] || 0) / n) : 0; };
    if (!n) pb.push(["att", "Aucun événement sur la dernière heure : vérifier l'index et les filtres de la recherche."]);
    if (+x.sans_ip) pb.push(["err", pct("sans_ip") + " % sans src_ip : ces événements ne peuvent pas être géolocalisés."]);
    if (+x.site_inconnu) pb.push(["err", pct("site_inconnu") + " % avec un dc inconnu (" + [].concat(x.sites_inconnus || "vide").join(", ") +
      ") : ils sont rattachés au site par défaut. Sites déclarés : " + SITES.join(", ") + "."]);
    if (+x.sev_invalide) pb.push(["att", pct("sev_invalide") + " % de sévérités hors critical/high/medium/low/informational (" +
      [].concat(x.severites || []).join(", ") + ") : comptées en medium."]);
    if (+x.sans_sig) pb.push(["att", pct("sans_sig") + " % sans signature."]);
    if (+x.sans_cible) pb.push(["info", pct("sans_cible") + " % sans dest_host (colonne Cible vide)."]);
    var html = (pb.length ? pb.map(function (p) {
      return '<div><span class="e e-' + p[0] + '">' + LIB_ETAT[p[0]] + '</span> ' + esc(p[1]) + '</div>';
    }).join("") : '<span class="e e-ok">Conforme</span> ') + '<div class="cf-conseil">' + nf.format(n) +
      ' événements, ' + nf.format(+x.ips || 0) + ' IP distinctes, sévérités : ' + esc([].concat(x.severites || []).join(", ") || "—") +
      ' · <a target="_blank" rel="noopener" href="' + esc(lienRecherche(source, "-60m")) + '">Ouvrir la recherche</a></div>';
    return { html: html, n: n, erreurs: pb.filter(function (p) { return p[0] === "err"; }).length };
  }, function (e) {
    return { html: '<span class="e e-err">Échec</span> ' + esc(e.message) + '<div class="cf-conseil">' + esc(conseil(e.message)) + '</div>',
             n: 0, erreurs: 1, echec: true };
  });
}
function valider(nom, bouton) {
  var d = DETAILS.filter(function (x) { return x.nom === nom; })[0]; if (!d) return;
  var tr = bouton.closest("tr"), suiv = tr.nextElementSibling;
  if (suiv && suiv.classList.contains("test")) suiv.remove();
  var ligne = document.createElement("tr"); ligne.className = "test";
  var cols = tr.children.length;
  ligne.innerHTML = '<td colspan="' + cols + '"><span class="e e-run">Contrôle des champs de ' + esc(nom) + ' sur la dernière heure…</span></td>';
  tr.after(ligne);
  bouton.disabled = true;
  controleContrat(d.source).then(function (r) {
    ligne.innerHTML = '<td colspan="' + cols + '">' + r.html + '</td>';
    bouton.disabled = false;
  });
}

function basculer(nom) {
  var s = SAVED[nom]; if (!s) return;
  var activer = !!s.disabled;
  if (!confirm((activer ? "Activer " : "Désactiver ") + nom + " sur ce search head (" + SH + ") ?" +
      (activer ? "" : "\n\nLe mur de ce search head cessera de recevoir cette source."))) return;
  rest("POST", cheminRecherche(nom), undefined, { disabled: activer ? "0" : "1" })
    .then(function () { toast(nom + (activer ? " activée." : " désactivée."), "ok"); rechargerSources(); })
    .catch(function (e) { toast("Modification refusée : " + e.message, "err"); });
}
$("cf-re-maj").onclick = chargerRecherches;

/* ================================================================ DEPANNAGE */
var CONSEILS = [
  [/Cannot find artifacts within the search time range/i,
   "Le mur a demandé un résultat que la recherche planifiée n'a pas produit dans les 20 dernières minutes : recherche désactivée, sautée ou appli tout juste installée. Sans conséquence si c'est ponctuel."],
  [/concurren|quota|maximum number of/i,
   "Limite de recherches simultanées atteinte (compte ou search head). Les recherches sautées laissent un trou dans le summary."],
  [/Could not load configuration for collection|Application does not exist/i,
   "Collection KV store pas encore chargée après installation : se résout au redémarrage suivant du search head."],
  [/Unknown search command|Error in 'search' command|Unbalanced/i,
   "Erreur de syntaxe SPL : régénérer et réinstaller l'appli (splunk_app/build.py)."],
  [/index=.*(not found|does not exist)|No matching index/i,
   "Index introuvable ou non autorisé pour le propriétaire des recherches."],
  [/timed? ?out|timeout/i, "Recherche trop longue : vérifier la charge du search head et la fenêtre de la recherche."]
];
function conseil(msg) {
  for (var i = 0; i < CONSEILS.length; i++) if (CONSEILS[i][0].test(msg)) return CONSEILS[i][1];
  return "";
}
var SPL_ECHECS = 'search index=_internal sourcetype=scheduler app=' + APP + ' savedsearch_name=wall_* status!=success' +
  ' | eval t=_time | table t host savedsearch_name status reason run_time | sort - t | head 100';
var SPL_ERREURS = 'search index=_internal sourcetype=splunkd (log_level=ERROR OR log_level=WARN) ("' + APP + '" OR "wall_")' +
  ' | rex "Error in \'(?<commande>[^\']+)\': (?<detail>[^\\"]+)"' +
  ' | rex field=_raw "^\\S+ \\S+ \\S+ \\w+\\s+\\S+ (\\[[^\\]]+\\] )?- (?<texte>.*)$"' +
  ' | eval message=if(isnotnull(commande), commande.": ".detail, substr(texte, 1, 400))' +
  ' | eval message=replace(message, "wall_\\w+", "wall_*")' +
  ' | stats count as nb max(_time) as dernier values(host) as hotes by log_level component message' +
  ' | sort - dernier | head 50';

function chargerDepannage() {
  var per = $("cf-dp-per").value;
  $("cf-dp-l1").href = lienRecherche(SPL_ECHECS, per);
  $("cf-dp-l2").href = lienRecherche(SPL_ERREURS, per);
  var attente = '<tbody><tr class="vide"><td><span class="e e-run">Recherche…</span></td></tr></tbody>';
  $("cf-dp1").innerHTML = attente; $("cf-dp2").innerHTML = attente;
  chercher(SPL_ECHECS, per).then(function (r) {
    $("cf-dp1").innerHTML = !r.rows.length
      ? '<tbody><tr class="vide"><td><span class="e e-ok">Aucun</span> tous les passages de la période ont réussi</td></tr></tbody>'
      : '<thead><tr><th>Heure</th><th>Search head</th><th>Recherche</th><th>Statut</th><th>Raison</th><th class="num">Durée</th></tr></thead><tbody>' +
        r.rows.map(function (x) {
          return '<tr><td>' + esc(heure(+x.t)) + '</td><td class="mono">' + esc(String(x.host).split(".")[0]) + '</td><td>' +
            esc(LIBELLE[x.savedsearch_name] || x.savedsearch_name) + '</td><td><span class="e ' + (x.status === "skipped" ? "e-att" : "e-err") + '">' +
            esc(x.status) + '</span></td><td>' + esc(x.reason || "") + (conseil(x.reason || "") ? '<div class="cf-conseil">' + esc(conseil(x.reason)) + '</div>' : "") +
            '</td><td class="num">' + (x.run_time ? (+x.run_time).toFixed(1) + " s" : "") + '</td></tr>';
        }).join("") + '</tbody>';
  }).catch(function (e) {
    $("cf-dp1").innerHTML = '<tbody><tr class="vide"><td><span class="e e-err">Illisible</span> ' + esc(e.message) + '</td></tr></tbody>';
  });
  chercher(SPL_ERREURS, per).then(function (r) {
    $("cf-dp2").innerHTML = !r.rows.length
      ? '<tbody><tr class="vide"><td><span class="e e-ok">Aucune</span> pas d\'erreur ni d\'avertissement lié à l\'appli sur la période</td></tr></tbody>'
      : '<thead><tr><th>Dernière</th><th>Niveau</th><th>Composant</th><th>Message</th><th class="num">Nombre</th></tr></thead><tbody>' +
        r.rows.map(function (x) {
          var c = conseil(x.message || "");
          return '<tr><td style="white-space:nowrap">' + esc(heure(+x.dernier)) + '</td><td><span class="e ' +
            (x.log_level === "ERROR" ? "e-err" : "e-att") + '">' + esc(x.log_level) + '</span></td><td class="mono">' + esc(x.component) +
            '</td><td>' + esc(x.message) + (c ? '<div class="cf-conseil">' + esc(c) + '</div>' : "") + '</td><td class="num">' +
            nf.format(+x.nb) + '</td></tr>';
        }).join("") + '</tbody>';
  }).catch(function (e) {
    $("cf-dp2").innerHTML = '<tbody><tr class="vide"><td><span class="e e-err">Illisible</span> ' + esc(e.message) + '</td></tr></tbody>';
  });
}
$("cf-dp-maj").onclick = chargerDepannage;
$("cf-dp-per").onchange = chargerDepannage;

/* ================================================================ DEMARRAGE
   Chaque verification affiche un etat (ok, attention, erreur), un detail et
   au besoin une action. */
function verifications() {
  var liste = [
    { id: "sh", titre: "Appli et search head", run: function (set) {
      return Promise.all([infoServeur, rest("GET", "/services/apps/local/" + APP)]).then(function (r) {
        var v = r[1].entry[0].content.version;
        if (v !== VERSION) set("att", "Version installée " + v + ", page chargée en " + VERSION +
          " : recharger la page (Ctrl+F5).");
        else set("ok", "v" + v + " sur " + r[0].serverName + " (Splunk " + r[0].version + ")");
      });
    } },
    { id: "an", titre: "Analystes", run: function (set) {
      return chargerAnalystes().then(function () {
        if (!ANALYSTES.length) set("att", "Aucun analyste enregistré : le bandeau du mur restera vide.",
          [[libInit(), initialiserAnalystes, true], ["Saisir", function () { location.hash = "cf-analystes"; }]]);
        else set("ok", ANALYSTES.length + " analystes : " + ANALYSTES.map(function (a) { return a.nom; }).join(", "));
      }, function (e) {
        set("err", "Collection wall_analystes injoignable (" + e.message + ") : elle sera chargée au prochain redémarrage du search head.");
      });
    } },
    { id: "pl", titre: "Planning", run: function (set) {
      return chargerPlanning().then(function () {
        var auj = iso(new Date()), p = PLAN[auj], jours = Object.keys(PLAN).length;
        var aVenir = Object.keys(PLAN).filter(function (d) { return d > auj; }).length;
        if (!jours) set("att", "Planning vide : le mur affiche « Planning du jour à renseigner ».",
          [["Créer un planning d'exemple (14 jours)", function () { planningExemple(); setTimeout(verifier, 1500); }, !!ANALYSTES.length],
           ["Saisir", function () { location.hash = "cf-planning"; }]]);
        else if (!p || (!p.en_service_1 && !p.en_service_2 && !p.astreinte))
          set("att", "Rien pour aujourd'hui (" + jours + " jours saisis, " + aVenir + " à venir).", [["Saisir", function () { location.hash = "cf-planning"; }]]);
        else {
          var nom = function (k) { var a = ANALYSTES.filter(function (x) { return x._key === k; })[0]; return a ? a.nom : capital(k); };
          var svc = [p.en_service_1, p.en_service_2].filter(Boolean).map(nom);
          set(aVenir ? "ok" : "att", "Aujourd'hui : " + (svc.length ? svc.join(" et ") + " en service" : "personne en service") +
            (p.astreinte ? ", astreinte " + nom(p.astreinte) : "") + " · " + aVenir + " jour" + (aVenir > 1 ? "s" : "") +
            " à venir" + (aVenir ? "" : " : pensez à compléter"));
        }
      }, function (e) { set("err", "Collection wall_planning injoignable : " + e.message); });
    } },
    { id: "re", titre: "Recherches planifiées", run: function (set) {
      return chargerSaved().then(function () {
        var absentes = RECHERCHES.filter(function (n) { return !SAVED[n]; });
        var off = RECHERCHES.filter(function (n) { return SAVED[n] && SAVED[n].disabled; });
        var skew = RECHERCHES.filter(function (n) { return SAVED[n] && String(SAVED[n].allow_skew) !== "0"; });
        if (absentes.length) set("err", "Introuvables : " + absentes.join(", "));
        else if (off.length) set("att", "Désactivées sur ce search head : " + off.join(", ") +
          (off.length === RECHERCHES.length ? ". Normal si un autre search head alimente le summary, mais le mur de celui-ci restera vide." : ""),
          [["Voir", function () { location.hash = "cf-recherches"; }]]);
        else if (skew.length) set("att", "allow_skew différent de 0 : " + skew.join(", ") + " (passages décalés).");
        else set("ok", RECHERCHES.length + " recherches actives, toutes les 5 min, sans décalage.");
      });
    } },
    { id: "su", titre: "Index summary", run: function (set) {
      // search_now = heure du passage ; _time de la ligne de controle = debut de
      // fenetre, 17 min plus tot pour le VPN
      var spl = 'search index=' + SUMMARY + ' search_name=wall_* meta=1 | stats max(search_now) as dernier dc(search_now) as lots by search_name host';
      return Promise.all([infoServeur, chercher(spl, "-40m")]).then(function (r) {
        var rows = r[1].rows, hotes = {}, parSource = {};
        rows.forEach(function (x) {
          hotes[x.host] = true;
          parSource[x.search_name] = Math.max(parSource[x.search_name] || 0, +x.dernier);
        });
        var manquent = DETAILS.filter(function (d) { return !parSource[d.nom] || Date.now() / 1000 - parSource[d.nom] > 20 * 60; })
                              .map(function (d) { return d.libelle; });
        var h = Object.keys(hotes), court = function (x) { return x.split(".")[0]; };
        if (!rows.length) set("err", "Rien écrit dans le summary depuis 30 min : recherches désactivées partout, ou index summary non autorisé.",
          [["Ouvrir dans Rechercher", lienRecherche(spl, "-30m")]]);
        else if (manquent.length) set("err", "Plus rien depuis 20 min pour : " + manquent.join(", "), [["Ouvrir dans Rechercher", lienRecherche(spl, "-30m")]]);
        else if (h.length > 1) set("att", "Écrit par " + h.length + " search heads (" + h.map(court).join(", ") +
          ") : chaque tranche est en double. Le mur n'en compte qu'une, mais le calcul tourne deux fois.");
        else set(h[0] === SH ? "ok" : "info", DETAILS.length + " sources y arrivent toutes les 5 min, écrites par " + court(h[0]) +
          (h[0] === SH ? " (ce search head)." : " (un autre search head : le mur de celui-ci ne lit pas ses résultats)."));
      });
    } },
    { id: "cu", titre: "Lecture par le mur", run: function (set) {
      return chargerSaved().then(function () {
        return chercher('| loadjob savedsearch="' + (PROPRIO.wall_cumul || "nobody") + ':' + APP + ':wall_cumul" | where meta=1', "-20m");
      }).then(function (r) {
        var m = r.rows[0];
        if (!m) return set("err", "Le cumul n'a pas de ligne de contrôle : réinstaller l'appli.");
        var fin = +m.fin;
        set("ok", "Le dernier cumul (" + nf.format(+m.n) + " lignes) couvre la journée jusqu'à " +
          new Date(fin * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) + ".");
      }, function (e) {
        var c = conseil(e.message);
        set("err", e.message + (c ? " — " + c : ""));
      });
    } }
  ];
  DETAILS.forEach(function (d) {
    liste.push({ id: "src-" + d.nom, titre: "Données " + d.libelle, sous: d.demo ? "démonstration (makeresults, aucun index)" : d.base, run: function (set) {
      // recherche de base (index, filtres) ; une source de demo est un generateur complet
      var spl = (d.demo || /^\s*\|/.test(d.base) ? d.source : d.base) + " | stats count max(_time) as dernier";
      return chercher(/^\s*\|/.test(spl) ? spl : "search " + spl, "-15m").then(function (r) {
        var x = r.rows[0] || {}, n = +x.count || 0;
        if (!n) set("err", "Aucun événement depuis 15 min : collecte arrêtée, ou index non autorisé pour ce compte.",
          [["Ouvrir dans Rechercher", lienRecherche(spl, "-24h")]]);
        else set(d.demo ? "info" : "ok", nf.format(n) + " événements en 15 min, dernier " + age(+x.dernier) + "." +
          (d.demo ? " Source de démonstration : à remplacer par votre recherche (docs/ADAPTER.md)." : ""),
          [["Ouvrir dans Rechercher", lienRecherche(spl, "-15m")]]);
      });
    } });
  });
  return liste;
}

var LIB_ETAT = { ok: "OK", att: "À voir", err: "Erreur", info: "Info", run: "En cours" };
var enCours = false;
function verifier() {
  if (enCours) return;
  enCours = true;
  $("cf-reverif").disabled = true;
  var liste = verifications(), bilan = {};
  $("cf-checks").innerHTML = liste.map(function (v) {
    return '<li id="cf-v-' + v.id + '"><span class="e e-run">En cours</span><div><b>' + esc(v.titre) + '</b>' +
      (v.sous ? ' <span class="mono dis">' + esc(v.sous) + '</span>' : "") + '<div class="det"></div></div><div class="act"></div></li>';
  }).join("");
  function resume() {
    var n = { ok: 0, att: 0, err: 0 };
    Object.keys(bilan).forEach(function (k) { if (n[bilan[k]] != null) n[bilan[k]]++; });
    $("cf-resume").innerHTML = '<span><b>' + n.ok + '</b>OK</span><span><b>' + n.att + '</b>à voir</span><span><b>' + n.err + '</b>en erreur</span>';
  }
  resume();
  var taches = liste.map(function (v) {
    return function () {
      var li = $("cf-v-" + v.id);
      var set = function (etat, detail, actions) {
        bilan[v.id] = etat; resume();
        li.querySelector(".e").className = "e e-" + etat;
        li.querySelector(".e").textContent = LIB_ETAT[etat];
        li.querySelector(".det").textContent = detail;
        var act = li.querySelector(".act"); act.innerHTML = "";
        (actions || []).forEach(function (a) {
          var el;
          if (typeof a[1] === "string") { el = document.createElement("a"); el.href = a[1]; el.target = "_blank"; el.rel = "noopener"; }
          else { el = document.createElement("button"); el.type = "button"; el.className = "petit" + (a[2] ? " prim" : ""); el.onclick = a[1]; }
          el.textContent = a[0];
          act.appendChild(el);
        });
      };
      return v.run(set).catch(function (e) { set("err", e.message + (conseil(e.message) ? " — " + conseil(e.message) : "")); });
    };
  });
  parLots(taches, 3).then(function () { enCours = false; $("cf-reverif").disabled = false; });
}
$("cf-reverif").onclick = verifier;

/* ---------------------------------------------------------------- lancement */
// les sources ajoutees d'abord : elles entrent dans les verifications et l'etat des recherches
chargerSources().then(function () { rendreSources(); }, function (e) { rendreSources(e); }).then(verifier);  // verifier charge analystes et planning
setTimeout(chargerRecherches, 1500);     // ensuite : le quota de recherches est partage
setTimeout(chargerDepannage, 3000);
rechargerSites();
rechargerClients();
window.__config = { version: VERSION };
