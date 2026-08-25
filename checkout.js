/* =========================================================
   arvcoin — checkout (manual UPI / QR flow)

   The user pays via the QR code or UPI ID configured in the admin
   panel, then submits the transaction reference. An admin verifies
   it and activates the subscription.

   Nothing here can grant access — status is admin-only in
   firestore.rules. This page only records a claim.
   ========================================================= */
import {
  ready, requireAuth, getSettings, effectivePlan,
  submitPaymentProof, myPaymentProofs, when
} from "./arv-core.js";

var CFG = window.ARV_CONFIG;
var $ = function (id) { return document.getElementById(id); };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function msg(kind, text) {
  var m = $("msg");
  if (!text) { m.className = "adm-msg"; return; }
  m.className = "adm-msg show " + kind;
  m.textContent = text;
  m.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------------------------------------------------------
   Which plan?  ?plan=pro
--------------------------------------------------------- */
function planIdFromUrl() {
  var m = location.search.match(/[?&]plan=([a-z0-9_-]+)/i);
  return m ? m[1] : "pro";
}

var planId = planIdFromUrl();
var plan = null;
var total = 0;

/* ---------------------------------------------------------
   UPI QR — generated from the UPI ID unless an image is set
--------------------------------------------------------- */
function upiUri(upiId, payee, amount) {
  return "upi://pay?pa=" + encodeURIComponent(upiId) +
         "&pn=" + encodeURIComponent(payee || "arvcoin") +
         "&cu=INR" + (amount ? "&am=" + amount : "");
}

function qrImageUrl(uri) {
  return "https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=0&data=" +
         encodeURIComponent(uri);
}

/* ---------------------------------------------------------
   Paint
--------------------------------------------------------- */
function paintOrder() {
  var gst = Math.round(plan.priceInr * CFG.PAYMENTS.gstPct / 100);
  total = plan.priceInr + gst;

  $("o-plan").textContent = plan.name;
  $("o-days").textContent = plan.durationDays + " days";
  $("o-segs").textContent = plan.segments.map(function (s) {
    return CFG.SEGMENTS[s] ? CFG.SEGMENTS[s].name : s;
  }).join(", ");
  $("o-base").textContent = CFG.inrFmt(plan.priceInr);
  $("o-gst").textContent = CFG.inrFmt(gst);
  $("o-total").textContent = CFG.inrFmt(total);
}

function paintPayment(settings) {
  var pay = (settings && settings.payment) || {};
  var holder = $("qr-holder");

  var src = "";
  if (pay.qrUrl) {
    src = pay.qrUrl;
  } else if (pay.upiId) {
    src = qrImageUrl(upiUri(pay.upiId, pay.payeeName, total));
  }

  if (src) {
    holder.innerHTML = '<div class="qr-frame"><img src="' + esc(src) +
      '" alt="Payment QR code" /></div>';
    // Deep link for mobile — opens the UPI app directly
    if (pay.upiId) {
      holder.innerHTML += '<a href="' + esc(upiUri(pay.upiId, pay.payeeName, total)) +
        '" class="btn-glass" style="margin-top:16px;display:inline-flex">Open UPI app →</a>';
    }
  } else {
    holder.innerHTML =
      '<div class="lux-note" style="text-align:left"><span class="n-ico">⚙️</span>' +
      '<div><b>Payment details not configured yet.</b> The site owner needs to add a ' +
      'UPI ID or QR code in the admin panel under Pricing &amp; payment.</div></div>';
    $("btn-submit").disabled = true;
  }

  if (pay.upiId) {
    $("upi-row").style.display = "flex";
    $("upi-id").textContent = pay.upiId;
    $("copy-upi").addEventListener("click", function () {
      navigator.clipboard.writeText(pay.upiId).then(function () {
        $("copy-upi").textContent = "Copied";
        setTimeout(function () { $("copy-upi").textContent = "Copy"; }, 1600);
      }).catch(function () {});
    });
  }

  if (pay.payeeName) {
    $("payee-line").textContent = "Payee: " + pay.payeeName;
  }

  if (pay.instructions) {
    var box = $("instructions-box");
    box.style.display = "block";
    box.className = "lux-note info";
    box.innerHTML = '<span class="n-ico">ℹ️</span><div>' + esc(pay.instructions) + '</div>';
  }

  var support = pay.supportContact || (CFG.BRAND && CFG.BRAND.supportEmail);
  if (support) {
    $("support-line").textContent = "Any issue with payment? Contact " + support;
  }
}

function paintMyProofs(rows) {
  var box = $("my-proofs");
  if (!rows.length) { box.innerHTML = ""; return; }

  box.innerHTML = '<h2 style="font-size:17px;font-weight:700;margin-bottom:14px">' +
    'Your submissions</h2>' +
    rows.map(function (r) {
      var cls = r.status === "approved" ? "target_hit"
              : (r.status === "rejected" ? "sl_hit" : "active");
      var label = r.status === "approved" ? "Approved"
                : (r.status === "rejected" ? "Rejected" : "Pending verification");
      return '<div class="call-card">' +
        '<div class="cc-top">' +
          '<span class="cc-inst">' + esc(r.planName) + '</span>' +
          '<span class="cc-status ' + cls + '">' + label + '</span>' +
          '<span class="cc-when">' + when(r.createdAt) + '</span>' +
        '</div>' +
        '<div class="cc-meta">' +
          '<span class="chip">' + CFG.inrFmt(r.amountInr) + '</span>' +
          '<span class="chip">Ref: ' + esc(r.reference) + '</span>' +
        '</div>' +
        (r.rejectReason ? '<div class="cc-why"><b>Reason</b>' + esc(r.rejectReason) + '</div>' : "") +
        '</div>';
    }).join("");
}

/* ---------------------------------------------------------
   Submit
--------------------------------------------------------- */
$("proof-form").addEventListener("submit", function (e) {
  e.preventDefault();
  msg(null);

  var ref = $("p-ref").value.trim();
  if (ref.length < 4) { msg("bad", "Enter the transaction reference from your UPI app."); return; }

  var btn = $("btn-submit");
  btn.disabled = true;
  msg("ok", "Submitting…");

  submitPaymentProof({
    planId: planId,
    amountInr: total,
    reference: ref,
    note: $("p-note").value.trim()
  })
    .then(function () {
      msg("ok", "✅ Received. We will verify your payment and activate access shortly. " +
                "You will see the status update on this page and your dashboard.");
      $("p-ref").value = "";
      $("p-note").value = "";
      btn.disabled = false;
      return myPaymentProofs(10).then(paintMyProofs);
    })
    .catch(function (err) {
      msg("bad", "❌ " + (err && err.message ? err.message : "Submission failed"));
      btn.disabled = false;
    });
});

/* ---------------------------------------------------------
   Disclosures
--------------------------------------------------------- */
(function () {
  var D = CFG.DISCLOSURES;
  $("disc").innerHTML = "<b>Important disclosures</b>" + [
    CFG.isRegistered() ? D.registeredNote : D.notRegistered,
    D.educationOnly, D.marketRisk, D.noGuarantee, D.noPersonalAdvice
  ].map(function (p) { return "<p>" + esc(p) + "</p>"; }).join("");
})();

/* ---------------------------------------------------------
   Boot
--------------------------------------------------------- */
if (!ready) {
  msg("bad", "Firebase config is missing — add it to firebase-config.js.");
} else {
  requireAuth("login.html").then(function (u) {
    if (!u) return;

    getSettings().then(function (settings) {
      plan = effectivePlan(planId, settings);
      if (!plan) {
        msg("bad", "Plan not found. Please pick one from the plans page.");
        return;
      }
      paintOrder();
      paintPayment(settings);
      return myPaymentProofs(10).then(paintMyProofs);
    });
  });
}
