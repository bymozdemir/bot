// src/liveEngine.js
// Gercek emir motoru. PaperEngine'den ayri tutulur.
// Varsayilan olarak KAPALI: canli emir icin mode=live + LIVE_TRADING_ENABLED=true gerekir.

const strategies = require('./strategies');
const { roundDownToStep, splitCandles, timeframeMs, validateCandleSeries } = require('./execution');
const tfPolicy = require('./timeframePolicy');
const MIN_STOP_STEP_PCT = 0.25;
// ACIL CIKIS (koruma kalmadi / risk limiti asildi): normal giris filtreleri (spread %0.75, etki %0.50, derinlik 1.25x)
// alis icin tasarlandi. Cikis bu filtrelere takilirsa, ozellikle stop iptal edilmis ve pozisyon korumasizken, coin
// elde kalir ve borsadaki stop-market zaten (korumasiz) tetiklenir. Bu yuzden acil cikista esikler gevsetilir;
// emrin TUMUNU doldurmaya yetecek derinlik yine zorunludur (marketSafety.estimate bunu garanti eder).
const EMERGENCY_MAX_SPREAD_PCT = 5;
const EMERGENCY_MAX_SLIPPAGE_PCT = 3;
const EMERGENCY_MIN_DEPTH_COVERAGE = 1.0;
const { OrderManager, TERMINAL } = require('./orderManager');
const { AccountReconciler, managedBaseAssets } = require('./reconciliation');
const { LiveRecovery } = require('./liveRecovery');
const { BinanceUserDataStream } = require('./userDataStream');
const { positionReductionOnSell, realizedPnl, nonPairCommissionAssets } = require('./financial');
const { validateMarketOrder } = require('./orderRules');
const { checkMarketOrderSafety } = require('./marketSafety');
const { normalizePortfolioPolicy, canOpenPosition } = require('./portfolioPolicy');
const { withIstanbulTime } = require('./istanbulTime');

const iso = (ms) => new Date(ms).toISOString();
// Pozisyonu koruyan tüm SELL emir rolleri. Hareketli stop (profit-protection-stop) eksikse
// dolumu yok sayılır, satılmış pozisyon açık kalır ve koruma döngüsü ikinci SELL üretirdi.
const PROTECTIVE_ROLES = new Set(['protective-stop', 'protective-stop-recovery', 'protective-tp', 'profit-protection-stop']);

class LiveEngine {
  constructor({ exchange, store, state, onUpdate, notifier, nowFn, orderManager, reconciler, recovery, stream, allowLive = false } = {}) {
    this.exchange = exchange;
    this.store = store;
    this.state = state;
    this.onUpdate = onUpdate || (() => {});
    this.notifier = notifier || null;
    // Varsayilan saat: borsa saatine gore duzeltilmis zaman (varsa). Yerel saat ileri/geri ise mum KAPANISI yanlis
    // algilanir ve strateji henuz kapanmamis mumla karar verip o sinyali tuketirdi.
    this.nowFn = nowFn || (() => (exchange && typeof exchange.nowMs === 'function' ? exchange.nowMs() : Date.now()));
    this.allowLive = allowLive || process.env.LIVE_TRADING_ENABLED === 'true';
    this.orderManager = orderManager || new OrderManager({ exchange, state, store, nowFn, onOrderUpdate: (o) => this._onOrderUpdate(o) });
    this.reconciler = reconciler || new AccountReconciler({ exchange, state, store, nowFn });
    this.recovery = recovery || new LiveRecovery({ orderManager: this.orderManager, reconciler: this.reconciler, state, store, nowFn, repair: async (ctx) => this._repairRecoveredState(ctx) });
    this.stream = stream || null;
    this.timer = null;
    this.busy = false;
    this.epoch = 0;
    this.symbolRulesCache = {};
    this.lastReconcileAt = 0;
    this.reconcileEveryMs = 5 * 60 * 1000;
    this.stopUpdateLocks = new Map();
  }

  _lockSnapshot() {
    const live = this.state.live || {};
    return JSON.stringify([
      live.lockReason || null, this.state.killSwitch || null, this.state.liveReconciliation?.safeToTrade ?? null,
      live.stopRecoveryError || null, live.feeValuationWarning || null, live.criticalAlert || null,
      this.state.liveStreamWarning || null
    ]);
  }

  _onOrderUpdate(order) {
    if (!order || !order.symbol) return;
    const role = order.meta?.role;
    if (!PROTECTIVE_ROLES.has(role)) return;
    const status = String(order.status || '').toUpperCase();
    const pos = this.state.live?.positions?.[order.symbol];
    if (!pos || (pos.stopOrderId !== order.clientOrderId && pos.tpOrderId !== order.clientOrderId)) return;

    // Aynı sembol için arka arkaya gelen stop fill olaylarını seri işleriz.
    // Böylece iki PARTIALLY_FILLED mesajı aynı anda eski stopu iptal edip
    // iki yeni koruyucu stop oluşturamaz.
    const previous = this.stopUpdateLocks.get(order.symbol);
    const work = previous ? previous.then(() => this._handleProtectiveStopUpdate(order)) : this._handleProtectiveStopUpdate(order);
    const current = work.catch((err) => {
      this.state.live.safeToTrade = false;
      this.state.live.stopRecoveryError = { symbol: order.symbol, clientOrderId: order.clientOrderId, at: iso(this.nowFn()), error: err?.message || String(err) };
      this.persist();
      this.log(`${order.symbol}: koruyucu stop kurtarma başarısız: ${err?.message || String(err)}`, 'error');
    }).finally(() => {
      if (this.stopUpdateLocks.get(order.symbol) === current) this.stopUpdateLocks.delete(order.symbol);
    });
    this.stopUpdateLocks.set(order.symbol, current);
  }

