/**
 * Peer-to-peer (P2P) panel on the trade page.
 *
 * This is a self-contained module that drives the [data-p2p] section: placing a
 * P2P buy or sell, and the "My P2P trades" surface where a buyer pays and
 * uploads proof and a seller confirms receipt.
 *
 * It deliberately does NOT call ui.boot() — trade.js already mounts the nav,
 * footer and feed for this page. This module only owns its own section, reads
 * the price from the P2P offers endpoint, and leaves the rest of the page alone.
 * Every state-changing call goes through the api.p2p.* helpers, which post CSRF
 * and shape errors; the server re-checks ownership and money on each one.
 */

import * as ui from '../ui.js';
import * as api from '../api.js';

var st = {
  side: 'buy',
  otype: 'market',
  nav: null,
  user: null,
  // Phase 2b: platform fee + TDS (in ARV) the buyer pays on release, from the
  // offers endpoint, plus whether the treasury can supply liquidity.
  fee: null,
  treasuryAvailable: false,
  // Where this seller receives rupees. Loaded lazily the first time the sell
  // side is opened, then kept in sync as methods are added or removed.
  methods: null,
  payKind: 'upi',
  payOpen: false
};

/* --------------------------------------------------------------- helpers -- */

function root() { return ui.el('[data-p2p]'); }

function estimatePaise(units) {
  var u = parseFloat(units);
  if (!isFinite(u) || u <= 0 || st.nav == null) return null;
  // Mirror the server's u8_to_paise flooring closely enough for a hint.
  return Math.floor(u * st.nav * 100);
}

function paintEstimate() {
  var host = ui.el('[data-p2p-est]');
  if (!host) return;
  var units = (ui.el('#p2pUnits').value || '').replace(/[^\d.]/g, '');
  var paise = estimatePaise(units);
  if (paise == null) {
    host.textContent = st.nav != null
      ? 'Settles at the live index price, ' + ui.fmtPrice(st.nav) + ' per ARV.'
      : '';
    return;
  }
  var line = (st.side === 'buy' ? 'You pay the seller about ' : 'You receive about ')
    + '<strong>' + ui.fmtPaise(paise) + '</strong> at ' + ui.fmtPrice(st.nav) + ' per ARV.';

  // On a buy, the platform fee + TDS come out of the ARV you receive (never your
  // rupees), so surface it up front. Uses the live pct from the offers endpoint.
  if (st.side === 'buy' && st.fee && st.fee.collected && st.fee.totalPct > 0) {
    var u = parseFloat(units);
    var net = u * (1 - st.fee.totalPct / 100);
    line += '<br><span class="tiny muted">Platform fee ' + st.fee.feePct + '%'
      + (st.fee.tdsPct > 0 ? ' + TDS ' + st.fee.tdsPct + '%' : '')
      + ' is deducted in ARV \u2014 you receive about <strong>' + ui.fmtUnits(net, 4)
      + ' ARV</strong>.</span>';
  }
  host.innerHTML = line;
}

/* -------------------------------------------------- seller payment method -- */

function methodLine(m) {
  if (m.type === 'upi') return 'UPI · ' + ui.esc(m.upiVpa);
  var tail = String(m.bankAccountNo || '');
  tail = tail.length > 4 ? '\u2022\u2022\u2022\u2022' + tail.slice(-4) : tail;
  return 'Bank · ' + ui.esc(m.accountName || '') + ' · ' + ui.esc(tail)
    + ' · ' + ui.esc(m.bankIfsc || '');
}

/**
 * The sell-side payment block. Three states, in order of what the seller needs:
 * none saved (an add form, open, explaining the sell is blocked without one),
 * some saved (the list, with the default marked and a collapsed add form), and
 * the add form itself. Kept in this panel so a seller never has to leave the
 * trade page to become able to sell.
 */
