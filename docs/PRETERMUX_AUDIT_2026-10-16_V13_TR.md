# Pre-Termux Audit v13 (2026-10-16)

## Değişiklik
- Telegram özel sohbet yetkilendirmesi ile grup/süpergrup yetkilendirmesi ayrıldı.
- Grup sohbetlerinde `TELEGRAM_ALLOWED_USER_IDS` içinde bulunmayan kullanıcıların komutları reddedilir. Chat ID, kullanıcı ID'si olarak kullanılmaz.
- README'ye grup yetkilendirme ayarı eklendi.
- Yetkisiz grup kullanıcısı ve izinli grup kullanıcısı senaryoları test edildi.

## Doğrulananlar
- JavaScript syntax: 181/181 dosya başarılı.
- Hedefli Telegram/notify/preflight testleri: 49/49 başarılı.
- Backtest test dosyası ayrı çalıştırmada: 16/16 başarılı.
- `paperFuzz.js`: 1.000.000 adım başarılı; kaos simülasyonu 17.280 saat.
- `portfolioPolicyFuzz.js`: 1.000.000 adım başarılı.
- Offline preflight: başarılı; varsayılan mod Paper, canlı işlem kilidi kapalı.

## Açık doğrulamalar
- Tam `runTestsBatched.js` çalıştırması bu ortamın 300 saniyelik çalışma sınırına ulaştı; tam paket için yeni toplam sonuç üretilmedi.
- `serverIntegration.test.js` gerçek bağımlılıklarla ayrıca doğrulanmalı (`npm ci` ve ağ erişimi gerekir).
- Güncel `npm audit`, gerçek borsa bağlantıları ve 60 aylık gerçek veri karşılaştırması bu ortamda tamamlanmadı.

Bu rapor canlı işlem onayı değildir. Canlı işlem güvenlik kilidi kapalı kalmalıdır.
