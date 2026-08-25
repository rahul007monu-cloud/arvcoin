/* =========================================================
   arvcoin — admin publishing panel

   Three content types can be published:
     note   -> RA registration REQUIRED (gated)
     lesson -> educational, no registration needed
     recap  -> educational, no registration needed

   Access: users with an analyst/admin custom claim only.
   firestore.rules enforces the same thing — hiding this page is
   only UX; the real security is in the rules.
   ========================================================= */
import {
  ready, requireAnalyst, isAdmin, isAnalyst, db, currentUser,
  publishCall, when,
  getSettings, saveSettings,
  pendingPaymentProofs, approvePayment, rejectPayment
} from "./arv-core.js";

function currentUid() { var u = currentUser(); return u ? u.uid : null; }
import {
  collection, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

var CFG = window.ARV_CONFIG;
var $ = function (id) { return document.getElementById(id); };

var REGISTERED = CFG.isRegistered();
var kind = "analysis";
var lastLevels = null;

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
  $("form-analysis").style.display = k === "analysis" ? "block" : "none";
  $("form-call").style.display = k === "call" ? "block" : "none";
  $("form-lesson").style.display = k === "lesson" ? "block" : "none";
  $("form-recap").style.display = k === "recap" ? "block" : "none";
  $("form-pricing").style.display = k === "pricing" ? "block" : "none";
  $("form-approvals").style.display = k === "approvals" ? "block" : "none";

  if (k === "pricing") paintPricingEditors();
  if (k === "approvals") loadApprovals();
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

  if (kind === "analysis") {
    var seg0 = CFG.SEGMENTS[$("a-segment").value] || { name: "—", icon: "🧮", color: "#00e0ff" };
    var lv = lastLevels;
    p.innerHTML =
      '<div class="cc-top">' +
        '<span class="cc-inst">' + (esc($("a-instrument").value) || "INSTRUMENT") + '</span>' +
        '<span class="cc-status ' + (lv && lv.biasTone === "up" ? "target_hit" :
            (lv && lv.biasTone === "down" ? "sl_hit" : "closed")) + '">' +
          (lv ? esc(lv.biasLabel) : "Levels") + '</span>' +
      '</div>' +
      '<div class="cc-meta">' +
        '<span class="chip" style="color:' + seg0.color + '">' + seg0.icon + " " + esc(seg0.name) + '</span>' +
        '<span class="chip">' + esc($("a-timeframe").value) + '</span>' +
        ($("a-free").value === "true" ? '<span class="chip">Free</span>' : '<span class="chip">🔒 Subscribers</span>') +
      '</div>' +
      (lv ?
        '<div class="cc-levels">' +
          '<div class="lvl s"><small>Support S1</small><b>' + num(lv.s1) + '</b></div>' +
          '<div class="lvl"><small>Pivot</small><b>' + num(lv.pivot) + '</b></div>' +
          '<div class="lvl t"><small>Resistance R1</small><b>' + num(lv.r1) + '</b></div>' +
          '<div class="lvl"><small>CPR</small><b>' + esc(lv.cprShape) + '</b></div>' +
        '</div>' : "") +
      ($("a-observation").value ?
        '<div class="cc-why"><b>Observation</b>' + esc($("a-observation").value) + '</div>' : "");
    return;
  }

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
      ($("l-summary").value ? '<div class="cc-why"><b>What you will learn</b>' + esc($("l-summary").value) + '</div>' : "");
    return;
  }

  p.innerHTML =
    '<div class="cc-top">' +
      '<span class="cc-inst">Market recap — ' + (esc($("r-date").value) || "date") + '</span>' +
      '<span class="cc-status closed">Recap</span>' +
    '</div>' +
    ($("r-summary").value ? '<div class="cc-why"><b>What happened</b>' + esc($("r-summary").value) + '</div>' : "") +
    ($("r-why").value ? '<div class="cc-why"><b>Why it happened</b>' + esc($("r-why").value) + '</div>' : "");
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
   ANALYSIS — auto-compute levels and publish (outside the RA gate)
