/**
 * arvcoin — lightweight global state (portfolio + live-ish prices).
 * Pure React Context + hooks, no external state lib needed for the demo.
 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  allAssets,
  Asset,
  getAsset,
  Holding,
  jitterPrice,
  seedHoldings,
  seedTxns,
  Txn,
} from "./mockData";

interface StoreValue {
  prices: Record<string, Asset>;
  holdings: Holding[];
  txns: Txn[];
  invested: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  /** Simulate a pay + auto-invest. Returns the created txn. */
  invest: (assetId: string, amountInr: number, method: "UPI" | "QR") => Txn;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [prices, setPrices] = useState<Record<string, Asset>>(() => {
    const map: Record<string, Asset> = {};
    allAssets.forEach((a) => (map[a.id] = a));
    return map;
  });
  const [holdings, setHoldings] = useState<Holding[]>(seedHoldings);
  const [txns, setTxns] = useState<Txn[]>(seedTxns);
  const idRef = useRef(100);

  // "live" price ticks
  useEffect(() => {
    const t = setInterval(() => {
      setPrices((prev) => {
        const next: Record<string, Asset> = {};
        Object.values(prev).forEach((a) => (next[a.id] = jitterPrice(a)));
        return next;
      });
    }, 3000);
    return () => clearInterval(t);
  }, []);

  const invest: StoreValue["invest"] = (assetId, amountInr, method) => {
    const price = prices[assetId] ?? getAsset(assetId)!;
    const units = amountInr / price.priceInr;
    const txn: Txn = {
      id: "t" + ++idRef.current,
      assetId,
      amountInr,
      units,
      method,
      at: Date.now(),
    };
    setTxns((prev) => [txn, ...prev]);
    setHoldings((prev) => {
      const idx = prev.findIndex((h) => h.assetId === assetId);
      if (idx === -1) {
        return [...prev, { assetId, units, investedInr: amountInr }];
      }
      const copy = [...prev];
      copy[idx] = {
        ...copy[idx],
        units: copy[idx].units + units,
        investedInr: copy[idx].investedInr + amountInr,
      };
      return copy;
    });
    return txn;
  };

  const { invested, currentValue } = useMemo(() => {
    let inv = 0;
    let cur = 0;
    holdings.forEach((h) => {
      inv += h.investedInr;
      const p = prices[h.assetId];
      if (p) cur += h.units * p.priceInr;
    });
    return { invested: inv, currentValue: cur };
  }, [holdings, prices]);

  const pnl = currentValue - invested;
  const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;

  const value: StoreValue = {
    prices,
    holdings,
    txns,
    invested,
    currentValue,
    pnl,
    pnlPct,
    invest,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
