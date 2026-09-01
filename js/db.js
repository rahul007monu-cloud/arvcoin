/**
 * Data layer.
 *
 * One interface, two backends:
 *
 *   supabase — Postgres with row level security. Reads come straight from the
 *              database; every write that touches money or units goes through an
 *              Edge Function holding the service role key. The browser cannot
 *              write its own balance, by design.
 *
 *   local    — localStorage, same shape, same ledger maths. Exists so the app is
 *              fully explorable before any credentials are configured: live
 *              prices, real charts, real fee and tax arithmetic, working buy and
 *              redeem flows. Nothing leaves the browser and nothing survives a
 *              cleared cache.
 *
 * The mode is chosen from config, and `mode()` is surfaced in the UI so it is
 * never ambiguous which one is in play. Local mode runs the ledger client-side
 * out of necessity — that is precisely what RLS exists to prevent in the real
 * backend, and why it must not be treated as the production path.
 */

import * as ledger from './ledger.js';
import { makeRef, fyOf, roundUnits } from './money.js';

var CFG = globalThis.ARV_CONFIG;
var LS = 'arv.local.v2';

var sb = null;
var sbLoad = null;
var listeners = [];

/* ================================================================== mode === */

export function configured() {
  return !!(CFG.SUPABASE.url && CFG.SUPABASE.anonKey);
}

export function mode() {
  return configured() ? 'supabase' : 'local';
}

function functionsBase() {
  return CFG.SUPABASE.functionsBase || (CFG.SUPABASE.url + '/functions/v1');
}

/** Lazily load supabase-js only when it is actually going to be used. */
async function client() {
  if (sb) return sb;
  if (!configured()) return null;
  if (!sbLoad) {
    sbLoad = (async function () {
      var mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      sb = mod.createClient(CFG.SUPABASE.url, CFG.SUPABASE.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      sb.auth.onAuthStateChange(function (_e, session) {
        emit(session ? session.user : null);
      });
      return sb;
    })();
  }
  return sbLoad;
}

function emit(user) {
  listeners.forEach(function (fn) { try { fn(user); } catch (_) {} });
}

export function onAuthChange(fn) {
  listeners.push(fn);
  return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
}

/* ============================================================ local store == */

function blank() {
  return {
    user: null,
    profile: null,
    holdings: { units: 0, investedPaise: 0, realisedGainPaise: 0 },
    lots: [],
    transactions: [],
    deposits: [],
    payouts: [],
    orders: [],
    alerts: [],
    candles: {}
  };
}

function load() {
  try {
    var raw = localStorage.getItem(LS);
    if (!raw) return blank();
    var d = JSON.parse(raw);
    return Object.assign(blank(), d);
  } catch (_) { return blank(); }
}

function save(d) {
  try { localStorage.setItem(LS, JSON.stringify(d)); }
  catch (_) { /* quota or private mode — the session still works in memory */ }
}

/* ==================================================================== auth = */

export async function signUp(email, password, fullName) {
  if (mode() === 'local') {
    var d = load();
    d.user = { id: 'local-' + btoa(email).replace(/=/g, '').slice(0, 12), email: email };
    d.profile = {
      id: d.user.id, email: email, fullName: fullName || '',
      pan: '', panVerified: false, upiVpa: '',
      kycStatus: 'none', isSpecifiedPerson: false, isAdmin: true
    };
    save(d);
    emit(d.user);
    return { user: d.user };
  }

  var c = await client();
  var res = await c.auth.signUp({
    email: email, password: password,
    options: { data: { full_name: fullName || '' } }
  });
  if (res.error) throw res.error;
  return { user: res.data.user, session: res.data.session };
}

export async function signIn(email, password) {
  if (mode() === 'local') {
    var d = load();
    if (!d.user) {
      // Local mode has no password store; first sign-in creates the account.
      return signUp(email, password, '');
    }
    emit(d.user);
    return { user: d.user };
  }
  var c = await client();
  var res = await c.auth.signInWithPassword({ email: email, password: password });
  if (res.error) throw res.error;
  return { user: res.data.user, session: res.data.session };
}

export async function signInWithGoogle() {
  if (mode() === 'local') throw new Error('Google sign-in needs Supabase configured');
  var c = await client();
  var res = await c.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + '/dashboard.html' }
  });
  if (res.error) throw res.error;
  return res.data;
}