--------------------------------------------------------- */
function computeAnalysisLevels() {
  var L = window.ARVLevels;
  var box = $("a-levels-out");
  if (!L) return null;

  var res = L.compute({
    high: $("a-high").value,
    low: $("a-low").value,
    close: $("a-close").value
  });

  if (!res.ok) { box.style.display = "none"; lastLevels = null; return null; }

  var c = res.sets.classic;
  var f = res.sets.fibonacci;

  lastLevels = {
    high: res.input.high, low: res.input.low, close: res.input.close,
    range: res.range, rangePct: res.rangePct,
    pivot: c.pivot,
    r1: c.r1, r2: c.r2, r3: c.r3, r4: c.r4,
    s1: c.s1, s2: c.s2, s3: c.s3, s4: c.s4,
    fibR1: f.r1, fibR2: f.r2, fibS1: f.s1, fibS2: f.s2,
    cprTop: res.cpr.tc, cprBottom: res.cpr.bc,
    cprWidthPct: res.cpr.widthPct, cprShape: res.cpr.shape,
    biasLabel: res.bias.label, biasTone: res.bias.tone,
    biasDistPct: res.bias.distPct,
    rangePosition: res.bias.posInRange
  };

  function cell(lbl, val, color) {
    return '<div style="padding:9px 12px;border-radius:11px;background:rgba(255,255,255,.03);' +
           'border:1px solid var(--stroke)"><small style="display:block;font-size:10px;' +
           'color:var(--muted-2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">' +
           lbl + '</small><b style="font-family:var(--font-alt);font-size:14.5px' +
           (color ? ";color:" + color : "") + '">' + num(val) + '</b></div>';
  }

  box.style.display = "block";
  box.innerHTML =
    '<div style="font-size:11.5px;color:var(--muted-2);text-transform:uppercase;' +
    'letter-spacing:.06em;margin-bottom:10px">Auto-computed levels</div>' +
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px">' +
      cell("R4", c.r4, "var(--down)") + cell("R3", c.r3, "var(--down)") +
      cell("R2", c.r2, "var(--down)") + cell("R1", c.r1, "var(--down)") +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px">' +
      cell("CPR top", res.cpr.tc, "var(--cyan)") +
      cell("Pivot", c.pivot) +
      cell("CPR bot", res.cpr.bc, "var(--cyan)") +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">' +
      cell("S1", c.s1, "var(--up)") + cell("S2", c.s2, "var(--up)") +
      cell("S3", c.s3, "var(--up)") + cell("S4", c.s4, "var(--up)") +
    '</div>' +
    '<p style="margin-top:11px;font-size:12.5px;color:var(--muted)">' +
      res.bias.label + " · " + (res.bias.distPct >= 0 ? "+" : "") + res.bias.distPct +
      "% from pivot · CPR " + res.cpr.shape + " (" + res.cpr.widthPct.toFixed(2) + "%)" +
    '</p>';

  return lastLevels;
}

["a-high", "a-low", "a-close"].forEach(function (id) {
  var el = $(id);
  if (el) el.addEventListener("input", function () { computeAnalysisLevels(); renderPreview(); });
});

