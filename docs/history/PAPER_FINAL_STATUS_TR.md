> **TARİHSEL RAPOR — 2026-10-11.** Bu belge önceki geliştirme aşamasının sonuçlarını saklar; güncel 2.0.0-paper-final test sonucu değildir. Güncel kayıt için kök dizindeki `TEST_RESULTS_2026-10-13_TR.txt` dosyasına bakın.

# Paper Final — son doğrulama raporu

Tarih: 2026-10-11

## Bu turda uygulanan düzeltmeler

1. `roundDownToStep()` artık kayan nokta toleransı sebebiyle gerçek bütçeden daha büyük miktar döndürmüyor. Negatif/geçersiz miktar sıfıra indiriliyor; tam adım katlarında kayan nokta gürültüsü korunarak düzeltiliyor.
2. Paper değerleme, panelin `paperEquityByAsset` alanı ve `/api/risk` aynı tasfiye değeri yaklaşımını kullanıyor: nakit + açık pozisyonların tahmini satış değeri, çıkış kayması ve komisyon düşülerek. TRY/USDT gibi kasalar birbirine eklenmiyor.
3. Sıfır/bozuk son fiyat, açık pozisyonu sıfır fiyatla değerlemiyor; son fiyat geçerli değilse giriş fiyatına geri dönüyor. Bu yalnızca raporlama/koruyucu fallback; gerçek piyasa fiyatı yerine geçmez.
4. Kâr koruma stopu hesaplaması strateji risk çıkışı ve PaperEngine arasında ortaklaştırıldı.
5. Kayan nokta gürültüsünün koruyucu SELL stopunu bir tick aşağı yuvarlaması düzeltildi; stop fiyatı tickSize'a göre normalize ediliyor.
6. Günlük zarar limitinde motor dururken pozisyonları stop izlemesiz bırakabilecek eski `closeOnDailyLoss=false` seçeneği kaldırıldı: UI'da zorunlu gösteriliyor ve eski kayıtlar yüklenirken `true` değerine taşınıyor. Canlı motor da risk duruşunda pozisyon kapatmayı dener.
7. Paper modunda açık pozisyon varken o paritenin strateji, parametre veya mum aralığı değiştirilemiyor.
8. `/api/analytics` ve `/api/backtest/quick` mum verisi doğrulamasını, borsa kasa desteği kontrolünü ve backtest sermaye/komisyon/kayma sınırlarını uyguluyor.
9. Portföy rezerv üst sınırı tekleştirildi (%90); pozisyon sayısı üst sınırı API ve motor arasında eşitlendi (100).
10. Tekrarlanan stats normalizasyon satırı kaldırıldı; log throttling enjekte edilen saat kaynağını kullanıyor.
11. Eski `shadow` modu ve `closeOnDailyLoss=false` içeren kayıtların güvenli Paper varsayılanlarına taşınması için regresyon testi eklendi.

## Test sonuçları

- JavaScript/CJS sözdizimi: **137/137 başarılı**.
- Çevrimdışı ön kontrol: **başarılı**; varsayılan mod Paper, canlı işlem kilidi kapalı.
- Test grupları 0–4: **439/439 başarılı**.
- Test grubu 5, `serverIntegration.test.js` hariç: **75/75 başarılı**.
- Toplam izole test sonucu: **514 başarılı**.
- Gerçek sunucu entegrasyon testi: **çalıştırılamadı**; ortamda `express`, `dotenv`, `ws` kurulu değil. `npm ci` sırasında npm kayıt sunucusuna erişim/DNS zaman aşımı oldu. Bu test atlanmadı; eksik bağımlılık nedeniyle açıkça başarısız oluyor.
- Güncel çevrimiçi `npm audit`: **tamamlanamadı**; ağ erişimi gerekli. Çevrimdışı audit sonucu güncel güvenlik denetimi yerine geçmez.
- Termux üzerinde gerçek başlatma ve tarayıcı/WebSocket smoke testi: **kullanıcı cihazında ayrıca yapılmalı**.

## Onay durumu

Bu paket Paper modu için kod ve regresyon düzeltmeleri içerir; canlı işlem kilidi kapalıdır. Bununla birlikte gerçek HTTP/WebSocket sunucu entegrasyonu ve güncel bağımlılık güvenlik denetimi bu çalışma ortamında tamamlanamadığından, bu rapor **tam dağıtım doğrulaması** iddiasında bulunmaz.

Termux'ta proje kökünde çalıştırılacak son doğrulama:

```bash
npm ci
npm audit
npm run test:server-integration
npm test
npm run preflight
npm start
```

Sunucu entegrasyonu ve testler geçmeden canlı API anahtarı eklenmemeli veya canlı işlem kilidi açılmamalıdır.
