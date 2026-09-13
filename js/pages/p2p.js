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
  // The whole offers payload — book, live activity and 24h stats — kept so the
  // side toggle can repaint the "fills now" line without another round trip.
  offers: null,
  // This user's own resting P2P orders, so the trade page can show them beside the
  // book they are sitting in.
  myOrders: null,
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
  // Kept to one plain sentence. The deductions are itemised in the summary block
  // above the confirm button rather than crammed into a form hint.
  host.innerHTML = (st.side === 'buy' ? 'You pay the seller about ' : 'You receive about ')
    + '<strong>' + ui.fmtPaise(paise) + '</strong> at ' + ui.fmtPrice(st.nav) + ' per ARV.';
}

/**
 * The itemised order summary, shown directly above the confirm button.
 *
 * Fee rates are no longer advertised on the marketing pages — a percentage shown
 * to somebody who is only reading tells them nothing useful and ages badly. This
 * is where a number earns its place: against a real quantity, at the moment the
 * order is about to be agreed to.
 *
 * On a BUY the platform fee and TDS are taken out of the ARV received, never out
 * of the rupees sent, so the rupee line and the unit line have to be shown
 * separately — the seller is paid in full and the deduction happens on the other
 * side of the trade. A SELLER pays no platform fee, so their summary says so
 * rather than leaving a blank where a charge would be.
 */
function paintSummary() {
  var host = ui.el('[data-p2p-summary]');
  if (!host) return;

  var raw = (ui.el('#p2pUnits').value || '').replace(/[^\d.]/g, '');
  var units = parseFloat(raw);
  var paise = estimatePaise(raw);

  if (!isFinite(units) || units <= 0 || paise == null) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  function row(label, amount, kind, note) {
    return '<div class="ledger-row k-' + (kind || 'info') + '">'
      + '<span class="l">' + ui.esc(label) + '</span>'
      + (amount != null ? '<span class="a">' + amount + '</span>' : '')
      + (note ? '<span class="note">' + ui.esc(note) + '</span>' : '')
      + '</div>';
  }

  var out = '';
  var fee = st.fee;
  var charged = st.side === 'buy' && fee && fee.collected && fee.totalPct > 0;

  if (st.side === 'buy') {
    out += row('You pay the seller', ui.fmtPaise(paise), 'gross',
               'Paid from your own bank to theirs. Nothing is deducted from this amount.');
    out += row('Price per ARV', ui.fmtPrice(st.nav), 'info',
               'The index price at the moment you match, not a price the seller sets.');

    if (charged) {
      var feeUnits = units * (fee.feePct / 100);
      out += row('Platform fee (' + fee.feePct + '%)',
                 '\u2212' + ui.fmtUnits(feeUnits, 4) + ' ARV', 'charge',
                 'Taken in ARV, not rupees.');
      if (fee.tdsPct > 0) {
        out += row('TDS (' + fee.tdsPct + '%)',
                   '\u2212' + ui.fmtUnits(units * (fee.tdsPct / 100), 4) + ' ARV', 'tds',
                   'Withheld in ARV and reported.');
      }
      out += row('You receive', ui.fmtUnits(units * (1 - fee.totalPct / 100), 4) + ' ARV', 'net');
    } else {
      out += row('You receive', ui.fmtUnits(units, 4) + ' ARV', 'net',
                 'No platform fee applies to this order.');
    }
  } else {
    out += row('You receive', ui.fmtPaise(paise), 'gross',
               'Paid by the buyer straight into the account you saved.');
    out += row('Price per ARV', ui.fmtPrice(st.nav), 'info',
               'The index price at the moment a buyer matches.');
    out += row('Units held in escrow', ui.fmtUnits(units, 4) + ' ARV', 'info',
               'Locked when a buyer matches, released once you confirm the money arrived.');
    out += row('Platform fee', 'None', 'net', 'A seller pays no platform fee.');
  }

  host.innerHTML = out;
  host.classList.remove('hidden');
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
          paintSummary();
        });
      });
    }
  }
  // Selling needs somewhere to be paid, so load that list the first time the
  // sell side is opened rather than on every page view.
  if (!isBuy && st.methods == null) loadMethods();
  paintPayBlock();

  paintEstimate();
  paintSummary();
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

    // A matched order and a resting one need different things said. A match has to
    // be paid for or confirmed, and that happens on the Orders page — so send them
    // there. An order that is resting has nothing to do yet, and telling that
    // person to "track it" makes them think something is wrong; instead, point them
    // at the queue they can now see themselves in, right on this page.
    if (r.matched) {
      ui.toast(ui.esc(r.message || 'Matched.')
        + ' <a href="orders.html" class="arrow">Pay and track it on Orders</a>', 'ok', 9000);
    } else {
      ui.toast(ui.esc(r.message || 'Order placed.')
        + ' It is in the queue below and matches automatically \u2014 nothing else for '
        + 'you to do.', 'ok', 9000);
    }

    ui.el('#p2pUnits').value = '';
    if (ui.el('#p2pTrigger')) ui.el('#p2pTrigger').value = '';

    // Immediately, so the order they just placed is visible in the book and in
    // "your open orders" rather than appearing up to 12 seconds later. Seeing it
    // land is the whole difference between a confirmation and a hope.
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

  // Say whether the order about to be placed will fill now, because that is the
  // question, and it was previously answered only after the fact by a toast.
  var liq = offers.liquidity || {};
  var fills = st.side === 'buy' ? liq.buyFillsNow : liq.sellFillsNow;
  var mine = st.side === 'buy' ? offers.sellDepthUnits : offers.buyDepthUnits;

  host.innerHTML = fills
    ? '<span class="up strong">Fills now</span> \u00b7 '
      + ui.fmtUnits(st.side === 'buy' ? liq.instantForBuyer : mine, 2)
      + ' ARV available on the other side'
    : '<span class="muted">Nothing on the other side right now.</span> Your order rests '
      + 'in the queue below and matches the moment someone appears.';
}

