/* =====================================================================
   Source de donnees "Splunk" du mur

   La page lit les resultats des recherches planifiees de l'appli au lieu de
   les calculer. Un seul calcul toutes les 5 minutes, quel que soit le nombre
   d'ecrans ouverts.

     (lus par "| loadjob" : aucun recalcul)
     index summary, recherches wall_*            dernier lot de chaque source (5 min)
                                                 (+ une ligne meta=1 : debut)
     wall_cumul                                  cumul depuis minuit jusqu'au
                                                 debut du lot en cours (meta : fin)
     KV store wall_analystes, wall_planning      equipe (API REST, pas une recherche)

     index=summary (relecture)                   evenements d'une tranche de 5 min
                                                 passee, deja copies par les detail

   Expose window.WALL_SOURCE, que la page utilise a la place de la simulation.
   ===================================================================== */
/* SOURCES (les recherches de detail livrees avec l'appli), BURST_CAP (arcs par rafale et par
   lot) et UNIQUE_SH (un seul search head par passage, voir build.py) sont
   fournis par build.py. */
var ATTENTE_LOT = 150000;    // ms : une source en retard n'empeche pas la livraison

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
var vide = function (v) { return v === null || v === undefined || v === ""; };

function versEvenement(x) {
  return {
    t: parseFloat(x.t) * 1000, country: x.Country || "",
    srcLat: vide(x.src_lat) ? NaN : +x.src_lat, srcLon: vide(x.src_lon) ? NaN : +x.src_lon,
    srcIp: x.src_ip || "", dc: x.dc, dstLat: +x.dst_lat, dstLon: +x.dst_lon,
    tech: x.source_tech, sev: x.severity, sig: x.signature || "", host: x.dest_host || "",
    client: x.client || "", action: x.action
  };
}

/* Une ligne de cumul -> ses dimensions ("prefixe|valeur"). */
function versDims(rows) {
  var agg = {};
  function add(k, n) { agg[k] = (agg[k] || 0) + n; }
  rows.forEach(function (r) {
    var n = parseInt(r.count, 10) || 0;
    add("all|all", n);
    // tranche horaire dans l'heure du poste, a partir de l'horodatage absolu
    if (!vide(r.t5)) {
      var d = new Date(parseFloat(r.t5) * 1000), hh = ("0" + d.getHours()).slice(-2);
      add("hour|" + hh, n);
      add("m5|" + hh + ("0" + d.getMinutes()).slice(-2), n);
    }
    [["act", "action"], ["tech", "source_tech"], ["sev", "severity"], ["cty", "Country"],
     ["sig", "signature"], ["site", "dc"], ["hour", "hour"], ["m5", "m5"]].forEach(function (pc) {
      if (!vide(r[pc[1]])) add(pc[0] + "|" + r[pc[1]], n);
    });
  });
  return Object.keys(agg).map(function (k) { return { dim: k, count: String(agg[k]) }; });
}

/* Plafond de rafale : on compte tout, mais seuls les BURST_CAP premiers
   evenements d'une rafale tracent un arc. */
function plafonner(ev) {
  var vu = {};
  ev.forEach(function (e) {
    var k = e.tech + "|" + e.sig + "|" + e.srcIp;
    vu[k] = (vu[k] || 0) + 1;
    if (vu[k] > BURST_CAP) e.noArc = true;
  });
}