function paintPayBlock() {
  var host = ui.el('[data-p2p-pay]');
  if (!host) return;

  if (st.side !== 'sell') {                 // buyers pay out, they receive nothing
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }
  host.classList.remove('hidden');

  if (st.methods == null) {                 // still loading
    host.innerHTML = '<div class="tiny muted">Loading your payment details\u2026</div>';
    return;
  }

  var has = st.methods.length > 0;
  var open = st.payOpen || !has;             // with none saved the form is always open
  var isUpi = st.payKind === 'upi';
  var h = '';

  h += '<div class="row-between small" style="margin-bottom:var(--sp-2)">'
    +    '<strong>Where you get paid</strong>'
    +    (has ? '<button type="button" class="btn btn-sm" data-p2p-pay-toggle>'
                 + (open ? 'Close' : 'Add another') + '</button>' : '')
    +  '</div>';

  if (!has) {
    h += '<div class="note-box bad tiny" style="margin-bottom:var(--sp-3)">'
      +    'Add a UPI ID or bank account first \u2014 a P2P buyer pays you directly, '
      +    'so a sell cannot be listed without it.'
      +  '</div>';
  }

  if (has) {
    h += '<div style="margin-bottom:var(--sp-3)">' + st.methods.map(function (m) {
      return '<div class="row-between tiny" style="padding:6px 0;border-bottom:1px solid var(--line)">'
        +      '<span>' + methodLine(m)
        +        (m.isDefault ? ' <span class="badge">default</span>' : '') + '</span>'
        +      '<span>'
        +        (m.isDefault ? '' : '<button type="button" class="btn btn-sm" data-p2p-pay-default="' + m.id + '">Use</button> ')
        +        '<button type="button" class="btn btn-sm" data-p2p-pay-del="' + m.id + '">Remove</button>'
        +      '</span>'
        +    '</div>';
    }).join('') + '</div>';
    h += '<div class="tiny muted" style="margin-bottom:var(--sp-3)">'
      +    'The one marked <strong>default</strong> is what a buyer sees when your sell matches.'
      +  '</div>';
  }

  if (open) {
    h += '<div class="tabs" data-p2p-pay-kind style="margin-bottom:var(--sp-3);width:100%">'
      +    '<button type="button" class="tab' + (isUpi ? ' on' : '') + '" data-kind="upi" style="flex:1">UPI</button>'
      +    '<button type="button" class="tab' + (isUpi ? '' : ' on') + '" data-kind="bank" style="flex:1">Bank</button>'
      +  '</div>';

    if (isUpi) {
      h += '<div class="field" style="margin-bottom:var(--sp-3)">'
        +    '<label for="p2pVpa">UPI ID</label>'
        +    '<input id="p2pVpa" type="text" autocomplete="off" placeholder="yourname@okhdfc">'
        +    '<span class="hint">Looks like yourname@okhdfc or 9876543210@paytm.</span>'
        +  '</div>';
    } else {
      h += '<div class="field" style="margin-bottom:var(--sp-3)">'
        +    '<label for="p2pAccName">Account holder name</label>'
        +    '<input id="p2pAccName" type="text" autocomplete="off" placeholder="As printed in your bank">'
        +  '</div>'
        +  '<div class="field" style="margin-bottom:var(--sp-3)">'
        +    '<label for="p2pAccNo">Account number</label>'
        +    '<input id="p2pAccNo" type="text" inputmode="numeric" autocomplete="off" placeholder="6 to 20 digits">'
        +  '</div>'
        +  '<div class="field" style="margin-bottom:var(--sp-3)">'
        +    '<label for="p2pIfsc">IFSC</label>'
        +    '<input id="p2pIfsc" type="text" autocomplete="off" placeholder="HDFC0001234">'
        +  '</div>';
    }

    h += '<button type="button" class="btn btn-block" data-p2p-pay-save>Save payment method</button>';
  }

  host.innerHTML = h;
  bindPayActions();
}