$("form-analysis").addEventListener("submit", function (e) {
  e.preventDefault();
  clearMsg();

  var inst = $("a-instrument").value.trim();
  var obs = $("a-observation").value.trim();

  if (inst.length < 2) { msg("bad", "Enter an instrument name."); return; }
  if (obs.length < 20) { msg("bad", "Write an observation (minimum 20 characters)."); return; }

  var lv = computeAnalysisLevels();
  if (!lv) { msg("bad", "Enter a valid previous high, low and close."); return; }

  var lint = window.ARVLint.check([inst, obs].join("\n"));
  showLint(lint);
  if (!lint.ok) { msg("bad", "Compliance block — remove the blocked phrases."); return; }
  if (lint.hasPersonal) { msg("bad", "Remove the personalised-advice wording."); return; }

  var btn = $("btn-analysis");
  btn.disabled = true;
  msg("ok", "Publish ho raha hai…");

  /* ⚠️ NEVER add action/entry/targets/stopLoss to this payload.
     firestore.rules rejects them too. */
  addDoc(collection(db, "analysis"), {
    instrument: inst,
    segment: $("a-segment").value,
    timeframe: $("a-timeframe").value,
    levels: lv,
    observation: obs,
    free: $("a-free").value === "true",
    publishedAt: serverTimestamp(),
    createdBy: currentUid()
  })
    .then(function (ref) {
      msg("ok", "✅ Analysis publish ho gaya (" + ref.id + "). It appears on the feed immediately.");
      $("a-instrument").value = "";
      $("a-observation").value = "";
      $("a-high").value = ""; $("a-low").value = ""; $("a-close").value = "";
      $("a-levels-out").style.display = "none";
      lastLevels = null;
      renderPreview();
      btn.disabled = false;
    })
    .catch(function (err) {
      msg("bad", "❌ " + (err && err.message ? err.message : "Publish failed"));
      btn.disabled = false;
    });
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
  if (bad.length) { msg("bad", "Please correct these fields: " + bad.join(", ")); return; }

  var lint = window.ARVLint.check([c.title, c.rationale].join("\n"));
  showLint(lint);
  if (!lint.ok) { msg("bad", "Compliance block — remove the blocked phrases."); return; }

  var btn = $("btn-call");
  btn.disabled = true;
  msg("ok", "Publish ho raha hai…");

  publishCall(c)
    .then(function (ref) {
      msg("ok", "✅ Call publish ho gaya (" + ref.id + "). It is now visible to subscribers.");
      $("form-call").reset();
      fillSegments("c-segment");
      renderPreview();
      btn.disabled = false;
    })
    .catch(function (err) {
      msg("bad", "❌ " + (err && err.message ? err.message : "Publish failed"));
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
  if (title.length < 4) { msg("bad", "Enter a title."); return; }
  if (body.length < 40) { msg("bad", "The lesson body is too short (minimum 40 characters)."); return; }

  var lint = window.ARVLint.check([title, $("l-summary").value, body].join("\n"));
  showLint(lint);
  if (!lint.ok) { msg("bad", "Compliance block — remove the blocked phrases."); return; }

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
      msg("bad", "❌ " + (err && err.message ? err.message : "Publish failed"));
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
  if (!date) { msg("bad", "Please choose a date."); return; }
  if (summary.length < 20) { msg("bad", "Write a summary (minimum 20 characters)."); return; }

  var lint = window.ARVLint.check([summary, $("r-why").value].join("\n"));
  showLint(lint);
  if (!lint.ok) { msg("bad", "Compliance block — remove the blocked phrases."); return; }

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
      msg("bad", "❌ " + (err && err.message ? err.message : "Publish failed"));
      btn.disabled = false;
    });
});

/* =========================================================
   PRICING & PAYMENT SETTINGS
   Stored in Firestore so they survive deployments and need no code edit.
   ========================================================= */
var settings = {};

function paintPricingEditors() {
  var wrap = $("plan-editors");
  if (!wrap) return;

  wrap.innerHTML = CFG.PLAN_ORDER.map(function (id) {
    var p = CFG.plan(id);
    var over = (settings.plans && settings.plans[id]) || {};
    var price = typeof over.priceInr === "number" ? over.priceInr : p.priceInr;
    var days = typeof over.durationDays === "number" ? over.durationDays : p.durationDays;
    var on = over.enabled !== false;

    return '' +
      '<div style="padding:16px;border-radius:14px;background:rgba(255,255,255,.03);' +
      'border:1px solid var(--stroke);margin-bottom:12px">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
          '<b style="font-size:15px">' + esc(p.name) + '</b>' +
          '<span class="chip">' + p.segments.length + ' segments</span>' +
          '<label style="margin-left:auto;display:flex;align-items:center;gap:7px;' +
            'font-size:12.5px;color:var(--muted);cursor:pointer">' +
            '<input type="checkbox" class="pl-on" data-plan="' + id + '"' + (on ? " checked" : "") +
            ' style="width:auto;margin:0" /> Visible</label>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
          '<div><label style="display:block;font-size:11.5px;color:var(--muted-2);' +
            'text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Price (₹)</label>' +
            '<input type="number" class="pl-price" data-plan="' + id + '" value="' + price + '" min="0" step="1" /></div>' +
          '<div><label style="display:block;font-size:11.5px;color:var(--muted-2);' +
            'text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Duration (days)</label>' +
            '<input type="number" class="pl-days" data-plan="' + id + '" value="' + days + '" min="1" step="1" /></div>' +
        '</div>' +
      '</div>';
  }).join("");

  // payment fields
  var pay = settings.payment || {};
  $("s-upi").value = pay.upiId || "";
  $("s-payee").value = pay.payeeName || "";
  $("s-qr").value = pay.qrUrl || "";
  $("s-instructions").value = pay.instructions || "";
  $("s-support").value = pay.supportContact || "";

  paintQrPreview();
}

