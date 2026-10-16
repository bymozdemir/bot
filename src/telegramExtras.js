'use strict';
// Telegram için salt-okunur biçimlendiriciler: /islemler, /neden, /haftalik, /aylik, /coinler, /ayarlar, /log.
// Hepsi saf fonksiyondur (ağ/disk yok); veri dışarıdan verilir. Böylece test edilebilir.
// Motor dosyaları (paperEngine) bu pakette yok: karar (decision) ve işlem alanları bilerek TOLERANSLI okunur.

const DAY_MS = 86400000;

// ---------- küçük yardımcılar ----------
function toMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); return n < 1e12 ? n * 1000 : n; }
  return Date.parse(s);
}

function fmtDateTime(value, withSeconds = false) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return 'bilinmiyor';
  const opts = { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (withSeconds) opts.second = '2-digit';
  return new Intl.DateTimeFormat('tr-TR', opts).format(new Date(ms));
}

function fmtDuration(ms) {
  const s = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(s) || s < 0) return null;
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} gün ${h} sa`;
  if (h > 0) return `${h} sa ${m} dk`;
  return m > 0 ? `${m} dk` : '1 dk altı';
}

function fmtAgo(value, now = Date.now()) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return null;
  const d = fmtDuration(now - ms);
  return d ? `${d} önce` : null;
}

function fmtPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'bilinmiyor';
  if (n !== 0 && Math.abs(n) < 0.000001) return n.toLocaleString('en-US', { maximumFractionDigits: 20, useGrouping: false });
  return n.toLocaleString('en-US', { maximumFractionDigits: 8, useGrouping: false });
}

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'bilinmiyor';
  const d = Math.abs(n) >= 1 || n === 0 ? 2 : 4;
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });
}
function signed(value) { const n = Number(value); return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${fmtMoney(n)}` : 'bilinmiyor'; }
function signedPct(value) { const n = Number(value); return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : ''; }
function icon(value) { return Number(value) >= 0 ? '🟢' : '🔴'; }
function pctText(value, digits = 2) { const n = Number(value); return Number.isFinite(n) ? `%${Number(n.toFixed(digits))}` : 'bilinmiyor'; }

function quoteOf(symbol, fallback = 'USDT') {
  const q = String(symbol || '').split('/')[1];
  return String(q || fallback).toUpperCase();
}

function clip(text, max) {
  const s = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Token / API anahtarı / parola benzeri değerleri mesajdan çıkarır.
function maskSecrets(text, extraSecrets = []) {
  let s = String(text === undefined || text === null ? '' : text);
  for (const secret of extraSecrets) {
    const v = String(secret || '');
    if (v.length >= 6) s = s.split(v).join('***');
  }
  s = s.replace(/\b\d{6,}:[A-Za-z0-9_-]{25,}\b/g, '[gizli-token]');
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***');
  s = s.replace(/((?:api[_-]?key|api[_-]?secret|apikey|secret|token|passphrase|password|passwd|parola|şifre|sifre|authorization|signature|sign)\s*["']?\s*[:=]\s*["']?)([^\s"'&,;]+)/gi, '$1***');
  s = s.replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9])/g, '***');
  return s;
}

// Kapanış sebebini okunur Türkçe etikete çevirir; tanınmazsa ham metni gösterir.
function reasonLabel(reason) {
  const raw = String(reason === undefined || reason === null ? '' : reason).trim();
  if (!raw) return 'belirtilmemiş';
  const l = raw.toLocaleLowerCase('tr-TR');
  let label = null;
  if (/trail/.test(l)) label = 'Trailing stop';
  else if (/break.?even|başabaş|basabas/.test(l)) label = 'Başa baş stop';
  else if (/kill/.test(l)) label = 'Kill switch';
  else if (/stop/.test(l)) label = 'Stop';
  else if (/take.?profit|\btp\b|kâr al|kar al|hedef/.test(l)) label = 'Kâr al';
  else if (/manual|manuel|kullanıcı|kullanici|user/.test(l)) label = 'Manuel';
  else if (/daily|günlük|gunluk/.test(l)) label = 'Günlük limit';
  else if (/signal|sinyal|sat\b|sell|exit|çıkış|cikis/.test(l)) label = 'Sinyal';
  if (!label) return clip(raw, 70);
  return label.toLocaleLowerCase('tr-TR') === l ? label : `${label} — ${clip(raw, 60)}`;
}

