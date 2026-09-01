/**
 * Shared Edge Function context.
 *
 * Two jobs:
 *
 *   1. Build the ARV_CONFIG object the ledger maths expects, from the database
 *      rather than from a hardcoded copy. `index_config` and `basket_config` are
 *      the server-side source of truth, so an operator changing a fee in the
 *      database changes what the functions actually charge — there is no second
 *      place to remember to edit.
 *
 *   2. Hand back both a service-role client (bypasses row level security, used
 *      for the writes that RLS forbids the browser) and the caller's identity
 *      (derived from their JWT, never from anything in the request body).
 *
 * The service role key is read from the environment and must never be sent to a
 * browser or committed. See SETUP.md.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export interface ArvConfig {
  BASKET: Array<{ key: string; name: string; weight: number; colour: string }>;
  WATCHLIST: Array<{ key: string; name: string; colour: string }>;
  INDEX: {
    quote: string;
    arvBaseInr: number;
    launchMs: number;
    baseUsd: Record<string, number>;
    baseFxUsdInr: number;
    priceDecimals: number;
    unitDecimals: number;
  };
  FEES: {
    entryPct: number; exitPct: number; gstPct: number; annualMgmtPct: number;
    minInvestPaise: number; minRedeemPaise: number; slippagePct: number;
  };
  TAX: {
    vdaGainPct: number; cessPct: number; tdsPct: number; tdsPctNoPan: number;
    tdsThresholdPaise: number; tdsThresholdSpecifiedPaise: number;
    allowLossSetOff: boolean; feesDeductible: boolean;
    costBasisMethod: string; fyStartMonth: number;
  };
  UI: { locale: string; currencySymbol: string };
}

export function admin(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in function secrets');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Resolve the caller from their bearer token. Never trust a user id in a body. */
export async function caller(req: Request): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Missing authorization header');

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const client = createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { authorization: `Bearer ${token}` } }
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) throw new HttpError(401, 'Not signed in');
  return { id: data.user.id, email: data.user.email ?? undefined };
}

export async function requireAdmin(db: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await db
    .from('profiles').select('is_admin').eq('id', userId).single();
  if (error) throw new HttpError(500, error.message);
  if (!data?.is_admin) throw new HttpError(403, 'This action is restricted to operator accounts');
}

/**
 * Load configuration from the database and shape it as the ledger expects.
 * Assigned to globalThis before the ledger module is imported, because that
 * module reads its rates from there.
 */
export async function loadConfig(db: SupabaseClient): Promise<ArvConfig> {
  const [{ data: idx, error: e1 }, { data: basket, error: e2 }] = await Promise.all([
    db.from('index_config').select('*').eq('id', 'only').single(),
    db.from('basket_config').select('*').order('weight', { ascending: false })
  ]);
  if (e1) throw new HttpError(500, 'index_config: ' + e1.message);
  if (e2) throw new HttpError(500, 'basket_config: ' + e2.message);

  const baseUsd: Record<string, number> = {};
  (basket ?? []).forEach((b) => { baseUsd[b.asset_key] = Number(b.base_price_usd); });

  const cfg: ArvConfig = {
    BASKET: (basket ?? []).filter((b) => b.is_basket).map((b) => ({
      key: b.asset_key, name: b.name, weight: Number(b.weight), colour: b.colour ?? ''
    })),
    WATCHLIST: (basket ?? []).filter((b) => !b.is_basket).map((b) => ({
      key: b.asset_key, name: b.name, colour: b.colour ?? ''
    })),
    INDEX: {
      quote: idx.quote,
      arvBaseInr: Number(idx.arv_base_inr),
      launchMs: Date.parse(idx.launch_at),
      baseUsd,
      baseFxUsdInr: Number(idx.base_fx_usd_inr),
      priceDecimals: 4,
      unitDecimals: 8
    },
    FEES: {
      entryPct: Number(idx.entry_fee_pct),
      exitPct: Number(idx.exit_fee_pct),
      gstPct: Number(idx.gst_pct),
      annualMgmtPct: 0,
      minInvestPaise: 10000,
      minRedeemPaise: 10000,
      slippagePct: 0.05
    },
    TAX: {
      vdaGainPct: Number(idx.vda_gain_pct),
      cessPct: Number(idx.cess_pct),
      tdsPct: Number(idx.tds_pct),
      tdsPctNoPan: 20,
      tdsThresholdPaise: 1000000,
      tdsThresholdSpecifiedPaise: 5000000,
      allowLossSetOff: false,
      feesDeductible: false,
      costBasisMethod: 'FIFO',
      fyStartMonth: 4
    },
    UI: { locale: 'en-IN', currencySymbol: '\u20b9' }
  };

  // The ledger module reads its rates from this global.
  (globalThis as Record<string, unknown>).ARV_CONFIG = cfg;
  return cfg;
}

/**
 * The ledger, loaded after config is in place.
 *
 * This is the same file the browser imports, imported here on purpose: the quote
 * a user is shown before confirming and the arithmetic that writes the ledger
 * come from one implementation. Two implementations of tax maths drift, and when
 * they do the user has agreed to a number the record disagrees with.
 */
export async function ledger() {
  return await import('../../../js/ledger.js');
}

export async function money() {
  return await import('../../../js/money.js');
}

/* ---------------------------------------------------------------- pricing --- */

/**
 * Current ARV price, server-side.
 *
 * Reads the most recent stored candle rather than calling an exchange. The
 * ingest worker is responsible for keeping that fresh; a trade must not depend
 * on a third-party API being reachable at the instant someone presses confirm,
 * and it must not be priceable at a stale number either — hence the age check.
 */
export async function currentNav(db: SupabaseClient, maxAgeMs = 10 * 60000): Promise<number> {
  const { data, error } = await db
    .from('arv_candles').select('ts,close')
    .eq('tf', '1m').order('ts', { ascending: false }).limit(1);

  if (error) throw new HttpError(500, 'price lookup failed: ' + error.message);
  if (!data?.length) {
    throw new HttpError(503, 'No price available yet. Run the ingest function first.');
  }

  const age = Date.now() - Date.parse(data[0].ts);
  if (age > maxAgeMs) {
    throw new HttpError(
      503,
      `The latest price is ${Math.round(age / 60000)} minutes old. ` +
      'Trading is paused until the feed catches up.'
    );
  }
  return Number(data[0].close);
}

/* ------------------------------------------------------------------ errors -- */

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS'
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' }
  });
}

export function fail(e: unknown): Response {
  const status = e instanceof HttpError ? e.status : 500;
  const message = e instanceof Error ? e.message : 'Unexpected error';
  if (status >= 500) console.error('[arv]', e);
  return json({ error: message }, status);
}

/** Audit every privileged action. Failures here must not fail the action. */
export async function audit(
  db: SupabaseClient,
  entry: { actor?: string; action: string; entity?: string; entityId?: string; after?: unknown }
): Promise<void> {
  try {
    await db.from('audit_log').insert({
      actor: entry.actor ?? null,
      action: entry.action,
      entity: entry.entity ?? null,
      entity_id: entry.entityId ?? null,
      after: entry.after ?? null
    });
  } catch (e) {
    console.error('[arv] audit write failed', e);
  }
}
