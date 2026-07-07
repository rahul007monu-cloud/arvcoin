/**
 * arvcoin — mock data layer (no API keys needed).
 * Swap these functions for real Onramp.money / CoinDCX / smallcase / Razorpay
 * calls when partner integrations go live.
 */
import { colors } from "./theme";

export type AssetType = "crypto" | "stock";

export interface Asset {
  id: string;
  name: string;
  symbol: string;
  type: AssetType;
  glyph: string; // simple char glyph for icon
  color: string;
  priceInr: number; // current mock price per unit
  change24h: number; // percent
}

export const cryptoAssets: Asset[] = [
  { id: "btc", name: "Bitcoin", symbol: "BTC", type: "crypto", glyph: "\u20BF", color: colors.btc, priceInr: 7412000, change24h: 2.4 },
  { id: "eth", name: "Ethereum", symbol: "ETH", type: "crypto", glyph: "\u039E", color: colors.eth, priceInr: 384500, change24h: 1.1 },
  { id: "sol", name: "Solana", symbol: "SOL", type: "crypto", glyph: "\u25CE", color: colors.sol, priceInr: 18240, change24h: 4.8 },
];

export const stockAssets: Asset[] = [
  { id: "nifty", name: "Nifty 50 Index", symbol: "NIFTY", type: "stock", glyph: "N", color: colors.cyan, priceInr: 26380, change24h: 0.7 },
  { id: "reliance", name: "Reliance", symbol: "RELI", type: "stock", glyph: "R", color: "#ff8a94", priceInr: 2985, change24h: -0.5 },
  { id: "goldmf", name: "Gold Mutual Fund", symbol: "GOLD", type: "stock", glyph: "\u2726", color: "#ffd76a", priceInr: 7620, change24h: 0.9 },
];

export const allAssets = [...cryptoAssets, ...stockAssets];

export function getAsset(id: string): Asset | undefined {
  return allAssets.find((a) => a.id === id);
}

/** Small random walk so prices feel "live" in the demo. */
export function jitterPrice(asset: Asset): Asset {
  const drift = (Math.random() - 0.48) * 0.8;
  return {
    ...asset,
    change24h: Math.max(-9, Math.min(9, asset.change24h + drift)),
    priceInr: Math.max(1, Math.round(asset.priceInr * (1 + drift / 100))),
  };
}

export interface Holding {
  assetId: string;
  units: number;
  investedInr: number;
}

export interface Txn {
  id: string;
  assetId: string;
  amountInr: number;
  units: number;
  method: "UPI" | "QR";
  at: number; // timestamp
}

/** Seed portfolio so the dashboard doesn't look empty on first open. */
export const seedHoldings: Holding[] = [
  { assetId: "btc", units: 0.00071, investedInr: 5000 },
  { assetId: "eth", units: 0.0081, investedInr: 3000 },
  { assetId: "sol", units: 0.104, investedInr: 1800 },
];

export const seedTxns: Txn[] = [
  { id: "t1", assetId: "btc", amountInr: 2000, units: 0.00028, method: "UPI", at: Date.now() - 86400000 * 2 },
  { id: "t2", assetId: "eth", amountInr: 1500, units: 0.004, method: "QR", at: Date.now() - 86400000 },
  { id: "t3", assetId: "sol", amountInr: 800, units: 0.045, method: "UPI", at: Date.now() - 3600000 * 5 },
];

export function formatInr(n: number, decimals = 0): string {
  return (
    "\u20B9" +
    n.toLocaleString("en-IN", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

export function formatUnits(n: number): string {
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.001) return n.toFixed(5);
  return n.toFixed(7);
}
