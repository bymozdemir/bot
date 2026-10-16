'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlertMonitor } = require('../src/alerts');

// 2026-10-15 12:00 İstanbul
const T0 = Date.UTC(2026, 9, 15, 9, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function makeMonitor(initial = {}, options = {}) {
  const sent = [];
  let now = T0; let persisted = {}; let snap = {
    running: true, mode: 'paper', killSwitch: null, quoteAsset: 'USDT', dayPnlPct: 0, dailyLimitPct: 5,
    positions: [], trades: [], dataAgeSec: 10, pollSeconds: 30, ...initial
  };
  let sendResult = { telegram: true };
  const monitor = createAlertMonitor({
    getSnapshot: () => snap,
    send: async (text) => { sent.push(text); if (options.throwOnSend) throw new Error('ağ'); return sendResult; },
    getPersisted: () => persisted, setPersisted: (o) => { persisted = o; },
    nowFn: () => now, logger: { warn() {} }, config: options.config || {}
  });
  return {
    monitor, sent,
    set: (patch) => { snap = { ...snap, ...patch }; },
    advance: (ms) => { now += ms; }, setNow: (v) => { now = v; },
    setSendResult: (r) => { sendResult = r; }, persisted: () => persisted
  };
}

const trade = (over = {}) => ({ symbol: 'PEPE/USDT', openedAt: iso(T0 - 3600000), closedAt: iso(T0 - 60000), entryPrice: 0.2, exitPrice: 0.19, quantity: 1000, pnl: -10, pnlPct: -5, reason: 'stop', ...over });
const pos = (over = {}) => ({ symbol: 'BTC/USDT', entryPrice: 67000, quantity: 0.01, costQuote: 670, stopPrice: 65000, currentPrice: 68000, openedAt: iso(T0 - 600000), quoteAsset: 'USDT', ...over });

test('ilk kontrol mevcut işlem ve pozisyonları sessizce kaydeder (yeniden başlatmada eski mesajlar gelmez)', async () => {
  const m = makeMonitor({ trades: [trade()], positions: [pos()] });
  await m.monitor.check();
  assert.equal(m.sent.length, 0);
  await m.monitor.check();
  assert.equal(m.sent.length, 0);
});

test('yeni kapanan işlem bir kez bildirilir (sebep ve K/Z ile)', async () => {
  const m = makeMonitor();
  await m.monitor.check();
  m.set({ trades: [trade()] });
  await m.monitor.check(); await m.monitor.check();
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0], /🔴 İŞLEM KAPANDI: PEPE\/USDT/);
  assert.match(m.sent[0], /K\/Z: -10\.00 USDT \(-5\.00%\)/);
  assert.match(m.sent[0], /Sebep: Stop/);
  m.set({ trades: [trade(), trade({ symbol: 'BTC/USDT', closedAt: iso(T0), pnl: 5, pnlPct: 1, reason: 'take_profit' })] });
  await m.monitor.check();
  assert.equal(m.sent.length, 2);
  assert.match(m.sent[1], /🟢 İŞLEM KAPANDI: BTC\/USDT/);
});

test('çok sayıda yeni işlem en fazla 5 mesaja indirilir', async () => {
  const m = makeMonitor();
  await m.monitor.check();
  m.set({ trades: Array.from({ length: 9 }, (_, i) => trade({ closedAt: iso(T0 - 600000 + i * 1000) })) });
  await m.monitor.check(); await m.monitor.check();
  assert.equal(m.sent.length, 5);
});

test('yeni pozisyon açılınca bildirilir; kapanıp yeniden açılırsa tekrar bildirilir', async () => {
  const m = makeMonitor();
  await m.monitor.check();
  m.set({ positions: [pos()] });
  await m.monitor.check(); await m.monitor.check();
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0], /POZİSYON AÇILDI: BTC\/USDT/);
  assert.match(m.sent[0], /Alış: 67000 \| Adet: 0\.01 \| Tutar: 670\.00 USDT/);
  assert.match(m.sent[0], /Stop: 65000 \(-2\.99%\)/);
  m.set({ positions: [] }); await m.monitor.check();
  m.set({ positions: [pos({ openedAt: iso(T0 + 1000) })] }); await m.monitor.check();
  assert.equal(m.sent.length, 2);
});

