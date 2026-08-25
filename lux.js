/* =========================================================
   arvcoin — LUX interactions
   3D tilt, cursor spotlight, scroll reveal, parallax,
   FAQ accordion, counters, nav state.

   Sab kuch progressive hai — JS fail ho to page normal dikhta hai.
   prefers-reduced-motion respect karta hai.
   ========================================================= */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var isTouch = window.matchMedia("(hover: none)").matches;
  var isSmall = window.innerWidth < 760;

  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* =========================================================
     1) CURSOR SPOTLIGHT on .lux panels
     ========================================================= */
  function initSpotlight() {
    if (isTouch) return;
    $all(".lux").forEach(function (el) {
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100) + "%");
        el.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100) + "%");
      });
    });
  }

  /* =========================================================
     2) 3D TILT on .lux-tilt
     ========================================================= */
  function initTilt() {
    if (reduced || isTouch || isSmall) return;

    $all(".lux-tilt, .lux-3d").forEach(function (el) {
      // .lux-3d rotates further than .lux-tilt
      var MAX = el.classList.contains("lux-3d") ? 12 : 7;
      var raf = null;

      el.addEventListener("pointerenter", function () {
        el.classList.add("is-tilting");
      });

      el.addEventListener("pointermove", function (e) {
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = null;
          var r = el.getBoundingClientRect();
          var px = (e.clientX - r.left) / r.width - 0.5;
          var py = (e.clientY - r.top) / r.height - 0.5;
          el.style.setProperty("--ry", (px * MAX * 2).toFixed(2) + "deg");
          el.style.setProperty("--rx", (-py * MAX * 2).toFixed(2) + "deg");
        });
      });

      el.addEventListener("pointerleave", function () {
        el.classList.remove("is-tilting");
        el.style.setProperty("--rx", "0deg");
        el.style.setProperty("--ry", "0deg");
      });
    });
  }

  /* =========================================================
     3) SCROLL REVEAL
     ========================================================= */
  function initReveal() {
    var items = $all(".rv");
    if (!items.length) return;

    if (reduced || !("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("in"); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });

    items.forEach(function (el) { io.observe(el); });
  }

  /* =========================================================
     4) AURORA + hero PARALLAX (mouse)
     ========================================================= */
  function initParallax() {
    if (reduced || isTouch || isSmall) return;

    var blobs = $all(".aurora span");
    var peeks = $all("[data-parallax]");
    if (!blobs.length && !peeks.length) return;

    var tx = 0, ty = 0, cx = 0, cy = 0, running = false;

    window.addEventListener("pointermove", function (e) {
      tx = (e.clientX / window.innerWidth - 0.5);
      ty = (e.clientY / window.innerHeight - 0.5);
      if (!running) { running = true; requestAnimationFrame(tick); }
    });

    function tick() {
      cx += (tx - cx) * 0.055;
      cy += (ty - cy) * 0.055;

      blobs.forEach(function (b, i) {
        var d = (i + 1) * 9;
        b.style.translate = (cx * d) + "px " + (cy * d) + "px";
      });

      peeks.forEach(function (p) {
        var d = parseFloat(p.getAttribute("data-parallax")) || 12;
        p.style.transform = "translate3d(" + (cx * d) + "px," + (cy * d) + "px,0)";
      });

      if (Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) {
        requestAnimationFrame(tick);
      } else {
        running = false;
      }
    }
  }

  /* =========================================================
     5) FAQ accordion
     ========================================================= */
  function initFaq() {
    $all(".faq-item").forEach(function (item) {
      var q = item.querySelector(".faq-q");
      var a = item.querySelector(".faq-a");
      if (!q || !a) return;

      q.setAttribute("aria-expanded", "false");

      q.addEventListener("click", function () {
        var open = item.classList.contains("open");

        // close siblings
        var parent = item.parentNode;
        $all(".faq-item.open", parent).forEach(function (other) {
          if (other !== item) {
            other.classList.remove("open");
            var oa = other.querySelector(".faq-a");
            var oq = other.querySelector(".faq-q");
            if (oa) oa.style.maxHeight = "0px";
            if (oq) oq.setAttribute("aria-expanded", "false");
          }
        });

        item.classList.toggle("open", !open);
        q.setAttribute("aria-expanded", String(!open));
        a.style.maxHeight = open ? "0px" : (a.scrollHeight + 20) + "px";
      });
    });
  }

  /* =========================================================
     6) COUNTERS
     ========================================================= */
  function initCounters() {
    var els = $all("[data-count]");
    if (!els.length) return;

    function run(el) {
      var target = parseFloat(el.getAttribute("data-count")) || 0;
      var suffix = el.getAttribute("data-suffix") || "";
      var prefix = el.getAttribute("data-prefix") || "";
      var dur = parseInt(el.getAttribute("data-dur"), 10) || 1500;

      if (reduced) {
        el.textContent = prefix + target.toLocaleString("en-IN") + suffix;
        return;
      }

      var start = performance.now();
      function step(now) {
        var p = Math.min(1, (now - start) / dur);
        var eased = 1 - Math.pow(1 - p, 3);
        var val = target * eased;
        el.textContent = prefix +
          (target % 1 === 0 ? Math.round(val).toLocaleString("en-IN")
                            : val.toFixed(1)) + suffix;
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    if (!("IntersectionObserver" in window)) { els.forEach(run); return; }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { run(en.target); io.unobserve(en.target); }
      });
    }, { threshold: 0.5 });

    els.forEach(function (el) { io.observe(el); });
  }

  /* =========================================================
     7) NAV scroll state + mobile burger
     ========================================================= */
  function initNav() {
    var nav = document.getElementById("nav") || document.querySelector(".nav");
    if (nav && !nav.classList.contains("scrolled")) {
      var onScroll = function () {
        nav.classList.toggle("scrolled", window.scrollY > 24);
      };
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
    }

    var burger = document.getElementById("burger");
    var links = document.querySelector(".nav-links");
    if (burger && links) {
      burger.addEventListener("click", function () {
        burger.classList.toggle("open");
        links.classList.toggle("open");
        document.body.classList.toggle("nav-open");
      });
      $all("a", links).forEach(function (a) {
        a.addEventListener("click", function () {
          burger.classList.remove("open");
          links.classList.remove("open");
          document.body.classList.remove("nav-open");
        });
      });
    }
  }

  /* =========================================================
     8) MARQUEE — duplicate track for seamless loop
     ========================================================= */
  function initMarquee() {
    $all(".lux-marquee .track").forEach(function (track) {
      if (track.getAttribute("data-cloned")) return;
      track.setAttribute("data-cloned", "1");
      track.innerHTML = track.innerHTML + track.innerHTML;
    });
  }

  /* =========================================================
     9) Smooth anchor scroll
     ========================================================= */
  function initAnchors() {
    $all('a[href^="#"]').forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href || href === "#") return;
      a.addEventListener("click", function (e) {
        var t = document.querySelector(href);
        if (!t) return;
        e.preventDefault();
        var top = t.getBoundingClientRect().top + window.scrollY - 84;
        window.scrollTo({ top: top, behavior: reduced ? "auto" : "smooth" });
      });
    });
  }

  /* =========================================================
     10) SERVICE WORKER — register + force update
     ---------------------------------------------------------
     Ye har page pe chalta hai (lux.js sab pages me load hota hai).
     Pehle sirf index.html register karta tha — us wajah se purana
     SW browser me atka reh jaata tha aur naya code dikhta hi nahi tha.

     Naya SW milte hi turant activate ho jaata hai (sw.js me
     skipWaiting + clients.claim hai) aur page reload ho jaata hai.
     ========================================================= */
  function initSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol === "file:") return;

    navigator.serviceWorker.register("sw.js").then(function (reg) {
      // Har page load pe check karo ki naya SW aaya hai kya
      reg.update().catch(function () {});

      reg.addEventListener("updatefound", function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", function () {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            console.log("[arvcoin] new version found, reloading");
          }
        });
      });
    }).catch(function (e) {
      console.warn("[arvcoin] SW register fail:", e);
    });

    // Naya SW control lene pe ek baar reload — taaki fresh code turant dikhe
    var reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }

  /* =========================================================
     11) PWA INSTALL PROMPT
     ---------------------------------------------------------
     Chrome/Edge fire beforeinstallprompt when the app is
     installable. We stash the event and show our own button,
     because the native mini-infobar is easy to miss.
     ========================================================= */
  function initInstall() {
    var deferred = null;

    function makeButton() {
      if (document.getElementById("pwa-install")) return null;
      var b = document.createElement("button");
      b.id = "pwa-install";
      b.type = "button";
      b.className = "pwa-install";
      b.innerHTML = '<span class="pi-ico">⬇</span><span>Install app</span>';
      document.body.appendChild(b);
      return b;
    }

    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferred = e;

      try {
        if (localStorage.getItem("arvcoin_install_dismissed") === "1") return;
      } catch (err) {}

      var btn = makeButton();
      if (!btn) return;

      requestAnimationFrame(function () { btn.classList.add("show"); });

      btn.addEventListener("click", function () {
        if (!deferred) return;
        deferred.prompt();
        deferred.userChoice.then(function (res) {
          if (res.outcome !== "accepted") {
            try { localStorage.setItem("arvcoin_install_dismissed", "1"); } catch (err) {}
          }
          deferred = null;
          btn.classList.remove("show");
          setTimeout(function () { btn.remove(); }, 400);
        });
      });
    });

    window.addEventListener("appinstalled", function () {
      var b = document.getElementById("pwa-install");
      if (b) b.remove();
      try { localStorage.setItem("arvcoin_installed", "1"); } catch (err) {}
    });
  }

  /* =========================================================
     Boot
     ========================================================= */
  function boot() {
    initSW();
    initInstall();
    initSpotlight();
    initTilt();
    initReveal();
    initParallax();
    initFaq();
    initCounters();
    initNav();
    initMarquee();
    initAnchors();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.ARVLux = { boot: boot, reduced: reduced };
})();
