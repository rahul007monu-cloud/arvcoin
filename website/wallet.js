/* =========================================================
   arvcoin — Wallet (MetaMask Embedded Wallets / Web3Auth)

   Web3Auth ab "MetaMask Embedded Wallets" hai (Consensys ne acquire kiya).
   Dashboard: developer.metamask.io  |  SDK package: @web3auth/modal

   MODE:
   - CONFIG.clientId khali  = DEMO (mock address, localStorage)
   - CONFIG.clientId set     = REAL non-custodial wallet
     User social-login karta hai -> wallet auto-generate,
     keys Web3Auth (MPC) ke paas encrypted rehti hain, hamare server pe kabhi nahi.

   NOTE: SDK bina bundler ke esm.sh CDN se dynamic import hota hai.
   Kuch bhi fail ho (network/version) to demo address pe safe fallback.
   ========================================================= */
(function () {
  "use strict";

  var CONFIG = {
    // MetaMask Embedded Wallets (Web3Auth) Client ID — Sapphire Devnet project "arvtoken"
    clientId: "BPsU7LXM_uX6sfO81PYM5NXb4gDkoxZc0UE47PSftpKrgLDzAX31c1kaf7hCs3NpktdxVuqLAtLf25nP2yQV6t8",
    network: "sapphire_devnet",             // test. Live pe: "sapphire_mainnet" (naya Mainnet project)
    sdkUrl: "https://esm.sh/@web3auth/modal@10" // no-bundler CDN build
  };

  var VERSION = "w3a-3"; // file version marker (cache diagnose ke liye)

  function isEnabled() { return String(CONFIG.clientId || "").trim().length > 0; }

  /* ---------- DEMO fallback address ---------- */
  function demoAddress() {
    var a;
    try { a = localStorage.getItem("arvcoin_wallet"); } catch (e) {}
    if (!a) {
      var hex = "0123456789abcdef";
      a = "0x";
      for (var i = 0; i < 40; i++) a += hex[Math.floor(Math.random() * 16)];
      try { localStorage.setItem("arvcoin_wallet", a); } catch (e) {}
    }
    return a;
  }

  /* ---------- REAL Web3Auth ---------- */
  var _w3a = null;       // web3auth instance
  var _connected = false;

  function loadInstance() {
    if (_w3a) return Promise.resolve(_w3a);
    // dynamic import works in modern browsers without any build tool
    return import(CONFIG.sdkUrl).then(function (mod) {
      var Web3Auth = mod.Web3Auth || (mod.default && mod.default.Web3Auth);
      if (!Web3Auth) throw new Error("Web3Auth export not found");
      _w3a = new Web3Auth({
        clientId: CONFIG.clientId,
        web3AuthNetwork: CONFIG.network,
        uiConfig: { appName: "Arvcoin", mode: "dark" }
      });
      // v10 = init(); older = initModal(). Jo mile use karo.
      var initFn = _w3a.init ? _w3a.init.bind(_w3a) : _w3a.initModal.bind(_w3a);
      return Promise.resolve(initFn()).then(function () { return _w3a; });
    });
  }

  // Social/email login -> opens Web3Auth modal, returns { address, name, email }
  function connect() {
    if (!isEnabled()) {
      return Promise.resolve({ address: demoAddress(), name: "", email: "", demo: true, enabled: false, error: "clientId khaali (purani cached file?)" });
    }
    return loadInstance().then(function (w) {
      var p = w.connected ? Promise.resolve(w.provider) : w.connect();
      return Promise.resolve(p).then(function (provider) {
        provider = provider || w.provider;
        _connected = true;
        var accP = provider && provider.request
          ? provider.request({ method: "eth_accounts" })
          : Promise.resolve([]);
        return Promise.resolve(accP).then(function (accounts) {
          var addr = (accounts && accounts[0]) || demoAddress();
          try { localStorage.setItem("arvcoin_wallet", addr); } catch (e) {}
          var infoP = w.getUserInfo ? w.getUserInfo() : Promise.resolve({});
          return Promise.resolve(infoP).catch(function () { return {}; }).then(function (info) {
            info = info || {};
            return { address: addr, name: info.name || "", email: info.email || "" };
          });
        });
      });
    }).catch(function (err) {
      // koi bhi dikkat -> demo pe safe fallback (site tooti nahi)
      try { console.warn("[ARVWallet] real connect fail, demo fallback:", err); } catch (e) {}
      return { address: demoAddress(), name: "", email: "", demo: true, enabled: true, error: String((err && err.message) || err) };
    });
  }

  // alias auth.js ke social buttons ke liye
  function socialLogin(/* provider */) { return connect(); }

  function logout() {
    if (_w3a && _w3a.logout) { try { _w3a.logout(); } catch (e) {} }
    _connected = false;
  }

  // sync address (dashboard display ke liye): cached/real ya demo
  function getAddress() {
    try {
      var a = localStorage.getItem("arvcoin_wallet");
      if (a) return a;
    } catch (e) {}
    return demoAddress();
  }

  window.ARVWallet = {
    isEnabled: isEnabled,
    connect: connect,
    socialLogin: socialLogin,
    logout: logout,
    getAddress: getAddress,
    isConnected: function () { return _connected; },
    version: VERSION,
    config: CONFIG
  };
})();
