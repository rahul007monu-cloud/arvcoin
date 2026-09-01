/**
 * Price ingest worker. Runs every minute.
 *
 * Fetches a 1-minute candle for each basket asset, values it in rupees, computes
 * the ARV index candle, and appends it. Then rolls the minute data up into the
 * larger timeframes.
 *
 * Why this exists rather than computing in the browser
 * ---------------------------------------------------
 * Public exchange APIs hand back a few hundred candles per request and none of
 * them will serve twenty months of minute data. Computing the chart client-side
 * therefore caps ARV's minute history at whatever a single call returns, forever.
 *
 * Appending here instead means the series accumulates: after a month of uptime
 * there is a real month of ARV minute history, held locally, that no third party
 * can rate-limit or withdraw. It also means a trade can be priced from the
 * database rather than depending on an exchange being reachable at the instant
 * someone presses confirm.
 *
 * Deploy with --no-verify-jwt and drive it from pg_cron or an external scheduler.
 * See SETUP.md.
 */

import { admin, loadConfig, CORS, json, fail } from '../_shared/context.ts';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

/* ------------------------------------------------------------------ sources -- */

/**
 * Ordered by preference, tried until one answers.
 *
 * Regional blocks are the reason there are several: measured from a US egress
 * point Binance and Bybit both refuse outright while OKX, Coinbase and Kraken
 * answer. From elsewhere the pattern differs. A single hardcoded exchange means
 * the worker silently stops producing candles the day that exchange blocks the
 * region it runs in.
 */
const SOURCES: Array<{
  name: string;
  symbol: (key: string) => string;
  url: (sym: string, limit: number) => string;
  parse: (j: unknown) => Candle[];
}> = [
  {
    name: 'binance',
    symbol: (k) => k + 'USDT',
    url: (s, n) => `https://api.binance.com/api/v3/klines?symbol=${s}&interval=1m&limit=${n}`,
    parse: (j) => {
      if (!Array.isArray(j)) throw new Error('binance: blocked or unexpected shape');
      return (j as unknown[][]).map((k) => ({
        t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
      }));
    }
  },
  {
    name: 'okx',
    symbol: (k) => k + '-USDT',
    url: (s, n) => `https://www.okx.com/api/v5/market/candles?instId=${s}&bar=1m&limit=${n}`,
    parse: (j) => {
      const r = j as { code?: string; data?: string[][] };
      if (r.code !== '0' || !r.data) throw new Error('okx: bad payload');
      return r.data.map((k) => ({
        t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
      }));
    }
  },
  {
    name: 'coinbase',
    symbol: (k) => k + '-USD',
    url: (s) => `https://api.exchange.coinbase.com/products/${s}/candles?granularity=60`,
    parse: (j) => {
      if (!Array.isArray(j)) throw new Error('coinbase: bad payload');
      // Coinbase orders each row [time, low, high, open, close, volume].
      return (j as number[][]).map((k) => ({
        t: k[0] * 1000, o: k[3], h: k[2], l: k[1], c: k[4], v: k[5]
      }));
    }
  },
  {
    name: 'kraken',
    symbol: (k) => (k === 'BTC' ? 'XBTUSD' : k + 'USD'),
    url: (s) => `https://api.kraken.com/0/public/OHLC?pair=${s}&interval=1`,
    parse: (j) => {
      const r = j as { error?: unknown[]; result?: Record<string, unknown[][]> };
      if (r.error?.length || !r.result) throw new Error('kraken: bad payload');
      const key = Object.keys(r.result).find((k) => k !== 'last');
      if (!key) throw new Error('kraken: no series');
      return r.result[key].map((k) => ({
        t: Number(k[0]) * 1000, o: +String(k[1]), h: +String(k[2]),
        l: +String(k[3]), c: +String(k[4]), v: +String(k[6])
      }));
    }
  }
];

async function fetchCandles(assetKey: string, limit = 60): Promise<{ candles: Candle[]; source: string }> {
  const tried: string[] = [];
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url(src.symbol(assetKey), limit), {
        signal: AbortSignal.timeout(8000),
        headers: { accept: 'application/json' }
      });
      if (!res.ok) throw new Error(String(res.status));
      const candles = src.parse(await res.json());
      if (!candles.length) throw new Error('empty');
      candles.sort((a, b) => a.t - b.t);
      return { candles, source: src.name };
    } catch (e) {
      tried.push(`${src.name}(${e instanceof Error ? e.message.slice(0, 40) : '?'})`);
    }
  }
  throw new Error(`No source served ${assetKey}. Tried: ${tried.join(', ')}`);
}

/* ----------------------------------------------------------------------- fx -- */

/**
 * USD/INR for today, cached in the database.
 *
 * Stored per day because valuing historical candles needs the rate of that day,
 * not today's — applying one rate across months rewrites the currency move as if
 * it were a Bitcoin move.
 */
async function usdInr(db: SupabaseClient): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);

  const { data: cached } = await db
    .from('fx_rates').select('usd_inr').eq('day', today).maybeSingle();
  if (cached) return Number(cached.usd_inr);

  for (const url of [
    'https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR',
    'https://open.er-api.com/v6/latest/USD'
  ]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const j = await res.json() as { rates?: { INR?: number } };
      const rate = j.rates?.INR;
      if (rate && rate > 0) {
        await db.from('fx_rates').upsert({ day: today, usd_inr: rate, source: url });
        return rate;
      }
    } catch (_) { /* next source */ }
  }

  // Fall back to the most recent stored rate rather than inventing one.
  const { data: last } = await db.from('fx_rates')
    .select('usd_inr').order('day', { ascending: false }).limit(1);
  if (last?.length) return Number(last[0].usd_inr);

  throw new Error('No USD/INR rate available from any source or from cache');
}

