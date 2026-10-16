# Borsa adaptörleri denetimi — 2026-10-14

## Kapsam ve sınır

Bu denetim ZIP içindeki kod, mock tabanlı testler ve adaptör yetenek kayıtları üzerinden yapıldı. Bu ortamda borsa API anahtarlarıyla gerçek hesap/emir testi yapılmadı; gerçek borsa sunucularına uçtan uca doğrulama iddiası yoktur. Bu nedenle hiçbir adaptör yalnızca mock test geçti diye gerçek emirler için tam Green kabul edilmez.

## Durum tablosu

| Borsa | Piyasa verisi kod/test durumu | Canlı hesap/emir durumu | Karar |
|---|---|---|---|
| Binance | Mevcut adaptör ve hedefli testler mevcut | Özel API kodu var; gerçek hesap/testnet doğrulaması bu denetimde yapılmadı | Sarı — canlı doğrulama gerekli |
| Binance TR | Adaptör ve hedefli testler mevcut | REST emir yetenekleri kodda var; gerçek hesap doğrulaması yapılmadı; native trailing yok | Sarı — canlı doğrulama gerekli |
| BtcTurk | Adaptör ve hedefli testler mevcut | Özel API kodu var; gerçek hesap doğrulaması yapılmadı; native OCO/trailing doğrulanmış değil | Sarı — canlı doğrulama gerekli |
| Paribu | Public veri ve adaptör testleri mevcut | Emir kimliği/idempotency/kurtarma sözleşmesi tam doğrulanmadı; canlı işlem güvenli kabul edilmez | Kırmızı — canlı işlem kapalı kalmalı |
| Coinbase Exchange | Public adaptör var; yanıtlar mock ile test edildi | Özel hesap/emir API'leri bilerek kapalı | Sarı — yalnız public kapsamı, canlı emir yok |
| Kraken | Public adaptör var; yanıtlar mock ile test edildi | Özel hesap/emir API'leri bilerek kapalı | Sarı — yalnız public kapsamı, canlı emir yok |
| Bitstamp | Public adaptör var; yanıtlar mock ile test edildi | Özel hesap/emir API'leri bilerek kapalı | Sarı — yalnız public kapsamı, canlı emir yok |
| OKX | Public adaptör var; yanıtlar mock ile test edildi | Özel hesap/emir API'leri bilerek kapalı | Sarı — yalnız public kapsamı, canlı emir yok |
| OKX TR | OKX public adaptörünü kullanıyor; bölgesel hesap/ürün kapsamı gerçek sunucuda doğrulanmadı | Özel hesap/emir API'leri bilerek kapalı | Sarı/Kırmızı — bölgesel kapsam doğrulanmalı |
| Bybit TR | Adaptör ve mock testleri mevcut; host açıkça yapılandırılmadan ağ isteği engelleniyor | Özel API hostu ve ürün kapsamı doğrulanmadı; canlı emirler kapalı | Sarı — asgari kod sözleşmesi var, bölgesel API/ürün doğrulaması gerekli |
| Midas | Bot için resmî Spot API sözleşmesi doğrulanmadı; çağrılar fail-closed | Kapalı | Kırmızı — resmî API sözleşmesi gerekli |

## Bu denetimde yapılan kod düzeltmesi

`fetchAllTickers24h()` dönüşleri borsalar arasında aynı şemayı kullanmıyordu. Tarayıcı `quoteVolume` alanını beklerken Coinbase Exchange, Kraken, Bitstamp, OKX ve Bybit TR adaptörleri farklı alan adları döndürüyordu; bu adaptörlerden gelen pariteler hacim filtresinden sessizce elenebiliyordu. Bu adaptörlerin dönüşleri ortak alanlara normalize edildi:

- `symbol`
- `lastPrice`
- `changePct`
- `quoteVolume`
- `highPrice`
- `lowPrice`

Kraken tarafında `p[1]` ağırlıklı ortalama fiyat olarak yorumlanıyordu; artık yüzde değişim açılış ve son fiyatla hesaplanıyor. Bybit TR yüzde oranı yüzde değerine çevriliyor ve `turnover24h` mevcutsa quote hacmi olarak kullanılıyor. Bazı borsalarda quote hacmi, baz hacim × son fiyat ile yaklaşık hesaplanır; bu bir borsa tarafından doğrudan verilen kesin quote hacmi değildir.

## Test sonuçları

