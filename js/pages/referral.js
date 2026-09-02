/**
 * Refer and earn.
 *
 * The commission is 5% of a referred user's *first* deposit, paid once. Nothing
 * on this page pays anything — `admin.php` credits it at the moment that deposit
 * is confirmed, and this only reports what happened.
 *
 * Two things are stated on screen rather than left implied, because both are the
 * kind of thing a referral page usually hides:
 *
 *   - the money comes out of our margin, not out of the referred user's deposit,
 *     so nobody is paying for someone else's bonus;
 *   - tiers reward with lower fees rather than cash, because a cash reward that
 *     scales with other people's deposits is a return funded by deposits.
 *
 * The second one is not decoration. Paying cash on referred volume in a product
 * that pools funds is what the Prize Chits and Money Circulation Schemes
 * (Banning) Act, 1978 describes, and taking deposits against a promised return
 * is an offence under the BUDS Act, 2019.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';
import * as qr from '../qr.js';

var CFG = globalThis.ARV_CONFIG;

var st = { user: null, summary: null, tiers: [] };

/* ------------------------------------------------------------------ invite -- */

function paintInvite() {
  var s = st.summary;
  if (!s || !s.code) return;

  ui.el('#code').value = s.code;
  ui.el('#link').value = s.link || '';

  var msg = 'I am using ARV Coin \u2014 one unit that tracks Bitcoin, priced in rupees. '
          + 'Use my code ' + s.code + ' when you sign up: ' + (s.link || '');

  var wa = ui.el('[data-wa]');
  var tg = ui.el('[data-tg]');
  if (wa) wa.href = 'https://wa.me/?text=' + encodeURIComponent(msg);
  if (tg) {
    tg.href = 'https://t.me/share/url?url=' + encodeURIComponent(s.link || '')
            + '&text=' + encodeURIComponent('ARV Coin \u2014 use code ' + s.code);
  }

  var mail = ui.el('[data-mail]');
  if (mail) {
    mail.href = 'mailto:?subject=' + encodeURIComponent('ARV Coin invite')
              + '&body=' + encodeURIComponent(msg);
  }

  // The native share sheet only exists on some devices, so the button appears
  // only where it will actually work rather than failing when tapped.
  if (navigator.share) {
    var btn = ui.el('[data-share]');
    btn.classList.remove('hidden');
    btn.addEventListener('click', function () {
      navigator.share({ title: 'ARV Coin', text: msg, url: s.link }).catch(function () {});
    });
  }

  if (s.link) {
    qr.render(ui.el('[data-qr]'), { uri: s.link, cellSize: 4 });
  }
}

function copyField(id) {
  var node = ui.el('#' + id);
  if (!node) return;
  var text = node.value;

  var done = function () { ui.toast('Copied.', 'ok', 2000); };
  var fallback = function () {
    // execCommand is deprecated but still the only path on a page served over
    // plain HTTP or in an older browser, where navigator.clipboard is undefined.
    node.select();
    try { document.execCommand('copy'); done(); }
    catch (_) { ui.toast('Select the text and copy it manually.', 'warn'); }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, fallback);
  } else {
    fallback();
  }
}

/* ------------------------------------------------------------------- stats -- */

function paintStats() {
  var t = (st.summary && st.summary.totals) || {};

  ui.setText('[data-earned]', ui.fmtPaise(t.earnedPaise || 0));
  ui.setText('[data-pending]', ui.fmtPaise(t.pendingPaise || 0));
  ui.setText('[data-funded]', String(t.funded || 0));
  ui.setText('[data-volume]', ui.fmtCompact((t.volumePaise || 0) / 100));

  var joined = t.joinedNotFunded || 0;
  ui.setText('[data-joined]', joined
    ? joined + ' more signed up, not yet funded'
    : 'people whose first deposit landed');
}

/* ------------------------------------------------------------------- terms -- */

function paintTerms() {
  var s = st.summary || {};
  var terms = s.terms || {};
  var pct = terms.commissionPct != null ? terms.commissionPct : CFG.REFERRAL.commissionPct;

  ui.setText('[data-pct]', String(pct));

  ui.setHtml('[data-terms]',
    row('Commission', pct + '% of their first deposit')
    + row('Paid', 'once per person')
    + row('Cap', ui.fmtPaise(terms.capPaise != null ? terms.capPaise : CFG.REFERRAL.maxCommissionPaise))
    + row('Levels', String(terms.levels || 1))
    + row('Credited to', 'your rupee balance')
    + row('Costs them', 'nothing'));

  ui.setText('[data-terms-note]', terms.explanation || '');

  function row(l, v) {
    return '<div class="ledger-row"><span class="l">' + l + '</span>'
         + '<span class="a">' + ui.esc(v) + '</span></div>';
  }
}

/* ------------------------------------------------------------------- tiers -- */

