'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withCloseConfirmation, parseArgs } = require('../scripts/compareLiveCandleBacktest');

function strategyWith(action) {
  return { id: 'fixture', defaultParams: {}, evaluate: () => ({ action, reason: 'fixture signal' }) };
}

test('historical proxy keeps BUY only when signal candle close confirms momentum', () => {
  const wrapped = withCloseConfirmation(strategyWith('buy'));
  const good = wrapped.evaluate({ candles: [{ t: 1, o: 100, h: 104, l: 99, c: 103 }] });
  assert.equal(good.action, 'buy');
  assert.match(good.reason, /tarihsel kapanış onayı/);
  const weak = wrapped.evaluate({ candles: [{ t: 1, o: 100, h: 101, l: 98, c: 100.01 }] });
  assert.equal(weak.action, 'hold');
  assert.match(weak.reason, /canlı mum filtresi/);
});

test('historical proxy does not alter SELL or HOLD decisions', () => {
  const candles = [{ t: 1, o: 100, h: 101, l: 99, c: 99.5 }];
  assert.equal(withCloseConfirmation(strategyWith('sell')).evaluate({ candles }).action, 'sell');
  assert.equal(withCloseConfirmation(strategyWith('hold')).evaluate({ candles }).action, 'hold');
});

test('comparison CLI rejects invalid periods and accepts supported parameters', () => {
  assert.throws(() => parseArgs(['--months', '61']), /1–60/);
  const opts = parseArgs(['--months', '12', '--symbols', 'BTC/USDT', '--tf', '1h', '--strategies', 'rsi_simple']);
  assert.equal(opts.months, 12);
  assert.equal(opts.exchange, 'binance');
  assert.deepEqual(opts.symbols, ['BTC/USDT']);
  assert.deepEqual(opts.tf, ['1h']);
  assert.deepEqual(opts.strategyIds, ['rsi_simple']);
});

test('comparison CLI accepts alternate exchanges and rejects unknown provider', () => {
  assert.equal(parseArgs(['--exchange','okx','--symbols','BTC/USDT']).exchange, 'okx');
  assert.equal(parseArgs(['--exchange','btcturk','--symbols','BTC/TRY']).exchange, 'btcturk');
  assert.equal(parseArgs(['--exchange','paribu','--symbols','BTC/TRY']).exchange, 'paribu');
  assert.throws(() => parseArgs(['--exchange','fake']), /--exchange/);
});
