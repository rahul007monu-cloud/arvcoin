/**
 * API client.
 *
 * One place that knows how to talk to the PHP backend: CSRF, error shaping,
 * timeouts, and the session. Every page uses these functions rather than calling
 * fetch directly, so a change to auth or error handling happens once.
 *
 * Errors are thrown as `ApiError` carrying the HTTP status and any extra fields
 * the server sent — `needs: 'kyc'`, field-level validation, and so on — because a
 * caller usually wants to react to *why* something failed, not just that it did.
 */

var CFG = globalThis.ARV_CONFIG;
var BASE = (CFG.API && CFG.API.base) || 'api';

var state = {
  csrf: null,
  user: null,
  userLoaded: false,
  listeners: []
};

export class ApiError extends Error {
  constructor(message, status, extra) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    Object.assign(this, extra || {});
  }
}

/* ---------------------------------------------------------------- request -- */

async function request(endpoint, action, opts) {
  var o = opts || {};
  var method = o.method || 'POST';
  var url = BASE + '/' + endpoint + '.php?action=' + encodeURIComponent(action);

  if (method === 'GET' && o.query) {
    Object.keys(o.query).forEach(function (k) {
      if (o.query[k] !== undefined && o.query[k] !== null && o.query[k] !== '') {
        url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(o.query[k]);
      }
    });
  }

  var headers = { accept: 'application/json' };
  var body;

  if (method !== 'GET') {
    // Anything that changes state needs the token. Fetched lazily so a page that
    // only reads never pays for it.
    if (!state.csrf && endpoint !== 'auth') {
      await ensureCsrf();
    }
    if (state.csrf) {
      headers[CFG.API.csrfHeader] = state.csrf;
    }

    if (o.form instanceof FormData) {
      // Let the browser set the multipart boundary.
      body = o.form;
      body.set('action', action);
      if (state.csrf) body.set('_csrf', state.csrf);
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(Object.assign({ action: action }, o.data || {}));
    }
  }

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, o.timeoutMs || CFG.API.timeoutMs || 20000);

  var res, json;
  try {
    res = await fetch(url, {
      method: method,
      headers: headers,
      body: body,
      credentials: 'same-origin',
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new ApiError('That took too long. Check your connection and try again.', 0);
    }
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }
  clearTimeout(timer);

  try {
    json = await res.json();
  } catch (_) {
    // A non-JSON body from an API endpoint almost always means PHP died and
    // printed something, or the host returned an error page.
    throw new ApiError(
      res.status === 404
        ? 'That endpoint is missing. The deployment may be incomplete.'
        : 'The server returned something unexpected (' + res.status + ').',
      res.status
    );
  }

  if (!res.ok || json.ok === false) {
    var err = new ApiError(json.error || ('Request failed (' + res.status + ')'), res.status, json);

    // A 419 means the session token rotated — refresh it once and let the caller
    // retry rather than making the user reload.
    if (res.status === 419) {
      state.csrf = null;
      await ensureCsrf().catch(function () {});
    }
    // 401 means the session is gone; clear the cached user so the UI updates.
    if (res.status === 401) {
      setUser(null);
    }
    throw err;
  }

  if (json.csrf) state.csrf = json.csrf;
  return json;
}

async function ensureCsrf() {
  var r = await request('auth', 'csrf', { method: 'GET' });
  state.csrf = r.csrf;
  return state.csrf;
}

/* ------------------------------------------------------------------- auth -- */

function setUser(u) {
  state.user = u;
  state.userLoaded = true;
  state.listeners.forEach(function (fn) { try { fn(u); } catch (_) {} });
}

export function onUser(fn) {
  state.listeners.push(fn);
  if (state.userLoaded) fn(state.user);
  return function () {
    state.listeners = state.listeners.filter(function (f) { return f !== fn; });
  };
}

export function cachedUser() {
  return state.user;
}

export async function me(force) {
  if (state.userLoaded && !force) return state.user;
  var r = await request('auth', 'me', { method: 'GET' });
  if (r.csrf) state.csrf = r.csrf;
  setUser(r.user || null);
  return state.user;
}