export async function signOut() {
  if (mode() === 'local') {
    var d = load();
    d.user = null;
    save(d);
    emit(null);
    return;
  }
  var c = await client();
  await c.auth.signOut();
  emit(null);
}

export async function currentUser() {
  if (mode() === 'local') return load().user;
  var c = await client();
  if (!c) return null;
  var res = await c.auth.getUser();
  return res.data ? res.data.user : null;
}

/** Redirect to login when there is no session. Returns the user otherwise. */
export async function requireUser(redirect) {
  var u = await currentUser();
  if (!u) {
    var to = redirect || 'login.html';
    var back = encodeURIComponent(location.pathname.replace(/^\//, '') + location.search);
    location.replace(to + '?next=' + back);
    return null;
  }
  return u;
}

/* ================================================================ profile = */

export async function getProfile() {
  if (mode() === 'local') return load().profile;
  var c = await client();
  var u = await currentUser();
  if (!u) return null;
  var r = await c.from('profiles').select('*').eq('id', u.id).single();
  if (r.error) throw r.error;
  return camel(r.data);
}

export async function updateProfile(patch) {
  if (mode() === 'local') {
    var d = load();
    d.profile = Object.assign({}, d.profile, patch);
    save(d);
    return d.profile;
  }
  var c = await client();
  var u = await currentUser();
  // Only the columns a user is permitted to set. The database enforces this too
  // (profile_guard), but sending fields that will be rejected is a bad request,
  // not a security boundary.
  var allowed = {};
  ['full_name', 'pan', 'upi_vpa'].forEach(function (k) {
    var camelKey = k.replace(/_(\w)/g, function (_, x) { return x.toUpperCase(); });
    if (patch[camelKey] !== undefined) allowed[k] = patch[camelKey];
    if (patch[k] !== undefined) allowed[k] = patch[k];
  });
  if (patch.submitKyc) allowed.kyc_status = 'pending';

  var r = await c.from('profiles').update(allowed).eq('id', u.id).select().single();
  if (r.error) throw r.error;
  return camel(r.data);
}

/* =============================================================== holdings = */

export async function getHoldings() {
  if (mode() === 'local') return load().holdings;
  var c = await client();
  var u = await currentUser();
  if (!u) return { units: 0, investedPaise: 0, realisedGainPaise: 0 };
  var r = await c.from('holdings').select('*').eq('user_id', u.id).maybeSingle();
  if (r.error) throw r.error;
  if (!r.data) return { units: 0, investedPaise: 0, realisedGainPaise: 0 };
  return {
    units: Number(r.data.units),
    investedPaise: Number(r.data.invested_paise),
    realisedGainPaise: Number(r.data.realised_gain_paise)
  };
}

/** Open FIFO lots, oldest first — the order cost basis must be consumed in. */
export async function getLots() {
  if (mode() === 'local') {
    return load().lots
      .filter(function (l) { return l.unitsRemaining > 1e-9; })
      .sort(function (a, b) { return a.acquiredAt - b.acquiredAt; });
  }
  var c = await client();
  var u = await currentUser();
  var r = await c.from('lots').select('*')
    .eq('user_id', u.id).gt('units_remaining', 0)
    .order('acquired_at', { ascending: true });
  if (r.error) throw r.error;
  return r.data.map(function (l) {
    return {
      id: l.id,
      units: Number(l.units),
      unitsRemaining: Number(l.units_remaining),
      costPaise: Number(l.cost_paise),
      nav: Number(l.nav),
      acquiredAt: Date.parse(l.acquired_at)
    };
  });
}

/* =========================================================== transactions = */

export async function getTransactions(opts) {
  var o = opts || {};
  if (mode() === 'local') {
    var rows = load().transactions.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
    if (o.type) rows = rows.filter(function (t) { return t.type === o.type; });
    if (o.fy) rows = rows.filter(function (t) { return t.fy === o.fy; });
    if (o.status) rows = rows.filter(function (t) { return t.status === o.status; });
    return o.limit ? rows.slice(0, o.limit) : rows;
  }
  var c = await client();
  var u = await currentUser();
  var q = c.from('transactions').select('*').eq('user_id', u.id)
    .order('created_at', { ascending: false });
  if (o.type) q = q.eq('type', o.type);
  if (o.fy) q = q.eq('fy', o.fy);
  if (o.status) q = q.eq('status', o.status);
  if (o.limit) q = q.limit(o.limit);
  var r = await q;
  if (r.error) throw r.error;
  return r.data.map(camelTxn);
}

/** Gross redemption proceeds so far this FY — drives the TDS threshold test. */
export async function fyGrossProceeds(fy) {
  var f = fy || fyOf(Date.now());
  var rows = await getTransactions({ type: 'redeem', fy: f });
  return rows
    .filter(function (t) { return t.status === 'confirmed' || t.status === 'settled'; })
    .reduce(function (s, t) { return s + (t.grossPaise || 0); }, 0);
}

/* ================================================================ trading = */

/**
 * Start a deposit.
 *
 * Creates an awaiting_payment record and returns the reference to put in the
 * UPI note. Units are NOT issued here — a QR cannot tell the app that money
 * arrived, so issuance waits for confirmation, and happens at the NAV of the
 * confirmation moment because that is when the treasury can actually buy.
 */
export async function createDeposit(amountPaise, nav) {
  var ref = makeRef('ARV');

  if (mode() === 'local') {
    var d = load();
    var q = ledger.quoteBuy(amountPaise, nav);
    if (!q.valid) throw new Error(q.errors[0] || 'Invalid deposit');

    var txn = {
      id: ref, ref: ref, userId: d.user ? d.user.id : 'local',
      type: 'deposit', status: 'awaiting_payment',
      grossPaise: q.grossPaise, feePaise: q.feePaise, gstPaise: q.gstPaise,
      tdsPaise: 0, netPaise: q.netInvestPaise,
      units: q.units, nav: q.execNav, slippagePct: q.slippagePct,
      fy: fyOf(Date.now()), createdAt: Date.now()
    };
    d.transactions.push(txn);
    d.deposits.push({
      id: ref, ref: ref, amountPaise: amountPaise,
      status: 'awaiting_payment', createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60000
    });
    save(d);
    return { ref: ref, txn: txn, quote: q };
  }

  return await callFunction('trade', {
    action: 'create_deposit',
    amountPaise: amountPaise,
    ref: ref
  });
}

/**
 * Confirm a deposit and issue units.
 *
 * In the real backend this is operator-only (or a verified PSP webhook). It is
 * exposed here because with a bare UPI QR there is nothing to verify against —
 * see SETUP.md. What must never happen is a client-side "payment succeeded"
 * callback minting units, which is why even in Supabase mode this call is an
 * Edge Function that re-checks the caller's admin flag server-side.
 */
export async function confirmDeposit(ref, nav, upiRef) {
  if (mode() === 'local') {
    var d = load();
    var dep = d.deposits.find(function (x) { return x.ref === ref; });
    var txn = d.transactions.find(function (x) { return x.ref === ref; });
    if (!dep || !txn) throw new Error('Deposit ' + ref + ' not found');
    if (dep.status === 'confirmed') throw new Error('Deposit already confirmed');

    // Re-quote at the current NAV, not the NAV shown when the QR was generated.
    var q = ledger.quoteBuy(dep.amountPaise, nav);
    if (!q.valid) throw new Error(q.errors[0] || 'Cannot confirm at the current price');

    dep.status = 'confirmed';
    dep.confirmedAt = Date.now();
    dep.upiRef = upiRef || '';

    txn.status = 'confirmed';
    txn.confirmedAt = Date.now();
    txn.units = q.units;
    txn.nav = q.execNav;
    txn.netPaise = q.netInvestPaise;
    txn.upiRef = upiRef || '';

    d.lots.push({
      id: 'LOT-' + ref,
      units: q.units, unitsRemaining: q.units,
      costPaise: q.netInvestPaise, nav: q.execNav,
      acquiredAt: Date.now(), txnId: ref
    });

    d.holdings.units = roundUnits(d.holdings.units + q.units);
    d.holdings.investedPaise += q.netInvestPaise;

    save(d);
    return { ref: ref, units: q.units, quote: q };
  }

  return await callFunction('trade', {
    action: 'confirm_deposit', ref: ref, upiRef: upiRef
  });
}

/**
 * Redeem units.
 *
 * Consumes FIFO lots, computes cost basis, withholds fee + GST + TDS, records
 * the 30% + cess as a reported liability rather than a deduction, and queues a
 * payout to the user's saved UPI ID.
 */
export async function redeem(units, nav, ctx) {
  if (mode() === 'local') {
    var d = load();
    var lots = d.lots
      .filter(function (l) { return l.unitsRemaining > 1e-9; })
      .sort(function (a, b) { return a.acquiredAt - b.acquiredAt; });

    var q = ledger.quoteSell(units, nav, lots, Object.assign({
      availableUnits: d.holdings.units,
      hasPan: !!(d.profile && d.profile.pan),
      isSpecifiedPerson: !!(d.profile && d.profile.isSpecifiedPerson),
      fyGrossProceedsPaise: await fyGrossProceeds()
    }, ctx || {}));

    if (!q.valid) throw new Error(q.errors[0] || 'Invalid redemption');

    var ref = makeRef('RDM');

    // Apply the FIFO consumption back onto the stored lots.
    q.lotsConsumed.forEach(function (cons) {
      var lot = d.lots.find(function (l) { return l.id === cons.lotId; });
      if (lot) lot.unitsRemaining = cons.unitsRemainingAfter;
    });

    d.holdings.units = roundUnits(d.holdings.units - q.units);
    d.holdings.investedPaise = Math.max(0, d.holdings.investedPaise - q.costBasisPaise);
    d.holdings.realisedGainPaise += q.pnlPaise;

    var txn = {
      id: ref, ref: ref, userId: d.user ? d.user.id : 'local',
      type: 'redeem', status: 'confirmed',
      grossPaise: q.grossPaise, feePaise: q.feePaise, gstPaise: q.gstPaise,
      tdsPaise: q.tdsPaise, netPaise: q.netPayoutPaise,
      units: q.units, nav: q.execNav, slippagePct: q.slippagePct,
      costBasisPaise: q.costBasisPaise,
      realisedGainPaise: q.pnlPaise,
      taxPaise: q.taxPaise, cessPaise: q.cessPaise,
      fy: q.fy, createdAt: Date.now(), confirmedAt: Date.now(),
      upiVpa: (d.profile && d.profile.upiVpa) || ''
    };
    d.transactions.push(txn);
    d.payouts.push({
      id: ref, ref: ref, amountPaise: q.netPayoutPaise,
      upiVpa: (d.profile && d.profile.upiVpa) || '',
      status: 'pending', createdAt: Date.now()
    });

    save(d);
    return { ref: ref, txn: txn, quote: q };
  }

  return await callFunction('trade', {
    action: 'redeem', units: units
  });
}

/* ================================================================= orders = */

export async function getOrders() {
  if (mode() === 'local') {
    return load().orders.filter(function (o) { return o.status === 'open'; });
  }
  var c = await client();
  var u = await currentUser();
  var r = await c.from('orders').select('*').eq('user_id', u.id).eq('status', 'open')
    .order('created_at', { ascending: false });
  if (r.error) throw r.error;
  return r.data.map(camel);
}

export async function placeOrder(o) {
  if (mode() === 'local') {
    var d = load();
    var row = Object.assign({
      id: makeRef('ORD'), status: 'open', createdAt: Date.now()
    }, o);
    d.orders.push(row);
    save(d);
    return row;
  }
  var c = await client();
  var u = await currentUser();
  var r = await c.from('orders').insert({
    user_id: u.id, side: o.side, trigger_nav: o.triggerNav,
    direction: o.direction, amount_paise: o.amountPaise || null,
    units: o.units || null, status: 'open'
  }).select().single();
  if (r.error) throw r.error;
  return camel(r.data);
}

export async function cancelOrder(id) {
  if (mode() === 'local') {
    var d = load();
    var o = d.orders.find(function (x) { return x.id === id; });
    if (o) o.status = 'cancelled';
    save(d);
    return;
  }
  var c = await client();
  var r = await c.from('orders').update({ status: 'cancelled' }).eq('id', id);
  if (r.error) throw r.error;
}

/* =============================================================== payouts == */

export async function getPayouts() {
  if (mode() === 'local') return load().payouts.slice().reverse();
  var c = await client();
  var u = await currentUser();
  var r = await c.from('payouts').select('*').eq('user_id', u.id)
    .order('created_at', { ascending: false });
  if (r.error) throw r.error;
  return r.data.map(camel);
}

export async function getDeposits() {
  if (mode() === 'local') return load().deposits.slice().reverse();
  var c = await client();
  var u = await currentUser();
  var r = await c.from('deposits').select('*').eq('user_id', u.id)
    .order('created_at', { ascending: false });
  if (r.error) throw r.error;
  return r.data.map(camel);
}

/* ============================================================ stored candles */

/**
 * ARV candles from the database.
 *
 * This is what lets the chart outgrow the exchanges' history limits: the ingest
 * worker appends a candle a minute, so the series accumulates locally and after
 * a month there is a month of real minute history no third party can withdraw.
 * Returns null when unavailable, so callers fall back to computing from live
 * exchange data.
 */
export async function getStoredCandles(tf, fromMs, limit) {
  if (mode() === 'local') return null;
  try {
    var c = await client();
    var q = c.from('arv_candles').select('ts,open,high,low,close,volume')
      .eq('tf', tf).order('ts', { ascending: false })
      .limit(limit || CFG.CHARTS.maxCandles);
    if (fromMs) q = q.gte('ts', new Date(fromMs).toISOString());
    var r = await q;
    if (r.error || !r.data || !r.data.length) return null;
    return r.data.map(function (k) {
      return {
        t: Date.parse(k.ts), o: Number(k.open), h: Number(k.high),
        l: Number(k.low), c: Number(k.close), v: Number(k.volume)
      };
    }).sort(function (a, b) { return a.t - b.t; });
  } catch (_) { return null; }
}

/* ================================================================ treasury = */

export async function getTreasury() {
  if (mode() === 'local') {
    var d = load();
    return {
      unitsOutstanding: d.holdings.units,
      netInvestedPaise: d.holdings.investedPaise,
      holderCount: d.holdings.units > 0 ? 1 : 0,
      feesCollectedPaise: d.transactions.reduce(function (s, t) {
        return s + (t.feePaise || 0) + (t.gstPaise || 0);
      }, 0),
      tdsWithheldPaise: d.transactions.reduce(function (s, t) {
        return s + (t.tdsPaise || 0);
      }, 0)
    };
  }
  var c = await client();
  var r = await c.from('treasury_summary').select('*').single();
  if (r.error) throw r.error;
  return {
    unitsOutstanding: Number(r.data.units_outstanding),
    netInvestedPaise: Number(r.data.net_invested_paise),
    latestNav: r.data.latest_nav != null ? Number(r.data.latest_nav) : null,
    holderCount: Number(r.data.holder_count),
    feesCollectedPaise: Number(r.data.fees_collected_paise),
    tdsWithheldPaise: Number(r.data.tds_withheld_paise)
  };
}

/* =============================================================== functions = */

async function callFunction(name, body) {
  var c = await client();
  var session = await c.auth.getSession();
  var token = session.data.session ? session.data.session.access_token : CFG.SUPABASE.anonKey;

  var res = await fetch(functionsBase() + '/' + name, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
      apikey: CFG.SUPABASE.anonKey
    },
    body: JSON.stringify(body)
  });

  var json = null;
  try { json = await res.json(); } catch (_) {}

  if (!res.ok) {
    throw new Error((json && (json.error || json.message)) || ('Request failed (' + res.status + ')'));
  }
  return json;
}

