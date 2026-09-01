-- ============================================================================
-- ARV Coin — initial schema
-- ============================================================================
--
-- Conventions that hold across every table:
--
--   Money is BIGINT paise. Never float, never NUMERIC-with-2dp, never "rupees".
--   A float rupee column will eventually produce a ledger that does not
--   balance, and in a financial product that is not a rounding bug.
--
--   ARV units are NUMERIC(28,8). Exact decimal, so the database is the source
--   of truth and JavaScript rounding can never drift away from it.
--
--   Prices are NUMERIC(20,8).
--
--   Anything a user must not be able to forge — holdings, lots, transactions,
--   tax — is readable by its owner and writable by nobody. Not "writable by the
--   owner with a check constraint": writable by nobody. Every mutation goes
--   through an Edge Function holding the service role key. A browser that can
--   write its own balance is a browser that will.
--
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. Profiles
-- ============================================================================

create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text,
  full_name       text,

  -- PAN drives the TDS rate. Without it s.206AA applies a higher rate, so this
  -- is a tax-relevant field, not a nicety.
  pan             text,
  pan_verified    boolean not null default false,

  -- Redemptions pay out here.
  upi_vpa         text,

  kyc_status      text not null default 'none'
                  check (kyc_status in ('none','pending','verified','rejected')),

  -- s.194S sets a higher TDS threshold for "specified persons".
  is_specified_person boolean not null default false,

  is_admin        boolean not null default false,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on column public.profiles.is_admin is
  'Checked by Edge Functions before any privileged action. Never trusted from the client.';

-- ============================================================================
-- 2. Basket configuration
-- ============================================================================
-- Mirrors arv-config.js so server-side code computes the identical index
-- without importing browser JavaScript. The two must agree; the admin panel
-- surfaces any drift between them.

create table if not exists public.basket_config (
  asset_key       text primary key,
  name            text not null,
  weight          numeric(10,8) not null check (weight >= 0 and weight <= 1),
  base_price_usd  numeric(20,8) not null check (base_price_usd > 0),
  is_basket       boolean not null default true,   -- false = watchlist only
  colour          text,
  updated_at      timestamptz not null default now()
);

-- A one-row configuration table. The domain enforces that rather than trusting
-- application code to only ever insert one row.
do $$ begin
  create domain singleton as text check (value = 'only');
exception when duplicate_object then null;
end $$;

create table if not exists public.index_config (
  id                singleton primary key default 'only',
  arv_base_inr      numeric(20,8) not null default 1.0,
  launch_at         timestamptz not null default '2025-01-01T00:00:00Z',
  base_fx_usd_inr   numeric(20,8) not null default 85.60,
  quote             text not null default 'INR' check (quote in ('INR','USD')),
  entry_fee_pct     numeric(6,4) not null default 0.5,
  exit_fee_pct      numeric(6,4) not null default 0.5,
  gst_pct           numeric(6,4) not null default 18,
  vda_gain_pct      numeric(6,4) not null default 30,
  cess_pct          numeric(6,4) not null default 4,
  tds_pct           numeric(6,4) not null default 1,
  updated_at        timestamptz not null default now()
);

-- ============================================================================
-- 3. Market data
-- ============================================================================

-- Raw per-asset candles in USD, exactly as the exchange served them.
create table if not exists public.asset_candles (
  asset_key   text not null,
  tf          text not null,
  ts          timestamptz not null,
  open        numeric(20,8) not null,
  high        numeric(20,8) not null,
  low         numeric(20,8) not null,
  close       numeric(20,8) not null,
  volume      numeric(28,8) not null default 0,
  source      text,
  primary key (asset_key, tf, ts)
);

-- Daily USD/INR. Kept because valuing historical candles in rupees needs the
-- rate *of that day*; applying today's rate to old candles silently rewrites
-- the currency move as if it were a Bitcoin move.
create table if not exists public.fx_rates (
  day         date primary key,
  usd_inr     numeric(20,8) not null check (usd_inr > 0),
  source      text,
  created_at  timestamptz not null default now()
);

