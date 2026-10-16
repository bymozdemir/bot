# Yeni borsalar – Stage 1 (güvenli başlangıç)

Bu aşamada Coinbase Exchange, Kraken, Bitstamp, OKX, OKX TR ve Bybit TR adaptörleri registry/panel listesine eklendi ve halka açık piyasa verisi uçları yazıldı. Yeni adaptörlerde özel hesap/emir metotları bilinçli olarak fail-closed durumdadır; `clientOrderId`, bakiye, emir sorgulama ve canlı işlem kabiliyetleri doğrulanmış sayılmaz.

Midas için bu projede kullanılabilecek resmî kripto Spot API sözleşmesi doğrulanmadığından bir adaptör kaydı oluşturuldu ancak veri ve emir çağrıları açıkça reddedilir. `mid.as/api` adlı benzer isimli hizmet, Midas yatırım platformunun kripto alım-satım API'si olarak kabul edilmemelidir.

Bu sürüm tam canlı entegrasyon değildir. API uç noktaları, bölgesel erişim, sembol kuralları ve yanıt şemaları her borsanın resmî belgeleriyle ve mock testlerle ayrıca doğrulanmalıdır. Canlı emirler etkinleştirilmemiştir.
