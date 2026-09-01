# ARV Coin

**An index unit priced at ₹1 at launch, tracking Bitcoin one for one.**

Buy with UPI, hold units, watch them against Bitcoin minute by minute, redeem back
to UPI. Fees and Indian VDA tax are computed and itemised on every transaction.

---

## The whole product, in one formula

```
ARV(t) = ARV_BASE × Σ [ weight_i × ( quotePrice_i(t) / quotePrice_i(launch) ) ]
```

With the current configuration there is one asset at weight 1.0, so:

```
ARV(t) = ₹1 × ( BTC(t) / BTC(launch) )
```

Bitcoin doubles, ARV is ₹2. Bitcoin falls 8%, ARV is ₹0.92. Nothing else moves it.

The launch reference is locked in `arv-config.js` and never revised:

| | |
|---|---|
| Launch | 1 January 2025, 00:00 UTC |
| Bitcoin then | **$93,347.59** (Coinbase daily open) |
| USD/INR then | **85.60** |
| Bitcoin then, in ₹ | **₹79,90,554** |
| ARV then | **₹1.0000** |

### Three properties that follow from it

**Issuance cannot move the price.** Nothing in the pricing path reads deposits,
redemptions or units outstanding. New money issues new units at the current price
rather than bidding it up, so an early holder gains nothing from a later one
arriving. This is what separates an index unit from a number an operator can push.

**It is quoted in rupees, deliberately.** Deposits are rupees and the treasury
holds Bitcoin, so a rupee-quoted index is the only one whose printed change equals
what the money actually did, currency movement included. A consequence: ARV's
percentage change and Bitcoin's *rupee* percentage change are the same number by
construction, and the charts page shows both side by side so that is checkable
rather than merely claimed. Set `INDEX.quote = 'USD'` to track dollar performance
instead and strip the currency effect out.

**There is no order book.** Units are issued and redeemed against the index price.
No counterparty, no spread, no depth ladder — and so none is drawn. Anything that
would have to be fabricated is absent rather than simulated.

---

## Tax, stated once

Redeeming ARV is a transfer of a virtual digital asset. Two separate things
happen, and the UI never blurs them:

| | Rate | Withheld here? |
|---|---|---|
| **TDS** — s.194S | 1% of gross consideration (20% without PAN, s.206AA) | **Yes.** Deducted from the payout |
| **Tax** — s.115BBH | 30% on the gain + 4% cess = **31.2%** | **No.** Your liability at filing |

Three things that surprise people, all enforced in `js/ledger.js`:

- **Platform fees are not deductible.** Only cost of acquisition reduces the gain.
- **Losses cannot be set off** — not against other VDA gains, not against other
  income, not carried forward. Gain ₹1,00,000 on one redemption and lose ₹1,00,000
  on another and you are flat, but still owe tax on ₹1,00,000. The tax page
  quantifies exactly what that rule cost.
- **Holding is not taxable.** Tax arises on transfer, however large the unrealised
  gain.

Cost basis is FIFO. Rates live in `arv-config.js` — verify them with a CA before
relying on this for a filing.

---

## Architecture

Vanilla ES modules, no build step, no bundler. Deploys by copying files.

```
arv-config.js              ALL configuration — weights, fees, tax rates, launch base
css/core.css               design system
js/money.js                integer paise, 8dp units, Indian FY
js/fx.js                   USD/INR + one-call historical curve
js/feed.js                 5 exchange adapters, probe + failover, WS + REST
js/index-engine.js         the index formula, candle construction, live candle
js/ledger.js               fees, FIFO cost basis, VDA tax        ← shared with backend
js/chart.js                lightweight-charts wrapper
js/helix.js                Three.js blockchain-DNA scene
js/db.js                   Supabase, with a localStorage fallback
js/ui.js                   nav, footer, toasts, formatting
js/qr.js                   UPI intent + QR
js/pages/*.js              one controller per page
supabase/migrations/       schema, RLS, append-only triggers
supabase/functions/        ingest · backfill · trade
sw.js                      service worker — never caches a price
```

### Money and precision

Rupees are **integer paise**, never floats. ARV units are **8 decimal places**,
stored as Postgres `NUMERIC(28,8)`. Units are always rounded **down** on issuance
and on redemption, so the treasury never issues more value than it received.

A float rupee column eventually produces a ledger that does not balance, and in a
financial product that is not a rounding bug.

### One ledger implementation, two callers

`js/ledger.js` is imported by the browser to *preview* a trade and by the Edge
Function to *execute* one. The number a user agrees to and the number written to
the database come from the same code. Two implementations of tax maths drift, and
when they drift the user has consented to a figure the record disagrees with.

### Security model

Row level security lets a signed-in browser read only its own rows and write
**nothing** that touches money:

- `holdings`, `lots`, `transactions`, `tax_ledger` — owner may read, nobody may
  write. Every mutation goes through an Edge Function holding the service role key.
- `transactions` is **append-only**, enforced by trigger: `DELETE` is impossible
  for everyone including the service role, financial columns are frozen once
  written, and status may only move forward. Corrections are compensating entries.
- A user cannot grant themselves `is_admin`, verify their own PAN, or reclassify
  their own TDS threshold — blocked by trigger, not by convention.
- Operator actions re-check authority server-side. Hiding a button is not a
  permission model.

### Market data

Exchange APIs are geo-restricted and which ones are blocked depends on where the
browser is. Measured from a US egress point on 1 Sep 2026:

| Source | Status | Notes |
|---|---|---|
| Binance | blocked | "restricted location" |
| Bybit | blocked | CloudFront country block |
| **OKX** | works | 1m candles + WebSocket |
| **Coinbase** | works | 1m candles + WebSocket |
| **Kraken** | works | 1m candles + WebSocket |
| **CoinGecko** | works | spot only, no intraday — last resort |