function tradePnl(t) {
  const pnl = Number(t && t.pnl);
  let pct = Number(t && t.pnlPct);
  if (!Number.isFinite(pct)) {
    const e = Number(t && t.entryPrice); const x = Number(t && t.exitPrice);
    pct = e > 0 && x > 0 ? (x / e - 1) * 100 : NaN;
  }
  return { pnl, pct };
}

function sortedClosed(trades) {
  return (Array.isArray(trades) ? trades : [])
    .filter((t) => t && Number.isFinite(toMs(t.closedAt)))
    .sort((a, b) => toMs(b.closedAt) - toMs(a.closedAt));
}

// ---------- tek işlem mesajları (komut + otomatik bildirim ortak kullanır) ----------
function describeTrade(t, index, quoteDefault) {
  const { pnl, pct } = tradePnl(t);
  const q = quoteOf(t.symbol, quoteDefault);
  const lines = [`${index === undefined ? '' : `${index}) `}${icon(pnl)} ${String(t.symbol || 'Bilinmeyen')}  ${signed(pnl)} ${q}${Number.isFinite(pct) ? ` (${signedPct(pct)})` : ''}`];
  const qty = Number(t.quantity);
  lines.push(`   Giriş: ${fmtPrice(t.entryPrice)} → Çıkış: ${fmtPrice(t.exitPrice)}${Number.isFinite(qty) ? ` | Adet: ${fmtPrice(qty)}` : ''}`);
  const o = toMs(t.openedAt); const c = toMs(t.closedAt);
  if (Number.isFinite(c)) {
    const held = Number.isFinite(o) ? fmtDuration(c - o) : null;
    lines.push(`   ${Number.isFinite(o) ? `${fmtDateTime(o)} → ` : 'Kapanış: '}${fmtDateTime(c)}${held ? ` (${held})` : ''}`);
  }
  lines.push(`   Sebep: ${reasonLabel(t.reason)}`);
  return lines.join('\n');
}

function formatTradeClosedMessage(t, quoteDefault) {
  const { pnl, pct } = tradePnl(t);
  const q = quoteOf(t.symbol, quoteDefault);
  const lines = [`${icon(pnl)} İŞLEM KAPANDI: ${String(t.symbol || 'Bilinmeyen')}`];
  lines.push(`K/Z: ${signed(pnl)} ${q}${Number.isFinite(pct) ? ` (${signedPct(pct)})` : ''}`);
  const qty = Number(t.quantity);
  lines.push(`Giriş: ${fmtPrice(t.entryPrice)} → Çıkış: ${fmtPrice(t.exitPrice)}${Number.isFinite(qty) ? ` | Adet: ${fmtPrice(qty)}` : ''}`);
  const o = toMs(t.openedAt); const c = toMs(t.closedAt);
  const held = Number.isFinite(o) && Number.isFinite(c) ? fmtDuration(c - o) : null;
  if (held) lines.push(`Süre: ${held}`);
  lines.push(`Sebep: ${reasonLabel(t.reason)}`);
  return lines.join('\n');
}

function formatPositionOpenedMessage(p, quoteDefault) {
  const q = quoteOf(p.symbol, p.quoteAsset || quoteDefault);
  const qty = Number(p.quantity); const entry = Number(p.entryPrice);
  const cost = Number(p.costQuote) > 0 ? Number(p.costQuote) : (qty > 0 && entry > 0 ? qty * entry : NaN);
  const lines = [`🟢 POZİSYON AÇILDI: ${String(p.symbol || 'Bilinmeyen')}`];
  lines.push(`Alış: ${fmtPrice(entry)} | Adet: ${fmtPrice(qty)}${Number.isFinite(cost) ? ` | Tutar: ${fmtMoney(cost)} ${q}` : ''}`);
  const stop = Number(p.stopPrice);
  if (Number.isFinite(stop) && stop > 0) {
    const dist = entry > 0 ? ((stop / entry) - 1) * 100 : NaN;
    lines.push(`Stop: ${fmtPrice(stop)}${Number.isFinite(dist) ? ` (${signedPct(dist)})` : ''}`);
  }
  return lines.join('\n');
}

