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
  getFirestore, doc, setDoc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

var cfg = window.ARV_FIREBASE_CONFIG;
var ready = cfg && cfg.apiKey && cfg.apiKey.indexOf("PASTE") === -1;

var auth = null, db = null;
if (ready) {
  var app = initializeApp(cfg);
  auth = getAuth(app);
  db = getFirestore(app);
} else {
  console.warn("[arvcoin] Firebase config missing — add it to firebase-config.js.");
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

/* Email ek hi baar verify hoti hai. Uske baad OTP dobara NAHI maangte. */
function isVerified(uid) {
  if (!db || !uid) return Promise.resolve(true);
  return getDoc(doc(db, "users", uid))
    .then(function (s) { return !!(s.exists() && s.data().emailVerified); })
    .catch(function () { return true; }); // read fail ho to user ko rok nahi rahe
}

function friendlyError(e) {
  var c = (e && e.code) || "";
  if (c.indexOf("email-already-in-use") > -1) return "This email is already registered. Please sign in.";
  if (c.indexOf("invalid-credential") > -1 || c.indexOf("wrong-password") > -1 || c.indexOf("user-not-found") > -1) return "Incorrect email or password.";
  if (c.indexOf("weak-password") > -1) return "Use a password of at least 6 characters.";
  if (c.indexOf("invalid-email") > -1) return "Enter a valid email address.";
  if (c.indexOf("too-many-requests") > -1) return "Too many attempts. Please try again shortly.";
  if (c.indexOf("popup-closed") > -1 || c.indexOf("cancelled-popup") > -1) return "Google sign-in was cancelled.";
  if (c.indexOf("popup-blocked") > -1) return "The popup was blocked — please allow popups.";
  if (c.indexOf("network") > -1) return "Please check your internet connection.";
  return "Something went wrong: " + (e && e.message ? e.message : c);
}

function guardReady() {
  if (!ready) { msg("bad", "Firebase config is not set yet."); return false; }
  return true;
}

/* =========================================================
   EMAIL OTP (free, via EmailJS) — real 6-digit code to inbox
   ========================================================= */
var ejs = window.ARV_EMAILJS || {};
var ejsReady = !!(ejs.publicKey && ejs.serviceId && ejs.templateId &&
  ejs.publicKey.indexOf("PASTE") === -1 &&
  ejs.serviceId.indexOf("PASTE") === -1 &&
  ejs.templateId.indexOf("PASTE") === -1);

if (ejsReady && window.emailjs && emailjs.init) {
  try { emailjs.init({ publicKey: ejs.publicKey }); } catch (e) { console.warn("[arvcoin] emailjs init:", e); }
}

function genOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }

// Real email bhejta hai; agar EmailJS set nahi to DEMO mode (code alert me).
function sendOtpEmail(toEmail, toName, code) {
  if (!ejsReady || !window.emailjs) {
    // DEMO fallback — taaki keys aane se pehle bhi flow test ho sake
    console.log("[arvcoin][DEMO OTP] " + code + " -> " + toEmail);
    alert("DEMO mode: EmailJS keys are not configured yet.\nYour OTP is: " + code + "\n(Real emails will send once the keys are added.)");
    return Promise.resolve({ demo: true });
  }
  // "valid till {{time}}" ke liye readable expiry time (IST)
  var expTime = new Date(Date.now() + 15 * 60 * 1000)
    .toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
  return emailjs.send(ejs.serviceId, ejs.templateId, {
    email: toEmail,      // template ke "To Email" field me {{email}} daalna
    to_email: toEmail,   // (backup naam)
    name: toName || "there",
    to_name: toName || "there",
    passcode: code,      // template body me {{passcode}}
    otp: code,           // (backup naam)
    time: expTime        // template body me {{time}}
  });
}

/* ---------- pending signup state ----------
   ⚠️ SECURITY: yahan password KABHI store nahi hota.
   Pehle Firebase account banta hai (password seedha Firebase ko jaata hai,
   hash hokar), phir OTP se email verify hoti hai. Pehle plaintext password
   sessionStorage me rakha jaa raha tha — wo fix ho gaya. */
