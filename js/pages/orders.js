/**
 * Orders — the P2P order and trade surface.
 *
 * This used to be two lists crammed under the trade form. It is its own page
 * now, because everything on it is on a clock: a resting order expires, a
 * matched buyer has minutes to pay, and a seller then has hours to confirm
 * before the trade goes to support. A cluttered corner of another page is the
 * wrong place for anything that costs money when it is missed.
 *
 * Structure, top to bottom: what needs doing right now, then open orders (buy
 * then sell), then live trades, then a collapsed history. Each card carries the
 * whole interaction — a buyer never leaves the card to find where to pay, and a
 * seller never leaves it to release.
 *
 * The rendering logic here is the trade page's old paintTrades/paintOrders code,
 * moved and reworked into colour-coded cards; p2p.js no longer carries it.
 *
 * Every state change goes through the api.p2p.* helpers, which post CSRF and
 * shape errors. The server re-checks ownership, status and money on each one, so
 * nothing here is trusted to be a permission check — the canUploadProof /
 * canConfirm / canCancel flags only decide what is worth drawing.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';

var st = {
  user: null,
  nav: null,       // live index price, from api.p2p.mine()
  trades: [],
  orders: [],
  loaded: false
};

/* --------------------------------------------------------------- time ----- */

/**
 * Parse a server timestamp as UTC.
 *
 * Two shapes arrive: the deadline fields are ISO-8601 with a trailing Z
 * (payDeadline, confirmDeadline, expiresAt), and the raw MySQL timestamps
 * (createdAt, matchedAt, paidAt) are 'YYYY-MM-DD HH:MM:SS' written with
 * UTC_TIMESTAMP(). The second shape has no zone, so it must be told it is UTC or
 * every countdown is wrong by the viewer's offset.
 */
function parseUtc(s) {
  if (!s) return NaN;
  var str = String(s);
  if (/(Z|[+-]\d\d:?\d\d)$/.test(str)) return Date.parse(str);
  return Date.parse(str.replace(' ', 'T') + 'Z');
}

/** Remaining time as words: "21h 14m", "42m 07s", "9s", or "overdue". */
function cdText(ms) {
  if (!isFinite(ms)) return '\u2014';
  if (ms <= 0) return 'overdue';
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + (sec < 10 ? '0' : '') + sec + 's';
  return sec + 's';
}

/**
 * A countdown placeholder.
 *
 * `deadline` is the instant the server will act; `from` is when the window
 * opened, which is what makes "25% left" mean anything — the windows differ by
 * an order of magnitude (24h for an order, 60min to pay, 4h to confirm), so a
 * fixed "amber under 10 minutes" would be wrong for at least one of them.
 * tick() fills these in; nothing else re-renders them.
 */
function cd(deadline, from) {
  if (!deadline) return '';
  return '<span class="cd" data-cd="' + ui.esc(deadline) + '"'
    + (from ? ' data-cd-from="' + ui.esc(from) + '"' : '') + '>\u2026</span>';
}

/**
 * Update every countdown on screen, in place.
 *
 * In place, and every second, deliberately: re-rendering the cards on a timer
 * would wipe a half-typed UTR or a file the buyer had just chosen from their
 * gallery. So the seconds tick here and the data poll (20s) rebuilds the markup.
 *
 * Colour escalates against the fraction of the window left rather than an
 * absolute number of minutes: normal, amber under 25%, red under 10% or once the
 * deadline has passed.
 */
function tick() {
  ui.els('[data-cd]').forEach(function (n) {
    var end = parseUtc(n.getAttribute('data-cd'));
    if (!isFinite(end)) { n.textContent = '\u2014'; return; }

    var left = end - Date.now();
    n.textContent = cdText(left);

    var from = parseUtc(n.getAttribute('data-cd-from'));
    var total = isFinite(from) ? end - from : NaN;
    var frac = (isFinite(total) && total > 0) ? left / total : null;

    n.classList.remove('cd-warn', 'cd-late');
    if (left <= 0 || (frac !== null && frac < 0.10)) n.classList.add('cd-late');
    else if (frac !== null && frac < 0.25) n.classList.add('cd-warn');
  });
}

