'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDailyReport, parseTime } = require('../src/dailyReport');
const { istanbulParts } = require('../src/istanbulTime');
const { createTelegramCommands } = require('../src/telegramCommands');

// 2026-10-15 21:00 İstanbul (UTC+3) = 18:00 UTC
const at = (hh, mm, day = 15) => Date.UTC(2026, 9, day, hh - 3, mm, 0);

function makeScheduler(overrides = {}) {
  const sent = []; let last = null; let now = at(20, 59);
  const sched = createDailyReport({
    send: async (text) => { sent.push(text); return overrides.result || { telegram: true }; },
    buildReport: async () => 'RAPOR',
    getLastSentDate: () => last, setLastSentDate: (d) => { last = d; },
    nowFn: () => now, logger: { warn() {} }, ...overrides.options
  });
  return { sched, sent, setNow: (v) => { now = v; }, getLast: () => last };
}

test('istanbulParts İstanbul gününü ve saatini döndürür', () => {
  assert.deepEqual(istanbulParts(Date.UTC(2026, 9, 15, 21, 30)), { dateKey: '2026-10-16', hour: 0, minute: 30 });
  assert.deepEqual(istanbulParts(at(21, 0)), { dateKey: '2026-10-15', hour: 21, minute: 0 });
});

test('parseTime geçersiz değerde 21:00 varsayılanına döner', () => {
  assert.deepEqual(parseTime('20:30'), { hour: 20, minute: 30 });
  assert.deepEqual(parseTime('25:00'), { hour: 21, minute: 0 });
  assert.deepEqual(parseTime('abc'), { hour: 21, minute: 0 });
});

test('rapor saatinden önce gönderilmez, saatinde bir kez gönderilir', async () => {
  const { sched, sent, setNow, getLast } = makeScheduler();
  assert.equal(await sched.check(), false);
  setNow(at(21, 0));
  assert.equal(await sched.check(), true);
  assert.equal(getLast(), '2026-10-15');
  setNow(at(21, 5));
  assert.equal(await sched.check(), false);
  assert.deepEqual(sent, ['RAPOR']);
});

test('ertesi gün yeniden gönderilir', async () => {
  const { sched, sent, setNow } = makeScheduler();
  setNow(at(21, 0)); await sched.check();
  setNow(at(21, 0, 16)); assert.equal(await sched.check(), true);
  assert.equal(sent.length, 2);
});

test('bot geç açılırsa tolerans içinde gönderir, tolerans geçtiyse o günü atlar', async () => {
  const a = makeScheduler(); a.setNow(at(22, 30)); assert.equal(await a.sched.check(), true);
  const b = makeScheduler(); b.setNow(at(23, 30)); assert.equal(await b.sched.check(), false);
  assert.equal(b.sent.length, 0);
});

test('tüm kanallar başarısızsa günü işaretlemez ve tekrar dener', async () => {
  const { sched, sent, setNow, getLast } = makeScheduler({ result: { telegram: false } });
  setNow(at(21, 1));
  assert.equal(await sched.check(), false);
  assert.equal(getLast(), null);
  assert.equal(await sched.check(), false);
  assert.equal(sent.length, 2);
});

test('rapor üretimi hata verirse fırlatmaz', async () => {
  const s = makeScheduler({ options: { buildReport: async () => { throw new Error('boom'); } } });
  s.setNow(at(21, 0));
  assert.equal(await s.sched.check(), false);
});

function bot(status) {
  const requests = [];
  const fetchFn = async (url, opts) => { requests.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true, result: [] }) }; };
  const b = createTelegramCommands({ env: { TELEGRAM_BOT_TOKEN: '1:A', TELEGRAM_CHAT_ID: '42' }, fetchFn, logger: { log() {}, warn() {} }, getStatus: () => status });
  return { b, requests };
}

const richStatus = {
  mode: 'paper', running: true, killSwitch: false, exchange: 'binance', quoteAsset: 'USDT',
  cash: 1, totalEquity: 300, startingEquity: 250, dayStartEquity: 290, uptimeSec: 90000,
  today: { count: 2, wins: 1, pnl: 3.5 },
  holdings: [{ symbol: 'PEPE/USDT', baseAsset: 'PEPE', quantity: 1000, costQuote: 200, quoteAsset: 'USDT', entryPrice: 0.2, currentPrice: 0.299, marketValue: 299 }]
};

