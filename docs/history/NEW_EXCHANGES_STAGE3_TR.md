# Yeni borsalar — Stage 3: API sözleşmesi ve özel işlem doğrulama planı

## Resmî kaynaklardan doğrulananlar (2026-10-14)

### Bybit TR
- Bybit TR Yardım Merkezi'nin "Alım-Satım API'sine Giriş" sayfası API'nin piyasa verisi, hesap yönetimi, emir oluşturma ve iptal işlemlerini desteklediğini ve API dokümantasyonuna bağlantı verdiğini belirtir.
- Bybit TR'nin API anahtarı rehberi ana ağ API yönetimi ile testnet API yönetimi sayfalarını ayrı gösterir.
- Bu kaynaklar Bybit TR API ürününün varlığını doğrular; ancak mevcut adaptörde kullanılacak REST/WS host adının ve Bybit TR hesap/ürünleri için geçerli endpoint kapsamının kodla doğrulanması hâlâ gerekir. Global Bybit hostu otomatik olarak Bybit TR hostu kabul edilmemelidir.
- Kaynaklar: https://www.bybit.tr/tr-TUR/help-center/article/Introduction-to-Trading-API ; https://www.bybit.tr/en-TR/help-center/article/How-to-create-your-API-key

### Midas
- Midas'ın resmî yasal duyuruları Midas Kripto Varlık Alım Satım Platformu A.Ş.'yi kripto varlık hizmet sağlayıcısı olarak belirtir.
- Bu araştırmada genel kullanıma açık, bot entegrasyonuna yönelik resmî kripto Spot REST/WebSocket API belgesi, endpoint tablosu veya sandbox dokümanı bulunamadı. Bu, özel/partner API bulunmadığının kanıtı değildir.
- Midas'tan yazılı olarak API kullanılabilirliği, erişim koşulları, sandbox, bakiye/açık emir/emir geçmişi, emir gönderme/iptal ve idempotency/kurtarma sözleşmesi istenmelidir.
- Kaynak: https://www.getmidas.com/yasal-duyurular/ ; destek: https://www.getmidas.com/destek/

## Midas'a gönderilecek destek talebi

Merhaba,

Midas Kripto hesabım için kendi hesabım adına çalışan bir alım-satım botu geliştirmek istiyorum. Üçüncü taraf uygulamaların kullanabileceği resmî bir kripto Spot API veya partner API'si mevcut mu?

Varsa güncel API dokümantasyonunu ve erişim başvuru sürecini paylaşabilir misiniz? Özellikle şu özelliklerin desteklenip desteklenmediğini öğrenmek istiyorum:
- piyasa verisi ve işlem çiftleri/işlem kuralları,
- hesap bakiyesi ve kullanılabilir bakiye,
- açık emirler ve emir geçmişi,
- emir oluşturma, sorgulama ve iptal,
- istemci tarafından belirlenen emir kimliği veya idempotency,
- zaman aşımından sonra emrin kabul edilip edilmediğini güvenli biçimde tespit etme,
- testnet/sandbox ve test API anahtarları.

API erişimi yalnızca yetkili ve resmî yöntemle sağlanacaksa ilgili şartları da paylaşmanızı rica ederim.

Teşekkürler.

## Her platform için doğrulama sırası

1. Resmî belge ve doğru host/ürün/ülke kapsamı.
2. Kimlik doğrulama imzası ve saat toleransı; ilk test salt-okunur.
3. Bakiye ve kullanılabilir bakiye alanlarının anlamı.
4. Emir oluşturma: zorunlu alanlar, miktar adımı, minimum tutar, ücret varlığı ve istemci kimliği.
5. Emir sorgulama: exchange order ID ile sorgu ve durum geçişleri.
6. İptal: dolmuş/kısmen dolmuş/iptal edilemez emir davranışı.
7. Belirsiz sonuç: POST sonrası timeout/bağlantı kesilmesi; yeniden POST atmadan önce sorgulama/kurtarma.
8. Yeniden başlatma: kayıtlı kimlikle emir durumunu uzlaştırma.
9. Sandbox testleri ve mock hata testleri ayrı raporlanır.
10. Her platformda canlı işlem kapısı ancak tüm gerekli sözleşme ve davranış kanıtları tamamlanınca değerlendirilebilir.

## Mevcut Stage 3 sınırı

Coinbase Exchange, Kraken, Bitstamp, OKX ve OKX TR adaptörleri bu sürümde genel piyasa verisi adaptörleridir; özel hesap/emir metotları bilerek kapalıdır. Bybit TR'nin resmî API belgeleri mevcut olsa da bu kodda kullanılacak bölgesel REST hostu doğrulanana kadar özel uç noktalar etkinleştirilmez. Midas'ın bot entegrasyonuna yönelik resmî API sözleşmesi doğrulanana kadar adaptör kapalı kalır.

Bu aşamadaki testler, yanlışlıkla canlı işlem yeteneği ilan edilmediğini ve kapalı metotların güvenli biçimde reddettiğini doğrular; gerçek borsa sunucularında uçtan uca entegrasyon kanıtı değildir.
