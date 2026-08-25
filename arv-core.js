/* =========================================================
   arvcoin — core data layer (ES module)

   Ek hi jagah Firebase init hota hai, aur saare read/write helpers
   yahan se aate hain. Pages isko import karte hain:

     import { onUser, requireAuth, getWallet, getSubscription,
              listCalls, entitlement } from "./arv-core.js";

   ⚠️ Yaad rakho: yahan ke checks UX ke liye hain. Asli gating
   firestore.rules me hai. Client pe kabhi trust nahi.
   ========================================================= */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, query, where,
  orderBy, limit as qLimit, getDocs, onSnapshot, serverTimestamp,
  addDoc, updateDoc, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

var CFG = window.ARV_CONFIG || {};
var fbCfg = window.ARV_FIREBASE_CONFIG;

var ready = !!(fbCfg && fbCfg.apiKey && fbCfg.apiKey.indexOf("PASTE") === -1);
var app = null, auth = null, db = null;

if (ready) {
  app = getApps().length ? getApps()[0] : initializeApp(fbCfg);
  auth = getAuth(app);
  db = getFirestore(app);
} else {
  console.warn("[arvcoin] Firebase config missing — arv-core disabled.");
}

export { auth, db, ready };

/* =========================================================
   AUTH
   ========================================================= */

var _user = null;
var _claims = null;
var _userCbs = [];

if (ready) {
  onAuthStateChanged(auth, function (u) {
    _user = u;
    if (u) {
      u.getIdTokenResult().then(function (r) {
        _claims = r.claims || {};
        _userCbs.forEach(function (cb) { cb(_user, _claims); });
      }).catch(function () {
        _claims = {};
        _userCbs.forEach(function (cb) { cb(_user, _claims); });
      });
    } else {
      _claims = null;
      _userCbs.forEach(function (cb) { cb(null, null); });
    }
  });
}

/** Auth state subscribe karo. Turant current state bhi mil jaata hai. */
export function onUser(cb) {
  _userCbs.push(cb);
  if (_user !== null || _claims !== null) cb(_user, _claims);
  return function () {
    var i = _userCbs.indexOf(cb);
    if (i > -1) _userCbs.splice(i, 1);
  };
}

export function currentUser() { return _user; }
export function claims() { return _claims || {}; }
export function isAdmin() { return !!claims().admin; }
export function isAnalyst() { return !!(claims().analyst || claims().admin); }

/**
 * Page guard. Login nahi hai to redirect.
 * localStorage pe bharosa NAHI — asli Firebase auth state check karta hai.
 */
export function requireAuth(redirectTo) {
  redirectTo = redirectTo || "login.html";
  return new Promise(function (resolve) {
    if (!ready) { resolve(null); return; }
    var done = false;
    onUser(function (u) {
      if (done) return;
      done = true;
      if (!u) {
        try {
          sessionStorage.setItem("arvcoin_returnTo", location.pathname + location.search);
          localStorage.removeItem("arvcoin_user");
          localStorage.removeItem("arvcoin_session");
        } catch (e) {}
        location.replace(redirectTo);
        resolve(null);
      } else {
        resolve(u);
      }
    });
  });
}

/** Analyst/admin-only page guard. */
export function requireAnalyst(redirectTo) {
  redirectTo = redirectTo || "dashboard.html";
  return requireAuth().then(function (u) {
    if (!u) return null;
    if (!isAnalyst()) { location.replace(redirectTo); return null; }
    return u;
  });
}

export function logout() {
  try {
    localStorage.removeItem("arvcoin_user");
    localStorage.removeItem("arvcoin_session");
  } catch (e) {}
  if (!ready) { location.href = "login.html"; return Promise.resolve(); }
  return signOut(auth).then(function () { location.href = "login.html"; });
}

/* =========================================================
   USER PROFILE
   ========================================================= */

