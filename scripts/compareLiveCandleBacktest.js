#!/usr/bin/env node
// Compares baseline strategy vs a conservative, no-lookahead historical proxy
// for live-candle confirmation. Since OHLC history does not contain intrabar
// snapshots, confirmation is evaluated at the signal candle CLOSE; any accepted
// buy still fills at the NEXT candle OPEN via the existing backtest engine.
const fs = require('fs');
const path = require('path');
const strategies = require('../src/strategies');
const store = require('../src/store');
const { loadCandles, INTERVAL_MS, DEFAULT_BASE_URL } = require('../src/backtest/data');
const { loadCandlesFromExchange } = require('../src/backtest/multiExchangeData');
const { runBacktest } = require('../src/backtest/simulator');
const { confirmBuy } = require('../src/liveCandleConfirmation');

function parseArgs(argv) {
  const opts = {
    months: 60,
    symbols: Object.keys(store.defaultState().pairs),
    tf: ['1h', '4h'],
    strategyIds: strategies.list().map((s) => s.id),
    capital: 1000,
    feePct: 0.1,
    slippagePct: 0.05,
    exchange: 'binance',
    baseUrl: process.env.BINANCE_BASE_URL || DEFAULT_BASE_URL,
    out: path.join(__dirname, '..', 'data', 'backtest')
  };
  const valued = new Set(['--months', '--symbols', '--tf', '--strategies', '--capital', '--fee', '--slip', '--base', '--out', '--exchange']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!valued.has(a)) throw new Error(`Bilinmeyen seçenek: ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} için değer gerekli.`);
    if (a === '--months') opts.months = Number(v);
    if (a === '--exchange') opts.exchange = v.toLowerCase();
    if (a === '--symbols') opts.symbols = v.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    if (a === '--tf') opts.tf = v.split(',').map(x => x.trim()).filter(Boolean);
    if (a === '--strategies') opts.strategyIds = v.split(',').map(x => x.trim()).filter(Boolean);
    if (a === '--capital') opts.capital = Number(v);
    if (a === '--fee') opts.feePct = Number(v);
    if (a === '--slip') opts.slippagePct = Number(v);
    if (a === '--base') opts.baseUrl = v.replace(/\/+$/, '');
    if (a === '--out') opts.out = v;
  }
  if (!['binance','okx','btcturk','paribu'].includes(opts.exchange)) throw new Error('--exchange binance|okx|btcturk|paribu olmalı.');
  if (!Number.isFinite(opts.months) || opts.months < 1 || opts.months > 60) throw new Error('--months 1–60 arası olmalı.');
  if (!Number.isFinite(opts.capital) || opts.capital <= 0) throw new Error('--capital pozitif olmalı.');
  if (![opts.feePct, opts.slippagePct].every(x => Number.isFinite(x) && x >= 0 && x <= 5)) throw new Error('--fee ve --slip 0–5 arası olmalı.');
  for (const tf of opts.tf) if (!INTERVAL_MS[tf]) throw new Error(`Desteklenmeyen mum aralığı: ${tf}`);
  for (const id of opts.strategyIds) strategies.get(id);
  if (!opts.symbols.length || !opts.tf.length || !opts.strategyIds.length) throw new Error('Parite, mum aralığı ve strateji boş olamaz.');
  return opts;
}

function withCloseConfirmation(strategy) {
  return {
    ...strategy,
    evaluate(args) {
      const decision = strategy.evaluate(args);
      if (decision?.action !== 'buy') return decision;
      const candle = args?.candles?.[args.candles.length - 1];
      const check = confirmBuy({ candle, observedPrice: candle?.c });
      return check.ok
        ? { ...decision, reason: `${decision.reason || 'BUY'} | tarihsel kapanış onayı` }
        : { ...decision, action: 'hold', reason: `canlı mum filtresi (tarihsel kapanış vekili): ${check.reason}` };
    }
  };
}

