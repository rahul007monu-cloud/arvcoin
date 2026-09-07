/**
 * Peer-to-peer (P2P) panel on the trade page.
 *
 * This is a self-contained module that drives the [data-p2p] section: placing a
 * P2P buy or sell, and the seller's payment-method block that a sell needs.
 *
 * What happens AFTER placement — a match paid for, proved, confirmed, cancelled,
 * each on its own clock — is not here any more. It is orders.html /
 * js/pages/orders.js, because those surfaces are time-critical and were being
 * lost at the bottom of the chart page.
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

  // The 20s poll re-runs this. Rebuilding the markup while someone is part-way
  // through typing a UPI ID or an account number would wipe what they entered,
  // so once a field has content this leaves the block exactly as it is.
  var typing = ['#p2pVpa', '#p2pAccName', '#p2pAccNo', '#p2pIfsc'].some(function (s) {
    var e = ui.el(s);
    return e && e.value && e.value.trim() !== '';
  });
  if (typing) return;

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
          // Read the holding at click time, not from the closure. The closure's
          // copy is whatever the wallet held when the buttons were last drawn,
          // which goes stale the moment a trade settles.
          var w2 = st.user && st.user.wallet;
          var have = w2 ? parseFloat(w2.arvUnits) : NaN;
          var inp = ui.el('#p2pUnits');
          if (!inp || !isFinite(pct) || !isFinite(have) || have <= 0) return;

          var u = Math.floor(have * (pct / 100) * 1e8) / 1e8;
          if (!isFinite(u) || u <= 0) return;   // never write NaN into the field
          inp.value = String(u);
          paintEstimate();
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
    // Placement is only the start: a match has to be paid for or confirmed, and
    // that all happens on the Orders page, so send them there rather than leaving
    // them on the chart wondering what happens next.
    ui.toast(ui.esc(r.message || 'Done.')
      + ' <a href="orders.html" class="arrow">Track it on Orders</a>', 'ok', 9000);
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

/*
 * The "My P2P trades" and "My open P2P orders" surfaces are no longer here.
 *
 * They moved to orders.html / js/pages/orders.js as colour-coded cards, along
 * with everything they carried: the status badge, the payment details, the proof
 * form, the confirm/cancel handlers and the countdowns. This module is now only
 * the place-order form (side, type, units, trigger, the seller's payment method)
 * plus the depth line, which is what belongs next to the chart.
 */

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

  // No api.p2p.mine() call here any more: nothing on this page renders trades or
  // orders, and the price it used to carry also comes from the offers endpoint
  // above. The Orders page polls mine() for the surfaces that need it.

  // Re-read the wallet. It changes whenever a trade settles or escrow is
  // returned, and the sell side reads it for both the "ARV available" line and
  // the quick-% amounts — without this they keep showing the boot-time holding.
  try {
    var u = await api.me(true);
    if (u) {
      st.user = u;
      if (st.side === 'sell') syncFormChrome();
    }
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