export function getProfile(uid) {
  uid = uid || (_user && _user.uid);
  if (!ready || !uid) return Promise.resolve(null);
  return getDoc(doc(db, "users", uid)).then(function (s) {
    return s.exists() ? Object.assign({ uid: uid }, s.data()) : null;
  });
}

export function updateProfileDoc(data) {
  if (!ready || !_user) return Promise.reject(new Error("not signed in"));
  // Protected fields client se nahi ja sakte (rules bhi block karte hain).
  var clean = Object.assign({}, data);
  ["role", "admin", "analyst", "arvBalance", "subscription", "founderMember", "createdAt"]
    .forEach(function (k) { delete clean[k]; });
  clean.updatedAt = serverTimestamp();
  return setDoc(doc(db, "users", _user.uid), clean, { merge: true });
}

/* =========================================================
   ARV CREDITS (wallet)

   ⚠️ Balance client se NEVER likha jaata. Sirf Cloud Function
   verified payment ke baad mint karta hai. Ye read-only hai.
   ========================================================= */

export function getWallet(uid) {
  uid = uid || (_user && _user.uid);
  if (!ready || !uid) return Promise.resolve({ arvBalance: 0, empty: true });
  return getDoc(doc(db, "wallets", uid)).then(function (s) {
    return s.exists() ? s.data() : { arvBalance: 0, empty: true };
  });
}

/** Live balance updates. */
export function watchWallet(cb) {
  if (!ready || !_user) return function () {};
  return onSnapshot(doc(db, "wallets", _user.uid), function (s) {
    cb(s.exists() ? s.data() : { arvBalance: 0, empty: true });
  }, function (e) { console.warn("[arvcoin] wallet watch:", e); });
}

/** Credit/debit history — audit trail. */
export function getLedger(max) {
  if (!ready || !_user) return Promise.resolve([]);
  var q = query(
    collection(db, "ledger"),
    where("uid", "==", _user.uid),
    orderBy("at", "desc"),
    qLimit(max || 50)
  );
  return getDocs(q).then(function (snap) {
    var out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    return out;
  });
}

/* =========================================================
   SUBSCRIPTION / ENTITLEMENT
   ========================================================= */

export function getSubscription(uid) {
  uid = uid || (_user && _user.uid);
  if (!ready || !uid) return Promise.resolve(null);
  return getDoc(doc(db, "subscriptions", uid)).then(function (s) {
    return s.exists() ? s.data() : null;
  });
}

export function watchSubscription(cb) {
  if (!ready || !_user) return function () {};
  return onSnapshot(doc(db, "subscriptions", _user.uid), function (s) {
    cb(s.exists() ? s.data() : null);
  }, function (e) { console.warn("[arvcoin] sub watch:", e); });
}

function toMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  var t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

/**
 * Entitlement snapshot — UI decide karne ke liye.
 * Server-side rules isko dobara enforce karte hain.
 */
export function entitlement(sub) {
  var now = Date.now();
  if (!sub) {
    return { active: false, planId: null, segments: [], daysLeft: 0, expired: false };
  }
  var till = toMillis(sub.activeTill);
  var active = sub.status === "active" && till > now;
  return {
    active: active,
    planId: sub.planId || null,
    planName: (CFG.plan && CFG.plan(sub.planId) && CFG.plan(sub.planId).name) || sub.planId || "",
    segments: sub.segments || [],
    activeTill: till,
    daysLeft: active ? Math.max(0, Math.ceil((till - now) / 86400000)) : 0,
    expired: !!(sub.status === "active" && till <= now) || sub.status === "expired",
    founderMember: !!sub.founderMember,
    covers: function (seg) { return active && (sub.segments || []).indexOf(seg) > -1; }
  };
}

/* =========================================================
   ACCESS REQUESTS — Telegram / WhatsApp funnel

   Website pe koi payment nahi. Flow:
     1. User "Unlock" dabata hai
     2. accessRequests/{id} doc banta hai — uid, plan, readable code
     3. Telegram/WhatsApp pe redirect, message me code prefilled
     4. Aap wahan charges batate ho, payment lete ho
     5. Admin panel se grant -> subscriptions/{uid} active
   ========================================================= */

