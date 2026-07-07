/* =========================================================
   arvcoin — Three.js 3D scene
   - floating particle field in the page background (#bg-canvas)
   - a glowing rotating coin in the hero (#coin-stage)
   Gracefully does nothing if THREE fails to load (CSS fallback shows).
   ========================================================= */
(function () {
  if (typeof THREE === "undefined") {
    console.warn("[arvcoin] THREE not loaded — using CSS fallback visuals.");
    return;
  }

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- Background particle field ---------------- */
  (function backgroundField() {
    const canvas = document.getElementById("bg-canvas");
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 26;

    // particles
    const COUNT = window.innerWidth < 700 ? 900 : 1800;
    const positions = new Float32Array(COUNT * 3);
    const speeds = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 90;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 60;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 50;
      speeds[i] = 0.002 + Math.random() * 0.01;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    // soft round sprite texture
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const cx = c.getContext("2d");
    const g = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(150,210,255,0.6)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    cx.fillStyle = g;
    cx.fillRect(0, 0, 64, 64);
    const sprite = new THREE.CanvasTexture(c);

    const mat = new THREE.PointsMaterial({
      size: 0.5,
      map: sprite,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: new THREE.Color(0x8fd6ff),
      opacity: 0.85,
    });
    const points = new THREE.Points(geo, mat);
    scene.add(points);

    // parallax on mouse
    let mx = 0, my = 0, tx = 0, ty = 0;
    window.addEventListener("mousemove", (e) => {
      tx = (e.clientX / window.innerWidth - 0.5);
      ty = (e.clientY / window.innerHeight - 0.5);
    });

    function resize() {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }
    window.addEventListener("resize", resize);

    const pos = geo.attributes.position.array;
    function animate() {
      requestAnimationFrame(animate);
      // drift particles upward, wrap around
      for (let i = 0; i < COUNT; i++) {
        pos[i * 3 + 1] += speeds[i];
        if (pos[i * 3 + 1] > 30) pos[i * 3 + 1] = -30;
      }
      geo.attributes.position.needsUpdate = true;
      points.rotation.y += 0.0004;

      mx += (tx - mx) * 0.04;
      my += (ty - my) * 0.04;
      camera.position.x = mx * 8;
      camera.position.y = -my * 6;
      camera.lookAt(scene.position);

      renderer.render(scene, camera);
    }
    animate();
  })();

  /* ---------------- Hero coin ---------------- */
  (function heroCoin() {
    const stage = document.getElementById("coin-stage");
    if (!stage) return;

    const size = Math.min(stage.clientWidth, stage.clientHeight) || 380;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.margin = "auto";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 6);

    // coin = short cylinder
    const coinGroup = new THREE.Group();
    scene.add(coinGroup);

    const coinGeo = new THREE.CylinderGeometry(1.7, 1.7, 0.28, 64);
    const coinMat = new THREE.MeshStandardMaterial({
      color: 0x0c1030,
      metalness: 0.95,
      roughness: 0.25,
      emissive: 0x0a1840,
      emissiveIntensity: 0.4,
    });
    const coin = new THREE.Mesh(coinGeo, coinMat);
    coin.rotation.x = Math.PI / 2;
    coinGroup.add(coin);

    // rim ring
    const rimGeo = new THREE.TorusGeometry(1.72, 0.06, 24, 100);
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x00e0ff, metalness: 1, roughness: 0.2,
      emissive: 0x00e0ff, emissiveIntensity: 1.2,
    });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    coinGroup.add(rim);

    // "A" mark on the face using an extruded shape
    const shape = new THREE.Shape();
    // triangle A outline (outer)
    shape.moveTo(0, 1.05);
    shape.lineTo(0.85, -0.9);
    shape.lineTo(0.5, -0.9);
    shape.lineTo(0.28, -0.35);
    shape.lineTo(-0.28, -0.35);
    shape.lineTo(-0.5, -0.9);
    shape.lineTo(-0.85, -0.9);
    shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(0, 0.45);
    hole.lineTo(0.16, 0.02);
    hole.lineTo(-0.16, 0.02);
    hole.closePath();
    shape.holes.push(hole);

    const markGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false });
    markGeo.center();
    const markMat = new THREE.MeshStandardMaterial({
      color: 0x00ffc2, metalness: 0.6, roughness: 0.3,
      emissive: 0x00ffa3, emissiveIntensity: 0.9,
    });
    const markFront = new THREE.Mesh(markGeo, markMat);
    markFront.position.z = 0.15;
    markFront.scale.set(0.62, 0.62, 1);
    coinGroup.add(markFront);
    const markBack = markFront.clone();
    markBack.position.z = -0.15;
    markBack.rotation.y = Math.PI;
    coinGroup.add(markBack);

    // lights
    scene.add(new THREE.AmbientLight(0x4455aa, 0.6));
    const key = new THREE.PointLight(0x7c5cff, 2.2, 50); key.position.set(-5, 5, 6); scene.add(key);
    const fill = new THREE.PointLight(0x00e0ff, 2.0, 50); fill.position.set(6, -3, 5); scene.add(fill);
    const back = new THREE.PointLight(0x00ffa3, 1.4, 50); back.position.set(0, 4, -6); scene.add(back);

    // remove CSS fallback once WebGL coin is live
    const fb = stage.querySelector(".coin-fallback");
    if (fb) fb.style.display = "none";
    stage.appendChild(renderer.domElement);

    let tiltX = 0, tiltY = 0, curX = 0, curY = 0;
    stage.addEventListener("mousemove", (e) => {
      const r = stage.getBoundingClientRect();
      tiltY = ((e.clientX - r.left) / r.width - 0.5) * 0.6;
      tiltX = ((e.clientY - r.top) / r.height - 0.5) * 0.6;
    });
    stage.addEventListener("mouseleave", () => { tiltX = 0; tiltY = 0; });

    function resize() {
      const s = Math.min(stage.clientWidth, stage.clientHeight) || 380;
      renderer.setSize(s, s);
    }
    window.addEventListener("resize", resize);

    let t = 0;
    function animate() {
      requestAnimationFrame(animate);
      t += 0.01;
      curX += (tiltX - curX) * 0.06;
      curY += (tiltY - curY) * 0.06;
      if (!reduceMotion) coinGroup.rotation.y += 0.012;
      coinGroup.rotation.x = curX;
      coinGroup.rotation.z = Math.sin(t) * 0.05;
      coinGroup.position.y = Math.sin(t * 0.8) * 0.12;
      renderer.render(scene, camera);
    }
    animate();
  })();
})();
