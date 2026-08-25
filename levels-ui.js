/* =========================================================
   arvcoin — Levels calculator UI
   levels.js (math) ko page se jodta hai.
   ========================================================= */
(function () {
  "use strict";

  var CFG = window.ARV_CONFIG;
  var L = window.ARVLevels;
  if (!L) return;

  var $ = function (id) { return document.getElementById(id); };
  var result = null;
  var formula = "classic";

  function fmt(v) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function err(text) {
    var e = $("err");
    if (!text) { e.className = "adm-msg"; return; }
    e.className = "adm-msg show bad";
    e.textContent = text;
  }

  /* ---------------------------------------------------------
     Ladder — resistances upar se, supports neeche
  --------------------------------------------------------- */
  function paintLadder() {
    if (!result) return;
    var s = result.sets[formula];
    if (!s) {
      $("ladder").innerHTML =
        '<div class="lux-note" style="margin:0"><span class="n-ico">ℹ️</span>' +
        '<div>Woodie pivots also need the <b>open</b> value.</div></div>';
      return;
    }

    var ltp = result.input.ltp;
    var ref = ltp != null ? ltp : result.input.close;

    var rows = [];
    ["r4", "r3", "r2", "r1"].forEach(function (k) {
      if (s[k] != null) rows.push({ lbl: k.toUpperCase(), val: s[k], cls: "res" });
    });

    // CPR band pivot ke around
    rows.push({ lbl: "TC", val: result.cpr.tc, cls: "cprb" });
    rows.push({ lbl: "PP", val: s.pivot, cls: "piv" });
    rows.push({ lbl: "BC", val: result.cpr.bc, cls: "cprb" });

    ["s1", "s2", "s3", "s4"].forEach(function (k) {
      if (s[k] != null) rows.push({ lbl: k.toUpperCase(), val: s[k], cls: "sup" });
    });

    $("ladder").innerHTML = rows.map(function (r) {
      var gap = ref ? ((r.val - ref) / ref) * 100 : 0;
      var gapTxt = ref ? (gap >= 0 ? "+" : "") + gap.toFixed(2) + "%" : "";
      return '' +
        '<div class="rung ' + r.cls + '">' +
          '<span class="lbl">' + r.lbl + '</span>' +
          '<span class="gap">' + gapTxt + '</span>' +
          '<span class="val">' + fmt(r.val) + '</span>' +
        '</div>';
    }).join("");
  }

  /* ---------------------------------------------------------
     Paint everything
  --------------------------------------------------------- */
  function paint() {
    if (!result || !result.ok) return;

    $("empty").style.display = "none";
    $("out").style.display = "block";

    // bias
    var b = result.bias;
    $("bias-box").className = "bias-box " + b.tone;
    $("bb-lbl").textContent = b.label;
    $("bb-pct").textContent = (b.distPct >= 0 ? "+" : "") + b.distPct.toFixed(2) + "% from pivot";
    $("bb-note").textContent = b.note;
    $("bb-strength").textContent = b.strength + ".";

    // mini stats
    $("m-range").textContent = fmt(result.range);
    $("m-rangepct").textContent = result.rangePct.toFixed(2) + "%";
    $("m-cpr").textContent = fmt(result.cpr.width) + " (" + result.cpr.widthPct.toFixed(2) + "%)";
    $("cpr-mean").textContent = L.cprMeaning(result.cpr.shape);

    // extent
    var c = result.sets.classic;
    $("e-r1").textContent = fmt(c.r1);
    $("e-r4").textContent = fmt(c.r4 != null ? c.r4 : c.r3);
    $("e-s1").textContent = fmt(c.s1);
    $("e-s4").textContent = fmt(c.s4 != null ? c.s4 : c.s3);

    paintLadder();
  }

  /* ---------------------------------------------------------
     Calculate
  --------------------------------------------------------- */
  function calc() {
    err(null);
    var res = L.compute({
      high: $("i-high").value,
      low: $("i-low").value,
      close: $("i-close").value,
      open: $("i-open").value,
      ltp: $("i-ltp").value
    });

    if (!res.ok) {
      err(res.message);
      $("out").style.display = "none";
      $("empty").style.display = "block";
      result = null;
      return;
    }

    result = res;

    // Woodie tab disable if no open
    var wTab = document.querySelector('.f-tab[data-f="woodie"]');
    if (wTab) {
      var hasOpen = res.input.open != null;
      wTab.style.opacity = hasOpen ? "1" : ".45";
      if (!hasOpen && formula === "woodie") {
        formula = "classic";
        document.querySelectorAll(".f-tab").forEach(function (t) {
          t.classList.toggle("active", t.getAttribute("data-f") === "classic");
        });
      }
    }

    paint();

    // save last input
    try {
      localStorage.setItem("arvcoin_levels_last", JSON.stringify({
        symbol: $("i-symbol").value,
        high: $("i-high").value, low: $("i-low").value,
        close: $("i-close").value, open: $("i-open").value, ltp: $("i-ltp").value
      }));
    } catch (e) {}
  }

  /* ---------------------------------------------------------
     Events
  --------------------------------------------------------- */
  $("btn-calc").addEventListener("click", calc);

  $("btn-clear").addEventListener("click", function () {
    ["i-symbol", "i-high", "i-low", "i-close", "i-open", "i-ltp"].forEach(function (id) {
      $(id).value = "";
    });
    result = null;
    err(null);
    $("out").style.display = "none";
    $("empty").style.display = "block";
    try { localStorage.removeItem("arvcoin_levels_last"); } catch (e) {}
  });

  // Enter se calculate
  ["i-high", "i-low", "i-close", "i-open", "i-ltp"].forEach(function (id) {
    $(id).addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); calc(); }
    });
    // live recalc agar result already hai
    $(id).addEventListener("input", function () {
      if (result) calc();
    });
  });

  // formula tabs
  document.querySelectorAll(".f-tab").forEach(function (t) {
    t.addEventListener("click", function () {
      formula = t.getAttribute("data-f");
      document.querySelectorAll(".f-tab").forEach(function (x) {
        x.classList.toggle("active", x === t);
      });
      paintLadder();
    });
  });

  // quick symbol picks
  document.querySelectorAll(".qp").forEach(function (b) {
    b.addEventListener("click", function () {
      $("i-symbol").value = b.getAttribute("data-sym");
    });
  });

  /* ---------------------------------------------------------
     Disclosures + restore
  --------------------------------------------------------- */
  if (CFG) {
    var D = CFG.DISCLOSURES;
    $("disc").innerHTML = "<b>Important disclosures</b>" +
      [
        "This page is a calculation tool. No buy or sell recommendations are given here.",
        D.educationOnly,
        CFG.isRegistered() ? D.registeredNote : D.notRegistered,
        D.marketRisk,
        D.noGuarantee,
        D.forexWarning
      ].map(function (p) { return "<p>" + p + "</p>"; }).join("");
  }

  try {
    var last = JSON.parse(localStorage.getItem("arvcoin_levels_last") || "null");
    if (last) {
      $("i-symbol").value = last.symbol || "";
      $("i-high").value = last.high || "";
      $("i-low").value = last.low || "";
      $("i-close").value = last.close || "";
      $("i-open").value = last.open || "";
      $("i-ltp").value = last.ltp || "";
      if (last.high && last.low && last.close) calc();
    }
  } catch (e) {}
})();