function bindPayActions() {
  ui.on('[data-p2p-pay-toggle]', 'click', function () {
    st.payOpen = !st.payOpen;
    paintPayBlock();
  });

  ui.els('[data-p2p-pay-kind] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      st.payKind = b.dataset.kind;
      paintPayBlock();
    });
  });

  ui.on('[data-p2p-pay-save]', 'click', async function () {
    var btn = ui.el('[data-p2p-pay-save]');
    var body = { type: st.payKind };

    if (st.payKind === 'upi') {
      body.upiVpa = (ui.el('#p2pVpa').value || '').trim();
      if (!body.upiVpa) return ui.toastError('Enter your UPI ID.');
    } else {
      body.accountName   = (ui.el('#p2pAccName').value || '').trim();
      body.bankAccountNo = (ui.el('#p2pAccNo').value || '').replace(/\s+/g, '');
      body.bankIfsc      = (ui.el('#p2pIfsc').value || '').trim().toUpperCase();
      if (!body.accountName || !body.bankAccountNo || !body.bankIfsc) {
        return ui.toastError('Fill the name, account number and IFSC.');
      }
    }

    ui.busy(btn, true, 'Saving\u2026');
    try {
      await api.paymentMethods.add(body);
      st.payOpen = false;
      await loadMethods();
      ui.toast('Payment method saved. You can list a sell now.');
    } catch (e) {
      ui.toastError(e);
    } finally {
      ui.busy(btn, false);
    }
  });

  ui.els('[data-p2p-pay-default]').forEach(function (b) {
    b.addEventListener('click', async function () {
      try {
        await api.paymentMethods.setDefault(Number(b.getAttribute('data-p2p-pay-default')));
        await loadMethods();
      } catch (e) { ui.toastError(e); }
    });
  });

  ui.els('[data-p2p-pay-del]').forEach(function (b) {
    b.addEventListener('click', async function () {
      if (!confirm('Remove this payment method? Trades already in flight keep the details they were matched with.')) return;
      try {
        await api.paymentMethods.remove(Number(b.getAttribute('data-p2p-pay-del')));
        await loadMethods();
      } catch (e) { ui.toastError(e); }
    });
  });
}

async function loadMethods() {
  try {
    var r = await api.paymentMethods.list();
    st.methods = r.methods || [];
  } catch (_) {
    st.methods = [];       // render the add form rather than a dead block
  }
  paintPayBlock();
}

/* ------------------------------------------------------------------ form -- */

function syncFormChrome() {
  var isBuy = st.side === 'buy';
  var btn = ui.el('[data-p2p-submit]');
  if (btn) {
    btn.textContent = isBuy ? 'Place P2P buy' : 'List P2P sell';
    btn.className = 'btn btn-block btn-lg ' + (isBuy ? 'btn-primary' : 'btn-sell');
  }
  ui.setText('[data-p2p-note]', isBuy
    ? 'You pay the seller directly and upload proof; the ARV is released when they confirm.'
    : 'Your ARV is escrowed now and released only when you confirm you were paid.');

  var hint = ui.el('[data-p2p-trigger-hint]');
  if (hint) {
    // stop = opposite direction to limit/target.
    var isStop = st.otype === 'stop';
    var up = isBuy ? isStop : !isStop;   // does it fire when the price RISES?
    hint.textContent = 'This ' + (isBuy ? 'buy' : 'sell') + ' triggers when ARV '
      + (up ? 'rises to this level or above' : 'falls to this level or below') + '.'
      + (isStop && !isBuy ? ' (Stop-loss: sells to limit your downside.)' : '')
      + (!isStop && !isBuy ? ' (Target: sells to lock in a gain.)' : '');
  }

  // Available balance + quick-% amounts. On a SELL the quick buttons pick a
  // portion of the ARV you hold (25/50/75/100%); on a BUY there is nothing to
  // portion (you have not chosen a seller yet), so they are hidden.
  var w = st.user && st.user.wallet;
  var avail = w ? (parseFloat(w.arvUnits) || 0) : 0;
  var availLabel = ui.el('[data-p2p-avail-label]');
  var availEl = ui.el('[data-p2p-avail]');
  var quick = ui.el('[data-p2p-quick]');
  if (availLabel) availLabel.textContent = isBuy ? 'KYC-verified buyers only' : 'ARV available';
  if (availEl) availEl.textContent = isBuy ? '\u2014' : (w ? ui.fmtUnits(avail, 4) + ' ARV' : '\u2014');
  if (quick) {
    if (isBuy) {
      quick.classList.add('hidden');
      quick.innerHTML = '';
    } else {
      quick.classList.remove('hidden');
      quick.innerHTML = [25, 50, 75, 100].map(function (pc) {
        return '<button type="button" class="btn btn-sm" data-p2p-qpct="' + pc + '">' + pc + '%</button>';
      }).join('');
      ui.els('[data-p2p-qpct]').forEach(function (b) {
        b.addEventListener('click', function () {
          // data-p2p-qpct="..." surfaces as dataset.p2pQpct, not dataset.qpct — the
          // old key read undefined, Number(undefined) is NaN, and NaN ended up in
          // the units box on every click. Read the attribute the button actually
          // has, and floor at 8dp so "100%" never asks for more than is held.
          var pct = Number(b.getAttribute('data-p2p-qpct'));
          if (!isFinite(pct)) return;
          var u = Math.floor(avail * (pct / 100) * 1e8) / 1e8;
          var inp = ui.el('#p2pUnits');
          if (inp) { inp.value = String(u); paintEstimate(); }
        });
      });
    }
  }
  // Selling needs somewhere to be paid, so load that list the first time the
  // sell side is opened rather than on every page view.
  if (!isBuy && st.methods == null) loadMethods();
  paintPayBlock();

  paintEstimate();
}

