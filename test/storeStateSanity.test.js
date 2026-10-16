const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('store.load normalizes malformed history containers and rejects unknown mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-store-sanity-'));
  try {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      settings: { mode: 'paper' },
      paper: { trades: 'x', equityHistory: {}, costs: [], stats: null, positions: {}, cashByAsset: {} }
    }));
    const code = `process.env.BOT_DATA_DIR=${JSON.stringify(dir)}; const s=require('./src/store').load(); console.log(JSON.stringify({trades:Array.isArray(s.paper.trades),equityHistory:Array.isArray(s.paper.equityHistory),costs:Array.isArray(s.paper.costs),stats:!!s.paper.stats,mode:s.settings.mode}));`;
    const r = spawnSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(out.trades, true);
    assert.equal(out.equityHistory, true);
    assert.equal(out.costs, false);
    assert.equal(out.stats, true);
    assert.equal(out.mode, 'paper');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
