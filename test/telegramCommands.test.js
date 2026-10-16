'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramCommands } = require('../src/telegramCommands');

function make(env = { TELEGRAM_BOT_TOKEN: '123:ABC', TELEGRAM_CHAT_ID: '42' }, overrides = {}) {
  const requests = [];
  const fetchFn = async (url, opts) => {
    requests.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: [] }) };
  };
  const status = { mode: 'paper', running: true, killSwitch: false, exchange: 'binance', quoteAsset: 'USDT', cash: 150, positions: 1 };
  const actions = { startBot: async () => { status.running = true; }, stopBot: async () => { status.running = false; }, ...overrides };
  const bot = createTelegramCommands({ env, fetchFn, logger: { log() {}, warn() {} }, getStatus: () => status, ...actions });
  return { bot, requests, status };
}

test('Telegram /status yanıt verir ve yalnızca izinli chat kimliğine', async () => {
  const { bot, requests } = make();
  assert.equal(await bot.processUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '/status' } }), true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/bot123:ABC\/sendMessage$/);
  assert.equal(requests[0].body.chat_id, '42');
  assert.match(requests[0].body.text, /Bot: ÇALIŞIYOR/);
  assert.match(requests[0].body.text, /150\.00 USDT/);
  assert.match(requests[0].body.text, /Kontrol zamanı \(İstanbul\): \d{2}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}/);
  assert.equal(await bot.processUpdate({ update_id: 2, message: { chat: { id: 99 }, text: '/status' } }), false);
  assert.equal(requests.length, 1);
});

test('Telegram /start ve /help komutları yardım verir, bilinmeyen komut yok sayılır', async () => {
  const { bot, requests } = make();
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/start' } }), true);
  assert.match(requests[0].body.text, /\/basla/);
  assert.match(requests[0].body.text, /\/bitir/);
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/other' } }), false);
  assert.equal(requests.length, 1);
});

test('token veya chat ID yoksa Telegram komutları etkinleştirilmez', () => {
  assert.equal(make({ TELEGRAM_BOT_TOKEN: 'x' }).bot.configured(), false);
});


test('Telegram /bitir motoru durdurur ama komut yanıtlayıcısı erişilebilir kalır', async () => {
  const { bot, requests, status } = make();
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/bitir' } }), true);
  assert.equal(status.running, false);
  assert.match(requests.at(-1).body.text, /Telegram komut dinleyicisi açık kalıyor/);
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/durum' } }), true);
  assert.match(requests.at(-1).body.text, /Bot: DURDU/);
});

test('Telegram /basla Paper motorunu başlatır; live modda reddeder', async () => {
  const { bot, requests, status } = make();
  status.running = false;
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/basla' } }), true);
  assert.equal(status.running, true);
  assert.match(requests.at(-1).body.text, /başlatma isteği başarıyla/);

  const live = make(undefined, { getStatus: () => ({ mode: 'live', running: false }) });
  assert.equal(await live.bot.processUpdate({ message: { chat: { id: 42 }, text: '/basla' } }), true);
  assert.match(live.requests.at(-1).body.text, /yalnızca Paper mod/);
});


test('Telegram /bakiye nakit, coin miktarı, güncel değer ve maliyeti gösterir', async () => {
  const { bot, requests } = make(undefined, {
    getStatus: () => ({ mode: 'paper', quoteAsset: 'USDT', cash: 127.97, totalEquity: 150,
      holdings: [{ symbol: 'PEPE/USDT', baseAsset: 'PEPE', quantity: 3007500, marketValue: 12.03, costQuote: 12, quoteAsset: 'USDT' }] })
  });
  assert.equal(await bot.processUpdate({ message: { chat: { id: 42 }, text: '/bakiye' } }), true);
  const reply = requests.at(-1).body.text;
  assert.match(reply, /Kullanılabilir nakit: 127.97 USDT/);
  assert.match(reply, /PEPE: 3007500 PEPE/);
  assert.match(reply, /güncel değer: 12.03 USDT/);
  assert.match(reply, /maliyet: 12 USDT/);
  assert.match(reply, /Tahmini toplam özkaynak: 150 USDT/);
});

