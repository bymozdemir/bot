'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramCommands } = require('../src/telegramCommands');
const extras = require('../src/telegramExtras');

const NOW = Date.UTC(2026, 9, 15, 15, 0, 0);
const iso = (d, h, m) => new Date(Date.UTC(2026, 9, d, h, m)).toISOString();
const TOKEN = '123456789:AAEhBP0abcdefghijklmnopqrstuvwxyz12345';

const trades = [
  { symbol: 'PEPE/USDT', openedAt: iso(15, 7, 2), closedAt: iso(15, 11, 45), entryPrice: 0.2, exitPrice: 0.19, quantity: 1000, pnl: -10, pnlPct: -5, reason: 'stop' },
  { symbol: 'BTC/USDT', openedAt: iso(14, 9, 0), closedAt: iso(14, 18, 30), entryPrice: 67000, exitPrice: 68200, quantity: 0.01, pnl: 12, pnlPct: 1.79, reason: 'signal_exit' },
  { symbol: 'ETH/USDT', openedAt: iso(12, 9, 0), closedAt: iso(12, 10, 30), entryPrice: 2400, exitPrice: 2450, quantity: 0.5, pnl: 25, pnlPct: 2.08, reason: 'trailing_stop' },
  { symbol: 'SOL/USDT', openedAt: iso(9, 9, 0), closedAt: iso(9, 12, 0), entryPrice: 150, exitPrice: 140, quantity: 2, pnl: -20, pnlPct: -6.7, reason: 'Stop-loss tetiklendi' },
  { symbol: 'OLD/USDT', openedAt: iso(1, 9, 0), closedAt: iso(1, 12, 0), entryPrice: 1, exitPrice: 1.1, quantity: 10, pnl: 1, pnlPct: 10, reason: 'take_profit' }
];

const baseStatus = {
  mode: 'paper', running: true, killSwitch: false, exchange: 'binance', quoteAsset: 'USDT', cash: 150, totalEquity: 300, positions: 2,
  settings: { defaultBudgetPct: 25, pollSeconds: 30, dailyLossLimitPct: 5, killSwitchLossPct: 20, maxTradeQuote: 100, maxConcurrentPositions: 3, reserveCashPct: 10, paperFeePct: 0.1, paperSlippagePct: 0.05 },
  pairs: {
    'BTC/USDT': { enabled: true, strategyId: 'trend-v1', timeframe: '15m', budgetPct: 20 },
    'PEPE/USDT': { enabled: false, strategyId: 'trend-v1', timeframe: '5m', budgetPct: 10 },
    'ETH/USDT': { enabled: true, strategyId: 'dca', timeframe: '1h', budgetPct: 25 }
  },
  holdings: [{ symbol: 'BTC/USDT', quantity: 0.01, costQuote: 670, marketValue: 680 }],
  decisions: {
    'BTC/USDT': { action: 'hold', reason: 'Pozisyon açık', at: NOW - 120000 },
    'ETH/USDT': { signal: 'none', conditions: [{ name: 'EMA20>EMA50', ok: true }, { name: 'MACD kesişimi', ok: false, detail: 'histogram -0.4' }], at: NOW - 60000 }
  },
  risk: { dayPnlPct: -1, dailyLimitPct: 5, maxDrawdownPct: 7.5 }, reports: { daily: '21:00', weekly: 'her Pazar 20:00' }, lastPrices: { 'BTC/USDT': 68000 }
};

function bot(over = {}) {
  const sent = [];
  const fetchFn = async (url, opts) => { sent.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({ ok: true, result: [] }) }; };
  const status = { ...baseStatus, ...(over.status || {}) };
  const b = createTelegramCommands({
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' }, fetchFn, logger: { log() {}, warn() {} },
    getStatus: () => status, getTrades: () => over.trades || trades, getLogs: () => over.logs || [], now: () => NOW,
    getLabel: over.label === undefined ? () => '' : () => over.label,
    listStrategies: () => [{ id: 'trend-v1', name: 'Trend v1' }, { id: 'dca', name: 'DCA' }],
    getPrice: over.getPrice || (async () => ({ price: 68123.45, source: 'test' }))
  });
  const ask = async (text) => { sent.length = 0; await b.processUpdate({ message: { chat: { id: 42 }, text } }); return sent.slice(); };
  return { b, ask, sent };
}

