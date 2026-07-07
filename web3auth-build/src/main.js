/* =========================================================
   arvcoin — REAL Web3Auth wallet (bundled build)

   Ye file Vite se bundle hoke ../website/wallet-bundle.js banti hai.
   Website me wallet-bundle.js load hone pe window.ARVWallet ko REAL
   Web3Auth se replace kar deta hai (demo wallet.js ko override).

   Same Google login = same wallet (web + mobile dono pe).
   ========================================================= */
import { Web3Auth, WEB3AUTH_NETWORK } from "@web3auth/modal";

// Sapphire Devnet project "arvtoken" ki Client ID (public — safe)
var CLIENT_ID = "BPsU7LXM_uX6sfO81PYM5NXb4gDkoxZc0UE47PSftpKrgLDzAX31c1kaf7hCs3NpktdxVuqLAtLf25nP2yQV6t8";
var NETWORK = (WEB3AUTH_NETWORK && WEB3AUTH_NETWORK.SAPPHIRE_DEVNET) || "sapphire_devnet";

var web3auth = null;

function saveAddr(a) { try { localStorage.setItem("arvcoin_wallet", a); } catch (e) {} }

async function ensureInit() {
  if (web3auth) return web3auth;
  web3auth = new Web3Auth({
    clientId: CLIENT_ID,
    web3AuthNetwork: NETWORK,
    uiConfig: { appName: "Arvcoin", mode: "dark" }
  });
  // v10 = init(); purana = initModal(). Jo mile use karo.
  if (typeof web3auth.init === "function") await web3auth.init();
  else if (typeof web3auth.initModal === "function") await web3auth.initModal();
  return web3auth;
}

async function connect() {
  var w = await ensureInit();
  var provider = w.provider;
  if (!w.connected) provider = await w.connect(); // modal khulta hai (Google/email)
  provider = provider || w.provider;

  var addr = "";
  try {
    var accounts = await provider.request({ method: "eth_accounts" });
    addr = (accounts && accounts[0]) || "";
  } catch (e) {}
  if (addr) saveAddr(addr);

  var info = {};
  try { info = await w.getUserInfo(); } catch (e) {}
  return { address: addr, name: (info && info.name) || "", email: (info && info.email) || "" };
}

async function logout() {
  try { if (web3auth) await web3auth.logout(); } catch (e) {}
}

function getAddress() {
  try { return localStorage.getItem("arvcoin_wallet") || ""; } catch (e) { return ""; }
}

window.ARVWallet = {
  isEnabled: function () { return true; },
  connect: connect,
  socialLogin: function () { return connect(); },
  logout: logout,
  getAddress: getAddress,
  isConnected: function () { return !!(web3auth && web3auth.connected); },
  version: "w3a-real-bundle",
  config: { clientId: CLIENT_ID, network: "sapphire_devnet" }
};
