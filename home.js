/* =========================================================
   arvcoin — homepage dynamic bits
   Segments grid, plans grid, disclosures — sab arv-config.js se.
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

  /* ---------- year ---------- */
  var yr = $("yr");
  if (yr) yr.textContent = new Date().getFullYear();

  /* ---------- segments ---------- */
  var segGrid = $("seg-grid");
  if (segGrid) {
    segGrid.innerHTML = CFG.SEGMENT_ORDER.map(function (id, i) {
      var s = CFG.SEGMENTS[id];
      var count = (s.instruments || []).length;
      return '' +
        '<div class="lux seg-card lux-tilt rv' + (i ? " d" + Math.min(i, 5) : "") + '">' +
          '<span class="sc-ico" style="color:' + s.color + '">' + s.icon + '</span>' +
          '<h3>' + esc(s.name) + '</h3>' +
          '<p>' + esc(s.blurb) + '</p>' +
          '<span class="sc-tag">' + count + ' instruments</span>' +
        '</div>';
    }).join("");
  }

  /* ---------- plans ---------- */
  var planGrid = $("plan-grid");
  if (planGrid) {
    planGrid.innerHTML = CFG.PLAN_ORDER.map(function (id, i) {
      var p = CFG.plan(id);
      if (!p) return "";
      var segs = p.segments.map(function (sid) {
        var s = CFG.SEGMENTS[sid];
        return s ? s.icon : "";
      }).join(" ");

      return '' +
        '<div class="lux plan lux-tilt rv' + (i ? " d" + Math.min(i, 5) : "") + (p.popular ? " pop" : "") + '">' +
          (p.popular ? '<span class="tag">Most popular</span>' : "") +
          (p.saveLabel && !p.popular ? '<span class="tag">' + esc(p.saveLabel) + '</span>' : "") +
          '<h3>' + esc(p.name) + '</h3>' +
          '<p class="sub">' + esc(p.tagline || "") + '</p>' +
          '<div class="amt">' + CFG.inrFmt(p.priceInr) + '</div>' +
          '<p class="amt-sub">/ ' + p.durationDays + ' din &nbsp;·&nbsp; ' + segs + '</p>' +
          '<ul>' + p.features.slice(0, 4).map(function (f) {
            return "<li>" + esc(f) + "</li>";
          }).join("") + '</ul>' +
          '<a href="pricing.html" class="' + (p.popular ? "btn-lux" : "btn-glass") + '">Details</a>' +
        '</div>';
    }).join("");
  }

  /* ---------- FAQ: registration status ---------- */
  var faqReg = $("faq-reg");
  if (faqReg) {
    faqReg.textContent = CFG.isRegistered()
      ? CFG.DISCLOSURES.registeredNote + " Reg. no. " + CFG.RA_REGISTRATION.number + "."
      : CFG.DISCLOSURES.notRegistered;
  }

  /* ---------- footer disclosure ---------- */
  var fd = $("foot-disclosure");
  if (fd) {
    var D = CFG.DISCLOSURES;
    var parts = [
      CFG.isRegistered() ? D.registeredNote : D.notRegistered,
      D.educationOnly,
      D.marketRisk,
      D.noGuarantee,
      D.noPersonalAdvice,
      D.forexWarning,
      D.cryptoTax
    ];
    fd.innerHTML = "<b>Important disclosures</b>" +
      parts.map(function (p) { return "<p>" + esc(p) + "</p>"; }).join("");
  }
})();
