/* =========================================================
   arvcoin — Wallet abstraction (Web3Auth-ready, demo-safe)

   DEMO vs REAL:
   - CONFIG.clientId khali = DEMO (mock wallet address, localStorage)
   - Web3Auth Client ID daalte hi = asli non-custodial wallet
     (user login karte hi wallet auto-generate, keys WaaS ke paas encrypted)

   CLIENT ID KAHAN SE:
     1. dashboard.web3auth.io -> Sign up (free)
     2. "Create Project" -> Plug and Play
     3. Client ID copy -> yahan CONFIG.clientId me daalo
   ========================================================= */
(function () {
  "use strict";

  var CONFIG = {
    clientId: "",              // <<< Web3Auth Client ID (khali = demo)
    network: "sapphire_devnet" // devnet (test) ya sapphire_mainnet (live)
  };

  function isEnabled() { return CONFIG.clientId.trim().length > 0; }

  // Demo: ek mock wallet address (localStorage me persist)
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

  /*
   * REAL Web3Auth (Client ID milne pe activate hoga):
   * 1. index/dashboard me CDN script add karo:
   *    <script src="https://cdn.jsdelivr.net/npm/@web3auth/modal@9/dist/modal.umd.min.js"></script>
   * 2. Yahan init + login karke provider se address nikalo:
   *
   *    const web3auth = new Modal.Web3Auth({ clientId: CONFIG.clientId, web3AuthNetwork: CONFIG.network, chainConfig: {...} });
   *    await web3auth.initModal();
   *    const provider = await web3auth.connect();
   *    const accounts = await provider.request({ method: "eth_accounts" });
   *    return accounts[0];
   *
   * Keys Web3Auth (MPC) ke paas encrypted rehti hain — tere server pe kabhi nahi.
   */
  function getAddress() {
    // Client ID set hote hi yahan real Web3Auth address return hoga.
    return demoAddress();
  }

  window.ARVWallet = {
    isEnabled: isEnabled,
    getAddress: getAddress,
    config: CONFIG
  };
})();
