/**
 * Scroll reveal.
 *
 * Marks elements as visible when they come into view, once, and drops the
 * observer as it goes. Cheap by construction: an IntersectionObserver does the
 * work off the main thread, so there is no scroll listener and nothing runs
 * during a scroll.
 *
 * Design notes:
 *
 *   Reveal once, then unobserve. An element that re-animates every time it is
 *   scrolled past is a distraction, and keeping observers alive for a long page
 *   costs memory for no benefit.
 *
 *   Content is never hidden behind JavaScript. `[data-reveal]` starts at zero
 *   opacity, so if this module fails to load the page would be blank — which is
 *   unacceptable. So the first thing it does is prove it ran, and a fallback in
 *   the shell reveals everything if it has not run within a second.
 *
 *   Anything already on screen at load is revealed immediately, without the
 *   transition, so the first paint is not a fade-in of the whole viewport.
 */

var CFG = globalThis.ARV_CONFIG;

var reduced = window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

var observer = null;
var started = false;

/** Number the children of a stagger group so each gets its own delay. */
function index(root) {
  (root || document).querySelectorAll('[data-reveal-group]').forEach(function (group) {
    var i = 0;
    Array.prototype.forEach.call(group.children, function (child) {
      if (child.hasAttribute && child.hasAttribute('data-reveal')) {
        child.style.setProperty('--i', String(i++));
      }
    });
  });
}

function show(el, instant) {
  if (el.classList.contains('shown')) return;

  if (instant) {
    // Already in view on load: no transition, so the page does not fade in
    // wholesale on arrival.
    el.style.transition = 'none';
    el.classList.add('shown');
    // Two frames, so the class lands before the transition is restored.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.style.transition = '';
        el.classList.add('settled');
      });
    });
    return;
  }

  el.classList.add('shown');

  // Release the compositor layer once the movement is over. On a long page this
  // is the difference between a few live layers and several hundred.
  var delay = parseFloat(getComputedStyle(el).transitionDelay) || 0;
  setTimeout(function () { el.classList.add('settled'); }, 1300 + delay * 1000);
}

var SELECTOR = '[data-reveal], .rule, .underline-draw';

/** Reveal everything, no animation. The safety net and the reduced-motion path. */
export function revealAll(root) {
  (root || document).querySelectorAll(SELECTOR)
    .forEach(function (el) { el.classList.add('shown', 'settled'); });
}

export function init() {
  if (started) return;
  started = true;

  var targets = document.querySelectorAll(SELECTOR);
  if (!targets.length) return;

  if (reduced || !('IntersectionObserver' in window)) {
    revealAll();
    return;
  }

  index();

  observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      show(entry.target, false);
      observer.unobserve(entry.target);
    });
  }, {
    // A little *before* the element reaches the viewport, so the movement has
    // finished by the time it is properly in view rather than starting then. That
    // means growing the root downward, which is a positive bottom margin — a
    // negative one shrinks the root and reveals later, the opposite of the intent.
    //
    // It also removes a hazard: an element sitting wholly inside an excluded
    // bottom band, on a page already scrolled as far as it goes, can never enter a
    // shrunk root and would stay at opacity 0 permanently. No current page ends
    // that way — the footer is always below the last revealed block — but it would
    // be a nasty thing to discover by adding one.
    rootMargin: '0px 0px 8% 0px',
    // Any intersection at all. A threshold is a *ratio of the element's own area*,
    // so a zero-height container has a ratio that is always zero and would never
    // qualify against any positive threshold.
    threshold: 0
  });

  var vh = window.innerHeight;
  targets.forEach(function (el) {
    var box = el.getBoundingClientRect();
    if (box.top < vh * 0.92 && box.bottom > 0) {
      show(el, true);          // above the fold — show at once
    } else {
      observer.observe(el);
    }
  });
}

/**
 * Register content added after load — a table that has just been filled, a list
 * rendered from an API response.
 *
 * A page that paints rows with innerHTML replaces the nodes being watched, so the
 * new ones have to be handed back. Pages that render their own content call this;
 * see home.js and dashboard.js.
 */
export function observe(root) {
  if (!observer) {
    revealAll(root);
    return;
  }
  index(root);
  (root || document).querySelectorAll('[data-reveal]:not(.shown)').forEach(function (el) {
    observer.observe(el);
  });
}

/**
 * Count a number up to its value.
 *
 * Eased rather than linear, so it decelerates into the final figure instead of
 * stopping dead. `formatter` keeps the currency and decimals correct at every
 * frame — a raw count-up on a money figure looks like a slot machine.
 */
export function countUp(el, to, opts) {
  var o = opts || {};
  var ms = o.ms || 1100;
  var from = o.from != null ? o.from : 0;
  var fmt = o.format || function (v) { return String(Math.round(v)); };

  if (reduced) {
    el.textContent = fmt(to);
    return;
  }

  var start = null;
  function frame(now) {
    if (start === null) start = now;
    var t = Math.min(1, (now - start) / ms);
    // Cubic ease-out, matching the reveal transitions.
    var eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Count up the first time an element is scrolled into view. */
export function countUpOnReveal(el, to, opts) {
  if (!('IntersectionObserver' in window) || reduced) {
    countUp(el, to, opts);
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      countUp(el, to, opts);
      io.disconnect();
    });
  }, { threshold: 0.4 });
  io.observe(el);
}