var PENDING_KEY = "arvcoin_pending";
function setPending(data) {
  try {
    var safe = {
      name: data.name, email: data.email, mobile: data.mobile,
      code: data.code, exp: data.exp, sentAt: data.sentAt, uid: data.uid
    };
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(safe));
  } catch (e) {}
}
function getPending() { try { return JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null"); } catch (e) { return null; } }
function clearPending() { try { sessionStorage.removeItem(PENDING_KEY); } catch (e) {} }

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
    if (!terms) { msg("bad", "Please accept the Terms and Privacy Policy first."); return; }

    var btn = signupForm.querySelector("button[type=submit]");
    if (btn) btn.disabled = true;
    msg("ok", "Creating your account\u2026");

    /* Account ABHI banta hai — password seedha Firebase ko jaata hai aur
       kahin store nahi hota. Uske baad email OTP verify hoti hai. */
    var code = genOtp();

    createUserWithEmailAndPassword(auth, email, pw)
      .then(function (cred) {
        var u = cred.user;
        return updateProfile(u, { displayName: name })
          .then(function () {
            return saveProfile(u.uid, {
              name: name, email: email, mobile: mobile,
              emailVerified: false, createdAt: serverTimestamp()
            });
          })
          .then(function () {
            setPending({
              name: name, email: email, mobile: mobile, uid: u.uid,
              code: code, exp: Date.now() + 15 * 60 * 1000, // 15 min
              sentAt: Date.now()
            });
            msg("ok", "Sending a verification code to your email\u2026");
            return sendOtpEmail(email, name, code);
          })
          .then(function () {
            msg("ok", "\uD83D\uDCE7 Code sent to " + email + " — please verify\u2026");
            setTimeout(function () { window.location.href = "verify.html"; }, 800);
          });
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        console.warn("[arvcoin] signup fail:", err);
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
      if (!emailOk) msg("bad", "Enter a valid email address (mobile sign-in is not available yet).");
      return;
    }

    var btn = loginForm.querySelector("button[type=submit]");
    if (btn) btn.disabled = true;
    msg("ok", "Signing in\u2026");

    signInWithEmailAndPassword(auth, email, pw)
      .then(function (cred) {
        var u = cred.user;
        saveLocal({ name: u.displayName || "", email: u.email, mobile: "", at: Date.now() });

        /* Email pehle se verified hai -> seedha dashboard, koi OTP nahi.
           Sirf pehli baar (unverified account) OTP maangte hain. */
        return isVerified(u.uid).then(function (ok) {
          if (ok) {
            msg("ok", "\uD83D\uDD13 Welcome back — opening your dashboard\u2026");
            setTimeout(function () { window.location.href = "dashboard.html"; }, 800);
            return;
          }

          var code = genOtp();
          setPending({
            name: u.displayName || "", email: u.email, mobile: "", uid: u.uid,
            code: code, exp: Date.now() + 15 * 60 * 1000, sentAt: Date.now()
          });
          msg("ok", "We need to verify your email once — sending a code\u2026");
          return sendOtpEmail(u.email, u.displayName || "there", code).then(function () {
            setTimeout(function () { window.location.href = "verify.html"; }, 800);
          });
        });
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
  msg("ok", "Connecting to Google\u2026");
  signInWithPopup(auth, provider)
    .then(function (res) {
      var u = res.user;
      /* Google already email verify kar chuka hai -> OTP kabhi nahi maangte. */
      return saveProfile(u.uid, {
        name: u.displayName || "", email: u.email || "", provider: "google",
        emailVerified: true, createdAt: serverTimestamp()
      })
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
    else { msg("", "Apple sign-in is coming soon. Please use Google or email for now."); }
  });
});

/* ---------- VERIFY (email OTP) -> account create ---------- */
// verify.html iske globals use karta hai (box UX wahin rehta hai).
window.arvOtp = {
  dest: function () { var p = getPending(); return p && p.email ? p.email : ""; },

  verify: function (codeStr, onOk, onErr) {
    var p = getPending();
    if (!p) { onErr && onErr("Your session expired. Please sign up again."); return; }
    if (Date.now() > p.exp) { onErr && onErr("The code expired. Please request a new one."); return; }
    if (String(codeStr) !== String(p.code)) { onErr && onErr("Incorrect code. Please check and try again."); return; }
    if (!guardReady()) { onErr && onErr("Firebase config is not set."); return; }

    /* Account signup pe hi ban gaya tha. Yahan sirf email verified mark
       karte hain — koi password handling nahi. */
    var uid = p.uid || (auth.currentUser && auth.currentUser.uid);
    if (!uid) { onErr && onErr("Session not found. Please sign in again."); return; }

    saveProfile(uid, { emailVerified: true, verifiedAt: serverTimestamp() })
      .then(function () {
        saveLocal({ name: p.name, email: p.email, mobile: p.mobile, at: Date.now() });
        clearPending();
        onOk && onOk(p.name);
      })
      .catch(function (err) { onErr && onErr(friendlyError(err)); });
  },

  resend: function (onOk, onErr) {
    var p = getPending();
    if (!p) { onErr && onErr("Your session expired. Please sign up again."); return; }
    var code = genOtp();
    p.code = code; p.exp = Date.now() + 15 * 60 * 1000; p.sentAt = Date.now();
    setPending(p);
    sendOtpEmail(p.email, p.name, code)
      .then(function () { onOk && onOk(); })
      .catch(function (e) { onErr && onErr("Resend failed. Please try again."); });
  }
};

/* ---------- FORGOT PASSWORD ---------- */
var forgot = $("forgot-pass");
if (forgot) {
  forgot.addEventListener("click", function (e) {
    e.preventDefault();
    if (!guardReady()) return;
    var email = ($("email") && $("email").value.trim()) || "";
    if (!isEmail(email)) { email = prompt("Enter your registered email and we will send a reset link:") || ""; email = email.trim(); }
    if (!isEmail(email)) { msg("bad", "Enter a valid email address to reset your password."); return; }
    sendPasswordResetEmail(auth, email)
      .then(function () { msg("ok", "\uD83D\uDCE7 Reset link " + email + " — check your inbox and spam folder."); })
      .catch(function (err) { msg("bad", friendlyError(err)); });
  });
}
