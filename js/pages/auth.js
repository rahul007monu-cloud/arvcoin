/**
 * Sign in and sign up.
 *
 * One controller for both — the page it loads on decides which branch runs. Both
 * end in the same place: an emailed code, then a session.
 *
 * The OTP step is a panel swap rather than a separate page. A second navigation
 * between "we sent you a code" and "enter the code" is where people lose the
 * thread, refresh, and end up with a code they can no longer use.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';

var CFG = globalThis.ARV_CONFIG;
var isSignup = /signup/.test(location.pathname);

var st = { email: '', purpose: 'signup' };

/* ------------------------------------------------------------------ routing -- */

/**
 * Where to go after signing in.
 *
 * Only ever a relative path on this origin. An open redirect on a login page is
 * a phishing primitive: send someone a link to the real site that bounces them
 * to a copy of it after they authenticate.
 */
function nextUrl() {
  var p = new URLSearchParams(location.search).get('next');
  if (!p) return 'dashboard.html';
  if (/^(https?:)?\/\//i.test(p) || p.startsWith('/') || p.includes('..')) return 'dashboard.html';
  return p;
}

function panel(name) {
  ui.els('[data-panel]').forEach(function (p) {
    p.classList.toggle('hidden', p.dataset.panel !== name);
  });
  var focus = ui.el('[data-panel="' + name + '"] input');
  if (focus) setTimeout(function () { focus.focus(); }, 60);
}

function toOtp(email, purpose, message) {
  st.email = email;
  st.purpose = purpose || 'signup';
  ui.setText('[data-otp-email]', email);
  panel('otp');
  if (message) ui.toast(message, 'ok', 6000);
}

/* ---------------------------------------------------------------- referral --- */

/**
 * Pick up a referral code from the link.
 *
 * Shown rather than hidden: someone arriving on a referral link should be able to
 * see whose it is, and that it costs them nothing.
 */
function applyReferral() {
  if (!isSignup) return;

  var code = (new URLSearchParams(location.search).get('ref') || '').toUpperCase()
    .replace(/[^A-Z0-9]/g, '').slice(0, 16);

  var field = ui.el('[data-ref-field]');
  var input = ui.el('#ref');

  if (code) {
    input.value = code;
    ui.setText('[data-ref-code]', code);
    ui.setText('[data-ref-pct]', CFG.REFERRAL.commissionPct + '%');
    ui.el('[data-ref-note]').classList.remove('hidden');
  } else {
    // No code on the link, so offer the field rather than hiding the feature.
    field.classList.remove('hidden');
  }
}

/* ------------------------------------------------------------------ google -- */

/**
 * Load Google Identity Services, once.
 *
 * Loaded lazily and only when the server says a client ID exists, so an install
 * that does not use Google never fetches a third-party script — which is both a
 * page-weight and a privacy consideration, since merely loading it tells Google
 * somebody opened this page.
 */
var gisPromise = null;
function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = function () {
      // Present but not ready is a real state on a slow connection.
      if (globalThis.google && globalThis.google.accounts && globalThis.google.accounts.id) resolve();
      else reject(new Error('gis-incomplete'));
    };
    s.onerror = function () { reject(new Error('gis-blocked')); };
    document.head.appendChild(s);
  });
  return gisPromise;
}

/**
 * Google handed us a token. Send it on and go where the server says.
 */