/* Generate a QR from the UPI ID when no image is supplied */
function upiQrUrl(upiId, payee, amount) {
  if (!upiId) return "";
  var uri = "upi://pay?pa=" + encodeURIComponent(upiId) +
            "&pn=" + encodeURIComponent(payee || "arvcoin") +
            "&cu=INR" + (amount ? "&am=" + amount : "");
  return "https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=" + encodeURIComponent(uri);
}

function paintQrPreview() {
  var box = $("qr-preview");
  if (!box) return;
  var url = $("s-qr").value.trim();
  var upi = $("s-upi").value.trim();
  var src = url || upiQrUrl(upi, $("s-payee").value.trim());

  if (!src) { box.style.display = "none"; return; }

  box.style.display = "block";
  box.innerHTML =
    '<div style="font-size:11.5px;color:var(--muted-2);text-transform:uppercase;' +
    'letter-spacing:.06em;margin-bottom:10px">QR preview' +
    (url ? " (your image)" : " (generated from UPI ID)") + '</div>' +
    '<div style="display:inline-block;padding:14px;border-radius:16px;background:#fff">' +
      '<img src="' + esc(src) + '" alt="Payment QR" width="200" height="200" ' +
      'style="display:block;width:200px;height:200px;object-fit:contain" />' +
    '</div>';
}

["s-upi", "s-payee", "s-qr"].forEach(function (id) {
  var el = $(id);
  if (el) el.addEventListener("input", paintQrPreview);
});

$("form-pricing").addEventListener("submit", function (e) {
  e.preventDefault();
  clearMsg();

  if (!isAdmin()) { msg("bad", "Admin access is required to change settings."); return; }

  var plans = {};
  var bad = false;

  document.querySelectorAll(".pl-price").forEach(function (inp) {
    var id = inp.getAttribute("data-plan");
    var v = parseInt(inp.value, 10);
    if (isNaN(v) || v < 0) { bad = true; return; }
    if (v > CFG.ANNUAL_FEE_CAP_INR) { bad = "cap"; return; }
    plans[id] = plans[id] || {};
    plans[id].priceInr = v;
  });

  document.querySelectorAll(".pl-days").forEach(function (inp) {
    var id = inp.getAttribute("data-plan");
    var v = parseInt(inp.value, 10);
    if (isNaN(v) || v < 1) { bad = true; return; }
    plans[id] = plans[id] || {};
    plans[id].durationDays = v;
  });

  document.querySelectorAll(".pl-on").forEach(function (cb) {
    var id = cb.getAttribute("data-plan");
    plans[id] = plans[id] || {};
    plans[id].enabled = cb.checked;
  });

  if (bad === "cap") {
    msg("bad", "A price exceeds the SEBI annual fee cap of " +
        CFG.inrFmt(CFG.ANNUAL_FEE_CAP_INR) + " per family.");
    return;
  }
  if (bad) { msg("bad", "Check the price and duration values."); return; }

  var btn = $("btn-pricing");
  btn.disabled = true;
  msg("ok", "Saving…");

  saveSettings({
    plans: plans,
    payment: {
      upiId: $("s-upi").value.trim(),
      payeeName: $("s-payee").value.trim(),
      qrUrl: $("s-qr").value.trim(),
      instructions: $("s-instructions").value.trim(),
      supportContact: $("s-support").value.trim()
    }
  })
    .then(function () {
      msg("ok", "✅ Saved. The live site is updated immediately.");
      settings.plans = plans;
      btn.disabled = false;
    })
    .catch(function (err) {
      msg("bad", "❌ " + (err && err.message ? err.message : "Save failed"));
      btn.disabled = false;
    });
});

