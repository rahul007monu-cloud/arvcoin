/**
 * Operations.
 *
 * The reconciliation panel is the reason this page exists. Everything else is
 * administration; reconciliation is the control that keeps the platform solvent,
 * because the obligation to unit holders only holds if the Bitcoin behind it is
 * actually there — and a shortfall compounds quietly until someone cannot exit.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';

var CFG = globalThis.ARV_CONFIG;
var st = { overview: null, recon: null };

/* ---------------------------------------------------------------- overview -- */

function paintOverview(o) {
  var q = o.queues || {};
  var late = o.overdue || {};

  ui.setText('[data-q-deposits]', String(q.deposits_pending || 0));
  ui.setText('[data-q-deposits-late]', String(late.deposits || 0));
  ui.setText('[data-q-withdrawals]',
    String((q.withdrawals_pending || 0) + (q.withdrawals_approved || 0)));
  ui.setText('[data-q-withdrawals-late]', String(late.withdrawals || 0));
  ui.setText('[data-q-kyc]', String(q.kyc_pending || 0));

  var p = o.price || {};
  ui.setText('[data-price]', p.nav != null ? ui.fmtPrice(p.nav) : '\u2014');
  ui.setText('[data-price-age]', p.nav == null
    ? 'feed has never run'
    : (p.stale ? 'stale \u2014 trading paused' : 'updated ' + (p.ageSeconds || 0) + 's ago'));

  ui.paintServerFeed({ price: p, feed: { source: (o.feed && o.feed.last_status) || 'server' } });

  // Warnings first: these are things an operator should be told rather than left
  // to discover from a support ticket.
  var wHost = ui.el('[data-warnings]');
  var warnings = o.warnings || [];
  wHost.innerHTML = warnings.length
    ? '<div class="note-box warn"><strong>Attention</strong>'
      + '<ul style="margin:8px 0 0;padding-left:1.1rem">'
      + warnings.map(function (w) { return '<li>' + ui.esc(w) + '</li>'; }).join('')
      + '</ul></div>'
    : '<div class="note-box ok">Nothing needs attention.</div>';

  // Money held for others.
  var m = o.money || {};
  ui.setHtml('[data-money]', [
    ['TDS withheld', m.tdsPaise, 'deposit with the department'],
    ['GST collected', m.gstPaise, 'a liability, not income'],
    ['Platform fees', m.feesPaise, 'this is the actual revenue'],
    ['Referral paid out', m.referralPaidPaise, 'from your own margin']
  ].map(function (r) {
    return '<div class="stat"><span class="stat-k">' + r[0] + '</span>'
      + '<span class="stat-v" style="font-size:1.25rem">' + ui.fmtPaise(r[1] || 0) + '</span>'
      + '<span class="stat-sub">' + r[2] + '</span></div>';
  }).join(''));
}

/* ---------------------------------------------------------- reconciliation -- */

function paintRecon(r) {
  st.recon = r;
  var ob = r.obligation || {};

  ui.setHtml('[data-obligation]',
    row('Units outstanding', ui.fmtUnits(ob.unitsOutstanding, 8))
    + row('ARV price', ob.nav != null ? ui.fmtPrice(ob.nav) : '\u2014')
    + rowKind('Owed to holders', ui.fmtPaise(ob.liabilityPaise || 0), 'gross')
    + '<div class="ledger-divider"></div>'
    + row('Bitcoin price', ob.btcPriceInr != null ? ui.fmtBig(ob.btcPriceInr) : '\u2014')
    + '<div class="ledger-row k-liability-total"><span class="l">Bitcoin required</span>'
      + '<span class="a">' + (ob.btcRequired != null ? ob.btcRequired.toFixed(8) : '\u2014')
      + ' BTC</span>'
      + '<span class="note">This much Bitcoin, held, is what makes the index return '
      + 'deliverable to holders.</span></div>'
    + '<div class="ledger-divider"></div>'
    + row('Rupees in user wallets', ui.fmtPaise(ob.userInrPaise || 0))
    + row('Cost basis held', ui.fmtPaise(ob.investedPaise || 0)));

  // Does the ledger agree with the cached wallet balances?
  var lc = r.ledgerCheck || {};
  ui.setHtml('[data-ledger-check]',
    '<div class="ledger-row k-' + (lc.balanced ? 'net' : 'warning') + '">'
      + '<span class="l">' + (lc.balanced ? 'Ledger and wallets agree' : 'Ledger drift') + '</span>'
      + '<span class="a">' + (lc.balanced ? '\u2713'
          : ui.fmtPaise(lc.inrDriftPaise || 0) + ' / ' + (lc.unitsDrift || '0')) + '</span>'
      + '<span class="note">' + ui.esc(lc.note || '') + '</span>'
    + '</div>');

  paintDiff();

  function row(l, v) {
    return '<div class="ledger-row"><span class="l">' + l + '</span>'
         + '<span class="a">' + v + '</span></div>';
  }
  function rowKind(l, v, k) {
    return '<div class="ledger-row k-' + k + '"><span class="l">' + l + '</span>'
         + '<span class="a">' + v + '</span></div>';
  }
}