function paintTiers() {
  var s = st.summary || {};
  var tier = s.tier || {};
  var tiers = st.tiers.length ? st.tiers : CFG.REWARD_TIERS;

  var current = tier.current || null;
  var earnedIdx = current
    ? tiers.findIndex(function (t) { return t.id === current; })
    : -1;

  if (current) {
    var b = ui.el('[data-tier-badge]');
    b.classList.remove('hidden');
    b.textContent = (tiers[earnedIdx] && tiers[earnedIdx].label) || current;
  }
  ui.setText('[data-tier-now]', current
    ? ((tiers[earnedIdx] && tiers[earnedIdx].label) || current)
    : 'no tier yet');

  /* progress toward the next one */
  var host = ui.el('[data-tier-progress]');
  if (tier.next && tier.gap) {
    if (tier.gap.type === 'blocked') {
      host.innerHTML = '<div class="note-box warn"><strong>'
        + ui.esc(tier.next.label) + ' is next.</strong> ' + ui.esc(tier.gap.reason) + '</div>';
    } else {
      var remaining = tier.gap.remainingPaise || 0;
      var vol = (s.totals && s.totals.volumePaise) || 0;
      var target = vol + remaining;
      var pct = target > 0 ? Math.min(100, (vol / target) * 100) : 0;

      host.innerHTML =
        '<div class="row-between small" style="margin-bottom:6px">'
          + '<span>Next: <strong>' + ui.esc(tier.next.label) + '</strong> \u2014 '
          + ui.esc(tier.next.perk) + '</span>'
          + '<span class="num muted">' + ui.fmtCompact(remaining / 100) + ' to go</span>'
        + '</div>'
        + '<div class="progress"><span style="width:' + pct.toFixed(1) + '%"></span></div>';
    }
  } else if (current) {
    host.innerHTML = '<div class="note-box ok">You are at the top tier. '
      + ui.esc((tiers[earnedIdx] && tiers[earnedIdx].perk) || '') + '</div>';
  } else {
    host.innerHTML = '';
  }

  /* the ladder */
  ui.setHtml('[data-tiers]', tiers.map(function (t, i) {
    var earned = earnedIdx >= 0 && i <= earnedIdx;
    var req = t.requirement || (t.metric === 'paise'
      ? ui.fmtCompact(t.threshold / 100) + ' referred'
      : t.threshold + '\u00d7 your own deposits');

    return '<div class="tier-row' + (earned ? ' earned' : '') + '">'
      + '<span class="tier-name">' + ui.esc(t.label) + '</span>'
      + '<span style="flex:1;min-width:0">'
        + '<span class="small strong" style="display:block">' + ui.esc(t.perk) + '</span>'
        + '<span class="tiny muted">' + ui.esc(req) + '</span>'
      + '</span>'
      + (earned ? '<span class="badge ok">earned</span>' : '')
      + '</div>';
  }).join(''));
}

/* ------------------------------------------------------------------ people -- */

function paintPeople() {
  var rows = (st.summary && st.summary.referrals) || [];
  var host = ui.el('[data-people]');

  if (!rows.length) {
    host.innerHTML = '<div class="empty"><div class="icon">\u25cb</div>'
      + 'Nobody yet. Share your code and they will show up here as soon as they sign up.</div>';
    return;
  }

  ui.el('[data-csv]').classList.remove('hidden');

  host.innerHTML =
    '<table class="data"><thead><tr>'
      + '<th>Who</th><th>Joined</th><th class="right">First deposit</th>'
      + '<th class="right">Rate</th><th class="right">Commission</th><th>Status</th>'
    + '</tr></thead><tbody>'
    + rows.map(function (r) {
      var cls = r.status === 'paid' ? 'ok' : (r.status === 'void' ? 'bad' : 'warn');
      return '<tr>'
        + '<td class="num">' + ui.esc(r.who) + '</td>'
        + '<td class="muted">' + ui.fmtDate(r.at) + '</td>'
        + '<td class="right num">' + ui.fmtPaise(r.basePaise) + '</td>'
        + '<td class="right num muted">' + r.commissionPct + '%</td>'
        + '<td class="right num strong">' + ui.fmtPaise(r.commissionPaise) + '</td>'
        + '<td><span class="badge ' + cls + '">' + ui.esc(r.status) + '</span></td>'
        + '</tr>';
    }).join('')
    + '</tbody></table>';
}

function exportCsv() {
  var rows = (st.summary && st.summary.referrals) || [];
  ui.downloadCsv('arv-referrals.csv', [
    ['Who', 'Joined', 'First deposit (INR)', 'Rate %', 'Commission (INR)', 'Status']
  ].concat(rows.map(function (r) {
    return [r.who, r.at, (r.basePaise / 100).toFixed(2), r.commissionPct,
            (r.commissionPaise / 100).toFixed(2), r.status];
  })));
}

/* -------------------------------------------------------------------- boot -- */

(async function () {
  await ui.boot({ feed: false });

  var user = await api.requireUser();
  if (!user) return;
  st.user = user;

  try {
    st.summary = await api.referralSummary();
  } catch (e) {
    ui.toastError(e);
    return;
  }

  if (st.summary.enabled === false) {
    ui.el('[data-off]').classList.remove('hidden');
  }

  // The tier ladder is presentational, so a failure to fetch it falls back to
  // the copy in arv-config.js rather than leaving a hole in the page.
  try {
    var t = await api.rewardTiers();
    st.tiers = t.tiers || [];
  } catch (_) {
    st.tiers = CFG.REWARD_TIERS;
  }

  paintInvite();
  paintStats();
  paintTerms();
  paintTiers();
  paintPeople();

  ui.els('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () { copyField(b.dataset.copy); });
  });
  ui.on('[data-csv]', 'click', exportCsv);
})();
