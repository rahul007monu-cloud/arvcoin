/**
 * UPI payment QR.
 *
 * Builds a standard UPI intent URI and renders it as a scannable QR. Any UPI
 * app — GPay, PhonePe, Paytm, a bank app — reads the same format:
 *
 *   upi://pay?pa=<vpa>&pn=<payee>&am=<amount>&cu=INR&tn=<note>&tr=<ref>
 *
 * What a QR cannot do
 * -------------------
 * It carries a request in one direction and returns nothing. There is no
 * callback, no signature, no confirmation — scanning it tells the payer's app
 * what to do and tells this app nothing at all. So a scanned QR is never
 * treated as a completed payment. The deposit stays awaiting_payment until it is
 * confirmed against the actual bank credit.
 *
 * Wiring a "the QR was shown, so credit the units" path is the single most
 * effective way to have a balance drained by someone who never paid.
 */

var CFG = globalThis.ARV_CONFIG;
var LOADER = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
var loading = null;

/** Load the encoder once, on demand. */
function loadLib() {
  if (globalThis.qrcode) return Promise.resolve(globalThis.qrcode);
  if (loading) return loading;
  loading = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = LOADER;
    s.async = true;
    s.onload = function () {
      globalThis.qrcode ? resolve(globalThis.qrcode) : reject(new Error('QR library loaded but did not register'));
    };
    s.onerror = function () { reject(new Error('Could not load the QR library')); };
    document.head.appendChild(s);
  });
  return loading;
}

/* ------------------------------------------------------------------ intent -- */

/**
 * UPI intent URI.
 *
 * @param opts { vpa, payeeName, amountPaise, note, ref, merchantCode }
 *
 * Amount is rendered with exactly two decimals: UPI rejects malformed amounts,
 * and "100" versus "100.00" is the kind of difference that fails silently on
 * one app and works on another.
 */
export function upiUri(opts) {
  var o = opts || {};
  var vpa = o.vpa || CFG.PAYMENTS.vpa;
  if (!vpa) return null;

  var p = new URLSearchParams();
  p.set('pa', vpa);
  p.set('pn', o.payeeName || CFG.PAYMENTS.payeeName || 'ARV Coin');
  if (o.amountPaise != null && o.amountPaise > 0) {
    p.set('am', (o.amountPaise / 100).toFixed(2));
  }
  p.set('cu', CFG.PAYMENTS.currency || 'INR');
  if (o.ref) p.set('tr', o.ref);

  var note = o.note ||
    (CFG.PAYMENTS.depositNoteTemplate || 'ARV-{ref}').replace('{ref}', o.ref || '');
  // UPI notes are length-limited and reject most punctuation.
  if (note) p.set('tn', note.replace(/[^\w\s\-]/g, '').slice(0, 50));

  var mc = o.merchantCode || CFG.PAYMENTS.merchantCode;
  if (mc) p.set('mc', mc);

  return 'upi://pay?' + p.toString();
}

/* ------------------------------------------------------------------ render -- */

/**
 * Render a QR into a container.
 *
 * Returns { ok, uri, reason }. When no VPA is configured it renders an explicit
 * placeholder rather than a broken or misleading code — a QR that scans to
 * nothing is worse than a panel that says it is not set up.
 */
export async function render(el, opts) {
  var o = opts || {};
  if (!el) return { ok: false, reason: 'no container' };

  var uri = o.uri || upiUri(o);

  if (!uri) {
    el.innerHTML =
      '<div class="qr-unconfigured">' +
        '<div><strong>UPI not configured</strong><br>' +
        'Set <code>PAYMENTS.vpa</code> in <code>arv-config.js</code> ' +
        'and a scannable code appears here.</div>' +
      '</div>';
    return { ok: false, reason: 'no vpa configured' };
  }

  try {
    var qrcode = await loadLib();
    // typeNumber 0 auto-selects the smallest version that fits; 'M' error
    // correction is the usual choice for payment codes — enough redundancy for a
    // phone camera at an angle without inflating the module count.
    var qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();

    el.innerHTML = qr.createSvgTag({
      cellSize: o.cellSize || 5,
      margin: o.margin != null ? o.margin : 8,
      scalable: true
    });

    var svg = el.querySelector('svg');
    if (svg) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'UPI payment QR code');
    }
    return { ok: true, uri: uri };
  } catch (e) {
    el.innerHTML =
      '<div class="qr-unconfigured"><div>' +
      'QR could not be generated.<br><span class="tiny">' +
      (e && e.message ? e.message : 'unknown error') +
      '</span></div></div>';
    return { ok: false, reason: e && e.message };
  }
}

/**
 * Deep link for the same intent.
 *
 * On a phone this opens the UPI app directly, which is far better than asking
 * someone to scan a code on the screen they are already holding.
 */
export function intentLink(opts) {
  return upiUri(opts);
}

export function isMobile() {
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent || '');
}

/** Whether payments are configured at all — drives UI copy. */
export function configured() {
  return !!CFG.PAYMENTS.vpa;
}
