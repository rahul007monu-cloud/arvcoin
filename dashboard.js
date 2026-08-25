/* =========================================================
   arvcoin — dashboard (advisory)

   The old crypto-investing dashboard has been removed.
   There is no fake portfolio, no fake holdings and no fake P&L here —
   only real data: your plan, your coverage, and published research.
   ========================================================= */
import {
  ready, requireAuth, currentUser, isAnalyst, logout,
  getProfile, watchSubscription, entitlement,
  listAnalysis, listRecaps, listLessons, when, toMillis
} from "./arv-core.js";

var CFG = window.ARV_CONFIG;
var $ = function (id) { return document.getElementById(id); };
var $all = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

var ent = entitlement(null);
var REGISTERED = CFG.isRegistered();

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function num(n) {
  if (n == null || n === "" || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/* =========================================================
   View switching
   ========================================================= */
function switchView(v) {
  $all(".view").forEach(function (s) {
    s.classList.toggle("active", s.getAttribute("data-view") === v);
  });
  $all(".side-link[data-view]").forEach(function (a) {
    a.classList.toggle("active", a.getAttribute("data-view") === v);
  });
  var side = $("side");
  if (side) side.classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$all(".side-link[data-view]").forEach(function (a) {
  a.addEventListener("click", function (e) {
    e.preventDefault();
    switchView(a.getAttribute("data-view"));
  });
});

var avatar = $("tb-avatar");
if (avatar) avatar.addEventListener("click", function () { switchView("settings"); });

var menuBtn = $("menu-btn");
if (menuBtn) menuBtn.addEventListener("click", function () {
  var s = $("side");
  if (s) s.classList.toggle("open");
});

/* =========================================================
   Logout
   ========================================================= */
[$("logout"), $("btn-logout2")].forEach(function (b) {
  if (b) b.addEventListener("click", function (e) { e.preventDefault(); logout(); });
});

/* =========================================================
   Greeting
   ========================================================= */
(function () {
  var h = new Date().getHours();
  var g = h < 12 ? "Good morning" : (h < 17 ? "Good afternoon" : "Good evening");
  var el = $("greet");
  if (el) el.textContent = g + " 👋";
})();

/* =========================================================
   Mode note + disclosures
   ========================================================= */
function paintMode() {
  var n = $("mode-note");
  if (!n) return;
  if (REGISTERED) {
    var ra = CFG.RA_REGISTRATION;
    n.className = "lux-note good";
    n.innerHTML = '<span class="n-ico">✅</span><div><b>SEBI Registered Research Analyst.</b> ' +
      'Reg. no. ' + esc(ra.number) + '. ' + esc(CFG.DISCLOSURES.marketRisk) + '</div>';
  } else {
    n.className = "lux-note";
    n.innerHTML = '<span class="n-ico">🎓</span><div><b>Education mode.</b> ' +
      esc(CFG.DISCLOSURES.notRegistered) + ' ' + esc(CFG.DISCLOSURES.educationOnly) + '</div>';
  }

  var d = $("disc");
  if (d) {
    var D = CFG.DISCLOSURES;
    d.innerHTML = "<b>Important disclosures</b>" + [
      REGISTERED ? D.registeredNote : D.notRegistered,
      D.educationOnly, D.marketRisk, D.noGuarantee,
      D.noPersonalAdvice, D.forexWarning, D.cryptoTax
    ].map(function (p) { return "<p>" + esc(p) + "</p>"; }).join("");
  }
}

/* =========================================================
   Plan / coverage
   ========================================================= */
function paintPlan() {
  var pill = $("plan-pill");
  if (pill) {
    if (ent.active) {
      pill.className = "pill-stat ok";
      pill.innerHTML = "<b>" + esc(ent.planName || ent.planId) + "</b> · " + ent.daysLeft + "d";
    } else if (ent.expired) {
      pill.className = "pill-stat warn";
      pill.textContent = "Plan expired";
    } else {
      pill.className = "pill-stat";
      pill.textContent = "Free account";
    }
  }

  if (ent.active) {
    $("plan-name").textContent = ent.planName || ent.planId;
    $("plan-meta").textContent = ent.daysLeft + " days left · "  +
      ent.segments.length + " / " + CFG.SEGMENT_ORDER.length + " segments unlocked";
    $("plan-cta").textContent = "Upgrade →";
  } else if (ent.expired) {
    $("plan-name").textContent = "Plan expired";
    $("plan-meta").textContent = "Renew to restore your research access.";
    $("plan-cta").textContent = "Renew →";
  }

  // segment chips
  var chips = $("seg-chips");
  if (chips) {
    chips.innerHTML = CFG.SEGMENT_ORDER.map(function (sid) {
      var s = CFG.SEGMENTS[sid];
      var has = ent.active && ent.segments.indexOf(sid) > -1;
      return '<span style="' +
        (has ? "color:" + s.color + ";border-color:" + s.color + "40" : "opacity:.45") +
        '">' + s.icon + " " + esc(s.name) + (has ? " ✓" : " 🔒") + "</span>";
    }).join("");
  }

  // upgrade promo
  var promo = $("side-promo");
  if (promo) {
    var missing = CFG.SEGMENT_ORDER.filter(function (sid) {
      return !(ent.active && ent.segments.indexOf(sid) > -1);
    });
    if (missing.length) {
      promo.style.display = "block";
      $("sp-sub").textContent = missing.map(function (sid) {
        return CFG.SEGMENTS[sid].name;
      }).join(", ") + " — unlock these.";
    } else {
      promo.style.display = "none";
    }
  }

  // my plan tab
  $("p-name").textContent = ent.active ? (ent.planName || ent.planId) : "—";
  $("p-status").textContent = ent.active ? "Active" : (ent.expired ? "Expired" : "No plan");
  $("p-till").textContent = ent.activeTill
    ? new Date(ent.activeTill).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "—";
  $("p-days").textContent = ent.active ? ent.daysLeft + " days" : "—";
  $("p-segs").textContent = ent.active && ent.segments.length
    ? ent.segments.map(function (s) { return CFG.SEGMENTS[s] ? CFG.SEGMENTS[s].name : s; }).join(", ")
    : "—";
}

/* =========================================================
   Cards
   ========================================================= */
function analysisCard(a) {
  var seg = CFG.SEGMENTS[a.segment] || { name: a.segment, icon: "🧮", color: "#00e0ff" };
  var lv = a.levels || {};
  var tone = lv.biasTone === "up" ? "target_hit" : (lv.biasTone === "down" ? "sl_hit" : "closed");
  return '' +
    '<article class="call-card">' +
      '<div class="cc-top">' +
        '<span class="cc-inst">' + esc(a.instrument) + '</span>' +
        (lv.biasLabel ? '<span class="cc-status ' + tone + '">' + esc(lv.biasLabel) + '</span>' : "") +
        '<span class="cc-when">' + when(a.publishedAt) + '</span>' +
      '</div>' +
      '<div class="cc-meta">' +
        '<span class="chip" style="color:' + seg.color + '">' + seg.icon + " " + esc(seg.name) + '</span>' +
        '<span class="chip">' + esc(a.timeframe || "daily") + '</span>' +
        (lv.cprShape ? '<span class="chip">CPR ' + esc(lv.cprShape) + '</span>' : "") +
      '</div>' +
      '<div class="cc-levels">' +
        '<div class="lvl s"><small>S1</small><b>' + num(lv.s1) + '</b></div>' +
        '<div class="lvl"><small>Pivot</small><b>' + num(lv.pivot) + '</b></div>' +
        '<div class="lvl t"><small>R1</small><b>' + num(lv.r1) + '</b></div>' +
        '<div class="lvl"><small>Range</small><b>' + num(lv.range) + '</b></div>' +
      '</div>' +
      (a.observation ? '<div class="cc-why"><b>Observation</b>' + esc(a.observation) + '</div>' : "") +
    '</article>';
}

function recapCard(r) {
  return '' +
    '<article class="call-card">' +
      '<div class="cc-top">' +
        '<span class="cc-inst">Recap — ' + esc(r.date || "") + '</span>' +
        '<span class="cc-when">' + when(r.createdAt || r.date) + '</span>' +
      '</div>' +
      (r.summary ? '<div class="cc-why"><b>What happened</b>' + esc(r.summary) + '</div>' : "") +
      (r.why ? '<div class="cc-why"><b>Why it happened</b>' + esc(r.why) + '</div>' : "") +
    '</article>';
}

function lessonCard(l) {
  var seg = CFG.SEGMENTS[l.segment] || { name: l.segment || "General", icon: "🎓" };
  return '' +
    '<article class="call-card">' +
      '<div class="cc-top">' +
        '<span class="cc-inst">' + esc(l.title) + '</span>' +
        (l.free ? '<span class="cc-status target_hit">Free</span>'
                : '<span class="cc-status active">Subscriber</span>') +
      '</div>' +
      '<div class="cc-meta">' +
        '<span class="chip">' + seg.icon + " " + esc(seg.name) + '</span>' +
        (l.level ? '<span class="chip">' + esc(l.level) + '</span>' : "") +
      '</div>' +
      (l.summary ? '<div class="cc-why"><b>What you will learn</b>' + esc(l.summary) + '</div>' : "") +
    '</article>';
}

function empty(icon, title, body, cta) {
  return '<div class="empty"><div class="e-ico">' + icon + '</div><h3>' + esc(title) + '</h3>' +
         '<p>' + esc(body) + '</p>' + (cta || "") + '</div>';
}

/* =========================================================
   Load feeds
   ========================================================= */
function loadFeeds() {
  listAnalysis({ limit: 5 }).then(function (rows) {
    $("latest-feed").innerHTML = rows.length
      ? rows.map(analysisCard).join("")
      : empty("🧮", "Analysis coming soon",
          "Levels analysis appears here once published. Meanwhile, use the free calculator.",
          '<a href="levels.html" class="btn btn-primary">Levels calculator →</a>');
  });

  listRecaps(10).then(function (rows) {
    $("recap-feed").innerHTML = rows.length
      ? rows.map(recapCard).join("")
      : empty("≣", "Recaps starting soon", "Daily market recaps will appear here once published.");
  });

  listLessons({ limit: 30 }).then(function (rows) {
    $("lesson-feed").innerHTML = rows.length
      ? rows.map(lessonCard).join("")
      : empty("🎓", "Lessons on the way", "From market basics to advanced concepts — being published now.");
  });
}

/* =========================================================
   Boot
   ========================================================= */
paintMode();
paintPlan();

if (!ready) {
  $("latest-feed").innerHTML = empty("⚙️", "Firebase config missing",
    "Add your project config to firebase-config.js.");
} else {
  requireAuth("login.html").then(function (u) {
    if (!u) return;

    var name = u.displayName || (u.email || "").split("@")[0] || "Investor";
    $("hello-name").textContent = name;
    $("tb-avatar").textContent = name.charAt(0).toUpperCase();

    if (isAnalyst()) $("admin-link").style.display = "flex";

    $("s-name").textContent = u.displayName || "—";
    $("s-email").textContent = u.email || "—";
    $("s-created").textContent = u.metadata && u.metadata.creationTime
      ? new Date(u.metadata.creationTime).toLocaleDateString("en-IN",
          { day: "numeric", month: "short", year: "numeric" })
      : "—";

    $("s-uid").textContent = u.uid;
    var cu = $("copy-uid");
    if (cu) cu.addEventListener("click", function () {
      navigator.clipboard.writeText(u.uid).then(function () {
        cu.textContent = "Copied ✓";
        setTimeout(function () { cu.textContent = "Copy UID"; }, 1800);
      }).catch(function () {});
    });

    getProfile().then(function (p) {
      $("s-verified").textContent = (p && p.emailVerified) ? "Yes ✓" : "Pending";
    });

    watchSubscription(function (sub) {
      ent = entitlement(sub);
      paintPlan();
    });

    loadFeeds();
  });
}
