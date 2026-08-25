/* =========================================================
   arvcoin — pricing page
   Plans, coverage table and segment detail — all from arv-config.js.
   ========================================================= */
(function () {
  "use strict";
  var CFG = window.ARV_CONFIG;
  if (!CFG) return;

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------- registration note ---------- */
  var rn = $("reg-note");
  if (rn) {
    if (CFG.isRegistered()) {
      var ra = CFG.RA_REGISTRATION;
      rn.className = "lux-note good rv";
      rn.innerHTML = '<span class="n-ico">✅</span><div><b>SEBI Registered Research Analyst.</b> ' +
        'Reg. no. ' + esc(ra.number) + (ra.entityName ? " · " + esc(ra.entityName) : "") +
        '. Research services are provided under this registration.</div>';
    } else {
      rn.className = "lux-note rv";
      rn.innerHTML = '<span class="n-ico">🎓</span><div><b>Currently in education mode.</b> ' +
        esc(CFG.DISCLOSURES.notRegistered) +
        ' Plans are ready for paid research and activate once registration is complete.</div>';
    }
  }

  /* ---------- plans ---------- */
  var grid = $("plan-grid");
  if (grid) {
    grid.innerHTML = CFG.PLAN_ORDER.map(function (id, i) {
      var p = CFG.plan(id);
      if (!p) return "";
      var t = CFG.planTotal(id);
      var segIcons = p.segments.map(function (sid) {
        var s = CFG.SEGMENTS[sid];
        return s ? '<span title="' + esc(s.name) + '" style="color:' + s.color + '">' + s.icon + '</span>' : "";
      }).join(" ");

      var feats = p.features.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("");
      var miss = (p.missing || []).map(function (f) { return '<li class="no">' + esc(f) + "</li>"; }).join("");

      return '' +
        '<div class="lux plan lux-3d rv' + (i ? " d" + Math.min(i, 5) : "") + (p.popular ? " pop" : "") + '">' +
          (p.popular ? '<span class="tag">Most popular</span>' :
            (p.saveLabel ? '<span class="tag">' + esc(p.saveLabel) + '</span>' : "")) +
          '<h3>' + esc(p.name) + '</h3>' +
          '<p class="sub">' + esc(p.tagline || "") + '</p>' +
          '<div class="amt">' + CFG.inrFmt(p.priceInr) + '</div>' +
          '<p class="amt-sub">/ ' + p.durationDays + ' din &nbsp;·&nbsp; ' + segIcons +
            '<br /><small style="color:var(--muted-2)">+ GST = ' + CFG.inrFmt(t.total) + ' total</small></p>' +
          '<ul>' + feats + miss + '</ul>' +
          '<a href="signup.html?plan=' + p.id + '" class="' + (p.popular ? "btn-lux" : "btn-glass") + '">' +
            (p.popular ? "Get " + esc(p.name) : "Choose " + esc(p.name)) + '</a>' +
        '</div>';
    }).join("");
  }

  /* ---------- gst note ---------- */
  var gn = $("gst-note");
  if (gn) {
    gn.textContent = "GST of " + CFG.PAYMENTS.gstPct +
      "% GST applies on top. No auto-renewal — access stops when the term ends. " +
      "SEBI RA fee limit: " + CFG.inrFmt(CFG.ANNUAL_FEE_CAP_INR) + " per year per family.";
  }

  /* ---------- coverage table ---------- */
  var ct = $("cov-table");
  if (ct) {
    var plans = CFG.PLAN_ORDER.map(function (id) { return CFG.plan(id); }).filter(Boolean);

    var head = "<thead><tr><th>Segment</th>" + plans.map(function (p) {
      return '<th class="' + (p.popular ? "hi" : "") + '">' + esc(p.name) + "</th>";
    }).join("") + "</tr></thead>";

    var rows = CFG.SEGMENT_ORDER.map(function (sid) {
      var s = CFG.SEGMENTS[sid];
      return "<tr><td>" + s.icon + " " + esc(s.name) + "</td>" +
        plans.map(function (p) {
          var yes = p.segments.indexOf(sid) > -1;
          return '<td class="' + (yes ? "yes" : "no") + '">' + (yes ? "✓" : "—") + "</td>";
        }).join("") + "</tr>";
    }).join("");

    // extra rows
    var extras = [
      ["Daily market recap", function () { return true; }],
      ["Levels calculator", function () { return true; }],
      ["Rationale on every note", function () { return true; }],
      ["Full call history", function () { return true; }],
      ["Analyst Q&A", function (p) { return p.id === "elite" || p.id === "quarterly"; }],
      ["Early call access", function (p) { return p.id === "elite" || p.id === "quarterly"; }]
    ].map(function (row) {
      return "<tr><td>" + esc(row[0]) + "</td>" + plans.map(function (p) {
        var yes = row[1](p);
        return '<td class="' + (yes ? "yes" : "no") + '">' + (yes ? "✓" : "—") + "</td>";
      }).join("") + "</tr>";
    }).join("");

    var dur = "<tr><td>Duration</td>" + plans.map(function (p) {
      return "<td>" + p.durationDays + " din</td>";
    }).join("") + "</tr>";

    var price = "<tr><td><b>Price</b></td>" + plans.map(function (p) {
      return "<td><b>" + CFG.inrFmt(p.priceInr) + "</b></td>";
    }).join("") + "</tr>";

    ct.innerHTML = head + "<tbody>" + rows + extras + dur + price + "</tbody>";
  }

  /* ---------- segment detail ---------- */
  var sd = $("seg-detail");
  if (sd) {
    sd.innerHTML = CFG.SEGMENT_ORDER.map(function (sid, i) {
      var s = CFG.SEGMENTS[sid];
      var chips = (s.instruments || []).map(function (x) { return "<span>" + esc(x) + "</span>"; }).join("");
      return '' +
        '<div class="lux lux-card lux-3d rv' + (i ? " d" + Math.min(i, 5) : "") + '">' +
          '<div class="ico" style="color:' + s.color + '">' + s.icon + '</div>' +
          '<h3>' + esc(s.name) + '</h3>' +
          '<p>' + esc(s.blurb) + '</p>' +
          '<div class="inst-chips">' + chips + '</div>' +
          (s.note ? '<p style="margin-top:14px;font-size:12.5px;color:var(--muted-2);line-height:1.6">⚠️ ' + esc(s.note) + '</p>' : "") +
        '</div>';
    }).join("");
  }

  /* ---------- disclosures ---------- */
  var d = $("disc");
  if (d) {
    var D = CFG.DISCLOSURES;
    d.innerHTML = "<b>Important disclosures</b>" + [
      CFG.isRegistered() ? D.registeredNote : D.notRegistered,
      D.educationOnly,
      D.paymentNote,
      D.marketRisk,
      D.noGuarantee,
      D.noPersonalAdvice,
      D.forexWarning,
      D.cryptoTax
    ].map(function (p) { return "<p>" + esc(p) + "</p>"; }).join("");
  }
})();
