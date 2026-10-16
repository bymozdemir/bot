'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { marketSymbol, normalize } = require('../src/backtest/multiExchangeData');

test('exchange symbols map to native market identifiers', () => {
  assert.equal(marketSymbol('okx','BTC/USDT'),'BTC-USDT');
  assert.equal(marketSymbol('btcturk','BTC/TRY'),'BTCTRY');
  assert.equal(marketSymbol('btcturk','BTC/USDT'),'BTCUSDT');
  assert.equal(marketSymbol('paribu','BTC/TRY'),'btc_tl');
});

test('OKX normalization keeps only closed, valid candles', () => {
  const now = 2000000000000;
  const rows = [
    ['1999996400000','100','105','99','104','12','0','0','1'],
    ['1999992800000','100','105','99','104','12','0','0','0'],
    ['1999989200000','100','98','99','97','12','0','0','1']
  ];
  const out = normalize(rows,'okx',now,3600000);
  assert.equal(out.length,1);
  assert.equal(out[0].c,104);
});

test('BtcTurk normalization converts seconds to milliseconds and drops forming candles', () => {
  const now = 2000000000000;
  const rows = [
    {t:1999996400,o:100,h:105,l:99,c:104,v:12},
    {t:1999999999,o:100,h:105,l:99,c:104,v:12}
  ];
  const out = normalize(rows,'btcturk',now,3600000);
  assert.equal(out.length,1);
  assert.equal(out[0].t,1999996400000);
});

test('cached history rejects mismatched metadata, malformed candles, and non-monotonic timestamps', () => {
  const { validCachedCandles } = require('../src/backtest/multiExchangeData');
  const opts = { exchange:'okx', symbol:'BTC/USDT', interval:'1h', months:12, startMs:1000000000000, endMs:1000007200000, step:3600000 };
  const good = { exchange:'okx', symbol:'BTC/USDT', interval:'1h', months:12, candles:[
    {t:1000000000000,o:100,h:105,l:99,c:104,v:10},
    {t:1000003600000,o:104,h:106,l:103,c:105,v:12}
  ] };
  assert.equal(validCachedCandles(good, opts).length, 2);
  assert.equal(validCachedCandles({...good, exchange:'paribu'}, opts), null);
  assert.equal(validCachedCandles({...good, candles:[...good.candles].reverse()}, opts), null);
  assert.equal(validCachedCandles({...good, candles:[{...good.candles[0], h:90}]}, opts), null);
});
