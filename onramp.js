/* =========================================================
   arvcoin — Onramp.money web integration (config + widget open)

   KYUN ONRAMP.MONEY:
   - Indian company (Bengaluru), FIU-India registered (VDA SP)
   - India-registered businesses/proprietorship ko onboard karta hai
     (Transak KYB me India option hi nahi tha)
   - UPI -> crypto seedha user ke wallet me

   DEMO vs REAL:
   - CONFIG.appId khali/0 = DEMO mode (mock invest chalega)
   - asli appId daalte hi = asli Onramp.money widget khulega

   appId KAHAN SE: onramp.money -> Partner/Merchant dashboard -> signup
   - KYB (business verify) ke baad appId + secret milta hai
   - Sandbox/test appId pehle, phir production

   NOTE: coinCode/network values Onramp dashboard se confirm kar lena
   (network strings partner ke enabled assets pe depend karte hain).
   ========================================================= */
(function () {
  "use strict";

  var CONFIG = {
    appId: "2264810",          // Onramp SANDBOX/test appId (playground). KYB ke baad live appId aayega.
    fiatType: 1,               // 1 = INR
    paymentMethod: 1,          // 1 = UPI (instant), 2 = bank transfer (IMPS/FAST)
    defaultWalletAddress: "",  // real me per-user embedded wallet address
  };

  // Hosted widget base (buy/onramp). flowType se buy/sell decide hota hai.
  var BASE = "https://onramp.money/main/buy/";

  // arvcoin asset id -> Onramp coinCode + network
  var MAP = {
    btc: { coin: "btc", network: "bitcoin" },
    eth: { coin: "eth", network: "erc20" },
    sol: { coin: "sol", network: "spl" },
  };

  function isEnabled() {
    return String(CONFIG.appId).trim().length > 0 && String(CONFIG.appId) !== "0";
  }

  function buildUrl(p) {
    var m = MAP[p.assetId] || { coin: "usdt", network: "matic20" };
    var wallet = p.walletAddress || CONFIG.defaultWalletAddress;
    var isSell = (p.product || "BUY").toUpperCase() === "SELL";

    var q = {
      appId: CONFIG.appId,
      flowType: isSell ? 2 : 1,          // 1 = onramp (buy), 2 = offramp (sell)
      fiatType: CONFIG.fiatType,         // 1 = INR
      paymentMethod: CONFIG.paymentMethod,
      coinCode: m.coin,
      network: m.network,
      fiatAmount: String(p.fiatAmount),
    };
    if (wallet) q.walletAddress = wallet;
    if (p.merchantRecognitionId) q.merchantRecognitionId = p.merchantRecognitionId;

    var qs = Object.keys(q)
      .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(q[k]); })
      .join("&");
    return BASE + "?" + qs;
  }

  // Onramp Web SDK se overlay modal kholo (preferred). Return true = khul gaya.
  function openSdk(p, m, wallet, isSell) {
    var Sdk = window.OnrampWebSDK;
    if (!Sdk) return false;
    var cfg = {
      appId: Number(CONFIG.appId),
      flowType: isSell ? 2 : 1,
      fiatType: CONFIG.fiatType,
      paymentMethod: CONFIG.paymentMethod,
      coinCode: m.coin,
      network: m.network,
      fiatAmount: Number(p.fiatAmount),
    };
    if (wallet) cfg.walletAddress = wallet;
    if (p.merchantRecognitionId) cfg.merchantRecognitionId = p.merchantRecognitionId;

    var inst;
    try { inst = new Sdk(cfg); } catch (e) { console.warn("[arvcoin] onramp sdk init:", e); return false; }

    var done = false;
    if (inst.on) {
      inst.on("WIDGET_EVENTS", function (ev) {
        var t = (ev && ev.type ? String(ev.type) : "").toUpperCase();
        if (t.indexOf("TX_COMPLETED") !== -1 || t.indexOf("SUCCESS") !== -1) {
          done = true; if (p.onSuccess) p.onSuccess();
        }
        if (t.indexOf("CLOSE") !== -1) {
          try { inst.close(); } catch (e) {}
          if (!done && p.onClose) p.onClose();
        }
      });
    }
    try { inst.show(); return true; } catch (e) { console.warn("[arvcoin] onramp sdk show:", e); return false; }
  }

  // Widget kholo: pehle SDK overlay try, warna hosted URL popup (fallback).
  function open(p) {
    if (!isEnabled()) { if (p.onClose) p.onClose(); return; }
    var m = MAP[p.assetId] || { coin: "usdt", network: "matic20" };
    var wallet = p.walletAddress || CONFIG.defaultWalletAddress;
    var isSell = (p.product || "BUY").toUpperCase() === "SELL";

    if (openSdk(p, m, wallet, isSell)) return;

    // Fallback: hosted widget popup window
    var url = buildUrl(p);
    var w = 460, h = 700;
    var left = (screen.width - w) / 2, top = (screen.height - h) / 2;
    var win = window.open(url, "onramp", "width=" + w + ",height=" + h + ",left=" + left + ",top=" + top);
    var timer = setInterval(function () {
      if (!win || win.closed) {
        clearInterval(timer);
        if (p.onSuccess) p.onSuccess();
      }
    }, 800);
  }

  window.ARVOnramp = { isEnabled: isEnabled, open: open, buildUrl: buildUrl, config: CONFIG };
})();
