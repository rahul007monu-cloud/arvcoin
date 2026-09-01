# Setup

Two modes. Local needs nothing; hosted needs a Supabase project.

---

## 1. Local, no backend

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`. With `SUPABASE.url` blank in `arv-config.js` the app
runs entirely in the browser:

- ✅ live prices from real exchanges, real candles, the full 3D scene
- ✅ the complete fee, FIFO and tax engine — every number is genuinely computed
- ✅ working buy and redeem flows against `localStorage`
- ❌ nothing persists past a cleared cache, and it is one browser only

Good for evaluating the product. Not a deployment.

> Local mode necessarily runs the ledger client-side, which is exactly what row
> level security exists to prevent in the hosted setup. Do not treat it as a
> production path.

---

## 2. Hosted, with Supabase

### 2.1 Create the project

[supabase.com](https://supabase.com) → new project. From **Settings → API** take:

- Project URL — `https://xxxxx.supabase.co`
- `anon` **public** key
- `service_role` key — **secret**

### 2.2 Configure the front end

In `arv-config.js`:

```js
var SUPABASE = {
  url:     'https://xxxxx.supabase.co',
  anonKey: 'eyJhbGciOi...',      // the anon key, public by design
  functionsBase: ''              // leave blank
};
```

> The `anon` key belongs in the browser — it is safe there because every table is
> guarded by RLS. The **`service_role` key must never appear in this repo, in
> `arv-config.js`, or anywhere a browser can reach.** It bypasses RLS entirely. It
> goes only into function secrets, below.

### 2.3 Apply the schema

Supabase dashboard → **SQL Editor** → paste all of
`supabase/migrations/0001_init.sql` → Run.

Or with the CLI:

```bash
npm install -g supabase
supabase link --project-ref xxxxx
supabase db push
```

This creates the tables, row level security policies, the append-only trigger on
`transactions`, the privilege-escalation guards on `profiles`, the signup hook and
the reporting views. It is idempotent — safe to re-run.

**Verify it took effect.** In the SQL editor:

```sql
select tablename, rowsecurity from pg_tables
where schemaname = 'public' order by tablename;
```

Every table must show `rowsecurity = true`. If any does not, stop and fix it — that
table is world-writable.

### 2.4 Deploy the functions

```bash
supabase secrets set SUPABASE_URL=https://xxxxx.supabase.co
supabase secrets set SUPABASE_ANON_KEY=eyJhbGciOi...
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...   # secret

supabase functions deploy trade
supabase functions deploy ingest --no-verify-jwt
supabase functions deploy backfill
```

`ingest` is deployed with `--no-verify-jwt` because a scheduler calls it, not a
signed-in user. `trade` and `backfill` verify the caller's JWT and re-check
operator authority against the database.

> **If the bundler cannot resolve `../../../js/ledger.js`:** the functions import
> the ledger maths from the front-end tree on purpose, so the quote a user sees and
> the arithmetic that writes the ledger are one implementation. If your CLI version
> refuses to bundle outside `supabase/functions/`, copy the two files in and adjust
> the import:
>
> ```bash
> mkdir -p supabase/functions/_shared/lib
> cp js/ledger.js js/money.js supabase/functions/_shared/lib/
> # then in _shared/context.ts change the two import paths to './lib/…'
> ```
>
> If you do this, re-copy them whenever `js/ledger.js` changes. Divergence between
> the two copies means users agree to numbers the ledger disagrees with.

### 2.5 Grant yourself operator access

Sign up through the app first, then in the SQL editor:

```sql
update public.profiles set is_admin = true where email = 'you@example.com';
```

There is no UI for this by design — a user cannot grant themselves `is_admin`, and
the trigger blocks the attempt.

### 2.6 Start the price feed

**Backfill history once.** From the app, signed in as an operator, or by curl with
your access token:

```bash
TOKEN='<your access_token from the browser session>'
BASE='https://xxxxx.supabase.co/functions/v1'

curl -s -X POST "$BASE/backfill" -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"tf":"1D"}'
curl -s -X POST "$BASE/backfill" -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"tf":"1h","days":90}'
curl -s -X POST "$BASE/backfill" -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"tf":"1m","days":7}'
```

Run them one at a time — each paces its own requests to avoid being rate-limited,
so the daily one takes a couple of minutes.

