/* ============================================================================
   coin3d — a struck metal ARV coin, built out of transforms
   ----------------------------------------------------------------------------
   Why this is CSS and not a 3D library: the old hero scene cost about 1.3 MB
   before a single word was readable, and on a phone that is felt immediately.
   This is the same idea done on the compositor instead — the geometry is a few
   dozen divs, so it adds no request and nothing to the critical path.

   The coin is genuinely three-dimensional rather than a picture of one:

     faces     two discs pushed apart on Z
     chamfer   a bevel ring either side, so the edge is not a hard 90 degrees
     rim       N thin quads wrapped into a closed cylinder wall, each placed with
                   rotateZ(t) translateX(R) rotateY(90deg)
               read right to left: turn the quad so its width becomes depth, push
               it out to the radius, then swing it round to its angle

   That closure is the whole trick — it is what keeps the edge solid when the
   coin turns side-on, and what gives it real thickness instead of the cardboard
   look of two faces glued together.

   What makes it read as struck metal rather than a silver circle is layering,
   not geometry: a brushed base, curvature shading, an engraved rim ring and
   dentils, an embossed mark lit from one consistent direction, and a specular
   band that sweeps across the face as it turns. Metal is defined by how it moves
   light around, so the highlight has to travel while the object rotates.

   Motion is split across nested elements — float, wobble, spin, orbit rings and
   shadow each own exactly one transform. Every animation touches only transform
   and opacity, so all of it stays on the GPU and none of it can trigger layout.

   Everything here is decorative: it is aria-hidden, it never blocks the data on
   the page, and it is the first thing to stop when reduced motion is asked for.
   ============================================================================ */

var reduced = window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

var DEFAULTS = {
  radius: 62,      // px
  thickness: 17,   // px, the coin's depth
  // Rim quads. Higher than strictly needed for a closed wall: the milling should
  // read as a fine machined edge, and coarse segments look like a barcode wrapped
  // round a disc. Cost is one empty div each, so smoothness is cheap.
  segments: 72,
  mark: 'ARV',
  sub: 'INDEX UNIT'
};

/**
 * The rim: N thin quads wrapped into a cylinder wall.
 *
 * Each quad is `arc * 1.09` tall so neighbours overlap slightly — at these radii
 * an exact arc length leaves hairline gaps that catch the eye as the coin turns.
 */
function rimHtml(radius, segments) {
  var arc = (2 * Math.PI * radius) / segments;
  var h = (arc * 1.09).toFixed(2);
  var out = '';
  for (var i = 0; i < segments; i++) {
    var a = ((360 / segments) * i).toFixed(3);
    out += '<i style="height:' + h + 'px;margin-top:' + (-h / 2).toFixed(2) + 'px;'
         + 'transform:rotateZ(' + a + 'deg) translateX(' + radius + 'px) rotateY(90deg)"></i>';
  }
  return out;
}

/** One face: material, engraving and specular layers, in light-to-dark order. */
function faceHtml(side, o) {
  var engraving = side === 'front'
    ? '<span class="c-mark">' + o.mark + '</span>'
      + '<span class="c-sub">' + o.sub + '</span>'
    : '<span class="c-mark c-mark-lg">\u20b9</span>'
      + '<span class="c-sub">TRACKS BITCOIN</span>';

  return '<div class="c-face c-' + side + '">'
    +   '<span class="c-brush"></span>'
    +   '<span class="c-dome"></span>'
    +   '<span class="c-ring"></span>'
    +   '<span class="c-dentils"></span>'
    +   engraving
    +   '<span class="c-spec"></span>'
    + '</div>';
}

/**
 * Build the coin and mount it into `host`.
 *
 * Returns a teardown function that drops the pointer listener and empties the
 * host, so a caller can remove the whole thing without leaking a listener.
 */
export function mount(host, opts) {
  if (!host) return function () {};

  var o = Object.assign({}, DEFAULTS, opts || {});

  // Geometry travels to CSS as custom properties, so one component serves the
  // big hero coin and the smaller wallet one without duplicated rules.
  host.style.setProperty('--coin-d', (o.radius * 2) + 'px');
  host.style.setProperty('--coin-t', o.thickness + 'px');
  host.setAttribute('aria-hidden', 'true');

  host.innerHTML =
    '<div class="c-glow"></div>'
    + '<div class="c-parallax">'
      + '<div class="c-float">'
        + '<div class="c-wobble">'
          + '<div class="c-rings">'
            + '<div class="c-ring-orbit o1"><span class="c-bead"></span></div>'
            + '<div class="c-ring-orbit o2"><span class="c-bead"></span></div>'
          + '</div>'
          + '<div class="c-coin">'
            + faceHtml('front', o)
            + faceHtml('back', o)
            + '<div class="c-chamfer c-chamfer-f"></div>'
            + '<div class="c-chamfer c-chamfer-b"></div>'
            + '<div class="c-rim">' + rimHtml(o.radius, o.segments) + '</div>'
          + '</div>'
        + '</div>'
      + '</div>'
      + '<div class="c-shadow"></div>'
      + '<div class="c-shadow c-shadow-soft"></div>'
    + '</div>';

  // Pointer parallax. Skipped under reduced motion, and only where a hover-capable
  // pointer exists — on a touch screen it would only fight the scroll.
  var fine = window.matchMedia && window.matchMedia('(hover: hover)').matches;
  if (reduced || !fine) return function () { host.innerHTML = ''; };

  var stage = host.closest('[data-coin-scope]') || host;
  var frame = 0;

  function onMove(e) {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      var r = stage.getBoundingClientRect();
      if (!r.width || !r.height) return;
      // -1..1 from the centre, damped to a few degrees. Enough that the object
      // feels seated in the page; more than this reads as a gimmick.
      var dx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      var dy = ((e.clientY - r.top) / r.height - 0.5) * 2;
      host.style.setProperty('--coin-px', (dx * 15).toFixed(2) + 'deg');
      host.style.setProperty('--coin-py', (-dy * 11).toFixed(2) + 'deg');
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