async function onGoogleCredential(response) {
  var box = ui.el('[data-google]');
  var note = ui.el('[data-google-note]');

  // Consent, and where it can legitimately be given.
  //
  // The terms checkbox lives on the signup page, next to the links. The login
  // page does not have one — so this route never claims consent from there, even
  // though the same button would otherwise happily open an account. Signing in
  // with Google on the login page as somebody with no account is answered by the
  // server with needs:'terms', and handled below by sending them to signup, where
  // the terms are actually in front of them.
  var accepted = false;
  if (isSignup) {
    var accept = ui.el('[data-accept]');
    accepted = !!(accept && accept.checked);
    if (!accepted) {
      ui.toast('Tick the box to accept the risk disclosure and terms, then use Google again.', 'warn', 7000);
      return;
    }
  }

  if (note) {
    note.textContent = 'Signing you in\u2026';
    note.classList.remove('hidden', 'warn');
  }
  if (box) box.style.opacity = '0.5';

  try {
    var r = await api.googleSignIn(response.credential, {
      referralCode: (ui.el('#ref') || {}).value || '',
      acceptedTerms: accepted
    });

    // Shown before navigating, because it is the only warning that the password
    // on a pre-existing unverified account has just been removed.
    if (r.notice) {
      ui.toast(r.notice, 'warn', 12000);
      setTimeout(function () { location.href = r.isNew ? 'profile.html#kyc' : nextUrl(); }, 2600);
      return;
    }
    // Same rule as the emailed-code path: a new account goes to KYC, a returning
    // one goes wherever it was headed.
    location.href = r.isNew ? 'profile.html#kyc' : nextUrl();
  } catch (err) {
    if (box) box.style.opacity = '';

    // No account for that Google address, and this page cannot take consent.
    // Not an error as far as the person is concerned — they are simply new.
    if (err.needs === 'terms') {
      ui.toast('That Google account is new here. Accept the terms on the sign-up page '
             + 'and use Google again \u2014 it takes one tap.', 'warn', 9000);
      setTimeout(function () {
        location.href = 'signup.html' + (location.search || '');
      }, 2200);
      return;
    }

    if (note) {
      note.textContent = err.message || 'That did not work. Try your email and password.';
      note.classList.remove('hidden');
      note.classList.add('warn');
    }
    ui.toastError(err);
  }
}

/**
 * Draw the Google button, if this install has Google configured.
 *
 * Every failure path here ends the same way: the button is simply not there, and
 * the email form above it is untouched. A sign-in page that breaks because a
 * third-party script did not load is a sign-in page nobody can use.
 */
async function setupGoogle() {
  var box = ui.el('[data-google]');
  if (!box) return;

  var cfg;
  try {
    cfg = await api.authProviders();
  } catch (_) {
    return;                       // Not installed, offline, old deployment.
  }
  var g = (cfg.providers || {}).google || {};
  if (!g.enabled || !g.clientId) return;

  try {
    await loadGis();
  } catch (_) {
    // Blocked by an extension, a network policy, or a region. Say so plainly
    // rather than leaving an empty gap where a button was promised.
    var note = ui.el('[data-google-note]');
    if (note) {
      note.textContent = 'Google sign-in could not load here. Use your email and password below.';
      note.classList.remove('hidden');
      note.classList.add('warn');
    }
    return;
  }

  globalThis.google.accounts.id.initialize({
    client_id: g.clientId,
    callback: onGoogleCredential,
    // Bound to our session and checked inside the signed token, so a credential
    // captured elsewhere cannot be posted to our endpoint.
    nonce: g.nonce,
    auto_select: false,
    // One Tap is deliberately not enabled. On a page about money an unprompted
    // account-chooser overlay reads as a phishing attempt, and it would cover
    // the form somebody is already typing into.
    cancel_on_tap_outside: true
  });

  var wrap = ui.el('[data-google-btn]');
  globalThis.google.accounts.id.renderButton(wrap, {
    type: 'standard',
    theme: 'filled_black',       // The only Google theme that sits in this palette.
    size: 'large',
    shape: 'rectangular',
    text: isSignup ? 'signup_with' : 'signin_with',
    logo_alignment: 'center',
    width: Math.min(wrap.clientWidth || 380, 400)
  });

  box.classList.remove('hidden');
}

/* ------------------------------------------------------------------- submit -- */