-- The computed ARV index.
--
-- This is the table that makes the product independent of any exchange's
-- history limits. Public APIs hand back a few hundred candles at a time and
-- nothing will serve 20 months of minute data — so the ingest worker appends
-- here every minute and the series grows on its own. After a month of uptime
-- there is a real month of ARV minute history that no third party can revoke.
create table if not exists public.arv_candles (
  tf          text not null,
  ts          timestamptz not null,
  open        numeric(20,8) not null,
  high        numeric(20,8) not null,
  low         numeric(20,8) not null,
  close       numeric(20,8) not null,
  volume      numeric(28,8) not null default 0,
  fx_rate     numeric(20,8),
  is_final    boolean not null default true,
  source      text,
  primary key (tf, ts)
);

create index if not exists arv_candles_tf_ts_desc on public.arv_candles (tf, ts desc);
create index if not exists asset_candles_lookup on public.asset_candles (asset_key, tf, ts desc);

-- ============================================================================
-- 4. Holdings and cost basis
-- ============================================================================

create table if not exists public.holdings (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  units           numeric(28,8) not null default 0 check (units >= 0),
  invested_paise  bigint not null default 0 check (invested_paise >= 0),
  -- Realised P&L is kept separately from cost basis so the two are never
  -- conflated when computing tax.
  realised_gain_paise bigint not null default 0,
  updated_at      timestamptz not null default now()
);

-- FIFO lots. Each deposit creates one; each redemption consumes the oldest
-- open lots first. s.115BBH allows only cost of acquisition as a deduction,
-- so the lot's cost is the *net invested* amount and nothing else.
create table if not exists public.lots (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  units           numeric(28,8) not null check (units > 0),
  units_remaining numeric(28,8) not null check (units_remaining >= 0),
  cost_paise      bigint not null check (cost_paise >= 0),
  nav             numeric(20,8) not null,
  acquired_at     timestamptz not null default now(),
  txn_id          uuid,
  constraint lots_remaining_le_units check (units_remaining <= units)
);

create index if not exists lots_fifo on public.lots (user_id, acquired_at)
  where units_remaining > 0;

-- ============================================================================
-- 5. Transactions — append-only
-- ============================================================================
--
-- Every movement of money or units lands here once and is never edited. A
-- correction is a new compensating row, not an UPDATE. Enforced by trigger
-- below, not by convention, because conventions do not survive a bad afternoon.

create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  ref             text unique not null,

  type            text not null check (type in (
                    'deposit','redeem','fee_reversal','adjustment','rebalance'
                  )),
  status          text not null default 'pending' check (status in (
                    'pending','awaiting_payment','confirmed','settled','failed','cancelled'
                  )),

  -- Amounts. All BIGINT paise. Signed from the user's perspective:
  -- gross_paise is what they hand over on a deposit, what they are owed on a redeem.
  gross_paise     bigint not null default 0,
  fee_paise       bigint not null default 0,
  gst_paise       bigint not null default 0,
  tds_paise       bigint not null default 0,
  net_paise       bigint not null default 0,

  units           numeric(28,8) not null default 0,
  nav             numeric(20,8),
  slippage_pct    numeric(8,4) not null default 0,

  -- Tax, computed at redemption. Cost basis is the FIFO lots consumed.
  cost_basis_paise    bigint,
  realised_gain_paise bigint,
  tax_paise           bigint,     -- 30% + cess. NOT withheld — user's own liability.
  cess_paise          bigint,

  fy              text,           -- '2025-26'
  upi_ref          text,
  upi_vpa          text,
  note            text,
  meta            jsonb not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz,
  settled_at      timestamptz
);

create index if not exists txn_user_time on public.transactions (user_id, created_at desc);
create index if not exists txn_status on public.transactions (status) where status in ('pending','awaiting_payment');
create index if not exists txn_fy on public.transactions (user_id, fy);

-- Append-only enforcement.
--
-- Status has to be able to advance (pending -> confirmed -> settled), so a
-- blanket UPDATE ban is too strict. Instead: financial columns are frozen the
-- moment a row exists, status may only move forward, and DELETE is impossible
-- for everyone including the service role.

