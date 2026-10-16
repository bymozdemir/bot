// Public historical candle adapters for exchanges with documented endpoints.
// Only closed candles are returned. All timestamps are normalized to milliseconds.
'use strict';
const { fetchWithRetry, sleep } = require('../util/retry');
const { INTERVAL_MS, monthsToMs } = require('./data');
const DAY_MS = 86400000;
const WARMUP_CANDLES = 800;
const { atomicWriteFileSync } = require('../util/atomicWrite');

function marketSymbol(exchange, symbol) {
  const s = String(symbol).toUpperCase().replace(/\s/g, '');
  const [base, quote] = s.includes('/') ? s.split('/') : (s.endsWith('USDT') ? [s.slice(0,-4), 'USDT'] : s.endsWith('TRY') ? [s.slice(0,-3), 'TRY'] : [s, 'TRY']);
  if (exchange === 'okx') return `${base}-${quote}`;
  if (exchange === 'btcturk') return `${base}${quote}`;
  if (exchange === 'paribu') return `${base.toLowerCase()}_${quote === 'TRY' ? 'tl' : quote.toLowerCase()}`;
  return s.replace('/', '');
}
function intervalOkx(tf) {
  const map = { '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m','1h':'1H','2h':'2H','4h':'4H','6h':'6Hutc','12h':'12Hutc','1d':'1Dutc','3d':'3Dutc','1w':'1Wutc' };
  if (!map[tf]) throw new Error(`OKX: desteklenmeyen mum aralığı ${tf}`);
  return map[tf];
}
function normalize(rows, exchange, nowMs, step) {
  const out = new Map();
  for (const r of rows) {
    let c;
    if (exchange === 'okx') {
      if (!Array.isArray(r) || r.length < 9 || String(r[8]) !== '1') continue;
      c = { t: Number(r[0]), o:Number(r[1]), h:Number(r[2]), l:Number(r[3]), close:Number(r[4]), v:Number(r[5]) };
      c.c = c.close; delete c.close;
    } else if (exchange === 'btcturk') {
      c = { t: Number(r.t) * 1000, o:Number(r.o), h:Number(r.h), l:Number(r.l), c:Number(r.c), v:Number(r.v) };
    } else if (exchange === 'paribu') {
      // Experimental adapter: accepts TradingView-style arrays or objects only.
      if (Array.isArray(r)) c = { t:Number(r[0]) * (Number(r[0]) < 1e12 ? 1000 : 1), o:Number(r[1]), h:Number(r[2]), l:Number(r[3]), c:Number(r[4]), v:Number(r[5] || 0) };
      else c = { t:Number(r.time ?? r.t) * (Number(r.time ?? r.t) < 1e12 ? 1000 : 1), o:Number(r.open ?? r.o), h:Number(r.high ?? r.h), l:Number(r.low ?? r.l), c:Number(r.close ?? r.c), v:Number(r.volume ?? r.v ?? 0) };
    }
    if (!c || !Number.isFinite(c.t) || c.t + step > nowMs || ![c.o,c.h,c.l,c.c,c.v].every(Number.isFinite) || c.o <= 0 || c.h < c.l || c.h < Math.max(c.o,c.c) || c.l > Math.min(c.o,c.c)) continue;
    out.set(c.t, c);
  }
  return [...out.values()].sort((a,b)=>a.t-b.t);
}
async function getJson(url, fetchFn) {
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}: ${(await r.text().catch(()=>'' )).slice(0,120)}`);
  return r.json();
}
async function fetchOkx({symbol, interval, startMs, endMs, baseUrl='https://www.okx.com', fetchFn=fetchWithRetry, pauseMs=120, nowMs=Date.now()}) {
  const step=INTERVAL_MS[interval], instId=marketSymbol('okx',symbol), bar=intervalOkx(interval), rows=new Map();
  let after=String(endMs), pages=0, oldest=Infinity;
  for (let guard=0; guard<2000; guard++) {
    const qs=new URLSearchParams({instId,bar,limit:'300',after});
    const data=await getJson(`${baseUrl}/api/v5/market/history-candles?${qs}`,fetchFn); pages++;
    if (data.code !== '0' || !Array.isArray(data.data)) throw new Error(`OKX history-candles yanıtı geçersiz: ${data.msg || data.code || 'bilinmeyen hata'}`);
    if (!data.data.length) break;
    let batchMin=Infinity;
    for (const r of data.data) { const t=Number(r[0]); batchMin=Math.min(batchMin,t); if (t>=startMs && t<endMs && String(r[8])==='1') rows.set(t,r); }
    if (!Number.isFinite(batchMin) || batchMin>=oldest || batchMin<=startMs) break;
    oldest=batchMin; after=String(batchMin); if (pauseMs) await sleep(pauseMs);
  }
  const candles=normalize([...rows.values()], 'okx', nowMs, step); return withGaps(candles,step,pages);
}
async function fetchBtcTurk({symbol, interval, startMs, endMs, baseUrl='https://graph-api.btcturk.com', fetchFn=fetchWithRetry, pauseMs=100, nowMs=Date.now()}) {
  const step=INTERVAL_MS[interval];
  const resolutionMap={'1m':1,'5m':5,'15m':15,'30m':30,'1h':60,'4h':240,'1d':'1D','1w':'1W'};
  const resolution=resolutionMap[interval]; if (!resolution) throw new Error(`BtcTurk: desteklenmeyen mum aralığı ${interval}`);
  const pair=marketSymbol('btcturk',symbol), rows=[];
  // Chunk at most 25 days per request to avoid response caps; API timestamps are seconds.
  const chunkMs=Math.max(step*500, 25*DAY_MS); let from=startMs, pages=0;
  while(from<endMs && pages<1000) {
    const to=Math.min(endMs,from+chunkMs);
    const qs=new URLSearchParams({symbol:pair,resolution:String(resolution),from:String(Math.floor(from/1000)),to:String(Math.floor(to/1000))});
    const data=await getJson(`${baseUrl}/v1/klines/history?${qs}`,fetchFn); pages++;
    if (data.s && data.s!=='ok') throw new Error(`BtcTurk kline yanıtı: ${data.s}`);
    if (Array.isArray(data.t)) { for(let i=0;i<data.t.length;i++) rows.push({t:data.t[i],o:data.o?.[i],h:data.h?.[i],l:data.l?.[i],c:data.c?.[i],v:data.v?.[i]}); }
    else if(Array.isArray(data)) rows.push(...data);
    else throw new Error('BtcTurk kline yanıt şeması beklenen formatta değil.');
    from=to; if(pauseMs) await sleep(pauseMs);
  }
  return withGaps(normalize(rows,'btcturk',nowMs,step),step,pages);
}
async function fetchParibu({symbol, interval, startMs, endMs, baseUrl='https://www.paribu.com', fetchFn=fetchWithRetry, pauseMs=100, nowMs=Date.now()}) {
  const step=INTERVAL_MS[interval], market=marketSymbol('paribu',symbol), rows=[];
  const resolutionMap={'1m':1,'5m':5,'15m':15,'30m':30,'1h':60,'4h':240,'1d':'1D','1w':'1W'};
  const resolution=resolutionMap[interval]; if (!resolution) throw new Error(`Paribu: desteklenmeyen mum aralığı ${interval}`);
  // Paribu chart/history is not documented as a stable public historical API. Try bounded chunks,
  // but reject unrecognized payloads instead of silently treating them as valid history.
  const chunkMs=Math.max(step*500, 20*DAY_MS); let from=startMs, pages=0;
  while(from<endMs && pages<1000) {
    const to=Math.min(endMs,from+chunkMs);
    const qs=new URLSearchParams({symbol:market,resolution:String(resolution),from:String(Math.floor(from/1000)),to:String(Math.floor(to/1000)),type:'basic'});
    const data=await getJson(`${baseUrl}/chart/history?${qs}`,fetchFn); pages++;
    const list=Array.isArray(data)?data:(Array.isArray(data?.data)?data.data:(Array.isArray(data?.candles)?data.candles:null));
    if (!list) throw new Error('Paribu chart/history uç noktası beklenen mum listesini döndürmedi; veri kaynağı doğrulanamadı.');
    rows.push(...list); from=to; if(pauseMs) await sleep(pauseMs);
  }
  const candles=normalize(rows,'paribu',nowMs,step);
  if (!candles.length) throw new Error('Paribu tarihsel mumları doğrulanamadı veya bu aralık için veri yok.');
  return withGaps(candles,step,pages);
}
function withGaps(candles,step,pages) { let gaps=0; for(let i=1;i<candles.length;i++) if(candles[i].t-candles[i-1].t!==step) gaps++; return {candles,gaps,pages}; }
function validCachedCandles(value, { exchange, symbol, interval, months, startMs, endMs, step }) {
  if (!value || value.exchange !== exchange || value.symbol !== symbol || value.interval !== interval || value.months !== months || !Array.isArray(value.candles) || !value.candles.length) return null;
  let previous = -Infinity;
  const candles = [];
  for (const c of value.candles) {
    if (!c || !Number.isSafeInteger(c.t) || c.t <= previous || c.t < startMs - WARMUP_CANDLES * step || c.t >= endMs ||
        ![c.o,c.h,c.l,c.c,c.v].every(n => Number.isFinite(n)) || c.o <= 0 || c.h < Math.max(c.o,c.c) || c.l > Math.min(c.o,c.c) || c.l <= 0 || c.v < 0 || c.h < c.l || c.t + step > endMs) return null;
    previous = c.t;
    candles.push({ t:c.t, o:c.o, h:c.h, l:c.l, c:c.c, v:c.v });
  }
  return candles;
}
async function loadCandlesFromExchange({exchange,symbol,interval,months,cacheDir,baseUrl,fetchFn,pauseMs,nowMs=Date.now(),refresh=false}) {
  if (!['okx','btcturk','paribu'].includes(exchange)) throw new Error(`Bilinmeyen alternatif borsa: ${exchange}`);
  const step=INTERVAL_MS[interval]; if(!step) throw new Error(`Desteklenmeyen mum aralığı: ${interval}`);
  const windowStartMs=nowMs-monthsToMs(months);
  const safe=`${exchange}-${marketSymbol(exchange,symbol).replace(/[^A-Z0-9_-]/gi,'_')}-${interval}-${months}m-${new Date(nowMs).toISOString().slice(0,10)}.json`;
  const file=cacheDir?require('path').join(cacheDir,safe):null;
  let candles=null,gaps=0,fromCache=false;
  if(file&&!refresh&&require('fs').existsSync(file)) {
    try {
      const x=JSON.parse(require('fs').readFileSync(file,'utf8'));
      candles=validCachedCandles(x,{exchange,symbol,interval,months,startMs:windowStartMs,endMs:nowMs,step});
      if(candles) { gaps=withGaps(candles,step,0).gaps; fromCache=true; }
    } catch { /* cache invalid/corrupt: fetch fresh data below */ }
  }
  if(!candles) {
    const args={symbol,interval,startMs:windowStartMs-WARMUP_CANDLES*step,endMs:nowMs,baseUrl,fetchFn,pauseMs,nowMs};
    const fn=exchange==='okx'?fetchOkx:exchange==='btcturk'?fetchBtcTurk:fetchParibu;
    const r=await fn(args); candles=r.candles; gaps=r.gaps;
    if(file&&candles.length){const fs=require('fs');fs.mkdirSync(cacheDir,{recursive:true,mode:0o700});atomicWriteFileSync(file,JSON.stringify({exchange,symbol,interval,months,fetchedAt:new Date(nowMs).toISOString(),gaps,candles}),{mode:0o600});}
  }
  if(!candles.length) throw new Error(`${exchange} ${symbol} ${interval}: mum verisi alınamadı.`);
  let startIndex=candles.findIndex(c=>c.t>=windowStartMs); if(startIndex<0)startIndex=candles.length;
  return {candles,startIndex,gaps,fromCache,windowStartMs};
}
module.exports={marketSymbol,normalize,fetchOkx,fetchBtcTurk,fetchParibu,loadCandlesFromExchange,validCachedCandles};
