# Yeni borsalar — Stage 2 doğrulama ve güvenli kapılar

Bu sürüm yedi ayrı platform kaydını korur: Coinbase Exchange, Kraken, Bitstamp, OKX, OKX TR, Bybit TR ve Midas.

## Bu aşamada yapılanlar
- Kraken sembol normalizasyonunda BTC→XBT ve DOGE→XDG eşlemesi eklendi.
- Kraken'in `error` dizisi dolu olduğunda yanıtın başarılı/boş sonuç olarak yorumlanması engellendi.
- Bybit TR için doğrulanmamış bir varsayılan alan adına istek gönderilmesi engellendi. `BYBITTR_BASE_URL` yalnızca resmî ve bölgeye uygun uç nokta doğrulandıktan sonra ayarlanmalıdır.
- OKX TR için `https://tr.okx.com` varsayılanı kullanılır; bölgesel hesap/ürün uygunluğu ayrıca doğrulanmalıdır.
- Mock tabanlı piyasa verisi testleri eklendi; bu testler API anahtarı veya gerçek emir gerektirmez.
- Yedi yeni adaptörün tamamında özel hesap ve emir yetenekleri doğrulanmış olarak işaretlenmez; canlı emirler fail-closed durumundadır.

## Henüz tamamlanmayanlar
Bu, yedi platform için tam canlı işlem entegrasyonu değildir. Coinbase Exchange, Kraken, Bitstamp, OKX ve OKX TR'nin özel API imzalama, bakiye, emir oluşturma/sorgulama/iptal ve belirsiz emir kurtarma yolları bu aşamada etkinleştirilmemiştir. Bybit TR'nin resmî API alan adı ve ürün erişimi doğrulanmamıştır. Midas için botun kullanabileceği resmî kripto Spot API sözleşmesi doğrulanmamıştır. Bu platformların canlı işlem güvenliği `liveTradingVerified=false` kalır.

## Bu sürümde çalıştırılan testler
`node --test test/newExchangesSafety.test.js test/exchangeSafety.test.js test/exchangeCapabilitySafety.test.js test/mergeRegression.test.js`

Sonuç: 40 test geçti, 0 başarısız, 0 atlandı. Bu sonuç yalnızca belirtilen hedefli testler içindir; tüm proje test paketi veya gerçek borsa sunucularına uçtan uca doğrulama değildir.

Stage 3 resmî kaynak doğrulama notları ve özel API güvenlik kapısı testleri için `docs/NEW_EXCHANGES_STAGE3_TR.md` ve `test/newExchangesPrivateGate.test.js` dosyalarına bakın.
