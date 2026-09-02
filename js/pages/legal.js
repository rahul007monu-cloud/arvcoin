/**
 * Legal page.
 *
 * The prose is in the HTML because it should be readable with JavaScript off —
 * a risk disclosure that only appears once a module loads is not a disclosure.
 * This file fills in the handful of values that must not be allowed to drift out
 * of step with the running configuration: the launch date and base price, the
 * deposit and withdrawal windows, the fallback window, and the support address.
 *
 * If any of these were typed into the page as literals, a change to a setting
 * would leave the terms quietly stating something the platform no longer does.
 */

import * as ui from '../ui.js';

var CFG = globalThis.ARV_CONFIG;

function fmtDate(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(CFG.UI.locale || 'en-IN', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

/* Smooth-scroll the contents list, and mark where the reader is. */
function wireToc() {
  var links = ui.els('[data-toc] a');
  if (!links.length) return;

  links.forEach(function (a) {
    a.addEventListener('click', function (e) {
      var target = document.querySelector(a.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Update the address bar without a jump, so the section can be linked to.
      history.replaceState(null, '', a.getAttribute('href'));
    });
  });

  if (!('IntersectionObserver' in window)) return;

  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var id = en.target.id;
      links.forEach(function (a) {
        a.classList.toggle('on', a.getAttribute('href') === '#' + id);
      });
    });
  }, { rootMargin: '-80px 0px -70% 0px' });

  ui.els('main section[id]').forEach(function (s) { obs.observe(s); });
}

(async function () {
  // No feed and no account needed — this page must work for someone who has not
  // signed up, which is precisely who most needs to read it.
  await ui.boot({ feed: false });

  ui.setText('[data-updated]', fmtDate(CFG.UI.legalUpdated));
  ui.setText('[data-launch]', fmtDate(new Date(CFG.INDEX.launchMs).toISOString()));
  ui.setText('[data-base]', ui.fmtPrice(CFG.INDEX.arvBaseInr, 2));

  var p = CFG.PAYMENTS;
  ui.setText('[data-dep-window]', p.depositMinMinutes + '\u2013' + p.depositMaxMinutes + ' minutes');
  ui.setText('[data-wd-window]',
    p.withdrawMinMinutes + ' minutes to '
    + (p.withdrawMaxMinutes >= 60
        ? (p.withdrawMaxMinutes / 60) + ' hour' + (p.withdrawMaxMinutes >= 120 ? 's' : '')
        : p.withdrawMaxMinutes + ' minutes'));
  ui.setText('[data-fallback]', CFG.MARKET.sellFallbackMinutes + ' minutes');

  var email = CFG.UI.supportEmail;
  ui.setText('[data-support]', email);
  ui.els('[data-support-link]').forEach(function (a) { a.href = 'mailto:' + email; });

  wireToc();

  // Arriving on a deep link from the footer should land on the section rather
  // than at the top with the anchor already consumed by the sticky nav.
  if (location.hash) {
    var t = document.querySelector(location.hash);
    if (t) setTimeout(function () { t.scrollIntoView({ block: 'start' }); }, 120);
  }
})();