/* -------------------------------------------------------------- helpers --- */

function statusBadge(status) {
  var map = {
    matched: 'warn', paid: 'metal', released: 'ok',
    cancelled: '', disputed: 'bad', expired: ''
  };
  return '<span class="badge ' + (map[status] || '') + '">' + ui.esc(status) + '</span>';
}

/** The ₹ value of a unit quantity at the live index price, or an em-dash. */
function valueAt(units, nav) {
  var u = parseFloat(units);
  if (!isFinite(u) || u <= 0 || nav == null || !isFinite(nav)) return null;
  return ui.fmtPaise(Math.floor(u * nav * 100));
}

/** A copyable field. The value is carried in an attribute, escaped like any other. */
function copyRow(label, value, copyText) {
  if (value == null || value === '') return '';
  var raw = copyText != null ? copyText : value;
  return '<div class="copy-row">'
    +    '<span class="k">' + ui.esc(label) + '</span>'
    +    '<span class="v">' + ui.esc(value) + '</span>'
    +    '<button type="button" class="btn btn-sm btn-ghost" data-copy="' + ui.esc(raw) + '">Copy</button>'
    +  '</div>';
}

/**
 * Where the buyer sends the money, every field individually copyable, plus the
 * exact amount.
 *
 * Typing a UPI ID and an amount by hand on a phone is where this flow loses
 * people (and a wrong amount is a dispute), so the amount copies as a bare
 * decimal — '1234.56' — which is what a UPI app's amount box wants.
 */
function payBlock(t) {
  var p = t.sellerPayment;
  var amount = ((t.amountPaise || 0) / 100).toFixed(2);

  var head = '<div class="tiny muted" style="margin-top:var(--sp-3)">'
    + 'Pay the seller directly \u2014 the platform never touches this money.</div>';

  var rows = '';
  if (!p) {
    rows = '<div class="note-box bad tiny" style="margin-top:8px">'
      + 'The seller\u2019s payment details are unavailable. Do not pay \u2014 contact support '
      + 'before this window runs out.</div>';
  } else if (p.type === 'upi') {
    rows = copyRow('UPI ID', p.upiVpa)
      + copyRow('Name', p.accountName);
  } else {
    rows = copyRow('Account name', p.accountName)
      + copyRow('Account number', p.bankAccountNo)
      + copyRow('IFSC', p.bankIfsc);
  }

  return head
    + '<div style="margin-top:6px">'
    +   rows
    +   copyRow('Amount to pay', ui.fmtPaise(t.amountPaise), amount)
    + '</div>';
}

/** The inline proof form, on the card, so paying and proving are one action. */
function proofForm(t) {
  return '<div class="stack" style="margin-top:var(--sp-3);gap:8px" data-proof="' + t.id + '">'
    +    '<div class="field">'
    +      '<label for="utr' + t.id + '">UTR / reference number</label>'
    +      '<input id="utr' + t.id + '" class="num-input" type="text" autocomplete="off"'
    +        ' placeholder="From your UPI or bank app" data-proof-utr>'
    +    '</div>'
    +    '<div class="field">'
    +      '<label for="shot' + t.id + '">Screenshot (optional)</label>'
    +      '<input id="shot' + t.id + '" type="file" accept="image/*" data-proof-file>'
    +    '</div>'
    +    '<div class="row row-wrap" style="gap:8px">'
    +      '<button type="button" class="btn btn-primary btn-sm" data-proof-submit="' + t.id + '">'
    +        'I\u2019ve paid \u2014 submit proof</button>'
    +      (t.canCancel
          ? '<button type="button" class="btn btn-sm btn-ghost" data-cancel-trade="' + t.id + '">Cancel trade</button>'
          : '')
    +    '</div>'
    +    '<div class="tiny muted">Either the UTR or a screenshot is enough; both is better '
    +      'if the seller ever disputes it.</div>'
    +  '</div>';
}

/* ---------------------------------------------------------- order cards --- */

