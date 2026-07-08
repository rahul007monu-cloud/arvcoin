/* =========================================================
   arvcoin — REAL auth via Firebase (login / signup / Google / password reset)
   Static site pe reliably chalta hai (koi bundler/popup drama nahi).
   Config firebase-config.js se aata hai (window.ARV_FIREBASE_CONFIG).
   ========================================================= */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

var cfg = window.ARV_FIREBASE_CONFIG;
var ready = cfg && cfg.apiKey && cfg.apiKey.indexOf("PASTE") === -1;

var auth = null, db = null;
if (ready) {
  var app = initializeApp(cfg);
  auth = getAuth(app);
  db = getFirestore(app);
} else {
  console.warn("[arvcoin] Firebase config abhi nahi laga — firebase-config.js me daalo.");
}

/* ---------- helpers ---------- */
function $(id) { return document.getElementById(id); }
function msg(kind, text) { var m = $("msg"); if (m) { m.className = "a-msg " + kind; m.textContent = text; } }
function invalid(id, bad) { var f = $(id); if (f) f.classList.toggle("invalid", !!bad); }
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function isMobile(v) { return /^[6-9]\d{9}$/.test(v); }

function saveLocal(user) {
  try {
    localStorage.setItem("arvcoin_user", JSON.stringify(user));
    localStorage.setItem("arvcoin_session", JSON.stringify({ user: user.email, at: Date.now() }));
  } catch (e) {}
}

function saveProfile(uid, data) {
  if (!db || !uid) return Promise.resolve();
  return setDoc(doc(db, "users", uid), Object.assign({}, data, { updatedAt: serverTimestamp() }), { merge: true })
    .catch(function (e) { console.warn("[arvcoin] firestore save fail:", e); });
}

function friendlyError(e) {
  var c = (e && e.code) || "";
  if (c.indexOf("email-already-in-use") > -1) return "Ye email pehle se registered hai. Login karo.";
  if (c.indexOf("invalid-credential") > -1 || c.indexOf("wrong-password") > -1 || c.indexOf("user-not-found") > -1) return "Email ya password galat hai.";
  if (c.indexOf("weak-password") > -1) return "Password kam se kam 6 characters ka rakho.";
  if (c.indexOf("invalid-email") > -1) return "Valid email daalo.";
  if (c.indexOf("too-many-requests") > -1) return "Bahut baar try kiya. Thodi der baad koshish karo.";
  if (c.indexOf("popup-closed") > -1 || c.indexOf("cancelled-popup") > -1) return "Google login cancel ho gaya.";
  if (c.indexOf("popup-blocked") > -1) return "Popup block ho gaya — browser me allow karo.";
  if (c.indexOf("network") > -1) return "Internet check karo.";
  return "Kuch gadbad: " + (e && e.message ? e.message : c);
}

function guardReady() {
  if (!ready) { msg("bad", "Firebase config abhi set nahi hai. Kiro ko config bhejo."); return false; }
  return true;
}

/* ---------- SIGNUP ---------- */
var signupForm = $("signup-form");
if (signupForm) {
  signupForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!guardReady()) return;

    var name = $("name").value.trim();
    var email = $("email").value.trim();
    var mobile = $("mobile").value.trim();
    var pw = $("password").value;
    var terms = $("terms") ? $("terms").checked : true;

    var nameOk = name.length >= 2, emailOk = isEmail(email), mobileOk = isMobile(mobile), pwOk = pw.length >= 6;
    invalid("f-name", !nameOk); invalid("f-email", !emailOk); invalid("f-mobile", !mobileOk); invalid("f-pass", !pwOk);
    if (!nameOk || !emailOk || !mobileOk || !pwOk) return;
    if (!terms) { msg("bad", "Pehle Terms & Privacy accept karo."); return; }

    var btn = signupForm.querySelector("button[type=submit]");
    if (btn) btn.disabled = true;
    msg("ok", "Account ban raha hai\u2026");

    createUserWithEmailAndPassword(auth, email, pw)
      .then(function (cred) {
        var u = cred.user;
        return updateProfile(u, { displayName: name })
          .then(function () { return saveProfile(u.uid, { name: name, email: email, mobile: mobile, createdAt: serverTimestamp() }); })
          .then(function () {
            saveLocal({ name: name, email: email, mobile: mobile, at: Date.now() });
            msg("ok", "\uD83C\uDF89 Account ban gaya, " + name.split(" ")[0] + "! Dashboard khul raha hai\u2026");
            setTimeout(function () { window.location.href = "dashboard.html"; }, 1000);
          });
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        msg("bad", friendlyError(err));
      });
  });
}

/* ---------- LOGIN ---------- */
var loginForm = $("login-form");
if (loginForm) {
  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!guardReady()) return;

    var email = $("email").value.trim();
    var pw = $("password").value;
    var emailOk = isEmail(email), pwOk = pw.length >= 6;
    invalid("f-email", !emailOk); invalid("f-pass", !pwOk);
    if (!emailOk || !pwOk) {
      if (!emailOk) msg("bad", "Valid email daalo (mobile login abhi nahi).");
      return;
    }

    var btn = loginForm.querySelector("button[type=submit]");
    if (btn) btn.disabled = true;
    msg("ok", "Login ho raha hai\u2026");

    signInWithEmailAndPassword(auth, email, pw)
      .then(function (cred) {
        var u = cred.user;
        saveLocal({ name: u.displayName || "", email: u.email, mobile: "", at: Date.now() });
        msg("ok", "\uD83D\uDD13 Welcome back! Dashboard khul raha hai\u2026");
        setTimeout(function () { window.location.href = "dashboard.html"; }, 900);
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        msg("bad", friendlyError(err));
      });
  });
}

/* ---------- GOOGLE login (signup + login dono pages) ---------- */
function googleLogin(btn) {
  if (!guardReady()) return;
  var provider = new GoogleAuthProvider();
  if (btn) btn.disabled = true;
  msg("ok", "Google se connect kar rahe hain\u2026");
  signInWithPopup(auth, provider)
    .then(function (res) {
      var u = res.user;
      return saveProfile(u.uid, { name: u.displayName || "", email: u.email || "", provider: "google", createdAt: serverTimestamp() })
        .then(function () {
          saveLocal({ name: u.displayName || "Google User", email: u.email || "", mobile: "", at: Date.now() });
          window.location.href = "dashboard.html";
        });
    })
    .catch(function (err) {
      if (btn) btn.disabled = false;
      msg("bad", friendlyError(err));
    });
}

document.querySelectorAll(".social-btn[data-provider]").forEach(function (btn) {
  btn.addEventListener("click", function () {
    var p = btn.getAttribute("data-provider");
    if (p === "google") { googleLogin(btn); }
    else { msg("", "Apple login jaldi aa raha hai. Abhi Google ya email use karo."); }
  });
});

/* ---------- FORGOT PASSWORD ---------- */
var forgot = $("forgot-pass");
if (forgot) {
  forgot.addEventListener("click", function (e) {
    e.preventDefault();
    if (!guardReady()) return;
    var email = ($("email") && $("email").value.trim()) || "";
    if (!isEmail(email)) { email = prompt("Apna registered email daalo — reset link bhej denge:") || ""; email = email.trim(); }
    if (!isEmail(email)) { msg("bad", "Valid email daalo password reset ke liye."); return; }
    sendPasswordResetEmail(auth, email)
      .then(function () { msg("ok", "\uD83D\uDCE7 Reset link " + email + " pe bhej diya. Inbox/spam check karo."); })
      .catch(function (err) { msg("bad", friendlyError(err)); });
  });
}