export async function signup(data) {
  await ensureCsrf();
  return request('auth', 'signup', { data: data });
}

export async function verifyOtp(data) {
  await ensureCsrf();
  var r = await request('auth', 'verify', { data: data });
  if (r.user) setUser(r.user);
  return r;
}

export function resendOtp(email, purpose) {
  return request('auth', 'resend', { data: { email: email, purpose: purpose || 'signup' } });
}

export async function login(email, password) {
  await ensureCsrf();
  var r = await request('auth', 'login', { data: { email: email, password: password } });
  if (r.user) setUser(r.user);
  return r;
}

export async function logout() {
  try {
    await request('auth', 'logout', {});
  } finally {
    setUser(null);
    state.csrf = null;
  }
}

export function changePassword(currentPassword, newPassword) {
  return request('auth', 'password', { data: { currentPassword: currentPassword, newPassword: newPassword } });
}

/**
 * Send an unauthenticated visitor to the sign-in page, remembering where they
 * were so they land back there afterwards.
 */
export async function requireUser(redirect) {
  var u = await me();
  if (!u) {
    var next = encodeURIComponent(location.pathname.replace(/^\//, '') + location.search);
    location.replace((redirect || 'login.html') + '?next=' + next);
    return null;
  }
  return u;
}

/* ----------------------------------------------------------------- market -- */

export function snapshot() {
  return request('market', 'snapshot', { method: 'GET' });
}

export function candles(tf, days, limit) {
  return request('market', 'candles', {
    method: 'GET',
    query: { tf: tf, days: days, limit: limit }
  });
}

export function watchlist() {
  return request('market', 'watchlist', { method: 'GET' });
}

export function marketStats() {
  return request('market', 'stats', { method: 'GET' });
}

/* ----------------------------------------------------------------- orders -- */

export function quoteBuy(amountPaise) {
  return request('orders', 'quote', { data: { side: 'buy', amountPaise: amountPaise } });
}

export function quoteSell(units) {
  return request('orders', 'quote', { data: { side: 'sell', units: String(units) } });
}

export function placeOrder(data) {
  return request('orders', 'place', { data: data });
}

export function cancelOrder(orderId) {
  return request('orders', 'cancel', { data: { orderId: orderId } });
}

export function myOrders(status) {
  return request('orders', 'mine', { method: 'GET', query: { status: status || 'open' } });
}

export function book() {
  return request('orders', 'book', { method: 'GET' });
}

export function tape(limit) {
  return request('orders', 'tape', { method: 'GET', query: { limit: limit } });
}

/* --------------------------------------------------------------- deposits -- */

export function createDeposit(amountPaise) {
  return request('deposit', 'create', { data: { amountPaise: amountPaise } });
}

/**
 * Submit proof of payment.
 *
 * Uses multipart when a screenshot is attached so the file is not base64'd into
 * JSON, which would inflate it by a third for no benefit.
 */
export function submitDeposit(ref, utr, file) {
  if (file) {
    var fd = new FormData();
    fd.set('ref', ref);
    fd.set('utr', utr || '');
    fd.set('screenshot', file);
    return request('deposit', 'submit', { form: fd, timeoutMs: 60000 });
  }
  return request('deposit', 'submit', { data: { ref: ref, utr: utr } });
}

export function myDeposits() {
  return request('deposit', 'mine', { method: 'GET' });
}

export function getDeposit(ref) {
  return request('deposit', 'get', { method: 'GET', query: { ref: ref } });
}

export function cancelDeposit(ref) {
  return request('deposit', 'cancel', { data: { ref: ref } });
}

/* ------------------------------------------------------------ withdrawals -- */

export function createWithdrawal(amountPaise, upiVpa) {
  return request('withdraw', 'create', { data: { amountPaise: amountPaise, upiVpa: upiVpa } });
}

export function myWithdrawals() {
  return request('withdraw', 'mine', { method: 'GET' });
}

export function cancelWithdrawal(ref) {
  return request('withdraw', 'cancel', { data: { ref: ref } });
}

/* -------------------------------------------------------------------- kyc -- */

export function getKyc() {
  return request('kyc', 'get', { method: 'GET' });
}

export function submitKyc(data) {
  return request('kyc', 'submit', { data: data });
}

/* --------------------------------------------------------------- referral -- */

export function referralSummary() {
  return request('referral', 'summary', { method: 'GET' });
}

export function rewardTiers() {
  return request('referral', 'tiers', { method: 'GET' });
}

/* ---------------------------------------------------------------- account -- */

/**
 * Ledger page.
 *
 * `before` is an id cursor, not an offset — the ledger grows while it is being
 * read, and an offset would skip or repeat rows as new entries land on top.
 */
export function ledger(opts) {
  var o = opts || {};
  return request('account', 'ledger', {
    method: 'GET',
    query: { limit: o.limit, before: o.before, fy: o.fy, group: o.group }
  });
}

export function myTrades(limit) {
  return request('account', 'trades', { method: 'GET', query: { limit: limit } });
}

export function taxStatement(fy) {
  return request('account', 'tax', { method: 'GET', query: { fy: fy } });
}

export function financialYears() {
  return request('account', 'years', { method: 'GET' });
}

/* ------------------------------------------------------------------ admin -- */

export var admin = {
  overview: function () { return request('admin', 'overview', { method: 'GET' }); },
  deposits: function (status) { return request('admin', 'deposits', { method: 'GET', query: { status: status } }); },
  confirmDeposit: function (ref, note) { return request('admin', 'confirm_deposit', { data: { ref: ref, note: note } }); },
  rejectDeposit: function (ref, reason) { return request('admin', 'reject_deposit', { data: { ref: ref, reason: reason } }); },
  withdrawals: function (status) { return request('admin', 'withdrawals', { method: 'GET', query: { status: status } }); },
  approveWithdraw: function (ref) { return request('admin', 'approve_withdraw', { data: { ref: ref } }); },
  markPaid: function (ref, utr) { return request('admin', 'mark_paid', { data: { ref: ref, utr: utr } }); },
  rejectWithdraw: function (ref, reason) { return request('admin', 'reject_withdraw', { data: { ref: ref, reason: reason } }); },
  kycQueue: function () { return request('admin', 'kyc_queue', { method: 'GET' }); },
  reviewKyc: function (userId, approve, reason) {
    return request('admin', 'kyc_review', { data: { userId: userId, approve: approve, reason: reason } });
  },
  reconcile: function () { return request('admin', 'reconcile', { method: 'GET' }); },
  users: function (search) { return request('admin', 'users', { method: 'GET', query: { q: search } }); },
  settings: function () { return request('admin', 'settings', { method: 'GET' }); },
  saveSetting: function (key, value) { return request('admin', 'save_setting', { data: { key: key, value: value } }); }
};

/**
 * History backfill.
 *
 * cron.php takes its job from the query string rather than an action, so this one
 * does not fit the shared request helper.
 */
export async function backfill(tf, days) {
  if (!state.csrf) await ensureCsrf();
  var url = BASE + '/cron.php?job=backfill&tf=' + encodeURIComponent(tf)
          + (days ? '&days=' + encodeURIComponent(days) : '');

  var headers = { accept: 'application/json' };
  headers[CFG.API.csrfHeader] = state.csrf;

  var res = await fetch(url, {
    method: 'POST',
    headers: headers,
    credentials: 'same-origin'
  });
  var json = await res.json().catch(function () { return null; });
  if (!res.ok || !json || json.ok === false) {
    throw new ApiError((json && json.error) || 'Backfill failed.', res.status, json || {});
  }
  return json;
}

/* ------------------------------------------------------------------ utils -- */

export function csrf() {
  return state.csrf;
}

/** Poll a function on an interval, pausing while the tab is hidden. */
export function poll(fn, ms) {
  var timer = null;
  var run = async function () {
    if (document.hidden) return;
    try { await fn(); } catch (_) { /* a failed poll is not worth a toast */ }
  };
  timer = setInterval(run, ms);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) run();
  });
  run();
  return function () { clearInterval(timer); };
}
