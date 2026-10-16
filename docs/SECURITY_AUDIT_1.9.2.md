# 1.9.2 Güvenlik Denetimi ve Düzeltmeler

1.9.1 üzerinde yapılan denetimde bulunan sorunlar ve çözümleri. Her madde için `test/securityFixes191.test.js` içinde regresyon testi vardır.

| # | Bulgu | Düzeltme |
|---|-------|----------|
| 1 | `PATCH/DELETE /api/pairs/__proto__` → `Object.prototype` kirlenmesi | `pairFromParam`: `SYMBOL_RE` + `hasOwnProperty`; çift `decodeURIComponent` kaldırıldı |
| 2 | Politika kategorisi `constructor`/`toString` ile limitler atlanıyordu | `isValidBucketKey` + `hasOwn`; `__proto__` anahtarı atılır |
| 3 | Canlı modda `portfolioPolicy` değişikliği yeniden doğrulama istemiyordu; 50 sınırı 100'e aşılabiliyordu | `LIVE_RISK_KEYS`'e eklendi; politika üst sınırı 50; düz `maxConcurrentPositions` yaması artık politikaya yansır |
| 4 | Saat-geri koruması her sağlıklı turda sıfırlanıyordu (ölü kod) | `trackOutage` içindeki yanlış `lastTickAt = null` kaldırıldı |
| 5 | Min-notional yükseltmesi kategori sermaye sınırını aşıyordu | Politika kontrolü nihai tutarla yapılır |
| 6 | Paper'da günlük zarar/kill switch kapısı girişten önce yoktu | `entryRiskGate()` |
| 7 | `await` sırasında silinen parite için yetim pozisyon açılabiliyordu | Await sonrası parite kimliği yeniden doğrulanır |
| 8 | VPS compose: 8787 tüm arayüzlere + `TRUST_PROXY=true` → `X-Forwarded-For` ile giriş hız sınırı aşılıyordu | Loopback bağlama; `trust proxy` = tam N hop |
| 9 | `x-forwarded-proto` istemci tarafından taklit edilebiliyordu | Yalnızca Express `req.secure` (güvenilir proxy ile) |
| 10 | HTTPS'te çıplak `panel_session` çerezi kabul ediliyordu (cookie tossing) | HTTPS'te yalnızca `__Host-` çerezi |
| 11 | WebSocket upgrade'de Origin kontrolü yoktu | `sameOrigin` kontrolü |
| 12 | Docker HEALTHCHECK `/api/health` her zaman 401 alıyordu | `/api/health` kimliksiz minimal yanıt |
| 13 | Kasa: 6 karakter ana şifre, varsayılan scrypt, `.bak` içinde silinen anahtar, AAD yok, otomatik kilit yok | 12 karakter, scrypt N=2^17 (dosyada saklı, eski kasa otomatik yükselir), `.bak` temizliği, AAD, GCM etiket uzunluğu kontrolü, otomatik kilit |
| 14 | Env URL'leri (BtcTurk/Paribu/Binance WS/Telegram) doğrulanmıyordu | `hostGuard` allowlist |
| 15 | Çoklu süreç kilidi yoktu | `data/bot.lock` |
| 16 | `state.json` varsayılan izinle, tahmin edilebilir tmp adıyla yazılıyordu | 0600 + rastgele tmp adı + `wx` |
| 17 | Canlı modda çalışırken kill switch / işlem başı üst tutar 0 yapılabiliyordu | Reddedilir |
| 18 | Çok uzun periyotlu stratejiler (örn. `emaSlow` > ~240) sessizce hiç işlem yapmıyordu | `validateParams` reddeder |
| 19 | CSV formül enjeksiyonu, `/api/risk` eski `cash` alanı | Düzeltildi |
| 20 | Pakette artık dosyalar (`gt*`, `group*`, `batchlogs`) | Silindi; `.dockerignore` genişletildi |

## Bilerek değiştirilmeyenler / sizin yapmanız gerekenler
- **`package-lock.json` yok.** Ağ erişimi olmadan üretilemedi. Kendi makinende `npm install --package-lock-only` çalıştırıp dosyayı depoya ekle; Dockerfile varsa `npm ci` kullanır.
- Paper ↔ canlı bütçe hesabı farkı (bkz. `PORTFOLIO_POLICY_1.9.1.md`).
- Canlı başlangıç özkaynağı dış para giriş/çıkışlarına göre yeniden ayarlanmaz; para yatırıp çekersen risk limitleri kayar. Büyük transferlerden sonra hesabı sıfırla.
- Kapsam dışı kalan, okunmamış dosyalar: reconciliation, liveRecovery, userDataStream gövdesi, BtcTurk/Paribu/BinanceTR gövdeleri, backtest, shadowEngine. HTTP katmanı gerçek Express ile canlı test edilemedi (ağ yoktu); orada kod okuma + statik testler kullanıldı.