async function place() {
  var btn = ui.el('[data-p2p-submit]');
  var units = (ui.el('#p2pUnits').value || '').replace(/[^\d.]/g, '');
  if (!parseFloat(units)) {
    ui.toast('Enter the number of units.', 'warn');
    return;
  }

  var payload = { side: st.side, type: st.otype, units: String(units) };
  if (st.otype !== 'market') {
    var trigger = parseFloat((ui.el('#p2pTrigger').value || '').replace(/[^\d.]/g, ''));
    if (!trigger) { ui.toast('Enter the price the order should trigger at.', 'warn'); return; }
    payload.triggerNav = String(trigger);
  }

  ui.busy(btn, true, st.side === 'buy' ? 'Placing…' : 'Listing…');
  try {
    var r = await api.p2p.place(payload);
    ui.toast(r.message || 'Done.', 'ok', 7000);
    ui.el('#p2pUnits').value = '';
    if (ui.el('#p2pTrigger')) ui.el('#p2pTrigger').value = '';
    await refresh();
  } catch (e) {
    ui.toastError(e);
  } finally {
    ui.busy(btn, false);
  }
}

/* -------------------------------------------------------------- rendering -- */

function statusBadge(status) {
  var map = { matched: 'warn', paid: 'metal', released: 'ok', cancelled: '', disputed: 'bad', expired: '' };
  return '<span class="badge ' + (map[status] || '') + '">' + ui.esc(status) + '</span>';
}

/**
 * A human countdown to an ISO-8601 (UTC) deadline, e.g. "42 min left" or
 * "overdue". The server sends the deadline with a trailing Z, so new Date()
 * parses it correctly regardless of the viewer's timezone.
 */
function countdownText(iso) {
  if (!iso) return '';
  var ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms)) return '';
  if (ms <= 0) return 'time is up';
  var mins = Math.round(ms / 60000);
  if (mins < 60) return mins + ' min left';
  var hrs = Math.floor(mins / 60);
  return hrs + 'h ' + (mins % 60) + 'm left';
}

