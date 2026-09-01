/**
 * Fees, FIFO cost basis and Indian VDA tax.
 *
 * Pure arithmetic — no DOM, no network, no storage. That is deliberate: this
 * same file is imported by the browser to *preview* a trade and by the Edge
 * Function to *execute* one, so the number the user is shown before confirming
 * and the number written to the ledger come from one implementation. Two
 * implementations of tax maths drift, and when they drift the user is shown a
 * figure the ledger disagrees with.
 *
 * ---------------------------------------------------------------------------
 * The tax model, stated once
 * ---------------------------------------------------------------------------
 *
 * Redeeming ARV is a transfer of a virtual digital asset. Two separate things
 * happen, and conflating them is the single most misleading thing a crypto app
 * can do to a user:
 *
 *   TDS — section 194S — 1% of gross consideration, WITHHELD by the platform at
 *         the moment of redemption. The user never receives it. It is credited
 *         against their eventual liability and shows up in Form 26AS / AIS.
 *         20% instead of 1% where no PAN is on record (section 206AA).
 *         Only applies once the year's transfers cross the threshold.
 *
 *   Tax — section 115BBH — 30% on the gain, plus 4% cess on that tax, so 31.2%
 *         effective. NOT withheld here. It is the user's own liability, paid
 *         when they file. This app computes and reports it so there is no
 *         surprise in July; it does not collect it.
 *
 * Two consequences that surprise people, both enforced below:
 *
 *   Platform fees are NOT deductible. Section 115BBH permits only cost of
 *   acquisition. Paying ₹50 in exit fee does not reduce the taxable gain by ₹50.
 *
 *   Losses cannot be set off — not against other VDA gains, not against
 *   anything else, and not carried forward. A loss is recorded and then, for tax
 *   purposes, discarded. So a user who gains ₹100 on one redemption and loses
 *   ₹100 on another pays tax on ₹100 despite being flat overall.
 *
 * Rates live in arv-config.js. Verify them with a CA before relying on this for
 * an actual filing.
 */

import { pctOfPaise, roundUnits, fyOf } from './money.js';

var CFG = globalThis.ARV_CONFIG;

function cfg() {
  // Read lazily so the admin panel can adjust config at runtime and previews
  // immediately reflect it.
  return {
    fees: CFG.FEES,
    tax: CFG.TAX
  };
}

/* ============================================================ execution ==== */

/**
 * Price a trade actually executes at.
 *
 * A real order does not fill at the mid price on screen. Buying pushes you up
 * the book, selling pushes you down. Modelling that as zero makes every
 * downstream number slightly optimistic in the user's favour, which is the
 * worst direction for an error in a financial product to point.
 */
export function execNav(nav, side) {
  var s = cfg().fees.slippagePct || 0;
  if (!s) return nav;
  return side === 'buy' ? nav * (1 + s / 100) : nav * (1 - s / 100);
}

/* ================================================================= buy ===== */

/**
 * Quote a deposit.
 *
 * @param grossPaise  what the user pays in, integer paise
 * @param nav         ARV price in rupees
 * @returns a fully itemised breakdown; every paise is accounted for
 */
export function quoteBuy(grossPaise, nav) {
  var f = cfg().fees;
  var gross = Math.max(0, Math.round(grossPaise));

  var errors = [];
  if (gross < f.minInvestPaise) {
    errors.push('Minimum deposit is \u20b9' + (f.minInvestPaise / 100).toLocaleString('en-IN'));
  }
  if (!nav || nav <= 0) {
    errors.push('No live price available \u2014 cannot quote a deposit');
  }

  var fee = pctOfPaise(gross, f.entryPct);
  var gst = pctOfPaise(fee, f.gstPct);
  var net = gross - fee - gst;

  var xnav = nav ? execNav(nav, 'buy') : 0;
  // Floor, so issuance never exceeds the value received.
  var units = xnav > 0 ? Math.floor((net / 100 / xnav) * 1e8) / 1e8 : 0;

  return {
    side: 'buy',
    grossPaise: gross,
    feePaise: fee,
    gstPaise: gst,
    totalChargesPaise: fee + gst,
    netInvestPaise: net,
    nav: nav,
    execNav: xnav,
    slippagePct: f.slippagePct,
    units: roundUnits(units),
    // What the user effectively paid per unit once charges are included.
    effectiveNav: units > 0 ? (gross / 100) / units : 0,
    errors: errors,
    valid: errors.length === 0 && net > 0 && units > 0
  };
}

