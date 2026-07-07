/**
 * arvcoin — Transak integration (fiat on/off-ramp).
 *
 * HOW IT WORKS:
 * - Jab tak TRANSAK_API_KEY khali hai -> app DEMO mode me chalta hai (mock invest).
 * - Jaise hi tu apni Transak API key yahan (ya .env me) daalega -> asli Transak
 *   widget khul jayega: user UPI se pay karega, crypto uske wallet me jaayega.
 *
 * KEY KAHAN SE:
 *   1. transak.com -> Partner dashboard -> signup
 *   2. Test/Staging key turant milti hai (yahan STAGING rakho)
 *   3. KYB (business verify) ke baad Production key -> environment "PRODUCTION"
 */

export const TRANSAK_CONFIG = {
  // <<< yahan apni key daalo. Khali = demo mode >>>
  apiKey: "",
  // "STAGING" (test) ya "PRODUCTION" (live)
  environment: "STAGING" as "STAGING" | "PRODUCTION",
  fiatCurrency: "INR",
  // user ka default wallet address (real me per-user embedded wallet se aayega)
  defaultWalletAddress: "",
};

const BASE_URL = {
  STAGING: "https://global-stg.transak.com",
  PRODUCTION: "https://global.transak.com",
};

/** Kya Transak live hai? (key set hai to haan, warna demo) */
export function isTransakEnabled(): boolean {
  return TRANSAK_CONFIG.apiKey.trim().length > 0;
}

/** arvcoin asset id -> Transak crypto code + network */
const ASSET_MAP: Record<string, { crypto: string; network: string }> = {
  btc: { crypto: "BTC", network: "mainnet" },
  eth: { crypto: "ETH", network: "ethereum" },
  sol: { crypto: "SOL", network: "solana" },
};

export interface TransakParams {
  assetId: string;
  fiatAmount: number;
  walletAddress?: string;
  /** "BUY" ya "SELL" (off-ramp) */
  product?: "BUY" | "SELL";
  email?: string;
}

/** Transak widget ka URL banata hai (WebBrowser me kholne ke liye) */
export function buildTransakUrl(p: TransakParams): string {
  const map = ASSET_MAP[p.assetId] ?? { crypto: "BTC", network: "mainnet" };
  const base = BASE_URL[TRANSAK_CONFIG.environment];
  const wallet = p.walletAddress || TRANSAK_CONFIG.defaultWalletAddress;

  const q: Record<string, string> = {
    apiKey: TRANSAK_CONFIG.apiKey,
    fiatCurrency: TRANSAK_CONFIG.fiatCurrency,
    fiatAmount: String(p.fiatAmount),
    cryptoCurrencyCode: map.crypto,
    network: map.network,
    productsAvailed: p.product || "BUY",
    themeColor: "7c5cff",
    hideMenu: "true",
  };
  if (wallet) q.walletAddress = wallet;
  if (p.email) q.email = p.email;

  const query = Object.keys(q)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(q[k]))
    .join("&");
  return base + "/?" + query;
}