function paymentDetailsHtml(p) {
  if (!p) return '<div class="tiny muted">Payment details unavailable.</div>';
  if (p.type === 'upi') {
    return '<div class="tiny">Pay by UPI to <strong>' + ui.esc(p.upiVpa) + '</strong>'
      + (p.accountName ? ' (' + ui.esc(p.accountName) + ')' : '') + '</div>';
  }
  return '<div class="tiny">Bank transfer to <strong>' + ui.esc(p.accountName || '') + '</strong>'
    + '<br>A/c ' + ui.esc(p.bankAccountNo || '') + ' · IFSC ' + ui.esc(p.bankIfsc || '') + '</div>';
}

function tradeCard(t) {
  var head = '<div class="row-between" style="align-items:center">'
    + '<span>' + statusBadge(t.status)
      + ' <span class="tiny muted">' + ui.esc(t.role) + '</span></span>'
    + '<span class="num tiny">' + ui.fmtUnits(t.units, 4) + ' ARV · ' + ui.fmtPaise(t.amountPaise) + '</span>'
    + '</div>';

  var body = '<div class="tiny muted" style="margin-top:4px">'
    + 'with ' + ui.esc(t.counterparty || '—') + ' · at ' + ui.fmtPrice(t.priceNav) + ' per ARV</div>';

  var extra = '';

  // A live deadline line for whichever timer is running on this trade.
  var payLeft = countdownText(t.payDeadline);
  var confirmLeft = countdownText(t.confirmDeadline);

  // Buyer, awaiting payment: show where to pay, the pay deadline, and a proof form.
  if (t.role === 'buyer' && t.status === 'matched') {
    extra += (payLeft
        ? '<div class="note-box warn tiny" style="margin-top:8px">Pay and upload proof \u2014 <strong>'
          + ui.esc(payLeft) + '</strong>. If the window passes the trade is cancelled and the ARV returns to the seller.</div>'
        : '')
      + '<div style="margin-top:8px">' + paymentDetailsHtml(t.sellerPayment) + '</div>'
      + '<div class="stack" style="margin-top:8px;gap:6px" data-proof="' + t.id + '">'
        + '<input class="num-input" type="text" placeholder="UTR / reference" data-proof-utr>'
        + '<input type="file" accept="image/*" data-proof-file>'
        + '<div class="row" style="gap:6px">'
          + '<button class="btn btn-sm btn-primary" data-proof-submit="' + t.id + '">I\u2019ve paid — submit proof</button>'
          + '<button class="btn btn-sm btn-ghost" data-p2p-cancel="' + t.id + '">Cancel</button>'
        + '</div>'
      + '</div>';
  } else if (t.role === 'buyer' && t.status === 'paid') {
    extra += '<div class="tiny muted" style="margin-top:8px">Proof submitted. Waiting for the seller to confirm receipt'
      + (confirmLeft ? ' (' + ui.esc(confirmLeft) + ' before it goes to support)' : '') + '.</div>';
  } else if (t.role === 'seller' && t.status === 'matched') {
    extra += '<div class="tiny muted" style="margin-top:8px">Waiting for the buyer to pay and upload proof'
      + (payLeft ? ' (' + ui.esc(payLeft) + ')' : '') + '.</div>'
      + '<button class="btn btn-sm btn-ghost" style="margin-top:6px" data-p2p-cancel="' + t.id + '">Cancel</button>';
  } else if (t.role === 'seller' && t.status === 'paid') {
    extra += '<div class="tiny" style="margin-top:8px">Buyer says paid'
      + (t.proofUtr ? ' · UTR ' + ui.esc(t.proofUtr) : '')
      + (t.hasProofImage ? ' · screenshot attached' : '') + '.</div>'
      + '<div class="note-box warn tiny" style="margin-top:6px">Only confirm once the money is actually in your account — releasing is final.'
      + (confirmLeft ? ' Confirm within <strong>' + ui.esc(confirmLeft) + '</strong> or this goes to support to settle.' : '') + '</div>'
      + '<button class="btn btn-sm btn-primary" style="margin-top:6px" data-p2p-confirm="' + t.id + '">Confirm received &amp; release</button>';
  } else if (t.status === 'disputed') {
    extra += '<div class="note-box bad tiny" style="margin-top:8px">Under review by support. '
      + (t.role === 'buyer'
          ? 'Your payment proof is being checked; the ARV is released to you or the trade is cancelled once support decides.'
          : (t.role === 'seller'
              ? 'The buyer says they paid but this was not confirmed in time. Support will check the proof and settle it.'
              : 'A moderator will settle this trade.'))
      + '</div>';
  } else if (t.status === 'expired') {
    extra += '<div class="tiny muted" style="margin-top:8px">Expired — '
      + (t.role === 'seller'
          ? 'the buyer did not pay in time, so the escrowed ARV was returned to you.'
          : 'payment was not made in time, so the trade was cancelled and the ARV returned to the seller.')
      + '</div>';
  }

  // Buyer, released: show exactly what the platform took, in ARV, and what
  // landed in the wallet — the fee is borne by the buyer, in ARV, so it should
  // be transparent after the fact as well as up front on the form.
  if (t.role === 'buyer' && t.status === 'released'
      && (parseFloat(t.feeUnits) > 0 || parseFloat(t.tdsUnits) > 0)) {
    extra += '<div class="tiny muted" style="margin-top:8px">Platform fee '
      + ui.fmtUnits(t.feeUnits, 4) + ' ARV'
      + (parseFloat(t.tdsUnits) > 0 ? ' \u00b7 TDS ' + ui.fmtUnits(t.tdsUnits, 4) + ' ARV' : '')
      + ' \u00b7 you received <strong>' + ui.fmtUnits(t.netUnits, 4) + ' ARV</strong>.</div>';
  }

  return '<div class="asset-row" style="display:block;padding:10px 0;border-bottom:1px solid var(--line)">'
    + head + body + extra + '</div>';
}

