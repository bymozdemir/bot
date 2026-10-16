// src/exchanges/binance.js
//
// Binance Spot REST adaptoru. Genel (public) uclar API anahtari gerektirmez ve
// kagit islem (paper) modunda kullanilan tek kisim burasidir. Ozel (private)
// uclar -- bakiye, emir gonderme, stop emri -- yazildi ve test edilmeye hazir,
// ANCAK bu paket henuz hicbir yerden bunlari cagirmiyor. Canli faza gecmeden
// once Binance testnet uzerinde ayrica dogrulanmali.
//
// Kaynak: https://api.binance.com (Spot REST API, HMAC SHA256 imzali istekler)

const { assertAllowedUrl } = require('../util/hostGuard');
const crypto = require('crypto');
const ExchangeAdapter = require('./base');
const { fetchWithRetry } = require('../util/retry');
const { validateOrderArgs, validatePositivePrice, guardCreate } = require('./orderGuards');
const { plainDecimal } = require('../execution');
const { applyNetworkDefaults } = require('../util/network');

const BINANCE_COM_BASE_URL = 'https://api.binance.com';

// baseUrl instance ozelligi olarak tutulur (modul sabiti degil) ki Binance TR
// gibi ayni API seklini paylasan bir borsa, bu sinifi extend edip sadece
// adresi degistirerek yeniden kullanabilsin (bkz. binancetr.js).
class BinanceAdapter extends ExchangeAdapter {
  constructor(opts = {}) {
    applyNetworkDefaults();
    super(opts);
    this.id = 'binance';
    this.name = 'Binance';
    this.quoteAssets = ['USDT'];
    this.capabilities = { clientOrderId: true, orderQuery: true, balanceQuery: true, openOrdersQuery: true, userDataStream: true, oco: true, nativeTrailingOco: true, marketOrderBook: true, protectiveStopImplemented: true, liveTradingVerified: false };
    // BINANCE_BASE_URL: ana adres engelliyse alternatif (yalnizca piyasa verisi sunan) adres, orn. https://data-api.binance.vision
    const env = String(opts.environment || process.env.BINANCE_ENV || 'production').toLowerCase();
    if (!['production', 'testnet'].includes(env)) throw new Error('BINANCE_ENV production veya testnet olmalı.');
    this.environment = env;
    const defaultBase = env === 'testnet' ? 'https://testnet.binance.vision' : BINANCE_COM_BASE_URL;
    const configuredBase = String(opts.baseUrl || process.env.BINANCE_BASE_URL || '').replace(/\/+$/, '');
    // Imzali istekler (emir, bakiye) yalnizca RESMI Binance adreslerine gitmeli: ortam ayarina
    // uymayan bir adres reddedilir. Binance TR gibi alt siniflar kendi adreslerini kullanir
    // (skipBaseUrlCheck); yerel sahte sunucu yalnizca BINANCE_ALLOW_LOCAL_BASE_URL=true ile
    // (testler icin) kabul edilir ve canli mod bu bayrakla BASLATILAMAZ (bkz. liveEngine).
    if (configuredBase && !opts.skipBaseUrlCheck) {
      const host = (() => { try { return new URL(configuredBase).hostname.toLowerCase(); } catch (_) { return ''; } })();
      const isTestnetHost = host === 'testnet.binance.vision' || host.endsWith('.testnet.binance.vision');
      const isProductionHost = host === 'api.binance.com' || host === 'api-gcp.binance.com' || /^api[1-4]\.binance\.com$/.test(host);
      const isLocalTestHost = process.env.BINANCE_ALLOW_LOCAL_BASE_URL === 'true' && (host === '127.0.0.1' || host === 'localhost');
      // data-api.binance.vision is a public market-data endpoint, not a signed
      // trading/account REST base. Never allow credentials or orders to target it.
      if (!isLocalTestHost && (!host || (env === 'testnet' && !isTestnetHost) || (env === 'production' && !isProductionHost))) {
        throw new Error(`Binance base URL ortamla uyumsuz: ${configuredBase}`);
      }
    }
    this.baseUrl = configuredBase || defaultBase;
    // Yerel saat sapmasi (ms). Imzali isteklerde timestamp bununla duzeltilir; saat recvWindow'u
    // (5 sn) asarsa Binance -1021 ile TUM emirleri (koruyucu stop dahil) reddeder.
    this._timeOffsetMs = 0;
    this._timeSyncedAt = 0;
  }