- Borsa adaptörleri, güvenlik kapıları ve yeni şema testleri: **65 geçti, 0 başarısız**.
- Altı izole test grubunun toplamı: **556 test; 555 geçti, 1 başarısız**. Tek başarısız test `test/serverIntegration.test.js`; `express`, `dotenv` ve `ws` bağımlılıkları eksik olduğu için gerçek sunucu entegrasyonu başlatılamadı.
- `npm ci` bu ortamda tamamlanmadı; çevrimdışı npm önbelleğinde `ws` paketi bulunmadı. Bu, test ortamı/bağımlılık kurulumu engelidir; sunucu entegrasyon testi başarıyla doğrulanmış sayılmaz.
- `npm run preflight`: başarılı; varsayılan mod `paper`, canlı işlem güvenlik kilidi kapalı.
- Gerçek borsa API'leri, API anahtarları, testnet emirleri ve gerçek hesap davranışları doğrulanmadı.

## Canlıya geçiş koşulu

API anahtarları yalnızca kullanıcının kendi cihazında, çekim izni kapalı ve mümkün olan en düşük işlem yetkisiyle kurulmalıdır. Önce salt-okunur API, sonra testnet/sandbox; emir oluşturma, sorgulama, iptal ve belirsiz POST kurtarma testleri ayrı ayrı geçmeden canlı emirler açılmamalıdır. OCO/trailing desteği doğrulanmadıysa bot bunu taklit etmemeli ve canlı başlangıcı engellemelidir.


## Ek denetim — GREEN etiketinin doğruluk düzeltmesi (2026-10-14)

Önceki `scripts/liveContractAudit.js`, `liveTradingVerified` alanı eksik/`undefined` olan eski adaptörleri GREEN sayabiliyordu. Bu, kod sözleşmesi ile sandbox/gerçek hesap kanıtını birbirine karıştırıyordu. Denetim artık GREEN için `liveTradingVerified === true` koşulunu açıkça arar; eksik doğrulama YELLOW, eksik güvenli kimlik/API sözleşmesi RED olur.

Binance, BtcTurk, Binance TR ve Paribu adaptörlerine açık `liveTradingVerified: false` eklendi. Böylece bayrağın yanlışlıkla eksik kalması nedeniyle eski adaptörlerin doğrulanmış gibi görünmesi engellendi; gerçek/sandbox kanıtı elde edilene kadar canlı başlangıç kilitli kalır. Bu bir API doğrulaması değildir.

Ek testler: borsa güvenlik/audit + yeni özel adaptör kapıları + LiveEngine/recovery/lifecycle + Stage 4 özel adaptör testleri **309/309 geçti**. Bu sonuç yalnızca seçili test grubudur; tam 76 dosyalık test paketi bu kod değişikliklerinden sonra yeniden tamamlanmış sayılmaz.

Güncel audit çıktısında Paribu ve Midas RED; diğer dokuz adaptör YELLOW görünür. YELLOW, kod sözleşmesinin asgari statik denetimden geçtiğini ama canlı doğrulamanın olmadığını söyler; gerçek hesapta çalıştığını kanıtlamaz. `liveTradingVerified` alanı açıkça `true` değilse (false veya eksik/undefined) hem `LiveEngine` hem `OrderManager` canlı başlangıcı/emri reddeder.


## Ek denetim — eksik doğrulama bayrağı (2026-10-14)

`LiveEngine` ve `OrderManager` önceden yalnızca `liveTradingVerified === false` durumunu reddediyordu; alanın eksik/undefined olması tek başına ret sebebi değildi. Her iki kapı da artık yalnızca `liveTradingVerified === true` olduğunda devam eder. Yeni regresyon testi, alanı eksik bir adaptörün iki katmanda da reddedildiğini doğrular. Bu düzeltme canlı doğrulama sağlamaz; tüm gerçek adaptörler kapalı kalır.


## Ek denetim — OKX SPOT emir miktarı kuralları (2026-10-14, adım 4)

OKX resmî V5 enstrüman belgesine göre SPOT `lotSz` ve `minSz` baz varlık miktarı cinsindedir; `maxMktSz` ise USDT cinsinden bildirilir. Önceki adaptör `maxMktSz` değerini `maxQty` olarak döndürüyordu. Canlı motor bunu baz miktarıyla karşılaştıracağından, bu alan birim uyuşmazlığı yaratıyordu. Adaptör artık `maxMktSz` değerini baz miktarı üst sınırı olarak kullanmıyor.

OKX public SPOT enstrüman yanıtında ayrı bir `minNotional` alanı bulunmadığından `minNotional: 0` tek başına “minimum kural yok” anlamına gelmez. Adaptör artık `minNotionalMode: 'quantity-only'` ile kuralın niteliğini açıkça işaretler. Canlı motor bu modu yalnızca `minQty` ve `stepSize` pozitifse kabul eder; diğer adaptörlerde eksik minimum emir tutarı eskisi gibi fail-closed davranır. Miktar adımı ve minimum miktar doğrulaması `validateMarketOrder` üzerinden devam eder.

