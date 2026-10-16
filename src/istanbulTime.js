'use strict';

// Human-facing timestamps only. Keep persisted timestamps and engine calculations in UTC.
function formatIstanbulTime(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'bilinmiyor';
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(date);
}

function withIstanbulTime(message, value = Date.now()) {
  return `${message}\n🕒 İstanbul: ${formatIstanbulTime(value)}`;
}

// Istanbul takvim günü (YYYY-MM-DD) ve saat/dakika. Zamanlanmış raporlar için.
function istanbulParts(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => parts.find((x) => x.type === type)?.value;
  return { dateKey: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

module.exports = { formatIstanbulTime, withIstanbulTime, istanbulParts };