/** Access request banao aur Telegram/WhatsApp ka URL wapas do. */
export function requestAccess(planId, channel) {
  if (!ready || !_user) return Promise.reject(new Error("Please sign in first"));

  var p = CFG.plan(planId);
  if (!p) return Promise.reject(new Error("Plan not found: " + planId));

  var code = CFG.newRequestCode();
  var email = _user.email || "";

  return addDoc(collection(db, "accessRequests"), {
    uid: _user.uid,
    email: email,
    name: _user.displayName || "",
    planId: p.id,
    planName: p.name,
    priceInr: p.priceInr,
    durationDays: p.durationDays,
    segments: p.segments,
    code: code,
    channel: channel || CFG.ACCESS.mode,
    status: "pending",
    createdAt: serverTimestamp()
  }).then(function (ref) {
    var url = (channel === "whatsapp")
      ? CFG.whatsappUrl(p.name, code, email)
      : CFG.telegramUrl(p.name, code, email);
    return { id: ref.id, code: code, url: url, plan: p };
  });
}

/** User ke apne pending requests. */
export function myAccessRequests(max) {
  if (!ready || !_user) return Promise.resolve([]);
  var q = query(
    collection(db, "accessRequests"),
    where("uid", "==", _user.uid),
    orderBy("createdAt", "desc"),
    qLimit(max || 10)
  );
  return getDocs(q).then(function (snap) {
    var out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    return out;
  }).catch(function () { return []; });
}

/** Admin: saare pending requests. */
export function pendingAccessRequests(max) {
  if (!ready || !isAdmin()) return Promise.resolve([]);
  var q = query(
    collection(db, "accessRequests"),
    where("status", "==", "pending"),
    orderBy("createdAt", "desc"),
    qLimit(max || 50)
  );
  return getDocs(q).then(function (snap) {
    var out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    return out;
  }).catch(function () { return []; });
}

/* =========================================================
   CALLS (research recommendations)

   Full call sirf active + covering subscription pe readable hai
   (firestore.rules). Bina subscription ke query permission-denied
   degi — isliye teasers alag collection me hain.
   ========================================================= */

/** Paid calls. Subscription na ho to error catch karke [] milta hai. */
export function listCalls(opts) {
  opts = opts || {};
  if (!ready) return Promise.resolve([]);
  var parts = [collection(db, "calls")];
  if (opts.segment) parts.push(where("segment", "==", opts.segment));
  if (opts.status) parts.push(where("status", "==", opts.status));
  parts.push(orderBy("publishedAt", "desc"));
  parts.push(qLimit(opts.limit || 50));
  return getDocs(query.apply(null, parts)).then(function (snap) {
    var out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    return out;
  }).catch(function (e) {
    if (e && e.code === "permission-denied") return [];
    console.warn("[arvcoin] listCalls:", e);
    return [];
  });
}

export function watchCalls(opts, cb) {
  opts = opts || {};
  if (!ready) return function () {};
  var parts = [collection(db, "calls")];
  if (opts.segment) parts.push(where("segment", "==", opts.segment));
  parts.push(orderBy("publishedAt", "desc"));
  parts.push(qLimit(opts.limit || 50));
  return onSnapshot(query.apply(null, parts), function (snap) {
    var out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    cb(out, null);
  }, function (e) { cb([], e); });
}

/** Public teasers — no entry/target/SL. SEO + locked-state UI. */
export function listTeasers(opts) {
  opts = opts || {};
  if (!ready) return Promise.resolve([]);
  var parts = [collection(db, "callTeasers")];
  if (opts.segment) parts.push(where("segment", "==", opts.segment));
  parts.push(orderBy("publishedAt", "desc"));
  parts.push(qLimit(opts.limit || 30));
  return getDocs(query.apply(null, parts)).then(function (snap) {
    var out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    return out;
  }).catch(function () { return []; });
}