So the feed **probes the configured order at startup, takes the first that
answers, and fails over mid-session** if that one goes quiet. A stalled WebSocket
that stays open reads as a frozen price, which is worse than a visible failure —
hence the staleness watchdog.

### Why candles are stored server-side

Public APIs return a few hundred candles per request and none will serve twenty
months of minute data. Computing the chart client-side caps ARV's minute history
at whatever one call returns, forever.

The ingest worker appends a candle a minute to `arv_candles`, so the series
accumulates — after a month of uptime there is a real month of ARV minute history
that no third party can rate-limit or withdraw. It also means a trade is priced
from the database rather than from an exchange being reachable at the instant
someone presses confirm, with a staleness check that pauses trading rather than
executing at an old number.

Backfill is tiered for the same reason: 1D since launch, 1h for 90 days, 1m for 7
days.

### The 3D scene

A double helix whose rungs are blocks — a single ledger twisting forward, each
block bound to the one before. It is wired to the market: rotation speed, glow and
colour temperature follow Bitcoin's live direction, so peripheral motion signals
which way the day is going before you read a number.

Restrained on purpose: particle count drops on small screens, rendering stops when
the tab is hidden, the whole thing is skipped under `prefers-reduced-motion`, a CSS
gradient stands in without WebGL, and the canvas never takes pointer events.

---

## Pages

| Page | Purpose |
|---|---|
| `index.html` | The formula, live price, worked fee examples from live data |
| `charts.html` | Candles at 7 timeframes, comparison overlay, tracking identity |
| `dashboard.html` | Position, P&L, and what redeeming everything would actually net |
| `buy.html` | Amount → itemised quote → UPI QR → issuance |
| `withdraw.html` | Units → full tax breakdown → payout |
| `transactions.html` | Complete append-only history, CSV export |
| `tax.html` | FY computation, Schedule VDA detail, cost of the no-set-off rule |
| `profile.html` | Name, PAN, payout UPI, TDS position |
| `admin.html` | **Treasury reconciliation**, pending payments, config |
| `legal.html` | Risk, terms, fees, tax, privacy, refunds, grievance |

### The reconciliation screen

`admin.html` computes the Bitcoin the treasury *must* hold — units outstanding ×
NAV ÷ Bitcoin's rupee price — and compares it against what is actually held. Any
difference is tracking error, and it is paid for by whoever redeems last. It
compounds silently, which makes it the one number an operator cannot leave
unchecked.

---

## Running it

```bash
python3 -m http.server 8080
# http://localhost:8080
```

With `SUPABASE.url` and `SUPABASE.anonKey` blank the app runs **local-only**: live
prices, real charts, and the complete fee and tax engine all work, with accounts
and holdings in `localStorage`. Nothing persists past a cleared cache.

For the real backend — schema, functions, scheduling, operator access — see
[SETUP.md](SETUP.md).

### Verification

The maths has a test harness (gitignored, in `.verify/`):

```bash
node .verify/engine.test.mjs   # index formula, candles, rollup, precision — 45 checks
node .verify/ledger.test.mjs   # fees, FIFO, TDS thresholds, no-set-off — 71 checks
```

Plus `.verify/schema.test.sql` — 46 checks against a real Postgres, covering the
append-only trigger, RLS isolation, privilege escalation and 8dp round-trips.

---

## Configuration

Everything tunable is in **`arv-config.js`**. No other file hardcodes a rate, a
fee, a weight or a tax percentage — and `legal.html` renders its fee and tax
tables from it, so the disclosure cannot drift out of step with what is charged.

Changing to a multi-asset basket is a config edit, not a rewrite. Every module is
written against the `BASKET` array rather than against "Bitcoin":

```js
var BASKET = [
  { key:'BTC', weight:0.50, /* … */ },
  { key:'ETH', weight:0.30, /* … */ },
  { key:'SOL', weight:0.20, /* … */ }
];
```

Add launch reference prices to `INDEX.baseUsd` for each new asset and the index,
charts, reconciliation and tax all follow. Weights must sum to 1 — the admin panel
flags it if they do not.

> **Note on open/high/low with several assets:** open and close stay exact, since
> every component's open and close are simultaneous. High and low become an upper
> and lower bound rather than true index extremes, because component extremes
> inside a bucket can occur at different moments. With one asset at weight 1.0 all
> four are exact.

---

## Regulatory position

This repository is software. It is not a licence to operate.

Virtual digital assets in India are taxed but are not regulated as securities.
Pooling money from the public to invest on their behalf, and holding customer
funds, engage several Indian regimes — among them FIU-IND registration as a
reporting entity, obligations under the PMLA, the Banning of Unregulated Deposit
Schemes Act, and the collective investment scheme provisions of the SEBI Act.
Which apply depends on how the operation is actually structured, and that is a
question for qualified counsel, not for code.

Before this is offered to anyone:

- [ ] Securities lawyer or company secretary review of every page of `legal.html`
- [ ] Determine which registrations apply, and obtain them
- [ ] GST registration, and the correct treatment of fee revenue
- [ ] A named grievance officer and a monitored address (currently placeholders)
- [ ] Real KYC and AML, and PAN verification against the department's records
- [ ] Payment reconciliation via a PSP webhook rather than manual matching
- [ ] Custody arrangements for the underlying asset, and an audit of them
- [ ] Independent audit of the ledger and the reconciliation process

`legal.html#regulatory` says all of this to the user as well, rather than only to
whoever reads the README.