// ---------- /islemler ----------
function formatTrades(trades, { limit = 10, quoteDefault = 'USDT' } = {}) {
  const n = Math.min(20, Math.max(1, Math.floor(Number(limit)) || 10));
  const closed = sortedClosed(trades);
  if (!closed.length) return '📜 SON KAPANAN İŞLEMLER\n\nHenüz kapanan işlem yok.';
  const shown = closed.slice(0, n);
  const out = [`📜 SON ${shown.length} KAPANAN İŞLEM (en yeni üstte)`, ''];
  shown.forEach((t, i) => { out.push(describeTrade(t, i + 1, quoteDefault), ''); });
  const sums = {};
  for (const t of shown) { const q = quoteOf(t.symbol, quoteDefault); const { pnl } = tradePnl(t); sums[q] = (sums[q] || 0) + (Number.isFinite(pnl) ? pnl : 0); }
  const wins = shown.filter((t) => tradePnl(t).pnl > 0).length;
  out.push(`Gösterilen ${shown.length} işlemde: ${wins} kazançlı, ${shown.length - wins} zararlı/başa baş.`);
  out.push(`Toplam K/Z: ${Object.entries(sums).map(([q, v]) => `${signed(v)} ${q}`).join(' | ')}`);
  out.push(`Kayıtlı toplam kapanan işlem: ${closed.length}. Daha fazlası için /islemler 20`);
  return out.join('\n');
}

// ---------- /haftalik, /aylik ----------
function periodTitle(days) {
  if (days === 7) return 'HAFTALIK RAPOR';
  if (days === 30) return 'AYLIK RAPOR';
  return `${days} GÜNLÜK RAPOR`;
}

