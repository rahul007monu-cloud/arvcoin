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

/* Email ek hi baar verify hoti hai. Uske baad OTP dobara NAHI maangte. */
function isVerified(uid) {
  if (!db || !uid) return Promise.resolve(true);
  return getDoc(doc(db, "users", uid))
    .then(function (s) { return !!(s.exists() && s.data().emailVerified); })
    .catch(function () { return true; }); // read fail ho to user ko rok nahi rahe
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
    alert("DEMO mode: EmailJS keys abhi nahi lage.\nTumhara OTP hai: " + code + "\n(Asli email tab jayega jab keys daalenge.)");
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
    if (!terms) { msg("bad", "Pehle Terms & Privacy accept karo."); return; }

    var btn = signupForm.querySelector("button[type=submit]");
    if (btn) btn.disabled = true;
    msg("ok", "Account bana rahe hain\u2026");

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
            msg("ok", "Email pe verification code bhej rahe hain\u2026");
            return sendOtpEmail(email, name, code);
          })
          .then(function () {
            msg("ok", "\uD83D\uDCE7 Code bhej diya " + email + " pe. Verify karo\u2026");
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

        /* Email pehle se verified hai -> seedha dashboard, koi OTP nahi.
           Sirf pehli baar (unverified account) OTP maangte hain. */
        return isVerified(u.uid).then(function (ok) {
          if (ok) {
            msg("ok", "\uD83D\uDD13 Welcome back! Dashboard khul raha hai\u2026");
            setTimeout(function () { window.location.href = "dashboard.html"; }, 800);
            return;
          }

          var code = genOtp();
          setPending({
            name: u.displayName || "", email: u.email, mobile: "", uid: u.uid,
            code: code, exp: Date.now() + 15 * 60 * 1000, sentAt: Date.now()
          });
          msg("ok", "Ek baar email verify karni hai \u2014 code bhej rahe hain\u2026");
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
  msg("ok", "Google se connect kar rahe hain\u2026");
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
    else { msg("", "Apple login jaldi aa raha hai. Abhi Google ya email use karo."); }
  });
});

/* ---------- VERIFY (email OTP) -> account create ---------- */
// verify.html iske globals use karta hai (box UX wahin rehta hai).
window.arvOtp = {
  dest: function () { var p = getPending(); return p && p.email ? p.email : ""; },

  verify: function (codeStr, onOk, onErr) {
    var p = getPending();
    if (!p) { onErr && onErr("Session expire ho gaya. Dobara signup karo."); return; }
    if (Date.now() > p.exp) { onErr && onErr("Code expire ho gaya. Naya code bhejo (Resend)."); return; }
    if (String(codeStr) !== String(p.code)) { onErr && onErr("Galat code. Dobara check karo."); return; }
    if (!guardReady()) { onErr && onErr("Firebase config set nahi hai."); return; }

    /* Account signup pe hi ban gaya tha. Yahan sirf email verified mark
       karte hain — koi password handling nahi. */
    var uid = p.uid || (auth.currentUser && auth.currentUser.uid);
    if (!uid) { onErr && onErr("Session mil nahi raha. Dobara login karo."); return; }

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
    if (!p) { onErr && onErr("Session expire ho gaya. Dobara signup karo."); return; }
    var code = genOtp();
    p.code = code; p.exp = Date.now() + 15 * 60 * 1000; p.sentAt = Date.now();
    setPending(p);
    sendOtpEmail(p.email, p.name, code)
      .then(function () { onOk && onOk(); })
      .catch(function (e) { onErr && onErr("Resend fail. Dobara try karo."); });
  }
};

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
