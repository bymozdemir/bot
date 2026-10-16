# Telegram bildirim paketi birleştirme denetimi

Tarih: 2026-10-15

## Birleştirilenler
- Telegram komutları: pozisyon kâr/zarar, günlük/haftalık rapor, işlem geçmişi, coin başına karar gerekçeleri, ayarlar/log görüntüleme ve fiyat sorgusu.
- İstanbul saat dilimi yardımcıları ve günlük/haftalık rapor zamanlayıcısı.
- İşlem açılış/kapanış, günlük zarar eşiği, kill switch, stop yakınlığı ve veri kesintisi uyarı izleyicisi.
- Mesajlarda mod/borsa etiketi ve Telegram için yeni testler.

## Birleştirme koruması
Telegram ZIP'indeki `server.js`, v10 sürümünden farklı olarak kasa birimi değişince paper hesabını yeniden oluşturan güvenlik düzeltmesini içermiyordu. Bu düzeltme birleştirme sırasında korundu ve geri eklendi. Böylece TRY/USDT kasa geçişi sonrası yüzde bazlı risk kontrollerinin sıfır başlangıç bakiyesiyle etkisiz kalması önlenmeye devam ediyor.

## Testler
- Yeni Telegram/uyarı/rapor ve mevcut Telegram komut testleri: 54/54 başarılı.
- Resmî grup3 çalıştırması: 14 test dosyası, 202/202 test başarılı.
- Tüm test dosyaları ayrı Node süreçlerinde: 90 dosya, 922 test; 921 başarılı, 1 başarısız, 0 atlanan. Tek başarısız test `test/serverIntegration.test.js`: `express`, `dotenv`, `ws` bağımlılıkları ortamda kurulu olmadığından gerçek HTTP/WebSocket entegrasyonu doğrulanamadı.
- JavaScript sözdizimi: 180/180 başarılı.
- `offlinePreflight`: başarılı; varsayılan mod paper ve canlı işlem kilidi kapalı.
- `paperFuzz`: 1.000.000 adım başarılı; 17.280 saatlik kaos senaryosu başarılı.
- `portfolioPolicyFuzz`: 1.000.000 adım başarılı.

## Henüz doğrulanmayanlar
- Ağ/DNS erişimi olmadığı için temiz `npm ci`, güncel `npm audit` ve gerçek sunucu entegrasyonu tamamlanamadı.
- Gerçek borsa API'lerinden tarihsel veri çekimi ve 60 aylık karşılaştırma henüz doğrulanmadı.
- Telegram mesajları gerçek bir Telegram botu/chat ile uçtan uca denenmedi; token eklenmeden önce Paper modda test edilmelidir.

## Güvenlik kararı
Bu paket yalnızca paper test adayıdır. Canlı işlem kilidi kapalı tutulmalıdır. Telegram komutları alım/satım emri vermez; `/basla` ve `/bitir` yalnızca Paper motoru için tasarlanmıştır.