/**
 * One resting P2P order.
 *
 * Colour is the side: a buy is green, a sell is red, on the left rail and as the
 * side word. The countdown runs to expiresAt, which the server derives from the
 * same p2p_match_ttl_hours setting the maintenance cron sweeps on, so the number
 * on screen is the instant the order really dies.
 */
function orderCard(o) {
  var isBuy = o.side === 'buy';
  var worth = valueAt(o.units, st.nav);

  var units = parseFloat(o.units);
  var matchable = parseFloat(o.matchableUnits);
  var partial = isFinite(units) && isFinite(matchable) && matchable > 0 && matchable < units;

  var h = '<div class="ocard ' + (isBuy ? 'ocard-buy' : 'ocard-sell') + '" id="order-' + o.id + '">'
    + '<div class="row-between row-wrap" style="align-items:flex-start;gap:var(--sp-3)">'
    +   '<div style="min-width:0">'
    +     '<div class="row" style="gap:8px">'
    +       '<span class="ocard-side">' + (isBuy ? 'Buy' : 'Sell') + '</span>'
    +       '<span class="badge">' + ui.esc(o.type) + '</span>'
    +       (o.status !== 'open' ? statusBadge(o.status) : '')
    +     '</div>'
    +     '<div class="num strong" style="margin-top:6px">' + ui.fmtUnits(o.units, 4) + ' ARV</div>'
    +     '<div class="tiny muted">'
    +       (worth ? 'about ' + worth + ' at ' + ui.fmtPrice(st.nav) + ' per ARV'
                  : 'value follows the live index price')
    +     '</div>'
    +   '</div>'
    +   '<div style="text-align:right">'
    +     '<div class="tiny muted">' + ui.esc(o.ref || '') + '</div>'
    +     (o.expiresAt
          ? '<div class="tiny" style="margin-top:4px">expires in '
            + cd(o.expiresAt, o.createdAt) + '</div>'
          : '')
    +     '<div class="tiny muted" style="margin-top:2px">placed ' + ui.fmtDate(o.createdAt) + '</div>'
    +   '</div>'
    + '</div>';

  if (partial) {
    h += '<div class="tiny" style="margin-top:8px">Partly matched \u2014 '
      + '<strong>' + ui.fmtUnits(o.matchableUnits, 4) + ' ARV</strong> of '
      + ui.fmtUnits(o.units, 4) + ' ARV is still looking for a counterparty.</div>';
  }

  if (o.triggerNav != null && o.type !== 'market') {
    h += '<div class="tiny muted" style="margin-top:6px">Triggers when ARV reaches '
      + ui.fmtPrice(o.triggerNav) + '.</div>';
  }

  h += '<div class="row" style="margin-top:var(--sp-3)">'
    +    '<button type="button" class="btn btn-sm btn-ghost" data-cancel-order="' + o.id + '">'
    +      'Cancel order</button>'
    +  '</div>'
    + '</div>';

  return h;
}

/* ---------------------------------------------------------- trade cards --- */

/**
 * One live trade, with the whole interaction on it.
 *
 * Colour follows what this viewer is doing, not what the counterparty is: a
 * buyer's card is green (they are buying), a seller's is red.
 */