export function getCall(callId) {
  if (!ready) return Promise.resolve(null);
  return getDoc(doc(db, "calls", callId)).then(function (s) {
    return s.exists() ? Object.assign({ id: s.id }, s.data()) : null;
  }).catch(function () { return null; });
}

/**
 * Call publish — sirf analyst/admin.
 * RA registration mandatory: bina number ke publish nahi hoga
 * (yahan bhi, aur firestore.rules me bhi).
 */
export function publishCall(data) {
  if (!ready) return Promise.reject(new Error("Firebase is not ready"));
  if (!isAnalyst()) return Promise.reject(new Error("Only an analyst or admin can publish research"));

  var ra = CFG.RA_REGISTRATION || {};
  if (!CFG.isRegistered || !CFG.isRegistered()) {
    return Promise.reject(new Error(
      "The SEBI RA registration number is not set in arv-config.js. " +
      "Publishing recommendations on securities for a fee requires registration " +
      "(SEBI Research Analysts Regulations, 2014). Add your own number or a partner RA's."
    ));
  }

  // Banned-phrase check (guaranteed returns waghera)
  if (window.ARVLint) {
    var lint = window.ARVLint.check([data.title, data.rationale, data.notes].join("\n"));
    if (!lint.ok) {
      return Promise.reject(new Error("Compliance block — remove these phrases: " + lint.hits.join(", ")));
    }
  }

  if (!data.rationale || String(data.rationale).trim().length < 20) {
    return Promise.reject(new Error("A rationale is required (minimum 20 characters). A bare tip is not research."));
  }

  var payload = {
    segment: data.segment,
    instrument: data.instrument,
    exchange: data.exchange || "NSE",
    action: data.action,                       // BUY / SELL
    entry: data.entry,
    entryType: data.entryType || "limit",
    targets: data.targets || [],
    stopLoss: data.stopLoss,
    horizon: data.horizon || "short",
    riskLevel: data.riskLevel || "moderate",
    title: data.title || "",
    rationale: data.rationale,
    notes: data.notes || "",
    status: "active",
    // SEBI-mandated attribution — har call pe dikhta hai
    raNumber: ra.number,
    analystName: ra.analystName || data.analystName || "",
    entityName: ra.entityName || "",
    publishedAt: serverTimestamp(),
    createdBy: _user.uid
  };

  return addDoc(collection(db, "calls"), payload);
}

/**
 * Call outcome update (target hit / SL hit / closed).
 * Original recommendation immutable hai — rules bhi rokte hain.
 * Performance stats me har call ginti hai, cherry-picking nahi.
 */
export function updateCallStatus(callId, patch) {
  if (!ready || !isAnalyst()) return Promise.reject(new Error("Not allowed"));
  var allowed = {};
  ["status", "exitPrice", "exitNote", "closedAt", "targetsHit"].forEach(function (k) {
    if (patch[k] !== undefined) allowed[k] = patch[k];
  });
  allowed.updatedAt = serverTimestamp();
  return addDoc(collection(db, "calls", callId, "revisions"), {
    patch: allowed, by: _user.uid, at: serverTimestamp()
  }).then(function () {
    return updateDoc(doc(db, "calls", callId), allowed);
  });
}

/* =========================================================
   PERFORMANCE — poori history se, filtered nahi
   ========================================================= */

export function performanceStats(calls) {
  var closed = calls.filter(function (c) {
    return c.status === "target_hit" || c.status === "sl_hit" || c.status === "closed";
  });
  var wins = closed.filter(function (c) { return c.status === "target_hit"; }).length;
  var losses = closed.filter(function (c) { return c.status === "sl_hit"; }).length;
  return {
    total: calls.length,
    active: calls.filter(function (c) { return c.status === "active"; }).length,
    closed: closed.length,
    wins: wins,
    losses: losses,
    neutral: closed.length - wins - losses,
    // Disclosure: ye past performance hai, future guarantee nahi
    note: (CFG.DISCLOSURES && CFG.DISCLOSURES.noGuarantee) || ""
  };
}