/* ================================================================== utils == */

/** snake_case -> camelCase, shallow. */
function camel(row) {
  if (!row) return row;
  var out = {};
  Object.keys(row).forEach(function (k) {
    out[k.replace(/_(\w)/g, function (_, c) { return c.toUpperCase(); })] = row[k];
  });
  return out;
}

/** Transactions need their numerics coerced — Postgres returns them as strings. */
function camelTxn(row) {
  var t = camel(row);
  ['grossPaise', 'feePaise', 'gstPaise', 'tdsPaise', 'netPaise',
   'costBasisPaise', 'realisedGainPaise', 'taxPaise', 'cessPaise'].forEach(function (k) {
    if (t[k] != null) t[k] = Number(t[k]);
  });
  if (t.units != null) t.units = Number(t.units);
  if (t.nav != null) t.nav = Number(t.nav);
  t.createdAt = t.createdAt ? Date.parse(t.createdAt) : Date.now();
  if (t.confirmedAt) t.confirmedAt = Date.parse(t.confirmedAt);
  if (t.settledAt) t.settledAt = Date.parse(t.settledAt);
  return t;
}

/** Wipe local-mode data. Only meaningful in local mode. */
export function resetLocal() {
  try { localStorage.removeItem(LS); } catch (_) {}
}

export function localSnapshot() {
  return mode() === 'local' ? load() : null;
}
