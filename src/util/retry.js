// src/util/retry.js
// Mobil veri / Wi-Fi geciscisinde ag istekleri ara sira zaman asimina ugrar
// ya da gecici 5xx doner. Bu sarmalayici olmadan tek bir basarisiz istek
// tum tick() turunu Promise reddiyle kesebilirdi (paperEngine zaten sembol
// basina try/catch yapiyor ama gereksiz yere "hata" olarak loglanip alim/satim
// firsati kacar). Burada kisa bir yeniden deneme ile gecici sorunlar sessizce
// asilir.

const { applyNetworkDefaults, explainNetworkError } = require('./network');
applyNetworkDefaults();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, opts = {}, { retries = 2, timeoutMs = 10000, backoffMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res = await fetch(url, { ...opts, signal: controller.signal });
      // Zaman aşımı sayacı YALNIZCA başlıklar gelince değil, GÖVDE de okunana kadar açık kalmalı. Eskiden başlıktan
      // hemen sonra durduruluyordu: sunucu başlığı gönderip gövdeyi yarıda bırakırsa çağıranın res.json()'ı sonsuza
      // dek asılı kalıyor, canlı motor turu (stop yeniden kurma, risk kapısı) ve emir sonucu bekleyen çağrı kilitleniyordu.
      // Gövde burada, süre sınırı altında tamponlanır; çağıran aynı arayüzle (json/text/status/headers) devam eder.
      if (typeof Response !== 'undefined' && res instanceof Response && ![101, 204, 205, 304].includes(res.status)) {
        const buf = await res.arrayBuffer();
        res = new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      clearTimeout(timer);
      // 418 = IP yasaklandi: istek gondermeye devam etmek yasagi UZATIR; tekrar denenmez, hata olarak yukari verilir.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfterRaw = res.headers?.get?.('retry-after');
        const retryAfter = Number(retryAfterRaw);
        const serverDelay = Number.isFinite(retryAfter) && retryAfter >= 0
          ? (retryAfter < 1000 ? retryAfter * 1000 : retryAfter)
          : 0;
        const jitter = Math.floor(Math.random() * Math.max(25, backoffMs * 0.25));
        const delay = Math.min(30000, Math.max(backoffMs * (attempt + 1), serverDelay) + jitter);
        lastErr = new Error(`HTTP ${res.status}`);
        lastErr.httpStatus = res.status;
        lastErr.retryAfterMs = delay;
        await sleep(delay);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        lastErr = new Error(`zaman aşımı (${timeoutMs}ms) — ${explainNetworkError('zaman aşımı')}`);
      } else {
        // Node'un fetch'i (undici) ag hatalarinda genelde sadece "fetch failed"
        // mesaji verir, gercek sebep (DNS bulunamadi, sertifika hatasi, baglanti
        // reddedildi...) e.cause icinde saklidir. Log'da sadece e.message
        // okunacagi icin (paperEngine.js) gercek sebebi buraya, mesajin icine
        // gomuyoruz -- yoksa "fetch failed" yazip gercek nedeni gizliyordu.
        const cause = e.cause;
        const causeMsg = cause ? cause.code || cause.message || String(cause) : null;
        const hint = explainNetworkError(causeMsg || e.message);
        lastErr = causeMsg ? new Error(`${e.message} (${causeMsg})${hint ? ' — ' + hint : ''}`) : e;
      }
      if (attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr;
}

module.exports = { fetchWithRetry, sleep };
