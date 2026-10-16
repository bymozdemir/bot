// Prevent two bot processes from writing the same state directory.
// Fail closed for stale, malformed, or foreign-host locks: PID values are not
// comparable across hosts/containers and automatic unlinking can permit split brain.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function acquireInstanceLock(dataDir, { pid = process.pid, host = os.hostname() } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'bot.lock');
  const token = crypto.randomBytes(16).toString('hex');
  const record = { pid: Number(pid), host: String(host), startedAt: new Date().toISOString(), token };
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
    catch (e) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(file); } catch {} throw e; }
    fs.closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let cur;
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch {
      throw new Error(`Süreç kilidi dosyası bozuk; güvenlik için otomatik silinmedi. Botların durduğunu doğrulayıp elle kaldır: ${file}`);
    }
    const sameHost = cur && String(cur.host || '') === String(host);
    const alive = sameHost && pidAlive(cur.pid);
    const detail = !sameHost ? `başka host/container (${cur.host || 'bilinmiyor'})` : alive ? `pid ${cur.pid}` : `eski olabilecek pid ${cur.pid}`;
    throw new Error(`Bu veri klasörü kilitli (${detail}). Paylaşılan volume'da çakışmayı önlemek için kilit otomatik devralınmaz. Diğer botun kesin durduğunu doğrula, sonra yalnızca ${file} dosyasını elle kaldır.`);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cur.token === token && cur.pid === record.pid && cur.host === record.host) fs.unlinkSync(file);
    } catch { /* Never remove a lock that cannot be verified as ours. */ }
  };
  process.once('exit', release);
  return { file, release, token };
}
module.exports = { acquireInstanceLock, pidAlive };