function bindTradeActions() {
  ui.els('[data-proof-submit]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = Number(b.dataset.proofSubmit);
      var wrap = ui.el('[data-proof="' + id + '"]');
      var utr = wrap ? (ui.el('[data-proof-utr]', wrap).value || '').trim() : '';
      var fileEl = wrap ? ui.el('[data-proof-file]', wrap) : null;
      var file = fileEl && fileEl.files && fileEl.files[0] ? fileEl.files[0] : null;
      if (!utr && !file) { ui.toast('Enter the UTR or attach a screenshot.', 'warn'); return; }
      ui.busy(b, true, 'Submitting…');
      try {
        var r = await api.p2p.proof(id, utr, file);
        ui.toast(r.message || 'Proof submitted.', 'ok', 6000);
        await refresh();
      } catch (e) { ui.toastError(e); ui.busy(b, false); }
    });
  });

  ui.els('[data-p2p-confirm]').forEach(function (b) {
    b.addEventListener('click', async function () {
      if (!confirm('Confirm you have received the payment? This releases the ARV to the buyer and cannot be undone.')) return;
      ui.busy(b, true, 'Releasing…');
      try {
        var r = await api.p2p.confirm(Number(b.dataset.p2pConfirm));
        ui.toast(r.message || 'Released.', 'ok', 6000);
        await refresh();
      } catch (e) { ui.toastError(e); ui.busy(b, false); }
    });
  });

  ui.els('[data-p2p-cancel]').forEach(function (b) {
    b.addEventListener('click', async function () {
      if (!confirm('Cancel this trade? The escrowed ARV returns to the seller.')) return;
      ui.busy(b, true, '…');
      try {
        var r = await api.p2p.cancelTrade(Number(b.dataset.p2pCancel), '');
        ui.toast(r.message || 'Cancelled.', 'ok');
        await refresh();
      } catch (e) { ui.toastError(e); ui.busy(b, false); }
    });
  });
}