/**
 * The difference between what must be held and what is.
 *
 * With no units outstanding there is nothing to be a percentage of, so a
 * percentage would read 0% and wrongly imply everything reconciles. That state
 * gets its own sentence.
 */
function paintDiff() {
  var host = ui.el('[data-diff]');
  if (!host || !st.recon) return;

  var ob = st.recon.obligation || {};
  var required = ob.btcRequired;
  var actual = parseFloat((ui.el('#held').value || '').replace(/[^\d.]/g, ''));

  if (required == null || !isFinite(actual)) {
    host.innerHTML = '<div class="ledger-row"><span class="l muted">'
      + 'Enter the Bitcoin actually held to see the difference.</span></div>';
    return;
  }

  var diff = actual - required;
  var inr = ob.btcPriceInr ? diff * ob.btcPriceInr : 0;
  var noLiability = required < 1e-12;
  var pct = noLiability ? null : (diff / required) * 100;
  var ok = noLiability ? Math.abs(diff) < 1e-12 : Math.abs(pct) < 0.5;

  var verdict;
  if (noLiability) {
    verdict = Math.abs(diff) < 1e-12
      ? 'No units outstanding and nothing held \u2014 balanced.'
      : 'No units are outstanding, so none of this is owed to holders. The whole '
        + 'balance is unallocated treasury, not profit.';
  } else if (ok) {
    verdict = 'Within half a percent \u2014 ordinary execution drift.';
  } else {
    verdict = diff < 0
      ? 'Holders are under-covered. Buy the difference before the next redemption.'
      : 'More is held than is owed. The excess is unallocated, not profit.';
  }

  host.innerHTML =
    '<div class="ledger-row"><span class="l">Required</span>'
      + '<span class="a">' + required.toFixed(8) + '</span></div>'
    + '<div class="ledger-row"><span class="l">Actually held</span>'
      + '<span class="a">' + actual.toFixed(8) + '</span></div>'
    + '<div class="ledger-row k-' + (ok ? 'net' : 'warning') + '">'
      + '<span class="l">'
        + (Math.abs(diff) < 1e-12 ? 'Balanced' : (diff > 0 ? 'Surplus' : 'Shortfall')) + '</span>'
      + '<span class="a">' + (diff >= 0 ? '+' : '\u2212') + Math.abs(diff).toFixed(8) + ' BTC</span>'
      + '<span class="note">'
        + (pct != null ? ui.fmtPct(pct) + ' \u00b7 ' : '')
        + (inr >= 0 ? '+' : '\u2212') + ui.fmtBig(Math.abs(inr)) + '. ' + verdict
      + '</span></div>';
}

/* ---------------------------------------------------------------- deposits -- */