test('pozisyon ortalama fiyatı değişse de (aynı açılış zamanı) tekrar "açıldı" denmez', async () => {
  const m = makeMonitor();
  await m.monitor.check();
  m.set({ positions: [pos()] }); await m.monitor.check();
  m.set({ positions: [pos({ entryPrice: 66500, quantity: 0.02 })] }); await m.monitor.check();
  assert.equal(m.sent.length, 1);
});

test('günlük zarar limiti: %80 bir kez, %100 bir kez; ertesi gün yeniden', async () => {
  const m = makeMonitor();
  await m.monitor.check();
  m.set({ dayPnlPct: -3 }); await m.monitor.check();
  assert.equal(m.sent.length, 0);
  m.set({ dayPnlPct: -4.1 }); await m.monitor.check(); await m.monitor.check();
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0], /%80'İNE ULAŞILDI/);
  m.set({ dayPnlPct: -5.2 }); await m.monitor.check(); await m.monitor.check();
  assert.equal(m.sent.length, 2);
  assert.match(m.sent[1], /LİMİTİ DOLDU/);
  m.set({ dayPnlPct: -4.5 }); await m.monitor.check();
  assert.equal(m.sent.length, 2); // limit altına dönünce tekrar %80 mesajı yok
  m.advance(24 * 3600 * 1000);
  m.set({ dayPnlPct: -4.2 }); await m.monitor.check();
  assert.equal(m.sent.length, 3);
});

test('doğrudan %100 aşılırsa yalnızca "doldu" gider, sonra %80 mesajı gelmez', async () => {
  const m = makeMonitor();
  await m.monitor.check();
  m.set({ dayPnlPct: -6 }); await m.monitor.check(); m.set({ dayPnlPct: -4.5 }); await m.monitor.check();
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0], /LİMİTİ DOLDU/);
});

test('kill switch: devreye girince bir kez, kalkınca bir kez; yeniden başlatmada tekrar yok', async () => {
  const m = makeMonitor();
  await m.monitor.check();
  m.set({ killSwitch: { reason: 'toplam zarar %20', at: 'x' } });
  await m.monitor.check(); await m.monitor.check();
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0], /KILL SWITCH DEVREYE GİRDİ\nSebep: toplam zarar %20/);
  // aynı kalıcı durumla yeni izleyici (yeniden başlatma): tekrar bildirmez
  const persisted = m.persisted();
  let againCalls = 0;
  const again = createAlertMonitor({ getSnapshot: () => ({ running: true, killSwitch: { reason: 'toplam zarar %20', at: 'x' }, positions: [], trades: [] }), send: async () => { againCalls++; return { telegram: true }; }, getPersisted: () => persisted, setPersisted() {}, nowFn: () => T0, logger: { warn() {} } });
  await again.check(); await again.check();
  assert.equal(againCalls, 0);
  m.set({ killSwitch: null }); await m.monitor.check();
  assert.equal(m.sent.length, 2);
  assert.match(m.sent[1], /Kill switch kaldırıldı/);
});

test('stop yakınlığı: eşikte bir kez, uzaklaşıp yeniden yaklaşınca tekrar', async () => {
  const m = makeMonitor({ positions: [pos({ currentPrice: 68000 })] });
  await m.monitor.check();
  m.set({ positions: [pos({ currentPrice: 65500 })] }); // (65500-65000)/65500 = %0.76
  await m.monitor.check(); await m.monitor.check();
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0], /STOP'A YAKLAŞTI: BTC\/USDT/);
  assert.match(m.sent[0], /Fiyat: 65500 \| Stop: 65000 \| Uzaklık: %0\.76/);
  m.set({ positions: [pos({ currentPrice: 65900 })] }); await m.monitor.check(); // eşik içinde ama tetikli: tekrar yok
  assert.equal(m.sent.length, 1);
  m.set({ positions: [pos({ currentPrice: 68000 })] }); await m.monitor.check(); // eşiğin 2 katından uzak: yeniden silahlanır
  m.set({ positions: [pos({ currentPrice: 65400 })] }); await m.monitor.check();
  assert.equal(m.sent.length, 2);
  const m2 = makeMonitor({ positions: [pos({ currentPrice: 68000 })] }); await m2.monitor.check();
  m2.set({ positions: [pos({ currentPrice: 64900 })] }); await m2.monitor.check();
  assert.match(m2.sent[0], /STOP SEVİYESİNDE\/ALTINDA/);
});

