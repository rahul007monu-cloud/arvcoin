/* =========================================================
   arvcoin — auth pages logic (DEMO ONLY, no backend)
   Real launch: replace submit handlers with API calls
   (Razorpay/partner KYC + your auth backend on Render/Railway).
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

  function isEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }
  function isMobile(v) {
    return /^[6-9]\d{9}$/.test(v);
  }
  function setInvalid(id, bad) {
    var f = document.getElementById(id);
    if (f) f.classList.toggle("invalid", !!bad);
  }
  function showMsg(kind, text) {
    var m = document.getElementById("msg");
    if (!m) return;
    m.className = "a-msg " + kind;
    m.textContent = text;
  }

  /* ---- password strength meter ---- */
  var pass = document.getElementById("password");
  var meter = document.getElementById("strength");
  if (pass && meter) {
    pass.addEventListener("input", function () {
      var v = pass.value;
      var score = 0;
      if (v.length >= 6) score++;
      if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
      if (/\d/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      meter.className = "strength" + (v ? " s" + score : "");
    });
  }

  /* ---- LOGIN ---- */
  var loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = document.getElementById("email").value.trim();
      var pw = document.getElementById("password").value;
      var emailOk = isEmail(email) || isMobile(email);
      var pwOk = pw.length >= 6;
      setInvalid("f-email", !emailOk);
      setInvalid("f-pass", !pwOk);
      if (!emailOk || !pwOk) return;

      showMsg("ok", "\uD83D\uDD13 Login successful! Redirecting to your dashboard…");
      try {
        localStorage.setItem("arvcoin_session", JSON.stringify({ user: email, at: Date.now() }));
      } catch (err) {}
      setTimeout(function () { window.location.href = "dashboard.html"; }, 1400);
    });
  }

  /* ---- SIGNUP ---- */
  var signupForm = document.getElementById("signup-form");
  if (signupForm) {
    signupForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("name").value.trim();
      var email = document.getElementById("email").value.trim();
      var mobile = document.getElementById("mobile").value.trim();
      var pw = document.getElementById("password").value;
      var terms = document.getElementById("terms").checked;

      var nameOk = name.length >= 2;
      var emailOk = isEmail(email);
      var mobileOk = isMobile(mobile);
      var pwOk = pw.length >= 6;

      setInvalid("f-name", !nameOk);
      setInvalid("f-email", !emailOk);
      setInvalid("f-mobile", !mobileOk);
      setInvalid("f-pass", !pwOk);

      if (!nameOk || !emailOk || !mobileOk || !pwOk) return;
      if (!terms) {
        showMsg("bad", "Pehle Terms & Privacy accept karo.");
        return;
      }

      showMsg("ok", "\uD83C\uDF89 Account created! Ab number verify karte hain, " + name.split(" ")[0] + ".");
      try {
        localStorage.setItem("arvcoin_user", JSON.stringify({ name: name, email: email, mobile: mobile, at: Date.now() }));
        localStorage.setItem("arvcoin_session", JSON.stringify({ user: email, at: Date.now() }));
      } catch (err) {}
      setTimeout(function () { window.location.href = "verify.html"; }, 1500);
    });

    // live clear-invalid as user types
    ["name", "email", "mobile", "password"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("input", function () {
        el.closest(".field").classList.remove("invalid");
      });
    });
  }

  /* ---- mobile: digits only ---- */
  var mob = document.getElementById("mobile");
  if (mob) {
    mob.addEventListener("input", function () {
      mob.value = mob.value.replace(/\D/g, "").slice(0, 10);
    });
  }
})();
