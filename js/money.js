/**
 * Money and unit arithmetic.
 *
 * Two rules that the rest of the app depends on:
 *
 *   1. Rupee amounts are integers, in paise. Never floats. A float rupee
 *      amount will eventually produce a ledger that does not balance, and a
 *      ledger that does not balance in a financial product is not a rounding
 *      bug, it is a missing-money bug.
 *
 *   2. ARV units carry 8 decimal places and are rounded to exactly that at
 *      every boundary. Postgres stores them as NUMERIC(28,8) so the database
 *      is exact; this module keeps JavaScript from drifting away from it.
 *
 * Every rounding decision is explicit. There is no implicit truncation.
 */

var CFG = globalThis.ARV_CONFIG;
var UNIT_SCALE = 1e8;

/* ------------------------------------------------------------------ paise ---- */

/** Rupees (number or numeric string) -> integer paise. */
export function toPaise(rupees) {
  var n = typeof rupees === 'string' ? parseFloat(rupees) : rupees;
  if (!isFinite(n)) return 0;
  // Scale then round half-away-from-zero, so -0.005 -> -1 rather than -0.
  return Math.sign(n) * Math.round(Math.abs(n) * 100);
}

/** Integer paise -> rupees as a number. Display only, never for arithmetic. */
export function toRupees(paise) {
  return (paise || 0) / 100;
}

/** Apply a percentage to a paise amount, returning integer paise. */
export function pctOfPaise(paise, pct) {
  return Math.round((paise || 0) * (pct / 100));
}

/* ------------------------------------------------------------------ units ---- */

/** Round to the canonical 8 decimal places. */
export function roundUnits(u) {
  if (!isFinite(u)) return 0;
  return Math.round(u * UNIT_SCALE) / UNIT_SCALE;
}

/**
 * Units issued for a net paise amount at a given NAV (rupees per unit).
 * Rounded DOWN, so the treasury never issues more value than it received.
 */
export function unitsForPaise(netPaise, navRupees) {
  if (!navRupees || navRupees <= 0) return 0;
  var raw = (netPaise / 100) / navRupees;
  return Math.floor(raw * UNIT_SCALE) / UNIT_SCALE;
}

/**
 * Gross paise realised by redeeming units at a given NAV.
 * Rounded DOWN for the same reason, in the same direction.
 */
export function paiseForUnits(units, navRupees) {
  return Math.floor(roundUnits(units) * navRupees * 100);
}

/* -------------------------------------------------------------- formatting -- */

var locale = (CFG && CFG.UI && CFG.UI.locale) || 'en-IN';
var symbol = (CFG && CFG.UI && CFG.UI.currencySymbol) || '\u20b9';

/** ₹1,23,456.78 — Indian grouping, from integer paise. */
export function fmtPaise(paise, opts) {
  var o = opts || {};
  var v = toRupees(paise);
  var s = v.toLocaleString(locale, {
    minimumFractionDigits: o.decimals != null ? o.decimals : 2,
    maximumFractionDigits: o.decimals != null ? o.decimals : 2
  });
  return (o.noSymbol ? '' : symbol) + s;
}

/**
 * ARV and other prices that live near ₹1 need more decimals than money does,
 * otherwise a real 0.4% move renders as no move at all.
 */
export function fmtPrice(rupees, decimals) {
  var d = decimals != null
    ? decimals
    : ((CFG && CFG.INDEX && CFG.INDEX.priceDecimals) || 4);
  if (!isFinite(rupees)) return '\u2014';
  return symbol + rupees.toLocaleString(locale, {
    minimumFractionDigits: d,
    maximumFractionDigits: d
  });
}

/** Large rupee figures (BTC in ₹) read better without decimals. */
export function fmtBig(rupees) {
  if (!isFinite(rupees)) return '\u2014';
  return symbol + Math.round(rupees).toLocaleString(locale);
}

/** Compact Indian notation — ₹1.24 L, ₹3.40 Cr. */
export function fmtCompact(rupees) {
  if (!isFinite(rupees)) return '\u2014';
  var a = Math.abs(rupees);
  var sign = rupees < 0 ? '-' : '';
  if (a >= 1e7) return sign + symbol + (a / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return sign + symbol + (a / 1e5).toFixed(2) + ' L';
  if (a >= 1e3) return sign + symbol + (a / 1e3).toFixed(2) + ' K';
  return sign + symbol + a.toFixed(2);
}

export function fmtUnits(units, decimals) {
  var d = decimals != null
    ? decimals
    : ((CFG && CFG.INDEX && CFG.INDEX.unitDecimals) || 8);
  if (!isFinite(units)) return '\u2014';
  // Trim trailing zeros but keep at least 2 decimals, so 1000 -> 1,000.00
  var s = roundUnits(units).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: d
  });
  return s;
}

/** Signed percentage, always with an explicit + or −. */
export function fmtPct(pct, decimals) {
  if (!isFinite(pct)) return '\u2014';
  var d = decimals != null ? decimals : 2;
  var sign = pct > 0 ? '+' : (pct < 0 ? '\u2212' : '');
  return sign + Math.abs(pct).toFixed(d) + '%';
}

/** 'up' | 'down' | 'flat' — drives colour classes across the UI. */
export function direction(n) {
  if (!isFinite(n) || Math.abs(n) < 1e-12) return 'flat';
  return n > 0 ? 'up' : 'down';
}

/* -------------------------------------------------- financial year (India) -- */

/**
 * Indian FY label for a timestamp — '2025-26'. FY starts in April, so
 * anything in Jan–Mar belongs to the FY that began the previous calendar year.
 */
export function fyOf(ms) {
  var startMonth = (CFG && CFG.TAX && CFG.TAX.fyStartMonth) || 4;
  var d = new Date(ms);
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var startYear = m >= startMonth ? y : y - 1;
  var endShort = String((startYear + 1) % 100).padStart(2, '0');
  return startYear + '-' + endShort;
}

/** Inclusive start / exclusive end timestamps for an FY label. */
export function fyRange(label) {
  var startMonth = (CFG && CFG.TAX && CFG.TAX.fyStartMonth) || 4;
  var startYear = parseInt(String(label).slice(0, 4), 10);
  return {
    from: new Date(startYear, startMonth - 1, 1).getTime(),
    to: new Date(startYear + 1, startMonth - 1, 1).getTime()
  };
}

export function currentFy() {
  return fyOf(Date.now());
}

/* ------------------------------------------------------------------ misc ---- */

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Short, human-readable reference for a transaction. */
export function makeRef(prefix) {
  var t = Date.now().toString(36).toUpperCase();
  var r = Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0');
  return (prefix || 'ARV') + '-' + t + r;
}
