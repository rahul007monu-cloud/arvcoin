# arvcoin — Market Research Desk

**Structured market research and investor education.** Stocks, F&O options, commodity
(gold, silver, copper, zinc, crude, natural gas, agri), currency (INR pairs) and crypto —
every note published with its rationale, and the full history kept public.

Live at **[arvcoin.com](https://arvcoin.com)**

---

## What this is

Three products in one:

| Product | Access | What it does |
|---|---|---|
| **Levels calculator** | Free, no login | Support, resistance, pivots and CPR for any instrument, from Classic / Fibonacci / Camarilla / Woodie formulas |
| **Levels analysis** | Free or subscriber | Computed levels plus an analyst's structural observation. No action, entry, target or stop-loss fields |
| **Research notes** | Subscriber, gated | Buy/sell recommendations with entry, targets, stop loss and rationale. Requires SEBI RA registration |

Plus daily market recaps and structured lessons.

---

## Tech

Deliberately simple — **no build step, no framework, no bundler.**

- **Frontend:** plain HTML, CSS and JavaScript. ES modules where a page needs them.
- **3D:** Three.js (r128, CDN) — a layered background field plus a rotating hero scene
- **Auth:** Firebase Authentication (email/password, Google, one-time email OTP via EmailJS)
- **Database:** Firestore, with all access gating enforced in `firestore.rules`
- **Payments:** Razorpay (order created and webhook verified server-side)
- **Hosting:** Hostinger, deployed automatically from `main` via its GitHub integration
- **PWA:** installable, with a service worker and offline shell

---

## Local development

No install required:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

Any static server works. Some features need config — see below.

---

## Configuration

All product configuration lives in **`arv-config.js`**. Nothing else needs editing for
day-to-day changes.

### SEBI RA registration

Gates the research-note publishing path. While `number` is empty, the app runs in
education mode (levels analysis, lessons and recaps only).

```js
var RA_REGISTRATION = {
  number:      "INH000021086",
  entityName:  "",   // required — exact entity name from the certificate
  analystName: "",   // required — principal analyst
  validTill:   ""    // required — "YYYY-MM-DD" or "Perpetual"
};
```

`missingRaFields()` surfaces any blanks in the admin panel.

### Plans and pricing

```js
PLAN_PRICES.pro.priceInr = 999;   // Basic 499 / Pro 999 / Elite 1999 / Quarterly 4999
```

Charges exclude GST (18%). No auto-renewal — access simply expires.

### Payments

```js
PAYMENTS.razorpayKeyId  = "rzp_live_...";   // public key only
PAYMENTS.createOrderUrl = "https://.../createOrder";
```

The secret key must never appear in this repo — it belongs in the Cloud Function
environment only.

### Firebase and email

- `firebase-config.js` — Firebase web SDK config. These values are public by design.
- `emailjs-config.js` — EmailJS keys for OTP delivery. Falls back to a DEMO mode that
  prints the code to the console when unset.

---

## Pages

| Page | File | Purpose |
|---|---|---|
| Landing | `index.html` | Positioning, segments, sample note, plans, FAQ |
| Levels calculator | `levels.html` | Free tool — S/R, pivots, CPR, momentum bias |
| Research feed | `calls.html` | Notes and analysis, gated by subscription |
| Dashboard | `dashboard.html` | Plan status, coverage, latest analysis, recaps, lessons |
| Publish | `admin.html` | Analyst panel — analysis, notes, lessons, recaps |
| Plans | `pricing.html` | Pricing, coverage matrix, segment detail |
| About | `about.html` | Positioning and compliance stance |
| Legal | `legal.html` | Disclosures, Terms, Privacy, Risk, Refund, Grievance |
| Auth | `login.html`, `signup.html`, `verify.html` | Sign in, sign up, one-time OTP |

---

## Deployment

`main` is wired to Hostinger through its GitHub integration — **merging to `main`
deploys the site.**

Two things do **not** deploy that way and must be run manually:

```bash
# 1. Firestore security rules — this is what actually enforces access gating
firebase deploy --only firestore:rules --project arvcoin

# 2. Grant a user analyst/admin access (Firebase Console has no UI for custom claims)
cd tools
npm install firebase-admin
node grant-admin.js you@email.com
```

After granting a claim, sign out and back in so the token refreshes.

> **Service worker:** bump `CACHE` in `sw.js` whenever assets change, and add any new
> file to its `ASSETS` list. Registration lives in `index.html` and `lux.js`.

---

## Architecture notes

**Access gating is server-side.** `firestore.rules` is the enforcement point; client-side
checks exist only for UX. A locked research note's detail never reaches the browser — the
query returns `permission-denied`, and public teasers come from a separate collection. The
blur in the UI is real, not cosmetic.

**Never client-writable:** `wallets`, `subscriptions`, `ledger`, `payments`. Subscriptions
are activated only by a Cloud Function after a verified Razorpay webhook signature.

**Notes are append-only.** Once published, a research note cannot be edited or deleted —
outcomes are recorded as revisions with an audit trail, so a losing note cannot be hidden.
Performance statistics count every note ever published.

**Schema as a compliance control.** The `analysis` collection has no `action`, `entry`,
`targets` or `stopLoss` fields, and `firestore.rules` explicitly rejects them. An analyst
cannot publish a recommendation through that path even by mistake.

**`compliance-lint.js`** blocks phrasing like "guaranteed returns", "sure shot" and
"assured profit" before anything publishes.

---

## Compliance

Publishing buy/sell recommendations on securities for a fee requires registration under
the SEBI (Research Analysts) Regulations, 2014. The registration gate in `arv-config.js`
enforces this in code.

Other constraints reflected in the product:

- **Currency:** RBI-approved INR pairs on recognised Indian exchanges only. Offshore and
  OTC forex breach FEMA, with penalties up to three times the transaction value.
- **Crypto:** outside SEBI's remit; taxed at 30% plus 1% TDS.
- **Fee cap:** SEBI caps research fees at ₹1,51,000 per year per family.
- **Disclosures:** the SEBI-mandated disclaimer, conflict-of-interest disclosure and
  standard research caution render on every note and across the legal pages.

Development guardrails are documented in `.kiro/steering/compliance.md`.

> This repository is software. It is not legal advice. Have a securities lawyer or Company
> Secretary review the disclosures, terms and refund policy before taking payments.

---

## Repository layout

```
arv-config.js          all product configuration
arv-core.js            Firebase data layer (auth, subscriptions, notes, analysis)
levels.js              levels maths — pivots, CPR, bias
compliance-lint.js     blocked-phrase filter
lux.css / lux.js       design system and interactions
3d.js                  Three.js background and hero scenes
firestore.rules        access gating — the real enforcement point
tools/grant-admin.js   grant analyst/admin custom claims
mobile/                Expo app (being migrated to the research product)
```

---

## Status

Working: levels calculator, levels analysis publishing, research feed with server-side
gating, admin panel, auth with one-time OTP, plans and legal pages, PWA install.

In progress: Cloud Functions for Razorpay orders and webhooks; the Expo mobile app still
carries the previous product's flow.