/* ================================================================ FIFO ===== */

/**
 * Consume the oldest lots first.
 *
 * FIFO is the method the app declares and must therefore apply consistently —
 * switching methods between transactions changes the tax owed and is not
 * defensible in an assessment.
 *
 * `lots` must be ascending by acquisition time. Each needs
 * { id, units, unitsRemaining, costPaise }, where costPaise is the cost of the
 * whole original lot.
 */
export function consumeLots(lots, unitsToSell) {
  var need = roundUnits(unitsToSell);
  var consumed = [];
  var costBasis = 0;

  for (var i = 0; i < lots.length && need > 1e-9; i++) {
    var lot = lots[i];
    var avail = roundUnits(lot.unitsRemaining != null ? lot.unitsRemaining : lot.units);
    if (avail <= 0) continue;

    var take = Math.min(avail, need);
    take = roundUnits(take);

    // Pro-rate the original cost by the fraction of the lot being taken.
    // Rounded so partial consumptions of a lot sum back to its full cost
    // rather than leaking a paise per split.
    var lotCost = Math.round(lot.costPaise * (take / lot.units));

    consumed.push({
      lotId: lot.id,
      units: take,
      costPaise: lotCost,
      nav: lot.nav,
      acquiredAt: lot.acquiredAt,
      unitsRemainingAfter: roundUnits(avail - take)
    });

    costBasis += lotCost;
    need = roundUnits(need - take);
  }

  return {
    consumed: consumed,
    costBasisPaise: costBasis,
    shortfall: need > 1e-9 ? need : 0,
    fullyCovered: need <= 1e-9
  };
}

/* ================================================================ sell ===== */

/**
 * TDS rate and whether it applies at all.
 *
 * Below the annual threshold nothing is withheld. Crossing it makes the whole
 * transfer liable, not just the excess.
 */
export function tdsAssessment(grossPaise, ctx) {
  var t = cfg().tax;
  var c = ctx || {};
  var priorFyGross = c.fyGrossProceedsPaise || 0;
  var threshold = c.isSpecifiedPerson ? t.tdsThresholdSpecifiedPaise : t.tdsThresholdPaise;
  var rate = c.hasPan === false ? t.tdsPctNoPan : t.tdsPct;

  var aggregate = priorFyGross + grossPaise;
  var applies = aggregate > threshold;

  return {
    applies: applies,
    rate: rate,
    ratePct: rate,
    thresholdPaise: threshold,
    fyAggregatePaise: aggregate,
    headroomPaise: Math.max(0, threshold - priorFyGross),
    tdsPaise: applies ? pctOfPaise(grossPaise, rate) : 0,
    reason: !applies
      ? 'Below the \u20b9' + (threshold / 100).toLocaleString('en-IN') +
        ' annual threshold for this financial year'
      : (c.hasPan === false
          ? 'No PAN on record \u2014 section 206AA applies ' + rate + '%'
          : 'Section 194S, ' + rate + '% of gross consideration')
  };
}

/**
 * Quote a redemption, end to end.
 *
 * @param units    ARV units to redeem
 * @param nav      current ARV price in rupees
 * @param lots     open FIFO lots, ascending by acquisition
 * @param ctx      { hasPan, isSpecifiedPerson, fyGrossProceedsPaise, availableUnits }
 */
