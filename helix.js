/* =========================================================
   arvcoin — DNA double helix (high fidelity)

   A single strand runs from just below the hero to the bottom of the
   document, on a fixed full-viewport canvas behind the content. Scroll
   travels you down it while it rotates.

   Quality approach — r128 from a CDN has no post-processing addons, so
   bloom is faked with layered additive shells rather than an
   EffectComposer pass:

     - each backbone is three concentric tubes: an emissive core, a
       translucent mid shell, and a wide additive halo
     - high segment counts, ACES filmic tone mapping, high pixel ratio
     - label plates render at 2x and are mipmapped for crisp text
     - travelling sparks ride the strand to catch the eye

   Guards: skips without THREE, static under prefers-reduced-motion,
   pauses when hidden, and steps geometry down on small screens.
   ========================================================= */
(function () {
  "use strict";

  if (typeof THREE === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var CFG = window.ARV_CONFIG || {};
  var S = CFG.SEGMENTS || {};

  /* ---------------------------------------------------------
     Service beads carried on the strand
  --------------------------------------------------------- */
  var NODES = [
    { label: "Stocks",    sub: "NSE · BSE",      color: 0x8b6cff,
      body: (S.equity && S.equity.blurb) || "Cash equity across large, mid and small caps." },
    { label: "F&O",       sub: "Derivatives",    color: 0x33e6ff,
      body: (S.options && S.options.blurb) || "Index and stock derivatives." },
    { label: "Commodity", sub: "MCX · NCDEX",    color: 0xffc247,
      body: (S.commodity && S.commodity.blurb) || "Metals, energy and agri contracts." },
    { label: "Currency",  sub: "INR pairs",      color: 0x33ffb4,
      body: (S.currency && S.currency.blurb) || "Exchange-traded currency derivatives." },
    { label: "Crypto",    sub: "Digital assets", color: 0xffa53d,
      body: (S.crypto && S.crypto.blurb) || "Major digital assets." },
    { label: "Levels",    sub: "Free tool",      color: 0x4de4ff,
      body: "Support, resistance, pivots and CPR for any instrument. Free, no login." },
    { label: "Recap",     sub: "Daily",          color: 0xe8ecff,
      body: "A factual summary of what moved, and why." },
    { label: "Lessons",   sub: "Education",      color: 0xf0d79a,
      body: "Market concepts from the basics to advanced." }
  ];

  var W0 = window.innerWidth;
  var isSmall = W0 < 760;
  var isMid = W0 < 1100;

  /* Crisp on retina and 4K. Capped so a 4K panel does not melt the GPU. */
  var DPR = Math.min(window.devicePixelRatio || 1, isSmall ? 2 : 2.5);

  /* ---------------------------------------------------------
     Renderer
  --------------------------------------------------------- */
  var canvas = document.createElement("canvas");
  canvas.id = "helix-canvas";
  document.body.appendChild(canvas);

  var renderer = new THREE.WebGLRenderer({
    canvas: canvas, alpha: true, antialias: true, powerPreference: "high-performance"
  });
  renderer.setPixelRatio(DPR);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  if ("outputEncoding" in renderer) renderer.outputEncoding = THREE.sRGBEncoding;

  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05060f, 0.0075);

  var camera = new THREE.PerspectiveCamera(48, 1, 0.1, 500);
  camera.position.set(0, 0, 27);

  /* ---------------------------------------------------------
     Lighting — key, fill, rim, plus a travelling accent
  --------------------------------------------------------- */
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));

  var key  = new THREE.PointLight(0x8b6cff, 1.5, 150); key.position.set(-18, 14, 26);
  var fill = new THREE.PointLight(0x33e6ff, 1.2, 150); fill.position.set(18, -12, 22);
  var rim  = new THREE.PointLight(0x33ffb4, 0.7, 110); rim.position.set(0, -20, -10);
  var accent = new THREE.PointLight(0xffffff, 1.4, 60);
  scene.add(key, fill, rim, accent);

  var helix = new THREE.Group();
  scene.add(helix);

  /* ---------------------------------------------------------
     Geometry parameters
  --------------------------------------------------------- */
  var R = isSmall ? 2.6 : 3.6;
  var SPAN = 300;
  var TURNS = isSmall ? 8 : 11;
  var STEPS = isSmall ? 320 : 560;          // curve resolution
  var RADIAL = isSmall ? 12 : 20;           // tube cross-section

  function strandCurve(phase) {
    var pts = [];
    for (var i = 0; i <= STEPS; i++) {
      var t = i / STEPS;
      var a = t * TURNS * Math.PI * 2 + phase;
      pts.push(new THREE.Vector3(
        Math.cos(a) * R,
        -t * SPAN + SPAN / 2,
        Math.sin(a) * R
      ));
    }
    return new THREE.CatmullRomCurve3(pts);
  }

  /* ---------------------------------------------------------
     Backbones — three concentric tubes each, for fake bloom
  --------------------------------------------------------- */
  var STRANDS = [
    { phase: 0,       core: 0x6d4dff, glow: 0x8b6cff },
    { phase: Math.PI, core: 0x00c8e6, glow: 0x33e6ff }
  ];

  var strandParts = [];

  STRANDS.forEach(function (sp) {
    var curve = strandCurve(sp.phase);

    // 1. emissive core — the bright filament
    var core = new THREE.Mesh(
      new THREE.TubeGeometry(curve, STEPS, isSmall ? 0.075 : 0.1, RADIAL, false),
      new THREE.MeshStandardMaterial({
        color: 0xffffff, metalness: 0.2, roughness: 0.15,
        emissive: sp.glow, emissiveIntensity: 0.85
      })
    );
    helix.add(core);

    // 2. mid shell — gives the strand body and catches the lights
    var shell = new THREE.Mesh(
      new THREE.TubeGeometry(curve, STEPS, isSmall ? 0.17 : 0.23, RADIAL, false),
      new THREE.MeshStandardMaterial({
        color: sp.core, metalness: 0.95, roughness: 0.22,
        emissive: sp.glow, emissiveIntensity: 0.22,
        transparent: true, opacity: 0.5
      })
    );
    helix.add(shell);

    // 3. wide additive halo — stands in for a bloom pass
    var halo = new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.floor(STEPS * 0.6), isSmall ? 0.42 : 0.58, 10, false),
      new THREE.MeshBasicMaterial({
        color: sp.glow, transparent: true, opacity: 0.055,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    helix.add(halo);

    strandParts.push({ core: core, shell: shell, halo: halo, curve: curve });
  });

  /* ---------------------------------------------------------
     Rungs — base pairs, with a glowing centre
  --------------------------------------------------------- */
  var RUNGS = isSmall ? 56 : 92;
  var rungs = [];
  var rungGeo = new THREE.CylinderGeometry(0.05, 0.05, R * 2, 10);
  var rungGlowGeo = new THREE.CylinderGeometry(0.13, 0.13, R * 2, 8);

  for (var i = 0; i < RUNGS; i++) {
    var t = i / (RUNGS - 1);
    var a = t * TURNS * Math.PI * 2;
    var y = -t * SPAN + SPAN / 2;
    var col = i % 2 ? 0x33e6ff : 0x8b6cff;

    var g = new THREE.Group();
    g.position.set(0, y, 0);
    g.rotation.z = Math.PI / 2;
    g.rotation.y = -a;

    var solid = new THREE.Mesh(rungGeo, new THREE.MeshStandardMaterial({
      color: 0xffffff, metalness: 0.6, roughness: 0.3,
      emissive: col, emissiveIntensity: 0.4,
      transparent: true, opacity: 0.3
    }));
    g.add(solid);

    var glow = new THREE.Mesh(rungGlowGeo, new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.03,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    g.add(glow);

    helix.add(g);
    rungs.push({ group: g, y: y, solid: solid.material, glow: glow.material });
  }

  /* ---------------------------------------------------------
     Bead labels — rendered at 2x for crisp text
  --------------------------------------------------------- */
  function beadTexture(n) {
    var SC = 2;
    var W = 420 * SC, H = 150 * SC;
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var g = c.getContext("2d");
    var hex = "#" + n.color.toString(16).padStart(6, "0");

    g.scale(SC, SC);
    var w = 420, h = 150;

    // rounded plate
    var r = 30, y0 = 30, ph = 90;
    g.beginPath();
    g.moveTo(r, y0);
    g.lineTo(w - r, y0);
    g.quadraticCurveTo(w, y0, w, y0 + r);
    g.lineTo(w, y0 + ph - r);
    g.quadraticCurveTo(w, y0 + ph, w - r, y0 + ph);
    g.lineTo(r, y0 + ph);
    g.quadraticCurveTo(0, y0 + ph, 0, y0 + ph - r);
    g.lineTo(0, y0 + r);
    g.quadraticCurveTo(0, y0, r, y0);
    g.closePath();

    var grad = g.createLinearGradient(0, y0, w, y0 + ph);
    grad.addColorStop(0, "rgba(10,12,28,0.94)");
    grad.addColorStop(1, "rgba(16,20,44,0.9)");
    g.fillStyle = grad;
    g.fill();

    g.strokeStyle = hex;
    g.lineWidth = 2.5;
    g.stroke();

    // colour flash on the left edge
    g.fillStyle = hex;
    g.fillRect(0, y0 + 16, 5, ph - 32);

    g.textAlign = "left";
    g.fillStyle = "#ffffff";
    g.font = "800 40px Sora, system-ui, sans-serif";
    g.fillText(n.label, 26, y0 + 44);

    g.fillStyle = hex;
    g.font = "600 21px 'Space Grotesk', monospace";
    g.fillText(n.sub.toUpperCase(), 26, y0 + 72);

    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy
      ? renderer.capabilities.getMaxAnisotropy() : 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    return tex;
  }

  var beads = [];
  NODES.forEach(function (n, i) {
    var t = 0.07 + (i / (NODES.length - 1)) * 0.86;
    var a = t * TURNS * Math.PI * 2;
    var y = -t * SPAN + SPAN / 2;

    var holder = new THREE.Group();
    holder.position.set(Math.cos(a) * R, y, Math.sin(a) * R);
    helix.add(holder);

    var rr = isSmall ? 0.44 : 0.58;

    // inner bright core
    var core = new THREE.Mesh(
      new THREE.SphereGeometry(rr, 32, 24),
      new THREE.MeshStandardMaterial({
        color: 0xffffff, metalness: 0.1, roughness: 0.1,
        emissive: n.color, emissiveIntensity: 1.1
      })
    );
    holder.add(core);

    // glass shell
    var shell = new THREE.Mesh(
      new THREE.SphereGeometry(rr * 1.5, 28, 20),
      new THREE.MeshStandardMaterial({
        color: n.color, metalness: 0.9, roughness: 0.12,
        transparent: true, opacity: 0.3
      })
    );
    holder.add(shell);

    // additive halos, two layers
    var halo1 = new THREE.Mesh(
      new THREE.SphereGeometry(rr * 2.3, 20, 16),
      new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false })
    );
    var halo2 = new THREE.Mesh(
      new THREE.SphereGeometry(rr * 3.6, 16, 12),
      new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity: 0.07,
        blending: THREE.AdditiveBlending, depthWrite: false })
    );
    holder.add(halo1, halo2);

    // orbiting ring for a sense of scale
    var ring = new THREE.Mesh(
      new THREE.TorusGeometry(rr * 2.1, 0.014, 8, 64),
      new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity: 0.5 })
    );
    ring.rotation.x = Math.PI / 2.6;
    holder.add(ring);

    var plate = new THREE.Sprite(new THREE.SpriteMaterial({
      map: beadTexture(n), transparent: true, opacity: 0.92, depthWrite: false
    }));
    var pw = isSmall ? 4.9 : 6.2;
    plate.scale.set(pw, pw * (150 / 420), 1);
    plate.position.set(0, isSmall ? 1.5 : 1.9, 0);
    holder.add(plate);

    beads.push({
      holder: holder, core: core, shell: shell,
      halo1: halo1, halo2: halo2, ring: ring, plate: plate,
      data: n, y: y
    });
  });

  /* ---------------------------------------------------------
     Travelling sparks along the strand
  --------------------------------------------------------- */
  var SPARKS = isSmall ? 14 : 26;
  var sparks = [];
  var sparkGeo = new THREE.SphereGeometry(isSmall ? 0.07 : 0.09, 10, 8);

  for (var s = 0; s < SPARKS; s++) {
    var strand = strandParts[s % 2];
    var m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({
      color: s % 2 ? 0x33e6ff : 0xb9a6ff,
      transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    helix.add(m);
    sparks.push({
      mesh: m, curve: strand.curve,
      u: Math.random(),
      speed: 0.00006 + Math.random() * 0.00012
    });
  }

  /* ---------------------------------------------------------
     Caption sync
  --------------------------------------------------------- */
  var elTitle = document.getElementById("helix-title");
  var elBody = document.getElementById("helix-body");
  var elIndex = document.getElementById("helix-index");
  var elDots = document.getElementById("helix-dots");

  if (elDots) {
    elDots.innerHTML = NODES.map(function () { return '<span class="cd"></span>'; }).join("");
  }

  var active = -1;
  function setActive(i) {
    if (i === active || i < 0 || i >= NODES.length) return;
    active = i;
    var n = NODES[i];
    if (elTitle) elTitle.textContent = n.label === "F&O" ? "F&O / Options" : n.label;
    if (elBody) elBody.textContent = n.body;
    if (elIndex) elIndex.textContent =
      String(i + 1).padStart(2, "0") + " / " + String(NODES.length).padStart(2, "0");
    if (elDots) Array.prototype.forEach.call(elDots.children, function (d, j) {
      d.classList.toggle("on", j === i);
    });
  }

  /* ---------------------------------------------------------
     Sizing and horizontal placement
  --------------------------------------------------------- */
  function size() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    // on wide screens the strand sits right of centre so copy stays clear
    var offset = w > 1100 ? R + 11 : 0;
    helix.position.x = offset;
    camera.position.x = offset;
  }
  size();

  var rz;
  window.addEventListener("resize", function () {
    clearTimeout(rz);
    rz = setTimeout(size, 150);
  });

  /* ---------------------------------------------------------
     Scroll — starts BELOW the hero, not at the top of the page
  --------------------------------------------------------- */
  var startY = 0;

  function measureStart() {
    var hero = document.querySelector(".lux-hero");
    if (hero) {
      var r = hero.getBoundingClientRect();
      // strand begins as the hero leaves the viewport
      startY = r.top + window.scrollY + r.height * 0.78;
    } else {
      startY = window.innerHeight * 0.7;
    }
  }
  measureStart();
  window.addEventListener("load", measureStart);
  window.addEventListener("resize", function () { setTimeout(measureStart, 200); });

  var prog = 0, targetProg = 0;
  var fade = 0, targetFade = 0;

  function computeProgress() {
    var docH = document.documentElement.scrollHeight;
    var vh = window.innerHeight;
    var span = Math.max(1, docH - vh - startY);
    var past = window.scrollY - startY;

    targetProg = Math.min(1, Math.max(0, past / span));

    // fade in over the first 55vh past the hero, so it arrives rather
    // than popping into existence
    targetFade = Math.min(1, Math.max(0, (past + vh * 0.25) / (vh * 0.55)));
  }
  computeProgress();
  window.addEventListener("scroll", computeProgress, { passive: true });
  window.addEventListener("load", computeProgress);

  /* ---------------------------------------------------------
     Pointer lean
  --------------------------------------------------------- */
  var pX = 0, pSX = 0, pY = 0, pSY = 0;
  window.addEventListener("pointermove", function (e) {
    pX = (e.clientX / window.innerWidth) * 2 - 1;
    pY = (e.clientY / window.innerHeight) * 2 - 1;
  }, { passive: true });

  /* ---------------------------------------------------------
     Loop
  --------------------------------------------------------- */
  var tmp = new THREE.Vector3();

  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden) return;

    prog += (targetProg - prog) * 0.065;
    fade += (targetFade - fade) * 0.07;
    pSX += (pX - pSX) * 0.045;
    pSY += (pY - pSY) * 0.045;

    canvas.style.opacity = (fade * (isMid ? 0.14 : 0.34)).toFixed(3);

    // nothing to draw before the hero has cleared
    if (fade < 0.01) return;

    var travel = prog * (SPAN - 46);
    helix.position.y = travel - SPAN / 2 + 22 + Math.sin(t * 0.00038) * 0.8;
    helix.rotation.y = prog * Math.PI * 2.6 + t * 0.000028;
    helix.rotation.z = Math.sin(t * 0.00026) * 0.03 + pSX * 0.045;
    helix.rotation.x = pSY * 0.02;

    // beads flare as they cross the viewport centre
    var best = -1, bestD = 1e9;
    beads.forEach(function (b, i) {
      var wy = b.y + helix.position.y;
      var d = Math.abs(wy);
      if (d < bestD) { bestD = d; best = i; }

      var near = Math.max(0, 1 - d / 18);
      var pulse = 1 + Math.sin(t * 0.0022 + i) * 0.045;

      b.core.material.emissiveIntensity = 0.55 + near * 1.3;
      b.shell.material.opacity = 0.16 + near * 0.3;
      b.halo1.material.opacity = 0.03 + near * 0.12;
      b.halo2.material.opacity = 0.012 + near * 0.055;
      b.halo1.scale.setScalar(pulse * (1 + near * 0.34));
      b.halo2.scale.setScalar(pulse * (1 + near * 0.5));
      b.plate.material.opacity = 0.12 + near * 0.88;
      b.ring.material.opacity = 0.16 + near * 0.5;
      b.ring.rotation.z += 0.006 + near * 0.012;

      // counter-rotate so labels always face front
      b.holder.rotation.y = -helix.rotation.y;
    });

    if (bestD < 34) setActive(best);

    // rungs fade with distance from centre
    rungs.forEach(function (r) {
      var wy = r.y + helix.position.y;
      var f = Math.max(0, 1 - Math.abs(wy) / 70);
      r.solid.opacity = 0.06 + f * 0.3;
      r.glow.opacity = 0.008 + f * 0.05;
    });

    // sparks run along the strands
    sparks.forEach(function (sp) {
      sp.u += sp.speed * 16;
      if (sp.u > 1) sp.u -= 1;
      sp.curve.getPointAt(sp.u, tmp);
      sp.mesh.position.copy(tmp);
      var wy = tmp.y + helix.position.y;
      sp.mesh.material.opacity = Math.max(0, 0.45 - Math.abs(wy) / 60);
    });

    key.position.y = 14 - travel * 0.08;
    fill.position.y = -12 - travel * 0.08;
    accent.position.set(helix.position.x, 0, R + 6);
    accent.intensity = 1.1 + Math.sin(t * 0.0012) * 0.3;

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
})();
