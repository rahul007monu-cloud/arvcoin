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
      trustDevice: !!(ui.el('[data-trust]') || {}).checked
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