function tradeCard(t) {
  var isBuyer = t.role === 'buyer';
  var payLeft = cd(t.payDeadline, t.matchedAt);
  var confirmLeft = cd(t.confirmDeadline, t.paidAt);

  var h = '<div class="ocard ' + (isBuyer ? 'ocard-buy' : 'ocard-sell') + '" id="trade-' + t.id + '">'
    + '<div class="row-between row-wrap" style="align-items:flex-start;gap:var(--sp-3)">'
    +   '<div style="min-width:0">'
    +     '<div class="row" style="gap:8px">'
    +       '<span class="ocard-side">' + (isBuyer ? 'Buying' : 'Selling') + '</span>'
    +       statusBadge(t.status)
    +     '</div>'
    +     '<div class="num strong" style="margin-top:6px">' + ui.fmtUnits(t.units, 4) + ' ARV</div>'
    +     '<div class="tiny muted">with ' + ui.esc(t.counterparty || '\u2014')
    +       ' \u00b7 at ' + ui.fmtPrice(t.priceNav) + ' per ARV</div>'
    +   '</div>'
    +   '<div style="text-align:right">'
    +     '<div class="tiny muted">' + (isBuyer ? 'you pay' : 'you receive') + '</div>'
    +     '<div class="num strong">' + ui.fmtPaise(t.amountPaise) + '</div>'
    +     '<div class="tiny muted">' + ui.esc(t.ref || '') + '</div>'
    +   '</div>'
    + '</div>';

  /* -- buyer, matched: pay, then prove it. */
  if (isBuyer && t.status === 'matched') {
    h += '<div class="note-box warn tiny" style="margin-top:var(--sp-3)">'
      +    '<strong>Pay the seller and upload proof</strong>'
      +    (t.payDeadline ? ' \u2014 ' + payLeft + ' left' : '')
      +    '. If the window closes the trade is cancelled and the ARV goes back to '
      +    'the seller.'
      +  '</div>'
      + payBlock(t)
      + (t.canUploadProof ? proofForm(t) : '');

  /* -- seller, matched: nothing to do but wait (or cancel). */
  } else if (!isBuyer && t.status === 'matched') {
    h += '<div class="tiny muted" style="margin-top:var(--sp-3)">'
      +    'Waiting for the buyer to pay you and upload proof'
      +    (t.payDeadline ? ' \u2014 ' + payLeft + ' left' : '')
      +    '. Your ARV is in escrow until then; if they never pay it returns to you '
      +    'automatically.'
      +  '</div>';

  /* -- seller, paid: check the bank, then release. */
  } else if (!isBuyer && t.status === 'paid') {
    h += '<div class="tiny" style="margin-top:var(--sp-3)">The buyer says they have paid'
      +    (t.proofUtr ? ' \u00b7 UTR <strong>' + ui.esc(t.proofUtr) + '</strong>' : '')
      +    (t.hasProofImage ? ' \u00b7 screenshot attached' : ' \u00b7 no screenshot attached')
      +  '.</div>'
      + '<div class="note-box warn tiny" style="margin-top:8px">'
      +    'Check your own account first. Confirming releases the ARV and cannot be '
      +    'undone.'
      +    (t.confirmDeadline
            ? ' Confirm within ' + confirmLeft + ' or this goes to support to settle.'
            : '')
      +  '</div>'
      + (t.canConfirm
          ? '<div class="row" style="margin-top:var(--sp-3)">'
            + '<button type="button" class="btn btn-primary btn-sm" data-confirm="' + t.id + '">'
            +   'Confirm received &amp; release</button>'
            + '</div>'
          : '');

  /* -- buyer, paid: the seller's move. */
  } else if (isBuyer && t.status === 'paid') {
    h += '<div class="tiny muted" style="margin-top:var(--sp-3)">'
      +    'Proof submitted'
      +    (t.proofUtr ? ' (UTR ' + ui.esc(t.proofUtr) + ')' : '')
      +    '. Waiting for the seller to confirm they received the money'
      +    (t.confirmDeadline ? ' \u2014 ' + confirmLeft + ' left' : '')
      +    '. If they do not, support settles it using your proof.'
      +  '</div>';

  /* -- disputed: operator-only. Neither party can act, so say so plainly. */
  } else if (t.status === 'disputed') {
    h += '<div class="note-box bad tiny" style="margin-top:var(--sp-3)">'
      +    '<strong>With support.</strong> '
      +    (isBuyer
            ? 'Your payment proof is being checked. Support either releases the ARV to '
            + 'you or cancels the trade \u2014 there is nothing to do here in the meantime.'
            : 'The buyer says they paid but this was not confirmed in time. Support will '
            + 'check the proof and settle it; neither side can act on it now.')
      +  '</div>';
  }

  // Cancel is drawn only where the server would allow it, and never twice — the
  // buyer's matched card already carries one inside the proof form.
  if (t.canCancel && !(isBuyer && t.status === 'matched' && t.canUploadProof)) {
    h += '<div class="row" style="margin-top:var(--sp-3)">'
      +    '<button type="button" class="btn btn-sm btn-ghost" data-cancel-trade="' + t.id + '">'
      +      'Cancel trade</button>'
      +  '</div>';
  }

  return h + '</div>';
}

