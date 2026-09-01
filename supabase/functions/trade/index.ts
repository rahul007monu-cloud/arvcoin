/**
 * Trade execution.
 *
 * The only path that may create units, consume lots, or move money. It runs with
 * the service role because row level security deliberately forbids the browser
 * from writing holdings, lots, transactions or tax records at all.
 *
 * Three actions:
 *
 *   create_deposit  — records an intent and returns a reference. Issues nothing.
 *   confirm_deposit — operator-only. Issues units at the CURRENT price.
 *   redeem          — consumes FIFO lots, withholds fee/GST/TDS, queues a payout.
 *
 * Why confirmation is separate from creation
 * ------------------------------------------
 * A UPI QR produces no callback and carries no signature. Nothing about
 * displaying one tells this service that money arrived. So `create_deposit`
 * issues nothing, and units come into existence only when someone with operator
 * authority asserts that the bank credit landed — at the price prevailing at that
 * moment, because that is when the treasury can actually buy.
 *
 * A client-side "payment succeeded" callback that mints units is the single most
 * reliable way to have a treasury emptied by someone who never paid.
 */

import {
  admin, caller, requireAdmin, loadConfig, ledger, currentNav,
  HttpError, CORS, json, fail, audit
} from '../_shared/context.ts';

interface Body {
  action: 'create_deposit' | 'confirm_deposit' | 'redeem';
  amountPaise?: number;
  units?: number;
  ref?: string;
  upiRef?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const db = admin();
    const user = await caller(req);
    const body = (await req.json()) as Body;

    await loadConfig(db);
    const L = await ledger();

    switch (body.action) {
      case 'create_deposit':  return await createDeposit(db, user, body, L);
      case 'confirm_deposit': return await confirmDeposit(db, user, body, L);
      case 'redeem':          return await redeem(db, user, body, L);
      default:
        throw new HttpError(400, 'Unknown action: ' + String(body.action));
    }
  } catch (e) {
    return fail(e);
  }
});

/* ------------------------------------------------------------ create deposit */

async function createDeposit(
  db: ReturnType<typeof admin>,
  user: { id: string },
  body: Body,
  L: Awaited<ReturnType<typeof ledger>>
): Promise<Response> {
  const amountPaise = Math.round(Number(body.amountPaise));
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    throw new HttpError(400, 'A positive amount is required');
  }

  const nav = await currentNav(db);
  const quote = L.quoteBuy(amountPaise, nav);
  if (!quote.valid) throw new HttpError(400, quote.errors[0] ?? 'Invalid deposit');

  const ref = body.ref && /^[A-Z0-9-]{6,32}$/.test(body.ref)
    ? body.ref
    : 'ARV-' + crypto.randomUUID().slice(0, 12).toUpperCase();

  const fy = fyOf(Date.now());

  // The transaction is recorded as awaiting_payment. The unit and price figures
  // here are the indicative quote; they are recomputed on confirmation.
  const { data: txn, error: txnErr } = await db.from('transactions').insert({
    user_id: user.id, ref, type: 'deposit', status: 'awaiting_payment',
    gross_paise: quote.grossPaise,
    fee_paise: quote.feePaise,
    gst_paise: quote.gstPaise,
    net_paise: quote.netInvestPaise,
    units: quote.units,
    nav: quote.execNav,
    slippage_pct: quote.slippagePct,
    fy,
    meta: { indicative: true }
  }).select().single();
  if (txnErr) throw new HttpError(500, txnErr.message);

  const { error: depErr } = await db.from('deposits').insert({
    user_id: user.id, txn_id: txn.id, ref,
    amount_paise: amountPaise,
    status: 'awaiting_payment',
    expires_at: new Date(Date.now() + 30 * 60000).toISOString()
  });
  if (depErr) throw new HttpError(500, depErr.message);

  await audit(db, {
    actor: user.id, action: 'deposit.create', entity: 'deposits', entityId: ref,
    after: { amountPaise, indicativeNav: nav }
  });

  return json({ ref, txn: { id: txn.id, ref }, quote });
}

/* ----------------------------------------------------------- confirm deposit */