create or replace function public.txn_guard()
returns trigger language plpgsql as $$
declare
  ordering constant text[] := array['pending','awaiting_payment','confirmed','settled','failed','cancelled'];
begin
  if (tg_op = 'DELETE') then
    raise exception 'transactions are append-only: DELETE is not permitted (ref %)', old.ref;
  end if;

  if (tg_op = 'UPDATE') then
    if new.id <> old.id or new.user_id <> old.user_id or new.ref <> old.ref
       or new.type <> old.type
       or new.gross_paise <> old.gross_paise
       or new.fee_paise <> old.fee_paise
       or new.gst_paise <> old.gst_paise
       or new.tds_paise <> old.tds_paise
       or new.net_paise <> old.net_paise
       or new.units <> old.units
       or coalesce(new.nav, -1) <> coalesce(old.nav, -1)
       or coalesce(new.cost_basis_paise, -1) <> coalesce(old.cost_basis_paise, -1)
       or coalesce(new.realised_gain_paise, -1) <> coalesce(old.realised_gain_paise, -1)
       or coalesce(new.tax_paise, -1) <> coalesce(old.tax_paise, -1)
       or new.created_at <> old.created_at
    then
      raise exception
        'transactions are append-only: financial fields of % cannot be modified. Post a compensating row instead.',
        old.ref;
    end if;

    if array_position(ordering, new.status) < array_position(ordering, old.status) then
      raise exception 'status cannot move backwards (% -> %) for %', old.status, new.status, old.ref;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists txn_guard_trg on public.transactions;
create trigger txn_guard_trg
  before update or delete on public.transactions
  for each row execute function public.txn_guard();

-- ============================================================================
-- 6. Tax ledger
-- ============================================================================
--
-- One row per user per financial year. Two numbers that must never be blurred:
--
--   tds_paise  — 1% under s.194S, actually withheld at redemption. Money the
--                user did not receive.
--   tax_paise  — 30% + 4% cess under s.115BBH, NOT withheld here. The user's
--                own liability at filing time. This app reports it; it does
--                not collect it.
--
-- Losses are tracked but deliberately never netted against gains: s.115BBH
-- permits no set-off and no carry-forward.

create table if not exists public.tax_ledger (
  user_id             uuid not null references auth.users(id) on delete cascade,
  fy                  text not null,
  gross_proceeds_paise bigint not null default 0,
  cost_basis_paise    bigint not null default 0,
  realised_gain_paise bigint not null default 0,   -- gains only
  realised_loss_paise bigint not null default 0,   -- recorded, never offset
  tax_paise           bigint not null default 0,
  cess_paise          bigint not null default 0,
  tds_withheld_paise  bigint not null default 0,
  fees_paise          bigint not null default 0,   -- not deductible; informational
  txn_count           integer not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (user_id, fy)
);

-- ============================================================================
-- 7. Deposits and payouts
-- ============================================================================
--
-- A UPI QR cannot tell the application whether money arrived. There is no
-- callback, no signature, nothing to verify. So a deposit is created as
-- awaiting_payment and only an operator (or a real PSP webhook, later) moves it
-- forward. Units are minted at the NAV of the *confirmation* moment, not the
-- QR-generation moment, because that is when the treasury can actually buy.

create table if not exists public.deposits (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  txn_id        uuid references public.transactions(id),
  ref           text unique not null,
  amount_paise  bigint not null check (amount_paise > 0),
  status        text not null default 'awaiting_payment' check (status in (
                  'awaiting_payment','confirmed','expired','rejected'
                )),
  upi_ref       text,
  qr_payload    text,
  confirmed_by  uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  confirmed_at  timestamptz
);

create table if not exists public.payouts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  txn_id        uuid references public.transactions(id),
  ref           text unique not null,
  amount_paise  bigint not null check (amount_paise > 0),
  upi_vpa       text not null,
  status        text not null default 'pending' check (status in (
                  'pending','processing','paid','failed'
                )),
  upi_ref       text,
  paid_by       uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);