test('Telegram coin ekleme: hazır indikatör varsayılanları korunur, yalnızca strateji/mum/bütçe/trailing stop seçilir ve onay beklenir', async () => {
  const added = [];
  const strategy = {
    id: 'demo', name: 'Demo strateji', description: 'Test',
    defaultParams: { rsiBuyBelow: 30, trailingStop: false },
    paramsSchema: [
      { key: 'rsiBuyBelow', label: 'RSI alım eşiği', type: 'number', min: 1, max: 99, step: 1 },
      { key: 'trailingStop', label: 'Trailing stop', type: 'boolean' }
    ],
    validate: (p) => p.rsiBuyBelow > 50 ? 'RSI eşiği test üst sınırını aşıyor.' : null
  };
  const { bot, requests } = make(undefined, {
    getStatus: () => ({ mode: 'paper', running: true, settings: { defaultBudgetPct: 30, pollSeconds: 60 }, pairs: {}, quoteAssets: ['USDT'] }),
    listStrategies: () => [strategy], timeframes: ['15m', '1h'],
    validateTimeframe: () => null,
    addPair: async (pair) => { added.push(pair); return { message: 'Global risk sabit.' }; }
  });
  const send = async (text) => bot.processUpdate({ message: { chat: { id: 42 }, text } });
  await send('/coin_ekle PEPE/USDT');
  assert.equal(added.length, 0);
  await send('1');
  await send('1h');
  await send('10');
  await send('evet');
  assert.equal(added.length, 0, 'özet onaylanana kadar kayıt yok');
  assert.match(requests.at(-1).body.text, /COIN AYAR ÖZETİ/);
  assert.match(requests.at(-1).body.text, /hazır varsayılanlar/);
  assert.match(requests.at(-1).body.text, /Bütçe payı: %10/);
  assert.match(requests.at(-1).body.text, /Trailing stop: AÇIK/);
  assert.doesNotMatch(requests.at(-1).body.text, /işlem saatleri|alım saati/i);
  await send('/onayla');
  assert.equal(added.length, 1);
  assert.equal(added[0].symbol, 'PEPE/USDT');
  assert.equal(added[0].params.rsiBuyBelow, 30, 'indikatörün kodda tanımlı varsayılanı korunmalı');
  assert.equal(added[0].params.trailingStop, true);
  assert.equal(added[0].budgetPct, 10);
  assert.match(requests.at(-1).body.text, /Paper listesine eklendi/);
});

test('Telegram coin ekleme: iptal ve canlı modda reddetme güvenli', async () => {
  const added = [];
  const strategy = { id: 'demo', name: 'Demo', description: '', defaultParams: {}, paramsSchema: [] };
  const common = { listStrategies: () => [strategy], timeframes: ['1h'], validateTimeframe: () => null, addPair: async (p) => added.push(p) };
  const { bot, requests } = make(undefined, {
    ...common,
    getStatus: () => ({ mode: 'paper', running: false, settings: { defaultBudgetPct: 30 }, pairs: {}, quoteAssets: ['USDT'] })
  });
  await bot.processUpdate({ message: { chat: { id: 42 }, text: '/coin_ekle BTC/USDT' } });
  await bot.processUpdate({ message: { chat: { id: 42 }, text: '/iptal' } });
  assert.equal(added.length, 0);
  assert.match(requests.at(-1).body.text, /iptal edildi/);

  const live = make(undefined, { ...common, getStatus: () => ({ mode: 'live', settings: { defaultBudgetPct: 30 }, pairs: {}, quoteAssets: ['USDT'] }) });
  await live.bot.processUpdate({ message: { chat: { id: 42 }, text: '/coin_ekle BTC/USDT' } });
  assert.match(live.requests.at(-1).body.text, /yalnızca Paper modda/);
  assert.equal(added.length, 0);
});

test('Telegram coin ekleme: bütçe payı varsayılan üst sınırını aşamaz', async () => {
  const strategy = { id: 'demo', name: 'Demo', description: '', defaultParams: {}, paramsSchema: [] };
  const { bot, requests } = make(undefined, {
    getStatus: () => ({ mode: 'paper', settings: { defaultBudgetPct: 20 }, pairs: {}, quoteAssets: ['USDT'] }),
    listStrategies: () => [strategy], timeframes: ['1h'], validateTimeframe: () => null,
    addPair: async () => { throw new Error('olmamalı'); }
  });
  const send = async (text) => bot.processUpdate({ message: { chat: { id: 42 }, text } });
  await send('/coin_ekle BTC/USDT');
  await send('1');
  await send('1h');
  await send('25');
  assert.match(requests.at(-1).body.text, /1 ile 20 arasında/);
});
