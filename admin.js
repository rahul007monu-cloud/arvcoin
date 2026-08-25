/* =========================================================
   arvcoin — admin publishing panel

   Teen cheezein publish hoti hain:
     call   -> RA registration ZAROORI (gate lagi hai)
     lesson -> education, registration nahi chahiye
     recap  -> education, registration nahi chahiye

   Access: sirf analyst/admin custom claim wale users.
   firestore.rules bhi yahi enforce karti hain — ye page
   chhup jaana sirf UX hai, security rules me hai.
   ========================================================= */
import {
  ready, requireAnalyst, isAdmin, isAnalyst, db,
  publishCall, when
} from "./arv-core.js";
import {
  collection, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

var CFG = window.ARV_CONFIG;
var $ = function (id) { return document.getElementById(id); };

var REGISTERED = CFG.isRegistered();
var kind = "call";

/* ---------------------------------------------------------
   Setup
--------------------------------------------------------- */
function fillSegments(sel) {
  var el = $(sel);
  if (!el) return;
  el.innerHTML = CFG.SEGMENT_ORDER.map(function (id) {
    var s = CFG.SEGMENTS[id];
    return '<option value="' + id + '">' + s.icon + " " + s.name + "</option>";
  }).join("");
}

function paintHeader() {
  $("pill-role").textContent = isAdmin() ? "Admin" : (isAnalyst() ? "Analyst" : "—");
  $("pill-role").className = "pill-stat ok";

  var ra = CFG.RA_REGISTRATION;
  if (REGISTERED) {
    $("pill-ra").innerHTML = "RA: <b>" + ra.number + "</b>";
    $("pill-ra").className = "pill-stat ok";
  } else {
    $("pill-ra").textContent = "RA: not set";
    $("pill-ra").className = "pill-stat warn";
    $("ra-gate").style.display = "block";
  }
}

function msg(kindStr, text) {
  var m = $("msg");
  m.className = "adm-msg show " + kindStr;
  m.textContent = text;
  m.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clearMsg() { $("msg").className = "adm-msg"; }

function showLint(res) {
  var box = $("lint");
  if (!res) { box.className = "lint-out"; return; }
  var cls = res.hits.length ? "bad" : ((res.warnings.length || res.personal.length) ? "warn" : "ok");
  box.className = "lint-out show " + cls;
  box.textContent = window.ARVLint.explain(res);
}

/* ---------------------------------------------------------
   Kind tabs
--------------------------------------------------------- */
function switchKind(k) {
  kind = k;
  $("form-call").style.display = k === "call" ? "block" : "none";
  $("form-lesson").style.display = k === "lesson" ? "block" : "none";
  $("form-recap").style.display = k === "recap" ? "block" : "none";
  clearMsg();
  showLint(null);
  renderPreview();
  document.querySelectorAll("#kind-tabs .seg-tab").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-kind") === k);
  });
}

document.querySelectorAll("#kind-tabs .seg-tab").forEach(function (b) {
  b.addEventListener("click", function () { switchKind(b.getAttribute("data-kind")); });
});

/* ---------------------------------------------------------
   Currency warning
--------------------------------------------------------- */
$("c-segment").addEventListener("change", function () {
  $("fx-warn").style.display = this.value === "currency" ? "block" : "none";
  renderPreview();
});

/* ---------------------------------------------------------
   Read form
--------------------------------------------------------- */
function readCall() {
  var targets = $("c-targets").value.split(",")
    .map(function (t) { return parseFloat(t.trim()); })
    .filter(function (t) { return !isNaN(t); });

  return {
    segment: $("c-segment").value,
    instrument: $("c-instrument").value.trim(),
    exchange: $("c-exchange").value,
    action: $("c-action").value,
    entry: parseFloat($("c-entry").value),
    entryType: $("c-entrytype").value,
    targets: targets,
    stopLoss: parseFloat($("c-sl").value),
    horizon: $("c-horizon").value,
    riskLevel: $("c-risk").value,
    rationale: $("c-rationale").value.trim(),
    title: $("c-instrument").value.trim() + " — " + $("c-action").value
  };
}