test('/islemler: en yeni üstte, varsayılan 10, sebep etiketli, sayı argümanı çalışır', async () => {
  const { ask } = bot();
  const [t] = await ask('/islemler');
  assert.match(t, /SON 5 KAPANAN İŞLEM/);
  assert.ok(t.indexOf('PEPE/USDT') < t.indexOf('BTC/USDT') && t.indexOf('BTC/USDT') < t.indexOf('OLD/USDT'));
  assert.match(t, /-10\.00 USDT \(-5\.00%\)/);
  assert.match(t, /Giriş: 0\.2 → Çıkış: 0\.19 \| Adet: 1000/);
  assert.match(t, /Sebep: Stop\n/);
  assert.match(t, /Sebep: Trailing stop/);
  assert.match(t, /Sebep: Kâr al/);
  assert.match(t, /Sebep: Sinyal/);
  const [two] = await ask('/islemler 2');
  assert.match(two, /SON 2 KAPANAN İŞLEM/);
  assert.doesNotMatch(two, /ETH\/USDT/);
});

test('/islemler: kayıt yoksa, 10 sınırı ve işlem süresi', async () => {
  const empty = await bot({ trades: [] }).ask('/islemler');
  assert.match(empty[0], /Henüz kapanan işlem yok/);
  const many = Array.from({ length: 15 }, (_, i) => ({ symbol: 'A/USDT', openedAt: iso(10, 1, 0), closedAt: iso(10, 2 + (i % 10), i), entryPrice: 1, exitPrice: 1.01, quantity: 1, pnl: 0.01, pnlPct: 1, reason: 'sinyal' }));
  const [t] = await bot({ trades: many }).ask('/islemler');
  assert.match(t, /SON 10 KAPANAN İŞLEM/);
  assert.match(t, /Kayıtlı toplam kapanan işlem: 15/);
  assert.match(t, /\(1 sa 0 dk\)|\(2 sa|\(\d+ sa \d+ dk\)/);
});

test('/neden: karar, sağlanan/eksik şartlar, kapalı parite ve açık pozisyon', async () => {
  const [t] = await bot().ask('/neden');
  assert.match(t, /BOT NEDEN BEKLİYOR/);
  assert.match(t, /BTC\/USDT \(15m · Trend v1\)/);
  assert.match(t, /Açık pozisyon var/);
  assert.match(t, /Son karar: bekle — Pozisyon açık/);
  assert.match(t, /PEPE\/USDT[\s\S]*Parite kapalı/);
  assert.match(t, /Eksik şart: MACD kesişimi \(histogram -0\.4\)/);
  assert.match(t, /Sağlanan: EMA20>EMA50/);
});

test('/neden: bot durmuş, kill switch, azami pozisyon, günlük limit ve karar kaydı yok uyarıları', async () => {
  const [stopped] = await bot({ status: { running: false, decisions: {} } }).ask('/neden');
  assert.match(stopped, /Bot şu an DURMUŞ/);
  assert.match(stopped, /Henüz karar kaydı yok \(bot durmuş\)/);
  const [ks] = await bot({ status: { killSwitch: true, killSwitchReason: 'toplam zarar limiti' } }).ask('/neden');
  assert.match(ks, /Kill switch AÇIK \(toplam zarar limiti\)/);
  const [full] = await bot({ status: { settings: { ...baseStatus.settings, maxConcurrentPositions: 1 } } }).ask('/neden');
  assert.match(full, /Azami pozisyon sayısına ulaşıldı \(1\/1\)/);
  const [lim] = await bot({ status: { risk: { dayPnlPct: -5.5, dailyLimitPct: 5 } } }).ask('/neden');
  assert.match(lim, /Günlük zarar limiti doldu/);
});

test('/neden: bilinmeyen karar biçimleri tolerans ile okunur (metin, dizi, harita, serbest alanlar)', async () => {
  const decisions = {
    'BTC/USDT': 'RSI çok yüksek',
    'ETH/USDT': { decision: 'buy', reasons: ['trend yukarı', 'hacim yeterli'] },
    'PEPE/USDT': { foo: 'bar', score: 0.7 }
  };
  const status = { decisions, holdings: [], pairs: { 'BTC/USDT': { enabled: true, timeframe: '15m' }, 'ETH/USDT': { enabled: true, timeframe: '1h' }, 'PEPE/USDT': { enabled: true, timeframe: '5m' } } };
  const [t] = await bot({ status }).ask('/neden');
  assert.match(t, /RSI çok yüksek/);
  assert.match(t, /Son sinyal: AL/);
  assert.match(t, /trend yukarı; hacim yeterli/);
  assert.match(t, /foo: bar \| score: 0\.7/);
  const map = extras.summarizeDecision({ conditions: { trendUp: true, rsiOk: false } });
  assert.deepEqual(map.conds.map((c) => [c.label, c.ok]), [['trendUp', true], ['rsiOk', false]]);
});

test('/neden: eski karar uyarısı', async () => {
  const status = { decisions: { 'BTC/USDT': { action: 'hold', at: NOW - 3 * 3600000 } } };
  const [t] = await bot({ status }).ask('/neden');
  assert.match(t, /karar eski/);
});

test('/haftalik ve /aylik: pencere, kazanma oranı, en iyi/en kötü, düşüş', async () => {
  const [w] = await bot().ask('/haftalik');
  assert.match(w, /HAFTALIK RAPOR \(son 7 gün\)/);
  assert.match(w, /Kapanan işlem: 4 \(2 kazançlı \/ 2 zararlı\) \| Kazanma oranı: %50/);
  assert.match(w, /Gerçekleşen K\/Z: \+7\.00 USDT/);
  assert.match(w, /En iyi: ETH\/USDT \+25\.00 USDT/);
  assert.match(w, /En kötü: SOL\/USDT -20\.00 USDT/);
  assert.match(w, /En büyük düşüş[^\n]*-20\.00 USDT/);
  assert.match(w, /Tüm zamanların en büyük özkaynak düşüşü: %7\.5/);
  assert.doesNotMatch(w, /OLD\/USDT/);
  const [m] = await bot().ask('/aylik');
  assert.match(m, /AYLIK RAPOR \(son 30 gün\)/);
  assert.match(m, /Kapanan işlem: 5/);
  const [none] = await bot({ trades: [] }).ask('/haftalik');
  assert.match(none, /Bu dönemde kapanan işlem yok/);
});

test('/haftalik: birden fazla kasa birimi ayrı hesaplanır', async () => {
  const mixed = [...trades.slice(0, 2), { symbol: 'BTC/TRY', openedAt: iso(14, 1, 0), closedAt: iso(14, 2, 0), entryPrice: 1, exitPrice: 2, quantity: 1, pnl: 100, pnlPct: 100, reason: 'x' }];
  const [w] = await bot({ trades: mixed }).ask('/haftalik');
  assert.match(w, /— USDT —/);
  assert.match(w, /— TRY —/);
  assert.match(w, /\+100\.00 TRY/);
});

test('/coinler ve /ayarlar', async () => {
  const [c] = await bot().ask('/coinler');
  assert.match(c, /3 coin, 2 açık/);
  assert.match(c, /AÇIK — BTC\/USDT/);
  assert.match(c, /KAPALI — PEPE\/USDT/);
  assert.match(c, /Strateji: DCA \(dca\)/);
  assert.match(c, /Mum: 15m \| Bütçe payı: %20/);
  const [s] = await bot().ask('/ayarlar');
  assert.match(s, /Günlük zarar limiti: %5/);
  assert.match(s, /Kill switch \(toplam zarar\): %20/);
  assert.match(s, /İşlem başına üst tutar: 100\.00 USDT/);
  assert.match(s, /Aynı anda azami pozisyon: 3/);
  assert.match(s, /Kill switch kapalı/);
  const [empty] = await bot({ status: { pairs: {} } }).ask('/coinler');
  assert.match(empty, /Listede coin yok/);
});

test('/fiyat: kısa ad kasa birimiyle tamamlanır, hata ve önbellek durumları', async () => {
  let asked = null;
  const ok = bot({ getPrice: async (s) => { asked = s; return { price: 68123.45, source: 'Binance' }; } });
  const [t] = await ok.ask('/fiyat btc');
  assert.equal(asked, 'BTC/USDT');
  assert.match(t, /BTC\/USDT: 68123\.45 USDT/);
  const fail = bot({ getPrice: async () => { throw new Error('ETIMEDOUT'); } });
  assert.match((await fail.ask('/fiyat ETH'))[0], /fiyatı alınamadı: ETIMEDOUT/);
  assert.match((await fail.ask('/fiyat BTC'))[0], /güncel fiyat alınamadı[\s\S]*Son bilinen fiyat[\s\S]*68000/);
  assert.match((await fail.ask('/fiyat ???'))[0], /Parite biçimi hatalı/);
  assert.match((await fail.ask('/fiyat'))[0], /Kullanım: \/fiyat BTC/);
});

test('/log: son olaylar, /log hata filtresi, token ve anahtar maskeleme', async () => {
  const logs = [
    { t: iso(15, 14, 50), msg: 'Tick tamam', level: 'info' },
    { t: iso(15, 14, 55), msg: `Hata apiKey=ABCDEF1234567890ABCDEF12345678901234 token ${TOKEN} Authorization: Bearer abc.def.ghi`, level: 'error' },
    { t: iso(15, 14, 56), msg: 'Yeniden deneniyor', level: 'warn' }
  ];
  const [all] = await bot({ logs }).ask('/log');
  assert.match(all, /SON 3 OLAY/);
  assert.ok(all.indexOf('Yeniden deneniyor') < all.indexOf('Tick tamam'));
  assert.doesNotMatch(all, /ABCDEF1234567890/);
  assert.doesNotMatch(all, /AAEhBP0/);
  assert.doesNotMatch(all, /abc\.def\.ghi/);
  const [err] = await bot({ logs }).ask('/log hata');
  assert.match(err, /HATA\/UYARI/);
  assert.doesNotMatch(err, /Tick tamam/);
  assert.match((await bot({ logs: [] }).ask('/log'))[0], /Kayıtlı olay yok/);
});

test('maskSecrets: token, anahtar ve uzun gizli değerleri gizler, normal metni korur', () => {
  assert.equal(extras.maskSecrets(`bot ${TOKEN} bitti`), 'bot [gizli-token] bitti');
  assert.match(extras.maskSecrets('secret=abc123 ve password: hunter2'), /secret=\*\*\* ve password: \*\*\*/);
  assert.equal(extras.maskSecrets('Fiyat 68000 USDT, BTC/USDT 15m'), 'Fiyat 68000 USDT, BTC/USDT 15m');
  assert.equal(extras.maskSecrets('özel değer xyz-SECRET-999', ['xyz-SECRET-999']), 'özel değer ***');
});

test('/yardim, /help, /yardım, /start: tüm komutlar ve açıklamaları listelenir', async () => {
  for (const cmd of ['/yardim', '/help', '/yardım', '/start']) {
    const [t] = await bot().ask(cmd);
    for (const c of ['/durum', '/bakiye', '/pozisyonlar', '/rapor', '/islemler', '/neden', '/haftalik', '/aylik', '/coinler', '/ayarlar', '/fiyat', '/log', '/basla', '/bitir', '/coin_ekle', '/onayla', '/iptal', '/yardim']) {
      assert.ok(t.includes(c), `${cmd} yardımında ${c} yok`);
    }
    assert.match(t, /Otomatik bildirimler: günlük rapor \(her gün 21:00\), haftalık rapor \(her Pazar 20:00\)/);
    assert.match(t, /son kapanan işlemler/);
  }
});

test('etiket: her yanıtın başına eklenir; uzun mesaj bölünür ve etiket yalnızca ilk parçada olur', async () => {
  const [t] = await bot({ label: '[PAPER · Binance]' }).ask('/ayarlar');
  assert.ok(t.startsWith('[PAPER · Binance] ⚙ AYARLAR'));
  const many = Array.from({ length: 400 }, (_, i) => ({ symbol: `C${i}/USDT`, openedAt: iso(10, 1, 0), closedAt: iso(10, 2, 0), entryPrice: 1, exitPrice: 1, quantity: 1, pnl: 0, pnlPct: 0, reason: 'x'.repeat(60) }));
  const pairs = Object.fromEntries(many.map((m) => [m.symbol, { enabled: true, strategyId: 'trend-v1', timeframe: '15m', budgetPct: 5 }]));
  const parts = await bot({ label: '[PAPER · Binance]', status: { pairs } }).ask('/coinler');
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.ok(parts[0].startsWith('[PAPER · Binance]'));
  assert.ok(!parts[1].startsWith('[PAPER'));
});

test('yeni komutlar yetkisiz sohbete yanıt vermez; biçimlendirme hatası komutu sessiz bırakmaz', async () => {
  const sent = [];
  const fetchFn = async (url, opts) => { sent.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({ ok: true, result: [] }) }; };
  const b = createTelegramCommands({ env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' }, fetchFn, logger: { log() {}, warn() {} },
    getStatus: () => baseStatus, getTrades: () => { throw new Error('bozuk kayıt'); } });
  for (const c of ['/islemler', '/neden', '/haftalik', '/aylik', '/coinler', '/ayarlar', '/fiyat BTC', '/log']) {
    assert.equal(await b.processUpdate({ message: { chat: { id: 99 }, text: c } }), false);
  }
  assert.equal(sent.length, 0);
  await b.processUpdate({ message: { chat: { id: 42 }, text: '/islemler' } });
  assert.match(sent[0], /⛔ \/islemler hazırlanamadı: bozuk kayıt/);
});

test('/durum: motor kontrol satırı yalnızca bilgi varsa görünür', async () => {
  assert.doesNotMatch((await bot().ask('/durum'))[0], /Son motor kontrolü/);
  assert.match((await bot({ status: { dataAgeSec: 42 } }).ask('/durum'))[0], /Son motor kontrolü: 42 sn önce/);
  assert.match((await bot({ status: { dataAgeSec: 600 } }).ask('/durum'))[0], /Son motor kontrolü: 10 dk önce/);
});
