/* =========================================================
   arvcoin — research calls feed

   Two modes:
     1) RA registration NOT set -> education mode
        (lessons and daily recaps only, no research notes)
     2) RA registration set     -> research mode
        (notes shown, locked or unlocked by subscription)

   The full detail of a locked note never reaches the client —
   firestore.rules returns permission-denied. Teasers come from a
   separate collection, so the blur is real, not cosmetic.
   ========================================================= */
import {
  ready, onUser, requireAuth, watchSubscription,
  entitlement, listCalls, listTeasers, listLessons, listRecaps, listAnalysis,
  performanceStats, inr, when
} from "./arv-core.js";

var CFG = window.ARV_CONFIG;
var $ = function (id) { return document.getElementById(id); };

var state = {
  segment: "all",
  ent: entitlement(null),
  calls: [],
  teasers: [],
  lessons: [],
  recaps: [],
  analysis: [],
  loading: true
};

var REGISTERED = CFG.isRegistered();

/* ---------------------------------------------------------
   Disclosures
--------------------------------------------------------- */
function paintDisclosures() {
  var D = CFG.DISCLOSURES;
  $("d-reg").textContent = REGISTERED ? D.registeredNote : D.notRegistered;
  $("d-risk").textContent = D.marketRisk;
  $("d-guar").textContent = D.noGuarantee;
  $("d-personal").textContent = D.noPersonalAdvice;
  $("d-forex").textContent = D.forexWarning;
  $("d-arv").textContent = D.arvNature;
}

/* ---------------------------------------------------------
   Mode banner
--------------------------------------------------------- */
function paintModeBanner() {
  var b = $("mode-banner");
  b.style.display = "flex";
  if (REGISTERED) {
    var ra = CFG.RA_REGISTRATION;
    b.className = "mode-banner live";
    $("mb-ico").textContent = "✅";
    $("mb-title").textContent = "Research services — SEBI Registered Research Analyst.";
    $("mb-text").textContent =
      "Reg. no. " + ra.number +
      (ra.entityName ? " · " + ra.entityName : "") +
      (ra.analystName ? " · Analyst: " + ra.analystName : "") +
      ". Registration details appear on every note.";
  } else {
    b.className = "mode-banner";
    $("mb-ico").textContent = "🎓";
    $("mb-title").textContent = "Education mode is active.";
    $("mb-text").textContent =
      "Levels analysis, market recaps and lessons — with computed support and resistance " +
      "plus structural observations. Buy and sell recommendations require SEBI Research " +
      "Analyst registration (RA Regulations, 2014) and unlock once that is in place.";
    $("ph-sub").textContent = "Levels analysis, daily recaps and market concepts.";
  }
}

/* ---------------------------------------------------------
   Segment tabs
--------------------------------------------------------- */
function paintTabs() {
  var wrap = $("seg-tabs");
  var html = '<button class="seg-tab' + (state.segment === "all" ? " active" : "") +
             '" data-seg="all"><i>◎</i> All</button>';

  CFG.SEGMENT_ORDER.forEach(function (id) {
    var s = CFG.SEGMENTS[id];
    var covered = state.ent.active && state.ent.segments.indexOf(id) > -1;
    var lock = (REGISTERED && !covered) ? ' <span class="lock">🔒</span>' : "";
    html += '<button class="seg-tab' + (state.segment === id ? " active" : "") +
            '" data-seg="' + id + '"><i>' + s.icon + '</i> ' + s.name + lock + '</button>';
  });

  wrap.innerHTML = html;
  wrap.querySelectorAll(".seg-tab").forEach(function (b) {
    b.addEventListener("click", function () {
      state.segment = b.getAttribute("data-seg");
      paintTabs();
      load();
    });
  });
}

