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
// Search/filter state is kept here so the 30s poll — which re-runs load() —
// preserves whatever the operator last searched for rather than snapping every
// table back to its unfiltered default.
var st = {
  overview: null, recon: null,
  userQuery: '', ledgerQuery: '', orderStatus: 'open', orderQuery: ''
};

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
  // If the overview carries a live fx rate, thread it in; otherwise fmtUsd falls
  // back to CFG.FEED.fx.fallbackRate. Current price gets the muted $ companion.
  ui.setUsdInr((o.index && o.index.fxUsdInr) || p.fxUsdInr);
  ui.setHtml('[data-price]', p.nav != null ? ui.fmtDual(p.nav) : '\u2014');
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

  paintOverviewStats(q, m);
}

/**
 * The at-a-glance stat grid.
 *
 * A wider read of the same overview payload than the queue cards give. Money is
 * shown with ui.fmtPaise (integer paise, never a float) and units with
 * ui.fmtUnits. GST and TDS are labelled as liabilities, not revenue — only the
 * platform-fee line is income.
 */
function paintOverviewStats(q, m) {
  var pending = (q.deposits_pending || 0)
    + (q.withdrawals_pending || 0) + (q.withdrawals_approved || 0)
    + (q.kyc_pending || 0);

  var stats = [
    ['Active users', String(q.users_active || 0), 'currently active'],
    ['\u20b9 held for users', ui.fmtPaise(m.userInrPaise || 0), 'rupees in user wallets'],
    ['ARV outstanding', ui.fmtUnits(m.unitsOutstanding, 8) + ' ARV', 'units owed to holders'],
    ['Invested', ui.fmtPaise(m.investedPaise || 0), 'cost basis held'],
    ['Deposited', ui.fmtPaise(m.depositedPaise || 0), 'confirmed in, all time'],
    ['Paid out', ui.fmtPaise(m.paidOutPaise || 0), 'withdrawals settled'],
    ['Platform fees', ui.fmtPaise(m.feesPaise || 0), 'this is the revenue'],
    ['Referral paid', ui.fmtPaise(m.referralPaidPaise || 0), 'from your own margin'],
    ['GST collected', ui.fmtPaise(m.gstPaise || 0), 'liability, not revenue'],
    ['TDS withheld', ui.fmtPaise(m.tdsPaise || 0), 'liability, not revenue'],
    ['Open orders', String(q.orders_open || 0), 'live on the book'],
    ['Pending queues', String(pending), 'deposits, withdrawals, KYC']
  ];

  ui.setHtml('[data-overview-stats]', stats.map(function (s) {
    return '<div class="stat"><span class="stat-k">' + s[0] + '</span>'
      + '<span class="stat-v" style="font-size:1.25rem">' + s[1] + '</span>'
      + '<span class="stat-sub">' + s[2] + '</span></div>';
  }).join(''));
}

/* ---------------------------------------------------------- reconciliation -- */

