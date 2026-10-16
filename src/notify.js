// src/notify.js
//
// Bildirim gonderici. Uc kanal, hepsi istege bagli (.env ile ayarlanir):
//   * Telegram:  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   * Termux:    NOTIFY_TERMUX=1   (pkg install termux-api + Termux:API uygulamasi gerekir)
//   * Nabiz:     HEALTHCHECK_URL   (ornegin healthchecks.io ping adresi). Bot her turda bu
//                adrese GET atar; ping KESILIRSE (telefon kapandi/bot coktu/internet gitti)
//                servis sana haber verir. Bot cokmus ya da telefon olmusse kendi kendine
//                bildirim GONDEREMEZ, bu yuzden bu kanal onemlidir.
//
// send() ASLA hata firlatmaz: bildirim yollanamadi diye bot durmamali.

const { execFile } = require('child_process');

function createNotifier({ env = process.env, fetchFn = globalThis.fetch, execFn = execFile, logger = console, now = () => Date.now() } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN || '';
  const chatId = env.TELEGRAM_CHAT_ID || '';
  // Token URL yolunda tasinir: ozel taban yalnizca acikca izin verilirse (yerel test) kullanilir.
  const tgBase = (env.TELEGRAM_API_BASE && env.ALLOW_LOCAL_EXCHANGE_URLS === '1' ? env.TELEGRAM_API_BASE : 'https://api.telegram.org').replace(/\/+$/, '');
  const termux = env.NOTIFY_TERMUX === '1' || env.NOTIFY_TERMUX === 'true';
  const healthUrl = env.HEALTHCHECK_URL || '';

  const lastByKey = new Map();
  const warned = new Set();
  let lastPing = 0;

  const status = () => ({ telegram: !!(token && chatId), termux, healthcheck: !!healthUrl });

  // Hata mesajlarinda token sizmasin.
  const scrub = (msg) => (token ? String(msg).split(token).join('***') : String(msg));
  const warnOnce = (channel, err) => {
    if (warned.has(channel)) return;
    warned.add(channel);
    logger.warn(`[bildirim] ${channel} gonderilemedi: ${scrub(err && err.message ? err.message : err)} (bu uyari bir kez gosterilir)`);
  };

  async function timedFetch(url, opts, ms = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetchFn(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendTelegram(text) {
    const res = await timedFetch(`${tgBase}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  function sendTermux(title, text) {
    return new Promise((resolve, reject) => {
      execFn('termux-notification', ['--title', title, '--content', text], { timeout: 8000 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  // key + minIntervalMs: ayni tur olayin (ornegin "veri kesildi") sik sik tekrarlanmasini onler.
  async function send(text, { key, minIntervalMs = 0, title = 'AL-SAT' } = {}) {
    try {
      if (key && minIntervalMs > 0) {
        const last = lastByKey.get(key);
        const t = now();
        if (last !== undefined && t - last < minIntervalMs) return { skipped: true };
        lastByKey.set(key, t);
      }
      const st = status();
      const result = {};
      if (st.telegram) result.telegram = await sendTelegram(text).then(() => true, (e) => (warnOnce('telegram', e), false));
      if (st.termux) result.termux = await sendTermux(title, text).then(() => true, (e) => (warnOnce('termux', e), false));
      return result;
    } catch (e) {
      warnOnce('genel', e);
      return {};
    }
  }

  // Nabiz: en fazla 30 saniyede bir.
  async function ping() {
    if (!healthUrl) return false;
    const t = now();
    if (t - lastPing < 30000) return false;
    lastPing = t;
    try {
      const res = await timedFetch(healthUrl, { method: 'GET' }, 8000);
      return res.ok;
    } catch (e) {
      warnOnce('nabiz', e);
      return false;
    }
  }

  return { send, ping, status };
}

module.exports = { createNotifier };
