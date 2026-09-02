# ARV Coin

**One unit, ₹1 at launch, tracking Bitcoin one for one in rupees.**

Deposit by UPI, buy ARV, watch it move with Bitcoin minute by minute, sell back to
your bank. Fees, GST, FIFO cost basis and Indian VDA tax are computed and itemised
on every transaction.

Runs on PHP 8 and MySQL — the stack a Hostinger shared plan already includes.
No build step, no framework, no node_modules in production.

---

## The whole product, in one formula

```
ARV(t) = ₹1.00 × ( BTC(t) × FX(t) ) / ( BTC(launch) × FX(launch) )
```

Bitcoin doubles in rupee terms, ARV is ₹2. Bitcoin falls 8%, ARV is ₹0.92.
Nothing else moves it.

The launch reference is stored in the `settings` table and never revised:

| | |
|---|---|
| Launch | 1 September 2021, 00:00 UTC |
| Bitcoin then | **$47,110.33** (Coinbase daily open) |
| USD/INR then | **₹73.073** (Frankfurter) |
| Bitcoin then, in ₹ | **₹34,42,493** |
| ARV then | **₹1.0000** |

Five years back, so the chart carries a full cycle rather than a flattering
slice — including the 2022 drawdown, where ARV fell to **₹0.3665**, 88.7% below
its October 2025 peak of ₹3.2571. A launch date that hid that would be a
marketing decision dressed up as a technical one.

### Three properties that follow from the formula

**Issuance cannot move the price.** Nothing in the pricing path reads deposits,
sales or units outstanding. New money issues new units at the current price rather
than bidding it up, so an early holder gains nothing from a later one arriving.
That is what separates an index unit from a number an operator can push.

**Every fill settles at the index price.** The order book queues for *size*, never
for price. One trade on a thin day therefore cannot drag ARV away from Bitcoin,
which is the single promise the product makes.

**A stale feed pauses trading.** If the last candle is older than
`price_max_age_seconds`, orders are refused rather than filled at a number nobody
trusts. A visible pause is correct; a fill at yesterday's price is not.

---

## How the order book works

A "limit order" here is a **trigger**, not an offer — *act when the index reaches
this level* — because there is no price to negotiate. Consequences, chosen
deliberately:

| | |
|---|---|
| **Buy** | Always fills immediately. Resting sell orders first, treasury for the remainder. Making buyers wait for sellers is how an exchange dies before it starts. |
| **Sell** | Prefers a real counterparty. Fills against resting buys first; anything unmatched rests, and after `sell_fallback_minutes` (60) the treasury takes the other side at the same price. |
| **Settlement** | Through each user's INR wallet. Never user-to-user UPI — direct transfers between strangers are how disputes, chargebacks, mule accounts and frozen bank accounts happen. |

Without the sell fallback, a falling market means everyone sells and nobody buys,
and holders are locked in at exactly the moment selling matters. "My money is
stuck" is the complaint that ends products.

---

## Money handling

- **Integer paise for rupees, integer units×10⁸ for ARV.** No floats anywhere on
  the money path. `10,000.12345678` units already uses 13 of a double's ~15
  significant digits, so a float would start losing paise at realistic balances.
- **Append-only ledger.** Every rupee and every unit that moves is written once,
  enforced by MySQL triggers rather than by convention. Wallets are a cached
  balance; the ledger is the book of record, and a correction is a new
  compensating entry rather than an edit.
- **Escrow that cannot be double-spent.** A resting buy holds the rupees it needs
  *including* the fee and the GST on the fee, sized as `G = L / (1 + e/100 ×
  (1+g/100))` so the fee is charged once rather than twice. A resting sell holds
  the units the same way.
- **FIFO cost basis, locked `FOR UPDATE`** in acquisition order — both the
  accounting requirement and a fixed lock order, so two concurrent sells queue
  instead of deadlocking.
- **A UPI QR proves nothing.** It carries a request one way and returns no
  callback and no signature. Deposits are credited when an operator matches a UTR
  or a screenshot against the bank statement, never because a QR was displayed.
  Wiring "QR shown, so credit the units" is the most effective way to have a
  balance drained by someone who never paid.

---

## Tax, as implemented

| | |
|---|---|
| Gains | 30% + 4% cess, flat, under s.115BBH |
| Deductible | cost of acquisition only — **not** our fee, not the GST on it |
| Losses | not set off, not carried forward (s.115BBH(2)) |
| TDS | 1% of gross consideration on sale, s.194S, above the annual threshold |
| No PAN | 20% under s.206AA — the most expensive blank field on the site |
| Cost basis | FIFO, fixed at the moment of each sale |

