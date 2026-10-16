# Stage 4 — Özel API kodu, kurtarma testleri ve kanıt planı

**Canlı işlem hâlâ KAPALI.** Bu sürüm hiçbir borsayı canlıya hazır ilan etmez.
Gerçek borsa sunucularına bağlanılmadı (ağ erişimi yoktu); testler mock tabanlıdır ve borsa davranışının kanıtı değildir.

## Durum tablosu

| Borsa | Önceki | Şimdi | Kalan engel |
|---|---|---|---|
| BtcTurk | Yeşil | Yeşil (kod) | Canlı kimlik sözleşmesi testi (aşağıdaki plan) |
| Paribu | Kırmızı | Kırmızı | İstemci kimliği yok. `orderId` alan hatası düzeltildi; kurtarma danışma amaçlı kanıt üretir, otomatik sahiplenmez |
| Coinbase Exchange | Kırmızı | Sarı | Sandbox/gerçek hesap kanıtı |
| Kraken | Kırmızı | Sarı | Gerçek hesap kanıtı |
| Bitstamp | Kırmızı | Sarı | Gerçek hesap kanıtı. Stop = stop-limit satış (`stop_price`, resmî belge); stop-market satış parametresi kesinleşmediği için kullanılmaz |
| OKX | Kırmızı | Sarı | Demo/gerçek hesap kanıtı |
| OKX TR | Kırmızı | Sarı | `tr.okx.com` resmî belgede doğrulandı; TR'ye özgü davranış kanıtı yok |
| Bybit TR | Kırmızı | Sarı | `api.bybit.tr` resmî belgede doğrulandı; hesap türü (UNIFIED/SPOT) ve spot stop emri kanıtı yok |
| Midas | Kırmızı | Kırmızı | Resmî API sözleşmesi yok; `docs/MIDAS_API_REQUEST_TR.md` |

Sarı = kod sözleşmesi tam, `liveTradingVerified=false`. `node scripts/liveContractAudit.js` bunu gösterir.

## Güvenlik kapıları (üç katman)
1. Adaptörler `liveTradingVerified=false` ilan eder.
2. `OrderManager.assertLiveCapability` ve `LiveEngine` başlatması bu bayrak false ise reddeder.
3. `LiveEngine` bilinmeyen borsa kimliklerini zaten reddeder (yalnızca binance/binancetr/btcturk/paribu).
Canlıya almak için üçünün de bilinçli, kanıtlı değişikliği gerekir.

## Ortak tasarım kuralları
- Emir POST/DELETE istekleri asla otomatik tekrar denenmez. Ağ hatası, zaman aşımı, 5xx, çözümlenemeyen yanıt => `unknownOutcome`.
- Mükerrer istemci kimliği hatası emrin zaten var olabileceği anlamına gelir => `unknownOutcome`.
- "Emir bulunamadı" (`orderNotFound`) hiçbir borsada "emir yok" kanıtı sayılmaz; emir UNKNOWN kalır. Gerekçeler: Coinbase eşleşmesiz iptal kayıtlarını tutmayabilir; Bitstamp kapalı emirleri 30 gün; OKX dolmamış iptalleri kısa süre saklar.
- İptal çağrısı başarılı olsa bile durum sorgulanır; hâlâ açık görünüyorsa UNKNOWN döner (CANCELED varsayılmaz).
- Botun kimliği borsa biçimine deterministik çevrilir: Coinbase/Kraken/Bitstamp UUID, OKX 32 hex, Bybit olduğu gibi (≤36, `[A-Za-z0-9_-]`).
- Env ile gelen URL host allowlist'inden geçer (imzalı istek başka sunucuya sızmasın).
- Miktar sözleşmesi: yeni adaptörlerde market AL/SAT miktarı baz varlıktır (Bybit için `marketUnit=baseCoin` gönderilir).