function cle(nom) {                      // prenom -> identifiant de photo
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

/* Lecture des derniers lots dans l'index summary, ou chaque recherche wall_*
   copie ses resultats (ligne meta=1 comprise, datee du debut de sa fenetre).
   Pour chaque recherche, on garde son dernier passage (search_now) et un seul
   search head (UNIQUE_SH).

   Pourquoi pas "| loadjob" enchaines : un seul loadjob sans resultat (source
   ajoutee qui n'a pas encore tourne, source supprimee) vide TOUTE la recherche,
   sans erreur. Le summary, lui, contient exactement les sources qui tournent :
   une source ajoutee depuis la configuration apparait a son premier passage,
   une source retiree disparait d'elle-meme.

   Un compte d'affichage a souvent peu de recherches simultanees (3 pour le
   role user) : une recherche pour les lots, une pour le cumul. */
/* loadjob ne trouve les resultats planifies que sous le VRAI proprietaire de
   la recherche : "nobody" a l'installation, mais un SOC la confie souvent a un
   compte de service (dont le fuseau fixe alors "depuis minuit"). Le proprietaire
   est relu par REST au demarrage puis toutes les 10 min. */
var PROPRIOS = {};
function chargerProprios() {
  return fetch(splunkUtil.make_url("/splunkd/__raw/servicesNS/-/" + APP +
               "/saved/searches?output_mode=json&count=0&search=wall_"), { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : { entry: [] }; })
    .then(function (j) { (j.entry || []).forEach(function (e) { if (e.acl && e.acl.app === APP) PROPRIOS[e.name] = e.acl.owner; }); })
    .catch(function (e) { console.warn("mur : proprietaires des recherches illisibles", e); });
}
var loadjob = function (nom) { return '| loadjob savedsearch="' + (PROPRIOS[nom] || "nobody") + ':' + APP + ':' + nom + '"'; };
var SPL_DETAILS = 'search index=' + SUMMARY + ' search_name=wall_* search_name!=wall_cumul' +
  ' | eventstats max(search_now) as dernier_passage by search_name | where search_now == dernier_passage ' + UNIQUE_SH +
  // pas de prefixe "_" : Splunk masque ces champs dans les resultats
  ' | eval wall_src = search_name' +
  ' | fields wall_src meta debut n t Country src_lat src_lon src_ip dc dst_lat dst_lon source_tech severity signature dest_host client action';

function lecteur(id, spl, surLignes) {
  // 20 min : les deux derniers passages (fenetres -7m@m -> -2m@m). Pour le
  // cumul, loadjob ne trouve un resultat planifie que s'il a ete produit DANS
  // cette fenetre : produit toutes les 5 min, 20 min suffisent.
  var m = new SearchManager({
    id: "mur-" + id, search: spl,
    earliest_time: "-20m", latest_time: "now", cache: false, preview: false, autostart: true
  });
  var res = m.data("results", { count: 0, output_mode: "json_rows" });
  res.on("data", function () { if (res.hasData()) surLignes(lignes(res)); });
  m.on("search:error search:fail", function (p) {
    console.warn("mur :", id, p && (p.message || p));
  });
  return m;
}

/* Dernier cumul connu, garde dans le navigateur : au rechargement il s'affiche
   tout de suite, puis le cumul frais le remplace. Valable le jour meme. */
var CLE_CUMUL = "mur.cumul";
function sauverCumul(dims, fin) {
  try { localStorage.setItem(CLE_CUMUL, JSON.stringify({ jour: new Date().toDateString(), dims: dims, fin: fin })); } catch (e) {}
}
function relireCumul() {
  try {
    var c = JSON.parse(localStorage.getItem(CLE_CUMUL));
    if (c && c.jour === new Date().toDateString() && c.dims && c.fin) return c;
  } catch (e) {}
  return null;
}

/* Relecture d'une tranche passee : les recherches de detail ont deja copie
   chaque evenement dans l'index summary (a son heure d'origine), il suffit
   de le relire - quelques secondes, sans toucher aux journaux bruts. Le
   plafond de rafale est applique dans Splunk : lors d'un pic, une tranche peut
   compter des milliers de lignes pour quelques centaines d'arcs utiles. */
var SPL_RELECTURE = 'search index=' + SUMMARY + ' search_name=wall_* search_name!=wall_cumul NOT meta=1 ' + UNIQUE_SH +
  ' | sort 0 t | streamstats count as rang by source_tech, signature, src_ip | where rang <= ' + BURST_CAP +
  ' | fields t Country src_lat src_lon src_ip dc dst_lat dst_lon source_tech severity signature dest_host client action';
/* lecture d'une collection KV store par l'API REST (pas une recherche) */
function kv(coll) {
  return fetch(splunkUtil.make_url("/splunkd/__raw/servicesNS/nobody/" + APP +
               "/storage/collections/data/" + coll + "?output_mode=json"), { credentials: "same-origin" })
    .then(function (r) { if (!r.ok) throw new Error(coll + " : HTTP " + r.status); return r.json(); });
}
var nRelecture = 0, finSummary = 0;    // fin (ms) du dernier lot copie dans le summary
var PHOTOTHEQUE = {};                  // cle -> photo (data URI) de la configuration

window.WALL_SOURCE = {
  planningAide: "Configuration > Planning",

  start: function (cb) {
    var lots = {}, dernier = 0, dernierLivre = Date.now();

    function livrer(debut) {
      var lot = lots[debut]; if (!lot) return;
      Object.keys(lots).forEach(function (k) { if (+k <= debut) delete lots[k]; });
      dernier = debut; dernierLivre = Date.now();
      finSummary = Math.max(finSummary, debut + 300000);
      lot.ev.sort(function (a, b) { return a.t - b.t; });
      plafonner(lot.ev);
      cb.batch(lot.ev);
      cb.state(true);
    }

    // 1. le cumul, en premier : c'est le chiffre que l'on regarde
    var connu = relireCumul();
    if (connu) cb.daily(connu.dims, connu.fin);
    var managers = [];
    chargerProprios().then(function () {
    managers.push(lecteur("cumul", loadjob("wall_cumul"), function (rows) {
      var meta = rows.filter(function (r) { return r.meta == 1; })[0];
      if (!meta) return;
      var dims = versDims(rows.filter(function (r) { return r.meta != 1; }));
      var fin = parseFloat(meta.fin) * 1000;
      cb.daily(dims, fin);
      sauverCumul(dims, fin);
    }));

    // 2. les derniers lots de toutes les sources, relus ensemble
    managers.push(lecteur("detail", SPL_DETAILS, function (rows) {
      var parSource = {}, debuts = {};
      rows.forEach(function (r) {
        (parSource[r.wall_src] = parSource[r.wall_src] || []).push(r);
        if (r.meta == 1) debuts[r.wall_src] = parseFloat(r.debut) * 1000;
      });
      // sources actives : celles dont le dernier lot est recent (5 min au plus
      // avant le plus recent). Une source retiree ou arretee n'est plus attendue.
      var plusRecent = Math.max.apply(null, Object.keys(debuts).map(function (k) { return debuts[k]; }).concat([0]));
      var actives = Object.keys(debuts).filter(function (k) { return debuts[k] >= plusRecent - 300000; }).length;
      Object.keys(parSource).forEach(function (nom) {
        var sesLignes = parSource[nom];
        var meta = sesLignes.filter(function (r) { return r.meta == 1; })[0];
        if (!meta) return;
        var debut = parseFloat(meta.debut) * 1000;
        if (!(debut > dernier)) return;                   // lot deja livre
        var lot = lots[debut] || (lots[debut] = { srcs: {}, ev: [], recu: Date.now() });
        if (lot.srcs[nom]) return;
        lot.srcs[nom] = true;
        sesLignes.forEach(function (r) { if (r.meta != 1) lot.ev.push(versEvenement(r)); });
        if (Object.keys(lot.srcs).length >= actives) livrer(debut);
      });
    }));
    });

    // 3. sources ajoutees depuis la configuration (KV store) : libelle, couleur
    function sourcesKV() {
      kv("wall_sources").then(function (docs) {
        if (cb.sources) cb.sources(docs.filter(function (d) { return d.label; }).map(function (d) {
          return { id: d._key, label: d.label, color: d.color, priority: d.priority === true || d.priority === "true" };
        }));
      }, function () { /* collection absente : sources de la configuration seulement */ });
    }
    sourcesKV();
    setInterval(sourcesKV, 10 * 60000);

    // 4. sites ajoutes depuis la configuration (KV store) : position sur la carte
    function sitesKV() {
      kv("wall_sites").then(function (docs) {
        if (cb.sites) cb.sites(docs.map(function (d) {
          return { id: d._key, label: d.label, lat: parseFloat(d.lat), lon: parseFloat(d.lon),
                   label_dir: [parseFloat(d.dx) || 1, parseFloat(d.dy) || -1] };
        }));
      }, function () { /* collection absente : sites de la configuration seulement */ });
    }
    sitesKV();
    setInterval(sitesKV, 10 * 60000);

    // nouveau passage du planificateur ? on relit chaque minute
    // (le proprietaire du cumul est relu toutes les 10 min : recherche reattribuee)
    var tour = 0;
    setInterval(function () {
      (++tour % 10 ? Promise.resolve() : chargerProprios()).then(function () {
        var cumul = managers[0], spl = loadjob("wall_cumul");
        if (cumul && cumul.settings.get("search") !== spl) cumul.settings.set("search", spl);
        managers.forEach(function (m) { m.startSearch(); });
      });
    }, 60000);
    setInterval(function () {
      Object.keys(lots).forEach(function (k) {
        if (Date.now() - lots[k].recu > ATTENTE_LOT) livrer(+k);   // source en retard
      });
      if (Date.now() - dernierLivre > 12 * 60000) cb.state(false, "Recherches planifiées en retard");
    }, 20000);
  },

  /* Equipe : analystes (nom, photo) et planning, dans deux collections KV store
     remplies par le tableau de bord "configuration". Lues par l'API REST du
     KV store : ce n'est pas une recherche, le quota de 3 recherches
     simultanees du compte de l'ecran reste aux donnees. */
  team: function () {
    // collection des analystes absente (appli pas encore redemarree) : vignettes livrees
    var analystes = kv("wall_analystes").catch(function (e) { console.warn("mur :", e.message); return []; });
    return Promise.all([analystes, kv("wall_planning")]).then(function (res) {
      var noms = {}, cles = PHOTOS.slice(), planning = {}, erreurs = [];
      PHOTOTHEQUE = {};
      res[0].forEach(function (a) {
        var k = cle(a._key || a.nom); if (!k) return;
        noms[k] = a.nom || k;
        if (a.photo) PHOTOTHEQUE[k] = a.photo;
        if (cles.indexOf(k) < 0 && a.photo) cles.push(k);
      });
      res[1].forEach(function (r) {
        var d = dateIso(r.date);
        if (!d) { erreurs.push("date illisible : " + r.date); return; }
        planning[d] = {
          service: [r.en_service_1, r.en_service_2].map(cle).filter(Boolean),
          astreinte: cle(r.astreinte)
        };
      });
      return { analystes: cles, planning: planning, noms: noms, erreurs: erreurs };
    });
  },

  // double-clic sur la courbe : les attaques de la tranche, dans l'appli Recherche
  rechercheUrl: function (debutMs) {
    var d = Math.floor(debutMs / 1000);
    var spl = 'search index=' + SUMMARY + ' search_name=wall_* search_name!=wall_cumul NOT meta=1 ' + UNIQUE_SH +
      ' | table _time source_tech severity signature src_ip Country dest_host action dc search_name | sort 0 _time';
    return splunkUtil.make_url("/app/" + APP + "/search") + "?q=" + encodeURIComponent(spl) +
      "&earliest=" + d + "&latest=" + (d + 300);
  },

  // la page ne propose pas de relire au-dela de ce que le summary contient
  replayMax: function () { return finSummary || Date.now() - 12 * 60000; },

  replay: function (debutMs) {
    var d = Math.floor(debutMs / 1000), id = "mur-relecture-" + (++nRelecture);
    return new Promise(function (ok, ko) {
      var fini = false;
      function fin(err, val) {
        if (fini) return; fini = true;
        try { mvc.Components.revokeInstance(id); } catch (e) {}
        err ? ko(err) : ok(val);
      }
      var sm = new SearchManager({
        id: id, search: SPL_RELECTURE, earliest_time: String(d), latest_time: String(d + 300),
        cache: false, preview: false, autostart: true
      });
      var res = sm.data("results", { count: 0, output_mode: "json_rows" });
      res.on("data", function () { if (res.hasData()) fin(null, lignes(res).map(versEvenement)); });
      sm.on("search:done", function (p) {
        if (p && p.content && p.content.resultCount === 0) fin(null, []);
      });
      sm.on("search:error search:fail", function (p) {
        fin(new Error((p && p.message) || "recherche en échec"));
      });
    });
  },

  /* Bilan d'une periode passee (selecteur du mur : 24 h, 7 j, 30 j). Interroge
     directement l'index summary sur la periode, dedupliques par search head.
     Rend les compteurs (dims), la courbe (par heure ou par jour) et un
     echantillon d'evenements pour le flux. */
  periode: function (earliest, latest, parJour) {
    var base = 'search index=' + SUMMARY + ' search_name=wall_* search_name!=wall_cumul NOT meta=1 ' + UNIQUE_SH;
    function unShot(spl) {
      return new Promise(function (ok, ko) {
        var id = "mur-periode-" + (++nRelecture), fini = false;
        function fin(err, val) { if (fini) return; fini = true;
          try { mvc.Components.revokeInstance(id); } catch (e) {} err ? ko(err) : ok(val); }
        var sm = new SearchManager({ id: id, search: spl, earliest_time: earliest, latest_time: latest,
          cache: false, preview: false, autostart: true });
        var res = sm.data("results", { count: 0, output_mode: "json_rows" });
        res.on("data", function () { if (res.hasData()) fin(null, lignes(res)); });
        sm.on("search:done", function (p) { if (p && p.content && p.content.resultCount === 0) fin(null, []); });
        sm.on("search:error search:fail", function (p) { fin(new Error((p && p.message) || "recherche en échec")); });
      });
    }
    var out = { dims: { total: 0, blocked: 0, crit: 0, sev: {}, cty: {}, sig: {}, tech: {}, site: {} }, courbe: [], feed: [] };
    function add(o, k, n) { if (k !== undefined && k !== null && k !== "") o[k] = (o[k] || 0) + n; }
    var taches = [
      function () {
        return unShot(base + ' | stats count by Country, signature, source_tech, dc, severity, action').then(function (rows) {
          var d = out.dims;
          rows.forEach(function (r) {
            var n = parseInt(r.count, 10) || 0;
            d.total += n;
            if (r.action === "blocked") d.blocked += n;
            if (r.severity === "critical" || r.severity === "high") d.crit += n;
            add(d.sev, r.severity, n); add(d.cty, r.Country, n); add(d.sig, r.signature, n);
            add(d.tech, r.source_tech, n); add(d.site, r.dc, n);
          });
        });
      },
      function () {
        // _time est formate (ISO) en sortie timechart : "+0" le ramene a l'epoch numerique
        return unShot(base + ' | timechart span=' + (parJour ? "1d" : "1h") + ' count | eval ep=_time+0').then(function (rows) {
          out.courbe = rows.map(function (r) { return { t: parseFloat(r.ep) * 1000, count: parseInt(r.count, 10) || 0 }; });
        });
      },
      function () {
        return unShot(base + ' | sort 0 - _time | head 300').then(function (rows) { out.feed = rows.map(versEvenement); });
      }
    ];
    // en serie : le quota de recherches simultanees du compte d'affichage est limite
    return taches.reduce(function (p, t) { return p.then(t); }, Promise.resolve()).then(function () { return out; });
  },

  // photo enregistree dans la configuration, sinon la vignette livree avec l'appli
  photo: function (k) {
    return PHOTOTHEQUE[k] || splunkUtil.make_url("/static/app/" + APP + "/team/" + encodeURIComponent(k) + ".jpg");
  }
};
