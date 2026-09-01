/**
 * The blockchain-DNA helix.
 *
 * A double helix whose rungs are blocks and whose strands are the chain linking
 * them. It is the product's central metaphor: a single ledger twisting forward
 * through time, each block bound to the one before it.
 *
 * It is also wired to the market. Rotation speed, glow intensity and colour
 * temperature all follow Bitcoin's live direction — rising means faster and
 * warmer, falling means slower and cooler. So the scene is a peripheral
 * indicator rather than decoration: motion in the corner of the eye already
 * tells you which way the day is going before you read a number.
 *
 * Restraint, deliberately
 * -----------------------
 * A full-screen WebGL scene behind a financial dashboard is a good way to melt
 * a phone battery and make text unreadable. So:
 *
 *   - particle count drops on small screens
 *   - rendering stops entirely when the tab is hidden
 *   - the whole thing is skipped under prefers-reduced-motion
 *   - a CSS gradient stands in when WebGL is unavailable
 *   - the canvas never receives pointer events
 *   - device pixel ratio is capped at 2 (beyond that costs a lot and shows little)
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';

var CFG = globalThis.ARV_CONFIG;
var C = CFG.UI.helix;

var state = {
  running: false,
  renderer: null,
  scene: null,
  camera: null,
  raf: null,
  clock: null,
  groups: {},
  mouse: { x: 0, y: 0, tx: 0, ty: 0 },
  market: { direction: 0, intensity: 0 },   // -1..1, 0..1
  disposables: []
};

/* ------------------------------------------------------------ capability -- */

