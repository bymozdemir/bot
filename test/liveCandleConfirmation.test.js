'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { confirmBuy } = require('../src/liveCandleConfirmation');

test('live candle confirmation accepts strengthening bullish candle', () => {
  assert.equal(confirmBuy({ candle: { o: 100, h: 104, l: 99, c: 103, v: 100 }, observedPrice: 103 }).ok, true);
});
test('live candle confirmation rejects bearish / weakening price below open', () => {
  const r = confirmBuy({ candle: { o: 100, h: 103, l: 97, c: 99, v: 100 }, observedPrice: 98.9 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /açılışının altında/);
});
test('live candle confirmation rejects weak body and missing data', () => {
  assert.equal(confirmBuy({ candle: { o: 100, h: 101, l: 99, c: 100.01 }, observedPrice: 100.01 }).ok, false);
  assert.equal(confirmBuy({ candle: null, observedPrice: 100 }).ok, false);
});
test('live candle confirmation rejects malformed OHLC and flat range', () => {
  assert.equal(confirmBuy({ candle: { o: 100, h: 99, l: 98, c: 99 }, observedPrice: 100 }).ok, false);
  assert.equal(confirmBuy({ candle: { o: 100, h: 100, l: 100, c: 100 }, observedPrice: 100 }).ok, false);
});

test('live candle confirmation rejects ticker price outside reported candle range', () => {
  const r = confirmBuy({ candle: { o: 100, h: 103, l: 98, c: 102 }, observedPrice: 104 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /aralığı dışında/);
});