/* -------------------------------------------------------------- history --- */

/**
 * A settled trade, one compact row rather than a card.
 *
 * A released buy still shows the fee/TDS split, because that is the one number a
 * buyer cannot reconstruct: the platform fee and TDS come out of the ARV, not the
 * rupees, so "I paid for 1 ARV and hold 0.994" needs explaining after the fact.
 */
function historyRow(t) {
  var when = t.releasedAt || t.cancelledAt || t.createdAt;
  var h = '<div class="orow">'
    + '<div style="min-width:0">'
    +   '<div class="tiny">'
    +     '<span class="' + (t.role === 'buyer' ? 'up' : 'down') + '">'
    +       (t.role === 'buyer' ? 'Bought' : 'Sold') + '</span> '
    +     ui.fmtUnits(t.units, 4) + ' ARV \u00b7 ' + ui.fmtPaise(t.amountPaise)
    +   '</div>'
    +   '<div class="tiny muted">' + ui.fmtDate(when) + ' \u00b7 with '
    +     ui.esc(t.counterparty || '\u2014') + ' \u00b7 ' + ui.esc(t.ref || '') + '</div>';

  if (t.role === 'buyer' && t.status === 'released'
      && (parseFloat(t.feeUnits) > 0 || parseFloat(t.tdsUnits) > 0)) {
    h += '<div class="tiny muted">Platform fee ' + ui.fmtUnits(t.feeUnits, 4) + ' ARV'
      + (parseFloat(t.tdsUnits) > 0 ? ' \u00b7 TDS ' + ui.fmtUnits(t.tdsUnits, 4) + ' ARV' : '')
      + ' \u00b7 you received <strong>' + ui.fmtUnits(t.netUnits, 4) + ' ARV</strong>.</div>';
  }

  if (t.status === 'expired') {
    h += '<div class="tiny muted">'
      + (t.role === 'seller'
          ? 'The buyer did not pay in time; the escrowed ARV came back to you.'
          : 'Payment was not made in time, so the ARV went back to the seller.')
      + '</div>';
  }

  if (t.resolution) {
    h += '<div class="tiny muted">Settled by support: ' + ui.esc(t.resolution) + '.</div>';
  }

  return h + '</div><span>' + statusBadge(t.status) + '</span></div>';
}

/* ------------------------------------------------------- needs-action ----- */

function needsAction(t) {
  return !!(t && (t.canUploadProof || t.canConfirm));
}

function needsStrip(live) {
  var host = ui.el('[data-needs]');
  if (!host) return;

  var rows = live.filter(needsAction);
  if (!rows.length) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  host.classList.remove('hidden');
  host.innerHTML = '<div class="note-box warn">'
    + '<strong>Needs your action'
    + (rows.length > 1 ? ' (' + rows.length + ')' : '') + '</strong>'
    + '<div style="margin-top:var(--sp-3)">'
    + rows.map(function (t) {
        var isBuyer = t.role === 'buyer';
        var what = isBuyer
          ? 'Pay ' + ui.fmtPaise(t.amountPaise) + ' for ' + ui.fmtUnits(t.units, 4)
            + ' ARV and upload proof'
          : 'Confirm you received ' + ui.fmtPaise(t.amountPaise) + ' for '
            + ui.fmtUnits(t.units, 4) + ' ARV';
        var left = isBuyer
          ? cd(t.payDeadline, t.matchedAt)
          : cd(t.confirmDeadline, t.paidAt);
        return '<div class="ostrip-item row-between row-wrap" style="gap:var(--sp-3)">'
          +      '<span class="tiny" style="min-width:0">' + what
          +        ' \u00b7 with ' + ui.esc(t.counterparty || '\u2014')
          +        (left ? ' \u00b7 ' + left + ' left' : '') + '</span>'
          +      '<a class="btn btn-sm arrow" href="#trade-' + t.id + '">Open</a>'
          +    '</div>';
      }).join('')
    + '</div></div>';
}