test('stop uyarısı: stop veya fiyat yoksa sessiz kalır', async () => {
  const m = makeMonitor({ positions: [pos({ stopPrice: null })] });
  await m.monitor.check(); await m.monitor.check();
  m.set({ positions: [pos({ currentPrice: null })] }); await m.monitor.check();
  assert.equal(m.sent.length, 0);
});

test('veri kesintisi: eşikte uyarı, 30 dk sonra hatırlatma, dönünce "geri geldi"', async () => {
  const m = makeMonitor();
  await m.monitor.check();
  m.set({ dataAgeSec: 200 }); await m.monitor.check();
  assert.equal(m.sent.length, 0); // 5 dk eşiğinin altında
  m.set({ dataAgeSec: 360 }); await m.monitor.check(); await m.monitor.check();
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0], /VERİ KESİNTİSİ\n6 dk'dır borsadan mum\/fiyat verisi gelmiyor/);
  m.advance(10 * 60000); m.set({ dataAgeSec: 960 }); await m.monitor.check();
  assert.equal(m.sent.length, 1);
  m.advance(25 * 60000); m.set({ dataAgeSec: 2460 }); await m.monitor.check();
  assert.equal(m.sent.length, 2);
  assert.match(m.sent[1], /SÜRÜYOR/);
  m.set({ dataAgeSec: 5 }); await m.monitor.check();
  assert.equal(m.sent.length, 3);
  assert.match(m.sent[2], /VERİ GERİ GELDİ/);
});

test('veri kesintisi: bot durmuşsa, kill switch açıksa veya bilgi yoksa uyarı yok', async () => {
  const a = makeMonitor({ running: false, dataAgeSec: 9999 }); await a.monitor.check(); await a.monitor.check();
  const b = makeMonitor({ killSwitch: { reason: 'x' }, dataAgeSec: 9999 }); await b.monitor.check(); await b.monitor.check();
  const c = makeMonitor({ dataAgeSec: null }); await c.monitor.check(); await c.monitor.check();
  assert.equal(a.sent.length, 0);
  assert.equal(b.sent.filter((x) => /VERİ/.test(x)).length, 0);
  assert.equal(c.sent.length, 0);
});

test('uzun poll aralığında eşik 4 x pollSeconds olur', async () => {
  const m = makeMonitor({ pollSeconds: 300 });
  await m.monitor.check();
  m.set({ dataAgeSec: 600 }); await m.monitor.check();
  assert.equal(m.sent.length, 0);
  m.set({ dataAgeSec: 1300 }); await m.monitor.check();
  assert.equal(m.sent.length, 1);
});

test('gönderim başarısızsa uyarı işaretlenmez, bekleme süresinden sonra tekrar denenir', async () => {
  const m = makeMonitor({}, { config: { retryMs: 60000 } });
  await m.monitor.check();
  m.setSendResult({ telegram: false });
  m.set({ trades: [trade()] });
  await m.monitor.check(); await m.monitor.check();
  assert.equal(m.sent.length, 1); // bekleme süresi içinde yeniden denenmedi
  m.advance(61000); m.setSendResult({ telegram: true });
  await m.monitor.check();
  assert.equal(m.sent.length, 2);
  await m.monitor.check();
  assert.equal(m.sent.length, 2);
});

test('send hata fırlatırsa izleyici çökmez', async () => {
  const m = makeMonitor({}, { throwOnSend: true });
  await m.monitor.check();
  m.set({ trades: [trade()] });
  assert.equal(await m.monitor.check(), true);
});

test('config ile türler tek tek kapatılabilir', async () => {
  const m = makeMonitor({}, { config: { trade: false, risk: false, data: false } });
  await m.monitor.check();
  m.set({ trades: [trade()], positions: [pos({ currentPrice: 65200 })], dayPnlPct: -9, dataAgeSec: 9999, killSwitch: { reason: 'x' } });
  await m.monitor.check();
  assert.equal(m.sent.length, 0);
});