/**
 * The book: everyone waiting, on both sides.
 *
 * This is the answer to the real problem — a customer who places an order into a
 * blank screen has no way to tell a quiet market from a broken one, and assumes
 * broken. Seeing the queue, with sizes and how long each has waited, is what makes
 * a resting order feel like a position in a line rather than a message into a void.
 *
 * It also does the job in the other direction: the buy side of this book IS a
 * seller's signal that somebody is waiting to buy, and how long they have waited.
 * A seller who can see ₹8,000 of demand that has been waiting twenty minutes has a
 * reason to sell; a seller who sees nothing does not.
 *
 * Anonymous throughout — the server sends size, kind and age, and nothing else.
 */
function paintBook(offers) {
  var host = ui.el('[data-depth]');
  if (!host || !offers) return;

  var book = offers.book || { sells: [], buys: [] };
  var nav = offers.price && offers.price.nav;

  if (nav == null) {
    host.innerHTML = '<div class="empty tiny">The market opens when the price feed is live.</div>';
    return;
  }

  var html =
    '<div class="row-between" style="align-items:baseline">'
      + '<span class="tiny muted">Everything settles at</span>'
      + '<span class="num strong" style="font-size:1.15rem">' + ui.fmtPrice(nav) + '</span>'
    + '</div>';

  // Sells first: it is the supply a buyer takes, so it is what most visitors are
  // reading the book for.
  html += bookSide('Waiting to sell', book.sells, offers.sellDepthUnits, 'down',
                   'to a buyer');
  html += bookSide('Waiting to buy', book.buys, offers.buyDepthUnits, 'up',
                   'for a seller');

  var t = parseFloat(offers.liquidity && offers.liquidity.treasuryUnits) || 0;
  if (t > 0) {
    html += '<div class="tiny muted" style="margin-top:10px">Plus '
      + ui.fmtUnits(t, 2) + ' ARV the treasury can sell instantly.</div>';
  }

  host.innerHTML = html;
}