-- ============================================================================
-- 8. Limit orders and alerts
-- ============================================================================
--
-- ARV has no order book — there is no counterparty, units are issued and
-- redeemed against NAV. A limit order here is therefore a NAV trigger, not a
-- resting bid: "when ARV reaches ₹1.20, redeem". Honest version of the feature.

create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  side          text not null check (side in ('buy','sell')),
  trigger_nav   numeric(20,8) not null check (trigger_nav > 0),
  direction     text not null check (direction in ('at_or_above','at_or_below')),
  amount_paise  bigint,           -- for buys
  units         numeric(28,8),    -- for sells
  status        text not null default 'open' check (status in (
                  'open','triggered','filled','cancelled','expired'
                )),
  txn_id        uuid references public.transactions(id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  triggered_at  timestamptz
);

create index if not exists orders_open on public.orders (status, trigger_nav) where status = 'open';

create table if not exists public.alerts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  trigger_nav   numeric(20,8) not null,
  direction     text not null check (direction in ('at_or_above','at_or_below')),
  active        boolean not null default true,
  fired_at      timestamptz,
  created_at    timestamptz not null default now()
);

-- ============================================================================
-- 9. Audit log
-- ============================================================================

create table if not exists public.audit_log (
  id          bigserial primary key,
  actor       uuid references auth.users(id),
  action      text not null,
  entity      text,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);

create index if not exists audit_time on public.audit_log (created_at desc);

-- ============================================================================
-- 10. Row Level Security
-- ============================================================================
--
-- Read your own rows. Write nothing. Market data is world-readable because it
-- is public information and the charts need it before login.
--
-- Note what is absent: there is no INSERT or UPDATE policy on holdings, lots,
-- transactions or tax_ledger for authenticated users. With RLS enabled and no
-- permissive policy, those operations are denied. The service role bypasses RLS
-- entirely, which is why every mutation lives in an Edge Function.

alter table public.profiles       enable row level security;
alter table public.holdings       enable row level security;
alter table public.lots           enable row level security;
alter table public.transactions   enable row level security;
alter table public.tax_ledger     enable row level security;
alter table public.deposits       enable row level security;
alter table public.payouts        enable row level security;
alter table public.orders         enable row level security;
alter table public.alerts         enable row level security;
alter table public.arv_candles    enable row level security;
alter table public.asset_candles  enable row level security;
alter table public.fx_rates       enable row level security;
alter table public.basket_config  enable row level security;
alter table public.index_config   enable row level security;
alter table public.audit_log      enable row level security;

-- Profiles: readable and updatable by their owner, but only the safe columns.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

-- A user must not be able to grant themselves admin, verify their own PAN, or
-- reclassify themselves out of a TDS threshold. Column-level protection.
create or replace function public.profile_guard()
returns trigger language plpgsql as $$
begin
  if auth.role() = 'service_role' then return new; end if;
  if new.is_admin <> old.is_admin then
    raise exception 'is_admin cannot be changed by the account holder';
  end if;
  if new.pan_verified <> old.pan_verified then
    raise exception 'pan_verified is set by verification, not by the account holder';
  end if;
  if new.is_specified_person <> old.is_specified_person then
    raise exception 'is_specified_person affects the TDS threshold and is set server-side';
  end if;
  if new.kyc_status <> old.kyc_status and new.kyc_status <> 'pending' then
    raise exception 'kyc_status is set by verification, not by the account holder';
  end if;
  return new;
end $$;

drop trigger if exists profile_guard_trg on public.profiles;
create trigger profile_guard_trg
  before update on public.profiles
  for each row execute function public.profile_guard();

-- Read-only, owner-scoped.
drop policy if exists holdings_select_own on public.holdings;
create policy holdings_select_own on public.holdings
  for select using (auth.uid() = user_id);

drop policy if exists lots_select_own on public.lots;
create policy lots_select_own on public.lots
  for select using (auth.uid() = user_id);

drop policy if exists txn_select_own on public.transactions;
create policy txn_select_own on public.transactions
  for select using (auth.uid() = user_id);

