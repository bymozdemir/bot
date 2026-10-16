// src/orderManager.js
//
// Canli emirlerin guvenli yasam dongusu. Bu katman henuz PaperEngine'i
// degistirmez ve kendi basina canli modu acmaz.
//
// Temel kural:
//   1) Emir daha gonderilmeden once kalici state'e PENDING olarak yazilir.
//   2) Borsaya clientOrderId ile gonderilir.
//   3) Ag/5xx nedeniyle sonuc belirsizse KESINLIKLE tekrar gonderilmez.
//   4) Yeniden baslatmada ayni clientOrderId ile emir sorgulanir.
//   5) FILLED/PARTIALLY_FILLED gibi durumlar borsanin gercek sonucundan okunur.
//
// clientOrderId desteklemeyen adaptorlerde canli market emirleri kasitli olarak
// reddedilir. Boylece idempotency mekanizmasi olmayan bir borsaya yanlislikla
// gercek para emri gonderilmez.

const crypto = require('crypto');
const { aggregateCommissions, addExecutionCommission, commissionTotalForSingleAsset, netBaseReceived, netQuoteFlow, nonPairCommissionAssets } = require('./financial');

const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
const KNOWN = new Set(['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
const STATUS_RANK = {
  NEW: 10,
  PARTIALLY_FILLED: 20,
  CANCELED: 30,
  EXPIRED: 30,
  REJECTED: 30,
  FILLED: 40
};

function mergeExecutionStatus(previous, incoming, previousExecutedQty, incomingExecutedQty) {
  const prev = normalizeStatus({ status: previous });
  const next = normalizeStatus({ status: incoming });
  if (prev === 'FILLED' && next !== 'FILLED') return prev;
  if (next === 'FILLED') return next;
  if ((prev === 'CANCELED' || prev === 'EXPIRED' || prev === 'REJECTED') && next === 'PARTIALLY_FILLED') {
    return prev;
  }
  if ((prev === 'CANCELED' || prev === 'EXPIRED') && next === 'NEW') return prev;
  if (Number(incomingExecutedQty) > Number(previousExecutedQty)) return next;
  const pr = STATUS_RANK[prev] || 0;
  const nr = STATUS_RANK[next] || 0;
  return nr >= pr ? next : prev;
}

function makeClientOrderId(prefix = 'bot') {
  const safe = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'bot';
  // Binance clientOrderId icin kisa, URL-safe bir kimlik yeterlidir.
  return `${safe}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`.slice(0, 36);
}

function normalizeStatus(raw) {
  const status = String(raw?.status || '').toUpperCase();
  return KNOWN.has(status) ? status : 'UNKNOWN';
}


function canonicalSymbol(rawSymbol, fallbackSymbol = '') {
  const raw = String(rawSymbol || '').toUpperCase();
  const fallback = String(fallbackSymbol || '').toUpperCase();
  // Borsa bazen BTCUSDT, yerel state ise BTC/USDT kullanır. Yerel emir
  // kaydı slash'lıysa onu kanonik anahtar olarak koru; aksi halde raw sembolü kullan.
  if (fallback.includes('/')) return fallback;
  if (raw.includes('/')) return raw;
  return raw;
}

function splitSymbol(symbol) {
  const raw = String(symbol || '').toUpperCase();
  // Kanonik BAZ/KASA biçimi varsa doğrudan oradan ayır. Eskiden önce "/" atılıp sabit bir kasa listesiyle
  // sondan eşleştiriliyordu: USD, GBP gibi listede olmayan kasa birimlerinde (Kraken, Bitstamp, Coinbase, OKX)
  // base/quote null çıkıyor, baz-varlık komisyonu düşülmüyor ve pozisyon miktarı komisyon kadar fazla kaydediliyordu.
  if (raw.includes('/')) {
    const parts = raw.split('/');
    return parts.length === 2 && parts[0] && parts[1] ? { base: parts[0], quote: parts[1] } : { base: null, quote: null };
  }
  const knownQuotes = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TRY', 'EUR', 'USD', 'GBP', 'BTC', 'ETH'];
  const quote = knownQuotes.find((q) => raw.endsWith(q) && raw.length > q.length);
  return quote ? { base: raw.slice(0, -quote.length), quote } : { base: null, quote: null };
}

function normalizeOrder(raw, fallback = {}) {
  const symbol = canonicalSymbol(raw?.symbol, fallback.symbol);
  const { base: baseAsset, quote: quoteAsset } = splitSymbol(symbol);
  const grossExecutedQty = Number(raw?.executedQty ?? fallback.executedQty ?? 0);
  const grossQuoteQty = Number(raw?.cummulativeQuoteQty ?? fallback.quoteQty ?? 0);
  const commission = aggregateCommissions(raw?.fills || [], fallback.commission || {});
  const side = String(raw?.side || fallback.side || '').toLowerCase();
  const netExecutedQty = netBaseReceived(side, grossExecutedQty, baseAsset, commission);
  const netQuoteQty = netQuoteFlow(side, grossQuoteQty, quoteAsset, commission);
  return {
    exchangeOrderId: raw?.orderId ?? fallback.exchangeOrderId ?? null,
    clientOrderId: raw?.clientOrderId || fallback.clientOrderId,
    symbol,
    side,
    status: normalizeStatus(raw),
    executedQty: grossExecutedQty,
    netExecutedQty,
    origQty: Number(raw?.origQty ?? fallback.origQty ?? fallback.amount ?? 0),
    quoteQty: grossQuoteQty,
    netQuoteQty,
    commissionTotal: commission.total,
    commissionByAsset: commission.byAsset,
    commissionBase: baseAsset ? (commission.byAsset[baseAsset] || 0) : 0,
    commissionQuote: quoteAsset ? (commission.byAsset[quoteAsset] || 0) : 0,
    commissionAsset: Object.keys(commission.byAsset).length === 1 ? Object.keys(commission.byAsset)[0] : null,
    raw: raw || null
  };
}

class OrderManager {
  constructor({ exchange, state, store, nowFn, onOrderUpdate } = {}) {
    if (!exchange) throw new Error('OrderManager için exchange gerekli.');
    if (!state) throw new Error('OrderManager için state gerekli.');
    if (!store || typeof store.save !== 'function') throw new Error('OrderManager için store.save gerekli.');
    this.exchange = exchange;
    this.state = state;
    this.store = store;
    this.nowFn = nowFn || (() => Date.now());
    this.onOrderUpdate = typeof onOrderUpdate === 'function' ? onOrderUpdate : null;
    if (!this.state.liveOrders || typeof this.state.liveOrders !== 'object') this.state.liveOrders = {};
  }

  assertLiveCapability() {
    const caps = this.exchange.capabilities || {};
    // Derinlemesine savunma: kanıtı tamamlanmamış adaptörler (liveTradingVerified !== true) canlı emir gönderemez.
    if (caps.liveTradingVerified !== true) {
      throw new Error(`${this.exchange.name || this.exchange.id || 'Borsa'}: liveTradingVerified=false veya eksik; sandbox/gerçek hesap kanıtı tamamlanmadan canlı emir gönderilemez.`);
    }
    if (!caps.clientOrderId || caps.recoveryByFingerprint === true || typeof this.exchange.createMarketOrder !== 'function' || typeof this.exchange.getOrder !== 'function') {
      throw new Error(`${this.exchange.name || this.exchange.id || 'Borsa'}: güvenli canlı emir için doğrulanmış clientOrderId + deterministik emir sorgulama gerekli; tahmini fingerprint kurtarma kabul edilmiyor.`);
    }
  }

  save() {
    this.store.save(this.state);
  }
  async _enrichThirdAssetFee(order) {
    const { base: baseAsset, quote: quoteAsset } = splitSymbol(order.symbol);
    const third = nonPairCommissionAssets({ byAsset: order.commissionByAsset || order.commission?.byAsset || {} }, baseAsset, quoteAsset);
    if (!third.length) {
      return { ...order, thirdAssetCommissionQuote: 0, thirdAssetCommissionValuationComplete: true, thirdAssetCommissionValuation: {} };
    }

    const valuation = {};
    for (const item of third) {
      let direct = null;
      let inverse = null;
      try {
        const t = await this.exchange.fetchTicker(`${item.asset}/${quoteAsset}`);
        direct = Number(t?.price);
      } catch (_) {}
      if (!(direct > 0)) {
        try {
          const t = await this.exchange.fetchTicker(`${quoteAsset}/${item.asset}`);
          inverse = Number(t?.price);
        } catch (_) {}
      }
      const value = direct > 0 ? item.amount * direct : (inverse > 0 ? item.amount / inverse : null);
      valuation[item.asset] = { amount: item.amount, direct: direct > 0 ? direct : null, inverse: inverse > 0 ? inverse : null, quoteValue: value };
    }
    const complete = third.every((x) => valuation[x.asset]?.quoteValue !== null && Number.isFinite(Number(valuation[x.asset]?.quoteValue)) && Number(valuation[x.asset]?.quoteValue) >= 0);
    const quoteValue = complete ? third.reduce((sum, x) => sum + Number(valuation[x.asset].quoteValue), 0) : null;
    return {
      ...order,
      thirdAssetCommissionQuote: quoteValue,
      thirdAssetCommissionValuationComplete: complete,
      thirdAssetCommissionValuation: valuation,
      thirdAssetCommissionValuationAt: new Date(this.nowFn()).toISOString()
    };
  }


  // tolerateSaveError: emir borsaya GİTTİKTEN sonraki kayıtlarda true. Bellekteki kayıt zaten güncel; diske yazım
  // başarısız olursa (depolama dolu, dosya kilidi) hata fırlatmak emri "gönderilmedi" gibi gösterirdi. Gönderim
  // ÖNCESİ kayıt (PENDING) tolerans tanımaz: yazılamıyorsa emir hiç gönderilmez.
  _record(clientOrderId, patch, { tolerateSaveError = false } = {}) {
    if (typeof clientOrderId !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(clientOrderId)) throw new Error('Geçersiz clientOrderId.');
    const old = this.get(clientOrderId) || { clientOrderId };
    this.state.liveOrders[clientOrderId] = { ...old, ...patch, updatedAt: new Date(this.nowFn()).toISOString() };
    try {
      this.save();
    } catch (e) {
      if (!tolerateSaveError) throw e;
      this.lastSaveError = { message: e?.message || String(e), at: new Date(this.nowFn()).toISOString(), clientOrderId };
      // Borsa yanıtından sonra kalıcı kayıt başarısızsa başarılı/terminal durum bildirmek
      // restart sonrasında çift emir veya kayıp pozisyon yaratabilir. Bellekte UNKNOWN'a
      // düşür ve bir kez daha kalıcılaştırmayı dene; kalıcı hata varsa kapı yine kilitli kalır.
      const uncertain = this.state.liveOrders[clientOrderId];
      const observedStatus = uncertain?.status;
      if (uncertain && typeof uncertain === 'object') {
        uncertain.status = 'UNKNOWN';
        uncertain.uncertain = true;
        uncertain.requiresReconciliation = true;
        uncertain.persistenceError = this.lastSaveError;
      }
      if (this.state.live && typeof this.state.live === 'object') {
        this.state.live.safeToTrade = false;
        this.state.live.lockReason = 'Emir kaydı diske kalıcı yazılamadı; borsa ile mutabakat gerekli.';
      }
      try {
        this.save();
      } catch (retryError) {
        this.lastSaveError = { message: retryError?.message || String(retryError), at: new Date(this.nowFn()).toISOString(), clientOrderId };
        // Kalıcı disk arızasında bellekte borsadan kesin gözlenen durumu koru
        // (ör. FILLED/CANCELED); güvenlik kapısı yine kapalıdır. Disk yazımı
        // yeniden başarılı olduysa UNKNOWN zaten kalıcılaştırılmıştır.
        if (uncertain && typeof uncertain === 'object') uncertain.status = observedStatus;
      }
    }
    if (this.onOrderUpdate) {
      try { this.onOrderUpdate(this.state.liveOrders[clientOrderId]); } catch (_) {}
    }
    return this.state.liveOrders[clientOrderId];
  }

  get(clientOrderId) {
    // 'liveOrders' duz nesne: '__proto__'/'constructor' gibi bir clientOrderId (Binance bu karakterlere izin verir; hesap
    // sahibinin elle verdigi emirde olabilir) Object.prototype'i "mevcut emir" diye dondururdu.
    if (typeof clientOrderId !== 'string' || !Object.prototype.hasOwnProperty.call(this.state.liveOrders, clientOrderId)) return null;
    return this.state.liveOrders[clientOrderId] || null;
  }

  _recordExchangeResponse(clientOrderId, order) {
    const existing = this.get(clientOrderId);
    if (!existing) return this._record(clientOrderId, order, { tolerateSaveError: true });

    // REST create cevabi, WebSocket executionReport'tan daha eski gelebilir.
    // Bu durumda create cevabi FILLED/partial durumunu NEW'e geri dusuremez.
    const mergedStatus = mergeExecutionStatus(
      existing.status,
      order.status,
      Number(existing.executedQty || 0),
      Number(order.executedQty || 0)
    );
    const existingFees = existing.commissionByAsset || {};
    const responseFees = order.commissionByAsset || {};
    const mergedFees = { ...existingFees };
    for (const [asset, value] of Object.entries(responseFees)) {
      mergedFees[asset] = Math.max(Number(existingFees[asset] || 0), Number(value || 0));
    }
    const mergedExecutedQty = Math.max(Number(existing.executedQty || 0), Number(order.executedQty || 0));
    const mergedQuoteQty = Math.max(Number(existing.quoteQty || 0), Number(order.quoteQty || 0));
    // KRITIK: net alanlar (netExecutedQty/netQuoteQty) birlestirilmis degerlerden YENIDEN hesaplanir.
    // Aksi halde WebSocket'ten daha once gelen dolum, gecikmis bir REST cevabinin (NEW, 0 dolum)
    // net=0 alanlariyla ezilir; LiveEngine dolu bir alimi "0 adet" sanip pozisyonu kaydetmez.
    const symbolForSplit = order.symbol || existing.symbol;
    const { base: mBase, quote: mQuote } = splitSymbol(symbolForSplit);
    const mSide = String(order.side || existing.side || '').toLowerCase();
    const mergedCommissionBase = mBase ? (mergedFees[mBase] || 0) : 0;
    const mergedCommissionQuote = mQuote ? (mergedFees[mQuote] || 0) : 0;
    return this._record(clientOrderId, {
      ...order,
      status: mergedStatus,
      executedQty: mergedExecutedQty,
      netExecutedQty: netBaseReceived(mSide, mergedExecutedQty, mBase, { byAsset: mergedFees }),
      quoteQty: mergedQuoteQty,
      netQuoteQty: netQuoteFlow(mSide, mergedQuoteQty, mQuote, { byAsset: mergedFees }),
      commissionByAsset: mergedFees,
      commissionTotal: commissionTotalForSingleAsset(mergedFees),
      commissionBase: mergedCommissionBase || order.commissionBase || existing.commissionBase || 0,
      commissionQuote: mergedCommissionQuote || order.commissionQuote || existing.commissionQuote || 0
    }, { tolerateSaveError: true });
  }

  listPending() {
    return Object.values(this.state.liveOrders).filter((o) => !TERMINAL.has(String(o.status).toUpperCase()));
  }

  cleanupTerminal({ maxRecords = 1000, maxAgeMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    const now = this.nowFn();
    const terminal = Object.values(this.state.liveOrders)
      .filter((o) => TERMINAL.has(String(o.status || '').toUpperCase()))
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    const keep = new Set(terminal.slice(0, maxRecords).map((o) => o.clientOrderId));
    for (const order of terminal) {
      const age = now - Date.parse(order.updatedAt || order.createdAt || now);
      if (age > maxAgeMs || !keep.has(order.clientOrderId)) delete this.state.liveOrders[order.clientOrderId];
    }
    this.save();
  }

  async submitMarket({ symbol, side, amount, clientOrderId, meta = {} }) {
    this.assertLiveCapability();
    if (!symbol || !['buy', 'sell'].includes(String(side).toLowerCase())) throw new Error('Geçersiz sembol veya emir yönü.');
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error('Emir miktarı geçersiz.');

    const cid = clientOrderId || makeClientOrderId('trade');
    const existing = this.get(cid);
    if (existing) {
      // Ayni kimlikle ikinci kez emir GONDERME. Once mevcut emrin sonucu sorgulanir.
      return { ...existing, reused: true };
    }

    const createdAt = new Date(this.nowFn()).toISOString();
    this._record(cid, {
      clientOrderId: cid,
      symbol,
      side: String(side).toLowerCase(),
      amount: Number(amount),
      status: 'PENDING',
      exchangeOrderId: null,
      executedQty: 0,
      quoteQty: 0,
      createdAt,
      updatedAt: createdAt,
      uncertain: false,
      meta
    });

    let raw;
    try {
      raw = await this.exchange.createMarketOrder(symbol, String(side).toLowerCase(), Number(amount), cid);
    } catch (err) {
      if (err && err.unknownOutcome) {
        // EN KRITIK KURAL: tekrar gonderme. Emir borsada acilmis olabilir.
        return this._record(cid, {
          status: 'UNKNOWN',
          uncertain: true,
          error: { message: err.message, httpStatus: err.httpStatus || null },
          requiresReconciliation: true
        }, { tolerateSaveError: true });
      }
      return this._record(cid, {
        status: 'REJECTED',
        uncertain: false,
        error: { message: err?.message || String(err) }
      }, { tolerateSaveError: true });
    }
    // Emir borsaya GITTI. Buradan sonraki hicbir hata (yanit isleme, disk yazimi) "REJECTED" sayilamaz:
    // emir borsada gerceklesmis olabilir; belirsiz sayilir ve mutabakat/yeniden sorgu ile cozulur.
    try {
      let order = normalizeOrder(raw, { clientOrderId: cid, symbol, side: String(side).toLowerCase(), amount: Number(amount), status: 'NEW' });
      order = await this._enrichThirdAssetFee(order);
      if (order.status === 'UNKNOWN') throw Object.assign(new Error('Borsa emir durumunu doğrulamadı; mutabakat gerekli.'), { unknownOutcome: true });
      return this._recordExchangeResponse(cid, {
        ...order,
        status: order.status,
        uncertain: false,
        exchangeOrderId: order.exchangeOrderId
      });
    } catch (err) {
      return this._record(cid, { status: 'UNKNOWN', uncertain: true, requiresReconciliation: true, error: { message: `emir borsaya gönderildi ama yanıt işlenemedi: ${err?.message || String(err)}` } }, { tolerateSaveError: true });
    }
  }

  async submitStop({ symbol, side, amount, stopPrice, limitPrice = 0, trailingDelta = 0, clientOrderId, meta = {} }) {
    this.assertLiveCapability();
    if (typeof this.exchange.createStopOrder !== 'function' || typeof this.exchange.cancelOrder !== 'function') {
      throw new Error('Koruyucu stop emri için borsa desteği gerekli.');
    }
    if (!symbol || String(side).toLowerCase() !== 'sell') throw new Error('Koruyucu stop şimdilik yalnızca sell destekliyor.');
    if (![amount, stopPrice].every((v) => Number.isFinite(Number(v)) && Number(v) > 0)) throw new Error('Stop emri parametreleri geçersiz.');
    if (!(Number(limitPrice) >= 0 && Number.isFinite(Number(limitPrice)))) throw new Error('Stop limitPrice değeri geçersiz.');
    const cid = clientOrderId || makeClientOrderId('stop');
    const existing = this.get(cid);
    if (existing) return { ...existing, reused: true };
    this._record(cid, {
      clientOrderId: cid, symbol, side: 'sell', amount: Number(amount),
      stopPrice: Number(stopPrice), limitPrice: Number(limitPrice), trailingDelta: Number(trailingDelta || 0),
      type: 'STOP_LOSS', status: 'PENDING', exchangeOrderId: null,
      executedQty: 0, quoteQty: 0, uncertain: false, meta,
      createdAt: new Date(this.nowFn()).toISOString()
    });
    let raw;
    try {
      raw = await this.exchange.createStopOrder(symbol, 'sell', Number(amount), Number(stopPrice), Number(limitPrice), cid, Number(trailingDelta || 0));
    } catch (err) {
      if (err && err.unknownOutcome) {
        return this._record(cid, { status: 'UNKNOWN', uncertain: true, requiresReconciliation: true, error: { message: err.message, httpStatus: err.httpStatus || null } }, { tolerateSaveError: true });
      }
      return this._record(cid, { status: 'REJECTED', uncertain: false, error: { message: err?.message || String(err) } }, { tolerateSaveError: true });
    }
    try {
      let order = normalizeOrder(raw, { clientOrderId: cid, symbol, side: String(side).toLowerCase(), amount: Number(amount), status: 'NEW' });
      order = await this._enrichThirdAssetFee(order);
      if (order.status === 'UNKNOWN') throw Object.assign(new Error('Borsa stop emri durumunu doğrulamadı; mutabakat gerekli.'), { unknownOutcome: true });
      return this._recordExchangeResponse(cid, { ...order, type: 'STOP_LOSS', status: order.status, uncertain: false });
    } catch (err) {
      return this._record(cid, { status: 'UNKNOWN', uncertain: true, requiresReconciliation: true, error: { message: `emir borsaya gönderildi ama yanıt işlenemedi: ${err?.message || String(err)}` } }, { tolerateSaveError: true });
    }
  }

  async submitOco({ symbol, side, amount, stopPrice, takeProfitPrice, stopLimitPrice = 0, trailingDelta = 0, meta = {} }) {
    this.assertLiveCapability();
    if (this.exchange.capabilities?.oco !== true || typeof this.exchange.createOcoOrder !== 'function') {
      throw new Error('Bu borsada doğrulanmış native OCO koruması yok. Aynı miktara bağımsız iki SELL emri kesinlikle gönderilmeyecek.');
    }
    if (!symbol || String(side).toLowerCase() !== 'sell') throw new Error('OCO şimdilik yalnızca sell destekliyor.');
    if (![amount, takeProfitPrice].every((v) => Number.isFinite(Number(v)) && Number(v) > 0)) throw new Error('OCO emir parametreleri geçersiz.');
    if (!(Number(trailingDelta) > 0) && !(Number(stopPrice) > 0)) throw new Error('OCO stop veya trailingDelta gerekli.');
    const listClientOrderId = makeClientOrderId('oco');
    const takeProfitClientOrderId = makeClientOrderId('tp');
    const stopClientOrderId = makeClientOrderId('stop');
    const createdAt = new Date(this.nowFn()).toISOString();
    const common = { symbol, side: 'sell', amount: Number(amount), status: 'PENDING', executedQty: 0, quoteQty: 0, uncertain: false, meta: { ...meta, oco: true, orderListClientId: listClientOrderId }, createdAt };
    this._record(takeProfitClientOrderId, { clientOrderId: takeProfitClientOrderId, ...common, type: 'TAKE_PROFIT', stopPrice: Number(takeProfitPrice), exchangeOrderId: null });
    this._record(stopClientOrderId, { clientOrderId: stopClientOrderId, ...common, type: 'STOP_LOSS', stopPrice: Number(stopPrice || 0), trailingDelta: Number(trailingDelta || 0), exchangeOrderId: null });
    let raw;
    try {
      raw = await this.exchange.createOcoOrder(symbol, 'sell', Number(amount), {
        takeProfitPrice: Number(takeProfitPrice), stopPrice: Number(stopPrice || 0), stopLimitPrice: Number(stopLimitPrice || 0),
        trailingDelta: Number(trailingDelta || 0), listClientOrderId, takeProfitClientOrderId, stopClientOrderId
      });
    } catch (err) {
      const patch = err?.unknownOutcome ? { status: 'UNKNOWN', uncertain: true, requiresReconciliation: true, error: { message: err.message, httpStatus: err.httpStatus || null } } : { status: 'REJECTED', uncertain: false, error: { message: err?.message || String(err) } };
      this._record(takeProfitClientOrderId, patch, { tolerateSaveError: true });
      this._record(stopClientOrderId, patch, { tolerateSaveError: true });
      throw Object.assign(new Error(err?.message || 'OCO oluşturulamadı'), { unknownOutcome: !!err?.unknownOutcome, httpStatus: err?.httpStatus });
    }
    // OCO borsaya GITTI: yanit isleme hatasi "REJECTED" sayilmaz, belirsiz isaretlenir (bkz. submitMarket).
    try {
      const reports = Array.isArray(raw?.orderReports) ? raw.orderReports : [];
      const legs = Array.isArray(raw?.orders) ? raw.orders : [];
      const findLeg = (cid) => reports.find(x => x.clientOrderId === cid) || legs.find(x => x.clientOrderId === cid) || null;
      if (!findLeg(takeProfitClientOrderId) || !findLeg(stopClientOrderId)) {
        throw new Error('OCO cevabında iki koruyucu emir bacağı da kimlikle doğrulanamadı.');
      }
      const normalizeLeg = async (cid, type) => {
        const leg = findLeg(cid) || {};
        let order = normalizeOrder(leg, { clientOrderId: cid, symbol, side: 'sell', amount: Number(amount), status: 'NEW' });
        order = await this._enrichThirdAssetFee(order);
        if (order.status === 'UNKNOWN') throw Object.assign(new Error('OCO bacağının durumu doğrulanamadı; mutabakat gerekli.'), { unknownOutcome: true });
        return this._recordExchangeResponse(cid, { ...order, type, status: order.status, uncertain: false, orderListId: raw?.orderListId ?? null, orderListClientId: raw?.listClientOrderId || listClientOrderId });
      };
      const tp = await normalizeLeg(takeProfitClientOrderId, 'TAKE_PROFIT');
      const stop = await normalizeLeg(stopClientOrderId, 'STOP_LOSS');
      return { status: (tp.status === 'FILLED' || stop.status === 'FILLED') ? 'FILLED' : 'NEW', orderListId: raw?.orderListId ?? null, orderListClientId: raw?.listClientOrderId || listClientOrderId, takeProfit: tp, stop, takeProfitClientOrderId, stopClientOrderId, trailingDelta: Number(trailingDelta || 0) };
    } catch (err) {
      const patch = { status: 'UNKNOWN', uncertain: true, requiresReconciliation: true, error: { message: `OCO borsaya gönderildi ama yanıtı işlenemedi: ${err?.message || String(err)}` } };
      this._record(takeProfitClientOrderId, patch, { tolerateSaveError: true });
      this._record(stopClientOrderId, patch, { tolerateSaveError: true });
      throw Object.assign(new Error(patch.error.message), { unknownOutcome: true });
    }
  }

  async submitTakeProfit({ symbol, side, amount, stopPrice, limitPrice = 0, clientOrderId, meta = {} }) {
    this.assertLiveCapability();
    if (typeof this.exchange.createTakeProfitOrder !== 'function' || typeof this.exchange.cancelOrder !== 'function') {
      throw new Error('Gerçek take-profit emri için borsa desteği gerekli.');
    }
    if (!symbol || String(side).toLowerCase() !== 'sell') throw new Error('Take-profit şimdilik yalnızca sell destekliyor.');
    if (![amount, stopPrice].every((v) => Number.isFinite(Number(v)) && Number(v) > 0)) throw new Error('Take-profit emri parametreleri geçersiz.');
    if (!Number.isFinite(Number(limitPrice ?? 0)) || Number(limitPrice ?? 0) < 0) throw new Error('Take-profit limitPrice değeri geçersiz.');
    const cid = clientOrderId || makeClientOrderId('tp');
    const existing = this.get(cid);
    if (existing) return { ...existing, reused: true };
    this._record(cid, {
      clientOrderId: cid, symbol, side: 'sell', amount: Number(amount),
      stopPrice: Number(stopPrice), limitPrice: Number(limitPrice || 0),
      type: 'TAKE_PROFIT', status: 'PENDING', exchangeOrderId: null,
      executedQty: 0, quoteQty: 0, uncertain: false, meta,
      createdAt: new Date(this.nowFn()).toISOString()
    });
    let raw;
    try {
      raw = await this.exchange.createTakeProfitOrder(symbol, 'sell', Number(amount), Number(stopPrice), Number(limitPrice || 0), cid);
    } catch (err) {
      if (err && err.unknownOutcome) return this._record(cid, { status: 'UNKNOWN', uncertain: true, requiresReconciliation: true, error: { message: err.message, httpStatus: err.httpStatus || null } }, { tolerateSaveError: true });
      return this._record(cid, { status: 'REJECTED', uncertain: false, error: { message: err?.message || String(err) } }, { tolerateSaveError: true });
    }
    try {
      let order = normalizeOrder(raw, { clientOrderId: cid, symbol, side: 'sell', amount: Number(amount), status: 'NEW' });
      order = await this._enrichThirdAssetFee(order);
      if (order.status === 'UNKNOWN') throw Object.assign(new Error('Borsa take-profit durumunu doğrulamadı; mutabakat gerekli.'), { unknownOutcome: true });
      return this._recordExchangeResponse(cid, { ...order, type: 'TAKE_PROFIT', status: order.status, uncertain: false });
    } catch (err) {
      return this._record(cid, { status: 'UNKNOWN', uncertain: true, requiresReconciliation: true, error: { message: `emir borsaya gönderildi ama yanıt işlenemedi: ${err?.message || String(err)}` } }, { tolerateSaveError: true });
    }
  }

  async cancel(clientOrderId) {
    this.assertLiveCapability();
    const record = this.get(clientOrderId);
    if (!record) throw new Error(`Yerel emir kaydı bulunamadı: ${clientOrderId}`);
    if (String(record.status).toUpperCase() === 'CANCELED') return record;
    if (TERMINAL.has(String(record.status).toUpperCase()) && String(record.status).toUpperCase() !== 'NEW') return record;
    if (record.exchangeOrderId === null || record.exchangeOrderId === undefined) {
      if (typeof this.exchange.findOrderForRecovery === 'function') {
        const found = await this.exchange.findOrderForRecovery(record);
        if (found?.exchangeOrderId != null) {
          record.exchangeOrderId = found.exchangeOrderId;
          this._record(clientOrderId, { exchangeOrderId: found.exchangeOrderId, recoveredByFingerprint: true });
        }
      }
    }
    if (record.exchangeOrderId === null || record.exchangeOrderId === undefined) {
      throw new Error(`İptal için borsa emir numarası yok: ${clientOrderId}`);
    }
    try {
      const raw = await this.exchange.cancelOrder(record.symbol, record.exchangeOrderId);
      const normalized = normalizeOrder(raw, record);
      const status = normalizeStatus(raw);
      // Cancel cevabinin UNKNOWN olmasi iptalin gercekten yapildigini kanitlamaz.
      // STOP halen borsada acik olabilir; bu durumda CANCELED'a zorlamak
      // sonrasinda market satisiyla cift satis/oversell riskine yol acar.
      if (status === 'UNKNOWN') {
        return this._record(clientOrderId, {
          ...normalized,
          status: 'UNKNOWN',
          uncertain: true,
          requiresReconciliation: true,
          cancelResult: raw,
          cancellationError: 'İptal sonucu belirsiz.'
        }, { tolerateSaveError: true });
      }
      return this._record(clientOrderId, {
        ...normalized,
        status,
        cancelResult: raw,
        canceledAt: new Date(this.nowFn()).toISOString()
      }, { tolerateSaveError: true });
    } catch (err) {
      if (err && err.unknownOutcome) {
        return this._record(clientOrderId, { status: 'UNKNOWN', uncertain: true, requiresReconciliation: true, cancellationError: err.message }, { tolerateSaveError: true });
      }
      throw err;
    }
  }

  async reconcile(clientOrderId, { markUnknownOnError = true } = {}) {
    this.assertLiveCapability();
    const record = this.get(clientOrderId);
    if (!record) throw new Error(`Yerel emir kaydı bulunamadı: ${clientOrderId}`);
    if (TERMINAL.has(String(record.status).toUpperCase())) return record;

    try {
      let raw;
      if ((record.exchangeOrderId === null || record.exchangeOrderId === undefined) && this.exchange.capabilities?.recoveryByFingerprint) {
        raw = await this.exchange.findOrderForRecovery(record);
        if (!raw) throw new Error('Belirsiz emir benzersiz şekilde bulunamadı; yeni emir gönderilmeyecek.');
        record.exchangeOrderId = raw.exchangeOrderId;
        this._record(clientOrderId, { exchangeOrderId: raw.exchangeOrderId, recoveredByFingerprint: true });
      } else {
        raw = await this.exchange.getOrder(record.symbol, record.exchangeOrderId, clientOrderId);
      }
      let order = normalizeOrder(raw, record);
      // REST yaniti daha eski/stale olabilir. WebSocket'ten daha yeni bir
      // FILLED veya daha buyuk kümülatif dolum geldiyse REST sorgusu bunu
      // geriye döndürmemeli. Reconciliation da executionReport ile ayni
      // monotonic kurallari kullanir.
      const mergedStatus = mergeExecutionStatus(
        record.status,
        order.status,
        Number(record.executedQty || 0),
        Number(order.executedQty || 0)
      );
      const mergedExecutedQty = Math.max(Number(record.executedQty || 0), Number(order.executedQty || 0));
      const mergedQuoteQty = Math.max(Number(record.quoteQty || 0), Number(order.quoteQty || 0));
      // Komisyonlar varlik bazinda MAX ile birlestirilir (kumulatif degerler geriye gitmez). Eskiden REST yaniti
      // bos olmayan bir komisyon haritasi getirdiginde WebSocket'ten birikmis daha buyuk komisyonun USTUNE YAZIYORDU;
      // bu da komisyonu eksik sayip maliyet/K-Z ve base-varlik miktari muhasebesini bozabilirdi.
      const mergedCommission = { ...(record.commissionByAsset || {}) };
      for (const [asset, value] of Object.entries(order.commissionByAsset || {})) {
        mergedCommission[asset] = Math.max(Number(mergedCommission[asset] || 0), Number(value || 0));
      }
      order = {
        ...order,
        status: mergedStatus,
        executedQty: mergedExecutedQty,
        quoteQty: mergedQuoteQty,
        commissionByAsset: mergedCommission,
        commissionTotal: commissionTotalForSingleAsset(mergedCommission)
      };
      const { base: mergedBase, quote: mergedQuote } = splitSymbol(order.symbol);
      order.netExecutedQty = netBaseReceived(order.side, mergedExecutedQty, mergedBase, { byAsset: mergedCommission });
      order.netQuoteQty = netQuoteFlow(order.side, mergedQuoteQty, mergedQuote, { byAsset: mergedCommission });
      order = await this._enrichThirdAssetFee(order);
      return this._record(clientOrderId, {
        ...order,
        uncertain: false,
        requiresReconciliation: false,
        lastReconciledAt: new Date(this.nowFn()).toISOString()
      }, { tolerateSaveError: true });
    } catch (err) {
      // Periyodik yenilemede (markUnknownOnError=false) gecici ag/5xx/-1021 hatasi saglikli bir emri (ornegin acik
      // koruyucu stop) UNKNOWN yapip botu kilitlememeli: kayit oldugu gibi birakilir.
      if (!markUnknownOnError) throw err;
      // NOT FOUND durumunda bile otomatik tekrar yok. Bir emrin gerçekten hiç
      // yaratilmadigini kesin olarak ispatlamak adaptere/borsaya özgüdür.
      return this._record(clientOrderId, {
        status: 'UNKNOWN',
        uncertain: true,
        requiresReconciliation: true,
        reconciliationError: err?.message || String(err),
        lastReconciledAt: new Date(this.nowFn()).toISOString()
      }, { tolerateSaveError: true });
    }
  }

  applyExecutionReport(event) {
    if (!event || String(event.e || '') !== 'executionReport') return { handled: false, reason: 'not_executionReport' };
    const cid = event.c || event.clientOrderId;
    if (!cid || typeof cid !== 'string') return { handled: false, reason: 'missing_clientOrderId' };
    if (['__proto__', 'constructor', 'prototype'].includes(cid)) return { handled: false, reason: 'reserved_clientOrderId' };

    const existing = this.get(cid);
    if (!existing) {
      // An order we did not create is intentionally NOT adopted automatically.
      // It must be investigated by account reconciliation first.
      this.state.liveStreamWarning = {
        at: new Date(this.nowFn()).toISOString(),
        type: 'UNKNOWN_ORDER_EVENT',
        clientOrderId: cid,
        exchangeOrderId: event.i ?? null,
        symbol: event.s || null
      };
      // Son mutabakat sonucu eski olsa bile, yeni ve taninmayan bir emir
      // olayi geldiginde canli islem kapisi tekrar kapanir.
      this.state.liveReconciliation = {
        ...(this.state.liveReconciliation || {}),
        safeToTrade: false,
        reason: 'WebSocket üzerinden tanınmayan emir olayı alındı.'
      };
      this.save();
      return { handled: false, reason: 'unknown_local_order', clientOrderId: cid };
    }

    const incomingStatus = normalizeStatus({ status: event.X });
    const executionId = event.I ?? event.t ?? `${event.E || ''}:${event.z || ''}:${event.Z || ''}`;
    const seen = new Set(existing.seenExecutionIds || []);
    const isNewExecution = !seen.has(String(executionId));
    if (isNewExecution) seen.add(String(executionId));
    let commission = existing.commission || { total: 0, byAsset: {} };
    if (isNewExecution) commission = addExecutionCommission(commission, event.N, event.n);
    const symbol = canonicalSymbol(event.s, existing.symbol);
    const { base: baseAsset, quote: quoteAsset } = splitSymbol(symbol);
    const eventExecutedQty = Number(event.z);
    const eventQuoteQty = Number(event.Z);
    const previousExecutedQty = Number(existing.executedQty || 0);
    const previousQuoteQty = Number(existing.quoteQty || 0);
    // Cumulative quantities must never move backwards after reconnect/out-of-order delivery.
    const grossExecutedQty = Number.isFinite(eventExecutedQty) ? Math.max(previousExecutedQty, eventExecutedQty) : previousExecutedQty;
    const grossQuoteQty = Number.isFinite(eventQuoteQty) ? Math.max(previousQuoteQty, eventQuoteQty) : previousQuoteQty;
    const status = mergeExecutionStatus(existing.status, incomingStatus, previousExecutedQty, grossExecutedQty);
    const side = String(event.S || existing.side || '').toLowerCase();
    const patch = {
      exchangeOrderId: event.i ?? existing.exchangeOrderId ?? null,
      clientOrderId: cid,
      symbol,
      side,
      status,
      executedQty: grossExecutedQty,
      netExecutedQty: netBaseReceived(side, grossExecutedQty, baseAsset, commission),
      origQty: Number(event.q ?? existing.origQty ?? existing.amount ?? 0),
      quoteQty: grossQuoteQty,
      netQuoteQty: netQuoteFlow(side, grossQuoteQty, quoteAsset, commission),
      commissionTotal: commission.total,
      commissionByAsset: commission.byAsset,
      commissionBase: baseAsset ? (commission.byAsset[baseAsset] || 0) : 0,
      commissionQuote: quoteAsset ? (commission.byAsset[quoteAsset] || 0) : 0,
      commission: commission,
      seenExecutionIds: [...seen],
      lastExecutionType: event.x || null,
      lastExecutionId: executionId,
      lastEventAt: event.E || null,
      uncertain: false,
      requiresReconciliation: false
    };
    // WebSocket dolum olayi bellege HER ZAMAN islenmeli; disk yazimi hatasi olayi (ve dolumu) kaybettirmemeli.
    return { handled: true, order: this._record(cid, patch, { tolerateSaveError: true }) };
  }

  async reconcileAll() {
    const pending = this.listPending();
    const results = [];
    for (const order of pending) results.push(await this.reconcile(order.clientOrderId));
    this.cleanupTerminal();
    return results;
  }

  // Calisirken (baslangic disinda) bekleyen emirlerin durumunu borsadan tazeler. Hata olursa kaydi UNKNOWN'a
  // CEVIRMEZ; yalnizca hata sayisini dondurur (bir sonraki turda tekrar denenir). Terminal kayit temizligi de burada.
  async refreshPending() {
    let refreshed = 0;
    let failed = 0;
    for (const order of this.listPending()) {
      try { await this.reconcile(order.clientOrderId, { markUnknownOnError: false }); refreshed++; } catch (_) { failed++; }
    }
    this.cleanupTerminal(); // uzun sure acik calisan botta liveOrders sinirsiz buyumesin
    return { refreshed, failed };
  }
}

module.exports = { OrderManager, makeClientOrderId, canonicalSymbol, normalizeOrder, splitSymbol, TERMINAL };