export function quoteSell(units, nav, lots, ctx) {
  var f = cfg().fees;
  var t = cfg().tax;
  var c = ctx || {};
  var u = roundUnits(units);

  var errors = [];
  if (!nav || nav <= 0) errors.push('No live price available \u2014 cannot quote a redemption');
  if (u <= 0) errors.push('Enter the number of units to redeem');
  if (c.availableUnits != null && u > roundUnits(c.availableUnits) + 1e-9) {
    errors.push('You hold ' + roundUnits(c.availableUnits) + ' units');
  }

  var xnav = nav ? execNav(nav, 'sell') : 0;
  var gross = xnav > 0 ? Math.floor(u * xnav * 100) : 0;

  if (gross > 0 && gross < f.minRedeemPaise) {
    errors.push('Minimum redemption is \u20b9' + (f.minRedeemPaise / 100).toLocaleString('en-IN'));
  }

  var fee = pctOfPaise(gross, f.exitPct);
  var gst = pctOfPaise(fee, f.gstPct);

  // Cost basis, FIFO.
  var fifo = consumeLots(lots || [], u);
  if (!fifo.fullyCovered && (lots || []).length) {
    errors.push('Cost basis covers only part of these units \u2014 lot data is incomplete');
  }

  // Gain is gross minus cost of acquisition. Fees are deliberately NOT
  // subtracted: section 115BBH allows no deduction other than cost.
  var taxableBase = t.feesDeductible ? (gross - fee - gst) : gross;
  var pnl = taxableBase - fifo.costBasisPaise;

  var gain = Math.max(0, pnl);
  var loss = Math.max(0, -pnl);

  // A loss is recorded and then discarded for tax. No set-off, no carry-forward.
  var tax = pctOfPaise(gain, t.vdaGainPct);
  var cess = pctOfPaise(tax, t.cessPct);

  var tds = tdsAssessment(gross, c);

  // Withheld now: fee, GST and TDS. NOT the 30% + cess.
  var netPayout = gross - fee - gst - tds.tdsPaise;

  return {
    side: 'sell',
    units: u,
    nav: nav,
    execNav: xnav,
    slippagePct: f.slippagePct,

    grossPaise: gross,
    feePaise: fee,
    gstPaise: gst,
    totalChargesPaise: fee + gst,

    costBasisPaise: fifo.costBasisPaise,
    lotsConsumed: fifo.consumed,
    avgCostNav: u > 0 ? (fifo.costBasisPaise / 100) / u : 0,

    pnlPaise: pnl,
    realisedGainPaise: gain,
    realisedLossPaise: loss,
    pnlPct: fifo.costBasisPaise > 0 ? (pnl / fifo.costBasisPaise) * 100 : 0,

    // Withheld at source, reduces the payout.
    tdsPaise: tds.tdsPaise,
    tds: tds,

    // The user's own liability, NOT withheld. Reported, not collected.
    taxPaise: tax,
    cessPaise: cess,
    totalTaxLiabilityPaise: tax + cess,
    effectiveTaxRatePct: t.vdaGainPct * (1 + t.cessPct / 100),

    // TDS already withheld is creditable against the liability above.
    balanceTaxPayablePaise: Math.max(0, (tax + cess) - tds.tdsPaise),

    netPayoutPaise: netPayout,
    // What actually remains after the user later settles their tax bill.
    netAfterTaxPaise: netPayout - Math.max(0, (tax + cess) - tds.tdsPaise),

    lossNotSetOff: loss > 0,
    fy: fyOf(Date.now()),
    errors: errors,
    valid: errors.length === 0 && gross > 0
  };
}

/* ====================================================== position maths ===== */

/**
 * Current position value and unrealised P&L.
 * Unrealised gains are not taxable — nothing is owed until a transfer happens.
 */
export function position(holding, nav) {
  var units = roundUnits((holding && holding.units) || 0);
  var invested = (holding && holding.investedPaise) || 0;
  var value = nav ? Math.floor(units * nav * 100) : 0;
  var pnl = value - invested;

  return {
    units: units,
    investedPaise: invested,
    valuePaise: value,
    nav: nav,
    avgCostNav: units > 0 ? (invested / 100) / units : 0,
    unrealisedPnlPaise: pnl,
    unrealisedPnlPct: invested > 0 ? (pnl / invested) * 100 : 0,
    realisedPnlPaise: (holding && holding.realisedGainPaise) || 0,
    // Explicit, because a dashboard that shows a big green number next to an
    // untaxed gain invites the wrong mental model.
    estimatedTaxIfSoldPaise: pnl > 0
      ? pctOfPaise(pnl, cfg().tax.vdaGainPct) +
        pctOfPaise(pctOfPaise(pnl, cfg().tax.vdaGainPct), cfg().tax.cessPct)
      : 0
  };
}

/* ========================================================= FY rollup ====== */

