/* =========================================================
   arvcoin — Transak web integration (config + widget open)

   DEMO vs REAL:
   - CONFIG.apiKey khali = DEMO mode (mock invest chalega)
   - apiKey daalte hi = asli Transak widget khulega (UPI pay -> crypto wallet me)

   KEY KAHAN SE: transak.com -> Partner dashboard -> signup
   - Test/Staging key turant (environment "STAGING")
   - KYB ke baad Production key (environment "PRODUCTION")
   ========================================================= */
(function () {
  "use strict";

  var CONFIG = {
    apiKey: "",                 // <<< yahan apni Transak key daalo (khali = demo)
    environment: "STAGING",     // "STAGING" (test) ya "PRODUCTION" (live)
    fiatCurrency: "INR",
    defaultWalletAddress: "",   // real me per-user embedded wallet address
  };

  var BASE = {
    STAGING: "https://global-stg.transak.com",
    PRODUCTION: "https://global.transak.com",
  };

  // arvcoin asset id -> Transak crypto code + network
  var MAP = {
    btc: { crypto: "BTC", network: "mainnet" },
    eth: { crypto: "ETH", network: "ethereum" },
    sol: { crypto: "SOL", network: "solana" },
  };

  function isEnabled() { return CONFIG.apiKey.trim().length > 0; }

  function buildUrl(p) {
    var m = MAP[p.assetId] || { crypto: "BTC", network: "mainnet" };
    var wallet = p.walletAddress || CONFIG.defaultWalletAddress;
    var q = {
      apiKey: CONFIG.apiKey,
      fiatCurrency: CONFIG.fiatCurrency,
      fiatAmount: String(p.fiatAmount),
      cryptoCurrencyCode: m.crypto,
      network: m.network,
      productsAvailed: p.product || "BUY", // "BUY" ya "SELL" (off-ramp)
      themeColor: "7c5cff",
      hideMenu: "true",
    };
    if (wallet) q.walletAddress = wallet;
    var qs = Object.keys(q)
      .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(q[k]); })
      .join("&");
    return BASE[CONFIG.environment] + "/?" + qs;
  }

  // Widget ko popup window me kholo; band hone pe success callback.
  // (Production me success Transak ke webhook/postMessage se confirm hota hai.)
  function open(p) {
    if (!isEnabled()) { if (p.onClose) p.onClose(); return; }
    var url = buildUrl(p);
    var w = 460, h = 700;
    var left = (screen.width - w) / 2, top = (screen.height - h) / 2;
    var win = window.open(url, "transak", "width=" + w + ",height=" + h + ",left=" + left + ",top=" + top);
    var timer = setInterval(function () {
      if (!win || win.closed) {
        clearInterval(timer);
        if (p.onSuccess) p.onSuccess();
      }
    }, 800);
  }

  window.ARVTransak = { isEnabled: isEnabled, open: open, buildUrl: buildUrl, config: CONFIG };
})();