async function confirmDeposit(
  db: ReturnType<typeof admin>,
  user: { id: string },
  body: Body,
  L: Awaited<ReturnType<typeof ledger>>
): Promise<Response> {
  // Operator authority is checked here, server-side, against the database. The
  // client showing or hiding a button is not the control.
  await requireAdmin(db, user.id);

  const ref = String(body.ref ?? '');
  if (!ref) throw new HttpError(400, 'A deposit reference is required');

  const { data: dep, error: depErr } = await db
    .from('deposits').select('*').eq('ref', ref).single();
  if (depErr || !dep) throw new HttpError(404, 'Deposit ' + ref + ' not found');
  if (dep.status === 'confirmed') throw new HttpError(409, 'Deposit already confirmed');
  if (dep.status !== 'awaiting_payment') {
    throw new HttpError(409, 'Deposit is ' + dep.status + ' and cannot be confirmed');
  }

  // Price at confirmation, not at QR generation. This is the moment the treasury
  // can actually buy, so it is the moment that sets the price.
  const nav = await currentNav(db);
  const quote = L.quoteBuy(Number(dep.amount_paise), nav);
  if (!quote.valid) throw new HttpError(400, quote.errors[0] ?? 'Cannot price this deposit');

  const { data: lot, error: lotErr } = await db.from('lots').insert({
    user_id: dep.user_id,
    units: quote.units,
    units_remaining: quote.units,
    cost_paise: quote.netInvestPaise,
    nav: quote.execNav,
    txn_id: dep.txn_id
  }).select().single();
  if (lotErr) throw new HttpError(500, 'lot: ' + lotErr.message);

  // Read-modify-write on holdings. Acceptable because confirmation is a
  // single-operator action, not a concurrent user path; a high-volume deployment
  // should move this into a Postgres function so it is atomic.
  const { data: h } = await db.from('holdings')
    .select('*').eq('user_id', dep.user_id).maybeSingle();

  const newUnits = round8(Number(h?.units ?? 0) + quote.units);
  const newInvested = Number(h?.invested_paise ?? 0) + quote.netInvestPaise;

  const { error: hErr } = await db.from('holdings').upsert({
    user_id: dep.user_id,
    units: newUnits,
    invested_paise: newInvested,
    realised_gain_paise: Number(h?.realised_gain_paise ?? 0),
    updated_at: new Date().toISOString()
  });
  if (hErr) throw new HttpError(500, 'holdings: ' + hErr.message);

  // The transaction row's financial fields are frozen by trigger, so the final
  // executed figures are recorded in meta and status advances.
  await db.from('transactions').update({
    status: 'confirmed',
    confirmed_at: new Date().toISOString(),
    upi_ref: body.upiRef ?? null,
    meta: {
      executed: true,
      executedNav: quote.execNav,
      executedUnits: quote.units,
      lotId: lot.id,
      confirmedBy: user.id
    }
  }).eq('id', dep.txn_id);

  await db.from('deposits').update({
    status: 'confirmed',
    confirmed_at: new Date().toISOString(),
    confirmed_by: user.id,
    upi_ref: body.upiRef ?? null
  }).eq('id', dep.id);

  await audit(db, {
    actor: user.id, action: 'deposit.confirm', entity: 'deposits', entityId: ref,
    after: { units: quote.units, nav: quote.execNav, upiRef: body.upiRef ?? null }
  });

  return json({ ref, units: quote.units, quote });
}

/* -------------------------------------------------------------------- redeem */