function fmt(v) { return Number.isFinite(v) ? `${v.toFixed(2)}%` : '—'; }
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cacheDir = path.join(opts.out, 'veri');
  const rows = [];
  const coverageRows = [];
  console.error(`Karşılaştırma: ${opts.exchange} | ${opts.months} ay | ${opts.symbols.length} parite | ${opts.tf.join(',')} | ${opts.strategyIds.length} strateji`);
  console.error('Yöntem: kapanmış sinyal mumunun OHLC kapanışında onay vekili; gerçekleşme sonraki mum açılışında. Bu, mum içi gerçek zaman akışının birebir simülasyonu değildir.');
  for (const tf of opts.tf) for (const symbol of opts.symbols) {
    const data = opts.exchange === 'binance'
      ? await loadCandles({ symbol, interval: tf, months: opts.months, baseUrl: opts.baseUrl, cacheDir })
      : await loadCandlesFromExchange({ exchange: opts.exchange, symbol, interval: tf, months: opts.months, baseUrl: opts.baseUrl === (process.env.BINANCE_BASE_URL || DEFAULT_BASE_URL) ? undefined : opts.baseUrl, cacheDir });
    if (data.candles.length - data.startIndex < 20) throw new Error(`${symbol} ${tf}: test penceresinde yeterli mum yok.`);
    const firstTestCandle = data.candles[data.startIndex];
    const lastCandle = data.candles[data.candles.length - 1];
    const requestedMs = data.windowStartMs ? (Date.now() - data.windowStartMs) : opts.months * 30.4375 * 86400000;
    const actualMs = firstTestCandle && lastCandle ? Math.max(0, lastCandle.t + INTERVAL_MS[tf] - firstTestCandle.t) : 0;
    const coverageMonths = actualMs / (30.4375 * 86400000);
    const coveragePct = requestedMs > 0 ? Math.min(100, actualMs / requestedMs * 100) : 0;
    if (!Number.isInteger(data.startIndex) || data.startIndex < 0 || data.startIndex >= data.candles.length) throw new Error(`${symbol} ${tf}: geçersiz tarihsel test başlangıç indeksi (${data.startIndex}).`);
    const coverage = { symbol, timeframe: tf, requestedMonths: opts.months, actualMonths: Number(coverageMonths.toFixed(2)), coveragePct: Number(coveragePct.toFixed(1)), candles: data.candles.length - data.startIndex, gaps: data.gaps, source: data.fromCache ? 'cache' : 'download' };
    coverageRows.push(coverage);
    console.error(`${symbol} ${tf}: ${data.candles.length - data.startIndex} test mumu; kapsam ${coverage.actualMonths}/${opts.months} ay (${coverage.coveragePct}%); ${data.gaps} boşluk; ${coverage.source}`);
    if (coveragePct < 95) console.error(`UYARI: ${symbol} ${tf} verisi istenen ${opts.months} aylık pencerenin en az %95'ini kapsamıyor; bu sonuç tam dönem testi sayılmamalı.`);
    for (const id of opts.strategyIds) {
      const strategy = strategies.get(id);
      const args = { candles: data.candles, startIndex: data.startIndex, strategy, params: strategy.defaultParams, capital: opts.capital, feePct: opts.feePct, slippagePct: opts.slippagePct };
      const base = runBacktest(args);
      const filtered = runBacktest({ ...args, strategy: withCloseConfirmation(strategy) });
      rows.push({ symbol, timeframe: tf, strategyId: id, coverageMonths: coverage.actualMonths, coveragePct: coverage.coveragePct, candlesTested: base.candlesTested,
        baseline: { returnPct: base.returnPct, maxDrawdownPct: base.maxDrawdownPct, trades: base.trades, winRatePct: base.winRatePct, profitFactor: base.profitFactor, feesPct: base.feesPct, buyHoldPct: base.buyHoldPct },
        filtered: { returnPct: filtered.returnPct, maxDrawdownPct: filtered.maxDrawdownPct, trades: filtered.trades, winRatePct: filtered.winRatePct, profitFactor: filtered.profitFactor, feesPct: filtered.feesPct, buyHoldPct: filtered.buyHoldPct },
        delta: { returnPct: filtered.returnPct - base.returnPct, maxDrawdownPct: filtered.maxDrawdownPct - base.maxDrawdownPct, trades: filtered.trades - base.trades }
      });
    }
  }
  const report = [
    'CANLI MUM ONAYI — TARİHSEL KARŞILAŞTIRMA',
    `Borsa: ${opts.exchange} | Dönem: ${opts.months} ay | Sermaye: ${opts.capital} | Komisyon: ${opts.feePct}%/taraf | Kayma: ${opts.slippagePct}%/taraf`,
    'ÖNEMLİ: Filtre, sinyal mumunun kapanış OHLC verisiyle vekil olarak test edilmiştir; gerçek mum içi onayla aynı değildir.',
    'Strateji / Parite / TF | Baz getiri | Filtreli getiri | Getiri farkı | Baz maxDD | Filtreli maxDD | Baz işlem | Filtreli işlem | İşlem farkı',
    ...rows.map(r => `${r.strategyId} / ${r.symbol} / ${r.timeframe} (${r.coverageMonths}ay, ${r.coveragePct}%) | ${fmt(r.baseline.returnPct)} | ${fmt(r.filtered.returnPct)} | ${fmt(r.delta.returnPct)} | ${fmt(r.baseline.maxDrawdownPct)} | ${fmt(r.filtered.maxDrawdownPct)} | ${r.baseline.trades} | ${r.filtered.trades} | ${r.delta.trades}`)
  ].join('\n');
  fs.mkdirSync(opts.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const txtPath = path.join(opts.out, `live-mum-karsilastirma-${stamp}.txt`);
  const jsonPath = path.join(opts.out, `live-mum-karsilastirma-${stamp}.json`);
  fs.writeFileSync(txtPath, report + '\n');
  fs.writeFileSync(jsonPath, JSON.stringify({ options: opts, method: 'closed-signal-candle close proxy; next-open fills; not intrabar stream replay', coverage: coverageRows, rows }, null, 2));
  console.log(report);
  console.error(`\nRaporlar: ${txtPath}\n           ${jsonPath}`);
}
if (require.main === module) {
  main().catch(e => { console.error(`Hata: ${e.message}`); process.exitCode = 1; });
}

module.exports = { parseArgs, withCloseConfirmation, main };
