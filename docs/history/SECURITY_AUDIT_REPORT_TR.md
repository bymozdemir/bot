> **TARİHSEL GELİŞTİRME KAYDI — GÜNCEL TEST SONUCU DEĞİLDİR.** Bu dosya önceki bir geliştirme aşamasında alınmış sonuçları korur. Güncel Paper Final doğrulama kaydı: Termux üzerinde `npm run test:batched`, `EXIT_CODE=0`; **67/67 dosya, 526 test, 526 başarılı, 0 başarısız, 0 atlanan** (2026-10-13). Güncel durum için kök dizindeki `TEST_RESULTS_2026-10-13_TR.txt` dosyasını esas alın.

# Güvenlik Denetimi — al-sat-bot 1.9.2

## Kapsam
- ZIP içindeki JavaScript dosyalarında sözdizimi kontrolü
- Mevcut Node.js test takımı
- Çevrimdışı ön kontrol
- Paper işlem ve portföy politikası fuzz testleri
- Canlı borsa sözleşmesi/güvenlik yeteneği kontrolü
- Kimlik doğrulama, kasa dosyası/KDF, HTTP/WS girişleri ve güvenli varsayılanların statik incelemesi

## Yapılan değişiklikler
1. `src/vault.js`: Kasa dosyasından okunan scrypt KDF parametreleri artık yalnızca desteklenen iki konfigürasyondan biri olabilir (N=16384 veya N=131072, r=8, p=1). Böylece değiştirilmiş/bozulmuş JSON ile aşırı CPU/RAM tüketimi tetiklenmesi engellenir.
2. `src/vault.js`: Salt alanı 16 baytlık geçerli Base64 olarak doğrulanıyor; parola biçimi sınırlandırılıyor.
3. `src/vault.js`: Kimlik bilgileri dosyası JSON ayrıştırılmadan önce normal dosya ve en fazla 1 MiB boyut koşuluna tabi tutuluyor.
4. `test/vaultKdfSafety.test.js`: Aşırı KDF parametreleri ve fazla büyük kasa dosyası için regresyon testleri eklendi.

## Test sonuçları
- JavaScript sözdizimi: geçti.
- `node scripts/offlinePreflight.js`: geçti; varsayılan mod `paper`, canlı işlem kilidi kapalı.
- `npm test`: 456 test geçti, 0 başarısız.
- `node scripts/paperFuzz.js`: 1.000.000 adım ve 17.280 saatlik simüle kaos koşusu tamamlandı, süreç 0 koduyla çıktı.
- `node scripts/portfolioPolicyFuzz.js`: 1.000.000 adım tamamlandı, süreç 0 koduyla çıktı.
- `node scripts/liveContractAudit.js`: Paribu için `identity=false` nedeniyle kırmızı sonuç. Bu, adaptörün clientOrderId/deterministik kurtarma yeteneği doğrulanmadığı için kasıtlı fail-closed davranıştır; gerçek borsa sözleşmesi doğrulanmadan canlı işlem izni verilmemelidir.

## Tamamlanamayan doğrulamalar / kalan riskler
- Bağımlılık kurulumu bu denetim ortamında zaman aşımına uğradı. Bu nedenle `scripts/apiPreflight.js` çalıştırılamadı; `npm audit` da mevcut `package-lock.json`/shrinkwrap dosyası olmadığı için çalışmadı. ZIP'te lockfile yoktur. Dağıtımdan önce güvenilir ağ ortamında `npm install`, `npm audit` ve API ön kontrolü çalıştırılmalı; üretilen lockfile sürüm kontrolüne eklenmelidir.
- Gerçek borsa API'sine bağlanma, canlı emir gönderme/iptal etme, anahtar izinleri ve borsa tarafındaki güncel davranışlar bu ortamda gerçek hesapla doğrulanmadı. Canlı işlem kilidi kapalı tutulmalıdır.
- Hiçbir otomatik veya statik test “tüm açıkların kesin olarak giderildiğini” ispatlayamaz. Bu rapor, kapsamı belirtilen kontrollerin sonucudur; bağımsız profesyonel penetrasyon testi yerine geçmez.


## 1.9.2 güvenlik düzeltme turu (2026-10-09)

Bu turda aşağıdaki değişiklikler yapıldı:

- `src/exchanges/paribu.js`: Paribu emir kurtarma artık sembol/yön/miktar benzerliğine bakarak emir sahiplenmiyor. Adaptörün doğrulanmış bir `clientOrderId` round-trip sözleşmesi bulunmadığından `findOrderForRecovery()` güvenli biçimde `null` döndürüyor. Paribu canlı işlem yeteneği kapalı kalmalı.
- `test/paribuApi.test.js`: Tek bir benzer aday bulunduğunda bile otomatik sahiplenmenin engellendiğini doğrulayan regresyon testi eklendi.
- `server.js`: `TRUST_PROXY=true` olduğunda `TRUST_PROXY_HOPS` yalnızca 1–5 arası pozitif tam sayı kabul ediyor; hatalı veya beklenmeyen ayarlarla uygulama başlatılmıyor.
- `Dockerfile`: Lockfile yokken değişken bağımlılıklarla `npm install` yapılması yerine, açık hata mesajıyla derleme durduruluyor ve `npm ci` kullanılıyor.

### Bu turda doğrulananlar

- `node --check server.js`: başarılı.
- `node --check src/exchanges/paribu.js`: başarılı.
- `node --test test/paribuApi.test.js test/exchangeCapabilitySafety.test.js`: 12 test geçti.

### Henüz tamamlanamayanlar

Bu çalışma ortamında `registry.npmjs.org` DNS çözümlemesi `EAI_AGAIN` ile başarısız olduğundan `package-lock.json` üretilemedi; `npm audit`, tam bağımlılık kurulumu ve gerçek HTTP penetrasyon testleri çalıştırılamadı. Docker imajı lockfile eklenene kadar kasıtlı olarak derlenmeyecektir. Ağ erişimi olan güvenilir geliştirme ortamında `npm install --package-lock-only`, ardından `npm ci` ve `npm audit` çalıştırılmalı; lockfile incelenip bu ZIP'e eklenmelidir.

Bu değişiklikler tam güvenlik sertifikası veya canlı işlem onayı değildir. Paribu canlı yeteneği kapalı kalmalı; gerçek borsa emirleriyle test yapılmamalıdır.
