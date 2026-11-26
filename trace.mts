import { createPineFetchSeriesAdapter, parseSeriesTicker, normalizeSeriesTimeframe } from './src/lib/services/pineSeriesAdapter';
const urls: string[] = [];
const now = Date.now();
(globalThis as any).fetch = async (u: any) => {
  const url = String(u); urls.push(url);
  const lim = Number(new URL(url).searchParams.get('limit') || 200);
  const data = Array.from({ length: lim }, (_, i) => ({ time: now - (lim - i) * 300000, open: '1', high: '2', low: '0.5', close: '1.5', baseVol: '1', quoteVol: '1' }));
  return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { 'content-type': 'application/json' } });
};
for (const sym of ['BITUNIX:BTCUSDT.P', 'BTCUSDT.P', 'bitunix:BTCUSDT.P']) {
  console.log(sym, '->', JSON.stringify(parseSeriesTicker(sym)), 'tf', normalizeSeriesTimeframe('40'));
  const fs = createPineFetchSeriesAdapter({ sqliteLoader: async () => [], sqliteSaver: async () => {} });
  urls.length = 0;
  const bars = await fs(sym, '40');
  console.log('   bars:', bars.length, '| urls:', urls.length, urls[0]?.slice(0, 150));
}
process.exit(0);
