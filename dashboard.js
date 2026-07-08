/* =========================================================
   arvcoin — dashboard logic (DEMO, mock data, no backend)
   ========================================================= */
(function () {
  "use strict";

  /* ---------------- mock data ---------------- */
  var ASSETS = [
    { id: "btc", name: "Bitcoin", sym: "BTC", type: "crypto", glyph: "\u20BF", color: "#f7931a", price: 7412000, chg: 2.4 },
    { id: "eth", name: "Ethereum", sym: "ETH", type: "crypto", glyph: "\u039E", color: "#9d8bff", price: 384500, chg: 1.1 },
    { id: "sol", name: "Solana", sym: "SOL", type: "crypto", glyph: "\u25CE", color: "#00ffa3", price: 18240, chg: 4.8 },
    { id: "nifty", name: "Nifty 50", sym: "NIFTY", type: "stock", glyph: "N", color: "#00e0ff", price: 26380, chg: 0.7 },
    { id: "reliance", name: "Reliance", sym: "RELI", type: "stock", glyph: "R", color: "#ff8a94", price: 2985, chg: -0.5 },
    { id: "goldmf", name: "Gold MF", sym: "GOLD", type: "stock", glyph: "\u2726", color: "#ffd76a", price: 7620, chg: 0.9 },
  ];
  var byId = {};
  ASSETS.forEach(function (a) { byId[a.id] = a; });

  var holdings = [
    { id: "btc", units: 0.00071, invested: 5000 },
    { id: "eth", units: 0.0081, invested: 3000 },
    { id: "sol", units: 0.104, invested: 1800 },
  ];
  var activity = [
    { id: "btc", amt: 2000, method: "UPI", at: Date.now() - 172800000 },
    { id: "eth", amt: 1500, method: "QR", at: Date.now() - 86400000 },
    { id: "sol", amt: 800, method: "UPI", at: Date.now() - 18000000 },
  ];

  function inr(n, d) { return "\u20B9" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function units(n) { return n >= 1 ? n.toFixed(3) : n >= 0.001 ? n.toFixed(5) : n.toFixed(7); }
  function $(s, ctx) { return (ctx || document).querySelector(s); }
  function $all(s, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(s)); }

  /* ---------------- session / greeting ---------------- */
  var name = "Investor";
  try {
    var u = JSON.parse(localStorage.getItem("arvcoin_user") || "null");
    if (u && u.name) name = u.name.split(" ")[0];
    else {
      var s = JSON.parse(localStorage.getItem("arvcoin_session") || "null");
      if (s && s.user && s.user.indexOf("@") > 0) name = s.user.split("@")[0];
    }
  } catch (e) {}
  $("#hello-name").textContent = name;
  $("#tb-avatar").textContent = name.charAt(0).toUpperCase();

  /* ---------------- totals ---------------- */
  function totals() {
    var inv = 0, cur = 0;
    holdings.forEach(function (h) { inv += h.invested; cur += h.units * byId[h.id].price; });
    return { inv: inv, cur: cur, pnl: cur - inv, pct: inv ? ((cur - inv) / inv) * 100 : 0 };
  }

  function renderBalance() {
    var t = totals();
    $("#bal-value").textContent = inr(t.cur);
    var up = t.pnl >= 0;
    var chg = $("#bal-chg");
    chg.className = "chg " + (up ? "up" : "down");
    chg.textContent = (up ? "\u25B2 " : "\u25BC ") + inr(Math.abs(t.pnl)) + " (" + (up ? "+" : "") + t.pct.toFixed(2) + "%)";
    $("#bal-invested").textContent = "Invested " + inr(t.inv);
  }

  /* ---------------- portfolio chart (canvas) ---------------- */
  var chartRange = "1D";
  function seriesFor(range) {
    var pts = { "1D": 24, "1W": 28, "1M": 30, "1Y": 24, "ALL": 20 }[range] || 24;
    var t = totals();
    var base = t.cur * 0.9;
    var arr = [];
    var v = base;
    for (var i = 0; i < pts; i++) {
      v += (Math.random() - 0.42) * t.cur * 0.02;
      arr.push(v);
    }
    arr[arr.length - 1] = t.cur;
    return arr;
  }
  function drawChart() {
    var cv = $("#port-chart");
    if (!cv) return;
    var wrap = cv.parentElement;
    var w = wrap.clientWidth, h = 120;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + "px"; cv.style.height = h + "px";
    var ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    var data = seriesFor(chartRange);
    var min = Math.min.apply(null, data), max = Math.max.apply(null, data);
    var pad = 6;
    function x(i) { return (i / (data.length - 1)) * w; }
    function y(val) { return h - pad - ((val - min) / (max - min || 1)) * (h - pad * 2); }
    // area fill
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(0,255,194,.28)");
    grad.addColorStop(1, "rgba(0,255,194,0)");
    ctx.beginPath();
    ctx.moveTo(0, h);
    data.forEach(function (v, i) { ctx.lineTo(x(i), y(v)); });
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    // line
    ctx.beginPath();
    data.forEach(function (v, i) { i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); });
    ctx.strokeStyle = "#00ffc2";
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    ctx.stroke();
    // end dot
    ctx.beginPath();
    ctx.arc(x(data.length - 1), y(data[data.length - 1]), 4, 0, Math.PI * 2);
    ctx.fillStyle = "#00ffc2";
    ctx.fill();
  }

  /* ---------------- sparkline ---------------- */
  function sparkSVG(up) {
    var pts = [];
    var v = 20;
    for (var i = 0; i < 12; i++) { v += (Math.random() - (up ? 0.35 : 0.6)) * 8; pts.push(v); }
    var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
    var d = pts.map(function (p, i) {
      var x = (i / 11) * 68 + 1;
      var y = 28 - ((p - min) / (max - min || 1)) * 26 - 1;
      return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }).join(" ");
    var col = up ? "#2fe08a" : "#ff5d6c";
    return '<svg class="hr-spark" viewBox="0 0 70 30"><path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  /* ---------------- holdings ---------------- */
  function holdRowHTML(h, withActions) {
    var a = byId[h.id];
    var val = h.units * a.price;
    var up = a.chg >= 0;
    var right = withActions
      ? '<div class="hr-actions"><div style="text-align:right"><div class="hr-val">' + inr(val) + '</div>' +
        '<div class="hr-chg" style="color:' + (up ? "#2fe08a" : "#ff5d6c") + '">' + (up ? "+" : "") + a.chg.toFixed(1) + "%</div></div>" +
        '<button class="mini-btn sell" data-sell="' + h.id + '">Sell</button></div>'
      : '<div class="hr-right"><div class="hr-val">' + inr(val) + '</div>' +
        '<div class="hr-chg" style="color:' + (up ? "#2fe08a" : "#ff5d6c") + '">' + (up ? "+" : "") + a.chg.toFixed(1) + "%</div></div>";
    return (
      '<div class="hold-row">' +
      '<span class="asset-ic" style="background:' + a.color + '22;color:' + a.color + '">' + a.glyph + "</span>" +
      '<div><div class="hr-name">' + a.name + '</div><div class="hr-sub">' + units(h.units) + " " + a.sym + "</div></div>" +
      sparkSVG(up) + right +
      "</div>"
    );
  }
  function wireSellButtons(ctx) {
    $all("[data-sell]", ctx).forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        openSell(b.getAttribute("data-sell"));
      });
    });
  }
  function renderHoldings() {
    if (!holdings.length) {
      var empty = '<div class="sip-empty">Abhi koi holding nahi. Pehla investment karo! 🚀</div>';
      $("#hold-list").innerHTML = empty;
      $("#hold-list-full").innerHTML = empty;
      if ($("#wallet-balances")) $("#wallet-balances").innerHTML = empty;
      return;
    }
    $("#hold-list").innerHTML = holdings.map(function (h) { return holdRowHTML(h, false); }).join("");
    $("#hold-list-full").innerHTML = holdings.map(function (h) { return holdRowHTML(h, true); }).join("");
    wireSellButtons($("#hold-list-full"));
    if ($("#wallet-balances")) {
      $("#wallet-balances").innerHTML = holdings
        .filter(function (h) { return byId[h.id].type === "crypto"; })
        .map(function (h) { return holdRowHTML(h, true); }).join("") || '<div class="sip-empty">Wallet empty. Add crypto! 🪙</div>';
      wireSellButtons($("#wallet-balances"));
    }
  }

  /* ---------------- allocation ---------------- */
  function renderAllocation() {
    var t = totals();
    var bar = "", legend = "";
    holdings.forEach(function (h) {
      var a = byId[h.id];
      var val = h.units * a.price;
      var pct = t.cur ? (val / t.cur) * 100 : 0;
      bar += '<span style="width:' + pct + '%;background:' + a.color + '"></span>';
      legend += '<div class="al-row"><span class="al-dot" style="background:' + a.color + '"></span>' + a.name + '<span class="al-pct">' + pct.toFixed(0) + "%</span></div>";
    });
    $("#alloc-bar").innerHTML = bar;
    $("#alloc-legend").innerHTML = legend;
  }

  /* ---------------- activity ---------------- */
  function actRowHTML(x) {
    var a = byId[x.id];
    return (
      '<div class="act-row"><span class="act-ic">\u2197</span>' +
      '<div><div class="act-name">Invested in ' + a.name + '</div>' +
      '<div class="act-sub">' + x.method + " \u00B7 " + new Date(x.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + "</div></div>" +
      '<span class="act-amt">' + inr(x.amt) + "</span></div>"
    );
  }
  function renderActivity() {
    $("#act-list-home").innerHTML = activity.slice(0, 4).map(actRowHTML).join("");
    $("#act-list-full").innerHTML = activity.map(actRowHTML).join("");
  }

  /* ---------------- markets ---------------- */
  var marketFilter = "all";
  function renderMarkets() {
    var list = ASSETS.filter(function (a) { return marketFilter === "all" || a.type === marketFilter; });
    $("#market-list").innerHTML = list.map(function (a) {
      var up = a.chg >= 0;
      return (
        '<div class="hold-row">' +
        '<span class="asset-ic" style="background:' + a.color + '22;color:' + a.color + '">' + a.glyph + "</span>" +
        '<div><div class="hr-name">' + a.name + '</div><div class="hr-sub">' + a.sym + " \u00B7 " + (a.type === "crypto" ? "Crypto" : "Stock") + "</div></div>" +
        sparkSVG(up) +
        '<div class="hr-right"><div class="hr-val">' + inr(a.price) + '</div>' +
        '<div class="hr-chg" style="color:' + (up ? "#2fe08a" : "#ff5d6c") + '">' + (up ? "+" : "") + a.chg.toFixed(1) + "%</div></div>" +
        "</div>"
      );
    }).join("");
  }

  /* ---------------- view switching ---------------- */
  function switchView(v) {
    $all(".view").forEach(function (el) { el.classList.toggle("active", el.getAttribute("data-view") === v); });
    $all(".side-link").forEach(function (el) { el.classList.toggle("active", el.getAttribute("data-view") === v); });
    $("#side").classList.remove("open");
    $(".dash-scroll").scrollTop = 0;
  }
  $all("[data-view]").forEach(function (el) {
    if (el.classList.contains("view")) return;
    el.addEventListener("click", function () { switchView(el.getAttribute("data-view")); });
  });

  /* ---------------- sidebar mobile ---------------- */
  $("#menu-btn").addEventListener("click", function () { $("#side").classList.toggle("open"); });

  /* ---------------- toast ---------------- */
  var toastT;
  function toast(msg) {
    var el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.remove("show"); }, 2600);
  }

  /* ---------------- invest modal ---------------- */
  var modal = $("#invest-modal");
  var invest = { amount: 0, method: "UPI", assetId: null, mtab: "crypto" };

  function openModal() {
    invest = { amount: 0, method: "UPI", assetId: null, mtab: "crypto" };
    $("#amt-val").textContent = "0";
    gotoStep(1);
    $all(".method-toggle button").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-m") === "UPI"); });
    modal.classList.add("open");
  }
  function closeModal() { modal.classList.remove("open"); }
  function gotoStep(n) {
    $all(".mstep").forEach(function (el) { el.classList.toggle("active", el.getAttribute("data-step") === String(n)); });
  }

  $("#open-invest").addEventListener("click", openModal);
  $("#open-invest2").addEventListener("click", function () { openModal(); invest.method = "QR"; $all(".method-toggle button").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-m") === "QR"); }); });
  $("#modal-close").addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });

  // quick amounts on dashboard
  $all("#quick-amts button").forEach(function (b) {
    b.addEventListener("click", function () { openModal(); setAmount(parseInt(b.getAttribute("data-a"), 10)); });
  });

  function setAmount(n) { invest.amount = n; $("#amt-val").textContent = n.toLocaleString("en-IN"); }
  $all(".amt-quick button").forEach(function (b) {
    b.addEventListener("click", function () { setAmount(parseInt(b.getAttribute("data-a"), 10)); });
  });
  $all(".method-toggle button").forEach(function (b) {
    b.addEventListener("click", function () {
      invest.method = b.getAttribute("data-m");
      $all(".method-toggle button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
    });
  });

  $("#to-step2").addEventListener("click", function () {
    if (invest.amount < 10) { toast("Minimum \u20B910 daalo"); return; }
    renderMassets();
    gotoStep(2);
  });

  function renderMassets() {
    var locked = invest.mtab === "stock";
    var list = ASSETS.filter(function (a) { return a.type === invest.mtab; });
    var html = "";
    if (locked) html += '<div class="locked-note">\u23F3 Stocks & MF coming soon \u2014 broker/smallcase KYC pending. Abhi crypto se invest karo.</div>';
    html += list.map(function (a) {
      var sel = invest.assetId === a.id && !locked;
      return (
        '<div class="masset ' + (sel ? "sel" : "") + (locked ? " locked" : "") + '" data-id="' + a.id + '">' +
        '<span class="asset-ic" style="background:' + a.color + '22;color:' + a.color + '">' + a.glyph + "</span>" +
        '<div style="flex:1"><div class="hr-name">' + a.name + '</div><div class="hr-sub">' + a.sym + "</div></div>" +
        '<div class="hr-val">' + inr(a.price) + "</div></div>"
      );
    }).join("");
    $("#masset-list").innerHTML = html;
    if (!locked) {
      $all("#masset-list .masset").forEach(function (el) {
        el.addEventListener("click", function () {
          invest.assetId = el.getAttribute("data-id");
          $all("#masset-list .masset").forEach(function (x) { x.classList.remove("sel"); });
          el.classList.add("sel");
          $("#to-step3").disabled = false;
        });
      });
    }
    $("#to-step3").disabled = true;
  }

  $all("#mtabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      invest.mtab = b.getAttribute("data-t");
      invest.assetId = null;
      $all("#mtabs button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      renderMassets();
    });
  });

  $("#to-step3").addEventListener("click", function () {
    if (!invest.assetId) return;
    var a = byId[invest.assetId];
    var fee = Math.max(0, Math.round(invest.amount * 0.005));
    var investable = invest.amount - fee;
    var u = investable / a.price;
    $("#review-box").innerHTML =
      '<div class="rev-row"><span>You pay</span><b>' + inr(invest.amount) + "</b></div>" +
      '<div class="rev-row"><span>Partner fee (0.5%)</span><b>' + inr(fee) + "</b></div>" +
      '<div class="rev-row"><span>Invested</span><b>' + inr(investable) + "</b></div>" +
      '<div class="rev-row"><span>Est. ' + a.sym + '</span><b>' + units(u) + " " + a.sym + "</b></div>" +
      '<div class="rev-row"><span>Asset</span><b>' + a.name + "</b></div>" +
      '<div class="rev-row"><span>Method</span><b>' + invest.method + "</b></div>";
    $("#do-pay").textContent = "Pay " + inr(invest.amount);
    gotoStep(3);
  });

  function completeInvest() {
    var a = byId[invest.assetId];
    var fee = Math.max(0, Math.round(invest.amount * 0.005));
    var investable = invest.amount - fee;
    var u = investable / a.price;
    var h = holdings.filter(function (x) { return x.id === a.id; })[0];
    if (h) { h.units += u; h.invested += investable; }
    else holdings.push({ id: a.id, units: u, invested: investable });
    activity.unshift({ id: a.id, amt: investable, method: invest.method, at: Date.now() });
    $("#success-text").textContent = inr(investable) + " invested in " + a.name + " via " + invest.method + ".";
    gotoStep(4);
    renderAll();
  }

  $("#do-pay").addEventListener("click", function () {
    var btn = $("#do-pay");
    var a = byId[invest.assetId];

    // REAL MODE: Onramp.money configured + crypto asset -> asli widget kholo
    if (window.ARVOnramp && window.ARVOnramp.isEnabled() && a && a.type === "crypto") {
      window.ARVOnramp.open({
        assetId: invest.assetId,
        fiatAmount: invest.amount,
        product: "BUY",
        onSuccess: function () { btn.disabled = false; btn.textContent = "Pay"; completeInvest(); },
        onClose: function () { btn.disabled = false; btn.textContent = "Pay " + inr(invest.amount); },
      });
      return;
    }

    // DEMO MODE: mock payment
    btn.textContent = "Processing\u2026";
    btn.disabled = true;
    setTimeout(function () {
      btn.disabled = false;
      btn.textContent = "Pay";
      completeInvest();
    }, 1500);
  });
  $("#success-done").addEventListener("click", function () { closeModal(); switchView("home"); toast("Portfolio updated \u2705"); });

  /* ---------------- range tabs ---------------- */
  $all("#range-tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      chartRange = b.getAttribute("data-r");
      $all("#range-tabs button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      drawChart();
    });
  });

  /* ---------------- market tabs ---------------- */
  $all("#market-tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      marketFilter = b.getAttribute("data-t");
      $all("#market-tabs button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      renderMarkets();
    });
  });

  /* ---------------- rewards ---------------- */
  $("#copy-code").addEventListener("click", function () {
    var code = $("#ref-code").textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(code);
    toast("Referral code copied! \uD83C\uDF89");
  });
  $("#promo-invite").addEventListener("click", function () { switchView("rewards"); });

  /* ---------------- logout ---------------- */
  $("#logout").addEventListener("click", function () { try { localStorage.removeItem("arvcoin_session"); } catch (e) {} });

  /* ---------------- kyc banner dismiss (if already done) ---------------- */
  try {
    if (localStorage.getItem("arvcoin_kyc") === "done") $("#kyc-banner").style.display = "none";
  } catch (e) {}

  /* ---------------- REAL live crypto rates (CoinGecko, free, no key) ----------------
     BTC/ETH/SOL ka asli INR price + 24h change fetch hota hai.
     Stocks (Nifty/Reliance/Gold) abhi "coming soon" locked hain -> simulated.
     Real stocks baad me broker/smallcase API se aayenge. */
  var CG_IDS = { btc: "bitcoin", eth: "ethereum", sol: "solana" };
  var CB_PAIRS = { btc: "BTC-INR", eth: "ETH-INR", sol: "SOL-INR" };
  var cryptoLive = false;

  function applyRates() {
    renderBalance();
    renderHoldings();
    renderAllocation();
    if ($(".view[data-view=markets]").classList.contains("active")) renderMarkets();
  }

  function fetchLiveRates() {
    // 1) PRICE — Coinbase (reliable, seedha INR, CORS-ok, no key, block nahi hota)
    Object.keys(CB_PAIRS).forEach(function (id) {
      fetch("https://api.coinbase.com/v2/prices/" + CB_PAIRS[id] + "/spot")
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var amt = j && j.data ? parseFloat(j.data.amount) : NaN;
          if (amt && byId[id]) {
            byId[id].price = Math.round(amt);
            cryptoLive = true;
            applyRates();
          }
        })
        .catch(function () {});
    });

    // 2) 24h CHANGE — CoinGecko (best-effort; fail ho to price phir bhi Coinbase se aayega)
    var ids = [];
    for (var k in CG_IDS) ids.push(CG_IDS[k]);
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + ids.join(",") + "&vs_currencies=inr&include_24hr_change=true")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        Object.keys(CG_IDS).forEach(function (id) {
          var d = data[CG_IDS[id]];
          if (d && byId[id]) {
            if (typeof d.inr === "number" && !cryptoLive) byId[id].price = Math.round(d.inr);
            if (typeof d.inr_24h_change === "number") byId[id].chg = Math.round(d.inr_24h_change * 10) / 10;
          }
        });
        applyRates();
      })
      .catch(function () {});
  }

  /* ---------------- price ticks ----------------
     crypto -> real (CoinGecko). stocks -> halka simulated drift (abhi locked). */
  setInterval(function () {
    ASSETS.forEach(function (a) {
      if (a.type !== "stock") return; // crypto real hai, chhedna nahi
      var drift = (Math.random() - 0.48) * 0.6;
      a.chg = Math.max(-9, Math.min(9, a.chg + drift));
      a.price = Math.max(1, Math.round(a.price * (1 + drift / 100)));
    });
    renderBalance();
    renderHoldings();
    renderAllocation();
    if ($(".view[data-view=markets]").classList.contains("active")) renderMarkets();
  }, 3500);

  // real crypto rates: turant + har 20s (CoinGecko free limit ke andar safe)
  fetchLiveRates();
  setInterval(fetchLiveRates, 20000);

  /* ---------------- notifications ---------------- */
  var notifs = [
    { title: "Welcome to arvcoin! 🎉", body: "Chalo pehla investment karte hain. ₹10 se bhi shuru kar sakte ho.", ago: "just now", read: false },
    { title: "BTC up 2.4% 📈", body: "Tumhara Bitcoin aaj upar hai. Portfolio check karo.", ago: "2h", read: false },
    { title: "Complete your KYC 🛡️", body: "Investing ke liye ek baar KYC zaroori hai (Onramp.money, 2 min).", ago: "1d", read: true },
  ];
  function renderNotifs() {
    var unread = notifs.filter(function (n) { return !n.read; }).length;
    var badge = $("#notif-btn .dot-badge");
    if (badge) badge.style.display = unread ? "block" : "none";
    $("#np-list").innerHTML = notifs.map(function (n) {
      return '<div class="np-item ' + (n.read ? "read" : "") + '"><span class="np-dot"></span>' +
        '<div><b>' + n.title + "</b><p>" + n.body + '</p><small>' + n.ago + "</small></div></div>";
    }).join("");
  }
  $("#notif-btn").addEventListener("click", function (e) {
    e.stopPropagation();
    $("#notif-panel").classList.toggle("open");
  });
  document.addEventListener("click", function (e) {
    if (!$("#notif-panel").contains(e.target) && e.target !== $("#notif-btn")) $("#notif-panel").classList.remove("open");
  });
  $("#np-clear").addEventListener("click", function () {
    notifs.forEach(function (n) { n.read = true; });
    renderNotifs();
    toast("Sab notifications read \u2705");
  });

  /* ---------------- SIP / auto-invest ---------------- */
  var sips = [];
  var sipDraft = { assetId: "btc", amount: 500, freq: "Weekly" };
  function renderSipAssets() {
    $("#sip-assets").innerHTML = ASSETS.filter(function (a) { return a.type === "crypto"; }).map(function (a) {
      var sel = sipDraft.assetId === a.id;
      return '<div class="sip-asset-chip ' + (sel ? "sel" : "") + '" data-sa="' + a.id + '">' +
        '<span class="asset-ic" style="width:26px;height:26px;border-radius:8px;background:' + a.color + '22;color:' + a.color + '">' + a.glyph + "</span>" + a.sym + "</div>";
    }).join("");
    $all("#sip-assets .sip-asset-chip").forEach(function (c) {
      c.addEventListener("click", function () {
        sipDraft.assetId = c.getAttribute("data-sa");
        renderSipAssets();
      });
    });
  }
  function renderSips() {
    if (!sips.length) { $("#sip-list").innerHTML = '<div class="sip-empty">Koi active SIP nahi. Left me ek banao! ↺</div>'; return; }
    $("#sip-list").innerHTML = sips.map(function (s, i) {
      var a = byId[s.assetId];
      return '<div class="sip-item"><span class="asset-ic" style="background:' + a.color + '22;color:' + a.color + '">' + a.glyph + "</span>" +
        '<div class="si-info"><b>' + inr(s.amount) + " · " + s.freq + '</b><p>' + a.name + " · next: " + s.next + "</p></div>" +
        '<button class="si-cancel" data-sip="' + i + '">Cancel</button></div>';
    }).join("");
    $all("#sip-list [data-sip]").forEach(function (b) {
      b.addEventListener("click", function () {
        sips.splice(parseInt(b.getAttribute("data-sip"), 10), 1);
        renderSips(); toast("SIP cancelled");
      });
    });
  }
  $all("#sip-amts button").forEach(function (b) {
    b.addEventListener("click", function () {
      sipDraft.amount = parseInt(b.getAttribute("data-a"), 10);
      $all("#sip-amts button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
    });
  });
  $all("#sip-freq button").forEach(function (b) {
    b.addEventListener("click", function () {
      sipDraft.freq = b.getAttribute("data-f");
      $all("#sip-freq button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
    });
  });
  $("#create-sip").addEventListener("click", function () {
    var nextMap = { Daily: "kal", Weekly: "agle hafte", Monthly: "agle mahine" };
    sips.push({ assetId: sipDraft.assetId, amount: sipDraft.amount, freq: sipDraft.freq, next: nextMap[sipDraft.freq] });
    renderSips();
    toast("SIP shuru! " + inr(sipDraft.amount) + " " + sipDraft.freq + " \uD83D\uDD01");
  });

  /* ---------------- wallet ---------------- */
  // Embedded wallet address — via ARVWallet (Web3Auth-ready; demo = mock)
  var walletAddr;
  if (window.ARVWallet) {
    walletAddr = window.ARVWallet.getAddress();
  } else {
    try { walletAddr = localStorage.getItem("arvcoin_wallet"); } catch (e) {}
    if (!walletAddr) {
      var hex = "0123456789abcdef";
      walletAddr = "0x";
      for (var i = 0; i < 40; i++) walletAddr += hex[Math.floor(Math.random() * 16)];
      try { localStorage.setItem("arvcoin_wallet", walletAddr); } catch (e) {}
    }
  }
  function renderWallet() {
    if ($("#wc-addr")) $("#wc-addr").textContent = walletAddr.slice(0, 6) + "…" + walletAddr.slice(-6) + "  (tap copy for full)";
  }
  $("#copy-addr").addEventListener("click", function () {
    if (navigator.clipboard) navigator.clipboard.writeText(walletAddr);
    toast("Wallet address copied! 📋");
  });
  $("#open-invest3").addEventListener("click", openModal);

  /* ---------------- settings ---------------- */
  function renderSettings() {
    var full = "Investor", email = "investor@arvcoin.com", mobile = "—";
    try {
      var u = JSON.parse(localStorage.getItem("arvcoin_user") || "null");
      if (u) { full = u.name || full; email = u.email || email; mobile = u.mobile || mobile; }
    } catch (e) {}
    if ($("#set-name")) $("#set-name").textContent = full;
    if ($("#set-email")) $("#set-email").textContent = email;
    if ($("#set-name2")) $("#set-name2").textContent = full;
    if ($("#set-mobile")) $("#set-mobile").textContent = mobile;
    if ($("#set-avatar")) $("#set-avatar").textContent = full.charAt(0).toUpperCase();
    var kyc = $("#set-kyc");
    var done = false;
    try { done = localStorage.getItem("arvcoin_kyc") === "done"; } catch (e) {}
    if (kyc) { kyc.textContent = done ? "Verified" : "Pending"; kyc.className = "kyc-pill " + (done ? "done" : "pending"); }
  }
  $("#logout2").addEventListener("click", function () {
    try { localStorage.removeItem("arvcoin_session"); } catch (e) {}
    window.location.href = "login.html";
  });

  /* ---------------- sell (Onramp.money off-ramp) ---------------- */
  var sellModal = $("#sell-modal");
  var sellState = { assetId: null, amount: 0 };
  function openSell(assetId) {
    var a = byId[assetId];
    var h = holdings.filter(function (x) { return x.id === assetId; })[0];
    if (!h) return;
    var maxVal = Math.round(h.units * a.price);
    sellState = { assetId: assetId, amount: 0, maxVal: maxVal };
    $("#sell-asset").innerHTML =
      '<span class="asset-ic" style="background:' + a.color + '22;color:' + a.color + '">' + a.glyph + "</span>" +
      '<div style="flex:1"><div class="hr-name">' + a.name + '</div><div class="hr-sub">Balance: ' + inr(maxVal) + "</div></div>";
    $("#sell-amt").textContent = "0";
    $("#sell-review").innerHTML = "";
    $all(".mstep", sellModal).forEach(function (el) { el.classList.toggle("active", el.getAttribute("data-sstep") === "1"); });
    sellModal.classList.add("open");
  }
  function renderSellReview() {
    var a = byId[sellState.assetId];
    var fee = Math.max(0, Math.round(sellState.amount * 0.005));
    var net = sellState.amount - fee;
    $("#sell-review").innerHTML =
      '<div class="rev-row"><span>Sell value</span><b>' + inr(sellState.amount) + "</b></div>" +
      '<div class="rev-row"><span>Fee (0.5%)</span><b>' + inr(fee) + "</b></div>" +
      '<div class="rev-row"><span>You get (bank)</span><b>' + inr(net) + "</b></div>" +
      '<div class="rev-row"><span>Via</span><b>Onramp.money off-ramp</b></div>';
  }
  function setSellAmt(n) { sellState.amount = Math.min(n, sellState.maxVal); $("#sell-amt").textContent = sellState.amount.toLocaleString("en-IN"); renderSellReview(); }
  $all("#sell-quick button").forEach(function (b) {
    b.addEventListener("click", function () {
      if (b.getAttribute("data-a")) setSellAmt(parseInt(b.getAttribute("data-a"), 10));
      else setSellAmt(Math.round(sellState.maxVal * parseInt(b.getAttribute("data-p"), 10) / 100));
    });
  });
  $("#sell-close").addEventListener("click", function () { sellModal.classList.remove("open"); });
  sellModal.addEventListener("click", function (e) { if (e.target === sellModal) sellModal.classList.remove("open"); });
  $("#do-sell").addEventListener("click", function () {
    if (sellState.amount < 10) { toast("Kam se kam \u20B910 sell karo"); return; }
    var btn = $("#do-sell");
    function finishSell() {
      var a = byId[sellState.assetId];
      var h = holdings.filter(function (x) { return x.id === sellState.assetId; })[0];
      if (h) {
        var sellUnits = sellState.amount / a.price;
        h.units = Math.max(0, h.units - sellUnits);
        h.invested = Math.max(0, h.invested - sellState.amount);
        if (h.units < 0.0000001) holdings = holdings.filter(function (x) { return x.id !== h.id; });
      }
      activity.unshift({ id: sellState.assetId, amt: -sellState.amount, method: "SELL", at: Date.now() });
      $("#sell-success-text").textContent = inr(sellState.amount - Math.round(sellState.amount * 0.005)) + " tumhare bank account me aa jayega (minutes me).";
      $all(".mstep", sellModal).forEach(function (el) { el.classList.toggle("active", el.getAttribute("data-sstep") === "2"); });
      renderAll();
    }
    if (window.ARVOnramp && window.ARVOnramp.isEnabled()) {
      window.ARVOnramp.open({ assetId: sellState.assetId, fiatAmount: sellState.amount, product: "SELL", onSuccess: finishSell, onClose: function () {} });
      return;
    }
    btn.textContent = "Processing…"; btn.disabled = true;
    setTimeout(function () { btn.disabled = false; btn.textContent = "Sell & withdraw to bank"; finishSell(); }, 1400);
  });
  $("#sell-done").addEventListener("click", function () { sellModal.classList.remove("open"); switchView("home"); toast("Sell request placed 💸"); });

  // update activity render to handle SELL (negative amt)
  var _actRowHTML = actRowHTML;
  actRowHTML = function (x) {
    var a = byId[x.id];
    if (x.method === "RECV") {
      return '<div class="act-row"><span class="act-ic" style="background:rgba(47,224,138,.14);color:#2fe08a">\u2193</span>' +
        '<div><div class="act-name">Payment received \u2192 ' + a.name + '</div><div class="act-sub">QR \u00B7 ' +
        new Date(x.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + "</div></div>" +
        '<span class="act-amt" style="color:#2fe08a">' + inr(x.amt) + "</span></div>";
    }
    if (x.method === "SELL") {
      return '<div class="act-row"><span class="act-ic" style="background:rgba(255,93,108,.14);color:#ff5d6c">\u2198</span>' +
        '<div><div class="act-name">Sold ' + a.name + '</div><div class="act-sub">Withdraw \u00B7 ' +
        new Date(x.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + "</div></div>" +
        '<span class="act-amt" style="color:#ff5d6c">' + inr(Math.abs(x.amt)) + "</span></div>";
    }
    return _actRowHTML(x);
  };

  /* ---------------- collect (shopkeeper QR) ---------------- */
  // Shop naam logged-in user (Firebase profile) se; UPI default EMPTY
  // (pehle "myshop@upi" hardcoded tha jo kisi aur ka VPA tha -> scan pe galat naam).
  var shopFullName = "";
  try { var _su = JSON.parse(localStorage.getItem("arvcoin_user") || "null"); if (_su && _su.name) shopFullName = _su.name; } catch (e) {}
  var shop = { name: (shopFullName ? shopFullName + "'s Shop" : (name && name !== "Investor" ? name + "'s Shop" : "My Shop")), upi: "" };
  try {
    var sc = JSON.parse(localStorage.getItem("arvcoin_shop") || "null");
    if (sc && sc.upi !== "myshop@upi") shop = sc; // purana fake default ignore karo
  } catch (e) {}
  function validUpi(v) { return /^[\w.\-]{2,}@[\w.\-]{2,}$/.test(v || ""); }
  var qrMode = "dynamic";
  var qrFixed = 0;
  var received = [];
  var RECV_ASSET = "btc"; // received INR auto-converts to this crypto

  function upiString() {
    var s = "upi://pay?pa=" + encodeURIComponent(shop.upi) + "&pn=" + encodeURIComponent(shop.name) + "&cu=INR";
    if (qrMode === "fixed" && qrFixed > 0) s += "&am=" + qrFixed;
    return s;
  }
  function generateQR() {
    var box = $("#qr-box");
    if (!box) return;
    box.innerHTML = "";
    // UPI set nahi hai -> misleading QR mat banao, shopkeeper ko UPI daalne ko bolo
    if (!validUpi(shop.upi)) {
      box.innerHTML = '<div class="sip-empty" style="padding:22px 14px;line-height:1.5">Pehle niche <b>Shop settings</b> me apni <b>UPI ID</b> daalo \u2014 tabhi QR banega jispe <b>tumhara apna</b> naam aayega.<br><small style="opacity:.7">Jaise: yourname@okaxis / yourname@ybl</small></div>';
      if ($("#qr-shop")) $("#qr-shop").textContent = shop.name;
      return;
    }
    var data = upiString();
    if (typeof QRCode !== "undefined") {
      new QRCode(box, { text: data, width: 210, height: 210, colorDark: "#05060f", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
    } else {
      var img = document.createElement("img");
      img.src = "https://api.qrserver.com/v1/create-qr-code/?size=210x210&data=" + encodeURIComponent(data);
      img.alt = "Payment QR";
      box.appendChild(img);
    }
    if ($("#qr-shop")) $("#qr-shop").textContent = shop.name;
  }
  function renderCollect() {
    if ($("#qr-shop")) $("#qr-shop").textContent = shop.name;
    if ($("#shop-name-inp") && !$("#shop-name-inp").value) $("#shop-name-inp").value = shop.name;
    if ($("#shop-upi-inp") && !$("#shop-upi-inp").value) $("#shop-upi-inp").value = shop.upi;
    var total = received.reduce(function (s, r) { return s + r.amt; }, 0);
    if ($("#today-collection")) $("#today-collection").textContent = inr(total);
    if ($("#today-count")) $("#today-count").textContent = received.length;
    if ($("#recv-list")) {
      $("#recv-list").innerHTML = received.length
        ? received.map(function (r) {
            var a = byId[r.crypto];
            return '<div class="recv-row"><span class="act-ic" style="background:rgba(47,224,138,.14);color:#2fe08a">\u2193</span>' +
              '<div style="flex:1"><div class="act-name">Payment received</div><div class="act-sub">' +
              new Date(r.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) + " \u00B7 \u2192 " + a.sym + " wallet</div></div>" +
              '<span class="act-amt" style="color:#2fe08a">' + inr(r.amt) + "</span></div>";
          }).join("")
        : '<div class="sip-empty">Abhi koi payment nahi. QR share/print karke customer se payment lo! 📷</div>';
    }
  }

  // QR amount mode toggle
  $all(".qr-amt-toggle button").forEach(function (b) {
    b.addEventListener("click", function () {
      qrMode = b.getAttribute("data-qm");
      $all(".qr-amt-toggle button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      $("#qr-fixed-amt").style.display = qrMode === "fixed" ? "block" : "none";
      $("#qr-amt-line").textContent = qrMode === "fixed" ? "Fixed: " + inr(qrFixed || 0) : "Customer koi bhi amount daal sakta hai";
      generateQR();
    });
  });
  $("#qr-fixed-amt").addEventListener("input", function () {
    qrFixed = parseInt(this.value.replace(/\D/g, "") || "0", 10);
    $("#qr-amt-line").textContent = "Fixed: " + inr(qrFixed);
    generateQR();
  });

  $("#save-shop").addEventListener("click", function () {
    var n = $("#shop-name-inp").value.trim(), up = $("#shop-upi-inp").value.trim();
    if (up && !validUpi(up)) { toast("UPI ID sahi format me daalo (jaise: naam@okaxis)"); return; }
    if (n) shop.name = n;
    if (up) shop.upi = up;
    try { localStorage.setItem("arvcoin_shop", JSON.stringify(shop)); } catch (e) {}
    generateQR(); renderCollect(); toast("Shop updated \u2705");
  });

  $("#qr-download").addEventListener("click", function () {
    var canvas = $("#qr-box canvas"), img = $("#qr-box img");
    var url = canvas ? canvas.toDataURL("image/png") : (img ? img.src : null);
    if (!url) { toast("QR ready nahi"); return; }
    var a = document.createElement("a"); a.href = url; a.download = "arvcoin-qr.png"; a.click();
    toast("QR downloaded \u2b07");
  });
  $("#qr-share").addEventListener("click", function () {
    var data = upiString();
    if (navigator.share) { navigator.share({ title: shop.name, text: "Pay " + shop.name + " via arvcoin", url: data }).catch(function () {}); }
    else { if (navigator.clipboard) navigator.clipboard.writeText(data); toast("Payment link copied! 📋"); }
  });
  $("#qr-print").addEventListener("click", function () {
    var canvas = $("#qr-box canvas"), img = $("#qr-box img");
    var url = canvas ? canvas.toDataURL("image/png") : (img ? img.src : "");
    var w = window.open("", "_blank");
    if (!w) { toast("Popup block hai"); return; }
    w.document.write('<html><head><title>arvcoin QR</title></head><body style="text-align:center;font-family:sans-serif;padding:40px">' +
      "<h2>" + shop.name + '</h2><img src="' + url + '" style="width:300px;height:300px"><p>Scan &amp; pay · arvcoin</p></body></html>');
    w.document.close(); w.focus(); setTimeout(function () { w.print(); }, 400);
  });

  $("#sim-pay").addEventListener("click", function () {
    var amt = (qrMode === "fixed" && qrFixed > 0) ? qrFixed : [50, 100, 250, 500, 1000][Math.floor(Math.random() * 5)];
    var a = byId[RECV_ASSET];
    var fee = Math.round(amt * 0.005);
    var net = amt - fee;
    var uUnits = net / a.price;
    var h = holdings.filter(function (x) { return x.id === RECV_ASSET; })[0];
    if (h) { h.units += uUnits; h.invested += net; }
    else holdings.push({ id: RECV_ASSET, units: uUnits, invested: net });
    received.unshift({ amt: amt, at: Date.now(), crypto: RECV_ASSET });
    activity.unshift({ id: RECV_ASSET, amt: net, method: "RECV", at: Date.now() });
    renderAll();
    toast("Payment received: " + inr(amt) + " \u2192 crypto 💰");
  });

  $("#withdraw-btn").addEventListener("click", function () {
    toast("Withdraw: crypto \u2192 INR bank (via Onramp.money off-ramp) 💸");
  });

  /* ---------------- init ---------------- */
  function renderAll() {
    renderBalance();
    renderHoldings();
    renderAllocation();
    renderActivity();
    renderMarkets();
    renderSips();
    renderWallet();
    renderSettings();
    renderCollect();
    drawChart();
  }
  renderNotifs();
  renderSipAssets();
  generateQR();
  renderAll();
  window.addEventListener("resize", drawChart);
})();