/**
 * Aggregate a set of transactions into a financial-year tax summary.
 *
 * Gains and losses are summed separately and never netted, mirroring how the
 * liability actually works. `taxOnGains` therefore uses gains only, which is
 * why it can exceed what a naive net-P&L view would suggest.
 */
export function fySummary(transactions, fy) {
  var t = cfg().tax;
  var rows = (transactions || []).filter(function (x) {
    return x.type === 'redeem' &&
           (x.status === 'confirmed' || x.status === 'settled') &&
           (!fy || x.fy === fy);
  });

  var s = {
    fy: fy || null,
    txnCount: rows.length,
    grossProceedsPaise: 0,
    costBasisPaise: 0,
    realisedGainPaise: 0,
    realisedLossPaise: 0,
    feesPaise: 0,
    gstPaise: 0,
    tdsWithheldPaise: 0
  };

  rows.forEach(function (x) {
    s.grossProceedsPaise += x.grossPaise || 0;
    s.costBasisPaise += x.costBasisPaise || 0;
    var pnl = (x.realisedGainPaise != null)
      ? x.realisedGainPaise
      : ((x.grossPaise || 0) - (x.costBasisPaise || 0));
    if (pnl >= 0) s.realisedGainPaise += pnl; else s.realisedLossPaise += -pnl;
    s.feesPaise += x.feePaise || 0;
    s.gstPaise += x.gstPaise || 0;
    s.tdsWithheldPaise += x.tdsPaise || 0;
  });

  s.taxPaise = pctOfPaise(s.realisedGainPaise, t.vdaGainPct);
  s.cessPaise = pctOfPaise(s.taxPaise, t.cessPct);
  s.totalTaxPaise = s.taxPaise + s.cessPaise;
  s.balancePayablePaise = Math.max(0, s.totalTaxPaise - s.tdsWithheldPaise);
  s.refundDuePaise = Math.max(0, s.tdsWithheldPaise - s.totalTaxPaise);
  s.netPnlPaise = s.realisedGainPaise - s.realisedLossPaise;
  // The cost of the no-set-off rule, made visible.
  s.taxOnDisallowedLossPaise = pctOfPaise(s.realisedLossPaise, t.vdaGainPct);
  s.effectiveRateOnNetPct = s.netPnlPaise > 0
    ? (s.totalTaxPaise / s.netPnlPaise) * 100
    : null;

  return s;
}

/**
 * Human-readable itemisation of a quote, for the confirmation screen.
 * Order matters: charges withheld now, then liability owed later.
 */
export function explainSell(q) {
  return [
    { label: 'Gross redemption value', paise: q.grossPaise, kind: 'gross' },
    { label: 'Exit fee (' + cfg().fees.exitPct + '%)', paise: -q.feePaise, kind: 'charge' },
    { label: 'GST on fee (' + cfg().fees.gstPct + '%)', paise: -q.gstPaise, kind: 'charge' },
    {
      label: 'TDS withheld' + (q.tds.applies ? ' (' + q.tds.ratePct + '%, s.194S)' : ' \u2014 none'),
      paise: -q.tdsPaise, kind: 'tds', note: q.tds.reason
    },
    { label: 'Credited to your UPI', paise: q.netPayoutPaise, kind: 'net' },
    { divider: true },
    { label: 'Cost of acquisition (FIFO)', paise: q.costBasisPaise, kind: 'info' },
    {
      label: q.pnlPaise >= 0 ? 'Realised gain' : 'Realised loss',
      paise: q.pnlPaise, kind: 'pnl'
    },
    {
      label: 'Tax on gain (' + cfg().tax.vdaGainPct + '% + ' + cfg().tax.cessPct + '% cess)',
      paise: q.totalTaxLiabilityPaise, kind: 'liability',
      note: 'Not withheld \u2014 payable by you when you file your return'
    },
    {
      label: 'Less TDS already withheld', paise: -q.tdsPaise, kind: 'liability'
    },
    {
      label: 'Balance tax payable at filing', paise: q.balanceTaxPayablePaise, kind: 'liability-total'
    }
  ].concat(q.lossNotSetOff ? [{
    label: 'Note',
    kind: 'warning',
    note: 'This loss cannot be set off against other gains or carried forward (s.115BBH).'
  }] : []);
}