Three amounts are kept visibly apart on `tax.html`, because conflating them is how
a crypto statement misleads: **TDS withheld** (a credit, already paid to the
government, appears in Form 26AS), **tax on gains** (your own liability at
filing), and **fees and GST** (real money paid, and not deductible).

Losses are reported and never netted against gains. A page that quietly subtracted
them would understate what is owed.

---

## Aadhaar

**Never collected in full, never stored.** Holding Aadhaar numbers without being a
licensed authentication agency is an offence under the Aadhaar Act, 2016, carrying
imprisonment. The field accepts four digits and cannot accept twelve.
`kyc.aadhaar_provider` stays empty until a licensed provider is wired in, and that
provider will return a yes or no rather than handing over the number.

PAN *is* stored: holding it is lawful, and it decides the TDS rate.

---

## Layout

```
index.html          the market, the formula, the five-year chart
login.html          sign in
signup.html         open an account, with OTP
trade.html          order ticket, book, tape, candles
dashboard.html      wallet, holdings, open orders
deposit.html        UPI QR, UTR or screenshot, countdown
withdraw.html       to your own verified VPA
transactions.html   the ledger, and every fill
tax.html            FY statement, printable
referral.html       code, link, QR, tier ladder
profile.html        KYC, PAN, password
admin.html          deposits, withdrawals, KYC queue, reconciliation, settings
legal.html          risk, terms, tax, KYC/AML, privacy, regulatory status
404.html

arv-config.js       every constant, in one file, with the reasoning next to it
css/core.css        the whole interface — silver on black, one stylesheet
js/api.js           the only thing that talks to PHP: CSRF, errors, session
js/ui.js            nav, footer, formatting, toasts, CSV, countdowns
js/feed.js          live price, trade-by-trade where the exchange allows it
js/reveal.js        scroll reveal
js/qr.js            UPI intent + QR
js/pages/*.js       one module per page

api/_boot.php       config, PDO, tx() with deadlock retry, CSRF, rate limits, audit
api/_money.php      u8 arithmetic, NAV, fees, TDS, FIFO lots, quotes, wallets
api/_match.php      the matching engine, escrow, fills, treasury fallback
api/_schema.php     18 tables, 8 append-only triggers, default settings
api/auth.php  orders.php  deposit.php  withdraw.php  kyc.php
api/account.php     ledger, fills, tax statement
api/referral.php  market.php  admin.php  cron.php
install.php         one-page installer — delete it afterwards

tools/build-icons.mjs   rasterise favicon.svg into the manifest's PNGs
```

`sw.js` never caches `api/`, and that exclusion is by path rather than by
hostname — the API shares an origin with the shell, so a hostname check would put
every wallet response in the cache and eventually serve one user's balance to
another.

---

## Design

Silver on black. The feel comes from space, weight and material rather than
motion: brushed-metal gradients, hairline rules, one serif for display and one
sans for everything else.

- **No hero video.** A background video costs one to two megabytes before anything
  is readable. The hero is four CSS layers — plate, engine turning, specular
  sweep, grain — so it paints on the first frame and weighs nothing.
- **No 3D.** Dropping Three.js took 1.3 MB off the critical path, which a phone on
  a slow connection feels immediately. A rotating object behind a balance was
  never helping anyone read it.
- **Green and red mean market direction and nothing else.** Nothing decorative is
  ever coloured, so a coloured number always means something.
- **Reveal once, one direction, slow out.** Elements rise as you reach them and do
  not replay. `prefers-reduced-motion` genuinely turns it off rather than speeding
  it up.

---

## Getting it running

See **[SETUP.md](SETUP.md)**. On a Hostinger plan it is: create a MySQL database,
push this branch, open `install.php`, add one cron line, backfill the chart, set
your UPI VPA, delete `install.php`.

---

## What this is not

Not registered with SEBI, the RBI, or any other financial regulator. ARV is not a
blockchain token, not transferable off this platform, not a share, not a deposit,
and not a unit of a mutual fund or collective investment scheme. There is no
capital protection, no insurance and no compensation scheme. Holding ARV is a
contractual claim on this platform for the rupee value of the units, and if the
business fails you are an unsecured creditor.

Bitcoin fell roughly 77% between November 2021 and November 2022. ARV would have
fallen with it, and the chart on the site shows exactly that. Nothing here is
investment, tax or legal advice.