  // Borsa saatine gore duzeltilmis simdiki zaman (ms). Mum kapanisi ve WebSocket imza zaman damgasi bunu kullanir.
  nowMs() { return Date.now() + (this._timeOffsetMs || 0); }

  async syncTime() { await this._ensureTimeSync(true); return this._timeOffsetMs || 0; }

  async _ensureTimeSync(force = false) {
    if (!force && this._timeSyncedAt && Date.now() - this._timeSyncedAt < 10 * 60 * 1000) return;
    try {
      const t0 = Date.now();
      const data = await this._publicGet('/api/v3/time');
      const t1 = Date.now();
      const server = Number(data && data.serverTime);
      if (Number.isFinite(server) && server > 1e12) this._timeOffsetMs = Math.round(server - (t0 + t1) / 2);
    } catch (_) { /* zaman servisi yoksa yerel saatle devam */ }
    this._timeSyncedAt = Date.now();
  }

  normalizeSymbol(symbol) {
    // "BTC/USDT" -> "BTCUSDT"
    return symbol.replace('/', '').toUpperCase();
  }

  // HERKESE ACIK (imzasiz) veri istekleri icin aday adresler. Ana adres ISS/modem tarafindan
  // engelleniyorsa ya da yanit vermiyorsa resmi alternatiflere dusulur. Imzali istekler
  // (emir/bakiye) ASLA buradaki adaylara gitmez; yalnizca this.baseUrl kullanilir.
  _publicHosts() {
    if (this.id !== 'binance' || this.environment !== 'production') return [this.baseUrl];
    const custom = String(process.env.BINANCE_PUBLIC_FALLBACKS || '').trim();
    if (custom.toLowerCase() === 'off') return [this.baseUrl];
    const defaults = ['https://api-gcp.binance.com', 'https://api1.binance.com', 'https://api2.binance.com',
      'https://api3.binance.com', 'https://api4.binance.com', 'https://data-api.binance.vision'];
    const extra = custom ? custom.split(',').map((x) => x.trim().replace(/\/+$/, '')).filter((x) => /^https:\/\//.test(x)) : defaults;
    // Yerel test sunucusu (BINANCE_ALLOW_LOCAL_BASE_URL) kullaniliyorsa dis adreslere asla dusme.
    if (!/binance\.(com|vision)$/i.test((() => { try { return new URL(this.baseUrl).hostname; } catch (_) { return ''; } })())) return [this.baseUrl];
    return [this.baseUrl, ...extra.filter((x) => x !== this.baseUrl)];
  }

  async _publicGet(pathname, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const hosts = this._publicHosts();
    this._hostDownUntil = this._hostDownUntil || {};
    const now = Date.now();
    const order = hosts.filter((h) => !(this._hostDownUntil[h] > now));
    const candidates = order.length ? order : hosts; // hepsi "kapali" ise yine de dene
    // Son basarili adres onde denenir (sticky), boylece her tick'te bozuk adresi beklemeyiz.
    if (this._publicGoodHost && candidates.includes(this._publicGoodHost)) {
      candidates.splice(candidates.indexOf(this._publicGoodHost), 1);
      candidates.unshift(this._publicGoodHost);
    }
    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
      const base = candidates[i];
      const url = `${base}${pathname}${qs ? '?' + qs : ''}`;
      try {
        const res = await fetchWithRetry(url, {}, i === 0 ? { retries: 1, timeoutMs: 8000 } : { retries: 0, timeoutMs: 6000 });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`${this.name} ${pathname} başarısız (${res.status}): ${body.slice(0, 200)}`);
          err.httpStatus = res.status;
          // 4xx (geçersiz parametre vb.) alternatif adreste de aynı olur; yalnızca 451/403/5xx'te sıradakini dene.
          if (![403, 418, 429, 451].includes(res.status) && res.status < 500) throw err;
          lastErr = err;
          this._hostDownUntil[base] = Date.now() + 60000;
          continue;
        }
        if (base !== this._publicGoodHost) {
          if (this._publicGoodHost || i > 0) console.warn(`[binance] herkese açık veri adresi: ${base}`);
          this._publicGoodHost = base;
        }
        return await res.json();
      } catch (e) {
        if (e && e.httpStatus && e.httpStatus < 500 && ![403, 418, 429, 451].includes(e.httpStatus)) throw e;
        lastErr = e;
        this._hostDownUntil[base] = Date.now() + 60000;
      }
    }
    throw lastErr || new Error(`${this.name} ${pathname}: hiçbir adrese ulaşılamadı`);
  }

  _sign(params) {
    if (!this.apiSecret) throw new Error('API secret tanimli degil');
    const qs = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex');
    return `${qs}&signature=${signature}`;
  }

  // allowRetry: sadece GUVENLI (idempotent) istekler icin true gecilmeli.
  // Emir gonderme/iptal gibi tekrar edilirse zarar verebilecek isteklerde
  // varsayilan false kalir -- ag hatasinda otomatik yeniden denemek yerine
  // hatayi yukari firlatiriz, cift emir riskini almayiz. Yine de zaman asimi
  // korumasi (AbortController) her iki durumda da devrede.
  async _signedRequest(method, pathname, params = {}, { allowRetry = false, _timeRetried = false } = {}) {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Bu islem icin API anahtari gerekli. Panelden borsa anahtarini kaydet ya da .env dosyasina ekle.');
    }
    await this._ensureTimeSync();
    const fullParams = { ...params, timestamp: Date.now() + (this._timeOffsetMs || 0), recvWindow: 5000 };
    const qs = this._sign(fullParams);
    const url = `${this.baseUrl}${pathname}?${qs}`;
    let res;
    try {
      res = await fetchWithRetry(
        url,
        { method, headers: { 'X-MBX-APIKEY': this.apiKey } },
        { retries: allowRetry ? 2 : 0, timeoutMs: 10000 }
      );
    } catch (err) {
      // A transport timeout/DNS/reset after a mutating request can mean the
      // exchange accepted the order but the response was lost. Treat it as
      // UNKNOWN so callers reconcile instead of submitting a duplicate.
      if (String(method).toUpperCase() === 'POST' || String(method).toUpperCase() === 'DELETE') {
        err.unknownOutcome = true;
      }
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`${this.name} ${pathname} hata (${res.status}): ${data.msg || JSON.stringify(data)}`);
      // Binance'e gore 5XX cevapta emir gercekten islenmis olabilir; bu
      // durumda caller ayni emri körlemesine tekrar gondermemeli, once
      // clientOrderId/orderId ile sonucu sorgulamali.
      if (res.status >= 500) err.unknownOutcome = true;
      err.httpStatus = res.status;
      err.exchange = this.id;
      if (Number(data && data.code) === -1021) {
        err.timestampError = true; this._timeSyncedAt = 0;
        // -1021 (zaman damgasi recvWindow disinda) emir ISLENMEDEN reddedilir: saati yeniden esitleyip BIR KEZ
        // tekrar denemek guvenlidir (cift emir riski yok). Aksi halde koruyucu stop bile reddedilirdi.
        if (!_timeRetried) {
          await this._ensureTimeSync(true);
          return this._signedRequest(method, pathname, params, { allowRetry, _timeRetried: true });
        }
      }
      throw err;
    }
    return data;
  }

  async fetchCandles(symbol, timeframe = '1h', limit = 300) {
    const intervalMs = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
      '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000, '8h': 28_800_000,
      '12h': 43_200_000, '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000 }[timeframe];
    if (!intervalMs) throw new Error(`Binance desteklenmeyen timeframe: ${timeframe}`);
    const n = Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 300)));
    const raw = await this._publicGet('/api/v3/klines', {
      symbol: this.normalizeSymbol(symbol),
      interval: timeframe,
      limit: n
    });
    if (!Array.isArray(raw) || raw.length === 0) throw new Error(`Binance candle cevabı boş/geçersiz: ${symbol} ${timeframe}`);
    const rows = raw.map((k, i) => {
      if (!Array.isArray(k) || k.length < 6) throw new Error(`Binance candle[${i}] formatı geçersiz.`);
      return { t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) };
    });
    const checked = ExchangeAdapter.validateCandleRows(rows, { source: `Binance ${symbol} ${timeframe}` });
    // Bakim penceresi / islem gormeyen aralik yuzunden eksik mum olabilir: aralik, mum suresinin TAM KATI ise kabul
    // edilir (aksi halde tek bir bosluk gecmis mum penceresi boyunca parite icin cikis sinyallerini de kor ederdi).
    // Yanlis timeframe (tum aralik katlari daha buyuk) ve hizasiz zaman damgalari yine reddedilir.
    let minDelta = Infinity;
    for (let i = 1; i < checked.length; i++) {
      const d = checked[i].t - checked[i - 1].t;
      if (d <= 0 || d % intervalMs !== 0) {
        throw new Error(`Binance candle zaman aralığı bozuk: ${symbol} ${timeframe} (${checked[i - 1].t} -> ${checked[i].t})`);
      }
      if (d < minDelta) minDelta = d;
    }
    if (checked.length >= 2 && minDelta !== intervalMs) {
      throw new Error(`Binance yanlış timeframe döndürdü: ${symbol} beklenen ${timeframe}, ölçülen ${minDelta}ms.`);
    }
    return checked;
  }

  async fetchOrderBook(symbol, limit = 20) {
    const data = await this._publicGet('/api/v3/depth', { symbol: this.normalizeSymbol(symbol), limit: Math.min(100, Math.max(5, Number(limit) || 20)) });
    return { bids: data.bids || [], asks: data.asks || [], timestamp: Date.now() };
  }

  async fetchTicker(symbol) {
    const raw = await this._publicGet('/api/v3/ticker/price', { symbol: this.normalizeSymbol(symbol) });
    return { symbol, price: parseFloat(raw.price) };
  }

  // Piyasa tarayici icin: tum USDT paritelerini hacme gore donduruyoruz.
  async fetchAllTickers24h() {
    const raw = await this._publicGet('/api/v3/ticker/24hr');
    return raw
      .filter((t) => t.symbol.endsWith('USDT'))
      .map((t) => ({
        symbol: t.symbol.replace('USDT', '') + '/USDT',
        lastPrice: parseFloat(t.lastPrice),
        changePct: parseFloat(t.priceChangePercent),
        quoteVolume: parseFloat(t.quoteVolume), // USDT cinsinden 24s hacim
        highPrice: parseFloat(t.highPrice),
        lowPrice: parseFloat(t.lowPrice)
      }));
  }

  async fetchSymbolRules(symbol) {
    const raw = await this._publicGet('/api/v3/exchangeInfo', { symbol: this.normalizeSymbol(symbol) });
    const info = raw.symbols && raw.symbols[0];
    if (!info) throw new Error(`Sembol bulunamadi: ${symbol}`);
    if (info.status && String(info.status).toUpperCase() !== 'TRADING') throw new Error(`Binance sembolü işlem için açık değil (${info.status}): ${symbol}`);
    const lot = info.filters.find((f) => f.filterType === 'LOT_SIZE') || {};
    const marketLot = info.filters.find((f) => f.filterType === 'MARKET_LOT_SIZE') || {};
    const priceFilter = info.filters.find((f) => f.filterType === 'PRICE_FILTER') || {};
    const notional = info.filters.find((f) => f.filterType === 'NOTIONAL') || info.filters.find((f) => f.filterType === 'MIN_NOTIONAL') || {};
    const hasNotionalFilter = Boolean(info.filters.find((f) => f.filterType === 'NOTIONAL'));
    const minNotionalAppliesToMarket = hasNotionalFilter ? notional.applyMinToMarket !== false : notional.applyToMarket !== false;
    const maxNotionalAppliesToMarket = hasNotionalFilter ? notional.applyMaxToMarket !== false : true;
    const orderTypes = Array.isArray(info.orderTypes) ? info.orderTypes : [];
    const normalizedOrderTypes = orderTypes.map((x) => String(x).toUpperCase().replace(/[_\s-]/g, ''));
    const percent = info.filters.find((f) => f.filterType === 'PERCENT_PRICE' || f.filterType === 'PERCENT_PRICE_BY_SIDE') || {};
    return {
      symbol,
      stepSize: parseFloat(lot.stepSize || '0'),
      minQty: parseFloat(lot.minQty || '0'),
      maxQty: parseFloat(lot.maxQty || '0'),
      marketStepSize: parseFloat(marketLot.stepSize || '0'),
      marketMinQty: parseFloat(marketLot.minQty || '0'),
      marketMaxQty: parseFloat(marketLot.maxQty || '0'),
      tickSize: parseFloat(priceFilter.tickSize || '0'),
      minPrice: parseFloat(priceFilter.minPrice || '0'),
      maxPrice: parseFloat(priceFilter.maxPrice || '0'),
      minNotional: parseFloat(notional.minNotional || notional.minNotionalValue || '0'),
      maxNotional: parseFloat(notional.maxNotional || '0'),
      applyToMarket: minNotionalAppliesToMarket, minNotionalAppliesToMarket, maxNotionalAppliesToMarket,
      orderTypes, supportsProtectiveStop: orderTypes.length ? normalizedOrderTypes.includes('STOPLOSS') : undefined,
      multiplierUp: parseFloat(percent.multiplierUp || '0'), multiplierDown: parseFloat(percent.multiplierDown || '0'),
      baseAsset: info.baseAsset,
      quoteAsset: info.quoteAsset
    };
  }

  // ---- Asagisi ozel (private) uclar. Bu paket bunlari hicbir yerden cagirmiyor. ----

  async fetchOpenOrders() {
    const data = await this._signedRequest('GET', '/api/v3/openOrders', {}, { allowRetry: true });
    if (!Array.isArray(data)) throw new Error('Binance açık emir cevabı şema doğrulamasını geçemedi.');
    return data.map((o) => ({
      orderId: o.orderId,
      clientOrderId: o.clientOrderId,
      symbol: o.symbol,
      side: String(o.side || '').toLowerCase(),
      status: o.status,
      executedQty: Number(o.executedQty || 0),
      origQty: Number(o.origQty || 0),
      quoteQty: Number(o.cummulativeQuoteQty || 0)
    }));
  }

  // API anahtarinin yetkileri (SAPI, yalnizca production). enableWithdrawals=true ise canli mod baslatilmaz.
  async fetchApiRestrictions() {
    return this._signedRequest('GET', '/sapi/v1/account/apiRestrictions', {}, { allowRetry: true });
  }

  async fetchBalance() {
    const data = await this._signedRequest('GET', '/api/v3/account', {}, { allowRetry: true });
    const balances = {};
    for (const b of data.balances || []) {
      const free = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      if (free > 0 || locked > 0) balances[b.asset] = { free, locked };
    }
    return balances;
  }

  async createMarketOrder(symbol, side, amount, clientOrderId) {
    const a = validateOrderArgs(this.name, { side, amount, clientOrderId });
    const params = {
      symbol: this.normalizeSymbol(symbol),
      side: a.side.toUpperCase(), // BUY | SELL
      type: 'MARKET',
      quantity: plainDecimal(a.amount),
      newOrderRespType: 'FULL',
      newClientOrderId: String(clientOrderId)
    };
    return guardCreate(this.name, () => this._signedRequest('POST', '/api/v3/order', params), { clientOrderId, side: a.side });
  }

  // Spot STOP_LOSS: stopPrice tetiklenince MARKET emri calisir.
  // Koruyucu stop icin deliberately STOP_LOSS kullaniyoruz; STOP_LOSS_LIMIT
  // gap durumunda limit fiyattan dolmayip pozisyonu korumasiz birakabilir.
  async createStopOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId, trailingDelta = 0) {
    const a = validateOrderArgs(this.name, { side, amount, clientOrderId });
    const params = {
      symbol: this.normalizeSymbol(symbol),
      side: a.side.toUpperCase(),
      type: 'STOP_LOSS',
      quantity: plainDecimal(a.amount)
    };
    if (Number(trailingDelta) > 0) params.trailingDelta = Math.round(Number(trailingDelta));
    else params.stopPrice = plainDecimal(validatePositivePrice(this.name, 'stop fiyatı', stopPrice));
    params.newClientOrderId = String(clientOrderId);
    return guardCreate(this.name, () => this._signedRequest('POST', '/api/v3/order', params), { clientOrderId, side: a.side });
  }

  async createTakeProfitOrder(symbol, side, amount, stopPrice, limitPrice, clientOrderId) {
    const a = validateOrderArgs(this.name, { side, amount, clientOrderId });
    const params = { symbol: this.normalizeSymbol(symbol), side: a.side.toUpperCase(), type: 'TAKE_PROFIT', quantity: plainDecimal(a.amount), stopPrice: plainDecimal(validatePositivePrice(this.name, 'take-profit fiyatı', stopPrice)) };
    params.newClientOrderId = String(clientOrderId);
    return guardCreate(this.name, () => this._signedRequest('POST', '/api/v3/order', params), { clientOrderId, side: a.side });
  }

  async createOcoOrder(...args) {
    // Istek cikis yaptiktan sonra olusan ayristirma hatasi "kesin red" sayilmaz (bkz. orderGuards.js).
    return guardCreate(this.name, () => this._createOcoOrderRaw(...args), { requireOrderId: false });
  }

  async _createOcoOrderRaw(symbol, side, amount, { takeProfitPrice, stopPrice, trailingDelta, stopLimitPrice = 0, listClientOrderId, takeProfitClientOrderId, stopClientOrderId } = {}) {
    const aboveType = 'TAKE_PROFIT';
    const belowType = stopLimitPrice > 0 ? 'STOP_LOSS_LIMIT' : 'STOP_LOSS';
    const params = {
      symbol: this.normalizeSymbol(symbol),
      side: String(side).toUpperCase(),
      quantity: plainDecimal(amount),
      aboveType,
      belowType,
      newOrderRespType: 'RESULT'
    };
    if (listClientOrderId) params.listClientOrderId = listClientOrderId;
    if (takeProfitClientOrderId) params.aboveClientOrderId = takeProfitClientOrderId;
    if (stopClientOrderId) params.belowClientOrderId = stopClientOrderId;
    params.aboveStopPrice = plainDecimal(takeProfitPrice);
    if (belowType === 'STOP_LOSS_LIMIT') params.belowPrice = plainDecimal(stopLimitPrice);
    if (Number(trailingDelta) > 0) params.belowTrailingDelta = Math.round(Number(trailingDelta));
    else params.belowStopPrice = plainDecimal(stopPrice);
    return this._signedRequest('POST', '/api/v3/orderList/oco', params);
  }

  async getOrder(symbol, orderId, clientOrderId) {
    const params = { symbol: this.normalizeSymbol(symbol) };
    if (orderId !== undefined && orderId !== null) params.orderId = orderId;
    else if (clientOrderId) params.origClientOrderId = clientOrderId;
    else throw new Error('getOrder için orderId veya clientOrderId gerekli.');
    return this._signedRequest('GET', '/api/v3/order', params, { allowRetry: false });
  }

  async cancelOrder(symbol, orderId) {
    return this._signedRequest('DELETE', '/api/v3/order', {
      symbol: this.normalizeSymbol(symbol),
      orderId
    });
  }

  // Güncel Spot User Data Stream: imzalı WebSocket aboneliği.
  // Böylece /sapi/v1/userListenToken bağımlılığı yoktur; bu özellikle Spot
  // Testnet için önemlidir çünkü Testnet /sapi endpointlerini desteklemez.
  getUserDataStreamTimestamp(now = Date.now()) {
    return Number(now) + (this._timeOffsetMs || 0);
  }

  createUserDataStreamSignature({ timestamp, recvWindow = 5000 } = {}) {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('User Data Stream için API anahtarı gerekli.');
    }
    const params = {
      apiKey: this.apiKey,
      timestamp: Number(timestamp ?? (Date.now() + (this._timeOffsetMs || 0))),
      recvWindow: Number(recvWindow)
    };
    if (!Number.isFinite(params.timestamp) || !Number.isFinite(params.recvWindow) || params.recvWindow <= 0 || params.recvWindow > 60000) {
      throw new Error('User Data Stream imza parametreleri geçersiz.');
    }
    const payload = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    params.signature = crypto.createHmac('sha256', this.apiSecret).update(payload, 'utf8').digest('hex');
    return params;
  }

  getUserDataWsUrl() {
    if (process.env.BINANCE_WS_API_URL) return assertAllowedUrl(process.env.BINANCE_WS_API_URL, ['binance.com', 'binance.vision'], 'BINANCE_WS_API_URL', { protocols: ['wss:'] });
    return this.environment === 'testnet'
      ? 'wss://ws-api.testnet.binance.vision/ws-api/v3'
      : 'wss://ws-api.binance.com:443/ws-api/v3';
  }
}

module.exports = BinanceAdapter;
