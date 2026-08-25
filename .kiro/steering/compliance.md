# arvcoin — Compliance Guardrails (READ BEFORE TOUCHING CALLS OR ARV CREDITS)

arvcoin is a **research/advisory delivery platform** (like Stoxpro / Waya) with access
paid via **ARV prepaid credits**.

Two subsystems, two very different rules. Do not mix them up.

---

## PART A — Calls / Research (permitted, but gated on registration)

Publishing buy/sell recommendations on securities **for a fee** requires SEBI registration
under the SEBI (Research Analysts) Regulations, 2014. The platform is built to be operated
by a registered entity.

**The gate:** `arv-config.js` exports `RA_REGISTRATION`. Until it holds a real registration
number, the publish path in `admin.js` refuses and the app runs in education-only mode.

- Populate it with **arvcoin's own RA number** once registered, **or** with the
  **partner RA/IA's number** under a revenue-share arrangement.
- Every published call stores and renders `raNumber` + `analystName`. This is a SEBI
  requirement, not decoration — registered apps display it on every call.
- Never bypass, stub, hardcode-true, or "temporarily disable" this gate.

**Required on every call (enforced by schema + UI):**

- `raNumber`, `analystName`, `publishedAt`
- Standard disclaimer block + "investments are subject to market risk"
- Rationale field must be non-empty — a bare tip with no research basis is not research

**Never, even when registered:**

- ❌ Guaranteed / assured / fixed returns, in any wording
- ❌ Accuracy or win-rate claims that aren't computed from the real, complete,
  unfiltered call history (no cherry-picking closed winners)
- ❌ Personalised advice without the suitability/risk-profiling that IA regulations
  require — RA registration covers **research**, not personalised advisory
- ❌ Deleting or editing a call after publish to hide a loss. Calls are append-only;
  corrections are new versions with an audit trail. Performance stats must include
  every call ever published.

**Forex — hard restriction regardless of registration:**

Residents may trade currency derivatives only in RBI-approved INR pairs on recognised
exchanges (NSE/BSE/MSE) via SEBI-registered brokers. Offshore/OTC retail forex violates
FEMA (penalties to 3× transaction value; platforms listed on RBI's Alert List).

- ❌ Never publish calls on offshore/OTC pairs, never link or normalise those platforms
- ✅ INR-pair exchange-traded currency derivatives only, with the FEMA warning shown

---

## PART B — ARV Credits (hard limits, no registration unlocks these)

ARV is a **closed-loop prepaid credit**. Fixed **1 ARV = ₹1**, set by the constant
`ARV_INR_RATE`. Redeemable only for arvcoin subscriptions.

**Never:**

- ❌ Make `ARV_INR_RATE` variable, admin-editable, time-based, or market-fetched
- ❌ Render an ARV **price** chart, a ₹ axis on ARV, candlesticks, or "ARV value" over time
- ❌ Tie ARV value to subscriber count, revenue, or platform growth
- ❌ Describe ARV as an investment, asset, token, coin, or share
- ❌ Imply or project that ARV appreciates
- ❌ Enable user-to-user transfer, resale, secondary market, or cash withdrawal
- ❌ Claim ARV is "backed by" founder investments, reserves, or any asset

An issuer-set price that the issuer raises at will, shown to paying users as their holding's
worth, is fabricated valuation — fraud by misrepresentation. Combined with "backed by my
investments" it is also unregulated deposit-taking under the BUDS Act, 2019 and a money
circulation scheme under the Prize Chits and Money Circulation Schemes (Banning) Act, 1978.
**No licence makes this lawful. It stays out, permanently.**

**The legitimate levers — these ARE founder-tunable, use them freely:**

| Lever | Config key | Effect |
|---|---|---|
| Bonus credits on purchase | `BONUS_TIERS` | More ARV per ₹ — real, fundable from own capital |
| Plan cost in ARV | `PLAN_PRICES` | Credits buy more/less access |
| Early-user rate lock | `FOUNDER_LOCK` | Early users keep old pricing permanently |
| Promo / referral credits | `PROMO_CREDITS` | Gifted access |

These change ARV's **purchasing power**, which is honest and disclosed, rather than
fabricating a market price. Founder generosity is unlimited here — fund it as desired.

**Growth chart:** `growth.js` charts platform activity only — subscribers, calls published,
community size. Never a ₹ axis, never labelled as ARV price or value.

---

## PART C — Enforced in code

- Access gating is **server-side** (Firestore rules / Cloud Functions). Client-side gating
  is decoration, not security.
- `wallets/{uid}`, `subscriptions/{uid}`, `ledger/*` are **never client-writable**.
  Credits are minted only by Cloud Functions after verified payment signature.
- Razorpay webhook signature must be verified server-side. Never trust a client
  "payment success" callback.
- `compliance-lint.js` blocks banned phrases (guaranteed returns, assured profit, etc.)
  before publish. Extend the wordlist; never weaken it.
- Calls are append-only with an audit trail.

---

## PART D — Open items for a professional, not a developer

- Securities lawyer / CS sign-off on all disclosures and terms
- **SEBI RA registration or a documented partner-RA agreement** — required before any
  call goes live to a paying user
- GST registration and correct rate on subscription revenue
- Refund policy, entity structure, grievance + ODR/SCORES flow