function paintTrades(trades) {
  var host = ui.el('[data-p2p-trades]');
  if (!host) return;
  // 'disputed' is live — it still needs a resolution — so it sorts with the
  // active trades; 'expired' joins the settled history alongside released/cancelled.
  var live = (trades || []).filter(function (t) {
    return t.status === 'matched' || t.status === 'paid' || t.status === 'disputed';
  });
  var past = (trades || []).filter(function (t) {
    return t.status === 'released' || t.status === 'cancelled' || t.status === 'expired';
  });
  var rows = live.concat(past.slice(0, 8));
  if (!rows.length) {
    host.innerHTML = '<div class="empty tiny">None yet</div>';
    return;
  }
  host.innerHTML = rows.map(tradeCard).join('');
  bindTradeActions();
}

function paintOrders(orders) {
  var host = ui.el('[data-p2p-orders]');
  if (!host) return;
  if (!orders || !orders.length) {
    host.innerHTML = '<div class="empty tiny">None</div>';
    return;
  }
  host.innerHTML = orders.map(function (o) {
    return '<div class="asset-row" style="grid-template-columns:1fr auto auto;padding:8px 0">'
      + '<div><span class="badge ' + (o.side === 'buy' ? 'ok' : 'warn') + '">' + o.side + '</span> '
        + '<span class="tiny muted">' + o.type + '</span>'
        + '<div class="num tiny" style="margin-top:3px">' + ui.fmtUnits(o.matchableUnits, 4) + ' left'
        + (o.triggerNav ? ' at ' + ui.fmtPrice(o.triggerNav) : '') + '</div></div>'
      + '<span></span>'
      + '<button class="btn btn-sm btn-ghost" data-p2p-cancelorder="' + o.id + '">Cancel</button>'
      + '</div>';
  }).join('');

  ui.els('[data-p2p-cancelorder]').forEach(function (b) {
    b.addEventListener('click', async function () {
      ui.busy(b, true, '…');
      try {
        var r = await api.p2p.cancelOrder(Number(b.dataset.p2pCancelorder));
        ui.toast(r.message || 'Cancelled.', 'ok');
        await refresh();
      } catch (e) { ui.toastError(e); ui.busy(b, false); }
    });
  });
}

function paintDepth(offers) {
  var host = ui.el('[data-p2p-depth]');
  if (!host || !offers) return;
  host.innerHTML = 'Waiting to sell: <strong>' + ui.fmtUnits(offers.sellDepthUnits, 2) + ' ARV</strong>'
    + ' · waiting to buy: <strong>' + ui.fmtUnits(offers.buyDepthUnits, 2) + ' ARV</strong>';
}

/* --------------------------------------------------------------- refresh -- */

async function refresh() {
  try {
    var o = await api.p2p.offers();
    if (o.price && o.price.nav != null) st.nav = o.price.nav;
    if (o.fee) st.fee = o.fee;
    st.treasuryAvailable = !!o.treasuryAvailable;
    paintDepth(o);
    paintEstimate();
  } catch (_) {}

  try {
    var r = await api.p2p.mine();
    if (r.nav != null) st.nav = r.nav;
    paintTrades(r.trades || []);
    paintOrders(r.orders || []);
  } catch (_) {}
}

/* ------------------------------------------------------------------ boot -- */

(async function () {
  if (!root()) return;   // not the trade page

  var user = await api.me().catch(function () { return null; });
  if (!user) return;     // trade.js handles the sign-in redirect
  st.user = user;

  root().hidden = false;

  ui.els('[data-p2p-side] button').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-p2p-side] button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.side = b.dataset.side;
      syncFormChrome();
    });
  });

  ui.els('[data-p2p-type] .tab').forEach(function (b) {
    b.addEventListener('click', function () {
      ui.els('[data-p2p-type] .tab').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      st.otype = b.dataset.otype;
      var f = ui.el('[data-p2p-trigger-field]');
      if (f) f.classList.toggle('hidden', st.otype === 'market');
      syncFormChrome();
    });
  });

  var unitsEl = ui.el('#p2pUnits');
  if (unitsEl) unitsEl.addEventListener('input', paintEstimate);
  ui.on('[data-p2p-submit]', 'click', place);

  syncFormChrome();
  await refresh();

  // The trades surface changes when a counterparty acts, so keep it fresh.
  api.poll(refresh, 20000);
})();
