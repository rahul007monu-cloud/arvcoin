/* =========================================================
   arvcoin — 3D scene

   Two independent scenes:
     1) #bg-canvas   — full-page depth field: drifting particles
                       plus slowly rotating wireframe solids
     2) #lux-stage   — hero centrepiece: a rotating glass coin
                       inside orbiting rings

   Guards:
     - bails out silently if THREE is unavailable
     - honours prefers-reduced-motion
     - scales geometry/particle counts down on small screens
     - pauses rendering when the tab is hidden
   ========================================================= */
(function () {
  "use strict";

  if (typeof THREE === "undefined") {
    console.warn("[arvcoin] three.js not loaded — skipping 3D");
    return;
  }

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var isSmall = window.innerWidth < 760;
  var DPR = Math.min(window.devicePixelRatio || 1, isSmall ? 1.5 : 2);

  var VIOLET = 0x7c5cff;
  var CYAN = 0x00e0ff;
  var MINT = 0x00ffa3;

  /* Shared pointer state, smoothed */
  var ptr = { x: 0, y: 0, sx: 0, sy: 0 };
  if (!reduced) {
    window.addEventListener("pointermove", function (e) {
      ptr.x = (e.clientX / window.innerWidth) * 2 - 1;
      ptr.y = (e.clientY / window.innerHeight) * 2 - 1;
    }, { passive: true });
  }

  var hidden = false;
  document.addEventListener("visibilitychange", function () {
    hidden = document.hidden;
  });

  /* Soft radial sprite texture for particles */
  function dotTexture() {
    var c = document.createElement("canvas");
    c.width = c.height = 64;
    var g = c.getContext("2d");
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  /* =========================================================
     SCENE 1 — background depth field
     ========================================================= */
  function backgroundField() {
    var canvas = document.getElementById("bg-canvas");
    if (!canvas) return;

    var renderer = new THREE.WebGLRenderer({
      canvas: canvas, alpha: true, antialias: !isSmall
    });
    renderer.setPixelRatio(DPR);
    renderer.setSize(window.innerWidth, window.innerHeight);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.position.z = 420;

    var tex = dotTexture();

    /* ---- layered particles ---- */
    var layers = [];
    var layerSpec = isSmall
      ? [{ n: 320, z: 260, size: 3.4, color: VIOLET, o: 0.55 },
         { n: 220, z: 120, size: 2.4, color: CYAN, o: 0.45 }]
      : [{ n: 700, z: 420, size: 3.8, color: VIOLET, o: 0.6 },
         { n: 520, z: 240, size: 2.8, color: CYAN, o: 0.5 },
         { n: 320, z: 90, size: 2.0, color: MINT, o: 0.38 }];

    layerSpec.forEach(function (spec) {
      var geo = new THREE.BufferGeometry();
      var pos = new Float32Array(spec.n * 3);
      for (var i = 0; i < spec.n; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 1500;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 1000;
        pos[i * 3 + 2] = -spec.z - Math.random() * 220;
      }
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

      var mat = new THREE.PointsMaterial({
        size: spec.size, map: tex, color: spec.color,
        transparent: true, opacity: spec.o,
        blending: THREE.AdditiveBlending,
        depthWrite: false, sizeAttenuation: true
      });

      var pts = new THREE.Points(geo, mat);
      scene.add(pts);
      layers.push({ mesh: pts, speed: 0.02 + Math.random() * 0.03 });
    });

    /* Note: wireframe solids were removed — they read as clutter.
       The background is now pure atmospheric depth. The sense of
       three dimensions comes from the page content floating on
       scroll (see initScrollFloat in lux.js). */

    /* ---- resize ---- */
    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      }, 150);
    });

    /* ---- loop ---- */
    function frame(t) {
      requestAnimationFrame(frame);
      if (hidden) return;

      ptr.sx += (ptr.x - ptr.sx) * 0.04;
      ptr.sy += (ptr.y - ptr.sy) * 0.04;

      if (!reduced) {
        layers.forEach(function (l, i) {
          l.mesh.rotation.z += l.speed * 0.004;
          var d = (i + 1) * 9;
          l.mesh.position.x = -ptr.sx * d;
          l.mesh.position.y = ptr.sy * d;
        });

        // camera drifts with the pointer and eases with scroll,
        // so the starfield parallaxes gently behind the content
        camera.position.x = -ptr.sx * 26;
        camera.position.y = ptr.sy * 20 - (window.scrollY || 0) * 0.012;
        camera.lookAt(0, 0, -200);
      }

      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }

  /* =========================================================
     SCENE 2 — hero centrepiece (#lux-stage)
     Rotating coin with orbiting rings
     ========================================================= */
  function heroStage() {
    var host = document.getElementById("lux-stage");
    if (!host) return;

    var w = host.clientWidth || 480;
    var h = host.clientHeight || 480;

    var renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(DPR);
    renderer.setSize(w, h);
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.pointerEvents = "none";
    host.insertBefore(renderer.domElement, host.firstChild);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(46, w / h, 0.1, 100);
    camera.position.set(0, 0, 12);

    var root = new THREE.Group();
    scene.add(root);

    /* ---- lights ---- */
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    var l1 = new THREE.PointLight(VIOLET, 2.4, 60); l1.position.set(-8, 6, 10); scene.add(l1);
    var l2 = new THREE.PointLight(CYAN, 2.0, 60); l2.position.set(9, -4, 8); scene.add(l2);
    var l3 = new THREE.PointLight(MINT, 1.4, 50); l3.position.set(0, -8, -6); scene.add(l3);

    /* ---- the coin ---- */
    var coinGroup = new THREE.Group();
    root.add(coinGroup);

    var coinGeo = new THREE.CylinderGeometry(3.1, 3.1, 0.42, 72);
    var coinMat = new THREE.MeshStandardMaterial({
      color: 0x11142c, metalness: 0.95, roughness: 0.22,
      emissive: VIOLET, emissiveIntensity: 0.16
    });
    var coin = new THREE.Mesh(coinGeo, coinMat);
    coin.rotation.x = Math.PI / 2;
    coinGroup.add(coin);

    // rim glow
    var rimGeo = new THREE.TorusGeometry(3.16, 0.075, 12, 84);
    var rimMat = new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.85 });
    coinGroup.add(new THREE.Mesh(rimGeo, rimMat));

    // the "A" mark, extruded from a shape
    var shape = new THREE.Shape();
    shape.moveTo(-1.25, -1.15);
    shape.lineTo(0, 1.5);
    shape.lineTo(1.25, -1.15);
    shape.lineTo(0.72, -1.15);
    shape.lineTo(0, 0.42);
    shape.lineTo(-0.72, -1.15);
    shape.lineTo(-1.25, -1.15);

    var aGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.16, bevelEnabled: false });
    var aMat = new THREE.MeshStandardMaterial({
      color: MINT, metalness: 0.7, roughness: 0.25,
      emissive: MINT, emissiveIntensity: 0.55
    });
    var aFront = new THREE.Mesh(aGeo, aMat);
    aFront.position.z = 0.22;
    coinGroup.add(aFront);

    var aBack = new THREE.Mesh(aGeo, aMat.clone());
    aBack.position.z = -0.38;
    aBack.rotation.y = Math.PI;
    coinGroup.add(aBack);

    // crossbar
    var barGeo = new THREE.BoxGeometry(1.28, 0.2, 0.16);
    var bar1 = new THREE.Mesh(barGeo, aMat);
    bar1.position.set(0, -0.34, 0.3);
    coinGroup.add(bar1);
    var bar2 = new THREE.Mesh(barGeo, aMat);
    bar2.position.set(0, -0.34, -0.3);
    coinGroup.add(bar2);

    /* ---- orbiting rings ---- */
    var rings = [];
    [
      { r: 4.5, tube: 0.028, color: CYAN, op: 0.7, tilt: 0.5, speed: 0.0055 },
      { r: 5.5, tube: 0.022, color: VIOLET, op: 0.55, tilt: -0.85, speed: -0.004 },
      { r: 6.6, tube: 0.018, color: MINT, op: 0.35, tilt: 1.25, speed: 0.003 }
    ].forEach(function (r) {
      var m = new THREE.Mesh(
        new THREE.TorusGeometry(r.r, r.tube, 8, 128),
        new THREE.MeshBasicMaterial({ color: r.color, transparent: true, opacity: r.op })
      );
      m.rotation.x = r.tilt;
      root.add(m);
      rings.push({ mesh: m, speed: r.speed, tilt: r.tilt });
    });

    /* Note: the orbiting geometric shards were removed — they read as
       floating blocks rather than luxury. The coin and its rings carry
       the scene; depth comes from the content floating on scroll. */

    /* ---- dust ---- */
    var dustGeo = new THREE.BufferGeometry();
    var dn = isSmall ? 90 : 190;
    var dpos = new Float32Array(dn * 3);
    for (var j = 0; j < dn; j++) {
      var a = Math.random() * Math.PI * 2;
      var rr = 3 + Math.random() * 7;
      dpos[j * 3] = Math.cos(a) * rr;
      dpos[j * 3 + 1] = (Math.random() - 0.5) * 12;
      dpos[j * 3 + 2] = Math.sin(a) * rr;
    }
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dpos, 3));
    var dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      size: 0.07, map: dotTexture(), color: 0xffffff,
      transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    root.add(dust);

    /* ---- resize ---- */
    var rt;
    window.addEventListener("resize", function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        var nw = host.clientWidth || 480, nh = host.clientHeight || 480;
        camera.aspect = nw / nh;
        camera.updateProjectionMatrix();
        renderer.setSize(nw, nh);
      }, 150);
    });

    /* ---- loop ---- */
    function frame(t) {
      requestAnimationFrame(frame);
      if (hidden) return;

      if (reduced) {
        coinGroup.rotation.y = 0.5;
        renderer.render(scene, camera);
        return;
      }

      // coin spins continuously, with a gentle wobble
      coinGroup.rotation.y = t * 0.00042;
      coinGroup.rotation.z = Math.sin(t * 0.0005) * 0.09;
      coinGroup.position.y = Math.sin(t * 0.0007) * 0.26;

      rings.forEach(function (r, i) {
        r.mesh.rotation.z += r.speed;
        r.mesh.rotation.x = r.tilt + Math.sin(t * 0.0004 + i) * 0.14;
      });

      dust.rotation.y = t * 0.00007;

      // whole rig tilts toward the pointer
      ptr.sx += (ptr.x - ptr.sx) * 0.045;
      ptr.sy += (ptr.y - ptr.sy) * 0.045;
      root.rotation.y = ptr.sx * 0.34;
      root.rotation.x = ptr.sy * 0.24;

      l1.position.x = -8 + ptr.sx * 3;
      l2.position.x = 9 + ptr.sx * 3;

      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }

  function boot() {
    try { backgroundField(); } catch (e) { console.warn("[arvcoin] bg scene:", e); }
    try { heroStage(); } catch (e) { console.warn("[arvcoin] hero scene:", e); }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
