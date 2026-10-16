# 2.0.8 denetim raporu (2026-10-14)

Kapsam: Stage 3 → Stage 4B birleşik paket (2.0.7). Yeni yedi borsa: Coinbase Exchange, Kraken, Bitstamp, OKX, OKX TR, Bybit TR, Midas. Canlıya açılabilen dört eski borsa da kapsandı: Binance, BTCTurk, Binance TR, Paribu.
Doğrulama gerçek borsaya bağlanmadan, sahte `fetch` ile yapıldı; borsa davranışının kanıtı değildir.

## Bulgular ve düzeltmeler

| # | Önem | Bulgu | Düzeltme | Kanıt |
|---|---|---|---|---|
| B1 | Yüksek | Emir isteğine HTTP 200 + `null` gövde dönünce TypeError `unknownOutcome` işaretsiz kalıyor; OrderManager emri REJECTED sayıyor (tekrar gönderme / çift emir riski). 9 adaptör etkilenmişti. | `privateBase._send` null/nesne-olmayan gövdeyi belirsiz sayar; `orderGuards.guardCreate` istek sonrası TypeError/RangeError/SyntaxError'u `unknownOutcome` yapar. | `orderResponseGuards.test.js` (adaptör başına + OrderManager uçtan uca) |
| B2 | Yüksek | Binance, BTCTurk, Binance TR: HTTP 200 + `{}`, `[]`, bozuk JSON veya emir kimliksiz gövde "emir kabul edildi" sayılıyordu. | `guardCreate`: emir kimliği zorunlu; yanıttaki clientOrderId/yön uyuşmazsa belirsiz sonuç. | aynı dosya |
| B3 | Orta | Geçersiz girdi ağa çıkıyordu: sıfır/negatif miktar, çok küçük (`"0"` olurdu), 1e21 (`"1e+21"`), `true` (=1), `hold` yönü, Binance/BTCTurk/Binance TR'de clientOrderId'siz emir. | `validateOrderArgs` / `validatePositivePrice` ağdan önce reddeder; `plain()` sıfıra yuvarlamayı ve üssel gösterimi reddeder; `positiveNumber` boolean/dizi reddeder. | aynı dosya |
| B4 | Orta | `npm run test:batched` başlamıyordu (4 test dosyası, 83 test grup listelerinde yoktu). | Dosyalar listelere eklendi. | `TOTAL: files=76/76` |
| B5 | Düşük | Sürüm tutarsızlığı: package.json 2.0.7; README/FINAL_VERSION/lock 2.0.5; bir belge 2.0.6. | 2.0.8'e eşitlendi. | — |

Davranış değişikliği: BTCTurk koruyucu stop emri artık clientOrderId olmadan gönderilmez.

## Temiz çıkanlar (kusur bulunmadı)
- Emir gönderen çağrılar tekrar denenmiyor; zaman aşımı/5xx/ağ hatası belirsiz sonuç sayılıyor (6 yeni adaptör).
- Canlı kilit üç katmanlı: `liveEngine` borsa izin listesi, `liveTradingVerified=false`, OrderManager kapısı.
- `liveEngine.tick()` `busy` bayrağı + `epoch` ile çift tick'i engelliyor.
- Boş veya ters (crossed) emir defteri market emrini reddediyor.
- Paper ve canlı motor mum serisini doğruluyor; NaN fiyat işlenmiyor.
- Aynı clientOrderId ile ikinci emir gönderilmiyor (OrderManager `reused`).

## Bilinen sınırlar / yapılmadı
- İmza, zaman damgası ve sembol eşleştirmesi canlı borsa belgelerine karşı doğrulanmadı; yalnızca mevcut mock testleri ve saldırı testleri.
- Yeniden başlatma, saat sınırı ve eşzamanlılık için yeni test yazılmadı; mevcut paket (chaos/liveRecovery/stress) kullanıldı.
- Genel veri (ticker/mum/defter) bozuk yanıtlarda bazı adaptörler okunaksız TypeError fırlatıyor; para riski yok (tick atlanır), yalnızca hata mesajı kalitesi.
- `fetchSymbolRules` bozuk yanıtta sıfır kurallar döndürebilir (Coinbase, Kraken); canlı kilitli olduğu için etkisiz.
- Midas: resmi API sözleşmesi yok. Paribu: `identity=false` açık; canlıda kullanılmamalı.
- `npm ci`, `npm audit`, serverIntegration çalıştırılamadı (ağ kapalı).

## Tarihsel veri kaynağı genişletmesi — alternatif borsalar

Karşılaştırma betiğine `--exchange` seçeneği eklendi:
- `binance`: mevcut Binance klines veri yolu.
- `okx`: OKX `/api/v5/market/history-candles` sayfalaması; yalnızca `confirm=1` kapanmış mumlar tutulur.
- `btcturk`: BtcTurk `graph-api.btcturk.com/v1/klines/history`; `from/to` tarih aralığı parçalara bölünür ve saniye zaman damgaları milisaniyeye normalize edilir.
- `paribu`: Paribu `chart/history` için deneysel adaptör. Bu uç noktanın tarihsel kapsamı/şeması resmî, kararlı bir kamu API sözleşmesi olarak doğrulanmadığı için yanıt şeması tanınmazsa test hata verir; veriyi sessizce kabul etmez.

Örnekler:
```sh
node scripts/compareLiveCandleBacktest.js --exchange okx --months 60 --symbols BTC/USDT --tf 1h,4h --out data/backtest-okx
node scripts/compareLiveCandleBacktest.js --exchange btcturk --months 60 --symbols BTC/TRY --tf 1h,4h --out data/backtest-btcturk
node scripts/compareLiveCandleBacktest.js --exchange paribu --months 60 --symbols BTC/TRY --tf 1h,4h --out data/backtest-paribu
```

Ağ/DNS erişimi bu çalışma ortamında başarısız olduğundan, alternatif uç noktalardan gerçek 60 aylık veri indirimi henüz doğrulanmadı. Yerel normalizasyon/CLI testleri geçti. Borsalar arası fiyat/likidite/ücret farkları nedeniyle getiriler doğrudan aynı veri gibi karşılaştırılmamalı; aynı borsa içindeki filtre açık-kapalı karşılaştırması ana ölçümdür.
