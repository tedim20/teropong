/**
 * Timeframe intraday non-native untuk request.security (mis. 40m dari script Pine "5m x 8").
 * Bursa seperti Binance tidak menyediakan 40m, jadi adapter menyusunnya dari candle 5m.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPineFetchSeriesAdapter,
  intradayTimeframeMinutes,
  planIntradayResample,
  resampleIntradayCandles,
} from '../src/lib/services/pineSeriesAdapter';
import type { Candle } from '../src/lib/types/market';

const DAY = Date.UTC(2026, 10, 26);
const fiveMin = (n: number, start = DAY): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: start + i * 300_000,
    open: 100 + i,
    high: 100 + i + 0.5,
    low: 100 + i - 0.5,
    close: 100 + i + 0.25,
    volume: 1,
  }));

test('intradayTimeframeMinutes membaca menit & jam', () => {
  assert.equal(intradayTimeframeMinutes('40m'), 40);
  assert.equal(intradayTimeframeMinutes('2h'), 120);
  assert.equal(intradayTimeframeMinutes('1D'), null);
  assert.equal(intradayTimeframeMinutes(''), null);
});

test('planIntradayResample: native tidak diubah, non-native disusun dari interval terbesar yang membagi habis', () => {
  for (const tf of ['1m', '5m', '15m', '30m', '1h', '4h']) assert.equal(planIntradayResample(tf), null, tf);
  assert.deepEqual(planIntradayResample('40m'), { baseInterval: '5m', factor: 8, targetMinutes: 40 });
  assert.deepEqual(planIntradayResample('24m'), { baseInterval: '3m', factor: 8, targetMinutes: 24 });
  assert.deepEqual(planIntradayResample('8m'), { baseInterval: '1m', factor: 8, targetMinutes: 8 });
  assert.deepEqual(planIntradayResample('3h'), { baseInterval: '1h', factor: 3, targetMinutes: 180 });
  assert.equal(planIntradayResample('1D'), null);
});

test('resampleIntradayCandles menggabungkan OHLCV dengan benar, sejajar tengah malam UTC', () => {
  const bars = resampleIntradayCandles(fiveMin(16), 40);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[0], { time: DAY, open: 100, high: 107.5, low: 99.5, close: 107.25, volume: 8 });
  assert.equal(bars[1].time, DAY + 40 * 60_000);
  assert.equal(bars[1].open, 108);
  assert.equal(bars[1].close, 115.25);
  // Bucket tidak terpengaruh titik awal data: mulai 10 menit setelah tengah malam tetap masuk bucket 00:00
  const shifted = resampleIntradayCandles(fiveMin(6, DAY + 600_000), 40);
  assert.equal(shifted[0].time, DAY);
  assert.equal(shifted[0].volume, 6);
});

test('fetchSeries 40m mengambil 5m dari jaringan lalu menggabungkannya', async () => {
  const calls: Array<{ interval: string; limit: number }> = [];
  const fetchSeries = createPineFetchSeriesAdapter({
    sqliteLoader: async () => [],
    sqliteSaver: async () => {},
    networkFetcher: async (_symbol, interval, limit) => {
      calls.push({ interval, limit: limit ?? 0 });
      return fiveMin(16);
    },
  });
  const bars = await fetchSeries('BINANCE:BTCUSDT', '40');
  assert.deepEqual(calls, [{ interval: '5m', limit: 1000 }]);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].open, 100);
  assert.equal(bars[0].close, 107.25);
});

test('fetchSeries timeframe native tetap diambil langsung (perilaku lama)', async () => {
  const calls: string[] = [];
  const fetchSeries = createPineFetchSeriesAdapter({
    sqliteLoader: async () => [],
    sqliteSaver: async () => {},
    networkFetcher: async (_symbol, interval) => {
      calls.push(interval);
      return fiveMin(3);
    },
  });
  await fetchSeries('BINANCE:BTCUSDT', '15');
  assert.deepEqual(calls, ['15m']);
});

import { fetchViaChartGateway, TrawanganPineWorkerEngine, toOHLCVBar } from '../src/lib/services/pineSeriesAdapter';

const fakeWorker = () => ({ postMessage() {}, addEventListener() {}, terminate() {} });

test('fetchViaChartGateway: 40 diambil sebagai 5 dari gateway chart lalu digabung', async () => {
  const calls: Array<{ tf: string; limit?: number }> = [];
  const gateway = async (_s: string, tf: string, range?: any) => {
    calls.push({ tf, limit: range?.limit });
    return fiveMin(16).map(toOHLCVBar);
  };
  const bars = await fetchViaChartGateway(gateway, 'BTCUSDT', '40', { limit: 100 });
  assert.deepEqual(calls, [{ tf: '5', limit: 800 }]);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].open, 100);
  assert.equal(bars[0].close, 107.25);
});

test('fetchViaChartGateway: timeframe native diteruskan apa adanya', async () => {
  const calls: string[] = [];
  await fetchViaChartGateway(async (_s, tf) => { calls.push(tf); return []; }, 'BTCUSDT', '15');
  assert.deepEqual(calls, ['15']);
});

function engineWithSession(gateway: any, custom: any) {
  const posted: any[] = [];
  const warnings: any[] = [];
  const engine = new TrawanganPineWorkerEngine({ createWorker: fakeWorker as any, fetchSeries: custom });
  (engine as any).post = (m: any) => posted.push(m);
  (engine as any).sessions = new Map([[1, { req: { fetchSeries: gateway }, handlers: { onWarning: (w: any) => warnings.push(w) } }]]);
  return { engine, posted, warnings };
}

test('serveFetch memakai gateway data chart lebih dulu', async () => {
  let customCalled = false;
  const { engine, posted, warnings } = engineWithSession(
    async () => fiveMin(3).map(toOHLCVBar),
    async () => { customCalled = true; return []; }
  );
  await (engine as any).serveFetch(7, 'BTCUSDT', '15', { limit: 10 });
  assert.equal(customCalled, false);
  assert.equal(posted[0].reqId, 7);
  assert.equal(posted[0].bars.length, 3);
  assert.equal(warnings.length, 0);
});

test('serveFetch jatuh ke adapter kustom bila gateway kosong, dan memberi peringatan bila keduanya kosong', async () => {
  const a = engineWithSession(async () => [], async () => fiveMin(2).map(toOHLCVBar));
  await (a.engine as any).serveFetch(1, 'BTCUSDT', '15');
  assert.equal(a.posted[0].bars.length, 2);
  assert.equal(a.warnings.length, 0);

  const b = engineWithSession(async () => { throw new Error('feed mati'); }, async () => []);
  await (b.engine as any).serveFetch(2, 'BTCUSDT', '40');
  assert.deepEqual(b.posted[0].bars, []);
  assert.equal(b.warnings.length, 1);
  assert.match(b.warnings[0].message, /BTCUSDT @ 40/);
});