/* ---------------------------------------------------------
   Preview
--------------------------------------------------------- */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function num(n) {
  return (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function renderPreview() {
  var p = $("preview");

  if (kind === "call") {
    var c = readCall();
    var seg = CFG.SEGMENTS[c.segment] || { name: c.segment, icon: "◎" };
    var ra = CFG.RA_REGISTRATION;
    p.innerHTML =
      '<div class="cc-top">' +
        '<span class="cc-action ' + (c.action === "SELL" ? "sell" : "buy") + '">' + esc(c.action) + '</span>' +
        '<span class="cc-inst">' + (esc(c.instrument) || "INSTRUMENT") + '</span>' +
        '<span class="cc-exch">' + esc(c.exchange) + '</span>' +
        '<span class="cc-status active">Active</span>' +
      '</div>' +
      '<div class="cc-meta">' +
        '<span class="chip">' + seg.icon + " " + esc(seg.name) + '</span>' +
        '<span class="chip">Horizon: ' + esc(c.horizon) + '</span>' +
        '<span class="chip">Risk: ' + esc(c.riskLevel) + '</span>' +
      '</div>' +
      '<div class="cc-levels">' +
        '<div class="lvl"><small>Entry</small><b>' + num(c.entry) + '</b></div>' +
        '<div class="lvl t"><small>Targets</small><b>' + (c.targets.map(num).join(" / ") || "—") + '</b></div>' +
        '<div class="lvl s"><small>Stop loss</small><b>' + num(c.stopLoss) + '</b></div>' +
        '<div class="lvl"><small>Type</small><b>' + esc(c.entryType) + '</b></div>' +
      '</div>' +
      (c.rationale ? '<div class="cc-why"><b>Rationale</b>' + esc(c.rationale) + '</div>' : "") +
      '<div class="cc-ra"><b>SEBI Research Analyst</b> Reg. ' + esc(ra.number || "NOT SET") +
        (ra.analystName ? " · " + esc(ra.analystName) : "") + '</div>';
    return;
  }

  if (kind === "lesson") {
    var seg2 = CFG.SEGMENTS[$("l-segment").value] || { name: "General", icon: "🎓" };
    p.innerHTML =
      '<div class="cc-top">' +
        '<span class="cc-inst">' + (esc($("l-title").value) || "Lesson title") + '</span>' +
        ($("l-free").value === "true" ? '<span class="cc-status target_hit">Free</span>'
                                      : '<span class="cc-status active">Subscriber</span>') +
      '</div>' +
      '<div class="cc-meta">' +
        '<span class="chip">' + seg2.icon + " " + esc(seg2.name) + '</span>' +
        '<span class="chip">' + esc($("l-level").value) + '</span>' +
      '</div>' +
      ($("l-summary").value ? '<div class="cc-why"><b>Kya seekhoge</b>' + esc($("l-summary").value) + '</div>' : "");
    return;
  }

  p.innerHTML =
    '<div class="cc-top">' +
      '<span class="cc-inst">Market recap — ' + (esc($("r-date").value) || "date") + '</span>' +
      '<span class="cc-status closed">Recap</span>' +
    '</div>' +
    ($("r-summary").value ? '<div class="cc-why"><b>Aaj kya hua</b>' + esc($("r-summary").value) + '</div>' : "") +
    ($("r-why").value ? '<div class="cc-why"><b>Kyun hua</b>' + esc($("r-why").value) + '</div>' : "");
}

/* live preview + live lint */
["c-instrument","c-action","c-entry","c-targets","c-sl","c-entrytype","c-horizon","c-risk",
 "c-rationale","c-exchange","l-title","l-summary","l-segment","l-level","l-free",
 "r-date","r-summary","r-why"].forEach(function (id) {
  var el = $(id);
  if (!el) return;
  el.addEventListener("input", function () {
    renderPreview();
    var text = kind === "call" ? [$("c-instrument").value, $("c-rationale").value].join("\n")
             : kind === "lesson" ? [$("l-title").value, $("l-summary").value, $("l-body").value].join("\n")
             : [$("r-summary").value, $("r-why").value].join("\n");
    showLint(text.trim() ? window.ARVLint.check(text) : null);
  });
  el.addEventListener("change", renderPreview);
});

/* ---------------------------------------------------------
   Publish: CALL
--------------------------------------------------------- */
$("form-call").addEventListener("submit", function (e) {
  e.preventDefault();
  clearMsg();

  var c = readCall();

  // client-side sanity
  var bad = [];
  if (!c.instrument) bad.push("instrument");
  if (isNaN(c.entry)) bad.push("entry");
  if (isNaN(c.stopLoss)) bad.push("stop loss");
  if (!c.targets.length) bad.push("targets");
  if (c.rationale.length < 20) bad.push("rationale (min 20 chars)");
  if (bad.length) { msg("bad", "Ye fields theek karo: " + bad.join(", ")); return; }

  var lint = window.ARVLint.check([c.title, c.rationale].join("\n"));
  showLint(lint);
  if (!lint.ok) { msg("bad", "Compliance block — banned phrases hata do."); return; }

  var btn = $("btn-call");
  btn.disabled = true;
  msg("ok", "Publish ho raha hai…");

  publishCall(c)
    .then(function (ref) {
      msg("ok", "✅ Call publish ho gaya (" + ref.id + "). Subscribers ko dikhne laga.");
      $("form-call").reset();
      fillSegments("c-segment");
      renderPreview();
      btn.disabled = false;
    })
    .catch(function (err) {
      msg("bad", "❌ " + (err && err.message ? err.message : "Publish fail"));
      btn.disabled = false;
    });
});

/* ---------------------------------------------------------
   Publish: LESSON
--------------------------------------------------------- */
$("form-lesson").addEventListener("submit", function (e) {
  e.preventDefault();
  clearMsg();

  var title = $("l-title").value.trim();
  var body = $("l-body").value.trim();
  if (title.length < 4) { msg("bad", "Title likho."); return; }
  if (body.length < 40) { msg("bad", "Lesson body chhota hai (min 40 chars)."); return; }

  var lint = window.ARVLint.check([title, $("l-summary").value, body].join("\n"));
  showLint(lint);
  if (!lint.ok) { msg("bad", "Compliance block — banned phrases hata do."); return; }

  var btn = $("btn-lesson");
  btn.disabled = true;
  msg("ok", "Publish ho raha hai…");

  addDoc(collection(db, "lessons"), {
    title: title,
    summary: $("l-summary").value.trim(),
    body: body,
    segment: $("l-segment").value,
    level: $("l-level").value,
    free: $("l-free").value === "true",
    order: parseInt($("l-order").value, 10) || 10,
    readMins: Math.max(1, Math.round(body.split(/\s+/).length / 200)),
    publishedAt: serverTimestamp()
  })
    .then(function (ref) {
      msg("ok", "✅ Lesson publish ho gaya (" + ref.id + ").");
      $("form-lesson").reset();
      fillSegments("l-segment");
      renderPreview();
      btn.disabled = false;
    })
    .catch(function (err) {
      msg("bad", "❌ " + (err && err.message ? err.message : "Publish fail"));
      btn.disabled = false;
    });
});

/* ---------------------------------------------------------
   Publish: RECAP
--------------------------------------------------------- */
$("form-recap").addEventListener("submit", function (e) {
  e.preventDefault();
  clearMsg();

  var date = $("r-date").value;
  var summary = $("r-summary").value.trim();
  if (!date) { msg("bad", "Date choose karo."); return; }
  if (summary.length < 20) { msg("bad", "Summary likho (min 20 chars)."); return; }

  var lint = window.ARVLint.check([summary, $("r-why").value].join("\n"));
  showLint(lint);
  if (!lint.ok) { msg("bad", "Compliance block — banned phrases hata do."); return; }

  var btn = $("btn-recap");
  btn.disabled = true;
  msg("ok", "Publish ho raha hai…");

  addDoc(collection(db, "recaps"), {
    date: date,
    summary: summary,
    why: $("r-why").value.trim(),
    createdAt: serverTimestamp()
  })
    .then(function (ref) {
      msg("ok", "✅ Recap publish ho gaya (" + ref.id + ").");
      $("form-recap").reset();
      renderPreview();
      btn.disabled = false;
    })
    .catch(function (err) {
      msg("bad", "❌ " + (err && err.message ? err.message : "Publish fail"));
      btn.disabled = false;
    });
});

/* ---------------------------------------------------------
   Boot
--------------------------------------------------------- */
fillSegments("c-segment");
fillSegments("l-segment");
$("r-date").value = new Date().toISOString().slice(0, 10);

if (!ready) {
  msg("bad", "Firebase config missing — firebase-config.js me daalo.");
} else {
  requireAnalyst("dashboard.html").then(function (u) {
    if (!u) return;
    paintHeader();
    renderPreview();
    if (!REGISTERED) {
      $("btn-call").disabled = true;
      $("btn-call").textContent = "Publishing band — RA number set karo";
    }
  });
}
