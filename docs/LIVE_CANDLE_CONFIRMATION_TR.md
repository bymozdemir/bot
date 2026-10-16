# Canlı mum doğrulaması — paper aşaması

Bu sürüm, mevcut kapanmış-mum strateji BUY sinyaline ek olarak oluşmakta olan mumun yönünü ve fiyatın mum aralığındaki konumunu kontrol eder. Varsayılan olarak açıktır (`settings.liveCandleConfirmation !== false`); `false` verilirse eski davranış korunur.

BUY sinyali yalnızca şu koşulların tümü sağlanırsa uygulanır:
- oluşan mum ve gözlenen fiyat mevcut/geçerli olmalı;
- gözlenen fiyat mum açılışının üzerinde olmalı;
- gövde en az %0,02 pozitif olmalı;
- fiyat, mumun yüksek-düşük aralığının en az %55'inde olmalı.

Bu, bir sonraki mumun yönünü tahmin etmez ve kârlılık garantisi değildir. Kısa vadeli geri dönüşleri veya hızlı yükselişten sonra gelen geri çekilmeleri kaçırabilir; bazı kötü girişleri de engelleyemeyebilir. Bu ilk uygulama, borsanın mevcut mum verisi ve gözlenen fiyatla çalışan bir filtre olup ayrı bir WebSocket trade/taker-buy akışını henüz kullanmaz. Bu yüzden gerçek tick düzeyinde alım-satım baskısı ölçümü değildir.

Yalnızca BUY girişini etkiler. Satış sinyalleri, stop-loss, trailing/profit-protection ve acil risk çıkışları bu filtreyi beklemez. Onaylanmayan sinyal o kapanmış mum için tüketilir; aynı mum boyunca geç onay alıp fiyatı kovalamaz.

## Doğrulama durumu
- `test/liveCandleConfirmation.test.js`: 4/4 geçti.
- `node --check src/paperEngine.js`: geçti.
- `node scripts/offlinePreflight.js`: geçti.
- `node scripts/runTests.js`: bu ortamda zaman sınırına ulaştı; çıktı en az 548 başarılı teste kadar geldi, fakat tamamlanmış toplam özet alınamadı. Tam test paketi PASS olarak raporlanamaz.
- Bu değişiklik için henüz kârlılık kanıtı yok. Önce aynı geçmiş veri üzerinde filtre açık/kapalı karşılaştırmalı backtest, ardından en az bir haftalık paper koşusu gerekir.
