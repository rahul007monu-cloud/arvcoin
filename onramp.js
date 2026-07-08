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
    appId: "",                 // <-- Onramp appId yahan daalna (khali = DEMO)
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

  // Widget popup window me kholo; band hone pe success callback.
  // (Production me success Onramp webhook/postMessage se confirm hota hai.)
  function open(p) {
    if (!isEnabled()) { if (p.onClose) p.onClose(); return; }
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
