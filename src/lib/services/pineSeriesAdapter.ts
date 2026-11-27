/**
 * Adapter Inter-Symbol Resolution untuk Mesin Skrip Pine (Ticket #197)
 *
 * Mengizinkan fungsi Pine Script seperti `request.security(symbol, timeframe, ...)`
 * menyelesaikan simbol eksternal lintas bursa kripto, saham Yahoo Finance, dan indeks makro.
 * Menyediakan caching multi-tier (Memory -> SQLite -> Network Provider) untuk meminimalkan
 * latensi dan mematuhi batasan rate limit.
 */

import { PineWorkerEngine, type PineWorkerOptions } from '@luxalgo/vela-pinets';
import type { Candle } from '../types/market';
import { resolveSymbolProvider, marketFeed } from './market';
import { fromVelaTimeframe, parseQuickTimeframeInput, toExchangeInterval } from '../utils/timeframeAdapter';
import { isTauriEnvironment } from '../utils/tauriEnv';
import { canonicalizeMacroIndexSymbol } from './macroIndexCatalog';

/** Rentang query bar yang diminta oleh Vela */
export interface FetchSeriesRange {
  from?: number;
  to?: number;
  limit?: number;
}

/** Tipe bar gabungan yang mendukung pengaksesan berbasis tuple indeks dan properti objek */
export interface OHLCVBar extends Array<number> {
  0: number; // time
  1: number; // open
  2: number; // high
  3: number; // low
  4: number; // close
  5: number; // volume
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Signature fungsi resolusi deret waktu inter-simbol */
export type FetchSeriesHandler = (
  symbol: string,
  timeframe: string,
  range?: FetchSeriesRange
) => Promise<OHLCVBar[]>;

/** Hasil penguraian ticker Pine */
export interface ParsedSeriesTicker {
  providerId: string;
  cleanSymbol: string;
  rawSymbol: string;
  modifier?: string;
}

/** Konfigurasi opsi pembuat adapter deret Pine */
export interface PineFetchSeriesAdapterOptions {
  sqliteLoader?: (symbol: string, timeframe: string, limit?: number) => Promise<Candle[]>;
  sqliteSaver?: (symbol: string, timeframe: string, candles: Candle[]) => Promise<void>;
  networkFetcher?: (symbol: string, interval: string, limit?: number) => Promise<Candle[]>;
  inMemoryCache?: Map<string, { fetchedAt: number; bars: OHLCVBar[] }>;
  cacheTtlMs?: number;
  defaultProvider?: string;
}

/** Opsi konstruktor mesin worker Pine dengan adapter deret inter-simbol */
export interface PineWorkerEngineOptions extends PineWorkerOptions {
  fetchSeries?: FetchSeriesHandler;
}

/**
 * Mengubah objek lilin pasar (atau array angka) menjadi OHLCVBar dual-interface
 */
export function toOHLCVBar(
  item: Candle | [number, number, number, number, number, number]
): OHLCVBar {
  let t = 0;
  let o = 0;
  let h = 0;
  let l = 0;
  let c = 0;
  let v = 0;

  if (Array.isArray(item)) {
    t = Number(item[0]) || 0;
    o = Number(item[1]) || 0;
    h = Number(item[2]) || 0;
    l = Number(item[3]) || 0;
    c = Number(item[4]) || 0;
    v = Number(item[5]) || 0;
  } else if (item && typeof item === 'object') {
    t = Number(item.time) || 0;
    o = Number(item.open) || 0;
    h = Number(item.high) || 0;
    l = Number(item.low) || 0;
    c = Number(item.close) || 0;
    v = Number(item.volume) || 0;
  }

  const tuple: any = [t, o, h, l, c, v];
  tuple.time = t;
  tuple.open = o;
  tuple.high = h;
  tuple.low = l;
  tuple.close = c;
  tuple.volume = v;

  return tuple as OHLCVBar;
}

/**
 * Mengurai ticker string yang dikirimkan oleh Pine Script
 * Mendukung format:
 * - Prefix bursa: `BINANCE:BTCUSDT`, `YAHOO:^GSPC`, `MACRO:TOTAL`, `INDODAX:BTCIDR`, `BITUNIX:BTCUSDT.P`
 * - Bare ticker: `BTCUSDT`, `^GSPC`, `BBCA.JK`, `TOTAL`, `BTC.D`, `ETHIDR`
 * - Modifier extended: `BINANCE:ETHUSDT;heikinashi`
 */
export function parseSeriesTicker(
  rawSymbol: string,
  defaultProvider = 'binance'
): ParsedSeriesTicker {
  if (!rawSymbol) {
    return { providerId: defaultProvider.toLowerCase(), cleanSymbol: '', rawSymbol: '' };
  }

  let clean = rawSymbol.trim();
  let modifier: string | undefined;

  // Tangani modifier tipe lilin bila disertakan oleh Vela (misal ";heikinashi")
  if (clean.includes(';')) {
    const parts = clean.split(';');
    clean = parts[0].trim();
    modifier = parts[1]?.trim().toLowerCase();
  }

  // Gunakan engine pemecah provider standar Trawangan
  const { providerId, cleanSymbol } = resolveSymbolProvider(clean, defaultProvider);

  // Periksa apakah simbol makro memerlukan kanonikalisasi
  const macroCanon = canonicalizeMacroIndexSymbol(cleanSymbol);
  const effectiveClean = macroCanon || cleanSymbol;
  const effectiveProvider = macroCanon ? 'macro' : providerId;

  return {
    providerId: effectiveProvider,
    cleanSymbol: effectiveClean,
    rawSymbol: clean,
    ...(modifier ? { modifier } : {}),
  };
}

/**
 * Menormalisasi representasi timeframe dari Pine Script ke format interval standar Trawangan
 */
export function normalizeSeriesTimeframe(timeframe: string): string {
  if (!timeframe || !timeframe.trim()) {
    return '15m';
  }

  const trimmed = timeframe.trim();

  // Konversi angka menit mentah Vela / PineTS (misal "1", "15", "60", "240")
  const fromVela = fromVelaTimeframe(trimmed);
  if (fromVela && fromVela !== trimmed) {
    return fromVela;
  }

  return parseQuickTimeframeInput(trimmed);
}

/**
 * Menyaring deret lilin berdasarkan batas range (from, to, limit) secara kronologis ascending
 */
export function applyRangeBounds(
  bars: OHLCVBar[],
  range?: FetchSeriesRange
): OHLCVBar[] {
  if (!bars || bars.length === 0) return [];

  let result = bars;

  if (range) {
    if (typeof range.from === 'number') {
      const fromTime = range.from;
      result = result.filter((b) => b.time >= fromTime);
    }

    if (typeof range.to === 'number') {
      const toTime = range.to;
      result = result.filter((b) => b.time <= toTime);
    }

    if (typeof range.limit === 'number' && range.limit > 0 && result.length > range.limit) {
      result = result.slice(-range.limit);
    }
  }

  return result;
}

/**
 * Pemuat lilin dari SQLite lokal bawaan Tauri
 */
async function defaultTauriSqliteLoader(
  symbol: string,
  timeframe: string,
  limit = 500
): Promise<Candle[]> {
  if (!isTauriEnvironment()) return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<Candle[]>('load_cached_candles', {
      symbol,
      timeframe,
      limit,
    });
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

/**
 * Penyimpan lilin ke SQLite lokal bawaan Tauri
 */
async function defaultTauriSqliteSaver(
  symbol: string,
  timeframe: string,
  candles: Candle[]
): Promise<void> {
  if (!isTauriEnvironment() || !candles || candles.length === 0) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('store_cached_candles', {
      symbol,
      timeframe,
      candles,
    });
  } catch {
    // Abaikan kegagalan cache persistensi sekunder
  }
}

/**
 * Pengambil lilin langsung dari jaringan melalui marketFeed Trawangan
 */
async function defaultMarketNetworkFetcher(
  symbol: string,
  interval: string,
  limit = 500
): Promise<Candle[]> {
  try {
    const candles = await marketFeed.getCandles(symbol, interval, limit);
    return Array.isArray(candles) ? candles : [];
  } catch (err) {
    console.warn(`[PineSeriesAdapter] Gagal mengambil lilin dari feed pasar untuk ${symbol}:`, err);
    return [];
  }
}

/**
 * Interval intraday (dalam menit) yang tersedia langsung di bursa (Binance, Bitunix, dsb.).
 */
const NATIVE_INTRADAY_MINUTES = [1, 3, 5, 15, 30, 60, 120, 240, 360, 480, 720];

/**
 * Mengubah timeframe intraday ternormalisasi menjadi menit ("40m" -> 40, "2h" -> 120); null bila bukan menit/jam.
 */
export function intradayTimeframeMinutes(tf: string): number | null {
  const match = /^(\d+)(m|h)$/.exec((tf || '').trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return match[2] === 'h' ? n * 60 : n;
}

/**
 * Untuk timeframe intraday yang tidak tersedia di bursa (mis. "40m" dari Pine `5 x 8`),
 * memilih interval native terbesar yang membaginya habis. Null bila timeframe sudah native
 * atau tidak bisa disusun dari interval native.
 */
export function planIntradayResample(
  tf: string
): { baseInterval: string; factor: number; targetMinutes: number } | null {
  const minutes = intradayTimeframeMinutes(tf);
  if (minutes === null || NATIVE_INTRADAY_MINUTES.includes(minutes)) return null;
  const base = [...NATIVE_INTRADAY_MINUTES].reverse().find((b) => b < minutes && minutes % b === 0);
  if (!base) return null;
  const baseInterval = base % 60 === 0 ? `${base / 60}h` : `${base}m`;
  return { baseInterval, factor: minutes / base, targetMinutes: minutes };
}

/**
 * Menggabungkan candle kecil menjadi candle N menit. Bucket disejajarkan ke tengah malam UTC
 * setiap hari, sama seperti TradingView untuk pasar 24 jam (bucket terakhir hari itu bisa lebih pendek).
 */
export function resampleIntradayCandles(candles: Candle[], targetMinutes: number): Candle[] {
  if (!Array.isArray(candles) || candles.length === 0 || targetMinutes <= 0) return [];
  const spanMs = targetMinutes * 60_000;
  const dayMs = 86_400_000;
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const out: Candle[] = [];
  let current: Candle | null = null;
  for (const c of sorted) {
    const dayStart = Math.floor(c.time / dayMs) * dayMs;
    const bucket = dayStart + Math.floor((c.time - dayStart) / spanMs) * spanMs;
    if (!current || current.time !== bucket) {
      if (current) out.push(current);
      current = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 };
    } else {
      current.high = Math.max(current.high, c.high);
      current.low = Math.min(current.low, c.low);
      current.close = c.close;
      current.volume = (current.volume ?? 0) + (c.volume ?? 0);
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Membangun adapter fungsi `fetchSeries` bertipe kuat untuk PineWorkerEngine
 */
export function createPineFetchSeriesAdapter(
  options: PineFetchSeriesAdapterOptions = {}
): FetchSeriesHandler {
  const {
    sqliteLoader = defaultTauriSqliteLoader,
    sqliteSaver = defaultTauriSqliteSaver,
    networkFetcher = defaultMarketNetworkFetcher,
    inMemoryCache = new Map<string, { fetchedAt: number; bars: OHLCVBar[] }>(),
    cacheTtlMs = 60_000,
    defaultProvider = 'binance',
  } = options;

  return async function fetchSeries(
    rawSymbol: string,
    rawTimeframe: string,
    range?: FetchSeriesRange
  ): Promise<OHLCVBar[]> {
    const parsed = parseSeriesTicker(rawSymbol, defaultProvider);
    if (!parsed.cleanSymbol) return [];

    const tf = normalizeSeriesTimeframe(rawTimeframe);
    const exchangeInterval = toExchangeInterval(tf);
    const cacheKey = `${parsed.providerId}:${parsed.cleanSymbol}:${tf}`;
    const requiredLimit = Math.max(100, Math.min(1000, range?.limit ?? 500));

    // ─── 1. Cek In-Memory Cache (Tier 1) ───
    const memHit = inMemoryCache.get(cacheKey);
    const now = Date.now();
    if (memHit && now - memHit.fetchedAt < cacheTtlMs && memHit.bars.length > 0) {
      return applyRangeBounds(memHit.bars, range);
    }

    // ─── 2. Cek SQLite Kline Cache (Tier 2) ───
    let loadedFromSqlite: Candle[] = [];
    const providerSymbolKey = `${parsed.providerId}:${parsed.cleanSymbol}`;
    try {
      // Coba cari dengan format canonical `${providerId}:${cleanSymbol}` terlebih dahulu
      loadedFromSqlite = await sqliteLoader(providerSymbolKey, tf, requiredLimit);
      if (!loadedFromSqlite || loadedFromSqlite.length === 0) {
        // Fallback coba cari bare cleanSymbol bila disimpan tanpa prefix
        loadedFromSqlite = await sqliteLoader(parsed.cleanSymbol, tf, requiredLimit);
      }
    } catch {
      loadedFromSqlite = [];
    }

    if (loadedFromSqlite && loadedFromSqlite.length > 0) {
      const bars = loadedFromSqlite.map(toOHLCVBar);
      const bounded = applyRangeBounds(bars, range);
      // Cache SQLite tidak punya batas kedaluwarsa: bila tidak mencakup rentang yang diminta, ambil ulang dari jaringan
      if (bounded.length > 0) {
        inMemoryCache.set(cacheKey, { fetchedAt: now, bars });
        return bounded;
      }
    }

    // ─── 3. Fallback Jaringan Market Feed / Universal Fetch (Tier 3) ───
    const lookupSymbol = `${parsed.providerId}:${parsed.cleanSymbol}`;
    let fetchedCandles: Candle[] = [];
    try {
      const resamplePlan = planIntradayResample(tf);
      if (resamplePlan) {
        // Timeframe non-native (mis. 40m): ambil interval native lalu gabungkan sendiri
        const baseLimit = Math.min(1000, requiredLimit * resamplePlan.factor);
        const baseCandles = await networkFetcher(lookupSymbol, resamplePlan.baseInterval, baseLimit);
        fetchedCandles = resampleIntradayCandles(baseCandles, resamplePlan.targetMinutes);
      } else {
        fetchedCandles = await networkFetcher(lookupSymbol, exchangeInterval, requiredLimit);
      }
    } catch (err) {
      console.warn(`[PineSeriesAdapter] Network fetcher gagal untuk ${lookupSymbol}:`, err);
      fetchedCandles = [];
    }

    if (fetchedCandles && fetchedCandles.length > 0) {
      const bars = fetchedCandles.map(toOHLCVBar);

      // Simpan ke SQLite cache untuk query berikutnya
      void sqliteSaver(providerSymbolKey, tf, fetchedCandles).catch(() => {});
      if (parsed.cleanSymbol !== providerSymbolKey) {
        void sqliteSaver(parsed.cleanSymbol, tf, fetchedCandles).catch(() => {});
      }

      // Simpan ke memory cache
      inMemoryCache.set(cacheKey, { fetchedAt: now, bars });

      return applyRangeBounds(bars, range);
    }

    return [];
  };
}

/**
 * Mesin Worker Pine yang di-hardening untuk Trawangan dengan injeksi fetchSeries inter-simbol
 */
/**
 * Mengambil series lewat gateway data chart milik Vela (`req.fetchSeries` = feed provider chart).
 * Timeframe intraday non-native (mis. "40" = 8 x 5m) diambil dalam interval dasar lalu digabung.
 */
export async function fetchViaChartGateway(
  gateway: FetchSeriesHandler,
  symbol: string,
  timeframe: string,
  range?: FetchSeriesRange
): Promise<OHLCVBar[]> {
  const plan = planIntradayResample(normalizeSeriesTimeframe(timeframe));
  if (!plan) {
    const bars = await gateway(symbol, timeframe, range);
    return Array.isArray(bars) ? bars : [];
  }
  const baseMinutes = plan.targetMinutes / plan.factor;
  const baseRange: FetchSeriesRange | undefined = range
    ? { ...range, ...(typeof range.limit === 'number' ? { limit: Math.min(5000, range.limit * plan.factor) } : {}) }
    : undefined;
  const baseBars = await gateway(symbol, String(baseMinutes), baseRange);
  if (!Array.isArray(baseBars) || baseBars.length === 0) return [];
  const candles: Candle[] = baseBars.map((b: any) => ({
    time: Number(b.time),
    open: Number(b.open),
    high: Number(b.high),
    low: Number(b.low),
    close: Number(b.close),
    volume: Number(b.volume ?? 0),
  }));
  return resampleIntradayCandles(candles, plan.targetMinutes).map(toOHLCVBar);
}

/**
 * Kunci instrumen untuk membandingkan simbol permintaan Pine dengan simbol chart:
 * tanpa prefix bursa, tanpa sufiks perpetual (.P / -PERP / PERP), huruf besar.
 * Mengembalikan null untuk ticker ber-modifier (mis. ";heikinashi").
 */
export function instrumentKey(symbol: string | undefined | null): string | null {
  if (!symbol || typeof symbol !== 'string') return null;
  if (symbol.includes(';')) return null;
  let s = symbol.trim();
  if (s.includes(':')) s = s.slice(s.lastIndexOf(':') + 1);
  s = s.replace(/(\.P|-PERP|PERP)$/i, '').toUpperCase();
  return s || null;
}

/**
 * Menyusun series timeframe lebih tinggi langsung dari candle chart bila simbolnya sama
 * dan timeframe yang diminta adalah kelipatan timeframe chart (mis. chart 5m -> 40m = 8 x 5m).
 * Tidak butuh jaringan: datanya persis sama dengan yang tampil di chart.
 */
export function deriveFromChartBars(
  chartSymbol: string,
  chartTimeframe: string,
  chartBars: any[] | undefined,
  symbol: string,
  timeframe: string
): OHLCVBar[] | null {
  if (!Array.isArray(chartBars) || chartBars.length === 0) return null;
  const want = instrumentKey(symbol);
  if (!want || want !== instrumentKey(chartSymbol)) return null;
  const chartMin = intradayTimeframeMinutes(normalizeSeriesTimeframe(chartTimeframe));
  const targetMin = intradayTimeframeMinutes(normalizeSeriesTimeframe(timeframe));
  if (!chartMin || !targetMin || targetMin < chartMin || targetMin % chartMin !== 0) return null;
  const candles: Candle[] = chartBars
    .map((b: any) => ({
      time: Number(b.time),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: Number(b.volume ?? 0),
    }))
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close));
  if (candles.length === 0) return null;
  const bars = targetMin === chartMin ? candles : resampleIntradayCandles(candles, targetMin);
  return bars.map(toOHLCVBar);
}

/**
 * Mesin Worker Pine yang di-hardening untuk Trawangan dengan injeksi fetchSeries inter-simbol.
 *
 * Urutan sumber data untuk `request.security`:
 *  1. Candle chart itu sendiri, bila simbolnya sama dan timeframe-nya kelipatan timeframe chart.
 *  2. Gateway data chart milik Vela (feed provider chart).
 *  3. Adapter kustom (cache SQLite / market feed) sebagai cadangan.
 * Bila keduanya kosong, peringatan dikirim ke konsol Pine agar tidak gagal diam-diam.
 */
export class TrawanganPineWorkerEngine extends PineWorkerEngine {
  private readonly customFetchSeries?: FetchSeriesHandler;

  constructor(opts?: PineWorkerEngineOptions) {
    super(opts);
    this.customFetchSeries = opts?.fetchSeries;

    (this as any).serveFetch = async (
      reqId: number,
      symbol: string,
      timeframe: string,
      range?: any
    ): Promise<void> => {
      let bars: OHLCVBar[] = [];
      let lastError: unknown = null;

      // 1. Simbol sama dengan chart & timeframe kelipatan: susun dari candle chart (tanpa jaringan)
      for (const session of this.activeSessions()) {
        const req = session?.req;
        if (!req?.market) continue;
        const chartBars = typeof req.getBars === 'function' ? req.getBars() : req.bars;
        const derived = deriveFromChartBars(req.market.symbol, req.market.timeframe, chartBars, symbol, timeframe);
        if (derived && derived.length > 0) {
          bars = derived;
          break;
        }
      }

      // 2. Gateway data chart milik Vela, 3. adapter kustom
      const gateway = bars.length === 0 ? this.findChartGateway() : undefined;
      if (gateway) {
        try {
          bars = await fetchViaChartGateway(gateway, symbol, timeframe, range);
        } catch (err) {
          lastError = err;
        }
      }

      if (bars.length === 0 && this.customFetchSeries) {
        try {
          bars = await this.customFetchSeries(symbol, timeframe, range);
        } catch (err) {
          lastError = err;
        }
      }

      if (!Array.isArray(bars) || bars.length === 0) {
        const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
        this.broadcastWarning(`request.security: tidak ada data untuk ${symbol} @ ${timeframe}${detail}`);
        bars = [];
      }

      (this as any).post?.({ kind: 'fetchSeriesResult', reqId, bars });
    };
  }

  private activeSessions(): any[] {
    const sessions: Map<unknown, any> | undefined = (this as any).sessions;
    if (!sessions || typeof sessions.values !== 'function') return [];
    return [...sessions.values()];
  }

  /**
   * Gateway `fetchSeries` yang disuntikkan Vela ke sesi aktif (bukan adapter kustom kita).
   */
  private findChartGateway(): FetchSeriesHandler | undefined {
    const sessions: Map<unknown, any> | undefined = (this as any).sessions;
    if (!sessions || typeof sessions.values !== 'function') return undefined;
    for (const s of sessions.values()) {
      const fn = s?.req?.fetchSeries;
      if (typeof fn === 'function' && fn !== this.customFetchSeries) return fn as FetchSeriesHandler;
    }
    return undefined;
  }

  private broadcastWarning(message: string): void {
    console.warn(`[TrawanganPineWorkerEngine] ${message}`);
    const sessions: Map<unknown, any> | undefined = (this as any).sessions;
    if (!sessions || typeof sessions.values !== 'function') return;
    for (const s of sessions.values()) {
      try {
        s?.handlers?.onWarning?.({ message, method: 'request.security', bar: 0 });
      } catch {
        // abaikan handler yang gagal
      }
    }
  }

  /**
   * Menyisipkan fetchSeries adapter ke setiap sesi eksekusi skrip
   */
  override execute(req: any, handlers: any) {
    if (this.customFetchSeries && (!req.fetchSeries || typeof req.fetchSeries !== 'function')) {
      req.fetchSeries = this.customFetchSeries;
    }
    return super.execute(req, handlers);
  }
}
