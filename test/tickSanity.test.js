const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCandleSeries } = require('../src/execution');
test('sifir ve negatif fiyatli mum reddedilir', () => {
  const T = 3600000;
  for (const px of [0, -5]) {
    const c = [{ t: 0, o: 100, h: 100, l: 100, c: 100, v: 1 }, { t: T, o: px, h: px, l: px, c: px, v: 1 }];
    assert.throws(() => validateCandleSeries(c, '1h'), /pozitif/);
  }
});

test('telegram: grup chat_id ise yabanci gonderen komut veremez', async () => {
  const { createTelegramCommands } = require('../src/telegramCommands');
  let stops = 0;
  const b = createTelegramCommands({
    env: { TELEGRAM_BOT_TOKEN: '1:T', TELEGRAM_CHAT_ID: '-1001234567890' }, logger: { log() {}, warn() {} },
    fetchFn: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }),
    getStatus: () => ({ mode: 'paper', running: true }), startBot: async () => {}, stopBot: async () => { stops++; },
    listStrategies: () => [], timeframes: ['1h'], validateTimeframe: () => null, getLogs: () => [],
  });
  assert.equal(await b.processUpdate({ message: { chat: { id: -1001234567890 }, from: { id: 666 }, text: '/bitir' } }), false);
  assert.equal(stops, 0);
});

test('telegram: ozel sohbette (from.id == chat.id) komut calisir', async () => {
  const { createTelegramCommands } = require('../src/telegramCommands');
  let stops = 0;
  const b = createTelegramCommands({
    env: { TELEGRAM_BOT_TOKEN: '1:T', TELEGRAM_CHAT_ID: '42' }, logger: { log() {}, warn() {} },
    fetchFn: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }),
    getStatus: () => ({ mode: 'paper', running: true }), startBot: async () => {}, stopBot: async () => { stops++; },
    listStrategies: () => [], timeframes: ['1h'], validateTimeframe: () => null, getLogs: () => [],
  });
  await b.processUpdate({ message: { chat: { id: 42 }, from: { id: 42 }, text: '/bitir' } });
  assert.equal(stops, 1);
});

test('telegram: grupta yalnızca TELEGRAM_ALLOWED_USER_IDS içindeki kullanıcı komut çalıştırır', async () => {
  const { createTelegramCommands } = require('../src/telegramCommands');
  let stops = 0;
  const b = createTelegramCommands({
    env: { TELEGRAM_BOT_TOKEN: '1:T', TELEGRAM_CHAT_ID: '-1001234567890', TELEGRAM_ALLOWED_USER_IDS: '777, 888' },
    logger: { log() {}, warn() {} },
    fetchFn: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }),
    getStatus: () => ({ mode: 'paper', running: true }), startBot: async () => {}, stopBot: async () => { stops++; },
    listStrategies: () => [], timeframes: ['1h'], validateTimeframe: () => null, getLogs: () => [],
  });
  assert.equal(await b.processUpdate({ message: { chat: { id: -1001234567890, type: 'supergroup' }, from: { id: 666 }, text: '/bitir' } }), false);
  assert.equal(await b.processUpdate({ message: { chat: { id: -1001234567890, type: 'supergroup' }, from: { id: 777 }, text: '/bitir' } }), true);
  assert.equal(stops, 1);
});