async function loadDeposits() {
  var host = ui.el('[data-deposits]');
  try {
    var r = await api.admin.deposits('submitted');
    var rows = r.deposits || [];
    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="5" class="empty">Nothing waiting.</td></tr>';
      return;
    }
    host.innerHTML = rows.map(function (d) {
      var kyc = d.kycStatus !== 'verified'
        ? '<span class="badge warn">KYC ' + ui.esc(d.kycStatus) + '</span>' : '';
      var shot = d.screenshot
        ? '<a href="' + ui.esc(d.screenshot) + '" target="_blank" rel="noopener">screenshot</a>' : '';
      return '<tr>'
        + '<td><div class="tiny">' + ui.esc(d.email) + '</div>'
          + '<div class="tiny muted">' + ui.esc(d.name || '') + ' ' + kyc + '</div>'
          + '<div class="mono tiny muted">' + ui.esc(d.ref) + '</div></td>'
        + '<td class="num strong">' + ui.fmtPaise(d.amountPaise) + '</td>'
        + '<td class="mono tiny">' + ui.esc(d.utr || '\u2014') + '<div>' + shot + '</div></td>'
        + '<td class="tiny' + (d.waitingMinutes > CFG.PAYMENTS.depositMaxMinutes ? ' warn' : '') + '">'
          + d.waitingMinutes + 'm</td>'
        + '<td class="right nowrap">'
          + '<button class="btn btn-sm btn-buy" data-confirm="' + ui.esc(d.ref) + '">Confirm</button> '
          + '<button class="btn btn-sm btn-ghost" data-reject-dep="' + ui.esc(d.ref) + '">Reject</button>'
        + '</td></tr>';
    }).join('');

    bind('[data-confirm]', async function (b) {
      var ref = b.dataset.confirm;
      if (!confirm('Confirm ' + ref + '?\n\nOnly do this once the credit is visible in the bank account. '
                 + 'This credits the wallet and pays any referral commission.')) return false;
      var r2 = await api.admin.confirmDeposit(ref, '');
      var extra = r2.commission
        ? ' Referral commission ' + ui.fmtPaise(r2.commission.paise) + ' paid.'
        : '';
      ui.toast((r2.message || 'Credited.') + extra, 'ok', 7000);
      return true;
    });

    bind('[data-reject-dep]', async function (b) {
      var reason = prompt('Why is this being rejected? The user sees this.');
      if (!reason) return false;
      await api.admin.rejectDeposit(b.dataset.rejectDep, reason);
      ui.toast('Rejected.', 'ok');
      return true;
    });
  } catch (e) {
    host.innerHTML = '<tr><td colspan="5" class="empty">' + ui.esc(e.message) + '</td></tr>';
  }
}

/* ------------------------------------------------------------- withdrawals -- */

async function loadWithdrawals() {
  var host = ui.el('[data-withdrawals]');
  try {
    var results = await Promise.all([
      api.admin.withdrawals('requested'),
      api.admin.withdrawals('approved')
    ]);
    var rows = (results[0].withdrawals || []).concat(results[1].withdrawals || []);

    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="5" class="empty">Nothing to pay.</td></tr>';
      return;
    }

    host.innerHTML = rows.map(function (w) {
      var action = w.status === 'requested'
        ? '<button class="btn btn-sm btn-buy" data-approve="' + ui.esc(w.ref) + '">Approve</button>'
        : '<button class="btn btn-sm btn-primary" data-paid="' + ui.esc(w.ref) + '">Mark paid</button>';
      return '<tr>'
        + '<td><div class="tiny">' + ui.esc(w.email) + '</div>'
          + '<div class="mono tiny muted">' + ui.esc(w.ref) + '</div>'
          + '<span class="badge ' + (w.status === 'approved' ? 'info' : 'warn') + '">'
            + ui.esc(w.status) + '</span></td>'
        + '<td class="num strong">' + ui.fmtPaise(w.amountPaise) + '</td>'
        + '<td class="mono tiny">' + ui.esc(w.upiVpa) + '</td>'
        + '<td class="tiny' + (w.overdue ? ' warn' : '') + '">' + w.waitingMinutes + 'm'
          + (w.overdue ? '<div class="tiny">overdue</div>' : '') + '</td>'
        + '<td class="right nowrap">' + action + ' '
          + '<button class="btn btn-sm btn-ghost" data-reject-wd="' + ui.esc(w.ref) + '">Reject</button>'
        + '</td></tr>';
    }).join('');

    bind('[data-approve]', async function (b) {
      var r = await api.admin.approveWithdraw(b.dataset.approve);
      ui.toast(r.message || 'Approved.', 'ok');
      return true;
    });

    bind('[data-paid]', async function (b) {
      var utr = prompt('UTR of the payment you sent (optional but recommended):') || '';
      if (!confirm('Mark ' + b.dataset.paid + ' as paid?\n\nOnly after the money has actually left. '
                 + 'This releases the hold and cannot be undone.')) return false;
      var r = await api.admin.markPaid(b.dataset.paid, utr.trim());
      ui.toast(r.message || 'Marked paid.', 'ok');
      return true;
    });

    bind('[data-reject-wd]', async function (b) {
      var reason = prompt('Why? The user sees this, and the hold is released.');
      if (!reason) return false;
      await api.admin.rejectWithdraw(b.dataset.rejectWd, reason);
      ui.toast('Rejected and hold released.', 'ok');
      return true;
    });
  } catch (e) {
    host.innerHTML = '<tr><td colspan="5" class="empty">' + ui.esc(e.message) + '</td></tr>';
  }
}

