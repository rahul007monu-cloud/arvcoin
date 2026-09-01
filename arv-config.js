/**
 * ARV Coin — single source of truth for all product configuration.
 *
 * Everything tunable lives here. No other file should hardcode a rate, a fee,
 * a weight or a tax percentage. Change a value here and the whole app follows,
 * including the fee schedule rendered on legal.html.
 *
 * Loaded as a classic script (not a module) so every page can read it without
 * an import, and so the admin panel can diff runtime config against defaults.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. THE BASKET — what ARV tracks
  // ---------------------------------------------------------------------------
  //
  // ARV is an index unit. Its price is ₹1 at launch, and from then on it moves
  // by exactly the weighted percentage change of the assets below.
  //
  //   ARV(t) = ARV_BASE × Σ [ weight_i × ( price_i(t) / price_i(launch) ) ]
  //
  // Right now there is one asset at 100% weight, so ARV mirrors Bitcoin 1:1.
  // To make it a multi-asset basket, add entries and make the weights sum to 1.
  // Nothing else in the codebase needs to change — every module is written
  // against this array, not against "Bitcoin".
  //
  //   Example 50/30/20 basket:
  //     { key:'BTC', weight:0.50, ... }, { key:'ETH', weight:0.30, ... },
  //     { key:'SOL', weight:0.20, ... }
  //
  var BASKET = [
    {
      key: 'BTC',
      name: 'Bitcoin',
      weight: 1.0,
      colour: '#f7931a',
      // Per-source instrument symbols. The feed layer probes sources in order
      // and uses whichever one answers, so a regional block on any single
      // exchange does not take the app down.
      symbols: {
        binance: 'BTCUSDT',
        okx: 'BTC-USDT',
        coinbase: 'BTC-USD',
        kraken: 'XBTUSD',
        coingecko: 'bitcoin'
      }
    }
  ];

  // Assets shown on charts and the market watchlist but NOT part of ARV's price.
  // These are reference instruments only — they carry zero weight.
  var WATCHLIST = [
    {
      key: 'ETH',
      name: 'Ethereum',
      colour: '#8a92b2',
      symbols: {
        binance: 'ETHUSDT',
        okx: 'ETH-USDT',
        coinbase: 'ETH-USD',
        kraken: 'ETHUSD',
        coingecko: 'ethereum'
      }
    },
    {
      key: 'SOL',
      name: 'Solana',
      colour: '#14f195',
      symbols: {
        binance: 'SOLUSDT',
        okx: 'SOL-USDT',
        coinbase: 'SOL-USD',
        kraken: 'SOLUSD',
        coingecko: 'solana'
      }
    }
  ];

  // ---------------------------------------------------------------------------
  // 2. LAUNCH BASE — the anchor the whole index hangs off
  // ---------------------------------------------------------------------------
  //
  // These are real observed values, not invented ones:
  //   BTC/USD open of the 2025-01-01 00:00 UTC daily candle (Coinbase)  = 93347.59
  //   USD/INR reference rate for that date (frankfurter, 2024-12-31)    = 85.60
  //
  // ARV is quoted in ₹ and tracks BTC *in ₹*. That is deliberate: users deposit
  // rupees and the treasury holds Bitcoin, so quoting in rupees is the only way
  // ARV's printed change matches what the money actually did. It also means the
  // UI can show BTC in ₹ beside ARV and the two percentages agree exactly.
  //
  // Set QUOTE to 'USD' to track Bitcoin's dollar performance instead and strip
  // the currency effect out. The tradeoff is that ARV's ₹ value would then
  // diverge from the real INR portfolio whenever the rupee moves.
  //
  var INDEX = {
    quote: 'INR',                        // 'INR' | 'USD'
    arvBaseInr: 1.0,                     // 1 ARV = ₹1 at launch
    launchIso: '2025-01-01T00:00:00Z',
    launchMs: Date.UTC(2025, 0, 1, 0, 0, 0),
    // Locked launch reference prices, per basket key, in USD.
    baseUsd: { BTC: 93347.59 },
    // Locked launch USD/INR. Used only when quote === 'INR'.
    baseFxUsdInr: 85.60,
    // Rebalancing only matters for multi-asset baskets. 'drift' lets weights
    // float with the market (what an index normally does). 'monthly' snaps
    // back to target weights on the 1st of each month.
    rebalance: 'drift',
    // Display precision. ARV starts at ₹1 so it needs more decimals than a
    // typical ₹ amount, otherwise real movement is invisible.
    priceDecimals: 4,
    unitDecimals: 8
  };

  // ---------------------------------------------------------------------------
  // 3. FEES — what the platform charges
  // ---------------------------------------------------------------------------
  var FEES = {
    entryPct: 0.5,          // % of gross deposit
    exitPct: 0.5,           // % of gross redemption
    gstPct: 18,             // GST applies to the FEE only, never to the principal
    annualMgmtPct: 0,       // set > 0 to accrue a daily management fee on AUM
    minInvestPaise: 10000,  // ₹100 minimum deposit
    minRedeemPaise: 10000,  // ₹100 minimum redemption
    // Simulated execution slippage on the underlying buy/sell. Real orders
    // never fill at the exact screen price; pretending they do makes every
    // number downstream slightly false.
    slippagePct: 0.05
  };

  // ---------------------------------------------------------------------------
  // 4. TAX — India, virtual digital assets
  // ---------------------------------------------------------------------------
  //
  // Two very different things, and the UI must never blur them:
  //
  //   TDS (s.194S)  — 1% of gross consideration, withheld by the platform at
  //                   the moment of redemption. Money the user does not receive.
  //   Tax (s.115BBH)— 30% + 4% cess on the gain. NOT withheld here; it is the
  //                   user's own liability, paid when they file their return.
  //                   The app computes and reports it, it does not collect it.
  //
  // Only cost of acquisition is deductible under s.115BBH — platform fees are
  // not. Losses cannot be set off against anything, or carried forward.
  //
  // Verify current rates with a CA before this is used for real filings.
  //
  var TAX = {
    vdaGainPct: 30,             // s.115BBH flat rate on gains
    cessPct: 4,                 // health & education cess, on the tax amount
    tdsPct: 1,                  // s.194S, on gross consideration
    tdsPctNoPan: 20,            // s.206AA — higher rate when PAN is absent
    tdsThresholdPaise: 1000000,       // ₹10,000 aggregate per FY
    tdsThresholdSpecifiedPaise: 5000000, // ₹50,000 for specified persons
    allowLossSetOff: false,     // must stay false — the law does not permit it
    feesDeductible: false,      // must stay false — only cost of acquisition
    costBasisMethod: 'FIFO',    // 'FIFO' — oldest lots consumed first
    fyStartMonth: 4             // Indian financial year begins in April
  };

  // ---------------------------------------------------------------------------
  // 5. PAYMENTS — UPI in, UPI out
  // ---------------------------------------------------------------------------
  //
  // Fill in `vpa` and `payeeName` and the app generates a real, scannable UPI
  // intent QR with the amount pre-filled. Leave `vpa` empty and it renders a
  // clearly-marked unconfigured placeholder instead.
  //
  // A QR alone cannot tell the app whether money actually arrived. Confirmation
  // is a manual step in the admin panel — see SETUP.md. Do not wire a
  // client-side "payment success" callback to credit units; that is the single
  // most common way these systems get drained.
  //
  var PAYMENTS = {
    vpa: '',                       // e.g. 'yourname@okhdfcbank'
    payeeName: 'ARV Coin',
    merchantCode: '',              // optional UPI MCC
    currency: 'INR',
    depositNoteTemplate: 'ARV-{ref}',
    // Redemptions are paid out to the UPI ID the user saves on their profile.
    payoutMode: 'upi',
    settlementHours: 24            // shown to the user as expected payout time
  };

  // ---------------------------------------------------------------------------
  // 6. MARKET DATA SOURCES
  // ---------------------------------------------------------------------------
  //
  // Probed in this order at startup; the first healthy one wins, and the app
  // fails over automatically if it goes stale mid-session.
  //
  // Measured from this sandbox (US egress) on 2026-09-01:
  //   binance  — blocked ("restricted location")
  //   bybit    — blocked (CloudFront country block)
  //   okx      — OK, 1m candles + WebSocket
  //   coinbase — OK, 1m candles + WebSocket
  //   kraken   — OK, 1m candles + WebSocket
  //   coingecko— OK, spot only (no intraday candles) — last resort
  //
  // Binance stays first in the list because where it is reachable it has the
  // best WebSocket and the deepest 1m history. It simply gets skipped when it
  // is not, which is why the probe exists.
  //
  var FEED = {
    sources: ['binance', 'okx', 'coinbase', 'kraken', 'coingecko'],
    probeTimeoutMs: 6000,
    // Treat the feed as stale and fail over if no tick arrives in this window.
    staleAfterMs: 90000,
    wsReconnectBaseMs: 1000,
    wsReconnectMaxMs: 30000,
    pollFallbackMs: 15000,       // used when no WebSocket is available
    fx: {
      // USD/INR. Only consulted when INDEX.quote === 'INR'.
      sources: ['frankfurter', 'erapi', 'coingecko'],
      refreshMs: 6 * 60 * 60 * 1000,   // FX moves slowly; 4x a day is plenty
      fallbackRate: 94.95              // last resort if every source fails
    }
  };

  // ---------------------------------------------------------------------------
  // 7. CHARTS
  // ---------------------------------------------------------------------------
  //
  // Backfill is tiered on purpose. 1m candles from launch would be ~876,000
  // rows and no public API will hand that over; every real platform keeps fine
  // granularity recent and coarse granularity long. Minute history then grows
  // on its own as the ingest worker runs.
  //
  var CHARTS = {
    timeframes: ['1m', '5m', '15m', '1h', '4h', '1D', '1W'],
    defaultTimeframe: '1h',
    defaultType: 'candles',        // 'candles' | 'area'
    backfill: { '1m': 7, '1h': 90, '1D': null },  // days of history; null = since launch
    maxCandles: 1500,
    showVolume: true,
    showEntryLine: true
  };

  // ---------------------------------------------------------------------------
  // 8. SUPABASE
  // ---------------------------------------------------------------------------
  //
  // The anon key is public by design — it is safe in a browser because every
  // table is guarded by row level security. The service_role key is NOT public
  // and must never appear in this repo; it belongs only in Edge Function
  // secrets. See SETUP.md.
  //
  // With these blank the app runs in local-only mode: live prices, charts and
  // the full fee/tax engine all work, but nothing persists between sessions.
  //
  var SUPABASE = {
    url: '',
    anonKey: '',
    functionsBase: ''   // defaults to `${url}/functions/v1` when left empty
  };

  // ---------------------------------------------------------------------------
  // 9. UI
  // ---------------------------------------------------------------------------
  var UI = {
    brand: 'ARV Coin',
    tagline: 'One rupee. One unit. Bitcoin\u2019s every move.',
    locale: 'en-IN',
    currencySymbol: '\u20b9',
    theme: 'helix-dark',
    // 3D scene. Heavy on a phone if left unchecked, so these are real limits.
    helix: {
      enabled: true,
      blocksPerStrand: 44,
      strandRadius: 2.6,
      rotationSpeed: 0.12,
      particleCount: 900,
      particleCountMobile: 260,
      pauseWhenHidden: true,
      respectReducedMotion: true
    },
    refreshMs: 1000,          // UI repaint cadence for live numbers
    toastMs: 4000
  };

  // ---------------------------------------------------------------------------
  // 10. Derived helpers — read-only conveniences
  // ---------------------------------------------------------------------------

  /** Launch reference price of the basket, in the quote currency. */
  function baseQuotePrice(key) {
    var usd = INDEX.baseUsd[key];
    if (usd == null) return null;
    return INDEX.quote === 'INR' ? usd * INDEX.baseFxUsdInr : usd;
  }

  /** Total basket weight — should be exactly 1. Surfaced in the admin panel. */
  function totalWeight() {
    return BASKET.reduce(function (s, a) { return s + a.weight; }, 0);
  }

  /** Config problems worth showing an operator, rather than failing silently. */
  function configWarnings() {
    var w = [];
    var tw = totalWeight();
    if (Math.abs(tw - 1) > 1e-9) {
      w.push('Basket weights sum to ' + tw.toFixed(4) + ', expected 1.0000');
    }
    BASKET.forEach(function (a) {
      if (INDEX.baseUsd[a.key] == null) {
        w.push('No launch base price for basket asset ' + a.key);
      }
    });
    if (!SUPABASE.url || !SUPABASE.anonKey) {
      w.push('Supabase not configured — running local-only, nothing will persist');
    }
    if (!PAYMENTS.vpa) {
      w.push('No UPI VPA configured — deposit QR is a placeholder');
    }
    if (TAX.allowLossSetOff) {
      w.push('TAX.allowLossSetOff is true — s.115BBH does not permit loss set-off');
    }
    if (TAX.feesDeductible) {
      w.push('TAX.feesDeductible is true — s.115BBH allows only cost of acquisition');
    }
    return w;
  }

  root.ARV_CONFIG = {
    BASKET: BASKET,
    WATCHLIST: WATCHLIST,
    INDEX: INDEX,
    FEES: FEES,
    TAX: TAX,
    PAYMENTS: PAYMENTS,
    FEED: FEED,
    CHARTS: CHARTS,
    SUPABASE: SUPABASE,
    UI: UI,
    baseQuotePrice: baseQuotePrice,
    totalWeight: totalWeight,
    configWarnings: configWarnings,
    version: '2.0.0'
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