/** One side of the book: a total, then the individual orders in queue order. */
function bookSide(label, rows, totalUnits, cls, waitingFor) {
  rows = rows || [];
  var total = parseFloat(totalUnits) || 0;

  var html = '<div class="row-between tiny" style="margin-top:12px;padding-top:12px;'
    + 'border-top:1px solid var(--line)">'
    + '<span class="' + cls + ' strong">' + label + '</span>'
    + '<span class="num">' + ui.fmtUnits(totalUnits || 0, 2) + ' ARV</span></div>';

  if (!rows.length || total <= 0) {
    return html + '<div class="tiny muted" style="margin-top:3px">Nobody ' + waitingFor
      + ' \u2014 be the first and you set the queue.</div>';
  }

  // The queue itself. Capped at five: enough to read as a real market, short
  // enough that the card stays a card.
  html += '<div class="depth-rows">' + rows.slice(0, 5).map(function (r) {
    return '<div class="depth-row">'
      + '<span class="num">' + ui.fmtUnits(r.units, 4) + '</span>'
      + '<span class="tiny muted">' + (r.paise != null ? ui.fmtPaise(r.paise) : '\u2014') + '</span>'
      + '<span class="tiny muted">' + ui.esc(waitedFor(r.waitingSeconds)) + '</span>'
      + '</div>';
  }).join('') + '</div>';

  if (rows.length > 5) {
    html += '<div class="tiny muted" style="margin-top:3px">and '
      + (rows.length - 5) + ' more in the queue</div>';
  }
  return html;
}

/** "just now" / "12m waiting" / "3h waiting" — how long this order has been in line. */
function waitedFor(seconds) {
  if (seconds == null) return '';
  if (seconds < 60) return 'just now';
  var mins = Math.floor(seconds / 60);
  if (mins < 60) return mins + 'm waiting';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h waiting';
  return Math.floor(hrs / 24) + 'd waiting';
}

/**
 * This user's own resting orders, beside the book they are sitting in.
 *
 * The box was previously fed by api.myOrders(), which reads the legacy index
 * channel — so on a P2P-only venue it said "None open" permanently, even to
 * somebody who had just placed an order and was staring at the confirmation. That
 * is precisely the moment the page needed to show them their order.
 *
 * Each row carries its queue position, because "you are 2nd in line" is a real
 * answer and "waiting" is not.
 */
function paintMyOrders() {
  var host = ui.el('[data-my-orders]');
  if (!host) return;

  var rows = st.myOrders;
  if (rows == null) return;            // not loaded yet; leave the placeholder

  if (!rows.length) {
    host.innerHTML = '<div class="empty tiny">None open</div>';
    return;
  }

  host.innerHTML = rows.map(function (o) {
    var pos = queuePosition(o);
    return '<div class="asset-row" style="grid-template-columns:1fr auto">'
      + '<div><span class="badge ' + (o.side === 'buy' ? 'ok' : 'warn') + '">' + ui.esc(o.side)
        + '</span> <span class="tiny muted">' + ui.esc(o.type) + '</span>'
        + '<div class="num tiny" style="margin-top:3px">'
          + ui.fmtUnits(o.matchableUnits, 4) + ' left'
          + (o.triggerNav ? ' at ' + ui.fmtPrice(o.triggerNav) : '') + '</div>'
        + (pos ? '<div class="tiny muted">' + ui.esc(pos) + '</div>' : '')
        + '</div>'
      + '<button class="btn btn-sm btn-ghost" data-p2p-cancel-order="' + o.id + '">Cancel</button>'
      + '</div>';
  }).join('');

  ui.els('[data-p2p-cancel-order]').forEach(function (b) {
    b.addEventListener('click', async function () {
      ui.busy(b, true, '\u2026');
      try {
        var res = await api.p2p.cancelOrder(Number(b.getAttribute('data-p2p-cancel-order')));
        ui.toast(res.message || 'Order cancelled.', 'ok');
        await refresh();
      } catch (e) {
        ui.toastError(e);
        ui.busy(b, false);
      }
    });
  });
}