/* =========================================================
   LESSONS / RECAPS
   ========================================================= */

/* =========================================================
   ANALYSIS — levels + structural observation
   RA registration ke bina publish hota hai (koi action/entry/
   target/SL field nahi). Free wale sabko, baaki subscribers ko.
   ========================================================= */
export function listAnalysis(opts) {
  opts = opts || {};
  if (!ready) return Promise.resolve([]);
  var parts = [collection(db, "analysis")];
  if (opts.segment) parts.push(where("segment", "==", opts.segment));
  if (opts.freeOnly) parts.push(where("free", "==", true));
  parts.push(orderBy("publishedAt", "desc"));
  parts.push(qLimit(opts.limit || 40));
  return getDocs(query.apply(null, parts)).then(function (snap) {
    var out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    return out;
  }).catch(function (e) {
    if (e && e.code === "permission-denied") return [];
    console.warn("[arvcoin] listAnalysis:", e);
    return [];
  });
}

export function watchAnalysis(opts, cb) {
  opts = opts || {};
  if (!ready) return function () {};
  var parts = [collection(db, "analysis")];
  if (opts.segment) parts.push(where("segment", "==", opts.segment));
  parts.push(orderBy("publishedAt", "desc"));
  parts.push(qLimit(opts.limit || 40));
  return onSnapshot(query.apply(null, parts), function (snap) {
    var out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    cb(out, null);
  }, function (e) { cb([], e); });
}

export function listLessons(opts) {
  opts = opts || {};
  if (!ready) return Promise.resolve([]);
  var parts = [collection(db, "lessons")];
  if (opts.segment) parts.push(where("segment", "==", opts.segment));
  if (opts.freeOnly) parts.push(where("free", "==", true));
  parts.push(orderBy("order", "asc"));
  parts.push(qLimit(opts.limit || 100));
  return getDocs(query.apply(null, parts)).then(function (snap) {
    var out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    return out;
  }).catch(function () { return []; });
}

export function listRecaps(max) {
  if (!ready) return Promise.resolve([]);
  var q = query(collection(db, "recaps"), orderBy("date", "desc"), qLimit(max || 10));
  return getDocs(q).then(function (snap) {
    var out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    return out;
  }).catch(function () { return []; });
}

/* =========================================================
   GROWTH METRICS
   Platform activity — subscribers, calls published, community.
   ⚠️ Ye ARV ka price chart NAHI hai. Koi ₹ value nahi.
   ========================================================= */

export function getGrowth() {
  if (!ready) return Promise.resolve(null);
  return getDoc(doc(db, "growth", "current")).then(function (s) {
    return s.exists() ? s.data() : null;
  }).catch(function () { return null; });
}

/* =========================================================
   Q&A (moderated, concept-level)
   ========================================================= */

export function askQuestion(text, segment) {
  if (!ready || !_user) return Promise.reject(new Error("Please sign in"));
  if (window.ARVLint) {
    var lint = window.ARVLint.check(text);
    if (!lint.ok) {
      return Promise.reject(new Error(
        "We cannot give personalised buy or sell advice. Please ask a concept-level question."
      ));
    }
  }
  return addDoc(collection(db, "questions"), {
    uid: _user.uid,
    text: String(text).slice(0, 1000),
    segment: segment || "general",
    status: "pending",
    createdAt: serverTimestamp()
  });
}

/* =========================================================
   FORMATTERS
   ========================================================= */

export function inr(n) {
  return "\u20B9" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export function arv(n) {
  return Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 }) + " ARV";
}

export function when(ts) {
  var ms = toMillis(ts);
  if (!ms) return "";
  var diff = Date.now() - ms;
  if (diff < 60000) return "abhi";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m pehle";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h pehle";
  if (diff < 604800000) return Math.floor(diff / 86400000) + "d pehle";
  return new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export { toMillis, Timestamp, serverTimestamp };