test('/pozisyonlar alış, adet, şimdiki fiyat ve K/Z gösterir (1 USDT + 299 USDT = 300 USDT örneği)', async () => {
  const { b, requests } = bot(richStatus);
  assert.equal(await b.processUpdate({ message: { chat: { id: 42 }, text: '/pozisyonlar' } }), true);
  const t = requests[0].text;
  assert.match(t, /PEPE\/USDT/);
  assert.match(t, /Adet: 1000 PEPE/);
  assert.match(t, /Alış: 0\.2 \| Şimdi: 0\.299 USDT/);
  assert.match(t, /Maliyet: 200\.00 → Değer: 299\.00 USDT/);
  assert.match(t, /K\/Z: \+99\.00 USDT \(\+49\.50%\)/);
  assert.match(t, /Nakit: 1\.00 USDT/);
  assert.match(t, /Toplam özkaynak: 300\.00 USDT/);
});

test('/kar ve /rapor aynı yanıtları verir; /rapor çalışma, bugün ve başlangıç K/Z içerir', async () => {
  const { b, requests } = bot(richStatus);
  await b.processUpdate({ message: { chat: { id: 42 }, text: '/kar' } });
  assert.match(requests[0].text, /AÇIK POZİSYONLAR/);
  await b.processUpdate({ message: { chat: { id: 42 }, text: '/rapor' } });
  const t = requests[1].text;
  assert.match(t, /Bot çalışmaya devam ediyor/);
  assert.match(t, /Sunucu: 1 gün 1 sa açık/);
  assert.match(t, /Bugün: \+10\.00 USDT \(\+3\.45%\)/);
  assert.match(t, /Başlangıçtan beri: \+50\.00 USDT \(\+20\.00%\)/);
  assert.match(t, /Bugün kapanan işlem: 2 \(1 kazançlı\)/);
});

test('rapor: bot durmuşsa, kill switch açıksa, pozisyon yoksa, fiyat yoksa doğru ifade kullanılır', async () => {
  const stopped = bot({ ...richStatus, running: false }).b.formatReport();
  assert.match(stopped, /DURMUŞ/);
  const killed = bot({ ...richStatus, killSwitch: true }).b.formatReport();
  assert.match(killed, /Kill switch AÇIK/);
  const empty = bot({ ...richStatus, holdings: [] }).b.formatReport();
  assert.match(empty, /Açık pozisyon yok/);
  const noPrice = bot({ ...richStatus, holdings: [{ ...richStatus.holdings[0], currentPrice: undefined, marketValue: undefined }] }).b.formatPositions();
  assert.match(noPrice, /fiyat yok/);
  assert.match(noPrice, /K\/Z hesaplanamadı/);
});

test('yeni komutlar yetkisiz sohbete yanıt vermez', async () => {
  const { b, requests } = bot(richStatus);
  assert.equal(await b.processUpdate({ message: { chat: { id: 99 }, text: '/rapor' } }), false);
  assert.equal(requests.length, 0);
});

test('haftalık mod: yalnızca seçilen günde (Pazar) ve saatinde bir kez gönderilir', async () => {
  // 2026-10-15 Perşembe, 2026-10-18 Pazar
  const { sched, sent, setNow } = makeScheduler({ options: { weekdays: [0], time: '20:00' } });
  setNow(at(20, 0, 15)); assert.equal(await sched.check(), false); // Perşembe
  setNow(at(20, 0, 17)); assert.equal(await sched.check(), false); // Cumartesi
  setNow(at(19, 59, 18)); assert.equal(await sched.check(), false); // Pazar, saatten önce
  setNow(at(20, 0, 18)); assert.equal(await sched.check(), true); // Pazar 20:00
  setNow(at(20, 30, 18)); assert.equal(await sched.check(), false); // aynı gün ikinci kez yok
  setNow(at(20, 0, 25)); assert.equal(await sched.check(), true); // sonraki Pazar
  assert.equal(sent.length, 2);
});

test('weekdays verilmezse günlük davranış değişmez', async () => {
  const { sched, setNow } = makeScheduler({ options: { weekdays: null } });
  setNow(at(21, 0, 15)); assert.equal(await sched.check(), true);
});