/* =========================================================
   PAYMENT APPROVALS
   ========================================================= */
function loadApprovals() {
  var list = $("approval-list");
  if (!list) return;

  if (!isAdmin()) {
    list.innerHTML = '<div class="empty"><div class="e-ico">🔒</div>' +
      '<h3>Admin access required</h3><p>Only an admin can approve payments.</p></div>';
    return;
  }

  list.innerHTML = '<div class="skel"></div>';

  pendingPaymentProofs(50).then(function (rows) {
    var badge = $("appr-count");
    if (badge) badge.textContent = rows.length ? "(" + rows.length + ")" : "";

    if (!rows.length) {
      list.innerHTML = '<div class="empty"><div class="e-ico">✓</div>' +
        '<h3>Nothing pending</h3><p>Payment submissions awaiting verification will appear here.</p></div>';
      return;
    }

    list.innerHTML = rows.map(function (r) {
      return '' +
        '<div class="call-card" data-proof="' + esc(r.id) + '">' +
          '<div class="cc-top">' +
            '<span class="cc-inst">' + esc(r.name || r.email) + '</span>' +
            '<span class="cc-status active">' + esc(r.planName) + '</span>' +
            '<span class="cc-when">' + when(r.createdAt) + '</span>' +
          '</div>' +
          '<div class="lux-table" style="margin-bottom:14px">' +
            '<div class="tr"><span>Email</span><b>' + esc(r.email) + '</b></div>' +
            '<div class="tr"><span>Amount</span><b>' + CFG.inrFmt(r.amountInr) + '</b></div>' +
            '<div class="tr"><span>Reference / UTR</span><b>' + esc(r.reference) + '</b></div>' +
            (r.payerNote ? '<div class="tr"><span>Note</span><b>' + esc(r.payerNote) + '</b></div>' : "") +
          '</div>' +
          '<div class="cta-row">' +
            '<button type="button" class="btn btn-primary ap-yes" data-id="' + esc(r.id) + '">Approve &amp; activate</button>' +
            '<button type="button" class="btn-glass ap-no" data-id="' + esc(r.id) + '">Reject</button>' +
          '</div>' +
        '</div>';
    }).join("");

    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });

    list.querySelectorAll(".ap-yes").forEach(function (b) {
      b.addEventListener("click", function () {
        var r = byId[b.getAttribute("data-id")];
        b.disabled = true;
        b.textContent = "Activating…";
        approvePayment(r)
          .then(function () { msg("ok", "✅ Activated for " + (r.email || r.name)); loadApprovals(); })
          .catch(function (e) {
            msg("bad", "❌ " + e.message);
            b.disabled = false;
            b.textContent = "Approve & activate";
          });
      });
    });

    list.querySelectorAll(".ap-no").forEach(function (b) {
      b.addEventListener("click", function () {
        var reason = prompt("Reason for rejection (shown to the user):") || "";
        b.disabled = true;
        rejectPayment(b.getAttribute("data-id"), reason)
          .then(function () { msg("ok", "Rejected."); loadApprovals(); })
          .catch(function (e) { msg("bad", "❌ " + e.message); b.disabled = false; });
      });
    });
  });
}

/* ---------------------------------------------------------
   Boot
--------------------------------------------------------- */
fillSegments("a-segment");
fillSegments("c-segment");
fillSegments("l-segment");
["a-segment", "a-instrument", "a-observation", "a-timeframe", "a-free"].forEach(function (id) {
  var el = $(id);
  if (el) {
    el.addEventListener("input", renderPreview);
    el.addEventListener("change", renderPreview);
  }
});
$("r-date").value = new Date().toISOString().slice(0, 10);

if (!ready) {
  msg("bad", "Firebase config missing — add it to firebase-config.js.");
} else {
  requireAnalyst("dashboard.html").then(function (u) {
    if (!u) return;
    paintHeader();
    switchKind("analysis");   // works immediately, outside the RA gate
    if (!REGISTERED) {
      $("btn-call").disabled = true;
      $("btn-call").textContent = "Publishing disabled — set the RA number";
    }
  });
}