async function onCredentials(e) {
  e.preventDefault();
  var form = e.currentTarget;
  var btn = form.querySelector('button[type=submit]');

  var email = ui.el('#email').value.trim().toLowerCase();
  var password = ui.el('#pw').value;

  if (isSignup && !ui.el('[data-accept]').checked) {
    ui.toast('You need to accept the risk disclosure and terms to continue.', 'warn');
    return;
  }

  ui.busy(btn, true, isSignup ? 'Creating\u2026' : 'Checking\u2026');
  try {
    var r;
    if (isSignup) {
      r = await api.signup({
        email: email,
        password: password,
        fullName: ui.el('#name').value.trim(),
        referralCode: (ui.el('#ref') || {}).value || '',
        acceptedTerms: true
      });
    } else {
      r = await api.login(email, password);
    }

    // Both endpoints answer with next:'verify' when a code has been sent.
    if (r.next === 'verify') {
      toOtp(email, r.purpose || 'signup', r.message);
      return;
    }
    if (r.user) {
      location.href = nextUrl();
      return;
    }
    toOtp(email, 'login');
  } catch (err) {
    // A 503 here almost always means the site has files but no database yet.
    if (err.status === 503) {
      ui.el('[data-not-installed]').classList.remove('hidden');
    }
    ui.toastError(err);
  } finally {
    ui.busy(btn, false);
  }
}

async function onOtp(e) {
  e.preventDefault();
  var form = e.currentTarget;
  var btn = form.querySelector('button[type=submit]');
  var errEl = ui.el('[data-otp-err]');
  var code = ui.el('#code').value.replace(/\D/g, '');

  errEl.classList.add('hidden');

  if (code.length !== 6) {
    errEl.textContent = 'Enter the 6 digits from the email.';
    errEl.classList.remove('hidden');
    return;
  }

  ui.busy(btn, true, 'Verifying\u2026');
  try {
    await api.verifyOtp({
      email: st.email,
      code: code,
      purpose: st.purpose,
      // Inverted from the old trustDevice flag: this device is trusted for the
      // next day unless the person says it is not theirs.
      sharedDevice: !!(ui.el('[data-shared]') || {}).checked
    });
    location.href = isSignup ? 'profile.html#kyc' : nextUrl();
  } catch (err) {
    errEl.textContent = err.message || 'That code is not correct.';
    errEl.classList.remove('hidden');
    ui.el('#code').select();
  } finally {
    ui.busy(btn, false);
  }
}

async function onResend(e) {
  var btn = e.currentTarget;
  ui.busy(btn, true, 'Sending\u2026');
  try {
    await api.resendOtp(st.email, st.purpose);
    ui.toast('A new code is on its way. The previous one no longer works.', 'ok', 6000);
    ui.el('#code').value = '';
    ui.el('#code').focus();
  } catch (err) {
    ui.toastError(err);
  } finally {
    ui.busy(btn, false);
  }
}

/* --------------------------------------------------------------------- boot -- */

(async function () {
  applyReferral();

  var res = await ui.boot({ feed: false });

  // Already signed in — no reason to show a login form.
  if (res.user) {
    location.replace(nextUrl());
    return;
  }

  // Not awaited: it reaches out to Google, and the email form must be usable
  // immediately whether or not that ever comes back.
  setupGoogle();

  ui.on('[data-form]', 'submit', onCredentials);
  ui.on('[data-otp-form]', 'submit', onOtp);
  ui.on('[data-resend]', 'click', onResend);
  ui.on('[data-back]', 'click', function () { panel('credentials'); });

  // Paste a 6-digit code and it submits itself. On a phone the code arrives in a
  // notification and this removes the last tap.
  var codeInput = ui.el('#code');
  if (codeInput) {
    codeInput.addEventListener('input', function () {
      var v = codeInput.value.replace(/\D/g, '').slice(0, 6);
      if (v !== codeInput.value) codeInput.value = v;
      if (v.length === 6) ui.el('[data-otp-form]').requestSubmit();
    });
  }
})();
