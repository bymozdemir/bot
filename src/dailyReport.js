'use strict';
const { istanbulParts } = require('./istanbulTime');

// Her gün (ya da weekdays ile seçilen günlerde) belirlenen İstanbul saatinde (varsayılan 21:00) bir kez rapor gönderir.
// - Aynı gün iki kez gönderilmez (son gönderim günü kalıcı saklanır: restart güvenli).
// - Bot saat 21:00'de kapalıysa ve graceMinutes içinde açılırsa geç de olsa gönderir;
//   süre geçtiyse o günü atlar (gece yarısı "akşam raporu" gelmesin).
// - Rapor metni üretilemese bile hata fırlatmaz; bot çalışmaya devam eder.
function parseTime(text, fallback = { hour: 21, minute: 0 }) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return fallback;
  const hour = Number(m[1]); const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return fallback;
  return { hour, minute };
}

function createDailyReport({
  send, buildReport, getLastSentDate = () => null, setLastSentDate = () => {},
  time = '21:00', graceMinutes = 120, checkEveryMs = 30000, nowFn = () => Date.now(), logger = console,
  weekdays = null // örn. [0] = yalnızca Pazar (0=Pazar ... 6=Cumartesi). null: her gün
} = {}) {
  const at = parseTime(time);
  let timer = null;
  let busy = false;

  async function check() {
    if (busy) return false;
    const p = istanbulParts(nowFn());
    if (!p) return false;
    const nowMin = p.hour * 60 + p.minute;
    const dueMin = at.hour * 60 + at.minute;
    if (nowMin < dueMin || nowMin >= dueMin + graceMinutes) return false;
    if (Array.isArray(weekdays) && weekdays.length > 0) {
      const dow = new Date(`${p.dateKey}T12:00:00Z`).getUTCDay(); // dateKey zaten İstanbul takvim günü
      if (!weekdays.includes(dow)) return false;
    }
    if (getLastSentDate() === p.dateKey) return false;
    busy = true;
    try {
      const text = await buildReport();
      if (!text) return false;
      const result = await send(text);
      // send() hata fırlatmaz. Tüm kanallar başarısızsa günü işaretleme: sonraki kontrolde tekrar denenir.
      const values = Object.values(result || {});
      if (values.length > 0 && values.every((ok) => ok === false)) return false;
      setLastSentDate(p.dateKey);
      return true;
    } catch (err) {
      logger.warn(`[günlük-rapor] gönderilemedi: ${String(err && err.message || err)}`);
      return false;
    } finally { busy = false; }
  }

  function start() {
    if (timer) return false;
    timer = setInterval(() => { check().catch(() => {}); }, checkEveryMs);
    if (timer.unref) timer.unref();
    check().catch(() => {});
    return true;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start, stop, check, time: `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}` };
}

module.exports = { createDailyReport, parseTime };