/* --------------------------------------------------------------------- KYC -- */

async function loadKyc() {
  var host = ui.el('[data-kyc]');
  try {
    var r = await api.admin.kycQueue();
    var rows = r.queue || [];
    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="7" class="empty">Nothing to review.</td></tr>';
      return;
    }
    host.innerHTML = rows.map(function (k) {
      return '<tr>'
        + '<td class="tiny">' + ui.esc(k.email) + '</td>'
        + '<td class="tiny">' + ui.esc(k.fullName) + '</td>'
        + '<td class="mono tiny">' + ui.esc(k.pan) + '</td>'
        + '<td class="tiny">' + ui.esc(k.dob || '') + '</td>'
        + '<td class="tiny">' + ui.esc((k.city || '') + ', ' + (k.state || '') + ' ' + (k.pincode || ''))
          + (k.aadhaarLast4 ? '<div class="tiny muted">Aadhaar \u2026' + ui.esc(k.aadhaarLast4) + '</div>' : '')
          + '</td>'
        + '<td class="tiny">' + (k.waitingHours != null ? k.waitingHours + 'h' : '\u2014') + '</td>'
        + '<td class="right nowrap">'
          + '<button class="btn btn-sm btn-buy" data-kyc-ok="' + k.userId + '">Verify</button> '
          + '<button class="btn btn-sm btn-ghost" data-kyc-no="' + k.userId + '">Reject</button>'
        + '</td></tr>';
    }).join('');

    bind('[data-kyc-ok]', async function (b) {
      await api.admin.reviewKyc(Number(b.dataset.kycOk), true, '');
      ui.toast('Verified.', 'ok');
      return true;
    });

    bind('[data-kyc-no]', async function (b) {
      var reason = prompt('What needs correcting? The user sees this.');
      if (!reason) return false;
      await api.admin.reviewKyc(Number(b.dataset.kycNo), false, reason);
      ui.toast('Rejected.', 'ok');
      return true;
    });
  } catch (e) {
    host.innerHTML = '<tr><td colspan="7" class="empty">' + ui.esc(e.message) + '</td></tr>';
  }
}

/* ---------------------------------------------------------------- settings -- */

var EDITABLE = [
  ['upi_vpa', 'UPI ID for deposits', 'text'],
  ['entry_fee_pct', 'Entry fee %', 'number'],
  ['exit_fee_pct', 'Exit fee %', 'number'],
  ['sell_fallback_minutes', 'Sell fallback (minutes)', 'number'],
  ['sell_fallback_to_treasury', 'Sell fallback on', 'bool'],
  ['referral_enabled', 'Referral on', 'bool'],
  ['referral_pct', 'Referral %', 'number'],
  ['kyc_required', 'KYC required', 'bool'],
  ['deposit_max_minutes', 'Deposit window (max min)', 'number'],
  ['withdraw_max_minutes', 'Withdraw window (max min)', 'number'],
  ['price_max_age_seconds', 'Pause trading after (seconds)', 'number'],
  ['maintenance_mode', 'Maintenance mode', 'bool']
];

async function loadSettings() {
  var host = ui.el('[data-settings]');
  try {
    var r = await api.admin.settings();
    var s = r.settings || {};

    host.innerHTML = EDITABLE.map(function (row) {
      var key = row[0], label = row[1], type = row[2];
      var val = s[key] != null ? s[key] : '';
      var input = type === 'bool'
        ? '<select data-setting="' + key + '">'
          + '<option value="1"' + (val === '1' ? ' selected' : '') + '>on</option>'
          + '<option value="0"' + (val !== '1' ? ' selected' : '') + '>off</option></select>'
        : '<input data-setting="' + key + '" type="text" value="' + ui.esc(val) + '">';
      return '<div class="field"><label>' + ui.esc(label) + '</label>' + input + '</div>';
    }).join('');

    ui.els('[data-setting]').forEach(function (input) {
      input.addEventListener('change', async function () {
        try {
          await api.admin.saveSetting(input.dataset.setting, input.value);
          ui.toast('Saved.', 'ok', 2000);
          load();
        } catch (e) { ui.toastError(e); }
      });
    });
  } catch (e) {
    host.innerHTML = '<div class="empty">' + ui.esc(e.message) + '</div>';
  }
}