function webglAvailable() {
  try {
    var c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
      (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch (_) { return false; }
}

function reducedMotion() {
  return C.respectReducedMotion &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isSmallScreen() {
  return window.innerWidth < 820;
}

function showFallback() {
  if (document.querySelector('.helix-fallback')) return;
  var d = document.createElement('div');
  d.className = 'helix-fallback';
  d.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(d, document.body.firstChild);
}

/* ------------------------------------------------------------- geometry --- */

/**
 * Point on a helical strand.
 * `phase` offsets the second strand half a turn round so the two interleave.
 */
function helixPoint(t, phase, radius, pitch) {
  var angle = t * Math.PI * 2 + phase;
  return new THREE.Vector3(
    Math.cos(angle) * radius,
    (t - 0.5) * pitch,
    Math.sin(angle) * radius
  );
}

function buildStrand(phase, radius, pitch, turns, colour) {
  var pts = [];
  // Must be a whole number: TubeGeometry uses this as a loop bound for its
  // tubular segments, and a fractional count silently produces undefined
  // vertices rather than erroring where the mistake was made.
  var steps = Math.round(turns * 48);
  for (var i = 0; i <= steps; i++) {
    pts.push(helixPoint((i / steps) * turns, phase, radius, pitch));
  }
  var curve = new THREE.CatmullRomCurve3(pts);
  var geo = new THREE.TubeGeometry(curve, steps, 0.035, 8, false);
  var mat = new THREE.MeshBasicMaterial({
    color: colour, transparent: true, opacity: 0.55
  });
  state.disposables.push(geo, mat);
  return new THREE.Mesh(geo, mat);
}

/**
 * The blocks. Each rung is a small box sitting between the two strands, plus a
 * wireframe edge so it reads as a discrete object rather than a blob at
 * distance.
 */
function buildBlocks(count, radius, pitch, turns) {
  var group = new THREE.Group();
  var boxGeo = new THREE.BoxGeometry(0.34, 0.2, 0.2);
  var edgeGeo = new THREE.EdgesGeometry(boxGeo);
  state.disposables.push(boxGeo, edgeGeo);

  for (var i = 0; i < count; i++) {
    var t = (i / (count - 1)) * turns;

    var a = helixPoint(t, 0, radius, pitch);
    var b = helixPoint(t, Math.PI, radius, pitch);
    var mid = a.clone().add(b).multiplyScalar(0.5);

    // Blocks alternate between the two identity colours so the chain reads as
    // two interleaved strands rather than one striped tube.
    var warm = i % 2 === 0;
    var mat = new THREE.MeshBasicMaterial({
      color: warm ? 0xf7931a : 0x6ee7ff,
      transparent: true, opacity: 0.16
    });
    var edgeMat = new THREE.LineBasicMaterial({
      color: warm ? 0xffb04d : 0xa5f0ff,
      transparent: true, opacity: 0.5
    });
    state.disposables.push(mat, edgeMat);

    var block = new THREE.Mesh(boxGeo, mat);
    var edges = new THREE.LineSegments(edgeGeo, edgeMat);

    block.position.copy(mid);
    edges.position.copy(mid);

    // Orient the rung along the line joining the two strands.
    var dir = b.clone().sub(a).normalize();
    var quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
    block.quaternion.copy(quat);
    edges.quaternion.copy(quat);

    // Scale the rung to actually span the gap.
    var span = a.distanceTo(b);
    block.scale.x = span / 0.34;
    edges.scale.x = span / 0.34;

    block.userData.seed = Math.random() * Math.PI * 2;
    block.userData.baseOpacity = 0.16;
    edges.userData.seed = block.userData.seed;
    edges.userData.baseOpacity = 0.5;

    group.add(block);
    group.add(edges);
  }
  return group;
}

/** Ambient particle field for depth. */
function buildParticles(count) {
  var geo = new THREE.BufferGeometry();
  var pos = new Float32Array(count * 3);
  var col = new Float32Array(count * 3);

  var warm = new THREE.Color(0xf7931a);
  var cool = new THREE.Color(0x6ee7ff);
  var mid = new THREE.Color(0x4d9fff);

  for (var i = 0; i < count; i++) {
    // Distributed in a slab around the helix, wider than it is deep so parallax
    // reads correctly without particles crowding the camera.
    pos[i * 3]     = (Math.random() - 0.5) * 30;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 26;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 18 - 4;

    var r = Math.random();
    var c = r < 0.35 ? warm : (r < 0.7 ? cool : mid);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  var mat = new THREE.PointsMaterial({
    size: 0.055, vertexColors: true, transparent: true,
    opacity: 0.6, sizeAttenuation: true,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  state.disposables.push(geo, mat);
  return new THREE.Points(geo, mat);
}

/* ---------------------------------------------------------------- scene --- */

function build() {
  var canvas = document.getElementById('helix-canvas');
  if (!canvas) return false;

  var renderer = new THREE.WebGLRenderer({
    canvas: canvas, antialias: !isSmallScreen(), alpha: true,
    powerPreference: 'low-power'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x000000, 0);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 0, 29);

  // Proportions matter more than they look like they should. Too few turns over
  // too tall a pitch reads as a ladder rather than a helix; too many and the
  // rungs merge into a solid band. Five turns over a pitch slightly shorter than
  // the visible frustum height keeps the twist legible while letting the ends
  // run off screen, so it feels like a section of something longer.
  var radius = C.strandRadius;
  var turns = 5;
  var pitch = 26;

  var helix = new THREE.Group();
  helix.add(buildStrand(0, radius, pitch, turns, 0xf7931a));
  helix.add(buildStrand(Math.PI, radius, pitch, turns, 0x6ee7ff));

  var blocks = buildBlocks(C.blocksPerStrand, radius, pitch, turns);
  helix.add(blocks);

  // A diagonal sweep rather than a vertical pole, offset right of centre so its
  // densest part falls in the gap between the hero copy and the price card
  // instead of sitting behind either one.
  helix.rotation.z = 0.34;
  helix.position.x = 3.4;
  scene.add(helix);

  var particles = buildParticles(isSmallScreen() ? C.particleCountMobile : C.particleCount);
  scene.add(particles);

  state.renderer = renderer;
  state.scene = scene;
  state.camera = camera;
  state.clock = new THREE.Clock();
  state.groups = { helix: helix, blocks: blocks, particles: particles };
  return true;
}

/* ----------------------------------------------------------------- loop --- */

function frame() {
  if (!state.running) return;
  state.raf = requestAnimationFrame(frame);

  var dt = Math.min(state.clock.getDelta(), 0.1);
  var el = state.clock.elapsedTime;

  var m = state.market;

  // Direction sets rotation speed and sign. Rising spins forward and faster;
  // falling slows and reverses slightly. The magnitude is intentionally small —
  // this should register peripherally, not demand attention.
  var speed = C.rotationSpeed * (1 + m.direction * 0.55);

  var helix = state.groups.helix;
  helix.rotation.y += speed * dt;

  // Gentle breathing so it never looks frozen when the market is flat.
  helix.rotation.x = Math.sin(el * 0.14) * 0.06;
  helix.position.y = Math.sin(el * 0.2) * 0.22;

  // Blocks pulse. Amplitude follows how strongly the market is moving, so a
  // violent day visibly shimmers and a quiet one barely does.
  var pulse = 0.35 + m.intensity * 0.65;
  var kids = state.groups.blocks.children;
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i];
    var s = k.userData.seed || 0;
    var wave = (Math.sin(el * 1.5 + s) + 1) * 0.5;
    k.material.opacity = k.userData.baseOpacity * (0.55 + wave * pulse);
  }

  // Particle drift, slow and independent of the helix.
  state.groups.particles.rotation.y += dt * 0.012;
  state.groups.particles.rotation.x = Math.sin(el * 0.07) * 0.04;

  // Camera parallax, eased toward the pointer.
  state.mouse.x += (state.mouse.tx - state.mouse.x) * 0.045;
  state.mouse.y += (state.mouse.ty - state.mouse.y) * 0.045;
  state.camera.position.x = state.mouse.x * 1.8;
  state.camera.position.y = -state.mouse.y * 1.3;
  state.camera.lookAt(4, 0, 0);

  state.renderer.render(state.scene, state.camera);
}

/* ---------------------------------------------------------------- events -- */

function onResize() {
  if (!state.renderer) return;
  var w = window.innerWidth, h = window.innerHeight;
  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(w, h, false);
}

function onPointer(e) {
  var t = e.touches ? e.touches[0] : e;
  if (!t) return;
  state.mouse.tx = (t.clientX / window.innerWidth - 0.5) * 2;
  state.mouse.ty = (t.clientY / window.innerHeight - 0.5) * 2;
}

function onVisibility() {
  if (!C.pauseWhenHidden) return;
  if (document.hidden) pause(); else resume();
}

/* ------------------------------------------------------------------- api -- */

/**
 * Start the scene. Silently does nothing — and installs the CSS fallback —
 * when the environment or the user's preferences say it should not run.
 */
export function init() {
  if (!C.enabled) return { ok: false, reason: 'disabled in config' };
  if (reducedMotion()) { showFallback(); return { ok: false, reason: 'prefers-reduced-motion' }; }
  if (!webglAvailable()) { showFallback(); return { ok: false, reason: 'no WebGL' }; }
  if (state.running) return { ok: true, reason: 'already running' };

  try {
    if (!build()) { showFallback(); return { ok: false, reason: 'no canvas element' }; }
  } catch (e) {
    showFallback();
    return { ok: false, reason: 'build failed: ' + (e && e.message) };
  }

  state.running = true;
  state.clock.start();
  frame();

  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('mousemove', onPointer, { passive: true });
  window.addEventListener('touchmove', onPointer, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);

  return { ok: true };
}

export function pause() {
  state.running = false;
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = null;
}

export function resume() {
  if (state.running || !state.renderer) return;
  state.running = true;
  state.clock.getDelta();     // discard the gap so nothing jumps
  frame();
}

/**
 * Feed the market in.
 *
 * @param changePct  percentage change over the display window
 *
 * The mapping saturates around ±6%: beyond that the scene is already at full
 * tilt and pushing further would only make it distracting.
 */
export function setMarket(changePct) {
  if (!isFinite(changePct)) return;
  var clamped = Math.max(-6, Math.min(6, changePct));
  state.market.direction = clamped / 6;
  state.market.intensity = Math.min(1, Math.abs(clamped) / 6);
}

export function destroy() {
  pause();
  window.removeEventListener('resize', onResize);
  window.removeEventListener('mousemove', onPointer);
  window.removeEventListener('touchmove', onPointer);
  document.removeEventListener('visibilitychange', onVisibility);

  // Three.js does not garbage-collect GPU resources for you.
  state.disposables.forEach(function (d) {
    try { d.dispose && d.dispose(); } catch (_) {}
  });
  state.disposables = [];

  if (state.renderer) {
    try { state.renderer.dispose(); } catch (_) {}
    state.renderer = null;
  }
  state.scene = null;
  state.camera = null;
  state.groups = {};
}

export function isRunning() { return state.running; }