/* ---------------------------------------------------------
   Header pills
--------------------------------------------------------- */
function paintPills() {
  // segment coverage pill
  var cov = $("pill-credits");
  if (cov) {
    if (state.ent.active) {
      cov.innerHTML = "<b>" + state.ent.segments.length + "</b> / " +
                      CFG.SEGMENT_ORDER.length + " segments";
      cov.className = "pill-stat ok";
    } else {
      cov.innerHTML = '<a href="pricing.html" style="color:var(--cyan)">Upgrade</a>';
      cov.className = "pill-stat";
    }
  }
  var p = $("pill-plan");
  if (state.ent.active) {
    p.className = "pill-stat ok";
    p.innerHTML = "<b>" + (state.ent.planName || state.ent.planId) + "</b> · " + state.ent.daysLeft + "d left";
  } else if (state.ent.expired) {
    p.className = "pill-stat warn";
    p.innerHTML = "Plan expired";
  } else {
    p.className = "pill-stat";
    p.textContent = "No active plan";
  }
}

/* ---------------------------------------------------------
   Renderers
--------------------------------------------------------- */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(n) {
  if (n == null || n === "") return "—";
  return Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

var STATUS_LABEL = {
  active: "Active",
  target_hit: "Target hit",
  sl_hit: "SL hit",
  closed: "Closed"
};

function callCard(c) {
  var seg = CFG.SEGMENTS[c.segment] || { name: c.segment, icon: "◎" };
  var act = String(c.action || "").toLowerCase();
  var targets = (c.targets || []).map(num).join(" / ");

  return '' +
    '<article class="call-card">' +
      '<div class="cc-top">' +
        '<span class="cc-action ' + (act === "sell" ? "sell" : "buy") + '">' + esc((c.action || "").toUpperCase()) + '</span>' +
        '<span class="cc-inst">' + esc(c.instrument) + '</span>' +
        '<span class="cc-exch">' + esc(c.exchange || "NSE") + '</span>' +
        '<span class="cc-status ' + esc(c.status || "active") + '">' + (STATUS_LABEL[c.status] || "Active") + '</span>' +
        '<span class="cc-when">' + when(c.publishedAt) + '</span>' +
      '</div>' +

      '<div class="cc-meta">' +
        '<span class="chip">' + seg.icon + " " + esc(seg.name) + '</span>' +
        '<span class="chip">Horizon: ' + esc(c.horizon || "short") + '</span>' +
        '<span class="chip">Risk: ' + esc(c.riskLevel || "moderate") + '</span>' +
      '</div>' +

      '<div class="cc-levels">' +
        '<div class="lvl"><small>Entry</small><b>' + num(c.entry) + '</b></div>' +
        '<div class="lvl t"><small>Target' + ((c.targets || []).length > 1 ? "s" : "") + '</small><b>' + (targets || "—") + '</b></div>' +
        '<div class="lvl s"><small>Stop loss</small><b>' + num(c.stopLoss) + '</b></div>' +
        '<div class="lvl"><small>' + (c.exitPrice ? "Exit" : "Type") + '</small><b>' +
          (c.exitPrice ? num(c.exitPrice) : esc(c.entryType || "limit")) + '</b></div>' +
      '</div>' +

      (c.rationale ? '<div class="cc-why"><b>Rationale</b>' + esc(c.rationale) + '</div>' : "") +
      (c.exitNote ? '<div class="cc-why"><b>Outcome</b>' + esc(c.exitNote) + '</div>' : "") +

      '<div class="cc-ra">' +
        '<b>SEBI Research Analyst</b> Reg. ' + esc(c.raNumber || "—") +
        (c.analystName ? ' · ' + esc(c.analystName) : "") +
        (c.entityName ? ' · ' + esc(c.entityName) : "") +
      '</div>' +
    '</article>';
}

function lockedCard(t) {
  var seg = CFG.SEGMENTS[t.segment] || { name: t.segment, icon: "◎" };
  return '' +
    '<article class="call-card locked">' +
      '<div class="cc-top">' +
        '<span class="cc-action buy">•••</span>' +
        '<span class="cc-inst">' + esc(t.instrument || t.title || "Research call") + '</span>' +
        '<span class="cc-exch">' + esc(t.exchange || "NSE") + '</span>' +
        '<span class="cc-when">' + when(t.publishedAt) + '</span>' +
      '</div>' +
      '<div class="cc-meta"><span class="chip">' + seg.icon + " " + esc(seg.name) + '</span></div>' +
      '<div class="cc-levels">' +
        '<div class="lvl"><small>Entry</small><b>0000</b></div>' +
        '<div class="lvl t"><small>Target</small><b>0000</b></div>' +
        '<div class="lvl s"><small>Stop loss</small><b>0000</b></div>' +
        '<div class="lvl"><small>Type</small><b>limit</b></div>' +
      '</div>' +
      '<div class="cc-why"><b>Rationale</b>' +
        'The full analysis is available to subscribers. A plan unlocks the entry, targets, stop loss and research rationale.' +
      '</div>' +
      '<div class="lock-overlay">' +
        '<span class="lk-ico">🔒</span>' +
        '<p>' + esc(seg.name) + ' research requires a plan</p>' +
        '<a href="pricing.html" class="btn btn-primary">View plans →</a>' +
      '</div>' +
    '</article>';
}

function analysisCard(a) {
  var seg = CFG.SEGMENTS[a.segment] || { name: a.segment, icon: "🧮", color: "#00e0ff" };
  var lv = a.levels || {};
  var toneCls = lv.biasTone === "up" ? "target_hit" : (lv.biasTone === "down" ? "sl_hit" : "closed");

  return '' +
    '<article class="call-card">' +
      '<div class="cc-top">' +
        '<span class="cc-inst">' + esc(a.instrument) + '</span>' +
        (lv.biasLabel ? '<span class="cc-status ' + toneCls + '">' + esc(lv.biasLabel) + '</span>' : "") +
        '<span class="cc-when">' + when(a.publishedAt) + '</span>' +
      '</div>' +

      '<div class="cc-meta">' +
        '<span class="chip" style="color:' + seg.color + '">' + seg.icon + " " + esc(seg.name) + '</span>' +
        '<span class="chip">' + esc(a.timeframe || "daily") + '</span>' +
        (lv.cprShape ? '<span class="chip">CPR ' + esc(lv.cprShape) + '</span>' : "") +
        (a.free ? '<span class="chip">Free</span>' : "") +
      '</div>' +

      '<div class="cc-levels">' +
        '<div class="lvl s"><small>Support S1</small><b>' + num(lv.s1) + '</b></div>' +
        '<div class="lvl s"><small>Support S2</small><b>' + num(lv.s2) + '</b></div>' +
        '<div class="lvl"><small>Pivot</small><b>' + num(lv.pivot) + '</b></div>' +
        '<div class="lvl t"><small>Resistance R1</small><b>' + num(lv.r1) + '</b></div>' +
      '</div>' +
      '<div class="cc-levels">' +
        '<div class="lvl t"><small>Resistance R2</small><b>' + num(lv.r2) + '</b></div>' +
        '<div class="lvl"><small>CPR top</small><b>' + num(lv.cprTop) + '</b></div>' +
        '<div class="lvl"><small>CPR bottom</small><b>' + num(lv.cprBottom) + '</b></div>' +
        '<div class="lvl"><small>Range</small><b>' + num(lv.range) + '</b></div>' +
      '</div>' +

      (a.observation ? '<div class="cc-why"><b>Structural observation</b>' + esc(a.observation) + '</div>' : "") +

      '<div class="cc-ra">' +
        '<b>Levels calculation</b> Classic pivots + CPR · ' +
        'Computed analysis — not a buy or sell recommendation.' +
      '</div>' +
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
        '<span class="cc-when">' + when(l.publishedAt) + '</span>' +
      '</div>' +
      '<div class="cc-meta">' +
        '<span class="chip">' + seg.icon + " " + esc(seg.name) + '</span>' +
        (l.level ? '<span class="chip">' + esc(l.level) + '</span>' : "") +
        (l.readMins ? '<span class="chip">' + esc(l.readMins) + ' min read</span>' : "") +
      '</div>' +
      (l.summary ? '<div class="cc-why"><b>What you will learn</b>' + esc(l.summary) + '</div>' : "") +
    '</article>';
}

function recapCard(r) {
  return '' +
    '<article class="call-card">' +
      '<div class="cc-top">' +
        '<span class="cc-inst">Market recap — ' + esc(r.date || "") + '</span>' +
        '<span class="cc-status closed">Recap</span>' +
        '<span class="cc-when">' + when(r.createdAt || r.date) + '</span>' +
      '</div>' +
      (r.summary ? '<div class="cc-why"><b>What happened</b>' + esc(r.summary) + '</div>' : "") +
      (r.why ? '<div class="cc-why"><b>Why it happened</b>' + esc(r.why) + '</div>' : "") +
    '</article>';
}

function emptyState(icon, title, body, cta) {
  return '<div class="empty"><div class="e-ico">' + icon + '</div><h3>' + esc(title) + '</h3>' +
         '<p>' + esc(body) + '</p>' + (cta || "") + '</div>';
}

/* ---------------------------------------------------------
   Paint feed
--------------------------------------------------------- */
function paintFeed() {
  var feed = $("feed");

  if (state.loading) {
    feed.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
    return;
  }

  /* ---- education mode: analysis + recap + lessons ---- */
  if (!REGISTERED) {
    $("perf-strip").style.display = "none";
    var eduHtml = "";

    state.analysis.forEach(function (a) { eduHtml += analysisCard(a); });
    state.recaps.forEach(function (r) { eduHtml += recapCard(r); });
    state.lessons.forEach(function (l) { eduHtml += lessonCard(l); });

    if (!eduHtml) {
      eduHtml = emptyState("🧮", "Analysis coming soon",
        "Levels analysis, market recaps and lessons are being published. " +
        "Meanwhile, use the free levels calculator to compute support and resistance for any instrument.",
        '<a href="levels.html" class="btn btn-primary">Levels calculator →</a>');
    }
    feed.innerHTML = eduHtml;
    return;
  }

  /* ---- research mode ---- */
  var perf = performanceStats(state.calls);
  if (state.calls.length) {
    $("perf-strip").style.display = "grid";
    $("pf-total").textContent = perf.total;
    $("pf-active").textContent = perf.active;
    $("pf-wins").textContent = perf.wins;
    $("pf-loss").textContent = perf.losses;
  } else {
    $("perf-strip").style.display = "none";
  }

  var html = "";
  state.calls.forEach(function (c) { html += callCard(c); });
  state.analysis.forEach(function (a) { html += analysisCard(a); });

  // Notes the subscription does not cover render as locked teasers
  var seenIds = {};
  state.calls.forEach(function (c) { seenIds[c.id] = 1; });
  state.teasers.forEach(function (t) {
    if (!seenIds[t.id]) html += lockedCard(t);
  });

  if (!html) {
    if (!state.ent.active) {
      html = emptyState("🔒", "A plan is required",
        "Research notes are for subscribers. Choose a plan to unlock equity, F&O, commodity, currency and crypto research.",
        '<a href="pricing.html" class="btn btn-primary">View plans →</a>');
    } else {
      html = emptyState("📭", "Nothing in this segment yet",
        "New research appears here as soon as it is published.");
    }
  }

  feed.innerHTML = html;
}

/* ---------------------------------------------------------
   Load data
--------------------------------------------------------- */
function load() {
  state.loading = true;
  paintFeed();

  var seg = state.segment === "all" ? null : state.segment;

  if (!REGISTERED) {
    Promise.all([
      listAnalysis({ segment: seg, limit: 40 }),
      listRecaps(5),
      listLessons({ segment: seg, limit: 40 })
    ]).then(function (r) {
      state.analysis = r[0];
      state.recaps = r[1];
      state.lessons = r[2];
      state.loading = false;
      paintFeed();
    });
    return;
  }

  Promise.all([
    listCalls({ segment: seg, limit: 60 }),
    listTeasers({ segment: seg, limit: 40 }),
    listAnalysis({ segment: seg, limit: 40 })
  ]).then(function (r) {
    state.calls = r[0];
    state.teasers = r[1];
    state.analysis = r[2];
    state.loading = false;
    paintFeed();
  });
}

/* ---------------------------------------------------------
   Boot
--------------------------------------------------------- */
paintDisclosures();
paintModeBanner();
paintTabs();

if (!ready) {
  $("feed").innerHTML = emptyState("⚙️", "Firebase config missing",
    "Add your project config to firebase-config.js and this page will show live data.");
} else {
  requireAuth("login.html").then(function (u) {
    if (!u) return;

    watchSubscription(function (sub) {
      state.ent = entitlement(sub);
      paintPills();
      paintTabs();
      load();
    });
  });
}
