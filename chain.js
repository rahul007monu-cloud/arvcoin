/* =========================================================
   arvcoin — scroll-driven rotating chain

   A ring of connected blocks. Scrolling through the section
   rotates the chain; whichever block faces the camera is
   highlighted, and the HTML caption below updates to match.

   Mount points expected in the page:
     #chain-sticky   the sticky 100vh stage
     #chain-canvas   the WebGL canvas
     #chain-title / #chain-body / #chain-index   caption
     #chain-dots     progress dots

   Guards: skips if THREE is missing, falls back to a static
   list under prefers-reduced-motion, pauses when off-screen.
   ========================================================= */
(function () {
  "use strict";

  var section = document.getElementById("chain-section");
  if (!section) return;

  var CFG = window.ARV_CONFIG || {};
  var canvas = document.getElementById("chain-canvas");
  var sticky = document.getElementById("chain-sticky");

  /* ---------------------------------------------------------
     Blocks — the services shown on the chain
  --------------------------------------------------------- */
  var S = CFG.SEGMENTS || {};
  var BLOCKS = [
    { key: "equity", label: "Stocks", sub: "NSE · BSE",
      title: "Stocks",
      body: (S.equity && S.equity.blurb) || "Cash equity across large, mid and small caps.",
      color: 0x7c5cff },
    { key: "options", label: "F&O", sub: "Derivatives",
      title: "F&O / Options",
      body: (S.options && S.options.blurb) || "Index and stock derivatives — futures, calls, puts and spreads.",
      color: 0x00e0ff },
    { key: "commodity", label: "Commodity", sub: "MCX · NCDEX",
      title: "Commodity",
      body: (S.commodity && S.commodity.blurb) || "Metals, energy and agri contracts.",
      color: 0xffb020 },
    { key: "currency", label: "Currency", sub: "INR pairs",
      title: "Currency",
      body: (S.currency && S.currency.blurb) || "Exchange-traded currency derivatives, INR pairs only.",
      color: 0x00ffa3 },
    { key: "crypto", label: "Crypto", sub: "Digital assets",
      title: "Crypto",
      body: (S.crypto && S.crypto.blurb) || "Major digital assets, outside SEBI's remit.",
      color: 0xf7931a },
    { key: "levels", label: "Levels", sub: "Free tool",
      title: "Levels calculator",
      body: "Support, resistance, pivots and CPR for any instrument — computed from standard public formulas. Free, no login.",
      color: 0x00e0ff },
    { key: "recap", label: "Recap", sub: "Daily",
      title: "Daily market recap",
      body: "A factual summary of what moved and why — written in the past tense, never as a forecast.",
      color: 0xdfe6ff },
    { key: "lessons", label: "Lessons", sub: "Education",
      title: "Structured lessons",
      body: "Market concepts from the basics to advanced, so you understand the reasoning rather than just following it.",
      color: 0xe8c98a }
  ];

  var N = BLOCKS.length;

  /* ---------------------------------------------------------
     Caption + dots
  --------------------------------------------------------- */
  var elTitle = document.getElementById("chain-title");
  var elBody = document.getElementById("chain-body");
  var elIndex = document.getElementById("chain-index");
  var elDots = document.getElementById("chain-dots");

  if (elDots) {
    elDots.innerHTML = BLOCKS.map(function (b, i) {
      return '<span class="cd" data-i="' + i + '"></span>';
    }).join("");
  }

  var activeIdx = -1;
  function setActive(i) {
    if (i === activeIdx) return;
    activeIdx = i;
    var b = BLOCKS[i];
    if (!b) return;

    if (elTitle) elTitle.textContent = b.title;
    if (elBody) elBody.textContent = b.body;
    if (elIndex) elIndex.textContent = String(i + 1).padStart(2, "0") + " / " + String(N).padStart(2, "0");

    if (elDots) {
      Array.prototype.forEach.call(elDots.children, function (d, j) {
        d.classList.toggle("on", j === i);
      });
    }
  }
  setActive(0);

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------------------------------
     Reduced motion / no THREE -> static grid fallback
  --------------------------------------------------------- */
  if (reduced || typeof THREE === "undefined" || !canvas) {
    section.classList.add("chain-fallback");
    var fb = document.getElementById("chain-fallback-grid");
    if (fb) {
      fb.innerHTML = BLOCKS.map(function (b) {
        return '<div class="lux lux-card">' +
          '<div class="ico" style="color:#' + b.color.toString(16).padStart(6, "0") + '">◧</div>' +
          '<h3>' + b.title + '</h3><p>' + b.body + '</p></div>';
      }).join("");
    }
    return;
  }

  /* ---------------------------------------------------------
     Label textures
  --------------------------------------------------------- */
  function labelTexture(b) {
    var c = document.createElement("canvas");
    var W = 512, H = 512;
    c.width = W; c.height = H;
    var g = c.getContext("2d");
    var hex = "#" + b.color.toString(16).padStart(6, "0");

    // face
    g.fillStyle = "rgba(10,12,28,0.94)";
    g.fillRect(0, 0, W, H);

    // inner border
    g.strokeStyle = hex;
    g.globalAlpha = 0.55;
    g.lineWidth = 6;
    g.strokeRect(26, 26, W - 52, H - 52);
    g.globalAlpha = 1;

    // corner ticks
    g.strokeStyle = hex;
    g.lineWidth = 10;
    [[26, 26, 1, 1], [W - 26, 26, -1, 1], [26, H - 26, 1, -1], [W - 26, H - 26, -1, -1]]
      .forEach(function (p) {
        g.beginPath();
        g.moveTo(p[0], p[1] + 54 * p[3]);
        g.lineTo(p[0], p[1]);
        g.lineTo(p[0] + 54 * p[2], p[1]);
        g.stroke();
      });

    // hash-like top line
    g.fillStyle = "rgba(255,255,255,0.28)";
    g.font = "500 26px 'Space Grotesk', monospace";
    g.textAlign = "center";
    g.fillText("0x" + (b.key + "00000000").slice(0, 8).toUpperCase(), W / 2, 108);

    // label
    g.fillStyle = "#ffffff";
    g.font = "800 74px Sora, sans-serif";
    g.fillText(b.label, W / 2, W / 2 + 6);

    // sub
    g.fillStyle = hex;
    g.font = "600 34px 'Space Grotesk', sans-serif";
    g.fillText(b.sub, W / 2, W / 2 + 68);

    var t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  }

  /* ---------------------------------------------------------
     Scene
  --------------------------------------------------------- */
  var isSmall = window.innerWidth < 760;
  var DPR = Math.min(window.devicePixelRatio || 1, isSmall ? 1.5 : 2);

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: !isSmall });
  renderer.setPixelRatio(DPR);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
  camera.position.set(0, 1.4, 15.5);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  var key = new THREE.PointLight(0x7c5cff, 2.2, 80); key.position.set(-10, 8, 14); scene.add(key);
  var fill = new THREE.PointLight(0x00e0ff, 1.8, 80); fill.position.set(11, -5, 10); scene.add(fill);
  var rim = new THREE.PointLight(0x00ffa3, 1.2, 60); rim.position.set(0, -9, -8); scene.add(rim);

  var chain = new THREE.Group();
  scene.add(chain);

  var RADIUS = isSmall ? 6.4 : 8.2;
  var BLOCK = isSmall ? 1.5 : 1.85;

  var blockMeshes = [];

  BLOCKS.forEach(function (b, i) {
    var ang = (i / N) * Math.PI * 2;
    var holder = new THREE.Group();
    holder.position.set(Math.sin(ang) * RADIUS, 0, Math.cos(ang) * RADIUS);
    holder.rotation.y = ang;               // face outward
    chain.add(holder);

    // solid body
    var body = new THREE.Mesh(
      new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK * 0.34),
      new THREE.MeshStandardMaterial({
        color: 0x0b0e20, metalness: 0.9, roughness: 0.32,
        emissive: b.color, emissiveIntensity: 0.06
      })
    );
    holder.add(body);

    // labelled front face
    var face = new THREE.Mesh(
      new THREE.PlaneGeometry(BLOCK * 0.96, BLOCK * 0.96),
      new THREE.MeshBasicMaterial({ map: labelTexture(b), transparent: true })
    );
    face.position.z = BLOCK * 0.171 + 0.002;
    holder.add(face);

    // glowing edge
    var edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK * 0.34)),
      new THREE.LineBasicMaterial({ color: b.color, transparent: true, opacity: 0.5 })
    );
    holder.add(edge);

    blockMeshes.push({ holder: holder, body: body, edge: edge, face: face, color: b.color, ang: ang });
  });

  /* ---- links between blocks ---- */
  for (var i = 0; i < N; i++) {
    var a1 = (i / N) * Math.PI * 2;
    var a2 = ((i + 1) / N) * Math.PI * 2;
    var p1 = new THREE.Vector3(Math.sin(a1) * RADIUS, 0, Math.cos(a1) * RADIUS);
    var p2 = new THREE.Vector3(Math.sin(a2) * RADIUS, 0, Math.cos(a2) * RADIUS);
    var mid = p1.clone().add(p2).multiplyScalar(0.5);
    var len = p1.distanceTo(p2) - BLOCK * 0.9;

    var link = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, Math.max(0.2, len), 8),
      new THREE.MeshBasicMaterial({ color: 0x00e0ff, transparent: true, opacity: 0.34 })
    );
    link.position.copy(mid);
    link.rotation.z = Math.PI / 2;
    link.rotation.y = -Math.atan2(p2.z - p1.z, p2.x - p1.x);
    chain.add(link);
  }

  /* ---- faint ground ring ---- */
  var ring = new THREE.Mesh(
    new THREE.TorusGeometry(RADIUS, 0.012, 6, 160),
    new THREE.MeshBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.3 })
  );
  ring.rotation.x = Math.PI / 2;
  chain.add(ring);

  /* ---------------------------------------------------------
     Size
  --------------------------------------------------------- */
  function size() {
    var w = sticky.clientWidth || window.innerWidth;
    var h = sticky.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  size();

  var rz;
  window.addEventListener("resize", function () {
    clearTimeout(rz);
    rz = setTimeout(size, 150);
  });

  /* ---------------------------------------------------------
     Scroll progress through the section
  --------------------------------------------------------- */
  var progress = 0, target = 0;

  function computeProgress() {
    var r = section.getBoundingClientRect();
    var total = r.height - window.innerHeight;
    if (total <= 0) { target = 0; return; }
    var p = -r.top / total;
    target = Math.max(0, Math.min(1, p));
  }

  var visible = true;
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (es) {
      visible = es[0].isIntersecting;
    }, { rootMargin: "120px" }).observe(section);
  }

  window.addEventListener("scroll", computeProgress, { passive: true });
  computeProgress();

  /* ---------------------------------------------------------
     Loop
  --------------------------------------------------------- */
  var TWO_PI = Math.PI * 2;

  function frame(t) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;

    progress += (target - progress) * 0.09;

    // scroll drives one full revolution, plus a slow idle drift
    var scrollRot = progress * TWO_PI;
    var idle = t * 0.00004;
    chain.rotation.y = -scrollRot + idle;

    // slight tilt so the ring reads as 3D, easing as you scroll
    chain.rotation.x = 0.16 + Math.sin(progress * Math.PI) * 0.06;
    chain.position.y = Math.sin(t * 0.0005) * 0.16;

    // which block faces the camera
    var step = TWO_PI / N;
    var idx = Math.round(scrollRot / step) % N;
    if (idx < 0) idx += N;
    setActive(idx);

    // highlight the front block, dim the rest
    blockMeshes.forEach(function (m, i) {
      var world = (m.ang - chain.rotation.y) % TWO_PI;
      var facing = Math.cos(world);              // 1 = toward camera
      var lit = Math.max(0, facing);

      m.body.material.emissiveIntensity = 0.05 + lit * 0.5;
      m.edge.material.opacity = 0.2 + lit * 0.65;
      m.face.material.opacity = 0.35 + lit * 0.65;

      // the active block lifts and spins on its own axis
      var isActive = i === idx;
      var targetY = isActive ? 0.42 : 0;
      m.holder.position.y += (targetY - m.holder.position.y) * 0.08;
      m.body.rotation.y += (isActive ? 0.012 : 0.002);
      m.edge.rotation.y = m.body.rotation.y;
    });

    key.position.x = -10 + Math.sin(t * 0.0004) * 4;
    fill.position.x = 11 + Math.cos(t * 0.0004) * 4;

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
})();
