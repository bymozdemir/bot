'use strict';
const { formatIstanbulTime } = require('./istanbulTime');
const extras = require('./telegramExtras');

// Read-only Telegram command responder. Only the configured TELEGRAM_CHAT_ID may use it.
// Polling is used for Termux installs; no public webhook/server endpoint is needed.
function createTelegramCommands({ env = process.env, fetchFn = globalThis.fetch, logger = console, getStatus = () => ({}), startBot = async () => { throw new Error('Başlatma işlemi yapılandırılmadı.'); }, stopBot = async () => { throw new Error('Durdurma işlemi yapılandırılmadı.'); }, listStrategies = () => [], timeframes = [], validateTimeframe = () => null, addPair = async () => { throw new Error('Coin ekleme işlemi yapılandırılmadı.'); }, pollTimeoutSeconds = 20,
  getTrades = () => [], getLogs = () => [], getLabel = () => '',
  getPrice = async () => { throw new Error('Fiyat sorgusu yapılandırılmadı.'); }, now = () => Date.now() } = {}) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  // Group chat IDs and Telegram user IDs are different namespaces. For groups,
  // require an explicit comma-separated user allowlist; never infer authority from chat ID.
  const allowedUserIds = new Set(String(env.TELEGRAM_ALLOWED_USER_IDS || '')
    .split(',').map((id) => id.trim()).filter((id) => /^\d+$/.test(id)));
  const base = 'https://api.telegram.org';
  let stopped = true;
  let offset = 0;
  let loopPromise = null;
  let warned = false;
  // Wizard state lives only in memory. A restart cancels an unconfirmed setup.
  let setup = null;
  const SETUP_TTL_MS = 15 * 60 * 1000;

  async function api(method, body, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${base}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}), signal: controller.signal
      });
      let data;
      try { data = await response.json(); } catch { throw new Error(`Telegram ${method}: invalid JSON (HTTP ${response.status})`); }
      if (!response.ok || data.ok !== true) throw new Error(`Telegram ${method}: ${data.description || `HTTP ${response.status}`}`);
      return data.result;
    } finally { clearTimeout(timer); }
  }

  function formatAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'bilinmiyor';
    if (n !== 0 && Math.abs(n) < 0.000001) return n.toLocaleString('en-US', { maximumFractionDigits: 20, useGrouping: false });
    return n.toLocaleString('en-US', { maximumFractionDigits: 8, useGrouping: false });
  }

  function formatBalance() {
    const s = getStatus() || {};
    const quote = String(s.quoteAsset || 'USDT').toUpperCase();
    const cash = Number(s.cash);
    const holdings = Array.isArray(s.holdings) ? s.holdings : [];
    const lines = ['💰 PAPER BAKİYE / VARLIKLAR', `Kontrol zamanı (İstanbul): ${formatIstanbulTime()}`];
    if (Number.isFinite(cash)) lines.push(`Kullanılabilir nakit: ${formatAmount(cash)} ${quote}`);
    if (!holdings.length) {
      lines.push('', 'Açık varlık/pozisyon bulunmuyor.');
    } else {
      lines.push('', 'Açık pozisyonlar:');
      for (const h of holdings) {
        const symbol = String(h.symbol || 'Bilinmeyen varlık');
        const base = String(h.baseAsset || symbol.split('/')[0] || '').toUpperCase();
        const quantity = formatAmount(h.quantity);
        const value = Number(h.marketValue);
        const cost = Number(h.costQuote);
        const q = String(h.quoteAsset || quote).toUpperCase();
        let line = `• ${base}: ${quantity} ${base}`;
        if (Number.isFinite(value) && value >= 0) line += ` | güncel değer: ${formatAmount(value)} ${q}`;
        else if (Number.isFinite(cost)) line += ` | kayıtlı maliyet: ${formatAmount(cost)} ${q} (güncel fiyat yok)`;
        if (Number.isFinite(cost)) line += ` | maliyet: ${formatAmount(cost)} ${q}`;
        lines.push(line);
      }
    }
    if (Number.isFinite(Number(s.totalEquity))) lines.push('', `Tahmini toplam özkaynak: ${formatAmount(s.totalEquity)} ${quote}`);
    lines.push('', 'Not: Değerler Paper kayıtlarından hesaplanır; güncel fiyat yoksa maliyet gösterilir.');
    return lines.join('\n');
  }

  function tickLine(s) {
    const age = Number(s.dataAgeSec);
    if (!Number.isFinite(age) || age < 0) return [];
    return [`Son motor kontrolü: ${age < 60 ? `${Math.round(age)} sn` : extras.fmtDuration(age * 1000)} önce`];
  }

  function formatStatus() {
    const s = getStatus() || {};
    const mode = String(s.mode || 'paper').toUpperCase();
    const running = s.running ? 'ÇALIŞIYOR' : 'DURDU';
    const kill = s.killSwitch ? 'AÇIK — işlemler engelli' : 'kapalı';
    const quote = String(s.quoteAsset || 'USDT').toUpperCase();
    const cash = Number(s.cash);
    const cashText = Number.isFinite(cash) ? `${cash.toFixed(2)} ${quote}` : 'bilinmiyor';
    const positions = Number.isFinite(Number(s.positions)) ? String(Number(s.positions)) : 'bilinmiyor';
    return [
      '🤖 AL-SAT BOT DURUMU',
      `Mod: ${mode}`,
      `Bot: ${running}`,
      `Kill switch: ${kill}`,
      `Borsa: ${String(s.exchange || 'bilinmiyor')}`,
      `Paper nakit: ${cashText}`,
      `Açık pozisyon: ${positions}`,
      ...tickLine(s),
      `Kontrol zamanı (İstanbul): ${formatIstanbulTime()}`,
      '',
      'Salt-okunur durum sorgusu. Telegram üzerinden alım/satım komutu çalıştırılmaz.'
    ].join('\n');
  }

  function fmtMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'bilinmiyor';
    return n.toLocaleString('en-US', { minimumFractionDigits: Math.abs(n) >= 1 || n === 0 ? 2 : 4, maximumFractionDigits: Math.abs(n) >= 1 || n === 0 ? 2 : 4, useGrouping: false });
  }
  function signed(value) { const n = Number(value); return `${n >= 0 ? '+' : ''}${fmtMoney(n)}`; }
  function signedPct(value) { const n = Number(value); return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
  function pnlIcon(value) { return Number(value) >= 0 ? '🟢' : '🔴'; }
  function fmtDuration(seconds) {
    const s = Math.floor(Number(seconds));
    if (!Number.isFinite(s) || s < 0) return null;
    const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
    return d > 0 ? `${d} gün ${h} sa` : (h > 0 ? `${h} sa ${m} dk` : `${m} dk`);
  }

  // Açık pozisyonlar: alış fiyatı, adet, güncel fiyat ve K/Z. Değerler yaklaşıktır (komisyon/kayma hariç).
  function positionLines() {
    const s = getStatus() || {};
    const quote = String(s.quoteAsset || 'USDT').toUpperCase();
    const holdings = Array.isArray(s.holdings) ? s.holdings : [];
    const lines = [];
    let totalPnl = 0; let totalCost = 0; let counted = 0;
    holdings.forEach((h, i) => {
      const symbol = String(h.symbol || 'Bilinmeyen');
      const base = String(h.baseAsset || symbol.split('/')[0] || '').toUpperCase();
      const q = String(h.quoteAsset || quote).toUpperCase();
      const cost = Number(h.costQuote);
      const value = Number(h.marketValue);
      lines.push(`${i + 1}) ${symbol}`);
      lines.push(`   Adet: ${formatAmount(h.quantity)} ${base}`);
      const entry = Number(h.entryPrice); const cur = Number(h.currentPrice);
      lines.push(`   Alış: ${Number.isFinite(entry) ? formatAmount(entry) : 'bilinmiyor'} | Şimdi: ${Number.isFinite(cur) && cur > 0 ? formatAmount(cur) : 'fiyat yok'} ${q}`);
      if (Number.isFinite(cost) && Number.isFinite(value) && value >= 0) {
        const pnl = value - cost; const pct = cost > 0 ? (pnl / cost) * 100 : 0;
        lines.push(`   Maliyet: ${fmtMoney(cost)} → Değer: ${fmtMoney(value)} ${q}`);
        lines.push(`   ${pnlIcon(pnl)} K/Z: ${signed(pnl)} ${q} (${signedPct(pct)})`);
        if (q === quote) { totalPnl += pnl; totalCost += cost; counted++; }
      } else {
        lines.push(`   Güncel fiyat yok; K/Z hesaplanamadı.${Number.isFinite(cost) ? ` Kayıtlı maliyet: ${fmtMoney(cost)} ${q}` : ''}`);
      }
      lines.push('');
    });
    return { lines, totalPnl, totalCost, counted, quote, count: holdings.length };
  }

  function formatPositions() {
    const s = getStatus() || {};
    const pos = positionLines();
    const out = ['📊 AÇIK POZİSYONLAR VE KÂR/ZARAR', `Kontrol zamanı (İstanbul): ${formatIstanbulTime()}`, ''];
    if (!pos.count) out.push('Açık pozisyon bulunmuyor.', '');
    else out.push(...pos.lines);
    if (pos.counted > 0) {
      const pct = pos.totalCost > 0 ? (pos.totalPnl / pos.totalCost) * 100 : 0;
      out.push(`${pnlIcon(pos.totalPnl)} Açık pozisyon toplam K/Z: ${signed(pos.totalPnl)} ${pos.quote} (${signedPct(pct)})`);
    }
    const cash = Number(s.cash);
    if (Number.isFinite(cash)) out.push(`Nakit: ${fmtMoney(cash)} ${pos.quote}`);
    if (Number.isFinite(Number(s.totalEquity))) out.push(`Toplam özkaynak: ${fmtMoney(s.totalEquity)} ${pos.quote}`);
    out.push('', 'Not: Tahmini değerlerdir; komisyon ve kayma hariçtir, gerçek satışta biraz farklı çıkabilir.');
    return out.join('\n');
  }

  function formatReport() {
    const s = getStatus() || {};
    const quote = String(s.quoteAsset || 'USDT').toUpperCase();
    const running = Boolean(s.running);
    const out = ['🌙 GÜNLÜK RAPOR', `İstanbul: ${formatIstanbulTime()}`, ''];
    if (s.killSwitch) out.push('🛑 Kill switch AÇIK — işlemler engelli.');
    else out.push(running ? '✅ Bot çalışmaya devam ediyor.' : '⏸ Bot şu an DURMUŞ durumda (sunucu açık).');
    const up = fmtDuration(s.uptimeSec);
    out.push(`Mod: ${String(s.mode || 'paper').toUpperCase()} | Borsa: ${String(s.exchange || 'bilinmiyor')}${up ? ` | Sunucu: ${up} açık` : ''}`);
    out.push('');
    const equity = Number(s.totalEquity);
    if (Number.isFinite(equity)) out.push(`💼 Toplam özkaynak: ${fmtMoney(equity)} ${quote}`);
    const cash = Number(s.cash);
    if (Number.isFinite(cash)) out.push(`Nakit: ${fmtMoney(cash)} ${quote}`);
    const dayStart = Number(s.dayStartEquity);
    if (Number.isFinite(equity) && Number.isFinite(dayStart) && dayStart > 0) {
      const d = equity - dayStart; out.push(`${pnlIcon(d)} Bugün: ${signed(d)} ${quote} (${signedPct((d / dayStart) * 100)})`);
    }
    const start = Number(s.startingEquity);
    if (Number.isFinite(equity) && Number.isFinite(start) && start > 0) {
      const d = equity - start; out.push(`${pnlIcon(d)} Başlangıçtan beri: ${signed(d)} ${quote} (${signedPct((d / start) * 100)})`);
    }
    const t = s.today;
    if (t && Number.isFinite(Number(t.count))) {
      out.push(t.count > 0
        ? `Bugün kapanan işlem: ${t.count} (${Number(t.wins) || 0} kazançlı) | Gerçekleşen K/Z: ${signed(t.pnl)} ${quote}`
        : 'Bugün kapanan işlem yok.');
    }
    out.push('');
    const pos = positionLines();
    if (!pos.count) out.push('Açık pozisyon yok.');
    else {
      out.push('📊 Açık pozisyonlar:', ...pos.lines);
      if (pos.counted > 0) out.push(`${pnlIcon(pos.totalPnl)} Açık pozisyon toplam K/Z: ${signed(pos.totalPnl)} ${quote}`);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  function quoteAssetOf() { return String((getStatus() || {}).quoteAsset || 'USDT').toUpperCase(); }
  function strategyNamesMap() {
    const map = {};
    try { for (const x of (listStrategies() || [])) if (x && x.id) map[x.id] = x.name || x.id; } catch { /* yok say */ }
    return map;
  }
  function formatTrades(limit) { return extras.formatTrades(getTrades(), { limit, quoteDefault: quoteAssetOf() }); }
  function formatPeriod(days) { return extras.formatPeriod(getTrades(), { days, now: now(), quoteDefault: quoteAssetOf(), status: getStatus() || {} }); }
  function formatCoins() { return extras.formatCoins(getStatus() || {}, strategyNamesMap()); }
  function formatSettings() { return extras.formatSettings(getStatus() || {}); }
  function formatWhy() {
    const status = getStatus() || {};
    return extras.formatWhy({ ...status, strategyNames: strategyNamesMap() }, status.decisions || {}, { now: now() });
  }
  function formatLogs(arg) {
    const onlyProblems = ['hata', 'hatalar', 'error', 'errors', 'uyari', 'uyarı'].includes(String(arg || '').toLocaleLowerCase('tr-TR'));
    return extras.formatLogs(getLogs(), { limit: 10, onlyProblems, secrets: [token] });
  }

  async function priceReply(arg) {
    const status = getStatus() || {};
    const quote = String(status.quoteAsset || 'USDT').toUpperCase();
    const cached = status.lastPrices && typeof status.lastPrices === 'object' ? status.lastPrices : {};
    if (!arg) {
      const lines = ['💲 FİYAT SORGUSU', 'Kullanım: /fiyat BTC  veya  /fiyat BTC/USDT'];
      const known = Object.entries(cached).filter(([, v]) => Number(v) > 0);
      if (known.length) { lines.push('', 'Listedeki coinlerin son bilinen fiyatları:'); known.slice(0, 15).forEach(([sym, v]) => lines.push(`• ${sym}: ${extras.fmtPrice(v)}`)); }
      return lines.join('\n');
    }
    let sym = String(arg).toUpperCase().replace(/[-_]/g, '/');
    if (!sym.includes('/')) sym = `${sym}/${quote}`;
    if (!/^[A-Z0-9]{2,20}\/[A-Z0-9]{2,10}$/.test(sym)) return 'Parite biçimi hatalı. Örnek: /fiyat BTC veya /fiyat BTC/USDT';
    const q = sym.split('/')[1];
    try {
      const r = await getPrice(sym);
      const price = Number(r && r.price);
      if (!Number.isFinite(price) || price <= 0) throw new Error('Geçerli fiyat alınamadı.');
      return `💲 ${sym}: ${extras.fmtPrice(price)} ${q}\nKaynak: ${String((r && r.source) || 'borsa')}\nKontrol zamanı (İstanbul): ${formatIstanbulTime()}`;
    } catch (err) {
      const msg = String(err && err.message || err).slice(0, 300);
      if (Number(cached[sym]) > 0) return `⚠ ${sym} için borsadan güncel fiyat alınamadı: ${msg}\nSon bilinen fiyat (güncel olmayabilir): ${extras.fmtPrice(cached[sym])} ${q}`;
      return `⛔ ${sym} fiyatı alınamadı: ${msg}`;
    }
  }

  function helpText() {
    const rep = (getStatus() || {}).reports || {};
    const auto = [];
    if (rep.daily) auto.push(`günlük rapor (her gün ${rep.daily})`); else auto.push('günlük rapor');
    if (rep.weekly) auto.push(`haftalık rapor (${rep.weekly})`);
    auto.push('alım/satım bildirimi', 'risk uyarıları (günlük zarar limiti, kill switch, stop yakınlığı)', 'veri kesintisi uyarısı', 'çökme uyarısı');
    return [
      'AL-SAT botu hazır. Komutlar:',
      '',
      '📊 BİLGİ',
      '/durum — bot çalışıyor mu, mod, borsa, kill switch, nakit, pozisyon sayısı',
      '/bakiye — nakit ve açık varlıklar',
      '/pozisyonlar (/kar, /kz, /pnl) — her coinin alış fiyatı, adedi, şimdiki fiyatı ve kâr/zararı',
      '/rapor (/ozet) — özkaynak, bugünkü ve toplam K/Z, bugünkü işlemler, açık pozisyonlar',
      '/islemler [sayı] — son kapanan işlemler (varsayılan 10, en fazla 20): giriş/çıkış, K/Z, kapanış sebebi',
      '/neden — her coin için botun neden beklediği: son sinyal, eksik şartlar',
      '/haftalik — son 7 günün özeti: K/Z, kazanma oranı, en iyi/en kötü işlem, en büyük düşüş',
      '/aylik — son 30 günün aynı özeti',
      '/coinler — listedeki coinler: strateji, mum aralığı, bütçe payı, açık/kapalı',
      '/ayarlar — risk ve genel ayarlar (salt-okunur)',
      '/fiyat BTC — anlık fiyat (örnek: /fiyat BTC/USDT)',
      '/log — son 10 olay (/log hata: yalnızca hata ve uyarılar; token ve anahtarlar maskelenir)',
      '',
      '🎛 KONTROL',
      '/basla — Paper botunu başlat',
      '/bitir — bot motorunu durdur',
      '/coin_ekle PEPE/USDT — Paper coin ekleme sihirbazı (hazır indikatör ayarları)',
      '/onayla — sihirbazın ayar özetini onayla',
      '/iptal — sihirbazı iptal et',
      '',
      'ℹ YARDIM',
      '/yardim (/help, /yardım, /start) — bu liste',
      '',
      `🔔 Otomatik bildirimler: ${auto.join(', ')}.`,
      '',
      'Coin ayarları açık onaydan sonra eklenir; Telegram canlı işlem başlatamaz veya manuel alım/satım emri veremez.'
    ].join('\n');
  }

  function splitMessage(text, max = 3800) {
    const str = String(text);
    if (str.length <= max) return [str];
    const chunks = []; let cur = '';
    for (const line of str.split('\n')) {
      if (line.length > max) {
        if (cur) { chunks.push(cur); cur = ''; }
        for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
        continue;
      }
      if ((cur ? cur.length + 1 : 0) + line.length > max) { chunks.push(cur); cur = line; }
      else cur = cur ? `${cur}\n${line}` : line;
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  function labelPrefix() {
    try { const l = String(getLabel() || '').trim(); return l; } catch { return ''; }
  }

  function isPaper() { return String((getStatus() || {}).mode || 'paper').toLowerCase() === 'paper'; }

  function setupExpired() {
    if (setup && Date.now() - setup.createdAt > SETUP_TTL_MS) setup = null;
    return !setup;
  }

  function askCurrentSetupQuestion() {
    if (!setup) return '';
    if (setup.step === 'timeframe') return `\nMum aralığını seç: ${(timeframes || []).join(', ')}. Örnek: 15m`;
    if (setup.step === 'budget') {
      const max = Number((getStatus() || {}).settings?.defaultBudgetPct);
      return `\nBu coin için portföy bütçe payını yüzde olarak yaz (1-${Number.isFinite(max) && max > 0 ? max : 100}). Bu değer varsayılan bütçe payını aşamaz; global risk limitleri değişmez.`;
    }
    if (setup.step === 'trailingStop') return `\nTrailing stop bu coin için açık mı olsun? evet/hayır yaz. Stratejinin kodda tanımlı diğer indikatör ve parametre değerleri değişmeyecek. Varsayılan: ${setup.params.trailingStop ? 'açık' : 'kapalı'}.`;
    if (setup.step === 'confirm') {
      const lines = [
        '🧾 COIN AYAR ÖZETİ — henüz eklenmedi',
        `Parite: ${setup.symbol}`,
        `Strateji: ${setup.strategy.name} (${setup.strategy.id})`,
        `Mum aralığı: ${setup.timeframe}`,
        `Bütçe payı: %${setup.budgetPct}`,
        'İndikatör ayarları: kodda tanımlı hazır varsayılanlar (değiştirilmedi).',
        `Trailing stop: ${setup.params.trailingStop ? 'AÇIK' : 'KAPALI'}`,
        '',
        'Eklemek için /onayla yaz. İptal etmek için /iptal yaz.',
        'Global günlük zarar limiti, kill switch, azami pozisyon ve işlem üst sınırı değiştirilmeyecek.'
      ];
      return lines.join('\n');
    }
    return '';
  }

  function beginCoinSetup(symbol) {
    if (!isPaper()) return '⛔ Güvenlik nedeniyle Telegram üzerinden coin ekleme yalnızca Paper modda yapılabilir.';
    const status = getStatus() || {};
    const norm = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{2,20}\/[A-Z0-9]{2,10}$/.test(norm)) return 'Parite biçimi hatalı. Örnek: /coin_ekle PEPE/USDT';
    if (status.pairs && Object.prototype.hasOwnProperty.call(status.pairs, norm)) return `${norm} zaten listede.`;
    const quoteAssets = Array.isArray(status.quoteAssets) ? status.quoteAssets : [];
    if (quoteAssets.length && !quoteAssets.includes(norm.split('/')[1])) return `Bu borsada desteklenen kasa birimleri: ${quoteAssets.join(', ')}.`;
    const choices = (listStrategies() || []);
    if (!choices.length) return 'Strateji listesi alınamadı; coin ekleme başlatılmadı.';
    setup = { symbol: norm, choices, step: 'strategy', createdAt: Date.now() };
    return `🛠 ${norm} coin ekleme sihirbazı\nKodda bulunan hazır stratejilerden birini seç. İndikatör hesap ayarları kodun varsayılanlarında kalır; senden yalnızca strateji, mum süresi, bütçe ve trailing stop seçimi istenir.\n\n${choices.map((x, i) => `${i + 1}. ${x.name} (${x.id})\n   ${x.description || ''}`).join('\n')}\n\nSeçmek için listedeki numarayı yaz. İptal: /iptal`;
  }

  function handleSetupReply(input) {
    if (setupExpired()) return null;
    const value = String(input || '').trim();
    if (value.toLowerCase() === '/iptal') { setup = null; return 'Coin ekleme iptal edildi. Herhangi bir ayar kaydedilmedi.'; }
    if (value.toLowerCase() === '/coin_ekle') return 'Kullanım: /coin_ekle PEPE/USDT';
    if (setup.step === 'strategy') {
      const idx = Number(value);
      if (!Number.isInteger(idx) || idx < 1 || idx > setup.choices.length) return `Geçersiz seçim. 1-${setup.choices.length} arasında bir numara yaz.`;
      setup.strategy = setup.choices[idx - 1];
      setup.params = { ...(setup.strategy.defaultParams || {}) };
      setup.paramIndex = 0;
      setup.step = 'timeframe';
      return `Seçilen strateji: ${setup.strategy.name}.\nİndikatör ayarları kodda tanımlı varsayılanlarla kullanılacak.\n${askCurrentSetupQuestion()}`;
    }
    if (setup.step === 'timeframe') {
      if (!(timeframes || []).includes(value)) return `Geçersiz mum aralığı. Seçenekler: ${(timeframes || []).join(', ')}`;
      const tfError = validateTimeframe({ timeframe: value, strategyId: setup.strategy.id });
      if (tfError) return tfError;
      setup.timeframe = value;
      setup.step = 'budget';
      return askCurrentSetupQuestion();
    }
    if (setup.step === 'budget') {
      const n = Number(value.replace(',', '.'));
      const max = Number((getStatus() || {}).settings?.defaultBudgetPct);
      const ceiling = Number.isFinite(max) && max > 0 ? Math.min(100, max) : 100;
      if (!Number.isFinite(n) || n < 1 || n > ceiling) return `Bütçe payı 1 ile ${ceiling} arasında olmalı. Global ayarlar değiştirilmez; bu coin için daha düşük pay seçebilirsin.`;
      setup.budgetPct = n;
      setup.step = 'trailingStop';
      return askCurrentSetupQuestion();
    }
    if (setup.step === 'trailingStop') {
      const v = value.toLocaleLowerCase('tr-TR');
      if (['evet', 'e', 'true', '1', 'açık', 'acik'].includes(v)) setup.params.trailingStop = true;
      else if (['hayır', 'hayir', 'h', 'false', '0', 'kapalı', 'kapali'].includes(v)) setup.params.trailingStop = false;
      else return 'Trailing stop için evet veya hayır yaz.';
      if (!Object.prototype.hasOwnProperty.call(setup.strategy.defaultParams || {}, 'trailingStop')) {
        if (setup.params.trailingStop) return 'Bu strateji trailing stop ayarını desteklemiyor. Hayır yazarak kapalı devam edebilirsin.';
        setup.params.trailingStop = false;
      }
      setup.step = 'confirm';
      return askCurrentSetupQuestion();
    }
    return 'Bekleyen bir ayar adımı yok. /coin_ekle PEPE/USDT ile başla.';
  }

  // Biçimlendirme hatası komutu sessiz bırakmasın: kullanıcıya kısa hata mesajı gider.
  function safeReply(name, fn) {
    try { return fn(); }
    catch (err) { return `⛔ ${name} hazırlanamadı: ${String(err && err.message || err).replace(token, '***').slice(0, 300)}`; }
  }

  async function processUpdate(update) {
    const message = update && (update.message || update.edited_message);
    if (!message || !message.chat || message.chat.id === undefined || !message.text) return false;
    // Fail closed: never respond to an unconfigured or different chat.
    if (!chatId || String(message.chat.id) !== chatId) return false;
    // Private chat: sender must be the configured chat owner (or explicit allowlist).
    // Group/supergroup: require an explicit TELEGRAM_ALLOWED_USER_IDS match.
    const senderId = message.from && message.from.id !== undefined ? String(message.from.id) : '';
    const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup' || String(message.chat.id).startsWith('-');
    if (isGroup) {
      if (!senderId || !allowedUserIds.has(senderId)) return false;
    } else if (senderId && senderId !== chatId && !allowedUserIds.has(senderId)) {
      return false;
    }
    const text = String(message.text).trim();
    const command = text.split(/\s+/, 1)[0].split('@')[0].toLowerCase();
    let reply;
    if (command === '/coin_ekle' || command === '/coin-ekle') {
      reply = beginCoinSetup(text.split(/\s+/).slice(1).join(' '));
    } else if (command === '/onayla') {
      if (!setup || setupExpired() || setup.step !== 'confirm') reply = 'Onaylanacak tamamlanmış ayar bulunmuyor. /coin_ekle PEPE/USDT ile başla.';
      else if (!isPaper()) { setup = null; reply = '⛔ Mod Paper değil; coin ekleme reddedildi. Hiçbir ayar kaydedilmedi.'; }
      else {
        const pending = setup;
        try {
          const result = await addPair({ symbol: pending.symbol, strategyId: pending.strategy.id, timeframe: pending.timeframe, budgetPct: pending.budgetPct, params: pending.params });
          setup = null;
          reply = `✅ ${pending.symbol} Paper listesine eklendi.
Strateji: ${pending.strategy.name}
Mum aralığı: ${pending.timeframe}
Bütçe payı: %${pending.budgetPct}
Trailing stop: ${pending.params.trailingStop ? 'AÇIK' : 'KAPALI'}
İndikatörler: kodda tanımlı varsayılan değerler
${result && result.message ? result.message : 'Global güvenlik limitleri korunuyor.'}`;
        } catch (err) { reply = `⛔ Coin eklenemedi: ${String(err && err.message || err).slice(0, 700)}
Ayarlar kaydedilmedi; düzeltip yeniden deneyebilirsin veya /iptal yaz.`; }
      }
    } else if (command === '/iptal') { setup = null; reply = 'Coin ekleme/ayar işlemi iptal edildi. Hiçbir bekleyen ayar kaydedilmedi.';
    } else if (setup && !command.startsWith('/')) {
      reply = handleSetupReply(text);
      if (reply === null) reply = 'Ayar sihirbazının süresi doldu. Hiçbir ayar kaydedilmedi. /coin_ekle PEPE/USDT ile yeniden başla.';
    } else if (command === '/start' || command === '/help' || command === '/yardim' || command === '/yardım') {
      reply = helpText();
    } else if (command === '/pozisyonlar' || command === '/kar' || command === '/kz' || command === '/pnl') {
      reply = formatPositions();
    } else if (command === '/rapor' || command === '/ozet' || command === '/özet') {
      reply = formatReport();
    } else if (command === '/status' || command === '/durum') {
      reply = formatStatus();
    } else if (command === '/bakiye' || command === '/balance') {
      reply = formatBalance();
    } else if (command === '/basla') {
      const status = getStatus() || {};
      if (String(status.mode || 'paper').toLowerCase() !== 'paper') {
        reply = 'Güvenlik nedeniyle Telegram üzerinden yalnızca Paper mod başlatılabilir. Canlı mod başlatılmadı.';
      } else if (status.running) {
        reply = 'Bot zaten çalışıyor.\n\n' + formatStatus();
      } else {
        try {
          await startBot();
          reply = '▶ Paper bot başlatma isteği başarıyla uygulandı.\n\n' + formatStatus();
        } catch (err) {
          reply = `⛔ Bot başlatılamadı: ${String(err && err.message || err).slice(0, 700)}`;
        }
      }
    } else if (command === '/bitir') {
      const status = getStatus() || {};
      if (!status.running) {
        reply = 'Bot zaten durmuş. Telegram komut dinleyicisi açık kalıyor.\n\n' + formatStatus();
      } else {
        try {
          await stopBot('Telegram /bitir komutu');
          reply = '⏹ Bot motoru durduruldu. Telegram komut dinleyicisi açık kalıyor; yeniden başlatmak için /basla yazabilirsin.\n\n' + formatStatus();
        } catch (err) {
          reply = `⛔ Bot durdurulamadı: ${String(err && err.message || err).slice(0, 700)}`;
        }
      }
    } else if (['/islemler', '/işlemler', '/islem', '/trades'].includes(command)) {
      const n = parseInt(text.split(/\s+/)[1], 10);
      reply = safeReply('/islemler', () => formatTrades(Number.isFinite(n) ? n : 10));
    } else if (command === '/neden' || command === '/why') {
      reply = safeReply('/neden', formatWhy);
    } else if (['/haftalik', '/haftalık', '/hafta', '/weekly'].includes(command)) {
      reply = safeReply('/haftalik', () => formatPeriod(7));
    } else if (['/aylik', '/aylık', '/ay', '/monthly'].includes(command)) {
      reply = safeReply('/aylik', () => formatPeriod(30));
    } else if (['/coinler', '/pariteler', '/coinlerim'].includes(command)) {
      reply = safeReply('/coinler', formatCoins);
    } else if (command === '/ayarlar' || command === '/settings') {
      reply = safeReply('/ayarlar', formatSettings);
    } else if (command === '/fiyat' || command === '/price') {
      reply = await priceReply(text.split(/\s+/)[1]);
    } else if (command === '/log' || command === '/loglar') {
      reply = safeReply('/log', () => formatLogs(text.split(/\s+/)[1]));
    } else {
      return false;
    }
    // Her mesajın başına [PAPER · Binance] gibi etiket eklenir; Telegram sınırı için uzun mesajlar bölünür.
    const label = labelPrefix();
    const chunks = splitMessage(label ? `${label} ${reply}` : reply);
    for (const chunk of chunks) await api('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true }, 10000);
    return true;
  }

  async function pollOnce() {
    const updates = await api('getUpdates', { offset, timeout: pollTimeoutSeconds, allowed_updates: ['message', 'edited_message'] }, (pollTimeoutSeconds + 10) * 1000);
    for (const update of updates || []) {
      if (Number.isSafeInteger(update.update_id)) offset = Math.max(offset, update.update_id + 1);
      try { await processUpdate(update); }
      catch (err) { logger.warn(`[telegram-komut] yanıt gönderilemedi: ${String(err && err.message || err).replace(token, '***')}`); }
    }
  }

  async function run() {
    while (!stopped) {
      try { await pollOnce(); warned = false; }
      catch (err) {
        if (!warned) {
          warned = true;
          logger.warn(`[telegram-komut] Telegram sorgusu başarısız: ${String(err && err.message || err).replace(token, '***')}`);
        }
        await new Promise((resolve) => { const timer = setTimeout(resolve, 3000); if (timer.unref) timer.unref(); });
      }
    }
  }

  function start() {
    if (!token || !chatId || !stopped) return false;
    stopped = false;
    // getUpdates ve webhook ayni anda kullanilamaz. Termux'taki bu uygulama polling
    // kullandigi icin eski webhook'u (bekleyen guncellemeleri silmeden) kaldir.
    loopPromise = (async () => {
      try { await api('deleteWebhook', { drop_pending_updates: false }, 10000); }
      catch (err) { logger.warn(`[telegram-komut] webhook temizlenemedi: ${String(err && err.message || err).replace(token, '***')}`); }
      if (!stopped) await run();
    })();
    if (loopPromise && typeof loopPromise.catch === 'function') loopPromise.catch(() => {});
    logger.log('[telegram-komut] etkin: /basla, /bitir, /durum, /bakiye, /pozisyonlar, /rapor, /islemler, /neden, /haftalik, /aylik, /coinler, /ayarlar, /fiyat, /log, /coin_ekle, /onayla, /iptal, /yardim');
    return true;
  }
  async function stop() { stopped = true; if (loopPromise) await Promise.race([loopPromise, new Promise((r) => setTimeout(r, 1000))]); loopPromise = null; }

  return { start, stop, processUpdate, formatStatus, formatBalance, formatPositions, formatReport, formatTrades, formatPeriod, formatCoins, formatSettings, formatWhy, formatLogs, helpText, configured: () => Boolean(token && chatId), getPendingSetup: () => setup };
}

module.exports = { createTelegramCommands };