/* ---------------------------------------------------------------- coverage -- */

async function loadCoverage() {
  var host = ui.el('[data-coverage]');
  try {
    var r = await api.marketStats();
    var rows = r.coverage || [];
    host.innerHTML = rows.length
      ? rows.map(function (c) {
          return '<tr><td class="mono">' + ui.esc(c.tf) + '</td>'
            + '<td class="num">' + Number(c.candles).toLocaleString('en-IN') + '</td>'
            + '<td class="tiny">' + ui.esc(String(c.first_ts).slice(0, 10)) + '</td>'
            + '<td class="tiny">' + ui.esc(String(c.last_ts).slice(0, 16)) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="4" class="empty">No candles stored. Run a backfill.</td></tr>';
  } catch (_) {
    host.innerHTML = '<tr><td colspan="4" class="empty">Unavailable.</td></tr>';
  }
}

/* -------------------------------------------------------------------- glue -- */

/** Wire a set of action buttons, reloading once the action succeeds. */
function bind(sel, handler) {
  ui.els(sel).forEach(function (b) {
    b.addEventListener('click', async function () {
      ui.busy(b, true, '\u2026');
      try {
        var reload = await handler(b);
        if (reload) { await load(); return; }
        ui.busy(b, false);
      } catch (e) {
        ui.toastError(e);
        ui.busy(b, false);
      }
    });
  });
}

/**
 * Replace the page with a plain refusal.
 *
 * Returning early is not enough on its own — the caller has to stop too, because
 * every wiring step below expects the operator markup to still be in the
 * document. Wiring a listener onto a node that has just been replaced is how a
 * "not authorised" screen ends up with an uncaught TypeError on top of it.
 */
function refuse() {
  document.querySelector('main').innerHTML =
    '<div class="wrap" style="padding:var(--sp-8) 0;max-width:640px">'
    + '<div class="note-box bad"><strong>Not authorised.</strong> '
    + 'This page is for operator accounts. If it should be yours, set '
    + '<code>is_admin</code> on your row in the <code>users</code> table \u2014 see '
    + 'SETUP.md.</div>'
    + '<p style="margin-top:var(--sp-4)"><a href="dashboard.html" class="btn btn-ghost arrow">'
    + 'Back to your wallet</a></p></div>';
}

async function load() {
  try {
    st.overview = await api.admin.overview();
    paintOverview(st.overview);
  } catch (e) {
    if (e.status === 403) {
      refuse();
      return false;
    }
    ui.toastError(e);
  }

  try {
    paintRecon(await api.admin.reconcile());
  } catch (_) {}

  await Promise.all([loadDeposits(), loadWithdrawals(), loadKyc(), loadCoverage()]);
  return true;
}

(async function () {
  await ui.boot({ feed: false });
  var user = await api.requireUser();
  if (!user) return;

  // The server decides this, not the browser — but asking first means a holder who
  // wanders in sees one clear message instead of a page of 403s.
  if (!user.isAdmin) {
    refuse();
    return;
  }

  if (!(await load())) return;
  loadSettings();

  ui.el('#held').addEventListener('input', paintDiff);
  ui.on('[data-refresh]', 'click', function (e) {
    ui.busy(e.currentTarget, true, 'Refreshing\u2026');
    load().finally(function () { ui.busy(e.currentTarget, false); });
  });

  ui.els('[data-backfill]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var tf = b.dataset.backfill;
      ui.busy(b, true, 'Running\u2026');
      try {
        var r = await api.backfill(tf);
        var bf = r.backfill || {};
        ui.toast('Backfilled ' + (bf.written || 0) + ' ' + tf + ' candles from '
                 + ui.esc(bf.source || 'an exchange') + '.', 'ok', 8000);
        loadCoverage();
      } catch (e) {
        ui.toastError(e);
      } finally {
        ui.busy(b, false);
      }
    });
  });

  // Queues change when users act, so this refreshes on its own.
  api.poll(load, 30000);
})();