function formatPeriod(trades, { days = 7, now = Date.now(), quoteDefault = 'USDT', status = {} } = {}) {
  const from = now - days * DAY_MS;
  const inWindow = sortedClosed(trades).filter((t) => toMs(t.closedAt) >= from && toMs(t.closedAt) <= now + 60000);
  const head = [`📅 ${periodTitle(days)} (son ${days} gün)`, `Dönem: ${fmtDateTime(from)} → ${fmtDateTime(now)} (İstanbul)`, ''];
  if (!inWindow.length) head.push('Bu dönemde kapanan işlem yok.');
  const byQuote = {};
  for (const t of inWindow) { const q = quoteOf(t.symbol, quoteDefault); (byQuote[q] = byQuote[q] || []).push(t); }
  const quotes = Object.keys(byQuote);
  const out = [...head];
  for (const q of quotes) {
    const list = byQuote[q];
    if (quotes.length > 1) out.push(`— ${q} —`);
    const pnls = list.map((t) => tradePnl(t));
    const total = pnls.reduce((s, x) => s + (Number.isFinite(x.pnl) ? x.pnl : 0), 0);
    const wins = pnls.filter((x) => x.pnl > 0).length;
    const losses = pnls.filter((x) => x.pnl < 0).length;
    const pcts = pnls.map((x) => x.pct).filter(Number.isFinite);
    out.push(`Kapanan işlem: ${list.length} (${wins} kazançlı / ${losses} zararlı) | Kazanma oranı: ${pctText((wins / list.length) * 100, 1)}`);
    out.push(`${icon(total)} Gerçekleşen K/Z: ${signed(total)} ${q}`);
    if (pcts.length) out.push(`Ortalama işlem getirisi: ${signedPct(pcts.reduce((a, b) => a + b, 0) / pcts.length)}`);
    let best = list[0]; let worst = list[0];
    for (const t of list) { if (tradePnl(t).pnl > tradePnl(best).pnl) best = t; if (tradePnl(t).pnl < tradePnl(worst).pnl) worst = t; }
    const line = (label, t) => { const x = tradePnl(t); return `${label}: ${t.symbol} ${signed(x.pnl)} ${q}${Number.isFinite(x.pct) ? ` (${signedPct(x.pct)})` : ''} — ${fmtDateTime(t.closedAt)}`; };
    out.push(line('🏆 En iyi', best), line('💥 En kötü', worst));
    // Gerçekleşen K/Z eğrisinde tepeden dibe en büyük düşüş (sadece kapanan işlemlerden hesaplanır).
    let cum = 0; let peak = 0; let dd = 0;
    for (const t of [...list].sort((a, b) => toMs(a.closedAt) - toMs(b.closedAt))) {
      const p = tradePnl(t).pnl; cum += Number.isFinite(p) ? p : 0;
      if (cum > peak) peak = cum;
      if (peak - cum > dd) dd = peak - cum;
    }
    out.push(`📉 En büyük düşüş (gerçekleşen K/Z eğrisinde): ${dd > 0 ? `-${fmtMoney(dd)} ${q}` : 'yok'}`);
    out.push('');
  }
  const s = status || {};
  const equity = Number(s.totalEquity);
  if (Number.isFinite(equity)) out.push(`💼 Güncel özkaynak: ${fmtMoney(equity)} ${String(s.quoteAsset || quoteDefault).toUpperCase()}`);
  const mdd = Number(s.risk && s.risk.maxDrawdownPct);
  if (Number.isFinite(mdd) && mdd > 0) out.push(`Tüm zamanların en büyük özkaynak düşüşü: ${pctText(mdd)}`);
  out.push('', 'Not: Yalnızca kapanan işlemler sayılır; açık pozisyonların anlık K/Z için /pozisyonlar.');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// ---------- /coinler ----------
function formatCoins(status = {}, strategyNames = {}) {
  const pairs = status.pairs && typeof status.pairs === 'object' ? Object.entries(status.pairs) : [];
  if (!pairs.length) return '🪙 COİN LİSTESİ\n\nListede coin yok. Eklemek için: /coin_ekle PEPE/USDT';
  const holdings = new Set((Array.isArray(status.holdings) ? status.holdings : []).map((h) => String(h.symbol)));
  const enabledCount = pairs.filter(([, p]) => p && p.enabled !== false).length;
  const out = [`🪙 COİN LİSTESİ (${pairs.length} coin, ${enabledCount} açık)`, ''];
  pairs.forEach(([symbol, p], i) => {
    const on = !p || p.enabled !== false;
    const sid = p && p.strategyId ? String(p.strategyId) : null;
    const sname = sid ? (strategyNames[sid] ? `${strategyNames[sid]} (${sid})` : sid) : 'bilinmiyor';
    out.push(`${i + 1}) ${on ? '🟢 AÇIK' : '⏸ KAPALI'} — ${symbol}`);
    out.push(`   Strateji: ${sname}`);
    out.push(`   Mum: ${p && p.timeframe ? p.timeframe : 'bilinmiyor'} | Bütçe payı: ${p && Number.isFinite(Number(p.budgetPct)) ? `%${Number(p.budgetPct)}` : 'varsayılan'}`);
    if (holdings.has(symbol)) out.push('   📌 Şu an açık pozisyon var');
    out.push('');
  });
  out.push('Coin eklemek için /coin_ekle PEPE/USDT. Ayarları değiştirmek/silmek için paneli kullan.');
  return out.join('\n');
}

// ---------- /ayarlar ----------
function formatSettings(status = {}) {
  const s = status.settings || {};
  const quote = String(status.quoteAsset || 'USDT').toUpperCase();
  const has = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
  const pct = (v) => (has(v) ? `%${Number(v)}` : 'bilinmiyor');
  const lines = ['⚙ AYARLAR (salt-okunur)', ''];
  lines.push(`Mod: ${String(status.mode || 'paper').toUpperCase()} | Borsa: ${String(status.exchange || 'bilinmiyor')} | Kasa birimi: ${quote}`);
  lines.push(`Bot: ${status.running ? 'ÇALIŞIYOR' : 'DURDU'}`);
  lines.push('');
  lines.push('🛡 Risk');
  lines.push(`• Günlük zarar limiti: ${pct(s.dailyLossLimitPct)}`);
  lines.push(`• Kill switch (toplam zarar): ${has(s.killSwitchLossPct) ? (Number(s.killSwitchLossPct) === 0 ? 'kapalı (0)' : pct(s.killSwitchLossPct)) : 'bilinmiyor'}`);
  lines.push(`• İşlem başına üst tutar: ${has(s.maxTradeQuote) ? (Number(s.maxTradeQuote) === 0 ? 'sınırsız (0)' : `${fmtMoney(s.maxTradeQuote)} ${quote}`) : 'bilinmiyor'}`);
  lines.push(`• Aynı anda azami pozisyon: ${has(s.maxConcurrentPositions) ? Number(s.maxConcurrentPositions) : 'bilinmiyor'}`);
  lines.push(`• Hiç kullanılmayacak nakit payı: ${pct(s.reserveCashPct)}`);
  lines.push('');
  lines.push('📐 Genel');
  lines.push(`• Varsayılan coin bütçe payı: ${pct(s.defaultBudgetPct)}`);
  lines.push(`• Kontrol sıklığı: ${has(s.pollSeconds) ? `${Number(s.pollSeconds)} sn` : 'bilinmiyor'}`);
  lines.push(`• Paper komisyon: ${pct(s.paperFeePct)} | kayma: ${pct(s.paperSlippagePct)}`);
  lines.push('');
  lines.push(status.killSwitch ? `🛑 Kill switch AÇIK${status.killSwitchReason ? `: ${clip(status.killSwitchReason, 160)}` : ''}` : '✅ Kill switch kapalı');
  lines.push('', 'Ayarlar Telegram\'dan değiştirilemez (yalnızca /coin_ekle); değiştirmek için paneli kullan.');
  return lines.join('\n');
}

// ---------- /neden ----------
function pick(obj, keys) {
  for (const k of keys) { const v = obj[k]; if (v !== undefined && v !== null && v !== '') return v; }
  return undefined;
}
function scalarText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function conditionList(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'object') {
    arr = Object.entries(raw).map(([k, v]) => {
      if (v && typeof v === 'object') return { name: k, ...v };
      if (typeof v === 'boolean') return { name: k, ok: v };
      return { name: k, detail: scalarText(v) };
    });
  } else arr = [raw];
  return arr.map((x) => {
    if (typeof x === 'string') return { label: x, ok: null, detail: '' };
    if (!x || typeof x !== 'object') return null;
    const label = scalarText(pick(x, ['label', 'name', 'title', 'id', 'rule', 'check', 'key']));
    const okRaw = pick(x, ['ok', 'passed', 'met', 'pass', 'satisfied', 'success']);
    const ok = typeof okRaw === 'boolean' ? okRaw : null;
    const detail = scalarText(pick(x, ['detail', 'details', 'reason', 'message', 'note', 'value', 'text']));
    return { label, ok, detail };
  }).filter((x) => x && (x.label || x.detail));
}

