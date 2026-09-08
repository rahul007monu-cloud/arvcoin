/* ============================================================================
   coin3d — a real 3D ARV coin, built out of transforms
   ----------------------------------------------------------------------------
   Why this is CSS and not a 3D library: the old hero scene cost about 1.3 MB
   before a single balance was readable, and on a phone that is felt immediately.
   This is the same idea done with the compositor instead — geometry is a handful
   of divs, so it adds no request, no parse cost and nothing to the critical path.

   The coin is genuinely three-dimensional rather than a spinning picture of one:
   two faces set apart on Z, and a rim assembled from N thin quads placed around
   the circumference. Each quad is positioned with

       rotateZ(t) translateX(R) rotateY(90deg)

   read right to left: turn the quad so its width becomes depth, push it out to
   the radius, then swing it round to its angle. That gives a closed cylinder, so
   the edge stays solid at every angle and the coin has real thickness when it
   turns side-on.

   Motion is layered onto separate nested elements on purpose — float, wobble,
   spin, orbit rings and shadow each own one transform. Composing them that way
   keeps every animation to transform/opacity only, so all of it stays on the GPU
   and never triggers layout. It also reads better: the parts move at different
   speeds instead of one rigid object.

   Everything here is decorative, so it is aria-hidden and it is the first thing
   to go when the visitor has asked for less motion.
   ============================================================================ */

// Coin geometry. RIM_SEGMENTS trades smoothness against DOM size — 28 quads at
// this radius overlap slightly, which is what keeps the edge from showing gaps.
var RADIUS = 62;
var RIM_SEGMENTS = 28;

var reduced = window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The rim: N thin quads wrapped into a cylinder wall. */
function buildRim() {
  var rim = document.createElement('div');
  rim.className = 'coin3d-rim';
  var html = '';
  for (var i = 0; i < RIM_SEGMENTS; i++) {
    var angle = (360 / RIM_SEGMENTS) * i;
    html += '<i style="transform:rotateZ(' + angle.toFixed(3) + 'deg) '
          + 'translateX(' + RADIUS + 'px) rotateY(90deg)"></i>';
  }
  rim.innerHTML = html;
  return rim;
}

/**
 * Build the coin and mount it into `host`.
 *
 * Returns a teardown function that removes the pointer listener and empties the
 * host, so a caller can drop the whole thing without leaking a listener.
 */
export function mount(host) {
  if (!host) return function () {};

  host.setAttribute('aria-hidden', 'true');
  host.innerHTML =
    '<div class="coin3d-glow"></div>'
    + '<div class="coin3d-parallax">'
      + '<div class="coin3d-float">'
        + '<div class="coin3d-wobble">'
          + '<div class="coin3d-rings">'
            + '<div class="coin3d-ring r1"><span class="coin3d-bead"></span></div>'
            + '<div class="coin3d-ring r2"><span class="coin3d-bead"></span></div>'
          + '</div>'
          + '<div class="coin3d" data-coin-body>'
            + '<div class="coin3d-face coin3d-front">'
              + '<span class="coin3d-mark">ARV</span>'
              + '<span class="coin3d-sheen"></span>'
            + '</div>'
            + '<div class="coin3d-face coin3d-back">'
              + '<span class="coin3d-mark coin3d-mark-sm">\u20b9</span>'
              + '<span class="coin3d-sheen"></span>'
            + '</div>'
          + '</div>'
        + '</div>'
      + '</div>'
      + '<div class="coin3d-shadow"></div>'
    + '</div>';

  var body = host.querySelector('[data-coin-body]');
  if (body) body.appendChild(buildRim());

  // Pointer parallax. Skipped entirely under reduced motion, and only bound on
  // devices that actually have a hover-capable pointer — on a touch screen it
  // would just fight the scroll.
  var fine = window.matchMedia && window.matchMedia('(hover: hover)').matches;
  if (reduced || !fine) return function () { host.innerHTML = ''; };

  var stage = host.closest('.wallet-hero') || host;
  var frame = 0;

  function onMove(e) {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      var r = stage.getBoundingClientRect();
      if (!r.width || !r.height) return;
      // -1..1 from the centre, then damped to a few degrees. Enough to feel like
      // the object is sitting in the page; more than this reads as a gimmick.
      var dx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      var dy = ((e.clientY - r.top) / r.height - 0.5) * 2;
      host.style.setProperty('--coin-px', (dx * 14).toFixed(2) + 'deg');
      host.style.setProperty('--coin-py', (-dy * 10).toFixed(2) + 'deg');
    });
  }

  function onLeave() {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    host.style.setProperty('--coin-px', '0deg');
    host.style.setProperty('--coin-py', '0deg');
  }

  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerleave', onLeave);

  return function () {
    if (frame) cancelAnimationFrame(frame);
    stage.removeEventListener('pointermove', onMove);
    stage.removeEventListener('pointerleave', onLeave);
    host.innerHTML = '';
  };
}
