/**
 * History backfill. Run once after setup, then whenever a gap needs filling.
 *
 * Tiered by design, because no free API will hand over twenty months of minute
 * candles and no chart needs them at that depth:
 *
 *   1D  from launch      — the long view
 *   1h  last ~90 days    — the medium view
 *   1m  last ~7 days     — the trading view
 *
 * Minute history then deepens on its own as the ingest worker runs, so this only
 * has to produce a usable starting point rather than a complete one.
 *
 * Historical rupee valuation uses the USD/INR rate *of each day*. Applying
 * today's rate across the whole period would fold the entire currency move of
 * the period into the chart as though it were a Bitcoin move — the further back
 * you look, the more wrong the number gets.
 *
 * POST { tf?: '1D'|'1h'|'1m', days?: number }
 * Operator-only, and deliberately slow: it paces its requests rather than
 * getting itself rate-limited into a half-finished series.
 */

import {
  admin, caller, requireAdmin, loadConfig, CORS, json, fail, audit
} from '../_shared/context.ts';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

const DEFAULTS: Record<string, number | null> = { '1D': null, '1h': 90, '1m': 7 };

/* ------------------------------------------------------------------ sources -- */

/**
 * Only sources that can page backwards are useful here.
 *
 * OKX exposes history-candles with `after`, which despite the name means "older
 * than this timestamp". Coinbase takes an explicit start/end window. Kraken is
 * omitted on purpose: it only offers `since` as a lower bound and always returns
 * the most recent window from there, so it cannot walk into deep history.
 */
