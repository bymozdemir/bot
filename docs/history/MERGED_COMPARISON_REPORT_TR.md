> **TARİHSEL GELİŞTİRME KAYDI — GÜNCEL TEST SONUCU DEĞİLDİR.** Bu dosya önceki bir geliştirme aşamasında alınmış sonuçları korur. Güncel Paper Final doğrulama kaydı: Termux üzerinde `npm run test:batched`, `EXIT_CODE=0`; **67/67 dosya, 526 test, 526 başarılı, 0 başarısız, 0 atlanan** (2026-10-13). Güncel durum için kök dizindeki `TEST_RESULTS_2026-10-13_TR.txt` dosyasını esas alın.

# Birleşik sürüm karşılaştırma raporu (Türkçe)

Tarih: 2026-10-12

## Karşılaştırılan dosyalar
- crypto-bot-v195-paper-final-candidate.zip
- crypto-bot-v195-noshadow.zip
- crypto-bot-v195-noshadow-reviewed.zip

## Birleştirme kararı
`paper-final-candidate` sürümü temel alındı. İncelenen üç arşivin dosya yolları ve içerik özetleri karşılaştırıldı. Bu temel sürüm, `noshadow` ve `noshadow-reviewed` sürümlerinde bulunan ortak dosyaları içeriyor; ayrıca aşağıdaki ek korumaları taşıyor. Çakışan dosyalar rastgele birleştirilmedi: daha yeni aday sürümdeki tam dosya seçildi, çünkü değişiklikler ilgili önceki sürümlere göre ek regresyon/güvenlik düzeltmeleri içeriyor.

## Korunan / tercih edilen iyileştirmeler
1. `execution.js`: `roundDownToStep()` geçersiz/negatif miktarı sıfıra indirir; kayan nokta toleransının sipariş miktarını bütçenin üstüne çıkarmaması için aşağı düzeltme yapar.
2. `paperEngine.js` ve `portfolioPolicy.js`: nakit rezervi üst sınırı %90; `closeOnDailyLoss` zorunlu güvenli davranışa taşınır.
3. `store.js`: eski kayıtlar yüklenirken `closeOnDailyLoss` güvenli değere migrate edilir.
4. `paperValuation.js`: sıfır/geçersiz son fiyatla açık pozisyonu sıfır değerlemek yerine geçerli giriş fiyatına geri döner; bu yalnızca koruyucu değerleme fallback'idir, piyasa fiyatı garantisi değildir.
5. `paperEngine.js`: log throttling enjekte edilen saat kaynağını kullanır.
6. `riskExit.js` ve `execution.js`: kâr koruma/break-even hesabı ortaklaştırılmıştır.
7. `paperValuation.js`: motor, risk API ve performans/zarar hesapları için ortak tasfiye özkaynağı yaklaşımı.
8. `instanceLock.js`: başka host/konteynerden kalmış olabilecek kilitleri otomatik silmeyen, sahiplik token'ı doğrulayan fail-closed davranış.
9. `fuzz_paper.cjs` / fuzz betikleri: gerçek BUY/SELL geçişlerinin sayılması ve işlem yolları çalışmazsa başarısızlık.
10. Üretim yolunda eski/sentetik zaman damgalarını otomatik geçerli sayan `syntheticClock` istisnalarının kaldırılması.
11. TRY/USDT quote bakiyelerinin ayrılması, ATR stop ve backtest değerleme tutarlılığı için aday sürümdeki düzeltmeler korunmuştur.

## Bu birleşik pakette doğrulananlar
- `node scripts/offlinePreflight.js`: BAŞARILI; varsayılan mod paper, canlı işlem kilidi kapalı.
- Değiştirilen ana JS modüllerinde `node --check`: BAŞARILI.
- `node --test test/paperValuation.test.js test/execution.test.js test/noShadowMigration.test.js`: 14/14 geçti.

## Tamamlanmamış doğrulamalar
- Bu çalışma ortamında `node_modules` yoktu; `npm ci` ve güncel çevrimiçi `npm audit` bu test koşusunda çalıştırılmadı.
- `test/serverIntegration.test.js` ve tam test paketi burada bu birleşik işlem sırasında çalıştırılmadı. Önceki raporlarda ağ/bağımlılık/zaman sınırı engelleri belirtilmişti; bunları başarılı test olarak saymıyoruz.
- Bu sonuçlar Termux üzerinde temiz kurulum ve gerçek API/HTTP/WebSocket smoke testinin yerine geçmez.

## Termux doğrulama sırası
```bash
npm ci
npm audit
npm run test:server-integration
npm test
npm run preflight
```

Testler tamamlanmadan canlı API anahtarı eklemeyin ve canlı işlem kilidini açmayın. Bu paket Paper adayıdır; canlı işlem için onay değildir.