Yeni regresyon testleri: OKX `minSz`/`lotSz` doğrulaması, `maxMktSz` birim ayrımı, miktar-altı emrin reddi ve motorun `quantity-only` moduna bağlı kapısı. İlgili dört test dosyası toplam **42/42 geçti**. Bu, gerçek OKX hesap/sandbox emir testi değildir; canlı işlem doğrulaması hâlâ kapalıdır.

## Ek denetim — Binance / Binance TR / BtcTurk emir kuralları (2026-10-14, adım 5)

Resmî sözleşmeler ve adaptör kodu karşılaştırıldı. Binance Spot `NOTIONAL` filtresinde minimum ve maksimum tutar için ayrı `applyMinToMarket` / `applyMaxToMarket` bayrakları bulunur; eski eşleme bunları tek `applyToMarket` alanı gibi ele alıyordu. Adaptörler artık iki bayrağı ayrı taşır ve market emri doğrulaması, borsanın market emirlerine uygulamadığı maksimum notional sınırını yanlışlıkla zorunlu tutmaz. `MIN_NOTIONAL` kullanan eski şema için `applyToMarket` korunur.

Binance, Binance TR ve BtcTurk sembol kuralları artık bilinen bir sembolün işlem dışı durumunu reddeder. Sembol yanıtı ilgili emir türlerini veriyorsa koruyucu stop desteği de sembol bazında hesaplanır: Binance için `STOP_LOSS`, Binance TR için numeric `STOP_LOSS` (3), BtcTurk için `STOP_MARKET`. Bir sembolün bilinen emir türleri botun kullandığı koruyucu stopu desteklemiyorsa `LiveEngine` alış emrinden önce canlı işlem kilidini kapatıp alış göndermeyi reddeder. Boş/eksik emir türü listesi destek kanıtı sayılmaz; gerçek/sandbox doğrulaması yerine geçmez.

Yeni regresyon testleri, `NOTIONAL` market bayrakları, işlem dışı semboller ve sembol bazlı stop desteği durumlarını kapsar. İlgili seçili test grubu **59/59 geçti, 0 başarısız, 0 atlanan**. Bu yalnızca mock/yerel testtir; borsa hesabında emir doğrulaması yapılmadı.

Adım 5 doğrulaması genişletilmiş birleşik hedefli test grubunda **145/145 geçti** (11 dosya, 0 atlanan). Tüm JavaScript dosyalarında `node --check` ve `scripts/offlinePreflight.js` başarılı. `scripts/liveContractAudit.js` beklenen RED bulguları nedeniyle 1 koduyla çıktı: Paribu ve Midas RED, dokuz adaptör YELLOW, GREEN yok. Tam test paketi, `npm ci`, `npm audit`, serverIntegration, `test:clock`, fuzz ve gerçek/sandbox emir doğrulaması tamamlanmış sayılmaz.

## Ek denetim — BtcTurk iptal sonucunu doğrulama (2026-10-14, adım 6)

BtcTurk resmî `Cancel an Order` belgesi, `DELETE /api/v1/order` için HTTP 200 yanıtının iptal isteğinin alındığını gösterdiğini; iptalin nihai sonucunun ayrı bir olayla bildirildiğini söylüyor. Adaptörün önceki davranışı DELETE yanıtını doğrudan üst katmana döndürüyordu. Bu yanıt `{success:true,data:{}}` gibi bir gövdeyse `OrderManager` durumu doğrulanmış iptal sayamıyordu. Bu güvenli tarafta kalıyor ama çıkış akışını kilitleyebiliyor; ayrıca DELETE yanıtı tek başına nihai iptal kanıtı değildir.

`BtcturkAdapter.cancelOrder()` artık DELETE isteğini yalnızca bir kez gönderir ve sonucu `CANCELED`, `FILLED`, `REJECTED` veya `EXPIRED` olana kadar en fazla sekiz salt-okunur `GET /order/{id}` sorgusuyla takip eder. GET hatası, iptal sonucunu belirsiz olarak işaretler; iptal isteği yeniden gönderilmez. Zaman aşımında son gözlenen `NEW`/`PARTIALLY_FILLED` durumu döner; `LiveEngine` yalnızca açıkça `CANCELED` durumunda market satışına geçebildiğinden, aktif veya belirsiz emir varken ikinci satış emri gönderilmez. İptal sırasında kısmi dolum varsa `executedQty` korunur ve üst katman mutabakat gerektirir.

Mock regresyon testleri: DELETE kabulünden sonra `Partial` → `Canceled` geçişi ve dolan miktarın korunması; ayrıca emir sekiz sorgu sonunda hâlâ `Untouched` ise `CANCELED` olarak sunulmaması. Bu testler gerçek BtcTurk hesabı veya WebSocket channel 452 doğrulaması değildir. BtcTurk canlı doğrulaması kapalı kalmalıdır.