const PAGERS = [
  {
    name: 'okx',
    max: 100,
    tf: { '1m': '1m', '1h': '1H', '4h': '4H', '1D': '1D' } as Record<string, string>,
    async fetch(key: string, tf: string, endMs: number): Promise<Candle[]> {
      const inst = key + '-USDT';
      const url = `https://www.okx.com/api/v5/market/history-candles` +
                  `?instId=${inst}&bar=${this.tf[tf]}&after=${endMs}&limit=${this.max}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json() as { code?: string; data?: string[][] };
      if (j.code !== '0' || !j.data) throw new Error('bad payload');
      return j.data.map((k) => ({
        t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
      })).sort((a, b) => a.t - b.t);
    }
  },
  {
    name: 'coinbase',
    max: 300,
    gran: { '1m': 60, '1h': 3600, '1D': 86400 } as Record<string, number>,
    async fetch(key: string, tf: string, endMs: number): Promise<Candle[]> {
      const g = this.gran[tf];
      if (!g) throw new Error('unsupported timeframe');
      const start = endMs - this.max * g * 1000;
      const url = `https://api.exchange.coinbase.com/products/${key}-USD/candles` +
                  `?granularity=${g}&start=${new Date(start).toISOString()}` +
                  `&end=${new Date(endMs).toISOString()}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      if (!Array.isArray(j)) throw new Error('bad payload');
      // [time, low, high, open, close, volume]
      return (j as number[][]).map((k) => ({
        t: k[0] * 1000, o: k[3], h: k[2], l: k[1], c: k[4], v: k[5]
      })).sort((a, b) => a.t - b.t);
    }
  }
];

async function pageBack(key: string, tf: string, fromMs: number, toMs: number) {
  for (const pager of PAGERS) {
    const acc = new Map<number, Candle>();
    let end = toMs;
    let guard = 0;
    let ok = false;

    try {
      while (end > fromMs && guard < 400) {
        guard++;
        const batch = await pager.fetch(key, tf, end);
        if (!batch.length) break;

        for (const k of batch) if (k.t >= fromMs) acc.set(k.t, k);

        const oldest = batch[0].t;
        if (oldest >= end) break;      // no progress, stop rather than spin
        end = oldest - 1;
        ok = true;

        // Pace deliberately. Hammering a free endpoint earns a 429 and a
        // half-finished series, which is worse than taking longer.
        await new Promise((r) => setTimeout(r, 260));
      }
    } catch (_) { /* try the next pager */ }

    if (ok && acc.size) {
      return {
        source: pager.name,
        candles: [...acc.values()].sort((a, b) => a.t - b.t)
      };
    }
  }
  throw new Error(`No source could page ${tf} history for ${key}`);
}

/* ---------------------------------------------------------------- fx curve -- */

/**
 * Daily USD/INR across the whole range, in one request.
 *
 * Frankfurter publishes business days only, so the curve is forward-filled: a
 * Sunday takes Friday's rate. Also persisted, so a later backfill does not have
 * to fetch it again.
 */
async function fxCurve(db: SupabaseClient, fromMs: number, toMs: number) {
  const from = new Date(fromMs).toISOString().slice(0, 10);
  const to = new Date(toMs).toISOString().slice(0, 10);

  const series: Array<{ ms: number; rate: number }> = [];

  try {
    const res = await fetch(
      `https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=INR`,
      { signal: AbortSignal.timeout(20000) }
    );
    if (res.ok) {
      const j = await res.json() as { rates?: Record<string, { INR: number }> };
      for (const day of Object.keys(j.rates ?? {}).sort()) {
        const rate = j.rates![day].INR;
        if (rate > 0) series.push({ ms: Date.parse(day + 'T00:00:00Z'), rate });
      }
      if (series.length) {
        await db.from('fx_rates').upsert(
          series.map((s) => ({
            day: new Date(s.ms).toISOString().slice(0, 10),
            usd_inr: s.rate, source: 'frankfurter'
          })),
          { onConflict: 'day' }
        );
      }
    }
  } catch (_) { /* fall through to the database */ }

  if (!series.length) {
    const { data } = await db.from('fx_rates')
      .select('day,usd_inr').gte('day', from).lte('day', to).order('day');
    for (const r of data ?? []) {
      series.push({ ms: Date.parse(r.day + 'T00:00:00Z'), rate: Number(r.usd_inr) });
    }
  }

  if (!series.length) throw new Error('No USD/INR history available for that range');

  return {
    degraded: false,
    at(ms: number): number {
      if (ms <= series[0].ms) return series[0].rate;
      let lo = 0, hi = series.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (series[mid].ms <= ms) lo = mid; else hi = mid - 1;
      }
      return series[lo].rate;
    }
  };
}

/* ------------------------------------------------------------------- serve -- */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const started = Date.now();
  try {
    const db = admin();
    const user = await caller(req);
    await requireAdmin(db, user.id);

    const cfg = await loadConfig(db);
    const body = await req.json().catch(() => ({})) as { tf?: string; days?: number };

    const tf = body.tf ?? '1D';
    if (!['1m', '1h', '1D'].includes(tf)) {
      return json({ error: 'tf must be 1m, 1h or 1D' }, 400);
    }

    const days = body.days ?? DEFAULTS[tf];
    const now = Date.now();
    const from = days == null
      ? cfg.INDEX.launchMs
      : Math.max(cfg.INDEX.launchMs, now - days * 86400000);

    const curve = await fxCurve(db, from, now);

    // Fetch every basket asset before computing anything: a partial basket
    // produces a confidently wrong index.
    const byKey: Record<string, Candle[]> = {};
    let source = 'unknown';
    for (const a of cfg.BASKET) {
      const r = await pageBack(a.key, tf, from, now);
      byKey[a.key] = r.candles;
      source = r.source;

      // Persist the raw USD candles in batches — history can then be recomputed
      // if the index definition ever changes.
      for (let i = 0; i < r.candles.length; i += 500) {
        await db.from('asset_candles').upsert(
          r.candles.slice(i, i + 500).map((k) => ({
            asset_key: a.key, tf, ts: new Date(k.t).toISOString(),
            open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v, source: r.source
          })),
          { onConflict: 'asset_key,tf,ts' }
        );
      }
    }

    // Build the index, valuing each candle at that day's FX rate.
    const primary = byKey[cfg.BASKET[0].key];
    const maps: Record<string, Map<number, Candle>> = {};
    for (const a of cfg.BASKET) maps[a.key] = new Map(byKey[a.key].map((k) => [k.t, k]));

    const index: Candle[] = [];
    for (const ref of primary) {
      if (ref.t < cfg.INDEX.launchMs) continue;
      const q = cfg.INDEX.quote === 'INR' ? curve.at(ref.t) : 1;

      let o = 0, h = 0, l = 0, c = 0, v = 0, complete = true;
      for (const a of cfg.BASKET) {
        const k = maps[a.key].get(ref.t);
        const baseUsd = cfg.INDEX.baseUsd[a.key];
        if (!k || !baseUsd) { complete = false; break; }
        const baseQuote = cfg.INDEX.quote === 'INR' ? baseUsd * cfg.INDEX.baseFxUsdInr : baseUsd;
        const f = (a.weight * cfg.INDEX.arvBaseInr) / baseQuote;
        o += k.o * q * f; h += k.h * q * f;
        l += k.l * q * f; c += k.c * q * f;
        v += (k.v ?? 0) * a.weight;
      }
      if (complete) index.push({ t: ref.t, o, h, l, c, v });
    }

    if (!index.length) throw new Error('Backfill produced no candles');

    let written = 0;
    for (let i = 0; i < index.length; i += 500) {
      const chunk = index.slice(i, i + 500);
      const { error } = await db.from('arv_candles').upsert(
        chunk.map((k) => ({
          tf, ts: new Date(k.t).toISOString(),
          open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v,
          fx_rate: cfg.INDEX.quote === 'INR' ? curve.at(k.t) : null,
          is_final: true, source
        })),
        { onConflict: 'tf,ts' }
      );
      if (error) throw new Error('arv_candles: ' + error.message);
      written += chunk.length;
    }

    await audit(db, {
      actor: user.id, action: 'backfill', entity: 'arv_candles', entityId: tf,
      after: { tf, days, written, source }
    });

    return json({
      ok: true, tf, source, written,
      range: {
        from: new Date(index[0].t).toISOString(),
        to: new Date(index[index.length - 1].t).toISOString()
      },
      firstClose: index[0].c,
      lastClose: index[index.length - 1].c,
      elapsedMs: Date.now() - started
    });
  } catch (e) {
    return fail(e);
  }
});
