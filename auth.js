/* =========================================================
   arvcoin — auth pages UI helpers (password toggle, strength,
   mobile digits, live-validation-clear).

   Actual login/signup/Google/password-reset ab firebase-auth.js
   is handled by Firebase — reliable, with no popup or bundler issues.
   ========================================================= */
(function () {
  "use strict";

  /* ---- show / hide password ---- */
  document.querySelectorAll(".toggle-eye").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var input = document.getElementById(btn.getAttribute("data-target"));
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.style.color = input.type === "text" ? "#00e0ff" : "";
    });
  });

  /* ---- password strength meter ---- */
  var pass = document.getElementById("password");
  var meter = document.getElementById("strength");
  if (pass && meter) {
    pass.addEventListener("input", function () {
      var v = pass.value, score = 0;
      if (v.length >= 6) score++;
      if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
      if (/\d/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      meter.className = "strength" + (v ? " s" + score : "");
    });
  }

  /* ---- live clear-invalid as user types ---- */
  ["name", "email", "mobile", "password"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("input", function () {
      var f = el.closest(".field");
      if (f) f.classList.remove("invalid");
    });
  });

  /* ---- mobile: digits only ---- */
  var mob = document.getElementById("mobile");
  if (mob) {
    mob.addEventListener("input", function () {
      mob.value = mob.value.replace(/\D/g, "").slice(0, 10);
    });
  }
})();