drop policy if exists tax_select_own on public.tax_ledger;
create policy tax_select_own on public.tax_ledger
  for select using (auth.uid() = user_id);

drop policy if exists deposits_select_own on public.deposits;
create policy deposits_select_own on public.deposits
  for select using (auth.uid() = user_id);

drop policy if exists payouts_select_own on public.payouts;
create policy payouts_select_own on public.payouts
  for select using (auth.uid() = user_id);

-- Orders and alerts are user intent, not money, so they may be created and
-- cancelled client-side. Execution still happens server-side.
drop policy if exists orders_select_own on public.orders;
create policy orders_select_own on public.orders
  for select using (auth.uid() = user_id);

drop policy if exists orders_insert_own on public.orders;
create policy orders_insert_own on public.orders
  for insert with check (auth.uid() = user_id and status = 'open');

drop policy if exists orders_cancel_own on public.orders;
create policy orders_cancel_own on public.orders
  for update using (auth.uid() = user_id and status = 'open')
  with check (auth.uid() = user_id and status in ('open','cancelled'));

drop policy if exists alerts_all_own on public.alerts;
create policy alerts_all_own on public.alerts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Market data and config: public read.
drop policy if exists arv_candles_read on public.arv_candles;
create policy arv_candles_read on public.arv_candles for select using (true);

drop policy if exists asset_candles_read on public.asset_candles;
create policy asset_candles_read on public.asset_candles for select using (true);

drop policy if exists fx_read on public.fx_rates;
create policy fx_read on public.fx_rates for select using (true);

drop policy if exists basket_read on public.basket_config;
create policy basket_read on public.basket_config for select using (true);

drop policy if exists index_read on public.index_config;
create policy index_read on public.index_config for select using (true);

-- audit_log: no policy at all. Service role only, in both directions.

-- ============================================================================
-- 11. Signup hook
-- ============================================================================

create or replace function public.on_auth_user_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;

  insert into public.holdings (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created_trg on auth.users;
create trigger on_auth_user_created_trg
  after insert on auth.users
  for each row execute function public.on_auth_user_created();

-- ============================================================================
-- 12. Reporting views
-- ============================================================================

-- Latest ARV close per timeframe.
create or replace view public.arv_latest as
select distinct on (tf) tf, ts, close, open, high, low, volume
from public.arv_candles
order by tf, ts desc;

-- Treasury position: what the fund owes its unit holders in aggregate.
--
-- The reconciliation view the operator actually needs. This says how many units
-- exist and what was paid in; comparing that against the Bitcoin actually held
-- is the check that catches a drifting treasury before the users do.
create or replace view public.treasury_summary as
select
  (select coalesce(sum(units), 0) from public.holdings)          as units_outstanding,
  (select coalesce(sum(invested_paise), 0) from public.holdings) as net_invested_paise,
  (select close from public.arv_latest where tf = '1m'
     order by ts desc limit 1)                                   as latest_nav,
  (select count(*) from public.holdings where units > 0)         as holder_count,
  (select coalesce(sum(fee_paise + gst_paise), 0)
     from public.transactions where status in ('confirmed','settled')) as fees_collected_paise,
  (select coalesce(sum(tds_paise), 0)
     from public.transactions where status in ('confirmed','settled')) as tds_withheld_paise;

-- ============================================================================
-- 13. Seed
-- ============================================================================
-- Matches arv-config.js. BTC's base is the real 2025-01-01 00:00 UTC daily open
-- and the FX base is the published USD/INR reference for that date.

insert into public.index_config (id) values ('only') on conflict (id) do nothing;

insert into public.basket_config (asset_key, name, weight, base_price_usd, is_basket, colour)
values
  ('BTC', 'Bitcoin',  1.0, 93347.59, true,  '#f7931a'),
  ('ETH', 'Ethereum', 0.0, 3337.00,  false, '#8a92b2'),
  ('SOL', 'Solana',   0.0, 190.00,   false, '#14f195')
on conflict (asset_key) do nothing;

insert into public.fx_rates (day, usd_inr, source)
values ('2024-12-31', 85.60, 'frankfurter')
on conflict (day) do nothing;