function summarizeDecision(d) {
  if (typeof d === 'string') return { action: '', reason: d, conds: [], at: NaN, extra: [] };
  if (!d || typeof d !== 'object') return null;
  const action = scalarText(pick(d, ['action', 'signal', 'side', 'decision', 'type', 'state', 'status', 'verdict'])).trim();
  const reason = scalarText(pick(d, ['reason', 'message', 'note', 'why', 'summary', 'text', 'explanation', 'detail']));
  const conds = conditionList(pick(d, ['conditions', 'checks', 'filters', 'missing', 'blockers', 'blocked', 'reasons', 'rules', 'criteria', 'gates']));
  const at = toMs(pick(d, ['at', 't', 'time', 'timestamp', 'ts', 'updatedAt', 'checkedAt', 'candleTime', 'closedAt']));
  const extra = [];
  if (!action && !reason && !conds.length) {
    for (const [k, v] of Object.entries(d)) {
      const txt = scalarText(v);
      if (txt && !['at', 't', 'time', 'timestamp', 'ts'].includes(k)) extra.push(`${k}: ${clip(txt, 60)}`);
      if (extra.length >= 4) break;
    }
  }
  return { action, reason, conds, at, extra };
}

function actionKind(action) {
  const l = String(action || '').toLocaleLowerCase('tr-TR');
  if (/^(buy|long|al|enter|entry|open|alım|alim)/.test(l)) return 'buy';
  if (/^(sell|exit|close|sat|short|çık|cik)/.test(l)) return 'sell';
  if (/^(hold|none|wait|bekle|flat|skip|no|yok|neutral|nötr|notr|idle)/.test(l)) return 'wait';
  return l ? 'other' : 'none';
}

