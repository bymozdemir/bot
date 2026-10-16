# Paper Mode Audit Fixes

Bu paket, 1.8.2 FINAL-HARDENED üzerine yalnızca Paper Mode davranışını iyileştiren düzeltmeleri içerir.

## Düzeltilenler

1. Aktif quote asset artık `settings.quoteAsset` ile belirlenir; `exchange.quoteAssets[0]` otomatik olarak kasa kabul edilmez.
2. TRY ve USDT başlangıç bakiyeleri birbirinin kopyası olarak oluşturulmaz.
3. Günlük zarar referansı yeni günün ilk başarılı piyasa fiyatları toplandıktan sonra sabitlenir.
4. İlk yeni-gün BUY kararı da doğru yeni-gün `dayStart` equity'sini kullanır.
5. `budgetPct`, kalan nakdin yüzdesi olarak küçülmez; 30/30/30 hedefleri ortak kasa üzerinden korunur. `budgetPct=100` mevcut kullanılabilir nakdi tamamen kullanma davranışını korur.
6. Paper state'teki `stopPrice`, motorun fiilen kullandığı kâr koruma/trailing seviyesini yansıtacak şekilde senkronize edilir.
7. Trailing stop, kâr koruma eşiği aktive olmadan önce yanlışlıkla break-even tabanına zorlanmaz.
8. Veri toplama ve işlem değerlendirme iki aşamaya ayrıldı; gün değişiminde parite işlem sırası day-start bütçesini değiştiremez.

## Doğrulama

- Full test suite: **407/407 PASS**
- Offline preflight: **PASS**
- Backtest ↔ Paper parity: **7/7 strateji PASS**
- Paper Mode regression suite: **7/7 PASS**

## Kapsam

Bu paket gerçek borsaya emir gönderme doğrulaması değildir. Gerçek API/testnet/gerçek para sözleşme testleri sonraki aşamadır.