function paintRecon(r) {
  st.recon = r;
  var ob = r.obligation || {};

  ui.setHtml('[data-obligation]',
    row('Units outstanding', ui.fmtUnits(ob.unitsOutstanding, 8))
    + row('ARV price', ob.nav != null ? ui.fmtDual(ob.nav) : '\u2014')
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

// Each row is [key, label, type, hint?]. The server keeps its own allow-list of
// what is writable; this list is only what the operator is shown. The two used to
// drift — google_client_id, trust_hours and login_otp_always were made writable
// on the server but never given a field here, so there was no way to turn Google
// sign-in on at all. Anything editable belongs in both places.
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
  ['maintenance_mode', 'Maintenance mode', 'bool'],

  // Sign-in.
  ['google_client_id', 'Google client ID', 'text',
   'Paste to switch Google sign-in on. Ends in .apps.googleusercontent.com. Leave blank to keep it off. This is the Client ID, not the secret — there is no secret in this flow.'],
  ['login_otp_always', 'Always email a code at login', 'bool',
   'On, and every sign-in needs a code, ignoring the trust window below.'],
  ['trust_hours', 'Trust a device for (hours)', 'number',
   'After one code, that device is not asked again for this long. 24 by default. Sign-out ends it.'],

  // Support assistant.
  ['assistant_enabled', 'Support assistant on', 'bool',
   'The floating help chat. On by default; it answers from a built-in ARV knowledge base even with no key below.'],
  ['gemini_api_key', 'Gemini API key (optional)', 'text',
   'Paste a Google Gemini API key to power the assistant with AI answers. Leave blank to use the built-in knowledge base only. Stored server-side, never shown to customers.']
];

async function loadSettings() {
  var host = ui.el('[data-settings]');
  try {
    var r = await api.admin.settings();
    var s = r.settings || {};

    host.innerHTML = EDITABLE.map(function (row) {
      var key = row[0], label = row[1], type = row[2], hint = row[3];
      var val = s[key] != null ? s[key] : '';
      var input = type === 'bool'
        ? '<select data-setting="' + key + '">'
          + '<option value="1"' + (val === '1' ? ' selected' : '') + '>on</option>'
          + '<option value="0"' + (val !== '1' ? ' selected' : '') + '>off</option></select>'
        : '<input data-setting="' + key + '" type="text" value="' + ui.esc(val) + '">';
      return '<div class="field"><label>' + ui.esc(label) + '</label>' + input
        + (hint ? '<span class="hint">' + ui.esc(hint) + '</span>' : '') + '</div>';
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

/* ------------------------------------------------------------------- users -- */

/**
 * The user directory.
 *
 * Read plus two safe toggles: suspend/activate and grant/remove operator. There
 * is deliberately no way to edit a balance here — money only ever moves through
 * the ledger, and the server refuses a self-suspend or self-demotion so an
 * operator cannot lock themselves out.
 */
async function loadUsers(search) {
  var host = ui.el('[data-users]');
  try {
    var r = await api.admin.users(search || '');
    var rows = r.users || [];
    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="9" class="empty">No users found.</td></tr>';
      return;
    }
    host.innerHTML = rows.map(function (u) {
      var status = u.status === 'active'
        ? '<span class="badge ok">active</span>'
        : '<span class="badge warn">' + ui.esc(u.status) + '</span>';
      var kyc = '<span class="badge ' + (u.kycStatus === 'verified' ? 'ok' : 'muted') + '">'
        + ui.esc(u.kycStatus) + '</span>';
      var adminBadge = u.isAdmin ? ' <span class="badge info">operator</span>' : '';
      var inr = (u.inrPaise || 0) + (u.inrLocked || 0);
      var arv = Number(u.arvUnits || 0) + Number(u.arvLocked || 0);
      return '<tr>'
        + '<td><div class="tiny">' + ui.esc(u.email) + '</div>'
          + '<div class="tiny muted">' + ui.esc(u.name || '') + adminBadge + '</div>'
          + '<div class="mono tiny muted">#' + u.id
            + (u.refCode ? ' \u00b7 ' + ui.esc(u.refCode) : '') + '</div></td>'
        + '<td>' + status + '</td>'
        + '<td>' + kyc + '</td>'
        + '<td class="num">' + ui.fmtPaise(inr) + '</td>'
        + '<td class="num tiny">' + ui.fmtUnits(arv, 4) + '</td>'
        + '<td class="num">' + ui.fmtPaise(u.investedPaise || 0) + '</td>'
        + '<td class="tiny muted">' + ui.fmtDate(u.joined) + '</td>'
        + '<td class="tiny muted">' + (u.lastLogin ? ui.fmtDate(u.lastLogin) : '\u2014') + '</td>'
        + '<td class="right nowrap">'
          + (u.status === 'active'
              ? '<button class="btn btn-sm btn-ghost" data-suspend="' + u.id + '">Suspend</button>'
              : '<button class="btn btn-sm btn-buy" data-activate="' + u.id + '">Activate</button>')
          + ' '
          + (u.isAdmin
              ? '<button class="btn btn-sm btn-ghost" data-admin-off="' + u.id + '">Remove admin</button>'
              : '<button class="btn btn-sm btn-ghost" data-admin-on="' + u.id + '">Make admin</button>')
        + '</td></tr>';
    }).join('');

    var reloadUsers = function () { return loadUsers(st.userQuery); };

    bindAction('[data-suspend]', async function (b) {
      var id = Number(b.dataset.suspend);
      if (!confirm('Suspend user #' + id + '?\n\nThey are signed out and cannot sign back in '
                 + 'until reactivated.')) return false;
      var r2 = await api.admin.setUserStatus(id, 'suspended');
      ui.toast(r2.message || 'Suspended.', 'ok');
      return true;
    }, reloadUsers);

    bindAction('[data-activate]', async function (b) {
      var r2 = await api.admin.setUserStatus(Number(b.dataset.activate), 'active');
      ui.toast(r2.message || 'Activated.', 'ok');
      return true;
    }, reloadUsers);

    bindAction('[data-admin-on]', async function (b) {
      var id = Number(b.dataset.adminOn);
      if (!confirm('Grant operator access to user #' + id + '?\n\nThey will be able to see and '
                 + 'manage everything on this page.')) return false;
      var r2 = await api.admin.setUserAdmin(id, 1);
      ui.toast(r2.message || 'Operator access granted.', 'ok');
      return true;
    }, reloadUsers);

    bindAction('[data-admin-off]', async function (b) {
      var id = Number(b.dataset.adminOff);
      if (!confirm('Remove operator access from user #' + id + '?')) return false;
      var r2 = await api.admin.setUserAdmin(id, 0);
      ui.toast(r2.message || 'Operator access removed.', 'ok');
      return true;
    }, reloadUsers);
  } catch (e) {
    host.innerHTML = '<tr><td colspan="9" class="empty">' + ui.esc(e.message) + '</td></tr>';
  }
}

/* ------------------------------------------------------------------ ledger -- */

/**
 * The book of record, read-only.
 *
 * No edit, no delete — the ledger is append-only and the database enforces it.
 * Rupee and unit deltas are shown signed from the holder's point of view.
 */
async function loadLedger(search) {
  var host = ui.el('[data-ledger]');
  try {
    var r = await api.admin.ledger(search || '');
    var rows = r.ledger || [];
    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="8" class="empty">No ledger entries.</td></tr>';
      return;
    }
    host.innerHTML = rows.map(function (l) {
      var inr = l.inrDeltaPaise
        ? '<span class="' + (l.inrDeltaPaise > 0 ? 'up' : 'down') + '">'
          + (l.inrDeltaPaise > 0 ? '+' : '\u2212') + ui.fmtPaise(Math.abs(l.inrDeltaPaise)) + '</span>'
        : '\u2014';
      var units = Number(l.arvDeltaUnits);
      var arv = units
        ? '<span class="' + (units > 0 ? 'up' : 'down') + '">'
          + (units > 0 ? '+' : '\u2212') + ui.fmtUnits(Math.abs(units), 4) + '</span>'
        : '\u2014';
      var who = l.email ? ui.esc(l.email) : (l.userId != null ? '#' + l.userId : 'system');
      return '<tr>'
        + '<td class="tiny muted nowrap">' + ui.fmtTime(l.createdAt, true) + '</td>'
        + '<td class="tiny">' + who + '</td>'
        + '<td><span class="badge">' + ui.esc(l.kind) + '</span></td>'
        + '<td class="num">' + inr + '</td>'
        + '<td class="num tiny">' + arv + '</td>'
        + '<td class="mono tiny muted">' + ui.esc(l.ref || '\u2014') + '</td>'
        + '<td class="tiny">' + ui.esc(l.note || '') + '</td>'
        + '<td class="tiny muted">' + ui.esc(l.fy || '') + '</td>'
        + '</tr>';
    }).join('');
  } catch (e) {
    host.innerHTML = '<tr><td colspan="8" class="empty">' + ui.esc(e.message) + '</td></tr>';
  }
}

/* ------------------------------------------------------------------ orders -- */

/**
 * Every order across every user.
 *
 * One editable action: cancel a still-open order. It releases only the unfilled
 * remainder, exactly as the holder's own cancel does — the balance maths lives on
 * the server and is not reinvented here.
 */
async function loadOrders(status, search) {
  var host = ui.el('[data-orders]');
  try {
    var r = await api.admin.ordersAll(status || 'open', search || '');
    var rows = r.orders || [];
    if (!rows.length) {
      host.innerHTML = '<tr><td colspan="9" class="empty">No orders.</td></tr>';
      return;
    }
    host.innerHTML = rows.map(function (o) {
      var side = '<span class="badge ' + (o.side === 'buy' ? 'ok' : 'info') + '">'
        + ui.esc(o.side) + '</span>';
      var isOpen = o.status === 'open' || o.status === 'triggered' || o.status === 'partial';
      // For a buy the size is named in rupees; for a sell, in units.
      var size = o.side === 'buy'
        ? (o.amountPaise != null ? ui.fmtPaise(o.amountPaise) : '\u2014')
        : (o.units != null ? ui.fmtUnits(o.units, 4) : '\u2014');
      return '<tr>'
        + '<td><div class="tiny">' + ui.esc(o.email) + '</div>'
          + '<div class="mono tiny muted">' + ui.esc(o.ref) + '</div></td>'
        + '<td>' + side + '</td>'
        + '<td class="tiny">' + ui.esc(o.type) + '</td>'
        + '<td class="num tiny">' + size + '</td>'
        + '<td class="num tiny">' + ui.fmtUnits(o.filledUnits, 4) + '</td>'
        + '<td><span class="badge">' + ui.esc(o.status) + '</span></td>'
        + '<td class="num tiny">' + (o.triggerNav != null ? ui.fmtPrice(o.triggerNav) : 'index') + '</td>'
        + '<td class="tiny muted nowrap">' + ui.fmtTime(o.createdAt, true) + '</td>'
        + '<td class="right nowrap">'
          + (isOpen ? '<button class="btn btn-sm btn-ghost" data-cancel-order="' + o.id + '">Cancel</button>' : '')
        + '</td></tr>';
    }).join('');

    bindAction('[data-cancel-order]', async function (b) {
      var id = Number(b.dataset.cancelOrder);
      if (!confirm('Cancel order #' + id + '?\n\nThe unfilled remainder is returned to the holder. '
                 + 'This cannot be undone.')) return false;
      var r2 = await api.admin.cancelOrder(id);
      ui.toast(r2.message || 'Order cancelled.', 'ok');
      return true;
    }, function () { return loadOrders(st.orderStatus, st.orderQuery); });
  } catch (e) {
    host.innerHTML = '<tr><td colspan="9" class="empty">' + ui.esc(e.message) + '</td></tr>';
  }
}

/* -------------------------------------------------------------------- glue -- */

/**
 * Wire action buttons that reload only their own section on success.
 *
 * Unlike bind() below — which reloads the whole page — this reloads via the
 * supplied `after` callback, so a per-row action in a searched table keeps its
 * search filter instead of snapping back to the unfiltered view.
 */
function bindAction(sel, handler, after) {
  ui.els(sel).forEach(function (b) {
    b.addEventListener('click', async function () {
      ui.busy(b, true, '\u2026');
      try {
        var reload = await handler(b);
        if (reload && after) { await after(); return; }
        ui.busy(b, false);
      } catch (e) {
        ui.toastError(e);
        ui.busy(b, false);
      }
    });
  });
}

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

  await Promise.all([
    loadDeposits(), loadWithdrawals(), loadKyc(), loadCoverage(),
    loadUsers(st.userQuery), loadLedger(st.ledgerQuery),
    loadOrders(st.orderStatus, st.orderQuery)
  ]);
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

  // Search boxes for the three big tables. Each stores its query in `st` so the
  // 30s poll re-runs the same filtered query rather than resetting the table.
  var userForm = ui.el('[data-user-form]');
  if (userForm) userForm.addEventListener('submit', function (e) {
    e.preventDefault();
    st.userQuery = (ui.el('[data-user-search]').value || '').trim();
    loadUsers(st.userQuery);
  });

  var ledgerForm = ui.el('[data-ledger-form]');
  if (ledgerForm) ledgerForm.addEventListener('submit', function (e) {
    e.preventDefault();
    st.ledgerQuery = (ui.el('[data-ledger-search]').value || '').trim();
    loadLedger(st.ledgerQuery);
  });

  var orderForm = ui.el('[data-order-form]');
  if (orderForm) orderForm.addEventListener('submit', function (e) {
    e.preventDefault();
    st.orderStatus = ui.el('[data-order-status]').value || 'open';
    st.orderQuery = (ui.el('[data-order-search]').value || '').trim();
    loadOrders(st.orderStatus, st.orderQuery);
  });

  // The status dropdown filters immediately, without needing the button.
  var orderStatus = ui.el('[data-order-status]');
  if (orderStatus) orderStatus.addEventListener('change', function () {
    st.orderStatus = orderStatus.value || 'open';
    st.orderQuery = (ui.el('[data-order-search]').value || '').trim();
    loadOrders(st.orderStatus, st.orderQuery);
  });

  // Queues change when users act, so this refreshes on its own.
  api.poll(load, 30000);
})();