  async _handleProtectiveStopUpdate(order) {
    const status = String(order.status || '').toUpperCase();
    if (status !== 'PARTIALLY_FILLED' && status !== 'FILLED') return;

    const symbol = order.symbol;
    const pos = this.state.live?.positions?.[symbol];
    const isTp = !!pos && pos.tpOrderId === order.clientOrderId;
    if (!pos || (!isTp && pos.stopOrderId !== order.clientOrderId)) return;

    const executionId = String(order.lastExecutionId || `${order.exchangeOrderId || order.clientOrderId}:${order.executedQty}:${order.quoteQty}`);
    const seen = new Set(pos.stopExecutionIds || []);
    if (seen.has(executionId)) return;
    seen.add(executionId);

    const cumulativeGross = Math.max(0, Number(order.executedQty || 0));
    const cumulativeBaseFee = Math.max(0, Number(order.commissionBase || 0));
    const cumulativeNetQuote = Math.max(0, Number(order.netQuoteQty ?? order.quoteQty ?? 0));
    const cumulativeThirdFee = this._orderFeeQuoteValue(order);
    if (cumulativeThirdFee === null) {
      this.state.live.safeToTrade = false;
      this.state.live.feeValuationWarning = { symbol, clientOrderId: order.clientOrderId, side: 'sell', at: iso(this.nowFn()), commissionByAsset: { ...(order.commissionByAsset || {}) } };
      this.state.live.unpricedRealizedTrades = (this.state.live.unpricedRealizedTrades || 0) + 1;
      this.persist();
      return;
    }

    const prevGross = Math.max(0, Number(pos.stopExecutedQty || 0));
    const prevBaseFee = Math.max(0, Number(pos.stopCommissionBase || 0));
    const prevNetQuote = Math.max(0, Number(pos.stopNetQuoteQty || 0));
    const prevThirdFee = Math.max(0, Number(pos.stopThirdAssetCommissionQuote || 0));
    const grossDelta = Math.max(0, cumulativeGross - prevGross);
    const baseFeeDelta = Math.max(0, cumulativeBaseFee - prevBaseFee);
    const netQuoteDelta = Math.max(0, cumulativeNetQuote - prevNetQuote);
    const thirdFeeDelta = Math.max(0, cumulativeThirdFee - prevThirdFee);
    const outflowQty = Math.min(pos.quantity, positionReductionOnSell(grossDelta, baseFeeDelta));
    const soldQty = Math.min(pos.quantity, grossDelta);

    pos.stopExecutedQty = cumulativeGross;
    pos.stopCommissionBase = cumulativeBaseFee;
    pos.stopNetQuoteQty = cumulativeNetQuote;
    pos.stopThirdAssetCommissionQuote = cumulativeThirdFee;
    pos.stopExecutionIds = [...seen];

    if (grossDelta <= 0 && outflowQty <= 0) {
      this.persist();
      return;
    }

    const proceeds = Math.max(0, netQuoteDelta - thirdFeeDelta);
    // Emir tamamen dolduysa ve geriye adimdan kucuk bir artik kaldiysa (koruyucu emir miktari
    // adima asagi yuvarlanmisti) pozisyon kapanmis sayilir; artik dust defterine yazilir.
    let dustLeft = 0;
    let pnlOutflow = outflowQty;
    if (status === 'FILLED') {
      const leftover = Math.max(0, pos.quantity - outflowQty);
      if (leftover > 1e-12) {
        let stepRules = null;
        try { stepRules = await this.getRules(symbol); } catch (_) { /* kurallar alinamazsa artik dust sayilmaz */ }
        const step = Number(stepRules?.stepSize || stepRules?.marketStepSize || 0);
        if (step > 0 && leftover < step - 1e-12) { dustLeft = leftover; pnlOutflow = pos.quantity; }
      }
    }
    const pnlResult = realizedPnl(pos, pnlOutflow, proceeds);
    this._recordLiveTrade(symbol, pos, order, soldQty, pnlResult, isTp ? 'take-profit' : 'protective stop');

    const remaining = Math.max(0, pos.quantity - pnlOutflow);
    pos.quantity = remaining;
    pos.costQuote = Math.max(0, Number(pos.costQuote || 0) - pnlResult.costBasis);

    const oppositeId = isTp ? pos.stopOrderId : pos.tpOrderId;

    // Yalnızca gerçekten sıfıra inmiş pozisyon silinebilir. FILLED yanıtı,
    // komisyon/yuvarlama/yanıt tutarsızlığı nedeniyle yerel pozisyon miktarıyla
    // uyuşmuyorsa kalan envanter korunur ve yeni koruyucu stop kurulur.
    if (remaining <= 1e-12) {
      if (oppositeId && oppositeId !== order.clientOrderId) {
        const canceledOpposite = await this.orderManager.cancel(oppositeId);
        if (!canceledOpposite || canceledOpposite.status !== 'CANCELED') {
          this.state.live.safeToTrade = false;
          this.state.live.protectiveCancelPending = { symbol, filledOrderId: order.clientOrderId, oppositeId, at: iso(this.nowFn()) };
          this.persist();
          throw new Error(`${symbol}: koruyucu emir gerçekleşti fakat karşı bacak kesin iptal edilemedi; canlı işlem kilitlendi.`);
        }
      }
      if (dustLeft > 0) this._addDust(symbol, dustLeft);
      delete this.state.live.positions[symbol];
      this.log(`${isTp ? 'TAKE-PROFIT' : 'KORUYUCU STOP'} GERÇEKLEŞTİ: ${symbol}`, 'warn');
      this.persist();
      return;
    }

    // Kısmi dolum veya FILLED yanıtına rağmen anlamlı kalan miktar: eski SELL
    // bacakları kalan pozisyondan büyük olabilir. Önce açık emirleri kesin iptal
    // et; terminal FILLED emrini iptal etmeye çalışma.
    if (status !== 'FILLED') {
      const canceled = await this.orderManager.cancel(order.clientOrderId);
      if (!canceled || canceled.status !== 'CANCELED') {
        this.state.live.safeToTrade = false;
        this.persist();
        throw new Error(`${symbol}: kısmi koruyucu emir sonrası mevcut emir kesin iptal edilemedi.`);
      }
    }
    if (oppositeId && oppositeId !== order.clientOrderId) {
      const opposite = await this.orderManager.cancel(oppositeId);
      if (!opposite || opposite.status !== 'CANCELED') {
        this.state.live.safeToTrade = false;
        this.state.live.protectiveCancelPending = { symbol, filledOrderId: order.clientOrderId, oppositeId, at: iso(this.nowFn()) };
        this.persist();
        throw new Error(`${symbol}: koruyucu dolumdan sonra karşı bacak iptal edilemedi; yeni SELL oluşturulmadı.`);
      }
    }

    // Kısmi take-profit sonrası TP'yi yeniden kurmak yerine kalan pozisyonu
    // stop ile koruyoruz. Böylece eski miktarlı TP/SL bacaklarından biri açık
    // kalmaz ve iki bağımsız koruyucu SELL aynı bakiyeyi tüketmeye çalışmaz.
    pos.stopOrderId = null;
    pos.tpOrderId = null;
    pos.tpPrice = null;
    pos.protectiveMode = 'single-stop';
    pos.stopExecutedQty = 0;
    pos.stopCommissionBase = 0;
    pos.stopNetQuoteQty = 0;
    pos.stopThirdAssetCommissionQuote = 0;
    pos.stopExecutionIds = [];

    const rules = await this.getRules(symbol);
    const stopPct = Number(this.state.pairs?.[symbol]?.params?.stopLossPct);
    const entryPrice = Number(pos.entryPrice || 0);
    const configuredStop = entryPrice > 0 && Number.isFinite(stopPct) && stopPct > 0
      ? entryPrice * (1 - stopPct / 100) : Number(pos.stopPrice || 0);
    const stopPrice = this._roundSellStopPrice(configuredStop, rules.tickSize);
    if (!(stopPrice > 0) || !Number.isFinite(stopPrice)) {
      this.state.live.safeToTrade = false;
      this.persist();
      throw new Error(`${symbol}: kısmi koruyucu dolum sonrası geçerli stop fiyatı hesaplanamadı.`);
    }
    const replacement = await this.orderManager.submitStop({ symbol, side: 'sell', amount: this._sellQty(remaining, rules), stopPrice, limitPrice: 0, meta: { role: 'protective-stop-recovery', entryClientOrderId: pos.entryOrderId } });
    pos.stopOrderId = replacement.clientOrderId;
    pos.stopPrice = stopPrice;
    if (replacement.status !== 'NEW' && replacement.status !== 'FILLED') {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: kısmi koruyucu emir yeniden kurulamadı (${replacement.status}).`);
    }
    this.state.live.safeToTrade = false;
    if (String(replacement.status).toUpperCase() === 'FILLED') { await this._handleProtectiveStopUpdate(replacement); return; }
    this.persist();
  }

  log(msg, level = 'info') {
    this.state.log.unshift({ t: iso(this.nowFn()), msg, level });
    this.state.log = this.state.log.slice(0, 200);
    console.log(`[live:${level}] ${msg}`);
  }

  notify(text, opts) {
    if (this.notifier) this.notifier.send(text, opts).catch(() => {});
  }

  persist() {
    this.store.save(this.state);
    this.onUpdate(this.state);
  }

  quoteAsset(symbol) {
    const q = String(symbol || '').toUpperCase().split('/')[1] || '';
    return q || null;
  }

  pairSupported(symbol) {
    const quotes = this.exchange.quoteAssets || [];
    if (!quotes.length) return true;
    const quote = this.quoteAsset(symbol);
    const active = String(this.state.settings.quoteAsset || quotes[0] || '').toUpperCase();
    return quotes.includes(quote) && quote === active;
  }

  ensureState() {
    if (!this.state.live || typeof this.state.live !== 'object') this.state.live = {};
    this.state.live.positions = this.state.live.positions || {};
    this.state.live.lastSignalT = this.state.live.lastSignalT || {};
    this.state.live.lastPrices = this.state.live.lastPrices || {};
    this.state.live.lastReconcileAt = this.state.live.lastReconcileAt || null;
    // Fail-closed: alan eksik/bozuksa kilitli başla; yalnızca start() mutabakattan sonra açar.
    this.state.live.safeToTrade = this.state.live.safeToTrade === true;
    this.state.live.trades = this.state.live.trades || [];
    this.state.live.stats = this.state.live.stats || { trades: 0, wins: 0, grossWin: 0, grossLoss: 0, realizedPnl: 0 };
    this.state.live.realizedPnl = Number.isFinite(Number(this.state.live.realizedPnl)) ? Number(this.state.live.realizedPnl) : 0;
    this.state.live.dayRealizedPnl = Number.isFinite(Number(this.state.live.dayRealizedPnl)) ? Number(this.state.live.dayRealizedPnl) : 0;
    this.state.live.startingEquityByQuote = this.state.live.startingEquityByQuote || {};
    this.state.live.dayStartEquityByQuote = this.state.live.dayStartEquityByQuote || {};
    this.state.live.dayRealizedPnlByQuote = this.state.live.dayRealizedPnlByQuote || {};
  }

  _validateRiskSettings() {
    const s = this.state.settings || {};
    s.portfolioPolicy = normalizePortfolioPolicy(s.portfolioPolicy);
    // Legacy scalar settings remain authoritative for backward-compatible direct state/test edits.
    s.portfolioPolicy.maxPositions = Number.isFinite(Number(s.maxConcurrentPositions)) ? Number(s.maxConcurrentPositions) : s.portfolioPolicy.maxPositions;
    s.portfolioPolicy.reserveCashPct = Number.isFinite(Number(s.reserveCashPct)) ? Number(s.reserveCashPct) : s.portfolioPolicy.reserveCashPct;
    const value = (key, fallback) => s[key] === undefined ? fallback : s[key];
    const maxPos = Number(value('maxConcurrentPositions', 3));
    const maxOpenOrders = Number(value('maxOpenOrders', 12));
    const reserve = Number(value('reserveCashPct', 10));
    const daily = Number(value('dailyLossLimitPct', 5));
    const total = Number(value('killSwitchLossPct', 25));
    const maxTrade = Number(value('maxTradeQuote', 0));
    const maxSpread = Number(value('maxMarketSpreadPct', 0.75));
    const maxSlip = Number(value('maxMarketSlippagePct', 0.50));
    const minDepth = Number(value('minMarketDepthCoverage', 1.25));
    const errors = [];
    if (!Number.isInteger(maxPos) || maxPos < 1) errors.push('maxConcurrentPositions geçersiz');
    if (!Number.isInteger(maxOpenOrders) || maxOpenOrders < 1) errors.push('maxOpenOrders geçersiz');
    if (!Number.isFinite(reserve) || reserve < 0 || reserve > 100) errors.push('reserveCashPct geçersiz');
    if (!Number.isFinite(daily) || daily < 0 || daily > 100) errors.push('dailyLossLimitPct geçersiz');
    if (!Number.isFinite(total) || total < 0 || total > 100) errors.push('killSwitchLossPct geçersiz');
    if (!Number.isFinite(maxTrade) || maxTrade < 0) errors.push('maxTradeQuote geçersiz');
    if (!Number.isFinite(maxSpread) || maxSpread <= 0 || maxSpread > 10) errors.push('maxMarketSpreadPct geçersiz');
    if (!Number.isFinite(maxSlip) || maxSlip <= 0 || maxSlip > 10) errors.push('maxMarketSlippagePct geçersiz');
    if (!Number.isFinite(minDepth) || minDepth < 1) errors.push('minMarketDepthCoverage geçersiz');
    return errors;
  }

  assertStartAllowed() {
    if (this.state.settings.mode !== 'live') throw new Error('Canlı motoru için settings.mode="live" olmalı.');
    const riskErrors = this._validateRiskSettings();
    if (riskErrors.length) throw new Error(`Canlı risk ayarları geçersiz: ${riskErrors.join(', ')}.`);
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      throw new Error('NODE_TLS_REJECT_UNAUTHORIZED=0 iken canlı mod başlatılamaz: TLS doğrulaması kapalıyken API anahtarı ve emirler ele geçirilebilir. Sertifika sorunu için NODE_EXTRA_CA_CERTS kullanın.');
    }
    if (!this.allowLive) throw new Error('Canlı işlem güvenlik kilidi kapalı. LIVE_TRADING_ENABLED=true olmadan gerçek emir gönderilmez.');
    // Gerçek borsalar için adaptorün REST sözleşmesi ayrıca doğrulanmış olmalı.
    // simulation çevrimdışı sahte borsadır; gerçek emir gönderemez.
    if (this.exchange.id === 'simulation') {
      // izin ver
    } else if (this.exchange.id === 'binance') {
      // Binance.com üretim/testnet kilitleri aşağıda uygulanır.
    } else if (this.exchange.id === 'binancetr') {
      if (process.env.ALLOW_BINANCE_TR_TRADING !== 'true') {
        throw new Error('Binance TR canlı işlem güvenlik kilidi kapalı. Önce ALLOW_BINANCE_TR_TRADING=true ile açıkça etkinleştirilmelidir.');
      }
    } else if (this.exchange.id === 'btcturk') {
      if (process.env.ALLOW_BTCTURK_TRADING !== 'true') {
        throw new Error('BTCTurk canlı işlem güvenlik kilidi kapalı. Önce ALLOW_BTCTURK_TRADING=true ile açıkça etkinleştirilmelidir.');
      }
    } else if (this.exchange.id === 'paribu') {
      if (process.env.ALLOW_PARIBU_TRADING !== 'true') {
        throw new Error('Paribu canlı işlem güvenlik kilidi kapalı. Önce ALLOW_PARIBU_TRADING=true ile açıkça etkinleştirilmelidir.');
      }
    } else {
      throw new Error(`Canlı işlem doğrulanmamış borsa için kapalı: "${this.exchange.id}".`);
    }
    if (process.env.BINANCE_ALLOW_LOCAL_BASE_URL === 'true') {
      throw new Error('BINANCE_ALLOW_LOCAL_BASE_URL yalnızca testler içindir; bu bayrakla canlı mod başlatılamaz.');
    }
    const caps = this.exchange.capabilities || {};
    if (caps.liveTradingVerified !== true) {
      throw new Error(`${this.exchange.name || this.exchange.id}: liveTradingVerified=false veya eksik; canlı başlatma engellendi (sandbox/gerçek hesap kanıtı gerekli).`);
    }
    if (!caps.clientOrderId || caps.recoveryByFingerprint === true || !caps.orderQuery || !caps.balanceQuery || !caps.openOrdersQuery) {
      throw new Error('Bu borsa güvenli canlı işlem için doğrulanmış clientOrderId + deterministik emir sorgulama yetenekleri gerekli.');
    }
    if (this.exchange.id === 'binance' && String(this.exchange.environment || 'production') === 'production' && process.env.ALLOW_PRODUCTION_TRADING !== 'true') {
      throw new Error('Binance üretim ortamı ek güvenlik kilidi nedeniyle kapalı. Önce Testnet doğrulaması tamamlanmalı; üretim için ALLOW_PRODUCTION_TRADING=true açıkça verilmelidir.');
    }
    const knownLiveExchange = ['binance','binancetr','btcturk','paribu'].includes(this.exchange.id);
    if (knownLiveExchange && caps.marketOrderBook !== true && typeof this.exchange.fetchOrderBook !== 'function') {
      throw new Error('Canlı MARKET emirleri için doğrulanmış order-book erişimi zorunlu; bu borsada canlı market emirleri kapalı.');
    }
    if (typeof this.exchange.createStopOrder !== 'function' || typeof this.exchange.cancelOrder !== 'function') {
      throw new Error('Canlı işlem için koruyucu stop emri desteği gerekli.');
    }
    for (const pair of Object.values(this.state.pairs || {})) {
      if (!pair.enabled) continue;
      let params = pair.params || {};
      try { params = { ...strategies.get(pair.strategyId).defaultParams, ...params }; } catch (_) { /* bilinmeyen strateji processPair'de uyarilir */ }
      { const tfErr = tfPolicy.timeframeProblem({ timeframe: pair.timeframe || this.state.settings.defaultTimeframe, strategyId: pair.strategyId, pollSeconds: this.state.settings.pollSeconds, mode: 'live' }); if (tfErr) throw new Error(`${pair.symbol}: ${tfErr} Canlı başlatma engellendi.`); }
      const hasTrailing = Boolean(params.trailingStop);
      if (this.exchange.id !== 'simulation' && hasTrailing && this.exchange.capabilities?.nativeTrailingOco !== true) {
        throw new Error(`${pair.symbol}: trailing stop için borsanın native trailing/OCO sözleşmesi doğrulanmamış; canlı başlatma engellendi.`);
      }
      if (hasTrailing && this.exchange.capabilities?.orderQuery !== true) {
        throw new Error(`${pair.symbol}: trailing stop için güvenli emir sorgulama yeteneği gerekli.`);
      }
    }
    // GERCEK borsada "0 = sinirsiz/kapali" anlamina gelen risk ayarlari ile baslatilmaz: ilk canli
    // denemede tek islem tutari ve zarar kesiciler acikca belirlenmis olmali.
    if (this.exchange.id !== 'simulation') {
      const s = this.state.settings || {};
      const missing = [];
      if (!(Number(s.maxTradeQuote) > 0)) missing.push('maxTradeQuote (işlem başına üst tutar) 0 olamaz');
      if (!(Number(s.killSwitchLossPct) > 0)) missing.push('killSwitchLossPct (toplam zarar limiti) 0 olamaz');
      if (!(Number(s.dailyLossLimitPct) > 0)) missing.push('dailyLossLimitPct (günlük zarar limiti) 0 olamaz');
      if (missing.length) throw new Error(`Gerçek borsada canlı başlatma için risk limitleri zorunlu: ${missing.join('; ')}.`);
    }
  }

  // Ayarlardan kontrol sikligi degisince (server.js) calisan zamanlayici yeni aralikla kurulur.
  reschedule() {
    if (this.timer) this._schedule();
  }

  _schedule() {
    if (this.timer) clearInterval(this.timer);
    const ms = Math.max(15, Number(this.state.settings.pollSeconds) || 60) * 1000;
    this.timer = setInterval(() => this.safeTick(), ms);
  }

  async _repairRecoveredState({ account } = {}) {
    this.ensureState();
    const positions = this.state.live.positions || (this.state.live.positions = {});
    const openOrders = Array.isArray(account?.openOrders) ? account.openOrders : [];
    let changed = false;

    // 1) UNKNOWN/PENDING entry emirleri borsada FILLED olduysa pozisyonu yeniden kur.
    // Aynı clientOrderId için ikinci BUY kesinlikle gönderilmez; mevcut dolum muhasebeye alınır.
    for (const order of Object.values(this.state.liveOrders || {})) {
      const role = order?.meta?.role;
      const status = String(order?.status || '').toUpperCase();
      if (role !== 'entry' || status !== 'FILLED' || !(Number(order.netExecutedQty ?? order.executedQty) > 0)) continue;
      const symbol = String(order.symbol || '').toUpperCase();
      if (!symbol || positions[symbol]) continue;
      const side = String(order.side || '').toLowerCase();
      if (side !== 'buy') continue;
      const filledQty = Number(order.netExecutedQty ?? order.executedQty);

      // KRITIK: Bu giris daha once satilip kapatilmis olabilir (yerel pozisyonun olmamasinin NORMAL nedeni).
      // Girise bagli (entryOrderId / entryClientOrderId) SELL emirlerinin dolum miktari dusulur; geriye adim
      // kadar bile coin kalmadiysa pozisyon KAPANMISTIR ve yeniden KURULMAZ. Eskiden tamamlanmis her al-sat
      // sonrasi yeniden baslatmada hayalet pozisyon uretiliyor, stop kurulamayinca canli mod acilamiyordu.
      let soldLinked = 0;
      for (const o of Object.values(this.state.liveOrders || {})) {
        if (!o || String(o.side || '').toLowerCase() !== 'sell') continue;
        const link = o.meta?.entryOrderId || o.meta?.entryClientOrderId;
        if (link !== order.clientOrderId) continue;
        soldLinked += Number(o.executedQty || 0);
      }
      const remainingQty = filledQty - soldLinked;
      let stepRules = null;
      try { stepRules = await this.getRules(symbol); } catch (_) { /* kurallar yoksa asagida atlanir */ }
      const stepSize = Number(stepRules?.stepSize || stepRules?.marketStepSize || 0);
      if (!(remainingQty > Math.max(stepSize, 1e-12))) continue; // kapanmis giris
      // Ikinci kanit: hesapta bu coin GERCEKTEN var mi? Yoksa (elle satilmis vb.) pozisyon kurulmaz.
      const baseAsset = symbol.split('/')[0];
      const heldTotal = Number(account?.balances?.[baseAsset]?.total);
      if (!Number.isFinite(heldTotal) || heldTotal + Math.max(1e-10, remainingQty * 1e-6) < remainingQty) {
        this.log(`${symbol}: kayıtlı giriş emri açık görünüyor ama hesapta yeterli ${baseAsset} yok; pozisyon yeniden kurulmadı.`, 'warn');
        continue;
      }
      const thirdFee = this._orderFeeQuoteValue(order);
      if (thirdFee === null) throw new Error(`${symbol}: recovery sırasında üçüncü varlık komisyonu değerlenemedi.`);
      const grossQuote = Number(order.netQuoteQty ?? order.quoteQty ?? 0);
      const quoteSpent = grossQuote + thirdFee;
      if (!(filledQty > 0) || !(quoteSpent > 0)) throw new Error(`${symbol}: recovery BUY muhasebesi geçersiz.`);
      const avgPrice = quoteSpent / filledQty;
      const pairCfg = this.state.pairs?.[symbol];
      if (!pairCfg) throw new Error(`${symbol}: recovery BUY için pair yapılandırması bulunamadı.`);
      let params = pairCfg.params || {};
      try { params = { ...strategies.get(pairCfg.strategyId).defaultParams, ...params }; } catch (_) {}
      positions[symbol] = {
        symbol,
        baseAsset: symbol.split('/')[0],
        quoteAsset: symbol.split('/')[1],
        quantity: remainingQty,
        entryPrice: avgPrice,
        costQuote: quoteSpent * (remainingQty / filledQty),
        entryCommissionTotal: Number(order.commissionTotal || 0),
        entryCommissionByAsset: { ...(order.commissionByAsset || {}) },
        entryThirdAssetCommissionQuote: thirdFee,
        entryThirdAssetCommissionValuation: order.thirdAssetCommissionValuation || {},
        openedAt: order.createdAt || iso(this.nowFn()),
        entryOrderId: order.clientOrderId,
        stopOrderId: null,
        stopPrice: null,
        tpOrderId: null,
        tpPrice: null,
        protectiveMode: 'single-stop',
        nativeTrailing: false,
        orderListId: null,
        takeProfitPct: Number(params.takeProfitPct || 0),
        trailingStop: Boolean(params.trailingStop),
        highWaterMark: avgPrice,
        reason: order.meta?.reason || 'recovered-entry',
        stopExecutedQty: 0,
        stopCommissionBase: 0,
        stopNetQuoteQty: 0,
        stopThirdAssetCommissionQuote: 0,
        stopExecutionIds: []
      };
      changed = true;
    }

    // 2) Borsada açık ama local state'e bağlanmamış protective SELL varsa, yalnızca
    // miktarı pozisyonla birebir eşleşen ve tek anlamlı aday varsa sahiplen.
    for (const [symbol, pos] of Object.entries(positions)) {
      const known = new Set([pos.stopOrderId, pos.tpOrderId].filter(Boolean).map(String));
      const candidates = openOrders.filter((o) =>
        String(o.symbol || '').toUpperCase() === symbol &&
        String(o.side || '').toLowerCase() === 'sell' &&
        ['NEW','PARTIALLY_FILLED'].includes(String(o.status || '').toUpperCase()) &&
        o.clientOrderId && !known.has(String(o.clientOrderId))
      );
      const expectedQty = Number(pos.quantity || 0);
      const qtyCandidates = candidates.filter((o) => {
        const q = Number(o.origQty ?? o.amount ?? 0);
        return q > 0 && q <= expectedQty + Math.max(1e-10, expectedQty * 1e-8) && (expectedQty - q) <= Math.max(1e-6, expectedQty * 1e-6);
      });
      if (pos.protectiveMode === 'oco') {
        // OCO iki leg olmalı. Tek leg bulunursa mevcut korumanın tamamlandığı kanıtlanmış değildir.
        if (qtyCandidates.length === 2) {
          const sorted = [...qtyCandidates].sort((a,b) => Number(a.stopPrice || 0) - Number(b.stopPrice || 0));
          const stop = sorted[0], tp = sorted[1];
          this.orderManager._record(stop.clientOrderId, { ...stop, exchangeOrderId: stop.exchangeOrderId ?? stop.orderId ?? null, type:'STOP_LOSS', meta:{ ...(stop.meta||{}), role:'protective-stop-recovery', entryClientOrderId:pos.entryOrderId, recovered:true } });
          this.orderManager._record(tp.clientOrderId, { ...tp, exchangeOrderId: tp.exchangeOrderId ?? tp.orderId ?? null, type:'TAKE_PROFIT', meta:{ ...(tp.meta||{}), role:'protective-tp', entryClientOrderId:pos.entryOrderId, recovered:true } });
          pos.stopOrderId = stop.clientOrderId; pos.tpOrderId = tp.clientOrderId;
          pos.stopPrice = Number(stop.stopPrice || pos.stopPrice || 0) || pos.stopPrice;
          pos.tpPrice = Number(tp.stopPrice || tp.price || 0) || pos.tpPrice;
          pos.orderListId = stop.orderListId ?? tp.orderListId ?? null;
          changed = true;
        } else if (qtyCandidates.length === 1) {
          throw new Error(`${symbol}: OCO recovery sırasında yalnızca tek koruyucu leg bulundu; ikinci leg doğrulanmadan yeni SELL gönderilmeyecek.`);
        }
      } else if (!pos.stopOrderId) {
        if (qtyCandidates.length === 1) {
          const stop = qtyCandidates[0];
          this.orderManager._record(stop.clientOrderId, { ...stop, exchangeOrderId: stop.exchangeOrderId ?? stop.orderId ?? null, type:'STOP_LOSS', meta:{ ...(stop.meta||{}), role:'protective-stop-recovery', entryClientOrderId:pos.entryOrderId, recovered:true } });
          pos.stopOrderId = stop.clientOrderId;
          pos.stopPrice = Number(stop.stopPrice || pos.stopPrice || 0) || pos.stopPrice;
          pos.protectiveMode = 'single-stop';
          changed = true;
        } else if (qtyCandidates.length > 1) {
          throw new Error(`${symbol}: birden fazla eşleşen koruyucu SELL bulundu; duplicate koruma riski nedeniyle işlem kilitlendi.`);
        }
      }
    }

    // 3) Recovered position protection yoksa yeni koruma kur; ama yalnızca exchange'te
    // eşleşen orphan koruma bulunmadığı kesinleştikten sonra.
    for (const [symbol, pos] of Object.entries(positions)) {
      const pairCfg = this.state.pairs?.[symbol];
      if (!pairCfg) throw new Error(`${symbol}: recovery position yapılandırması bulunamadı.`);
      let params = pairCfg.params || {};
      try { params = { ...strategies.get(pairCfg.strategyId).defaultParams, ...params }; } catch (_) {}
      const rules = await this.getRules(symbol);
      const refPrice = Number(pos.entryPrice || 0);
      if (!(refPrice > 0)) throw new Error(`${symbol}: recovery pozisyon fiyatı geçersiz.`);
      const stopPct = Number(params.stopLossPct);
      if (!(stopPct > 0 && stopPct < 100)) throw new Error(`${symbol}: recovery stopLossPct geçersiz.`);
      if (!pos.stopOrderId) {
        const stopPrice = this._roundSellStopPrice(refPrice * (1 - stopPct/100), rules.tickSize);
        const qty = this._sellQty(pos.quantity, rules);
        if (!(qty > 0)) throw new Error(`${symbol}: recovery stop miktarı geçersiz.`);
        const stop = await this.orderManager.submitStop({ symbol, side:'sell', amount:qty, stopPrice, limitPrice:0, meta:{role:'protective-stop-recovery', entryClientOrderId:pos.entryOrderId, recovered:true} });
        if (!['NEW','FILLED'].includes(String(stop.status).toUpperCase())) throw new Error(`${symbol}: recovery stop kurulamadı (${stop.status}).`);
        pos.stopOrderId = stop.clientOrderId; pos.stopPrice = stopPrice; pos.protectiveMode='single-stop'; pos.tpOrderId=null; pos.tpPrice=null; pos.orderListId=null;
        changed = true;
      }
    }
    if (changed) this.persist();
    return { changed };
  }

  async start() {
    if (this.timer) return;
    this.assertStartAllowed();
    if (this.state.killSwitch) throw new Error(`Kill switch devrede: ${this.state.killSwitch.reason}`);

    this.ensureState();
    await this._assertApiKeySafe();
    const recovery = await this.recovery.recover();
    if (!recovery.safeToTrade) {
      this.state.live.safeToTrade = false;
      this.persist();
      throw new Error('Canlı başlangıç güvenli değil: emir/bakiye mutabakatı tamamlanamadı.');
    }

    if (this.stream) {
      try {
        await this.stream.start();
      } catch (err) {
        this.state.live.safeToTrade = false;
        this.persist();
        throw new Error(`User Data Stream başlatılamadı: ${err.message}`);
      }
    }

    this.state.running = true;
    this.state.live.safeToTrade = true;
    this.log('Canlı motor başlatıldı.');
    this.notify('▶ Canlı işlem motoru başlatıldı.', { key: 'live-start', minIntervalMs: 60000 });
    this.persist();
    this._schedule();
    this.safeTick();
  }

  // Para cekme (withdraw) yetkisi acik bir anahtarla canli islem BASLATILMAZ. Yetki sorgusu
  // yapilamazsa (testnet / desteklemeyen borsa / izin eksigi) uyari yazilir ve panelde
  // "dogrulanamadi" olarak isaretlenir; yetki acikca aciksa baslatma reddedilir.
  async _assertApiKeySafe() {
    this.state.live.apiRestrictionsChecked = false;
    if (typeof this.exchange.fetchApiRestrictions !== 'function') return;
    if (this.exchange.id === 'binance' && String(this.exchange.environment || 'production') !== 'production') return;
    let info;
    try {
      info = await this.exchange.fetchApiRestrictions();
    } catch (err) {
      this.state.live.apiRestrictionsUnverified = err?.message || String(err);
      this.log(`API anahtarı yetkileri doğrulanamadı (${this.state.live.apiRestrictionsUnverified}). Para çekme yetkisinin KAPALI olduğunu borsa panelinden elle teyit et.`, 'warn');
      return;
    }
    this.state.live.apiRestrictionsUnverified = null;
    if (info && info.enableWithdrawals === true) {
      throw new Error('API anahtarında PARA ÇEKME yetkisi açık. Güvenlik için canlı mod başlatılmadı; anahtarı yalnızca okuma + spot işlem yetkisiyle yeniden oluştur.');
    }
    this.state.live.apiRestrictionsChecked = true;
  }

  async stop(reason = 'Kullanıcı durdurdu.') {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.epoch++;
    this.state.running = false;
    if (this.stream) await this.stream.stop().catch(() => {});
    this.log('Canlı bot durduruldu: ' + reason);
    this.persist();
  }

  safeTick() {
    return this.tick().catch((e) => {
      this.log('Canlı tick hatası: ' + e.message, 'error');
      // Ornegin "koruyucu stop reddedildi" gibi durumlarda gercek pozisyon korumasiz kalabilir: sesli bildir.
      this.notify(`🚨 Canlı tick hatası: ${e.message}`, { key: 'live-tick-error', minIntervalMs: 5 * 60000 });
    });
  }

  async _reconcileIfDue() {
    const now = this.nowFn();
    if (now - this.lastReconcileAt < this.reconcileEveryMs) return this.state.live?.safeToTrade === true;
    // WebSocket kopmasi sirasinda dolan emirler (ozellikle koruyucu stop) REST ile yakalanir;
    // aksi halde bakiye uyusmazligi canli islemi kalici kilitlerdi.
    if (typeof this.orderManager?.refreshPending === 'function') {
      try {
        const rp = await this.orderManager.refreshPending();
        if (rp.failed > 0) this.log(`${rp.failed} bekleyen emrin durumu şimdilik tazelenemedi (geçici ağ hatası olabilir); kayıtlar korunuyor.`, 'warn');
        await Promise.all([...this.stopUpdateLocks.values()]);
      } catch (err) {
        this.log(`Emir durumu REST ile güncellenemedi: ${err?.message || String(err)}`, 'warn');
      }
    }
    const r = await this.reconciler.reconcile();
    this.lastReconcileAt = now;
    this.state.live.lastReconcileAt = iso(now);
    this.state.live.lastBalance = r.balances || null;
    this.state.live.safeToTrade = r.safeToTrade === true;
    // Mutabakat temiz ve her pozisyonun korumasi dogrulandiysa eski kilit nedenleri/uyarilari temizlenir;
    // aksi halde panel cozulmus bir sorunu sonsuza dek "KILIT NEDENI" diye gostermeye devam ederdi.
    if (this.state.live.safeToTrade) {
      this.state.live.lockReason = null;
      this.state.live.stopReplacementError = null;
      this.state.live.stopRecoveryError = null;
      this.state.live.criticalAlert = null;
    }
    this.persist();
    return this.state.live.safeToTrade;
  }

  async tick() {
    if (!this.state.running || this.busy) return;
    this.busy = true;
    const epoch = this.epoch;
    let tickFailed = false;
    try {
      this.ensureState();
      // Önceki reconciliation başarısız olduysa burada kalıcı kilitlenme
      // yaşanmamalı. _reconcileIfDue kendi periyodunu uygular ve zamanı
      // geldiğinde yeniden bakiye/açık emir/koruyucu emir mutabakatı yapar.
      // Eski başarısız sonucu sadece güvenli durum bilgisi olarak kullanmak,
      // yeni reconciliation çağrısını hiç çalıştırmayan bir deadlock yaratır.
      await this._reconcileIfDue();
      // Güvenlik kilidi yeni girişleri durdurur; mevcut pozisyonların korumasını
      // durdurmamalıdır. Stop eksikse burada REST üzerinden yeniden kurmayı deneriz.
      await this._ensurePositionProtection();
      if (this.stream && this.state.liveStream && this.state.liveStream.connected !== true) {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = 'User Data Stream bağlı değil';
        this.persist();
        return;
      }
      // Yeni sinyalleri değerlendirmeden ÖNCE risk kapısını çalıştır.
      // Böylece günlük/toplam zarar limiti zaten aşılmışsa aynı tick içinde
      // yeni bir alış emri açılmaz.
      await this._checkRiskGate();
      if (!this.state.running || !this.state.live.safeToTrade) return;
      for (const [symbol, pairCfg] of Object.entries(this.state.pairs)) {
        if (!pairCfg.enabled && !this.state.live.positions[symbol]) continue;
        if (!this.pairSupported(symbol)) continue;
        try {
          await this.processPair(symbol, pairCfg, epoch);
          if (this.state.live.lastPairError?.symbol === symbol) this.state.live.lastPairError = null;
        } catch (err) {
          // Tek bir bozuk/delist edilmiş parite diğer paritelerin satış ve stop
          // işlemlerini durduramaz. Pozisyon varsa koruma kilitli kalır ama loop devam eder.
          this.log(`${symbol}: parite tick hatası: ${err?.message || String(err)}`, 'error');
          this.state.live.lastPairError = { symbol, at: iso(this.nowFn()), error: err?.message || String(err) };
          this.persist();
        }
        if (epoch !== this.epoch) return;
      }
      await this._checkRiskGate();
    } catch (err) {
      tickFailed = true;
      throw err;
    } finally {
      this.busy = false;
      // Nabiz (dead-man's switch): paper motoru gibi canli motor da her BASARILI turda ping atar.
      // Kilitli olsa bile surec yasiyorsa ping gider; surec/ag giderse ping kesilir ve servis haber verir.
      if (!tickFailed && this.notifier && typeof this.notifier.ping === 'function') this.notifier.ping().catch(() => {});
      // Guvenli durumdan kilitli duruma gecis: yeni emirler durur, kullaniciya haber ver.
      const safeNow = this.state.live && this.state.live.safeToTrade === true;
      if (this._wasSafe && !safeNow) {
        this.notify('🔒 CANLI İŞLEM KİLİTLENDİ: yeni emirler durdu, açık pozisyonlar ve stop emirleri korunuyor mu kontrol et (log\'a bak).', { key: 'live-locked', minIntervalMs: 10 * 60000 });
      }
      this._wasSafe = safeNow;
    }
  }

  async _ensurePositionProtection() {
    let recoveredAny = false;
    const positions = this.state.live?.positions || {};
    for (const [symbol, position] of Object.entries(positions)) {
      const stopId = position?.stopOrderId;
      const stop = stopId ? this.orderManager.get(stopId) : null;
      const stopStatus = String(stop?.status || '').toUpperCase();
      if (stopId && (stopStatus === 'NEW' || stopStatus === 'PARTIALLY_FILLED')) continue;
      // Stop dolmuş/kısmi dolup kapanmışsa önce dolumu muhasebeleştir. Aksi halde satılmış miktar
      // için yeni SELL stop kurulur (oversell) veya kalan miktar yanlış korunur.
      if (stop && Number(stop.executedQty || 0) > 0) {
        const pendingLock = this.stopUpdateLocks.get(symbol);
        if (pendingLock) await pendingLock.catch(() => {});
        await this._handleProtectiveStopUpdate({ ...stop, status: stopStatus === 'FILLED' ? 'FILLED' : 'PARTIALLY_FILLED' });
        if (!this.state.live.positions[symbol]) continue;
        if (stopStatus === 'FILLED') continue;
      }

      // Belirsiz/pending aynı sembol emri varken ikinci bir SELL stop üretmek
      // oversell riskidir; önce reconciliation çözülmelidir.
      const blocking = this.orderManager.listPending().find((o) =>
        o && o.symbol === symbol && (o.uncertain === true || String(o.status).toUpperCase() === 'UNKNOWN')
      );
      if (blocking) {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = `${symbol}: belirsiz emir ${blocking.clientOrderId} çözülmedi`;
        continue;
      }

      try {
        // Fiyat zaten stop seviyesinin ALTINA indiyse SELL-stop kurulamaz (borsa "hemen tetiklenir" diye
        // reddeder) ve pozisyon sonsuza dek korumasiz kalirdi. Bu durumda piyasadan kontrollu cikis yapilir.
        let lastPrice = Number(this.state.live?.lastPrices?.[symbol]);
        try { const t = await this.exchange.fetchTicker(symbol); if (Number(t?.price) > 0) lastPrice = Number(t.price); } catch (_) { /* son bilinen fiyat */ }
        if (Number(position.stopPrice) > 0 && lastPrice > 0 && lastPrice <= Number(position.stopPrice)) {
          this.log(`${symbol}: fiyat (${lastPrice}) stop seviyesinin (${position.stopPrice}) altında ve koruma yok; piyasadan çıkış deneniyor.`, 'warn');
          this.state.live.safeToTrade = false;
          await this.sell(symbol, position, lastPrice, 'koruma kurulamadı: fiyat stop seviyesinin altında', this.epoch, { emergency: true });
          this.persist();
          continue;
        }
        const rules = await this.getRules(symbol);
        const { stop: replacement, stopPrice } = await this._placeProtectiveStop(symbol, position, position.quantity, rules);
        if (replacement.status === 'NEW' || replacement.status === 'FILLED') {
          position.stopOrderId = replacement.clientOrderId;
          position.stopPrice = stopPrice;
          position.protectiveMode = 'single-stop';
          position.nativeTrailing = false;
          this.state.live.stopRecoveryError = null;
          this.state.live.lockReason = null;
          recoveredAny = true;
          this.log(`${symbol}: eksik koruyucu stop yeniden kuruldu.`, 'warn');
        } else {
          this.state.live.safeToTrade = false;
          this.state.live.stopRecoveryError = { symbol, at: iso(this.nowFn()), error: `Stop sonucu: ${replacement.status}` };
        }
      } catch (err) {
        this.state.live.safeToTrade = false;
        this.state.live.stopRecoveryError = { symbol, at: iso(this.nowFn()), error: err?.message || String(err) };
        this.log(`${symbol}: koruyucu stop yeniden kurulamadı: ${err?.message || String(err)}`, 'error');
      }
      this.persist();
    }
    if (recoveredAny) {
      // Stop gerçekten borsada açık mı diye hemen doğrula; 5 dakikalık normal
      // reconciliation aralığını beklemek gereksiz bir güvenlik kilidi yaratmasın.
      try {
        const r = await this.reconciler.reconcile();
        this.lastReconcileAt = this.nowFn();
        this.state.live.lastReconcileAt = iso(this.lastReconcileAt);
        this.state.live.lastBalance = r.balances || null;
        this.state.live.safeToTrade = r.safeToTrade === true;
        this.persist();
      } catch (err) {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = `Stop kurtarma sonrası doğrulama başarısız: ${err?.message || String(err)}`;
        this.persist();
      }
    }
  }

  async processPair(symbol, pairCfg, epoch) {
    let strategy;
    try { strategy = strategies.get(pairCfg.strategyId); } catch (e) { this.log(`${symbol}: ${e.message}`, 'warn'); return; }
    const params = { ...strategy.defaultParams, ...(pairCfg.params || {}) };
    const paramError = strategies.validateParams(strategy.id, params);
    if (paramError) { this.log(`${symbol}: geçersiz strateji parametreleri: ${paramError}`, 'warn'); return; }

    const timeframe = pairCfg.timeframe || this.state.settings.defaultTimeframe;
    const candles = await this.exchange.fetchCandles(symbol, timeframe, Math.min(1000, strategies.candleLimit(strategy, params) + 1));
    validateCandleSeries(candles, timeframe);
    const ticker = await this.exchange.fetchTicker(symbol);
    if (epoch !== this.epoch) return;
    const price = Number(ticker.price);
    if (!Number.isFinite(price) || price <= 0) return;
    this.state.live.lastPrices[symbol] = price;

    const position = this.state.live.positions[symbol] || null;
    // Koruyucu emir senkronizasyonu sinyal dedup'undan ÖNCE çalışır: böylece
    // aynı mum içinde de trailing stop gerçek borsa emriyle yukarı taşınabilir.
    if (position) await this._syncTrailingStop(symbol, position, params, price);
    const { closed, forming } = splitCandles(candles, this.nowFn());
    if (!closed.length) return;
    const lastClosed = closed[closed.length - 1];
    if (this.state.live.lastSignalT[symbol] === lastClosed.t) return;

    const decision = strategy.evaluate({ candles: closed, position, params });
    this.state.live.lastSignalT[symbol] = lastClosed.t;

    // Sinyal taze mi? (kagit motorla ayni kural) Mum kapanisindan cok sonra -bot kapaliydi, parite yeni
    // eklendi, ag kesildi- bir ALIM sinyali bilinmeyen bir fiyattan gercek para harcatir: UYGULANMAZ.
    // Eski bir SATIM sinyali ise riski azalttigi icin yine uygulanir.
    const pollMs = Math.max(15, Number(this.state.settings.pollSeconds) || 60) * 1000;
    const step = forming ? forming.t - lastClosed.t : (candles.length > 1 ? lastClosed.t - candles[candles.length - 2].t : timeframeMs(timeframe));
    const closeT = forming ? forming.t : lastClosed.t + (step || timeframeMs(timeframe));
    const maxAgeMs = Math.min(Math.max(3 * pollMs, 120000), Math.max(60000, (step || timeframeMs(timeframe) || 3600000) / 2));
    const now = this.nowFn();
    // Never bypass stale-signal protection in production for synthetic timestamps.
    // Tests using fixture timestamps must inject a matching clock.
    const ageMs = Math.max(0, now - closeT);
    const fresh = ageMs <= maxAgeMs;
    this.state.decisions[symbol] = { action: decision.action, reason: decision.reason, candleT: lastClosed.t, evaluatedAt: iso(this.nowFn()), price, mode: 'live', stale: !fresh };
    this.persist();

    if (decision.action === 'buy' && !fresh) {
      this.log(`${symbol}: alım sinyali eski (${Math.round(ageMs / 60000)} dk önce kapanan mum), gerçek emir gönderilmedi.`, 'info');
    } else if (decision.action === 'buy' && pairCfg.enabled && !position) {
      await this.buy(symbol, pairCfg, params, price, decision.reason, epoch);
    } else if (decision.action === 'sell' && position) {
      try {
        await this.sell(symbol, position, price, decision.reason, epoch);
      } catch (err) {
        // Basarisiz cikis sinyali bu muma TUKETILMIS sayilmaz: sonraki turda (kilit acilinca) yeniden denenir.
        // Aksi halde ornegin 4 saatlik mumda bir ag hatasi, cikis sinyalini 4 saat boyunca yutardi.
        if (this.state.live.lastSignalT[symbol] === lastClosed.t) delete this.state.live.lastSignalT[symbol];
        this.persist();
        throw err;
      }
    }
  }

  async getRules(symbol) {
    if (this.symbolRulesCache[symbol]) return this.symbolRulesCache[symbol];
    const r = await this.exchange.fetchSymbolRules(symbol);
    this.symbolRulesCache[symbol] = r;
    return r;
  }

  _orderFeeQuoteValue(order) {
    const symbol = String(order?.symbol || '').toUpperCase().replace('/', '');
    const quotes = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TRY', 'EUR', 'BTC', 'ETH'];
    const quote = quotes.find((q) => symbol.endsWith(q)) || '';
    const base = quote ? symbol.slice(0, -quote.length) : '';
    const third = nonPairCommissionAssets({ byAsset: order?.commissionByAsset || order?.commission?.byAsset || {} }, base, quote);
    if (!third.length) return 0;
    if (order?.thirdAssetCommissionValuationComplete !== true) return null;
    const value = Number(order?.thirdAssetCommissionQuote);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  _roundSellStopPrice(price, tickSize) {
    const p = Number(price);
    const t = Number(tickSize);
    if (!(p > 0)) return 0;
    if (!(t > 0)) return p;
    const quotient = p / t;
    const nearest = Math.round(quotient);
    // Normalize binary representation noise (e.g. 120 * 0.97 becomes
    // 116.39999999999999). For a SELL stop, a one-tick downward rounding
    // caused only by float noise is unnecessary and can delay protection.
    const normalized = Math.abs(quotient - nearest) <= 1e-8 ? nearest * t : Math.floor(quotient) * t;
    return Number(normalized.toFixed(Math.min(12, Math.max(0, String(t).split('.')[1]?.length || 0))));
  }

  // Satilabilir/koruyucu emir miktari: borsa adimina (LOT_SIZE / MARKET_LOT_SIZE) ASAGI yuvarlanir.
  // Alimda baz varlik komisyonu dusulunce net miktar adim katı olmaz; yuvarlanmadan gonderilirse
  // hem market satis hem koruyucu stop "LOT_SIZE" filtresiyle reddedilir ve pozisyondan cikilamaz.
  _sellQty(qty, rules, { market = false } = {}) {
    const q = Number(qty);
    if (!(q > 0)) return 0;
    const step = market
      ? Number(rules?.marketStepSize || rules?.stepSize || 0)
      : Number(rules?.stepSize || rules?.marketStepSize || 0);
    return step > 0 ? roundDownToStep(q, step) : q;
  }

  _addDust(symbol, qty) {
    const base = String(symbol || '').toUpperCase().split('/')[0];
    const q = Number(qty);
    if (!base || !(q > 0)) return;
    this.state.live.dustByAsset = this.state.live.dustByAsset || {};
    this.state.live.dustByAsset[base] = Number(this.state.live.dustByAsset[base] || 0) + q;
  }

  // takeProfitPct <= 0 kâr koruma aktivasyonunu kapatır.
  _tpEnabled(pct) {
    const n = Number(pct);
    return Number.isFinite(n) && n > 0;
  }

  _pairParams(symbol) {
    const pair = this.state.pairs?.[symbol] || {};
    let defaults = {};
    try { defaults = strategies.get(pair.strategyId).defaultParams || {}; } catch (_) { /* bilinmeyen strateji */ }
    return { ...defaults, ...(pair.params || {}) };
  }

  // Tek bir koruyucu stop kurar (kismi dolum / satis iptali / yeniden koruma icin ortak yol).
  async _placeProtectiveStop(symbol, position, qty, rules, role = 'protective-stop-recovery') {
    const stopPct = Number(this._pairParams(symbol).stopLossPct);
    let stopPrice = Number(position.stopPrice);
    if (!(stopPrice > 0)) {
      if (!(stopPct > 0)) throw new Error(`${symbol}: koruyucu stop için geçerli stopLossPct yok.`);
      stopPrice = Number(position.entryPrice || 0) * (1 - stopPct / 100);
    }
    stopPrice = this._roundSellStopPrice(stopPrice, rules.tickSize);
    const amount = this._sellQty(qty, rules);
    if (!(stopPrice > 0) || !(amount > 0)) throw new Error(`${symbol}: koruyucu stop parametreleri üretilemedi.`);
    const stop = await this.orderManager.submitStop({ symbol, side: 'sell', amount, stopPrice, limitPrice: 0, meta: { role, entryClientOrderId: position.entryOrderId } });
    return { stop, stopPrice };
  }

  async _syncTrailingStop(symbol, position, params, price) {
    if (position.nativeTrailing) return;
    if (!(Number(params.stopLossPct) > 0) || !(price > 0) || !position.stopOrderId) return;
    const tpPct = Number(params.takeProfitPct);
    const activation = Number.isFinite(tpPct) && tpPct > 0
      ? Number(position.entryPrice || 0) * (1 + tpPct / 100)
      : Infinity;
    const oldHigh = Number(position.highWaterMark || position.entryPrice || 0);
    const alreadyTrailing = Boolean(params.trailingStop) || oldHigh >= activation;
    if (!alreadyTrailing && price < activation) return;
    if (!(price > oldHigh)) return;
    position.highWaterMark = price;
    const rules = await this.getRules(symbol);
    const trailingStop = price * (1 - Number(params.stopLossPct) / 100);
    const breakEvenFloor = Number(position.entryPrice || 0) * (1 + 0.20 / 100);
    const naturalBreakEven = trailingStop >= breakEvenFloor;
    const tpBreakEven = Number.isFinite(activation) && (oldHigh >= activation || price >= activation);
    const floorActive = tpBreakEven || naturalBreakEven;
    const nextStop = this._roundSellStopPrice(floorActive ? Math.max(trailingStop, breakEvenFloor) : trailingStop, rules.tickSize);
    if (!(nextStop > Number(position.stopPrice || 0) + Math.max(Number(rules.tickSize || 0), 1e-12))) return;
    // Her yeni tepede iptal+yeniden kurma, stop'suz kisa pencereyi ve API/emir kaydi yukunu surekli tekrarlar.
    // Stop yalnizca en az %0.25 iyilesiyorsa tasinir (kâr korumanin ilk aktivasyonu bu esigi zaten asar).
    if (Number(position.stopPrice) > 0 && nextStop < Number(position.stopPrice) * (1 + MIN_STOP_STEP_PCT / 100)) return;
    const wasSafe = this.state.live.safeToTrade === true;
    const lockSnapshot = this._lockSnapshot();
    this.state.live.safeToTrade = false;
    const oldId = position.stopOrderId;

    // Spot borsalarda SELL stop emri coin miktarını kilitleyebilir. Bu nedenle
    // eski stop canlıyken aynı miktarda ikinci SELL stop göndermek çoğu borsada
    // -2010 / insufficient balance ile reddedilir. Güvenli spot sözleşmesi:
    // cancel -> doğrula -> replacement. Aradaki çıplak pencereyi mümkün olduğunca
    // kısa tutuyoruz; replacement başarısız olursa yeniden koruma, o da olmazsa
    // kontrollü market çıkışı deneniyor.
    const canceled = await this.orderManager.cancel(oldId);
    if (!canceled || String(canceled.status).toUpperCase() !== 'CANCELED' || Number(canceled.executedQty || 0) > 0) {
      this.state.live.safeToTrade = false;
      this.persist();
      throw new Error(`${symbol}: eski dinamik stop güvenli şekilde iptal edilemedi; canlı işlem kilitlendi.`);
    }
    position.stopOrderId = null;
    this.persist();

    let replacement = null;
    let replacementError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        replacement = await this.orderManager.submitStop({
          symbol, side: 'sell', amount: this._sellQty(position.quantity, rules),
          stopPrice: nextStop,
          limitPrice: 0,
          meta: { role: 'profit-protection-stop', entryClientOrderId: position.entryOrderId, trailing: true }
        });
        const st = String(replacement.status || '').toUpperCase();
        if (['NEW', 'PARTIALLY_FILLED', 'FILLED'].includes(st)) break;
        if (st === 'UNKNOWN' || replacement.uncertain === true) {
          replacementError = new Error('Yeni stop sonucu belirsiz; duplicate SELL riski nedeniyle yeniden gönderilmedi.');
          break;
        }
        replacementError = new Error(`Stop sonucu: ${replacement.status}`);
      } catch (err) { replacementError = err; }
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }

    const replacementStatus = String(replacement?.status || '').toUpperCase();
    if (!replacement || !['NEW', 'PARTIALLY_FILLED', 'FILLED'].includes(replacementStatus)) {
      // UNKNOWN sonuçta emir borsada oluşmuş olabilir; duplicate SELL/stop üretmek
      // yerine reconciliation'a bırakıyoruz. Kesin REJECTED/başarısız sonuçta ise
      // eski stop zaten iptal edildiği için kontrollü market çıkışı son savunmadır.
      if (replacementStatus === 'UNKNOWN' || replacement?.uncertain === true) {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = `${symbol}: yeni stop sonucu belirsiz; reconciliation gerekli`;
        this.state.live.stopReplacementError = { symbol, at: iso(this.nowFn()), error: replacementError?.message || 'unknown stop outcome' };
        this.state.live.criticalAlert = { type: 'PROTECTION_UNKNOWN', symbol, at: iso(this.nowFn()), message: 'Yeni koruyucu stop sonucu belirsiz; reconciliation gerekli.' };
        this.notify(`🚨 KRİTİK: ${symbol} yeni koruyucu stop sonucu BELİRSİZ. Duplicate emir göndermeden reconciliation gerekli.`, { key: `critical-protection-unknown:${symbol}`, minIntervalMs: 60000 });
        this.persist();
        throw new Error(`${symbol}: yeni dinamik stop sonucu belirsiz; duplicate emir riski nedeniyle canlı işlem kilitlendi.`);
      }
      // Son güvenlik katmanı: eski stop artık iptal edildi ve yenisi kurulamadı.
      // Açık pozisyonu bilinçli şekilde çıplak bırakmak yerine market çıkışı dene.
      this.state.live.safeToTrade = false;
      this.state.live.stopReplacementError = { symbol, at: iso(this.nowFn()), error: replacementError?.message || 'stop replacement başarısız' };
      this.persist();
      try {
        await this.sell(symbol, position, price, 'profit-protection-stop-replacement-failed', this.epoch, { emergency: true });
        return;
      } catch (exitErr) {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = `${symbol}: stop yenilenemedi ve acil market çıkışı da başarısız; reconciliation gerekli`;
        this.state.live.criticalAlert = {
          type: 'PROTECTION_FAILURE',
          symbol,
          at: iso(this.nowFn()),
          message: `Koruyucu stop yenilenemedi ve acil market çıkışı da başarısız: ${exitErr?.message || exitErr}`
        };
        this.notify(`🚨 KRİTİK KORUMA HATASI ${symbol}: stop yenilenemedi ve acil market çıkışı da başarısız. Manuel/reconciliation müdahalesi gerekli.`, { key: `critical-protection:${symbol}`, minIntervalMs: 60000 });
        this.persist();
        throw new Error(`${symbol}: dinamik stop kurulamadı ve acil çıkış başarısız: ${exitErr?.message || exitErr}`);
      }
    }

    position.stopOrderId = replacement.clientOrderId;
    position.stopPrice = nextStop;
    position.protectiveMode = 'single-stop';
    position.tpOrderId = null;
    position.tpPrice = null;
    // Bekleme sırasında başka bir kaynak (mutabakat, tanınmayan emir, kill switch) kilit koyduysa
    // eski "güvenli" değeri geri yazmak o kilidi sessizce açardı.
    this.state.live.safeToTrade = wasSafe && this._lockSnapshot() === lockSnapshot;
    if (replacementStatus === 'FILLED' || replacementStatus === 'PARTIALLY_FILLED') {
      await this._handleProtectiveStopUpdate(replacement);
      return;
    }
    this.persist();
  }

  _validateTriggerPrice(rules, side, triggerPrice, referencePrice) {
    const p = Number(triggerPrice), ref = Number(rules?.referencePrice || referencePrice || 0);
    const pr = rules?.priceRange || {};
    if (this.exchange.id !== 'binancetr') return { ok: true, errors: [] };
    if (!(ref > 0) || !pr || Object.keys(pr).length === 0) return { ok: false, errors: ['executionRules/referencePrice'] };
    const errors = [];
    const up = String(side).toLowerCase() === 'sell' ? Number(pr.askMultiplierUp || 0) : Number(pr.bidMultiplierUp || 0);
    const down = String(side).toLowerCase() === 'sell' ? Number(pr.askMultiplierDown || 0) : Number(pr.bidMultiplierDown || 0);
    if (up > 0 && p > ref * up) errors.push('priceRangeUp');
    if (down > 0 && p < ref * down) errors.push('priceRangeDown');
    return { ok: errors.length === 0, errors };
  }

  async _checkMarketOrderSafety({ symbol, side, baseQty, quoteQty = 0, emergency = false }) {
    const relaxed = emergency === true && String(side).toLowerCase() === 'sell';
    if (this.exchange.id === 'simulation') return;
    // Gerçek adapterler capability + fetchOrderBook uygular. Eski/yalın test doubles
    // order-book sözleşmesini uygulamıyorsa bu yardımcı yalnızca unit test dublörünü
    // engellememek için bypass edilir; gerçek borsa adapterleri bypass edemez.
    if (this.exchange.id !== 'simulation' && typeof this.exchange.fetchOrderBook !== 'function') {
      return;
    }
    let book;
    try { book = await this.exchange.fetchOrderBook(symbol, 50); }
    catch (err) { this.state.live.lastMarketSafety = { symbol, side, at: iso(this.nowFn()), ok: false, errors: ['order-book alınamadı'] }; this.persist(); throw new Error(`${symbol}: order-book alınamadı; bu MARKET girişi gönderilmedi: ${err.message}`); }
    const cfg = this.state.settings || {};
    let result;
    try {
      result = checkMarketOrderSafety({
        book, side, baseQty, quoteQty,
        marketBuyUsesQuote: this.exchange.marketBuyUsesQuote === true || this.exchange.capabilities?.marketBuyUsesQuote === true,
        maxSpreadPct: relaxed ? Math.max(Number(cfg.maxMarketSpreadPct ?? 0.75), EMERGENCY_MAX_SPREAD_PCT) : Number(cfg.maxMarketSpreadPct ?? 0.75),
        maxSlippagePct: relaxed ? Math.max(Number(cfg.maxMarketSlippagePct ?? 0.50), EMERGENCY_MAX_SLIPPAGE_PCT) : Number(cfg.maxMarketSlippagePct ?? 0.50),
        minDepthCoverage: relaxed ? Math.min(Number(cfg.minMarketDepthCoverage ?? 1.25), EMERGENCY_MIN_DEPTH_COVERAGE) : Number(cfg.minMarketDepthCoverage ?? 1.25)
      });
    } catch (err) {
      this.state.live.lastMarketSafety = { symbol, side, at: iso(this.nowFn()), ok: false, errors: [err.message] }; this.persist();
      throw new Error(`${symbol}: order-book MARKET güvenlik hesabı başarısız; emir gönderilmedi: ${err.message}`);
    }
    this.state.live.lastMarketSafety = { symbol, side, at: iso(this.nowFn()), spreadPct: result.spreadPct, impactPct: result.impactPct, depthCoverage: result.coverage, avgPrice: result.avgPrice, emergency: relaxed };
    if (!result.ok) {
      this.state.live.lastMarketSafety = { ...this.state.live.lastMarketSafety, ok: false, errors: result.errors };
      this.persist();
      throw new Error(`${symbol}: MARKET emir güvenlik kontrolü reddetti: ${result.errors.join('; ')}`);
    }
  }

  async buy(symbol, pairCfg, params, price, reason, epoch) {
    const riskErrors = this._validateRiskSettings();
    if (riskErrors.length) {
      this.state.live.safeToTrade = false;
      this.persist();
      throw new Error(`Canlı risk ayarları geçersiz: ${riskErrors.join(', ')}`);
    }
    const budgetPct = Number(pairCfg?.budgetPct);
    if (!Number.isFinite(budgetPct) || budgetPct <= 0 || budgetPct > 100) {
      this.state.live.safeToTrade = false;
      this.persist();
      throw new Error(`${symbol}: budgetPct geçersiz; canlı alış kilitlendi.`);
    }
    // Emir göndermeden hemen önce ikinci risk kapısı. İlk kapı tick başında
    // çalışır; fakat ağ/bakiye/stop hazırlığı sırasında kill-switch tetiklenmiş
    // olabilir. Bu kontrol yeni giriş emrinin yarış durumunda kaçmasını önler.
    if (this.state.killSwitch || this.state.live?.safeToTrade !== true) return;
    if (Object.keys(this.state.live.positions).length >= Number(this.state.settings.maxConcurrentPositions || 1)) return;
    const maxOpenOrders = Number(this.state.settings.maxOpenOrders || 12);
    const activeOrderCount = Object.values(this.state.liveOrders || {}).filter((o) => o && !TERMINAL.has(String(o.status || '').toUpperCase())).length;
    if (activeOrderCount >= maxOpenOrders) { this.state.live.safeToTrade = false; this.persist(); throw new Error(`${symbol}: maksimum açık emir sınırı (${maxOpenOrders}) aşıldı.`); }
    const quote = this.quoteAsset(symbol);
    const supportedQuotes = this.exchange.quoteAssets || [];
    const activeQuote = String(this.state.settings.quoteAsset || (supportedQuotes[0] || '')).toUpperCase();
    if (!quote || (supportedQuotes.length && (!supportedQuotes.includes(quote) || quote !== activeQuote))) {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: paritenin quote varlığı (${quote || 'bilinmiyor'}) bu borsada desteklenmiyor; canlı alış kilitlendi.`);
    }
    const balance = await this.exchange.fetchBalance();
    const available = Number(balance?.[quote]?.free || 0);
    const reserve = available * (Number(this.state.settings.reserveCashPct || 0) / 100);
    let spend = Math.max(0, available - reserve) * (Number(pairCfg.budgetPct) / 100);
    const positionCost = Object.values(this.state.live.positions || {}).reduce((sum,pos)=>{ const c=Number(pos?.costQuote ?? pos?.costUSDT ?? (Number(pos?.quantity)*Number(pos?.entryPrice))); return sum+(Number.isFinite(c)&&c>0?c:0); },0);
    const portfolioEquity = available + positionCost;
    const policyCheck = canOpenPosition({symbol,pair:pairCfg,positions:this.state.live.positions,pairs:this.state.pairs,policy:this.state.settings.portfolioPolicy,equity:portfolioEquity,requestedCost:spend});
    if (!policyCheck.ok) return;
    const maxTrade = Number(this.state.settings.maxTradeQuote || 0);
    if (maxTrade > 0) spend = Math.min(spend, maxTrade);
    const rules = await this.getRules(symbol);
    const minNotional = Number(rules.minNotional);
    const quantityOnlyRules = rules.minNotionalMode === 'quantity-only';
    if ((!Number.isFinite(minNotional) || minNotional <= 0) && !quantityOnlyRules) {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: borsa minimum emir kuralı alınamadı; canlı alış kilitlendi.`);
    }
    if (quantityOnlyRules && (!(Number(rules.minQty) > 0) || !(Number(rules.stepSize) > 0))) {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: miktar/adım kuralları eksik; canlı alış kilitlendi.`);
    }
    if (minNotional > 0 && rules.minNotionalAppliesToMarket !== false && !(spend >= minNotional)) return;
    const qtyStep = Number(rules.marketStepSize || rules.stepSize || 0);
    const minQty = Number(rules.marketMinQty || rules.minQty || 0);
    const maxQty = Number(rules.marketMaxQty || rules.maxQty || 0);
    const baseQty = roundDownToStep(spend / price, qtyStep);
    if (!(baseQty > 0) || (minQty && baseQty < minQty) || (maxQty && baseQty > maxQty) || (minNotional > 0 && rules.minNotionalAppliesToMarket !== false && baseQty * price < minNotional)) return;
    if (epoch !== this.epoch || this.state.killSwitch || this.state.live?.safeToTrade !== true) return;
    // BtcTurk market BUY quantity is quote-currency amount (TRY/USDT), while
    // the other adapters use base-asset quantity. The adapter declares this explicitly.
    const marketBuyUsesQuote = this.exchange.marketBuyUsesQuote === true || this.exchange.capabilities?.marketBuyUsesQuote === true;
    const orderAmount = marketBuyUsesQuote ? spend : baseQty;
    const validationQty = marketBuyUsesQuote ? baseQty : orderAmount;
    const ruleCheck = validateMarketOrder({ rules, side: 'buy', amount: validationQty, price });
    if (!ruleCheck.ok) {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: borsa emir kuralları sağlanmadı: ${ruleCheck.errors.join(', ')}`);
    }
    // Koruma on-kontrolu: market alis GONDERILMEDEN once koruyucu emrin kurulabilecegi dogrulanir.
    // Eskiden bu kontroller dolumdan SONRA yapiliyordu; basarisizlikta coin alinmis ama korumasiz
    // (ve yerel defterde kayitsiz) kalabiliyordu.
    if (rules.supportsProtectiveStop === false) {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: borsa bu paritede doğrulanmış koruyucu stop türünü desteklemiyor; alış gönderilmedi.`);
    }
    const preStopPct = Number(params.stopLossPct);
    if (!Number.isFinite(preStopPct) || preStopPct <= 0 || preStopPct >= 100) {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: koruyucu stop için geçerli stopLossPct gerekli; alış gönderilmedi.`);
    }
    if (Boolean(params.trailingStop) && this.exchange.id !== 'simulation' && this.exchange.capabilities?.nativeTrailingOco !== true) {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: borsada doğrulanmış native trailing yok; alış gönderilmedi.`);
    }
    const preStopPrice = this._roundSellStopPrice(price * (1 - preStopPct / 100), rules.tickSize);
    if (!(preStopPrice > 0)) {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: borsa fiyat adımına uygun koruyucu stop fiyatı üretilemiyor; alış gönderilmedi.`);
    }
    try {
      await this._checkMarketOrderSafety({ symbol, side: 'buy', baseQty, quoteQty: spend });
    } catch (err) {
      this.state.live.lastEntryRejection = { symbol, at: iso(this.nowFn()), reason: err?.message || String(err) };
      this.persist();
      this.log(`${symbol}: MARKET alış gönderilmedi: ${err?.message || String(err)}`, 'warn');
      return;
    }

    let order = await this.orderManager.submitMarket({ symbol, side: 'buy', amount: orderAmount, meta: { role: 'entry', reason } });
    if (order.status === 'UNKNOWN' || order.uncertain) {
      this.state.live.safeToTrade = false;
      this.persist();
      throw new Error(`${symbol}: alış emri sonucu belirsiz; canlı işlem kilitlendi.`);
    }
    if (order.status === 'PARTIALLY_FILLED') {
      const canceled = await this.orderManager.cancel(order.clientOrderId);
      if (!canceled || canceled.status !== 'CANCELED') {
        this.state.live.safeToTrade = false;
        this.persist();
        throw new Error(`${symbol}: kısmi alışın kalan miktarı iptal edilemedi; canlı işlem kilitlendi.`);
      }
      order = canceled;
      this.state.live.safeToTrade = false;
    }
    if (order.status !== 'FILLED' && order.status !== 'CANCELED') return;
    const filledQty = Number(order.netExecutedQty ?? order.executedQty ?? 0);
    if (!(filledQty > 0)) return;
    const thirdFeeQuote = this._orderFeeQuoteValue(order);
    if (thirdFeeQuote === null) {
      this.state.live.safeToTrade = false;
      this.state.live.feeValuationWarning = { symbol, clientOrderId: order.clientOrderId, side: 'buy', at: iso(this.nowFn()), commissionByAsset: { ...(order.commissionByAsset || {}) } };
      this.persist();
      throw new Error(`${symbol}: üçüncü varlık komisyonunun quote karşılığı hesaplanamadı; canlı işlem kilitlendi.`);
    }
    const quoteSpent = Number(order.netQuoteQty ?? order.quoteQty ?? filledQty * price) + thirdFeeQuote;
    const avgPrice = quoteSpent > 0 ? quoteSpent / filledQty : price;
    const stopPct = Number(params.stopLossPct);
    const rawStopPrice = avgPrice * (1 - stopPct / 100);
    const stopPrice = this._roundSellStopPrice(rawStopPrice, rules.tickSize);

    // Kritik: market alış FILLED olduktan sonra HICBIR dogrulama basarisizligi gercek pozisyonu
    // yerel defterden dusurmemeli. Once pozisyon kaydedilir, sonra koruma kurulur/dogrulanir.
    const [baseAssetName, quoteAssetName] = String(symbol).toUpperCase().split('/');
    this.state.live.positions[symbol] = {
      symbol, baseAsset: baseAssetName, quoteAsset: quoteAssetName,
      quantity: filledQty, entryPrice: avgPrice, costQuote: quoteSpent,
      entryCommissionTotal: Number(order.commissionTotal || 0),
      entryCommissionByAsset: { ...(order.commissionByAsset || {}) },
      entryThirdAssetCommissionQuote: thirdFeeQuote,
      entryThirdAssetCommissionValuation: order.thirdAssetCommissionValuation || {},
      openedAt: iso(this.nowFn()), entryOrderId: order.clientOrderId,
      stopOrderId: null, stopPrice: stopPrice > 0 ? stopPrice : null, tpOrderId: null, tpPrice: null, protectiveMode: 'single-stop', nativeTrailing: false, orderListId: null, takeProfitPct: Number(params.takeProfitPct || 0), trailingStop: Boolean(params.trailingStop), highWaterMark: avgPrice,
      reason,
      stopExecutedQty: 0, stopCommissionBase: 0, stopNetQuoteQty: 0,
      stopThirdAssetCommissionQuote: 0, stopExecutionIds: []
    };
    this.persist();

    const stopRuleCheck = this._validateTriggerPrice(rules, 'sell', stopPrice, price);
    if (!stopRuleCheck.ok) { this.state.live.safeToTrade = false; this.persist(); throw new Error(`${symbol}: stop fiyatı Binance TR execution rule dışında veya doğrulanamadı: ${stopRuleCheck.errors.join(', ')}`); }
    if (!(stopPrice > 0)) {
      this.state.live.safeToTrade = false;
      this.persist();
      throw new Error(`${symbol}: borsa fiyat adımına uygun koruyucu stop fiyatı üretilemedi; POZİSYON KORUMASIZ.`);
    }
    // Koruyucu emir miktari adima ASAGI yuvarlanir (baz komisyonu dusulmus net miktar adim katı degildir).
    const protectQty = this._sellQty(filledQty, rules);
    if (!(protectQty > 0)) {
      this.state.live.safeToTrade = false;
      this.persist();
      throw new Error(`${symbol}: dolum miktarı borsa adımının altında; koruyucu stop kurulamadı, POZİSYON KORUMASIZ.`);
    }

    const hasTrailing = Boolean(params.trailingStop);
    let stop;
    try {
      // TP artık ayrı bir satış emri değildir. takeProfitPct yalnızca dinamik
      // kâr korumanın aktive olacağı eşiği belirtir; ilk koruma stop-loss
      // olarak giriş fiyatından kurulur ve fiyat yükseldikçe yukarı taşınır.
      const trailingDelta = hasTrailing ? Math.round(Number(params.stopLossPct) * 100) : 0;
      stop = await this.orderManager.submitStop({ symbol, side: 'sell', amount: protectQty, stopPrice, limitPrice: 0, trailingDelta, meta: { role: 'protective-stop', entryClientOrderId: order.clientOrderId, trailing: trailingDelta > 0 } });
    } catch (err) {
      this.state.live.safeToTrade = false; this.persist(); throw err;
    }
    if (stop.status === 'UNKNOWN' || stop.uncertain || stop.status === 'REJECTED' || !['NEW','FILLED'].includes(stop.status)) {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: koruyucu stop kurulamadı (${stop.status}); canlı işlem kilitlendi, POZİSYON KORUMASIZ olabilir.`);
    }
    const trailingNative = hasTrailing && Math.round(Number(params.stopLossPct) * 100) > 0;
    this.state.live.positions[symbol].stopOrderId = stop.clientOrderId;
    this.state.live.positions[symbol].stopPrice = stopPrice;
    this.state.live.positions[symbol].protectiveMode = 'single-stop';
    this.state.live.positions[symbol].nativeTrailing = trailingNative;
    this.persist();

    // WebSocket FILLED bildirimi stopOrderId atamasindan once gelmis olabilir.
    // OrderManager bu bildirimi kaydeder; son durumu tekrar okuyarak kacirilan
    // fill'i burada isleriz.
    const protectiveId = this.state.live.positions[symbol]?.stopOrderId;
    const latestStop = protectiveId ? (this.orderManager.get(protectiveId) || { clientOrderId: protectiveId, status: 'NEW' }) : null;
    if (String(latestStop.status).toUpperCase() === 'FILLED') {
      await this._handleProtectiveStopUpdate(latestStop);
      return;
    }
    this.log(`CANLI ALIM ${symbol} @ ${avgPrice} miktar ${filledQty} — ${reason}`);
    this.notify(withIstanbulTime(`🟢 CANLI ALIM ${symbol} @ ${avgPrice}`, this.nowFn()), { key: `live-buy:${symbol}`, minIntervalMs: 10000 });
    this.persist();
  }

  async sell(symbol, position, price, reason, epoch, { emergency = false } = {}) {
    if (epoch !== this.epoch) return;

    // 1) ON KONTROLLER (koruyucu stop'a DOKUNMADAN): kurallar + order-book guvenligi.
    //    Eskiden stop once iptal ediliyor, kontrol sonradan basarisiz olunca pozisyon korumasiz kaliyordu.
    const sellRules = await this.getRules(symbol);
    const sellQty = this._sellQty(position.quantity, sellRules, { market: true });
    if (!(sellQty > 0)) {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: pozisyon miktarı borsa adımının altında; market satışı yapılamaz.`);
    }
    const sellCheck = validateMarketOrder({ rules: sellRules, side: 'sell', amount: sellQty, price });
    if (!sellCheck.ok) {
      this.state.live.safeToTrade = false; this.persist();
      throw new Error(`${symbol}: satış borsa kuralları sağlanmadı: ${sellCheck.errors.join(', ')}`);
    }
    await this._checkMarketOrderSafety({ symbol, side: 'sell', baseQty: sellQty, emergency });

    // 2) Ancak simdi koruyucu stop iptal edilir (hemen ardindan market satis gonderilecek).
    if (position.stopOrderId) {
      const canceled = await this.orderManager.cancel(position.stopOrderId);
      if (!canceled || canceled.status !== 'CANCELED') {
        this.state.live.safeToTrade = false;
        this.persist();
        throw new Error(`${symbol}: koruyucu stop iptal edilemedi; market satışına izin verilmedi.`);
      }
      // Stop iptal edilirken kısmen dolmuş olabilir. Bu durumda yerel
      // pozisyon miktarı artık borsadaki gerçek miktarı temsil etmiyor.
      // Kalan pozisyonu tahmin ederek market satışına devam etmek oversell
      // riski doğurur. Önce mutabakat/recovery yapılmalı.
      const canceledExecutedQty = Number(canceled.executedQty || 0);
      if (Number.isFinite(canceledExecutedQty) && canceledExecutedQty > 0) {
        this.state.live.safeToTrade = false;
        this.state.live.stopCancelPartialFill = {
          symbol,
          clientOrderId: position.stopOrderId,
          executedQty: canceledExecutedQty,
          at: iso(this.nowFn())
        };
        this.persist();
        throw new Error(`${symbol}: koruyucu stop iptal edilirken kısmen dolmuş; mutabakat yapılmadan market satışına izin verilmedi.`);
      }
      // OCO'da bir bacagin iptali tum listeyi iptal eder; diger bacagin yerel kaydi da guncellenir.
      if (position.protectiveMode === 'oco' && position.tpOrderId && typeof this.orderManager.reconcile === 'function') {
        try { await this.orderManager.reconcile(position.tpOrderId); } catch (_) { /* reconcile sonraki turda tekrar dener */ }
      }
    }

    let order = await this.orderManager.submitMarket({
      symbol, side: 'sell', amount: sellQty,
      meta: { role: 'exit', reason, entryOrderId: position.entryOrderId }
    });
    if (order.status === 'UNKNOWN' || order.uncertain) {
      this.state.live.safeToTrade = false;
      this.persist();
      throw new Error(`${symbol}: çıkış emri sonucu belirsiz; canlı işlem kilitlendi.`);
    }

    if (order.status === 'PARTIALLY_FILLED') {
      const canceled = await this.orderManager.cancel(order.clientOrderId);
      if (!canceled || canceled.status !== 'CANCELED') {
        this.state.live.safeToTrade = false;
        this.persist();
        throw new Error(`${symbol}: kısmi satışın kalan miktarı iptal edilemedi; canlı işlem kilitlendi.`);
      }
      order = canceled;
      this.state.live.safeToTrade = false;
    }

    const grossFilled = Number(order.executedQty || 0);
    const baseFee = Number(order.commissionBase || 0);
    const positionOutflow = positionReductionOnSell(grossFilled, baseFee);
    const soldQty = Math.min(position.quantity, grossFilled);
    const outflowQty = Math.min(position.quantity, positionOutflow);

    // Market satis HIC dolmadiysa (reddedildi/iptal/expire): stop zaten iptal edilmisti, pozisyon
    // korumasiz kalmasin diye koruyucu stop yeniden kurulur. Belirsiz (UNKNOWN) sonuc yukarida kilitlendi.
    if (!(soldQty > 0)) {
      this.state.live.safeToTrade = false;
      this.persist();
      let rearmNote = '';
      if (position.stopOrderId || position.tpOrderId) {
        try {
          const { stop, stopPrice } = await this._placeProtectiveStop(symbol, position, position.quantity, sellRules);
          if (stop.status === 'NEW' || stop.status === 'FILLED') {
            position.stopOrderId = stop.clientOrderId;
            position.stopPrice = stopPrice;
            position.tpOrderId = null; position.tpPrice = null; position.orderListId = null;
            position.protectiveMode = 'single-stop'; position.nativeTrailing = false;
            rearmNote = ' Koruyucu stop yeniden kuruldu.';
          } else {
            rearmNote = ` Koruyucu stop yeniden KURULAMADI (${stop.status}); POZİSYON KORUMASIZ.`;
          }
        } catch (err) {
          rearmNote = ` Koruyucu stop yeniden KURULAMADI (${err.message}); POZİSYON KORUMASIZ.`;
        }
        this.persist();
      }
      throw new Error(`${symbol}: satış emri dolmadı (${order.status}).${rearmNote}`);
    }

    const thirdFeeQuote = this._orderFeeQuoteValue(order);
    if (thirdFeeQuote === null) {
      this.state.live.safeToTrade = false;
      this.state.live.feeValuationWarning = { symbol, clientOrderId: order.clientOrderId, side: 'sell', at: iso(this.nowFn()), commissionByAsset: { ...(order.commissionByAsset || {}) } };
      this.persist();
      throw new Error(`${symbol}: satış için üçüncü varlık komisyonunun quote karşılığı hesaplanamadı; canlı işlem kilitlendi.`);
    }
    const proceeds = Math.max(0, Number(order.netQuoteQty ?? order.quoteQty ?? soldQty * price) - thirdFeeQuote);

    // Adim yuvarlamasindan kalan artik (< 1 adim) satilamaz: pozisyon kapanmis sayilir, artik
    // "dust" defterine yazilir (mutabakat bunu bekler) ve maliyetinin tamami gerceklesen zarara girer.
    const rawStep = Number(sellRules.marketStepSize || sellRules.stepSize || 0);
    const leftover = Math.max(0, position.quantity - outflowQty);
    const dustOnly = String(order.status).toUpperCase() === 'FILLED' && leftover > 1e-12 && rawStep > 0 && leftover < rawStep - 1e-12;
    const pnlResult = realizedPnl(position, dustOnly ? position.quantity : outflowQty, proceeds);
    const fullClose = dustOnly || outflowQty + 1e-12 >= position.quantity;
    const remaining = dustOnly ? 0 : Math.max(0, position.quantity - outflowQty);
    if (dustOnly) this._addDust(symbol, leftover);

    this._recordLiveTrade(symbol, position, order, soldQty, pnlResult, reason);

    if (!fullClose || String(order.status).toUpperCase() !== 'FILLED') {
      this.state.live.positions[symbol].quantity = remaining;
      // Cost basis, kalan coin ile orantılı azaltılır; böylece sonraki satışın
      // gerçekleşen P/L hesabı çift sayım yapmaz.
      this.state.live.positions[symbol].costQuote = Math.max(0, Number(position.costQuote || 0) - pnlResult.costBasis);
      this.state.live.positions[symbol].stopOrderId = null;
      this.state.live.safeToTrade = false;

      if (remaining > 0) {
        try {
          const { stop, stopPrice } = await this._placeProtectiveStop(symbol, this.state.live.positions[symbol], remaining, sellRules);
          if (stop.status === 'NEW' || stop.status === 'FILLED') {
            this.state.live.positions[symbol].stopOrderId = stop.clientOrderId;
            this.state.live.positions[symbol].stopPrice = stopPrice;
          } else {
            this.log(`${symbol}: kısmi satış sonrası kalan pozisyon için koruyucu stop kurulamadı (${stop.status}).`, 'error');
          }
        } catch (err) {
          this.log(`${symbol}: kısmi satış sonrası koruyucu stop kurulamadı: ${err.message}`, 'error');
        }
      }
      this.persist();
      return;
    }

    delete this.state.live.positions[symbol];
    this.log(`CANLI SATIM ${symbol} @ ${price} — ${reason} — gerçekleşen K/Z: ${pnlResult.pnl.toFixed(4)}`, pnlResult.pnl >= 0 ? 'info' : 'warn');
    this.notify(withIstanbulTime(`${pnlResult.pnl >= 0 ? '🟢' : '🔴'} CANLI SATIM ${symbol} — K/Z ${pnlResult.pnl.toFixed(2)}`, this.nowFn()), { key: `live-sell:${symbol}`, minIntervalMs: 10000 });
    this.persist();
  }

  _recordLiveTrade(symbol, position, order, soldQty, pnlResult, reason) {
    this.ensureState();
    const live = this.state.live;
    const pnl = Number(pnlResult.pnl || 0);
    const quote = String(position?.quoteAsset || String(symbol).toUpperCase().split('/')[1] || '').toUpperCase();
    live.realizedPnl += pnl;
    live.dayRealizedPnl += pnl;
    if (quote) live.dayRealizedPnlByQuote[quote] = Number(live.dayRealizedPnlByQuote[quote] || 0) + pnl;
    live.stats.trades += 1;
    live.stats.realizedPnl += pnl;
    if (pnl > 0) {
      live.stats.wins += 1;
      live.stats.grossWin += pnl;
    } else {
      live.stats.grossLoss += -pnl;
    }
    live.trades.unshift({
      symbol,
      entryPrice: Number(position.entryPrice || 0),
      exitPrice: soldQty > 0 ? Number(pnlResult.proceeds / soldQty) : 0,
      quantity: soldQty,
      proceedsQuote: Number(pnlResult.proceeds || 0),
      costBasisQuote: Number(pnlResult.costBasis || 0),
      pnl,
      pnlPct: Number(pnlResult.costBasis) > 0 ? pnl / Number(pnlResult.costBasis) * 100 : null,
      commissionTotal: Number(order.commissionTotal || 0),
      commissionByAsset: { ...(order.commissionByAsset || {}) },
      thirdAssetCommissionQuote: Number(order.thirdAssetCommissionQuote || 0),
      thirdAssetCommissionValuation: order.thirdAssetCommissionValuation || {},
      reason,
      openedAt: position.openedAt,
      closedAt: iso(this.nowFn()),
      orderId: order.exchangeOrderId || null,
      clientOrderId: order.clientOrderId || null
    });
    live.trades = live.trades.slice(0, 300);
  }

  getRiskDayKey(ms = this.nowFn()) {
    const tz = this.state.settings.riskDayTimezone || 'Europe/Istanbul';
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
    catch { return new Date(ms).toISOString().slice(0, 10); }
  }

  async _checkRiskGate() {
    this.ensureState();
    const live = this.state.live;
    const riskErrors = this._validateRiskSettings();
    if (riskErrors.length) {
      this.state.live.safeToTrade = false;
      this.state.killSwitch = { t: iso(this.nowFn()), reason: `geçersiz canlı risk ayarı: ${riskErrors.join(', ')}` };
      this.persist();
      await this.stop('Geçersiz canlı risk ayarı.');
      return;
    }
    const equities = this.computeEquityByQuote();
    const primaryQuote = String(this.state.settings.quoteAsset || (this.exchange.quoteAssets || ['USDT'])[0]).toUpperCase();
    if (!(Number(live.startingEquityByQuote[primaryQuote]) > 0) && Number(live.startingEquity) > 0) live.startingEquityByQuote[primaryQuote] = Number(live.startingEquity);
    if (!(Number(live.dayStartEquityByQuote[primaryQuote]) > 0) && Number(live.dayStartEquity) > 0) live.dayStartEquityByQuote[primaryQuote] = Number(live.dayStartEquity);
    if (!(Number(live.dayRealizedPnlByQuote[primaryQuote]) || 0) && Number(live.dayRealizedPnl)) live.dayRealizedPnlByQuote[primaryQuote] = Number(live.dayRealizedPnl);
    const validQuotes = Object.entries(equities).filter(([, v]) => Number.isFinite(v) && v > 0);
    if (!validQuotes.length) return;
    const today = this.getRiskDayKey();
    if (live.dayKey !== today) {
      live.dayKey = today;
      live.dayStartEquityByQuote = { ...equities };
      live.dayRealizedPnlByQuote = {};
      // Legacy scalar fields remain for old UI/API consumers and use the primary quote only.
      live.dayStartEquity = Number(equities[primaryQuote] || 0);
      live.dayRealizedPnl = 0;
    }
    for (const [quote, equity] of validQuotes) {
      if (!(Number(live.startingEquityByQuote[quote]) > 0)) live.startingEquityByQuote[quote] = equity;
      if (!(Number(live.dayStartEquityByQuote[quote]) > 0)) live.dayStartEquityByQuote[quote] = equity;
    }
    live.startingEquity = Number(live.startingEquityByQuote[primaryQuote] || live.startingEquity || equities[primaryQuote] || 0);
    const totalLimit = Number(this.state.settings.killSwitchLossPct || 0);
    const dayLimit = Number(this.state.settings.dailyLossLimitPct || 0);
    let reason = null;
    for (const [quote, equity] of validQuotes) {
      const start = Number(live.startingEquityByQuote[quote] || equity);
      const dayStart = Number(live.dayStartEquityByQuote[quote] || equity);
      const totalLossPct = start > 0 ? ((equity / start) - 1) * 100 : 0;
      const dayLossPct = dayStart > 0 ? ((equity / dayStart) - 1) * 100 : 0;
      const dayRealizedPct = dayStart > 0 ? (Number(live.dayRealizedPnlByQuote[quote] || 0) / dayStart) * 100 : 0;
      if (totalLimit > 0 && totalLossPct <= -totalLimit) { reason = `canlı ${quote} toplam zarar %${Math.abs(totalLossPct).toFixed(2)} (limit %${totalLimit})`; break; }
      if (dayLimit > 0 && (dayLossPct <= -dayLimit || dayRealizedPct <= -dayLimit)) { reason = `canlı ${quote} günlük zarar limiti aşıldı`; break; }
    }
    if (!reason) return;

    this.state.live.safeToTrade = false;
    this.state.killSwitch = { t: iso(this.nowFn()), reason };
    this.log(`KILL SWITCH: ${reason}.`, 'error');
    { // Always attempt emergency closes before stopping; leaving positions open would remove bot-side protection.
      for (const [symbol, position] of Object.entries({ ...live.positions })) {
        try { await this.sell(symbol, position, live.lastPrices[symbol] || position.entryPrice, `Risk limiti: ${reason}`, this.epoch, { emergency: true }); }
        catch (err) { this.log(`${symbol}: risk nedeniyle kapatma başarısız: ${err.message}`, 'error'); }
      }
    }
    await this.stop(`Risk limiti: ${reason}`);
  }

  computeEquityByQuote() {
    const balances = this.state.live.lastBalance || {};
    const out = {};
    const quoteList = (this.exchange.quoteAssets || []).map((x) => String(x).toUpperCase());
    for (const quote of quoteList) {
      const cash = Number(balances?.[quote]?.total || 0);
      if (!Number.isFinite(cash) || cash < 0) return {};
      out[quote] = cash;
    }
    const baseQuotes = {};
    for (const symbol of Object.keys(this.state.pairs || {})) {
      const [base, quote] = String(symbol).toUpperCase().split('/');
      if (base && quote) (baseQuotes[base] ||= new Set()).add(quote);
    }
    for (const [asset, quoteSet] of Object.entries(baseQuotes)) {
      // If a base asset is traded against exactly one quote, the exchange's
      // actual balance can be valued safely in that quote. If it is traded
      // against multiple quotes, allocation is ambiguous; use local position
      // quantities instead and let reconciliation lock trading on mismatches.
      if (quoteSet.size === 1) {
        const quote = [...quoteSet][0];
        const total = Number(balances?.[asset]?.total || 0);
        const price = Number(this.state.live.lastPrices?.[`${asset}/${quote}`] || 0);
        if (total > 0 && price > 0) out[quote] = (out[quote] || 0) + total * price;
      }
    }
    for (const [symbol, position] of Object.entries(this.state.live?.positions || {})) {
      const quote = String(position?.quoteAsset || String(symbol).toUpperCase().split('/')[1] || '').toUpperCase();
      const base = String(position?.baseAsset || String(symbol).toUpperCase().split('/')[0] || '').toUpperCase();
      const qset = baseQuotes[base];
      if (qset && qset.size === 1) continue; // already valued from actual balance
      const qty = Number(position?.quantity || 0);
      const price = Number(this.state.live.lastPrices?.[symbol] || position?.entryPrice || 0);
      if (!quote || !(qty >= 0) || !(price > 0)) continue;
      out[quote] = (out[quote] || 0) + qty * price;
    }
    return out;
  }

  computeEquity(requestedQuote = null) {
    const q = String(requestedQuote || (this.exchange.quoteAssets || ['USDT'])[0]).toUpperCase();
    const byQuote = this.computeEquityByQuote();
    return Number.isFinite(Number(byQuote[q])) ? Number(byQuote[q]) : NaN;
  }
}

module.exports = LiveEngine;
