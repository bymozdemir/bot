# Pre-Termux denetim raporu — v10

## Bu sürümdeki değişiklik

- Paper hesap quote birimi değiştiğinde (ör. USDT → TRY), pozisyon yokken yeni quote için başlangıç bakiyesi sıfırda kalmıyor. Paper hesabı `paperStartingBalance` ve yeni quote ile yeniden oluşturuluyor; önceki quote birimindeki sanal işlem geçmişi yeni hesaba taşınmıyor. Bu işlem bir döviz dönüşümü değildir.
- Değişiklik sonrası `server.js` sözdizimi kontrolü, `offlinePreflight`, `engine.test.js` ve `paperAuditFixes.test.js` başarılı.
- Test çalıştırıcısı `--groups group0,group1` ile grupları ayrı çalıştırabiliyor.

## Yeniden doğrulama

- group0: 122/122 geçti.
- group1: 78/78 geçti.
- group2: 115/115 geçti.
- group3: 157/157 geçti.
- group4: 254/254 geçti.
- group5: sunucu entegrasyon testi hariç 150/150 geçti.
- Toplam: 876 test başarılı; `serverIntegration.test.js` gerçek bağımlılıklar eksik olduğundan doğrulanamadı. Bu test geçilmiş sayılmamıştır.
- Paper motoru ve portföy fuzz betikleri önceki v9 adayında geçti; bu raporda değişen ayar rotası için gerçek HTTP entegrasyon testi yerine geçmez.
- JavaScript sözdizimi taraması ve offline preflight başarılı.

## Blokajlar / kapsam dışı doğrulamalar

- `npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=10000` bu ortamda npm hata verdi (`Exit handler never called!`). Önceki denemede npm registry DNS hatası da görülmüştü.
- `npm audit` güncel registry verisiyle tamamlanamadı; güvenlik taraması temiz olarak raporlanamaz.
- `serverIntegration.test.js` bağımlılıklar kurulamadığı için çalıştırılamadı.
- Gerçek borsa uç noktalarından 60 aylık tarihsel veri ve karşılaştırma henüz doğrulanmadı.
- Borsa bazında canlı emir kimliği/kurtarma sözleşmesi tam onaylı değildir. Canlı mod onayı verilmez; canlı kilidi kapalı tutulmalıdır.

## Karar

Bu sürüm, çevrimdışı kod denetimi ve paper-mode testleri için adaydır; tam final/Termux geçiş onayı değildir. Temiz bağımlılık kurulumu, entegrasyon testi, güncel audit ve gerçek veri karşılaştırması tamamlanmadan final onayı verilmemelidir.
