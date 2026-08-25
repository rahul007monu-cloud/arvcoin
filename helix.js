/* =========================================================
   arvcoin — DNA double helix

   A single helix runs the full height of the document. It lives on a
   fixed, full-viewport canvas behind the content, so as you scroll the
   page you travel down the strand — it rotates and rises continuously
   from the top of the site to the bottom.

   Structure:
     - two intertwined strands, phase-offset by PI
     - rungs joining them, like base pairs
     - glowing service nodes spaced along the strand; when a node passes
       the viewport centre it flares and the caption updates

   Guards: skips without THREE, static under prefers-reduced-motion,
   pauses when the tab is hidden, lighter geometry on small screens.
   ========================================================= */
(function () {
  "use strict";

  if (typeof THREE === "undefined") return;

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return;

  var CFG = window.ARV_CONFIG || {};
  var S = CFG.SEGMENTS || {};

  /* ---------------------------------------------------------
     Service nodes carried on the strand
  --------------------------------------------------------- */
  var NODES = [
    { label: "Stocks",     sub: "NSE · BSE",       color: 0x7c5cff,
      body: (S.equity && S.equity.blurb) || "Cash equity across large, mid and small caps." },
    { label: "F&O",        sub: "Derivatives",     color: 0x00e0ff,
      body: (S.options && S.options.blurb) || "Index and stock derivatives." },
    { label: "Commodity",  sub: "MCX · NCDEX",     color: 0xffb020,
      body: (S.commodity && S.commodity.blurb) || "Metals, energy and agri contracts." },
    { label: "Currency",   sub: "INR pairs",       color: 0x00ffa3,
      body: (S.currency && S.currency.blurb) || "Exchange-traded currency derivatives." },
    { label: "Crypto",     sub: "Digital assets",  color: 0xf7931a,
      body: (S.crypto && S.crypto.blurb) || "Major digital assets." },
    { label: "Levels",     sub: "Free tool",       color: 0x00e0ff,
      body: "Support, resistance, pivots and CPR for any instrument. Free, no login." },
    { label: "Recap",      sub: "Daily",           color: 0xdfe6ff,
      body: "A factual summary of what moved, and why." },
    { label: "Lessons",    sub: "Education",       color: 0xe8c98a,
      body: "Market concepts from the basics to advanced." }
  ];

  var isSmall = window.innerWidth < 760;
  var DPR = Math.min(window.devicePixelRatio || 1, isSmall ? 1.4 : 1.9);

  /* ---------------------------------------------------------
     Canvas — fixed, behind the content
  --------------------------------------------------------- */
  var canvas = document.createElement("canvas");
  canvas.id = "helix-canvas";
  document.body.appendChild(canvas);

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: !isSmall });
  renderer.setPixelRatio(DPR);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
  camera.position.set(0, 0, 26);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  var l1 = new THREE.PointLight(0x7c5cff, 2.4, 120); l1.position.set(-16, 12, 24); scene.add(l1);
  var l2 = new THREE.PointLight(0x00e0ff, 2.0, 120); l2.position.set(16, -10, 20); scene.add(l2);
  var l3 = new THREE.PointLight(0x00ffa3, 1.3, 90);  l3.position.set(0, -18, 6);   scene.add(l3);

  /* the whole strand lives in one group we translate and spin */
  var helix = new THREE.Group();
  scene.add(helix);

  /* ---------------------------------------------------------
     Geometry
     The strand is built once, tall enough to cover the document.
     TURNS controls how tightly it coils.
  --------------------------------------------------------- */
  var R = isSmall ? 3.4 : 4.6;          // helix radius
  var SPAN = 260;                        // virtual strand length in world units
  var TURNS = isSmall ? 7 : 9;           // full rotations across the span
  var STEPS = isSmall ? 200 : 320;       // sample points per strand

  function strandPoints(phase) {
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
    return pts;
  }

  /* ---- the two backbones, as tubes so they catch light ---- */
  var strandMats = [
    new THREE.MeshStandardMaterial({
      color: 0x1a1740, metalness: 0.9, roughness: 0.3,
      emissive: 0x7c5cff, emissiveIntensity: 0.4
    }),
    new THREE.MeshStandardMaterial({
      color: 0x0d2436, metalness: 0.9, roughness: 0.3,
      emissive: 0x00e0ff, emissiveIntensity: 0.35
    })
  ];

  [0, Math.PI].forEach(function (phase, si) {
    var curve = new THREE.CatmullRomCurve3(strandPoints(phase));
    var tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, STEPS, isSmall ? 0.11 : 0.14, 8, false),
      strandMats[si]
    );
    helix.add(tube);
  });

  /* ---- rungs (base pairs) ---- */
  var RUNGS = isSmall ? 44 : 68;
  var rungs = [];
  var rungGeo = new THREE.CylinderGeometry(0.035, 0.035, R * 2, 6);

  for (var i = 0; i < RUNGS; i++) {
    var t = i / (RUNGS - 1);
    var a = t * TURNS * Math.PI * 2;
    var y = -t * SPAN + SPAN / 2;

    var mat = new THREE.MeshBasicMaterial({
      color: i % 2 ? 0x00e0ff : 0x7c5cff,
      transparent: true, opacity: 0.3
    });

    var rung = new THREE.Mesh(rungGeo, mat);
    rung.position.set(0, y, 0);
    rung.rotation.z = Math.PI / 2;
    rung.rotation.y = -a;
    helix.add(rung);
    rungs.push({ mesh: rung, y: y, mat: mat });
  }

  /* ---------------------------------------------------------
     Service nodes — labelled beads riding the strand
  --------------------------------------------------------- */
  function nodeTexture(n) {
    var c = document.createElement("canvas");
    c.width = 384; c.height = 192;
    var g = c.getContext("2d");
    var hex = "#" + n.color.toString(16).padStart(6, "0");

    g.clearRect(0, 0, 384, 192);

    // pill
    var r = 26, w = 384, h = 96, y0 = 48;
    g.fillStyle = "rgba(8,10,24,0.9)";
    g.strokeStyle = hex;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(r, y0);
    g.lineTo(w - r, y0);
    g.quadraticCurveTo(w, y0, w, y0 + r);
    g.lineTo(w, y0 + h - r);
    g.quadraticCurveTo(w, y0 + h, w - r, y0 + h);
    g.lineTo(r, y0 + h);
    g.quadraticCurveTo(0, y0 + h, 0, y0 + h - r);
    g.lineTo(0, y0 + r);
    g.quadraticCurveTo(0, y0, r, y0);
    g.closePath();
    g.fill();
    g.stroke();

    g.textAlign = "left";
    g.fillStyle = "#fff";
    g.font = "800 40px Sora, sans-serif";
    g.fillText(n.label, 28, y0 + 44);

    g.fillStyle = hex;
    g.font = "600 22px 'Space Grotesk', sans-serif";
    g.fillText(n.sub, 28, y0 + 76);

    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }

  var nodes = [];
  NODES.forEach(function (n, i) {
    // spread the nodes down the strand, avoiding the very ends
    var t = 0.06 + (i / (NODES.length - 1)) * 0.88;
    var a = t * TURNS * Math.PI * 2;
    var y = -t * SPAN + SPAN / 2;

    var holder = new THREE.Group();
    holder.position.set(Math.cos(a) * R, y, Math.sin(a) * R);
    helix.add(holder);

    // glowing bead
    var bead = new THREE.Mesh(
      new THREE.SphereGeometry(isSmall ? 0.4 : 0.52, 20, 16),
      new THREE.MeshStandardMaterial({
        color: n.color, metalness: 0.6, roughness: 0.2,
        emissive: n.color, emissiveIntensity: 0.9
      })
    );
    holder.add(bead);

    // halo
    var halo = new THREE.Mesh(
      new THREE.SphereGeometry(isSmall ? 0.78 : 1.0, 16, 12),
      new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity: 0.14 })
    );
    holder.add(halo);

    // label plate, always facing the camera
    var plate = new THREE.Sprite(new THREE.SpriteMaterial({
      map: nodeTexture(n), transparent: true, opacity: 0.9, depthWrite: false
    }));
    plate.scale.set(isSmall ? 4.6 : 5.8, isSmall ? 2.3 : 2.9, 1);
    plate.position.set(0, isSmall ? 1.4 : 1.7, 0);
    holder.add(plate);

    nodes.push({ holder: holder, bead: bead, halo: halo, plate: plate, data: n, y: y, t: t });
  });

  /* ---------------------------------------------------------
     Caption sync (optional — only if the section exists)
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
     Size
  --------------------------------------------------------- */
  function size() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    // shift the strand to one side on wide screens so text stays clear
    helix.position.x = w > 1100 ? R + 4.5 : 0;
    camera.position.x = w > 1100 ? R + 4.5 : 0;
  }
  size();

  var rz;
  window.addEventListener("resize", function () {
    clearTimeout(rz);
    rz = setTimeout(size, 150);
  });

  /* ---------------------------------------------------------
     Scroll — drives travel down the strand and its spin
  --------------------------------------------------------- */
  var prog = 0, targetProg = 0;

  function computeProgress() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    targetProg = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  }
  computeProgress();
  window.addEventListener("scroll", computeProgress, { passive: true });
  window.addEventListener("load", computeProgress);

  /* ---------------------------------------------------------
     Loop
  --------------------------------------------------------- */
  var ptrX = 0, ptrSX = 0;
  window.addEventListener("pointermove", function (e) {
    ptrX = (e.clientX / window.innerWidth) * 2 - 1;
  }, { passive: true });

  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden) return;

    prog += (targetProg - prog) * 0.07;
    ptrSX += (ptrX - ptrSX) * 0.05;

    /* Travel: the strand rises as you scroll, so you move down it.
       Spin: scrolling also rotates it, which is what makes the double
       helix read as a helix rather than a flat wave. */
    var travel = prog * (SPAN - 40);
    helix.position.y = travel - SPAN / 2 + 20;
    helix.rotation.y = prog * Math.PI * 2.4 + t * 0.00003;

    // gentle float, independent of scroll
    helix.position.y += Math.sin(t * 0.0004) * 0.7;
    helix.rotation.z = Math.sin(t * 0.00028) * 0.035 + ptrSX * 0.05;

    // nodes: flare as they pass the viewport centre (world y ~ 0)
    var best = -1, bestD = 1e9;
    nodes.forEach(function (n, i) {
      var wy = n.y + helix.position.y;
      var d = Math.abs(wy);
      if (d < bestD) { bestD = d; best = i; }

      var near = Math.max(0, 1 - d / 16);
      n.bead.material.emissiveIntensity = 0.5 + near * 1.6;
      n.halo.material.opacity = 0.06 + near * 0.3;
      n.halo.scale.setScalar(1 + near * 0.5 + Math.sin(t * 0.002 + i) * 0.04);
      n.plate.material.opacity = 0.2 + near * 0.8;

      // beads counter-rotate so labels stay legible
      n.holder.rotation.y = -helix.rotation.y;
    });

    if (bestD < 30) setActive(best);

    // rungs fade with distance from the viewport centre
    rungs.forEach(function (r) {
      var wy = r.y + helix.position.y;
      r.mat.opacity = Math.max(0.04, 0.34 - Math.abs(wy) / 90);
    });

    l1.position.y = -travel * 0.1 + 12;
    l2.position.y = -travel * 0.1 - 10;

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
})();