/* -------------------------------------------------------------- render ---- */

/** Is the user part-way through a proof, so a rebuild would throw work away? */
function hasDraft() {
  var typing = ui.els('[data-proof-utr]').some(function (e) {
    return e.value && e.value.trim() !== '';
  });
  if (typing) return true;
  return ui.els('[data-proof-file]').some(function (e) {
    return e.files && e.files.length > 0;
  });
}

function render() {
  var boot = ui.el('[data-boot]');
  if (boot) boot.classList.add('hidden');

  var trades = st.trades || [];
  var orders = st.orders || [];

  // 'disputed' is live — it still has a resolution coming — so it sits with the
  // active trades. 'expired' joins released/cancelled in the history.
  var live = trades.filter(function (t) {
    return t.status === 'matched' || t.status === 'paid' || t.status === 'disputed';
  });
  var past = trades.filter(function (t) {
    return t.status === 'released' || t.status === 'cancelled' || t.status === 'expired';
  });

  needsStrip(live);

  /* -- open orders, buys first, then sells. */
  var buys = orders.filter(function (o) { return o.side === 'buy'; });
  var sells = orders.filter(function (o) { return o.side === 'sell'; });
  var openSec = ui.el('[data-open-sec]');
  var openHost = ui.el('[data-open]');
  if (openHost && openSec) {
    openSec.classList.toggle('hidden', orders.length === 0);
    ui.setText('[data-open-count]', String(orders.length));
    var oh = '';
    if (buys.length) {
      oh += '<div class="tiny muted" style="margin:var(--sp-2) 0 var(--sp-2)">Buying</div>'
        + buys.map(orderCard).join('');
    }
    if (sells.length) {
      oh += '<div class="tiny muted" style="margin:var(--sp-4) 0 var(--sp-2)">Selling</div>'
        + sells.map(orderCard).join('');
    }
    openHost.innerHTML = oh;
  }

  /* -- live trades. */
  var activeSec = ui.el('[data-active-sec]');
  var activeHost = ui.el('[data-active]');
  if (activeHost && activeSec) {
    activeSec.classList.toggle('hidden', live.length === 0);
    ui.setText('[data-active-count]', String(live.length));
    activeHost.innerHTML = '<div style="padding-top:var(--sp-2)">'
      + live.map(tradeCard).join('') + '</div>';
  }

  /* -- history. */
  var histSec = ui.el('[data-history-sec]');
  var histHost = ui.el('[data-history]');
  if (histHost && histSec) {
    histSec.classList.toggle('hidden', past.length === 0);
    ui.setText('[data-history-count]', String(past.length));
    histHost.innerHTML = past.map(historyRow).join('');
  }

  /* -- nothing at all. */
  var empty = ui.el('[data-empty]');
  if (empty) empty.classList.toggle('hidden', !(orders.length === 0 && trades.length === 0));

  bind();
  tick();

  // Keep the nav dot honest while this page is open, in both directions.
  ui.setOrdersAlert(live.filter(needsAction).length);
}

/* -------------------------------------------------------------- actions --- */

function copyText(text, btn) {
  var done = function () {
    ui.toast('Copied.', 'ok', 1800);
    if (btn) {
      var was = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = was; }, 1500);
    }
  };
  // execCommand is deprecated but is still the only path on plain HTTP or in an
  // older browser, where navigator.clipboard is undefined.
  var fallback = function () {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch (_) {
      ui.toast('Could not copy \u2014 select it and copy manually.', 'warn');
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, fallback);
  } else {
    fallback();
  }
}

