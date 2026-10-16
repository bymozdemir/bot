'use strict';
const { istanbulParts } = require('./istanbulTime');
const {
  toMs, fmtPrice, signedPct, formatTradeClosedMessage, formatPositionOpenedMessage
} = require('./telegramExtras');

// Otomatik Telegram uyarıları. Motor dosyalarına dokunmaz; her turda state'in bir görüntüsünü (snapshot) okur:
//  - işlem açıldı / kapandı
//  - günlük zarar limiti %80 ve %100
//  - kill switch devreye girdi / kaldırıldı
//  - fiyat stop'a yaklaştı
//  - borsadan veri gelmiyor / veri geri geldi
// Aynı uyarı tekrar tekrar gönderilmez (günlük/kalıcı kilitler). Gönderim başarısızsa uyarı işaretlenmez, 1 dk sonra tekrar denenir.
function createAlertMonitor({
  getSnapshot, send, getPersisted = () => ({}), setPersisted = () => {},
  nowFn = () => Date.now(), logger = console, intervalMs = 10000,
  config = {}
} = {}) {
  const cfg = {
    trade: config.trade !== false, risk: config.risk !== false, data: config.data !== false,
    stopWarnPct: Number.isFinite(Number(config.stopWarnPct)) && Number(config.stopWarnPct) > 0 ? Number(config.stopWarnPct) : 1,
    staleMinutes: Number.isFinite(Number(config.staleMinutes)) && Number(config.staleMinutes) > 0 ? Number(config.staleMinutes) : 5,
    staleReminderMinutes: Number.isFinite(Number(config.staleReminderMinutes)) && Number(config.staleReminderMinutes) > 0 ? Number(config.staleReminderMinutes) : 30,
    retryMs: Number.isFinite(Number(config.retryMs)) && Number(config.retryMs) >= 0 ? Number(config.retryMs) : 60000,
    maxTradeMessages: 5
  };
  let timer = null; let busy = false; let seeded = false;
  const knownTrades = new Set();
  const knownPositions = new Map(); // symbol -> key
  const stopArmed = new Set();
  const failedUntil = new Map();
  const data = { stale: false, since: 0, lastReminder: 0 };

  const tradeKey = (t) => `${t.symbol}|${t.openedAt ?? ''}|${t.closedAt ?? ''}`;
  const posKey = (p) => `${p.symbol}|${p.openedAt ?? ''}`;

  // true: iletildi (ya da hiç kanal yok); false: tüm kanallar başarısız -> işaretleme, sonra tekrar dene.
  async function deliver(key, text) {
    const now = nowFn();
    if ((failedUntil.get(key) || 0) > now) return false;
    let result;
    try { result = await send(text); } catch (err) { logger.warn(`[uyarı] gönderilemedi: ${String(err && err.message || err)}`); failedUntil.set(key, now + cfg.retryMs); return false; }
    const values = Object.values(result || {});
    if (values.length > 0 && values.every((ok) => ok === false)) { failedUntil.set(key, now + cfg.retryMs); return false; }
    failedUntil.delete(key);
    return true;
  }

  function persisted() { const p = getPersisted(); return p && typeof p === 'object' ? { ...p } : {}; }

  async function checkTrades(snap) {
    const trades = (Array.isArray(snap.trades) ? snap.trades : []).filter((t) => t && Number.isFinite(toMs(t.closedAt)));
    const positions = Array.isArray(snap.positions) ? snap.positions : [];
    if (!seeded) {
      for (const t of trades) knownTrades.add(tradeKey(t));
      for (const p of positions) knownPositions.set(String(p.symbol), posKey(p));
      return;
    }
    // Açılan pozisyonlar
    const present = new Set(positions.map((p) => String(p.symbol)));
    for (const sym of [...knownPositions.keys()]) if (!present.has(sym)) knownPositions.delete(sym);
    for (const p of positions) {
      const sym = String(p.symbol); const key = posKey(p);
      if (knownPositions.get(sym) === key) continue;
      if (await deliver(`open:${key}`, formatPositionOpenedMessage(p, snap.quoteAsset))) knownPositions.set(sym, key);
    }
    // Kapanan işlemler (eskiden yeniye)
    const fresh = trades.filter((t) => !knownTrades.has(tradeKey(t))).sort((a, b) => toMs(a.closedAt) - toMs(b.closedAt));
    if (!fresh.length) return;
    const toSend = fresh.slice(-cfg.maxTradeMessages);
    for (const t of fresh.slice(0, fresh.length - toSend.length)) knownTrades.add(tradeKey(t)); // çok eskiler sessiz işaretlenir
    for (const t of toSend) {
      if (await deliver(`close:${tradeKey(t)}`, formatTradeClosedMessage(t, snap.quoteAsset))) knownTrades.add(tradeKey(t));
    }
    if (knownTrades.size > 5000) { const keep = [...knownTrades].slice(-2000); knownTrades.clear(); keep.forEach((k) => knownTrades.add(k)); }
  }

  async function checkRisk(snap) {
    const now = nowFn();
    const dateKey = (istanbulParts(now) || {}).dateKey || '';
    let p = persisted();
    // Günlük zarar limiti
    const day = Number(snap.dayPnlPct); const limit = Number(snap.dailyLimitPct);
    if (Number.isFinite(day) && Number.isFinite(limit) && limit > 0) {
      if (p.dayKey !== dateKey) { p = { ...p, dayKey: dateKey, l80: false, l100: false }; setPersisted(p); }
      const loss = Math.max(0, -day); const ratio = loss / limit;
      if (ratio >= 1 && !p.l100) {
        const text = `🚨 GÜNLÜK ZARAR LİMİTİ DOLDU\nBugünkü zarar: %${Number(loss.toFixed(2))} | Limit: %${Number(limit.toFixed(2))}\nBotun bu durumdaki davranışı ayarlara bağlıdır; /durum ve /ayarlar ile kontrol et.`;
        if (await deliver('risk:l100', text)) { p = { ...p, l100: true, l80: true }; setPersisted(p); }
      } else if (ratio >= 0.8 && ratio < 1 && !p.l80) {
        const text = `⚠ GÜNLÜK ZARAR LİMİTİNİN %80'İNE ULAŞILDI\nBugünkü zarar: %${Number(loss.toFixed(2))} | Limit: %${Number(limit.toFixed(2))}`;
        if (await deliver('risk:l80', text)) { p = { ...p, l80: true }; setPersisted(p); }
      }
    }
    // Kill switch
    const ks = snap.killSwitch || null;
    if (ks) {
      const obj = typeof ks === 'object' ? ks : {};
      const reason = obj.reason ? String(obj.reason) : '';
      const key = `${reason}|${obj.at ?? obj.t ?? obj.time ?? obj.since ?? ''}` || 'on';
      if (p.killKey !== key) {
        const text = `🛑 KILL SWITCH DEVREYE GİRDİ${reason ? `\nSebep: ${reason.slice(0, 300)}` : ''}\nYeni işlemler engellendi. Kaldırmak için panelden onay gerekir.`;
        if (await deliver('risk:kill', text)) { p = { ...p, killKey: key }; setPersisted(p); }
      }
    } else if (p.killKey) {
      if (await deliver('risk:killoff', '✅ Kill switch kaldırıldı.')) { p = { ...p }; delete p.killKey; setPersisted(p); }
    }
    // Stop'a yaklaşma
    const positions = Array.isArray(snap.positions) ? snap.positions : [];
    const live = new Set();
    for (const pos of positions) {
      const key = posKey(pos); live.add(key);
      const stop = Number(pos.stopPrice); const cur = Number(pos.currentPrice);
      if (!(stop > 0) || !(cur > 0)) continue;
      const dist = ((cur - stop) / cur) * 100;
      if (dist > cfg.stopWarnPct * 2) { stopArmed.delete(key); continue; }
      if (dist > cfg.stopWarnPct || stopArmed.has(key)) continue;
      const entry = Number(pos.entryPrice);
      const open = entry > 0 ? ((cur / entry) - 1) * 100 : NaN;
      const lines = [dist <= 0 ? `⚠ FİYAT STOP SEVİYESİNDE/ALTINDA: ${pos.symbol}` : `⚠ STOP'A YAKLAŞTI: ${pos.symbol}`,
        `Fiyat: ${fmtPrice(cur)} | Stop: ${fmtPrice(stop)} | Uzaklık: %${Number(Math.max(0, dist).toFixed(2))}`];
      if (Number.isFinite(open)) lines.push(`Alış: ${fmtPrice(entry)} (açık K/Z: ${signedPct(open)})`);
      if (await deliver(`stop:${key}`, lines.join('\n'))) stopArmed.add(key);
    }
    for (const k of [...stopArmed]) if (!live.has(k)) stopArmed.delete(k);
  }

  async function checkData(snap) {
    const now = nowFn();
    const age = snap.dataAgeSec === null || snap.dataAgeSec === undefined ? NaN : Number(snap.dataAgeSec);
    if (!snap.running || snap.killSwitch) { data.stale = false; return; }
    if (!Number.isFinite(age) || age < 0) return; // bilinmiyorsa karar verme
    const poll = Number(snap.pollSeconds);
    const thresholdSec = Math.max(cfg.staleMinutes * 60, (Number.isFinite(poll) ? poll : 0) * 4);
    const mins = Math.max(1, Math.round(age / 60));
    if (age >= thresholdSec) {
      if (!data.stale) {
        const text = `📡 VERİ KESİNTİSİ\n${mins} dk'dır borsadan mum/fiyat verisi gelmiyor.\nAğ bağlantısını ve borsa erişimini kontrol et (bazı internet hatları borsayı engelleyebilir). Bu sürede sinyal ve stop kontrolleri gecikebilir.`;
        if (await deliver('data:stale', text)) { data.stale = true; data.since = now - age * 1000; data.lastReminder = now; }
      } else if (now - data.lastReminder >= cfg.staleReminderMinutes * 60000) {
        if (await deliver('data:remind', `📡 VERİ KESİNTİSİ SÜRÜYOR\n${mins} dk'dır veri gelmiyor.`)) data.lastReminder = now;
      }
    } else if (data.stale) {
      const lasted = Math.max(1, Math.round((now - data.since) / 60000));
      if (await deliver('data:ok', `✅ VERİ GERİ GELDİ\nKesinti yaklaşık ${lasted} dk sürdü.`)) data.stale = false;
    }
  }

  async function check() {
    if (busy) return false;
    busy = true;
    try {
      const snap = getSnapshot();
      if (!snap) return false;
      if (cfg.trade) { try { await checkTrades(snap); } catch (e) { logger.warn(`[uyarı] işlem kontrolü: ${String(e && e.message || e)}`); } }
      if (cfg.risk) { try { await checkRisk(snap); } catch (e) { logger.warn(`[uyarı] risk kontrolü: ${String(e && e.message || e)}`); } }
      if (cfg.data) { try { await checkData(snap); } catch (e) { logger.warn(`[uyarı] veri kontrolü: ${String(e && e.message || e)}`); } }
      seeded = true;
      return true;
    } catch (err) {
      logger.warn(`[uyarı] kontrol başarısız: ${String(err && err.message || err)}`);
      return false;
    } finally { busy = false; }
  }

  function start() {
    if (timer) return false;
    timer = setInterval(() => { check().catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();
    check().catch(() => {});
    return true;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start, stop, check, config: cfg };
}

module.exports = { createAlertMonitor };
