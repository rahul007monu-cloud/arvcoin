/* =========================================================
   arvcoin — site interactions
   ========================================================= */
(function () {
  "use strict";

  /* ---- year ---- */
  var y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();

  /* ---- navbar scroll state ---- */
  var nav = document.getElementById("nav");
  function onScroll() {
    if (window.scrollY > 20) nav.classList.add("scrolled");
    else nav.classList.remove("scrolled");
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---- mobile burger ---- */
  var burger = document.getElementById("burger");
  if (burger) {
    burger.addEventListener("click", function () {
      nav.classList.toggle("open");
    });
    nav.querySelectorAll(".nav-links a").forEach(function (a) {
      a.addEventListener("click", function () { nav.classList.remove("open"); });
    });
  }

  /* ---- scroll reveal ---- */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e, i) {
        if (e.isIntersecting) {
          var el = e.target;
          setTimeout(function () { el.classList.add("in"); }, (i % 4) * 80);
          io.unobserve(el);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---- markets ticker (mock live prices) ---- */
  var assets = [
    { name: "Bitcoin", sym: "BTC", price: 7412000, chg: 2.4, ic: "\u20BF", cls: "btc" },
    { name: "Ethereum", sym: "ETH", price: 384500, chg: 1.1, ic: "\u039E", cls: "eth" },
    { name: "Solana", sym: "SOL", price: 18240, chg: 4.8, ic: "\u25CE", cls: "sol" },
    { name: "Nifty 50", sym: "NIFTY", price: 26380, chg: 0.7, ic: "N", cls: "nifty" },
    { name: "Reliance", sym: "RELI", price: 2985, chg: -0.5, ic: "R", cls: "reli" },
    { name: "Tata Motors", sym: "TATA", price: 1078, chg: 1.9, ic: "T", cls: "tata" },
    { name: "HDFC Bank", sym: "HDFC", price: 1712, chg: 0.3, ic: "H", cls: "hdfc" },
    { name: "Gold MF", sym: "GOLD", price: 7620, chg: 0.9, ic: "\u2726", cls: "gold" },
  ];
  var iconColors = {
    btc: ["rgba(247,147,26,.16)", "#f7931a"],
    eth: ["rgba(124,92,255,.18)", "#9d8bff"],
    sol: ["rgba(0,255,163,.14)", "#00ffa3"],
    nifty: ["rgba(0,224,255,.14)", "#00e0ff"],
    reli: ["rgba(255,93,108,.14)", "#ff8a94"],
    tata: ["rgba(0,224,255,.12)", "#7fe9ff"],
    hdfc: ["rgba(124,92,255,.14)", "#b3a4ff"],
    gold: ["rgba(255,215,0,.14)", "#ffd76a"],
  };

  function fmt(n) {
    return "\u20B9" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }

  function chipHTML(a) {
    var col = iconColors[a.cls] || ["rgba(255,255,255,.1)", "#fff"];
    var up = a.chg >= 0;
    return (
      '<div class="tk" data-sym="' + a.sym + '">' +
      '<span class="tk-ic" style="background:' + col[0] + ';color:' + col[1] + '">' + a.ic + "</span>" +
      "<div><div class=\"tk-name\">" + a.name + '</div><div class="tk-sym">' + a.sym + "</div></div>" +
      '<div class="tk-price"><b>' + fmt(a.price) + "</b>" +
      '<small class="' + (up ? "up" : "down") + '">' + (up ? "+" : "") + a.chg.toFixed(1) + "%</small></div>" +
      "</div>"
    );
  }

  var ticker = document.getElementById("ticker");
  if (ticker) {
    // duplicate list for seamless loop
    var html = assets.map(chipHTML).join("");
    ticker.innerHTML = html + html;

    // gently mutate prices to feel "live"
    setInterval(function () {
      assets.forEach(function (a) {
        var drift = (Math.random() - 0.48) * 0.6;
        a.chg = Math.max(-9, Math.min(9, a.chg + drift));
        a.price = Math.max(1, Math.round(a.price * (1 + drift / 100)));
      });
      var fresh = assets.map(chipHTML).join("");
      ticker.innerHTML = fresh + fresh;
    }, 3200);
  }

  /* ---- waitlist form ---- */
  var form = document.getElementById("waitlist-form");
  var note = document.getElementById("cta-note");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = form.querySelector("input");
      var email = (input.value || "").trim();
      if (!email) return;
      // demo only — no backend yet
      try {
        var list = JSON.parse(localStorage.getItem("arvcoin_waitlist") || "[]");
        if (list.indexOf(email) === -1) list.push(email);
        localStorage.setItem("arvcoin_waitlist", JSON.stringify(list));
      } catch (err) {}
      form.reset();
      if (note) {
        note.textContent = "\uD83C\uDF89 You're on the list! Launch update sabse pehle tumhe milega.";
        note.style.color = "#2fe08a";
      }
    });
  }

  /* ---- smooth anchor offset for fixed nav ---- */
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (e) {
      var id = link.getAttribute("href");
      if (id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      var top = target.getBoundingClientRect().top + window.scrollY - 76;
      window.scrollTo({ top: top, behavior: "smooth" });
    });
  });
})();