function bind() {
  ui.els('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      copyText(b.getAttribute('data-copy') || '', b);
    });
  });

  ui.els('[data-proof-submit]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = Number(b.getAttribute('data-proof-submit'));
      var wrap = ui.el('[data-proof="' + id + '"]');
      var utrEl = wrap ? ui.el('[data-proof-utr]', wrap) : null;
      var fileEl = wrap ? ui.el('[data-proof-file]', wrap) : null;
      var utr = utrEl ? (utrEl.value || '').trim() : '';
      var file = fileEl && fileEl.files && fileEl.files[0] ? fileEl.files[0] : null;

      if (!utr && !file) {
        ui.toast('Enter the UTR of your payment, or attach a screenshot.', 'warn');
        return;
      }

      ui.busy(b, true, 'Submitting\u2026');
      try {
        var r = await api.p2p.proof(id, utr, file);
        // Clear the draft BEFORE refreshing, or the hasDraft() guard would see
        // the submitted values and skip the re-render that shows the new state.
        if (utrEl) utrEl.value = '';
        if (fileEl) fileEl.value = '';
        ui.toast(ui.esc(r.message || 'Proof submitted.'), 'ok', 6000);
        await load();
      } catch (e) {
        ui.toastError(e);
        ui.busy(b, false);
      }
    });
  });

  ui.els('[data-confirm]').forEach(function (b) {
    b.addEventListener('click', async function () {
      if (!confirm('Confirm you have received the payment? This releases the ARV to the buyer and cannot be undone.')) return;
      ui.busy(b, true, 'Releasing\u2026');
      try {
        var r = await api.p2p.confirm(Number(b.getAttribute('data-confirm')));
        ui.toast(ui.esc(r.message || 'Released.'), 'ok', 6000);
        await load();
      } catch (e) {
        ui.toastError(e);
        ui.busy(b, false);
      }
    });
  });

  ui.els('[data-cancel-trade]').forEach(function (b) {
    b.addEventListener('click', async function () {
      if (!confirm('Cancel this trade? The escrowed ARV returns to the seller.')) return;
      ui.busy(b, true, '\u2026');
      try {
        var r = await api.p2p.cancelTrade(Number(b.getAttribute('data-cancel-trade')), '');
        ui.toast(ui.esc(r.message || 'Cancelled.'), 'ok');
        await load();
      } catch (e) {
        ui.toastError(e);
        ui.busy(b, false);
      }
    });
  });

  ui.els('[data-cancel-order]').forEach(function (b) {
    b.addEventListener('click', async function () {
      if (!confirm('Cancel this order? Anything already matched into a trade is unaffected.')) return;
      ui.busy(b, true, '\u2026');
      try {
        var r = await api.p2p.cancelOrder(Number(b.getAttribute('data-cancel-order')));
        ui.toast(ui.esc(r.message || 'Cancelled.'), 'ok');
        await load();
      } catch (e) {
        ui.toastError(e);
        ui.busy(b, false);
      }
    });
  });
}

/* --------------------------------------------------------------- loading -- */

/**
 * Refresh the data and repaint.
 *
 * The repaint is skipped while a proof is part-way through being filled in — the
 * poll runs every 20 seconds and rebuilding the markup underneath someone would
 * discard a chosen file or a half-typed UTR. The countdowns keep ticking either
 * way, because they are updated in place and never re-rendered.
 */
async function load() {
  var r;
  try {
    r = await api.p2p.mine();
  } catch (e) {
    if (!st.loaded) {
      var boot = ui.el('[data-boot]');
      if (boot) {
        boot.classList.remove('hidden');
        boot.innerHTML = '<div class="empty tiny">Could not load your orders. '
          + 'This page retries every 20 seconds.</div>';
      }
    }
    return;
  }

  st.trades = r.trades || [];
  st.orders = r.orders || [];
  if (r.nav != null) st.nav = r.nav;
  st.loaded = true;

  if (hasDraft()) {
    // Still keep the dot and the timers current; just leave the DOM alone.
    ui.setOrdersAlert(st.trades.filter(needsAction).length);
    tick();
    return;
  }
  render();
}

/* ------------------------------------------------------------------ boot -- */

(async function () {
  await ui.boot({ feed: false });

  var user = await api.requireUser();
  if (!user) return;
  st.user = user;

  // One shared interval for every countdown on the page, updating text in place.
  setInterval(tick, 1000);

  // api.poll runs immediately, then every 20s, and pauses while the tab is hidden.
  api.poll(load, 20000);
})();