function formatWhy(status = {}, decisions = {}, { now = Date.now() } = {}) {
  const s = status || {};
  const pairs = s.pairs && typeof s.pairs === 'object' ? Object.entries(s.pairs) : [];
  const holdings = Array.isArray(s.holdings) ? s.holdings : [];
  const out = ['🔍 BOT NEDEN BEKLİYOR?', ''];
  const general = [];
  if (s.killSwitch) general.push(`🛑 Kill switch AÇIK${s.killSwitchReason ? ` (${clip(s.killSwitchReason, 120)})` : ''}: yeni işlemler engelli.`);
  if (!s.running) general.push('⏸ Bot şu an DURMUŞ: sinyal üretilmiyor. Başlatmak için /basla.');
  const maxPos = Number(s.settings && s.settings.maxConcurrentPositions);
  if (Number.isFinite(maxPos) && maxPos > 0 && holdings.length >= maxPos) general.push(`📌 Azami pozisyon sayısına ulaşıldı (${holdings.length}/${maxPos}): yeni alım yapılmaz.`);
  const day = Number(s.risk && s.risk.dayPnlPct); const lim = Number(s.risk && s.risk.dailyLimitPct);
  if (Number.isFinite(day) && Number.isFinite(lim) && lim > 0 && -day >= lim) general.push(`🚨 Günlük zarar limiti doldu (${pctText(-day)} / limit ${pctText(lim)}): yeni alım engelli olabilir.`);
  if (general.length) out.push(...general, '');
  if (!pairs.length) { out.push('Listede coin yok. Eklemek için /coin_ekle PEPE/USDT'); return out.join('\n'); }
  const poll = Number(s.settings && s.settings.pollSeconds);
  const staleMs = Math.max(10 * 60000, (Number.isFinite(poll) ? poll : 60) * 3000);
  const strategyNames = s.strategyNames || {};
  for (const [symbol, p] of pairs) {
    const tf = p && p.timeframe ? p.timeframe : '?';
    const sid = p && p.strategyId ? (strategyNames[p.strategyId] || p.strategyId) : '?';
    out.push(`• ${symbol} (${tf} · ${sid})`);
    const holding = holdings.find((h) => String(h.symbol) === symbol);
    if (p && p.enabled === false) { out.push('  ⏸ Parite kapalı: bu coin için işlem yapılmaz.', ''); continue; }
    if (holding) {
      const cost = Number(holding.costQuote); const val = Number(holding.marketValue);
      const pnl = Number.isFinite(cost) && cost > 0 && Number.isFinite(val) ? ((val / cost) - 1) * 100 : NaN;
      out.push(`  📌 Açık pozisyon var${Number.isFinite(pnl) ? ` (${signedPct(pnl)})` : ''}: çıkış sinyali veya stop bekleniyor.`);
    }
    const d = summarizeDecision(decisions ? decisions[symbol] : null);
    if (!d) {
      out.push(`  ℹ Henüz karar kaydı yok${s.running ? ' (ilk mum/kontrol bekleniyor)' : ' (bot durmuş)'}.`, '');
      continue;
    }
    const kind = actionKind(d.action);
    const head = kind === 'buy' ? '🟢 Son sinyal: AL' : kind === 'sell' ? '🔴 Son sinyal: SAT' : kind === 'wait' ? '⏳ Son karar: bekle' : (d.action ? `ℹ Son karar: ${clip(d.action, 40)}` : 'ℹ Son karar');
    out.push(`  ${head}${d.reason ? ` — ${clip(d.reason, 140)}` : ''}`);
    const unmet = d.conds.filter((c) => c.ok === false || (c.ok === null && d.conds.every((x) => x.ok === null)));
    const met = d.conds.filter((c) => c.ok === true);
    const fmtCond = (c) => clip(c.detail ? (c.label ? `${c.label} (${c.detail})` : c.detail) : c.label, 80);
    if (unmet.length) out.push(`  ✗ ${d.conds.some((c) => c.ok === false) ? 'Eksik şart' : 'Gerekçe'}: ${unmet.slice(0, 5).map(fmtCond).join('; ')}${unmet.length > 5 ? ` (+${unmet.length - 5})` : ''}`);
    if (met.length) out.push(`  ✓ Sağlanan: ${met.slice(0, 4).map((c) => clip(c.label || c.detail, 40)).join(', ')}${met.length > 4 ? ` (+${met.length - 4})` : ''}`);
    if (d.extra.length) out.push(`  ${d.extra.join(' | ')}`);
    if (Number.isFinite(d.at)) {
      const ago = fmtAgo(d.at, now);
      out.push(`  🕒 ${fmtDateTime(d.at)}${ago ? ` (${ago})` : ''}${now - d.at > staleMs && s.running ? ' ⚠ karar eski; veri gecikmiş olabilir' : ''}`);
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// ---------- /log ----------
function formatLogs(entries, { limit = 10, onlyProblems = false, secrets = [] } = {}) {
  let list = (Array.isArray(entries) ? entries : []).filter((e) => e && (e.msg !== undefined || typeof e === 'string'))
    .map((e) => (typeof e === 'string' ? { t: NaN, msg: e, level: 'info' } : e));
  if (list.length && list.every((e) => Number.isFinite(toMs(e.t)))) list = [...list].sort((a, b) => toMs(b.t) - toMs(a.t));
  if (onlyProblems) list = list.filter((e) => /^(error|warn|warning|hata|uyari|uyarı|fatal)$/i.test(String(e.level || '')));
  const n = Math.min(20, Math.max(1, Math.floor(Number(limit)) || 10));
  const shown = list.slice(0, n);
  const title = onlyProblems ? `🧾 SON ${shown.length || n} HATA/UYARI` : `🧾 SON ${shown.length || n} OLAY`;
  if (!shown.length) return `${title}\n\n${onlyProblems ? 'Kayıtlı hata/uyarı yok.' : 'Kayıtlı olay yok.'}`;
  const out = [title, ''];
  for (const e of shown) {
    const lvl = String(e.level || 'info').toLowerCase();
    const mark = /^(error|fatal|hata)$/.test(lvl) ? '❌' : (/^(warn|warning|uyari|uyarı)$/.test(lvl) ? '⚠' : 'ℹ');
    out.push(`${mark} ${Number.isFinite(toMs(e.t)) ? fmtDateTime(e.t, true) : '--'}  ${clip(maskSecrets(e.msg, secrets), 170)}`);
  }
  out.push('', `Token, API anahtarı ve parolalar maskelenir.${onlyProblems ? '' : ' Yalnızca hatalar için: /log hata'}`);
  return out.join('\n');
}

module.exports = {
  toMs, fmtDateTime, fmtDuration, fmtAgo, fmtPrice, fmtMoney, signed, signedPct, maskSecrets, reasonLabel,
  describeTrade, formatTradeClosedMessage, formatPositionOpenedMessage,
  formatTrades, formatPeriod, formatCoins, formatSettings, formatWhy, formatLogs, summarizeDecision
};
