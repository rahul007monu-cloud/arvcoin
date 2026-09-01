/**
 * Sign in and sign up. One controller for both — the page it is on decides
 * which branch runs.
 */

import * as ui from '../ui.js';
import * as db from '../db.js';

function nextUrl() {
  var p = new URLSearchParams(location.search).get('next');
  // Only ever redirect to a relative path on this origin. An open redirect on a
  // login page is a phishing primitive.
  if (!p) return 'dashboard.html';
  if (/^(https?:)?\/\//i.test(p) || p.startsWith('/')) return 'dashboard.html';
  return p;
}

var isSignup = /signup/.test(location.pathname);

(async function () {
  await ui.boot({ feed: false, ticker: false, helix: true });

  if (db.mode() === 'local') {
    var note = ui.el('[data-local-note]');
    if (note) note.hidden = false;
  }

  // Already signed in — no reason to show a login form.
  var existing = await db.currentUser().catch(function () { return null; });
  if (existing) {
    location.replace(nextUrl());
    return;
  }

  var form = ui.el('[data-form]');
  if (form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type=submit]');
      ui.busy(btn, true, isSignup ? 'Creating\u2026' : 'Signing in\u2026');

      try {
        var email = ui.el('#email').value.trim();
        var pw = ui.el('#pw').value;

        if (isSignup) {
          var name = ui.el('#name') ? ui.el('#name').value.trim() : '';
          var res = await db.signUp(email, pw, name);
          // With email confirmation enabled Supabase returns a user but no
          // session — the account exists but cannot be used yet.
          if (db.mode() === 'supabase' && res.user && !res.session) {
            ui.toast('Account created. Check your email to confirm it, then sign in.', 'ok', 9000);
            setTimeout(function () { location.href = 'login.html'; }, 2500);
            return;
          }
        } else {
          await db.signIn(email, pw);
        }

        location.href = nextUrl();
      } catch (err) {
        ui.toastError(err);
      } finally {
        ui.busy(btn, false);
      }
    });
  }

  ui.on('[data-google]', 'click', async function () {
    try {
      await db.signInWithGoogle();
    } catch (e) {
      ui.toastError(e);
    }
  });
})();
