'use strict';

// Conservative confirmation for a strategy BUY signal using the currently forming
// candle. This is a momentum filter, not a prediction of the next candle.
// Fail closed when the candle/observed price is missing or malformed.
function confirmBuy({ candle, observedPrice, minBodyPct = 0.02, minRangePosition = 0.55 } = {}) {
  if (!candle || typeof candle !== 'object') return { ok: false, reason: 'oluşan mum verisi yok' };
  const o = Number(candle.o), h = Number(candle.h), l = Number(candle.l), c = Number(candle.c);
  const p = Number(observedPrice);
  if (![o, h, l, c, p].every(Number.isFinite) || o <= 0 || p <= 0 || h < l || h < o || h < c || l > o || l > c) {
    return { ok: false, reason: 'oluşan mum veya anlık fiyat geçersiz' };
  }
  const range = h - l;
  if (range <= 0) return { ok: false, reason: 'oluşan mumda ölçülebilir fiyat aralığı yok' };
  // A ticker price outside the current candle's reported high/low means the
  // ticker and kline snapshots are inconsistent (or one is stale). Fail closed
  // rather than treating stale OHLC as live confirmation.
  if (p < l || p > h) return { ok: false, reason: 'anlık fiyat mumun bildirilen yüksek-düşük aralığı dışında; veri tazeliği doğrulanamadı' };
  // Prefer the observed market price over the last REST kline close when available.
  const live = p;
  if (live < o) return { ok: false, reason: 'anlık fiyat mum açılışının altında; alım momentumu doğrulanmadı' };
  const bodyPct = ((live - o) / o) * 100;
  if (bodyPct < minBodyPct) return { ok: false, reason: `mum gövdesi zayıf (${bodyPct.toFixed(3)}%)` };
  const rangePosition = (live - l) / range;
  if (rangePosition < minRangePosition) return { ok: false, reason: `fiyat mum aralığının alt bölümünde (${Math.round(rangePosition * 100)}%)` };
  return { ok: true, reason: `canlı mum onayı: fiyat açılışın ${bodyPct.toFixed(3)}% üstünde, aralığın ${Math.round(rangePosition * 100)}% bölümünde` };
}

module.exports = { confirmBuy };