/* -------------------------------------------------------------------- index -- */

function buildIndex(
  byKey: Record<string, Candle[]>,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  fx: number
): Candle[] {
  const basket = cfg.BASKET;
  if (!basket.length) return [];

  const maps: Record<string, Map<number, Candle>> = {};
  for (const a of basket) {
    maps[a.key] = new Map((byKey[a.key] ?? []).map((k) => [k.t, k]));
  }

  const primary = byKey[basket[0].key] ?? [];
  const out: Candle[] = [];

  for (const ref of primary) {
    let o = 0, h = 0, l = 0, c = 0, v = 0;
    let complete = true;

    for (const a of basket) {
      const k = maps[a.key].get(ref.t);
      const baseUsd = cfg.INDEX.baseUsd[a.key];
      if (!k || !baseUsd) { complete = false; break; }

      const baseQuote = cfg.INDEX.quote === 'INR' ? baseUsd * cfg.INDEX.baseFxUsdInr : baseUsd;
      const q = cfg.INDEX.quote === 'INR' ? fx : 1;
      const f = (a.weight * cfg.INDEX.arvBaseInr) / baseQuote;

      o += k.o * q * f;
      h += k.h * q * f;
      l += k.l * q * f;
      c += k.c * q * f;
      v += (k.v ?? 0) * a.weight;
    }

    if (complete && ref.t >= cfg.INDEX.launchMs) out.push({ t: ref.t, o, h, l, c, v });
  }

  return out;
}

/* ------------------------------------------------------------------ rollups -- */

const TF_MINUTES: Record<string, number> = {
  '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440, '1W': 10080
};

function bucketOf(t: number, tf: string): number {
  if (tf === '1W') {
    const d = new Date(t);
    const dow = (d.getUTCDay() + 6) % 7;          // Monday = 0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * 86400000;
  }
  const size = TF_MINUTES[tf] * 60000;
  return Math.floor(t / size) * size;
}

/**
 * Recompute the current bucket of each larger timeframe from stored 1m candles.
 *
 * Only the in-progress bucket is touched: completed buckets are already correct
 * and rewriting them every minute would be pointless load.
 */
async function rollup(db: SupabaseClient, source: string): Promise<Record<string, boolean>> {
  const done: Record<string, boolean> = {};

  for (const tf of Object.keys(TF_MINUTES)) {
    const from = bucketOf(Date.now(), tf);

    const { data, error } = await db.from('arv_candles')
      .select('ts,open,high,low,close,volume')
      .eq('tf', '1m')
      .gte('ts', new Date(from).toISOString())
      .order('ts', { ascending: true });

    if (error || !data?.length) { done[tf] = false; continue; }

    const open = Number(data[0].open);
    const close = Number(data[data.length - 1].close);
    let high = -Infinity, low = Infinity, vol = 0;
    for (const k of data) {
      high = Math.max(high, Number(k.high));
      low = Math.min(low, Number(k.low));
      vol += Number(k.volume);
    }

    const { error: upErr } = await db.from('arv_candles').upsert({
      tf, ts: new Date(from).toISOString(),
      open, high, low, close, volume: vol,
      is_final: false, source
    }, { onConflict: 'tf,ts' });

    done[tf] = !upErr;
  }

  return done;
}

/* ------------------------------------------------------------------- serve -- */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const started = Date.now();
  try {
    const db = admin();
    const cfg = await loadConfig(db);

    const all = [...cfg.BASKET.map((a) => a.key), ...cfg.WATCHLIST.map((a) => a.key)];
    const fx = await usdInr(db);

    const byKey: Record<string, Candle[]> = {};
    let source = 'unknown';
    const failed: string[] = [];

    for (const key of all) {
      try {
        const r = await fetchCandles(key, 60);
        byKey[key] = r.candles;
        source = r.source;

        // Keep the raw USD candles too. If the index definition ever changes,
        // history can be recomputed from these instead of being lost.
        await db.from('asset_candles').upsert(
          r.candles.map((k) => ({
            asset_key: key, tf: '1m', ts: new Date(k.t).toISOString(),
            open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v, source: r.source
          })),
          { onConflict: 'asset_key,tf,ts' }
        );
      } catch (e) {
        failed.push(key + ': ' + (e instanceof Error ? e.message : '?'));
      }
    }

    // Every basket asset is required. A partial basket would produce a
    // confidently wrong index value, which is worse than a gap in the series.
    const missing = cfg.BASKET.filter((a) => !byKey[a.key]);
    if (missing.length) {
      throw new Error('Missing basket data for ' + missing.map((a) => a.key).join(', ') +
                      '. ' + failed.join('; '));
    }

    const index = buildIndex(byKey, cfg, fx);
    if (!index.length) throw new Error('Index produced no candles');

    const { error: insErr } = await db.from('arv_candles').upsert(
      index.map((k) => ({
        tf: '1m', ts: new Date(k.t).toISOString(),
        open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v,
        fx_rate: fx, is_final: true, source
      })),
      { onConflict: 'tf,ts' }
    );
    if (insErr) throw new Error('arv_candles: ' + insErr.message);

    const rolled = await rollup(db, source);
    const latest = index[index.length - 1];

    return json({
      ok: true,
      source,
      fx,
      candlesWritten: index.length,
      latest: { ts: new Date(latest.t).toISOString(), close: latest.c },
      arvPrice: latest.c,
      rolledUp: rolled,
      watchlistFailures: failed.length ? failed : undefined,
      elapsedMs: Date.now() - started
    });
  } catch (e) {
    return fail(e);
  }
});