async function redeem(
  db: ReturnType<typeof admin>,
  user: { id: string },
  body: Body,
  L: Awaited<ReturnType<typeof ledger>>
): Promise<Response> {
  const units = Number(body.units);
  if (!Number.isFinite(units) || units <= 0) {
    throw new HttpError(400, 'A positive number of units is required');
  }

  const [{ data: h }, { data: profile }, { data: lotRows }] = await Promise.all([
    db.from('holdings').select('*').eq('user_id', user.id).maybeSingle(),
    db.from('profiles').select('pan,upi_vpa,is_specified_person,full_name').eq('id', user.id).single(),
    db.from('lots').select('*').eq('user_id', user.id)
      .gt('units_remaining', 0).order('acquired_at', { ascending: true })
  ]);

  if (!h || Number(h.units) <= 0) throw new HttpError(400, 'You hold no units');
  if (!profile?.upi_vpa) {
    throw new HttpError(400, 'Add a payout UPI ID to your profile before redeeming');
  }

  const fy = fyOf(Date.now());

  // Gross proceeds already this financial year — decides whether the TDS
  // threshold has been crossed.
  const { data: priorRows } = await db.from('transactions')
    .select('gross_paise').eq('user_id', user.id).eq('type', 'redeem').eq('fy', fy)
    .in('status', ['confirmed', 'settled']);
  const fyGross = (priorRows ?? []).reduce((s, r) => s + Number(r.gross_paise), 0);

  const lots = (lotRows ?? []).map((l) => ({
    id: l.id,
    units: Number(l.units),
    unitsRemaining: Number(l.units_remaining),
    costPaise: Number(l.cost_paise),
    nav: Number(l.nav),
    acquiredAt: Date.parse(l.acquired_at)
  }));

  const nav = await currentNav(db);
  const q = L.quoteSell(units, nav, lots, {
    hasPan: !!profile.pan,
    isSpecifiedPerson: !!profile.is_specified_person,
    fyGrossProceedsPaise: fyGross,
    availableUnits: Number(h.units)
  });
  if (!q.valid) throw new HttpError(400, q.errors[0] ?? 'Invalid redemption');

  const ref = 'RDM-' + crypto.randomUUID().slice(0, 12).toUpperCase();

  // Consume the FIFO lots the quote decided on.
  for (const c of q.lotsConsumed) {
    const { error } = await db.from('lots')
      .update({ units_remaining: c.unitsRemainingAfter })
      .eq('id', c.lotId);
    if (error) throw new HttpError(500, 'lot update: ' + error.message);
  }

  const { data: txn, error: txnErr } = await db.from('transactions').insert({
    user_id: user.id, ref, type: 'redeem', status: 'confirmed',
    gross_paise: q.grossPaise,
    fee_paise: q.feePaise,
    gst_paise: q.gstPaise,
    tds_paise: q.tdsPaise,
    net_paise: q.netPayoutPaise,
    units: q.units,
    nav: q.execNav,
    slippage_pct: q.slippagePct,
    cost_basis_paise: q.costBasisPaise,
    realised_gain_paise: q.pnlPaise,
    tax_paise: q.taxPaise,
    cess_paise: q.cessPaise,
    fy,
    upi_vpa: profile.upi_vpa,
    confirmed_at: new Date().toISOString(),
    meta: {
      lotsConsumed: q.lotsConsumed,
      tds: q.tds,
      // Recorded because it is a liability the holder owes but this platform does
      // not collect. Keeping it on the row means the tax statement never has to
      // re-derive it from rates that may since have changed.
      taxLiabilityPaise: q.totalTaxLiabilityPaise,
      balanceTaxPayablePaise: q.balanceTaxPayablePaise
    }
  }).select().single();
  if (txnErr) throw new HttpError(500, txnErr.message);

  await db.from('holdings').update({
    units: round8(Number(h.units) - q.units),
    invested_paise: Math.max(0, Number(h.invested_paise) - q.costBasisPaise),
    realised_gain_paise: Number(h.realised_gain_paise) + q.pnlPaise,
    updated_at: new Date().toISOString()
  }).eq('user_id', user.id);

  await db.from('payouts').insert({
    user_id: user.id, txn_id: txn.id, ref,
    amount_paise: q.netPayoutPaise,
    upi_vpa: profile.upi_vpa,
    status: 'pending'
  });

  // FY tax ledger. Gains and losses are accumulated separately and never netted,
  // because section 115BBH permits no set-off.
  const { data: tl } = await db.from('tax_ledger')
    .select('*').eq('user_id', user.id).eq('fy', fy).maybeSingle();

  await db.from('tax_ledger').upsert({
    user_id: user.id, fy,
    gross_proceeds_paise: Number(tl?.gross_proceeds_paise ?? 0) + q.grossPaise,
    cost_basis_paise: Number(tl?.cost_basis_paise ?? 0) + q.costBasisPaise,
    realised_gain_paise: Number(tl?.realised_gain_paise ?? 0) + q.realisedGainPaise,
    realised_loss_paise: Number(tl?.realised_loss_paise ?? 0) + q.realisedLossPaise,
    tax_paise: Number(tl?.tax_paise ?? 0) + q.taxPaise,
    cess_paise: Number(tl?.cess_paise ?? 0) + q.cessPaise,
    tds_withheld_paise: Number(tl?.tds_withheld_paise ?? 0) + q.tdsPaise,
    fees_paise: Number(tl?.fees_paise ?? 0) + q.feePaise + q.gstPaise,
    txn_count: Number(tl?.txn_count ?? 0) + 1,
    updated_at: new Date().toISOString()
  });

  await audit(db, {
    actor: user.id, action: 'redeem', entity: 'transactions', entityId: ref,
    after: {
      units: q.units, nav: q.execNav, gross: q.grossPaise,
      tds: q.tdsPaise, net: q.netPayoutPaise, gain: q.pnlPaise
    }
  });

  return json({ ref, txn: { id: txn.id, ref }, quote: q });
}

/* -------------------------------------------------------------------- utils */

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/** Indian financial year label, April to March. */
function fyOf(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() + 1 >= 4 ? y : y - 1;
  return startYear + '-' + String((startYear + 1) % 100).padStart(2, '0');
}