## Doğrulanan resmî kaynaklar (2026-10-14)
- Bybit TR: V5 rehberi "Turkey users: use https://api.bybit.tr". (Eski bir zh-TW sayfa `api.bybit-tr.com` yazıyor; güncel İngilizce rehber esas alındı.)
- OKX TR: tr.okx.com/docs-v5 "REST: https://tr.okx.com". Sayfa önbelleği eski görünüyor; salt-okunur betikle doğrulayın.
- Kraken: `cl_ord_id` AddOrder/CancelOrder/OpenOrders/ClosedOrders (değişiklik günlüğü 2024). İmza örnek vektörü testte birebir eşleşiyor.
- Coinbase Exchange: `client_oid`, `client:` önekiyle sorgu/iptal; 404 uyarısı belgede var.
- Bitstamp: `client_order_id`, `order_status` id veya client_order_id ile, hata 400.019.
- OKX: `clOrdId` alfanümerik ≤32 (kodda hex'e çevrilir) — bu kısıt bilgi birikiminden; ilk canlı/demo çağrıda doğrulayın.

## Kanıt toplama (sizin yapmanız gereken adımlar)
1. Salt-okunur anahtar oluşturun (ticaret/çekim yetkisi YOK). Sonra:
   `KRAKEN_API_KEY=... KRAKEN_API_SECRET=... node scripts/exchangeReadonlyAudit.js kraken BTC/USD`
   (Coinbase/OKX için `<ID>_API_PASSPHRASE` de.) JSON çıktısını `docs/evidence/<borsa>-readonly-<tarih>.json` olarak saklayın.
2. Sandbox/demo: Coinbase `COINBASEEXCHANGE_BASE_URL=https://api-public.sandbox.exchange.coinbase.com`, OKX `OKX_SIMULATED=1` (demo anahtarı). Kraken ve Bitstamp spot sandbox sunmaz; asgari tutarlı gerçek test gerekir.
3. Asgari tutarlı emir testi (her borsa için, bir kez): market AL (borsanın minimum tutarı) → `getOrder(null, cid)` ile yalnızca istemci kimliğiyle sorgu → FILLED ve miktar/komisyon doğru mu → koruyucu stop kur → `fetchOpenOrders` içinde görünüyor mu → iptal et → durum CANCELED mı → bakiyeyi sat/temizle.
4. Kanıt dosyası + bu adımların kaydı tamamlanınca, kod incelemesiyle o adaptörde `liveTradingVerified` kaldırılır ve `LiveEngine` izin listesine ayrı bir `ALLOW_<BORSA>_TRADING` kilidi eklenir. Bu sürüm bunu yapmaz.

## BtcTurk canlı doğrulama planı
Salt-okunur: `node scripts/exchangeReadonlyAudit.js btcturk BTC/TRY` (bakiye, açık emir şeması, kuralların `stepSize`/`minNotional` değerleri, 1h mum aralığı).
Emirli (asgari tutar): market AL → yanıt ve `getOrder` içinde `newOrderClientId`/`orderClientId` geri dönüyor mu? → `fetchOpenOrders` şemasında kimlik var mı → `stopMarket` SATIŞ kur, açık emirlerde göründüğünü doğrula, iptal et → pozisyonu kapat. İstemci kimliğinin gerçekten geri döndüğü kanıtlanmadan BtcTurk "doğrulandı" sayılmamalı.

## Paribu
- Düzeltilen hata: adaptör yalnızca `exchangeOrderId` döndürüyordu; `OrderManager` ve `AccountReconciler` `orderId` okuduğu için emir kimliği yerel kayda `null` yazılabilirdi. Artık ikisi de döndürülür.
- `captureRecoverySnapshot` + `assessUnknownOrder`: POST öncesi/sonrası açık emir ve bakiye karşılaştırması. Sonuç `NO_EVIDENCE | LIKELY_PRESENT | LIKELY_FILLED_OR_MANUAL | AMBIGUOUS`; `autoAdopt` daima false. Bu kanıt operatör içindir, motoru etkinleştirmez. Motor entegrasyonu (POST öncesi anlık görüntüyü çağırma) bilerek yapılmadı, çünkü Paribu canlı kapalı.
- Paribu'dan resmî olarak istenmesi gereken: istemci emir kimliği alanı veya geçmiş emir sorgusu.

## Düzeltme turu (aynı gün)
- Kasa artık API passphrase saklıyor (AAD'li şifreleme, eski kasa yükseltmesinde korunur). `POST /api/vault/keys` Coinbase Exchange/OKX/OKX TR için passphrase zorunlu kılar, diğerlerinde reddeder. Arayüze alan eklendi. Ortam değişkeni (`<ID>_API_PASSPHRASE`) yedek olarak çalışır.
- `fetchAllTickers24h` artık tarayıcının okuduğu `quoteVolume/lastPrice/changePct/highPrice/lowPrice` alanlarını döndürür (eski anahtarlar da duruyor). Kraken pair adları `AssetPairs.wsname` ile eşlenir; eşlenemeyen pair listeye alınmaz. Coinbase'te toplu endpoint olmadığı için en çok 60 ürün, 5 eşzamanlı çağrı.
- Bitstamp koruyucu stop eklendi (stop-limit satış). Stop-limit, boşluklu düşüşte dolmayabilir; limit varsayılanı stop fiyatının %1 altı.
- Eski `docs/EXCHANGE_CAPABILITY_MATRIX.md` güncellendi.

## Bilinen sınırlar
- Bybit TR spot koşullu emir (`orderFilter=StopOrder`) ve hesap türü, OKX algo durumları (`effective` => UNKNOWN), Coinbase/Bitstamp stop-limit sapması (%1 varsayılan) gerçek hesapta doğrulanmadı.
- Zaman damgası/nonce toleransı olan borsalarda (Bybit recv_window 5 sn, Coinbase, OKX) sunucu saati kayıksa istekler reddedilir. Bu güvenli yöndedir ama otomatik saat eşitleme yok.
- Ticker `quoteVolume` değeri TRY/EUR paritelerinde USDT'ye çevrilmez (BtcTurk'te de böyle); tarayıcı eşiği (5M) bu paritelerde kaba kalır.
- Server entegrasyon testi bu ortamda çalıştırılamadı (bağımlılıklar yok); `server.js` değişiklikleri yalnızca sözdizimi denetimiyle doğrulandı.