**Then schedule `ingest` every minute.** In the SQL editor:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'arv-ingest',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://xxxxx.supabase.co/functions/v1/ingest',
    headers := '{"content-type":"application/json"}'::jsonb
  );
  $$
);
```

Any external scheduler works too — GitHub Actions on a cron, cron-job.org,
Cloudflare Workers. It just needs to POST to `/functions/v1/ingest` once a minute.

**Confirm it is running:**

```sql
select tf, count(*), max(ts) as latest
from public.arv_candles group by tf order by tf;
```

`latest` for `1m` should be within the last minute or two. **Trading is paused
while the newest price is more than 10 minutes old** — deliberately, so nothing
executes at a stale number. If `ingest` stops, buys and redemptions stop.

---

## 3. Payments

### 3.1 Configure UPI

```js
var PAYMENTS = {
  vpa:        'yourname@okhdfcbank',   // your real UPI ID
  payeeName:  'ARV Coin',
  merchantCode: '',
  settlementHours: 24
};
```

With `vpa` set, the buy screen generates a real scannable UPI intent QR with the
amount pre-filled, plus a deep link that opens the UPI app directly on mobile.
Leave it blank and a clearly-marked placeholder is shown instead.

### 3.2 How confirmation works, and why

**A UPI QR cannot tell the app that money arrived.** It carries a request one way
and returns nothing — no callback, no signature, nothing to verify. So:

1. `create_deposit` records the intent and issues **nothing**
2. money lands in your bank account
3. an operator confirms it in `admin.html`
4. units are issued at the price **at that moment**, not when the QR was shown

Step 3 is manual because with a bare UPI QR there is nothing to automate against.
To automate it, use a PSP that signs webhooks (Razorpay, Cashfree, PhonePe
business), verify the signature server-side inside the `trade` function, and call
the same `confirm_deposit` path.

> **Never wire a client-side "payment succeeded" callback to issue units.** It is
> the single most reliable way to have a treasury emptied by someone who never paid.

### 3.3 Payouts

Redemptions queue in `payouts` with the amount already net of exit fee, GST and
TDS. `admin.html` lists them with the holder's UPI ID and a scannable QR so the
payout can be sent without retyping the amount. Mark them paid once sent.

---

## 4. Operating it

### Daily: reconcile

Open `admin.html`. It computes the Bitcoin the treasury must hold — units
outstanding × NAV ÷ Bitcoin's rupee price — and you enter what is actually held.

Any gap is tracking error, and it is funded by whoever redeems last. Under 0.5% is
normal execution drift. Anything larger needs correcting before the next
redemption. This compounds silently if left alone.

### Monthly and quarterly

- **TDS deposited.** `admin.html` shows TDS withheld under s.194S. It is not
  revenue — it is holders' money that must be deposited with the department and
  reported so it appears in each holder's Form 26AS.
- **GST on fees.** Also a liability, not income.
- **Ledger check.** `select * from public.treasury_summary;`

### When assets change

Bump `CACHE` in `sw.js` and add any new file to its `ASSETS` list, or returning
users keep the old shell from cache.

---

## 5. Deploying the front end

Static files — any host works.

**Hostinger** (what this repo was previously wired to): merging to `main` deploys.
Check that first if the repo has a GitHub integration attached.

**Netlify / Vercel / Cloudflare Pages:** no build command, publish directory `.`.

**Supabase Storage / S3 / GitHub Pages:** upload as-is.

Requirements: serve over **HTTPS** (the service worker and WebSockets need it), and
serve `.js` as `text/javascript` — some hosts default `.mjs` or ES modules wrongly
and the browser then refuses the module.

---

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| Price shows `—` forever | Every exchange blocked from that network. Check the feed indicator in the footer — it names the source it settled on. Reorder `FEED.sources`. |
| "No market data source reachable" | Same, with all sources exhausted. Binance and Bybit block many regions. |
| Chart empty on 1m but fine on 1D | `ingest` is not running, or backfill for `1m` was never done. |
| "Trading is paused… price is N minutes old" | `ingest` has stopped. Working as intended — check the cron job. |
| "No price available yet" on a trade | Backfill and ingest have not run. Do §2.6. |
| QR shows "UPI not configured" | `PAYMENTS.vpa` is empty. |
| Confirm button missing on buy | Account is not an operator. Do §2.5. |
| `admin.html` says "Not authorised" | Same. |
| Units issued at a different price than quoted | Correct behaviour. Issuance uses the confirmation-time price. |
| `permission denied for table holdings` | Correct behaviour — browsers cannot write holdings. The write must go through the `trade` function. |
| Signup succeeds but sign-in fails | Email confirmation is on in Supabase Auth. Confirm the address or turn it off for testing. |
| Google sign-in fails | Configure the Google provider in Supabase Auth and add your redirect URL. |
| Helix not rendering | No WebGL, or `prefers-reduced-motion` is set. The CSS gradient fallback is expected. |
| Old version after deploy | `CACHE` in `sw.js` was not bumped. |