/**
 * Where this order sits in the queue it will be matched from.
 *
 * p2p_try_match() takes resting counterparties by created_at ASC, so position in
 * the book is genuinely position in line — this is not a decorative number. Counted
 * against the same side of the book, since those are the orders competing for the
 * same counterparties.
 */
function queuePosition(o) {
  var book = st.offers && st.offers.book;
  if (!book) return '';

  var sameSide = (o.side === 'buy' ? book.buys : book.sells) || [];
  if (sameSide.length <= 1) return 'first in the queue';

  // The book is anonymous, so match on age: this order is ahead of everything that
  // has waited less time than it has.
  var mine = Date.parse(String(o.createdAt).replace(' ', 'T') + 'Z');
  if (isNaN(mine)) return '';
  var myWait = (Date.now() - mine) / 1000;

  var ahead = sameSide.filter(function (r) {
    return (r.waitingSeconds || 0) > myWait + 1;
  }).length;

  return ahead === 0
    ? 'first in the queue'
    : (ahead + 1) + (ahead + 1 === 2 ? 'nd' : (ahead + 1 === 3 ? 'rd' : 'th'))
      + ' in the queue of ' + sameSide.length;
}

/**
 * The live feed: what has actually been trading.
 *
 * Reads offers.activity, which the server builds from `p2p_trades` — so a match
 * appears the instant it happens. The old tape read the `trades` table, which is
 * only written when a trade fully releases, so it stayed empty while several
 * trades were in flight and made a working market look like a dead one.
 *
 * In-flight trades are marked rather than hidden. "Somebody is paying for 2 ARV
 * right now" is the single most reassuring thing this page can show.
 */
function paintActivity(offers) {
  var host = ui.el('[data-tape]');
  if (!host || !offers) return;

  var rows = offers.activity || [];
  var s = offers.stats24h || {};

  ui.setText('[data-tape-count]', s.trades
    ? s.trades + (s.trades === 1 ? ' trade' : ' trades') + ' in 24h'
    : '');

  if (!rows.length) {
    host.innerHTML = '<div class="empty tiny">No trades yet. '
      + 'The first one appears here as it happens.</div>';
    return;
  }

  host.innerHTML = rows.map(function (t) {
    var live = t.status === 'matched' || t.status === 'paid';
    var mark = live
      ? '<span class="live-dot" title="In progress \u2014 being paid for now"></span>'
      : '';
    return '<div class="tape-row' + (live ? ' is-live' : '') + '">'
      + '<span class="num">' + ui.fmtPrice(t.nav) + ' ' + mark + '</span>'
      + '<span class="num">' + ui.fmtUnits(t.units, 4) + '</span>'
      + '<span class="t">' + ui.fmtTime(t.at) + '</span>'
      + '</div>';
  }).join('');
}

/* --------------------------------------------------------------- refresh -- */

async function refresh() {
  try {
    var o = await api.p2p.offers();
    if (o.price && o.price.nav != null) st.nav = o.price.nav;
    if (o.fee) st.fee = o.fee;
    st.treasuryAvailable = !!o.treasuryAvailable;
    st.offers = o;
    paintDepth(o);
    paintBook(o);
    paintActivity(o);
    paintMyOrders();
    paintEstimate();
    paintSummary();
  } catch (_) {}

  // mine() is back, for one thing only: this user's own resting orders, shown
  // beside the book so somebody who has just placed one can see it in the queue.
  // The full trades surface still lives on orders.html.
  try {
    var m = await api.p2p.mine();
    st.myOrders = m.orders || [];
    paintMyOrders();
  } catch (_) {}

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
      // The "fills now" line is side-specific, so repaint it from the payload we
      // already hold rather than waiting up to 20s for the next poll.
      if (st.offers) paintDepth(st.offers);
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
  if (unitsEl) unitsEl.addEventListener('input', function () { paintEstimate(); paintSummary(); });
  ui.on('[data-p2p-submit]', 'click', place);

  syncFormChrome();
  await refresh();

  // Faster than it was: this now carries the book and the live activity feed, and a
  // "live" feed that updates every 20 seconds does not read as live.
  api.poll(refresh, 12000);
})();
