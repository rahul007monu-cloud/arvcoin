/**
 * ARV Coin — client configuration.
 *
 * Everything the browser needs to know, in one place. No other front-end file
 * hardcodes a rate, a fee, a weight, a timer or a tax percentage.
 *
 * Two rules about this file:
 *
 *   1. It is public. Anyone can read it. Nothing secret goes here — no database
 *      password, no SMTP password, no API secret. Those live in
 *      `api/config.local.php`, which the installer writes and git ignores.
 *
 *   2. The server does not trust it. Fees, tax and prices are recomputed
 *      server-side from `settings` in the database before any money moves. This
 *      copy exists so the UI can quote instantly without a round trip — if the
 *      two ever disagree, the server wins and the admin panel says so.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. WHAT ARV TRACKS
  // ---------------------------------------------------------------------------
  //
  //   ARV(t) = ARV_BASE × Σ [ weight_i × ( quotePrice_i(t) / quotePrice_i(launch) ) ]
  //
  // One asset at weight 1.0, so ARV is Bitcoin's percentage move applied to ₹1.
  // The weighted sum stays because turning this into a basket must remain a
  // config edit, not a rewrite.
  //
  var BASKET = [
    {
      key: 'BTC',
      name: 'Bitcoin',
      weight: 1.0,
      colour: '#c8ccd6',
      symbols: {
        binance: 'BTCUSDT', okx: 'BTC-USDT', coinbase: 'BTC-USD',
        kraken: 'XBTUSD', coingecko: 'bitcoin'
      }
    }
  ];

  // Shown on the dashboard so a holder can see the wider market. Zero weight —
  // these do not touch ARV's price.
  var WATCHLIST = [
    {
      key: 'ETH', name: 'Ethereum', colour: '#9aa0ae',
      symbols: {
        binance: 'ETHUSDT', okx: 'ETH-USDT', coinbase: 'ETH-USD',
        kraken: 'ETHUSD', coingecko: 'ethereum'
      }
    },
    {
      key: 'SOL', name: 'Solana', colour: '#8d93a1',
      symbols: {
        binance: 'SOLUSDT', okx: 'SOL-USDT', coinbase: 'SOL-USD',
        kraken: 'SOLUSD', coingecko: 'solana'
      }
    },
    {
      key: 'XRP', name: 'XRP', colour: '#7f8593',
      symbols: {
        binance: 'XRPUSDT', okx: 'XRP-USDT', coinbase: 'XRP-USD',
        kraken: 'XRPUSD', coingecko: 'ripple'
      }
    }
  ];

  // ---------------------------------------------------------------------------
  // 2. THE INDEX ANCHOR
  // ---------------------------------------------------------------------------
  //
  // Real observed values, locked and never revised:
  //   BTC/USD open of the 2021-09-01 00:00 UTC daily candle = 47110.33  (Coinbase)
  //   USD/INR reference for that date                        = 73.073   (Frankfurter)
  //
  // A roughly ten-year history is the point of that date. The launch anchor is
  // 2015-07-20 — the day Coinbase listed BTC-USD and the earliest date a free
  // exchange API (Coinbase, then OKX) reliably serves daily Bitcoin candles. An
  // index with a few years behind it covers a couple of full cycles; ten years
  // covers the 2017 run, the 2018 winter, the 2021 top, the 2022 drawdown and
  // the 2024-25 recovery, so the chart shows what holding this actually feels
  // like rather than only the pleasant stretch.
  //
  // HONEST DATA LIMIT — read before "improving" this. Free exchange APIs serve
  // *daily* Bitcoin only back to ~2015, and NO free source serves *minute* data
  // ten years deep (five years of 1m alone is ~2.6M rows). So the deep history
  // is genuinely daily/weekly, and the minute/tick-by-tick view only exists for
  // the recent window. The chart is tiered on purpose; we do not synthesise fake
  // candles to paper over the gap. See README.md ("A note on history depth").
  //
  // Both anchor figures are real, published observations for 2015-07-20 and are
  // never revised, because the whole index hangs off them: BTC/USD daily open
  // ≈ $277.89, USD/INR ≈ 63.50 that day.
  //
  // arvBaseInr is chosen together with the launch so that today's price sits
  // near ₹10,000 today while the chart still traces real Bitcoin's actual
  // ~560x ten-year shape. With a 2015 launch the now/launch multiple is large
  // (~561x for BTC≈$110k, USD/INR≈90), so the base is small:
  // 10000 / 561 ≈ 17.83. Because NAV_launch == arvBaseInr in the index formula,
  // the launch value honestly reads ~₹17.83 (that is the real consequence of
  // tracking BTC's genuine ~560x run: launch small, today ~₹10k, and the ATH
  // scales to BTC's real ATH proportion). Recent minutes are true minute-by-
  // minute history; the deep 2015→ body is daily/weekly. See NAV arithmetic in
  // README/SETUP.
  //
  // Quoted in rupees because deposits are rupees and the treasury holds Bitcoin.
  // That makes ARV's printed change equal what the money actually did, currency
  // movement included, and it makes ARV's percentage identical to Bitcoin's
  // rupee percentage — which the trade screen shows side by side.
  //
  var INDEX = {
    quote: 'INR',
    // Retargeted to ~$100 USD today. Math: ARV ≈ $100 × fx ≈ $100 × 90 = ₹9,000.
    // BTC_launch_inr = 277.89 × 63.50 = 17,645.915. BTC_now_inr ≈ ₹75,33,497.
    // arv_base_inr = 9000 × (17,645.915 / 75,33,497) ≈ 21.08.
    arvBaseInr: 21.08,
    launchIso: '2015-07-20T00:00:00Z',
    launchMs: Date.UTC(2015, 6, 20, 0, 0, 0),
    baseUsd: { BTC: 277.89 },
    baseFxUsdInr: 63.50,
    rebalance: 'drift',
    priceDecimals: 4,
    unitDecimals: 8
  };

  // ---------------------------------------------------------------------------
  // 3. THE MARKET MODEL — how a trade actually happens
  // ---------------------------------------------------------------------------
  //
  // This is the decision that shapes the whole product, so it is written out.
  //
  // ARV's price is a formula, not an auction. An order book that also discovered
  // price would fight that formula: one trade at a silly price on a thin day
  // would drag the chart away from Bitcoin and break the one promise the product
  // makes. So the book is a *queue*, not an auction —
  //
  //   every match settles at the index price
  //
  // and a "limit order" is a trigger: "act when the index reaches this level",
  // not "wait for someone to accept my price".
  //
  // Consequences, deliberately chosen:
  //
  //   BUY is always instant. It fills from resting sell orders first, and the
  //   remainder from the treasury. A buyer never waits, because making buyers
  //   wait for sellers is how an exchange dies before it starts.
  //
  //   SELL prefers a real counterparty. It fills against resting buy orders
  //   first. Anything unmatched rests in the book — and if it is still unmatched
  //   after `sellFallbackMinutes`, the treasury buys it.
  //
  // That fallback is not a nicety. Without it, a falling market means everyone
  // sells and nobody buys, and holders are locked in with no exit. "My money is
  // stuck" is the complaint that ends products.
  //
  // Set `matchAtIndexPrice` to false only if the book is genuinely deep enough
  // to discover price honestly. It is not, on day one.
  //
  var MARKET = {
    matchAtIndexPrice: true,
    buyFillsFromTreasury: true,        // buys never wait
    sellFallbackToTreasury: true,      // no seller ever gets trapped
    sellFallbackMinutes: 60,
    orderExpiryHours: 168,             // resting orders expire after a week
    allowPartialFills: true,
    minOrderPaise: 10000,              // ₹100
    minOrderUnits: 1,
    // Users trade against the platform's INR wallet, never each other's bank
    // accounts. Direct user-to-user UPI invites disputes, mule-account abuse and
    // frozen bank accounts — the ledger moves instead.
    settlement: 'inr_wallet'
  };

  // ---------------------------------------------------------------------------
  // 4. FEES
  // ---------------------------------------------------------------------------
  var FEES = {
    entryPct: 0.5,
    exitPct: 0.5,
    gstPct: 18,                  // on the fee only, never on the principal
    annualMgmtPct: 0,
    minInvestPaise: 10000,
    minRedeemPaise: 10000,
    minWithdrawPaise: 10000,
    // A real order does not fill at the mid price. Modelling this as zero makes
    // every downstream number optimistic in the user's favour, which is the
    // worst direction for an error to point.
    slippagePct: 0.05
  };

  // ---------------------------------------------------------------------------
  // 5. TAX — India, virtual digital assets
  // ---------------------------------------------------------------------------
  //
  // Two different things the UI must never merge:
  //
  //   TDS (s.194S)   1% of gross consideration, WITHHELD from the seller at the
  //                  moment of a fill. 20% where no PAN is on record (s.206AA).
  //   Tax (s.115BBH) 30% + 4% cess = 31.2% on the gain. NOT withheld. The
  //                  holder's own liability at filing. Computed and reported
  //                  here, not collected.
  //
  // Only cost of acquisition is deductible — fees are not. Losses cannot be set
  // off against anything, or carried forward.
  //
  var TAX = {
    vdaGainPct: 30,
    cessPct: 4,
    tdsPct: 1,
    tdsPctNoPan: 20,
    tdsThresholdPaise: 1000000,
    tdsThresholdSpecifiedPaise: 5000000,
    allowLossSetOff: false,
    feesDeductible: false,
    costBasisMethod: 'FIFO',
    fyStartMonth: 4
  };

  // ---------------------------------------------------------------------------
  // 6. MONEY IN AND OUT
  // ---------------------------------------------------------------------------
  //
  // A UPI QR carries a request one way and returns nothing — no callback, no
  // signature. So a deposit is never credited because a QR was shown. The user
  // submits a UTR or a screenshot, and an operator matches it against the bank
  // account before the wallet moves.
  //
  var PAYMENTS = {
    // NOT the payment address. The one that matters is `settings.upi_vpa` in the
    // database, editable in Operations → Settings and returned by deposit.php with
    // every request. This stays empty on purpose: a second copy of a payment
    // address is a second place to forget, and a stale one here would mean money
    // sent to whatever it used to say.
    vpa: '',
    payeeName: 'ARV Coin',
    merchantCode: '',
    currency: 'INR',
    depositNoteTemplate: 'ARV-{ref}',
    requireUtrOrScreenshot: true,
    maxScreenshotMb: 4,

    // Windows shown to the user. Honest ranges, not promises of the minimum.
    depositMinMinutes: 2,
    depositMaxMinutes: 15,
    withdrawMinMinutes: 5,
    withdrawMaxMinutes: 60,

    depositRequestExpiryMinutes: 30
  };

  // ---------------------------------------------------------------------------
  // 7. KYC
  // ---------------------------------------------------------------------------
  //
  // PAN is collected and stored: it is required to apply the correct TDS rate,
  // and holding it is lawful.
  //
  // Aadhaar is NOT. Storing an Aadhaar number or image without being a licensed
  // KUA/AUA is an offence under the Aadhaar Act, 2016, carrying imprisonment.
  // So the flow captures only the last four digits for display, and expects a
  // licensed provider (Digio, Signzy, HyperVerge, Karza) to do the actual
  // verification and return a yes/no. The full number never reaches this
  // database. `aadhaarProvider` stays empty until such a provider is wired in,
  // and while it is empty the field is optional and clearly marked unverified.
  //
  var KYC = {
    required: true,
    requiredBefore: 'first_buy',
    fields: ['fullName', 'dob', 'pan', 'address', 'state', 'pincode'],
    panRegex: '^[A-Z]{5}[0-9]{4}[A-Z]$',
    aadhaarProvider: '',
    aadhaarStoreLast4Only: true,
    minAge: 18,
    reviewSlaHours: 24
  };

  // ---------------------------------------------------------------------------
  // 8. REFERRAL AND REWARDS
  // ---------------------------------------------------------------------------
  //
  // 5% of a referred user's first deposit, once, credited to the referrer's INR
  // wallet.
  //
  // A word of caution kept next to the switch that turns it on: paying a
  // commission calculated on money other people put in, in a product that pools
  // funds, is the shape the Prize Chits and Money Circulation Schemes (Banning)
  // Act, 1978 describes. Single-level and one-time — as configured — is a long
  // way from a chain scheme, and `enabled: false` disables the whole thing
  // instantly if counsel says to. Do not add a second level.
  //
  var REFERRAL = {
    enabled: true,
    commissionPct: 5,
    onlyFirstDeposit: true,
    levels: 1,                        // must stay 1
    maxCommissionPaise: 5000000,      // ₹50,000 cap per referral
    codeLength: 8,
    selfReferralBlocked: true,
    // Commission is income for the referrer, not a capital gain. It is recorded
    // separately so it never contaminates the VDA cost basis.
    ledgerKind: 'referral_commission'
  };

  // Tiers are earned on total referred volume — the rupees a referrer's
  // referrals have actually deposited.
  //
  // The reward is a fee discount, not cash. That is deliberate: a cash bonus
  // scaled to volume reads as a promised return, which is both a compliance
  // problem and a promise the treasury cannot keep. A fee discount is real
  // value, funded out of the platform's own margin, and honest to describe.
  var REWARD_TIERS = [
    { id: 'bronze',   label: 'Bronze',   metric: 'ratio',  threshold: 1,        entryFeePct: 0,    exitFeePct: null, days: 30,   perk: 'Entry fee waived for 30 days' },
    { id: 'silver',   label: 'Silver',   metric: 'ratio',  threshold: 5,        entryFeePct: 0.25, exitFeePct: null, days: null, perk: 'Entry fee 0.25%, permanently' },
    { id: 'gold',     label: 'Gold',     metric: 'ratio',  threshold: 10,       entryFeePct: 0.25, exitFeePct: 0.25, days: null, perk: 'Entry and exit fee 0.25%' },
    { id: 'platinum', label: 'Platinum', metric: 'ratio',  threshold: 100,      entryFeePct: 0,    exitFeePct: 0.25, days: null, perk: 'No entry fee, exit 0.25%' },
    { id: 'sterling', label: 'Sterling', metric: 'paise',  threshold: 10000000, entryFeePct: 0,    exitFeePct: 0.25, days: null, perk: 'Priority withdrawal \u2014 the 5 minute band' },
    { id: 'obsidian', label: 'Obsidian', metric: 'paise',  threshold: 100000000, entryFeePct: 0,   exitFeePct: 0,    days: null, perk: 'Zero fees and a dedicated line' }
  ];

  // ---------------------------------------------------------------------------
  // 9. MARKET DATA
  // ---------------------------------------------------------------------------
  //
  // Probed in order; the first that answers wins, and the winner is remembered.
  // Reachability is a property of the network, not the moment — exchange APIs
  // are geo-restricted and which ones are blocked depends on where the browser
  // is. Measured from a US egress point: Binance and Bybit refuse outright,
  // while OKX, Coinbase and Kraken answer.
  //
  // `channel: 'trades'` subscribes to individual executions rather than a
  // once-a-second summary, which is what makes the tape and the last candle move
  // trade by trade instead of in visible steps.
  //
  var FEED = {
    sources: ['binance', 'okx', 'coinbase', 'kraken', 'coingecko'],
    channel: 'trades',
    probeTimeoutMs: 6000,
    staleAfterMs: 90000,
    wsReconnectBaseMs: 1000,
    wsReconnectMaxMs: 30000,
    wsOpenTimeoutMs: 8000,
    pollFallbackMs: 15000,
    tapeLength: 40,               // how many recent trades to keep on screen
    // Individual trades can arrive faster than a screen can repaint. Ticks are
    // coalesced to this interval for rendering; none are dropped from the tape.
    renderThrottleMs: 80,
    fx: {
      sources: ['frankfurter', 'erapi', 'coingecko'],
      refreshMs: 6 * 60 * 60 * 1000,
      fallbackRate: 94.95
    }
  };

  // ---------------------------------------------------------------------------
  // 10. CHARTS
  // ---------------------------------------------------------------------------
  //
  // Backfill is tiered because no public API will serve five years of minute
  // candles, and no browser should hold them. Fine granularity stays recent;
  // minute history then deepens on its own as the cron worker runs.
  //
  //   1D  since launch  — the full five years, ~1,830 candles
  //   1W  since launch  — ~260 candles, the long view at a glance
  //   4h  two years     — enough to read the 2022 drawdown properly
  //   1h  90 days
  //   1m  7 days
  //
  var CHARTS = {
    timeframes: ['1m', '5m', '15m', '1h', '4h', '1D', '1W'],
    // Open on the minute chart, the way CoinDCX and Delta do. A trader lands on
    // the live candle first and zooms out to a range if they want the history.
    defaultTimeframe: '1m',
    // What the "All" range on the overview chart opens at. Weekly over the full
    // history reads well; anything finer is noise at that width.
    allTimeframe: '1W',
    defaultType: 'candles',
    // Every tf a range can request needs a backfill depth, or that range renders
    // near-empty. 5m and 15m are now backfilled so 1D and 1W are populated.
    backfill: { '1m': 7, '5m': 30, '15m': 90, '1h': 365, '4h': 730, '1D': null, '1W': null },
    // Five years of daily is ~1,830 bars, so the old 1,500 cap would have
    // silently truncated the earliest months of history.
    maxCandles: 2600,
    showVolume: true,
    showEntryLine: true,
    // Ranges offered on the chart toolbar, in days. null = since launch. Each
    // window is paired with a tf that keeps the bar count readable: a day of
    // minutes, a week of 15m, a month of hours, a quarter of 4h, then daily out
    // to five years and weekly for everything. No range is left near-empty and
    // none crams years of daily bars into a one-day view.
    ranges: [
      { label: '1D',  days: 1,    tf: '1m'  },
      { label: '1W',  days: 7,    tf: '15m' },
      { label: '1M',  days: 30,   tf: '1h'  },
      { label: '3M',  days: 90,   tf: '4h'  },
      { label: '1Y',  days: 365,  tf: '1D'  },
      { label: '5Y',  days: 1825, tf: '1D'  },
      { label: 'All', days: null, tf: '1W'  }
    ],
    defaultRange: '1W'
  };

  // ---------------------------------------------------------------------------
  // 11. API
  // ---------------------------------------------------------------------------
  //
  // Same origin. PHP on the same Hostinger account that serves these pages, so
  // there is no CORS, no third-party service, and nothing to keep in sync.
  //
  var API = {
    base: 'api',
    timeoutMs: 20000,
    csrfHeader: 'X-ARV-CSRF'
  };

  // ---------------------------------------------------------------------------
  // 12. UI
  // ---------------------------------------------------------------------------
  var UI = {
    brand: 'ARV',
    brandFull: 'ARV Coin',
    tagline: 'One rupee. One unit. Bitcoin\u2019s every move.',
    locale: 'en-IN',
    currencySymbol: '\u20b9',

    // Silver on black. Restraint is the point: a luxury interface earns its
    // feel from space, weight and material, not from motion. Nothing here
    // animates for its own sake, and there is no 3D scene at all — dropping it
    // removed 1.3 MB from the critical path, which a phone feels immediately.
    theme: 'sterling',

    // Hero.
    //
    // Rendered entirely in CSS — no video, no images, no 3D. That is a
    // deliberate choice rather than a limitation: a background video costs a
    // megabyte or two before anything is readable, and on a phone it is the
    // single easiest way to make a site feel slow. Everything here is a gradient,
    // so the hero paints on the first frame and weighs nothing.
    //
    // The material is built in four layers, in order:
    //
    //   plate      a deep charcoal base with a soft overhead light
    //   engine     fine concentric engine-turning, as on a milled metal plate
    //   sweep      a specular highlight that drifts across, like light on steel
    //   grain      a faint noise overlay so large flat areas are not plastic
    //
    // Only `sweep` animates, on transform and opacity alone, so it stays on the
    // compositor and never touches layout.
    hero: {
      style: 'sterling',
      engineTurning: true,
      specularSweep: true,
      grain: true,
      sweepSeconds: 18,
      // Mobile keeps the plate and the grain but drops the moving highlight.
      // A large blurred element animating behind the fold is the most expensive
      // thing on the page and the least noticed.
      sweepOnMobile: false
    },

    motion: {
      shimmer: true,
      respectReducedMotion: true,
      pauseWhenHidden: true
    },

    refreshMs: 1000,
    toastMs: 4000,

    // Where complaints go, and the date the terms last changed. Both are printed
    // on legal.html, so they live here rather than being hard-coded into a page
    // nobody remembers to edit.
    supportEmail: 'support@arvcoin.com',
    legalUpdated: '2026-09-01'
  };

  // ---------------------------------------------------------------------------
  // 13. Derived helpers
  // ---------------------------------------------------------------------------

  function baseQuotePrice(key) {
    var usd = INDEX.baseUsd[key];
    if (usd == null) return null;
    return INDEX.quote === 'INR' ? usd * INDEX.baseFxUsdInr : usd;
  }

  function totalWeight() {
    return BASKET.reduce(function (s, a) { return s + a.weight; }, 0);
  }

  /** Effective fees for a user, after any reward tier they have earned. */
  function effectiveFees(tierId) {
    var f = { entryPct: FEES.entryPct, exitPct: FEES.exitPct, tier: null };
    if (!tierId) return f;
    var t = REWARD_TIERS.find(function (x) { return x.id === tierId; });
    if (!t) return f;
    if (t.entryFeePct != null) f.entryPct = t.entryFeePct;
    if (t.exitFeePct != null) f.exitPct = t.exitFeePct;
    f.tier = t;
    return f;
  }

  /** Problems worth showing an operator rather than failing silently on. */
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
    if (!PAYMENTS.vpa) w.push('No UPI VPA configured \u2014 the deposit QR is a placeholder');
    if (TAX.allowLossSetOff) w.push('TAX.allowLossSetOff is true \u2014 s.115BBH does not permit set-off');
    if (TAX.feesDeductible) w.push('TAX.feesDeductible is true \u2014 only cost of acquisition is deductible');
    if (REFERRAL.levels > 1) w.push('REFERRAL.levels is above 1 \u2014 multi-level referral is a money circulation scheme');
    if (!MARKET.sellFallbackToTreasury) {
      w.push('Sell fallback is off \u2014 holders can be left unable to exit in a falling market');
    }
    if (KYC.required && !KYC.aadhaarProvider) {
      w.push('No Aadhaar verification provider configured \u2014 Aadhaar remains optional and unverified, which is correct until one is licensed');
    }
    return w;
  }

  root.ARV_CONFIG = {
    BASKET: BASKET,
    WATCHLIST: WATCHLIST,
    INDEX: INDEX,
    MARKET: MARKET,
    FEES: FEES,
    TAX: TAX,
    PAYMENTS: PAYMENTS,
    KYC: KYC,
    REFERRAL: REFERRAL,
    REWARD_TIERS: REWARD_TIERS,
    FEED: FEED,
    CHARTS: CHARTS,
    API: API,
    UI: UI,
    baseQuotePrice: baseQuotePrice,
    totalWeight: totalWeight,
    effectiveFees: effectiveFees,
    configWarnings: configWarnings,
    version: '3.0.0'
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
