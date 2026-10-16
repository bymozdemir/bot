# 1.9.3 Güvenlik Denetimi (gerçek sunucuya saldırı turu)

Bu turda `server.js` gerçekten çalıştırılıp HTTP/WebSocket üzerinden saldırıldı (Express davranışı, ağ olmadığı için bir test shim'iyle
taklit edildi; gerçek Express ile `npm test` çalıştırınca `test/serverIntegration.test.js` aynı kontrolleri yeniden yapar).

## 1.9.2'de bulunan REGRESYONLAR (önceki turda benim eklediğim düzeltmelerden)
| # | Sorun | Düzeltme |
|---|-------|----------|
| R1 | WebSocket Origin kontrolü **doğru** Origin'i de reddediyordu: `sameOrigin` ham `upgrade` isteğinde olmayan `req.get`'i çağırıp TypeError'u yutuyordu. Tarayıcı her zaman Origin gönderdiği için panelin canlı akışı çalışmazdı | `req.headers.host` kullanılır |
| R2 | `isSecureRequest` yalnızca `req.secure`'a bakıyordu; ham upgrade isteğinde bu alan yok → HTTPS proxy arkasında WS oturumu `__Host-` çerezini bulamıyordu | Ham istekte `TRUST_PROXY=true` ise `X-Forwarded-Proto` kabul edilir; guvenilmeyen proxy'de başlık yine yok sayılır |
| R3 | `hostGuard` allowlist'i `server.js`'in env→`opts` yolunu kapsamıyordu; **Binance TR** hiçbir kontrolden geçmiyordu | `buildExchange` içinde tüm env URL'leri `URL_ALLOW` ile doğrulanır |

## Yeni bulgular
| # | Bulgu | Kanıt | Düzeltme |
|---|-------|-------|----------|
| 1 | Panel şifre doğrulaması `scryptSync` ile olay döngüsünü bloke ediyordu (kimliksiz DoS) | 16 paralel yanlış giriş sırasında `/api/ping` 3 ms → **1353 ms** | Async scrypt, eşzamanlılık 2 + kuyruk 6, taşınca 503; sonuç: 26 ms |
| 2 | Async doğrulamada "başarısızlığı say" mantığı paralel patlamayla delinir | tasarım analizi | Deneme doğrulamadan **önce** sayılır, başarıda sıfırlanır; `Retry-After` eklendi |
| 3 | WebSocket `maxPayload` 100 MiB: tek 60 MB mesaj RSS'yi 60 → 194 MB yaptı; bağlantı sayısı sınırsız | canlı ölçüm | `maxPayload: 1024`, en çok 16 istemci, istemci mesajı bağlantıyı kapatır (RSS 75 MB) |
| 4 | Kullanıcı veri akışı: abonelik yanıtı gelmezse/el sıkışma takılırsa `start()` sonsuza dek bekler, `connecting` kilitli kalır | kod analizi + birim test | `handshakeTimeout` 10 sn, abonelik zaman aşımı 15 sn |
| 5 | Kasaya sınırsız boyutlu API anahtarı kaydedilebiliyordu (1 MiB okuma sınırını aşıp kasayı kilitler) | 200 KB anahtar kabul edildi | 8-512 karakter, boşluksuz yazdırılabilir ASCII |
| 6 | Politikada sınırsız kategori (5000 kabul edildi) | canlı | En çok 20 |
| 7 | Borsaya giden pahalı GET uçları (preflight/backtest/candles/scanner/analytics) sınırsızdı; canlı botla aynı IP kotasını paylaşır | kod analizi | Oturum başına 60/dk, preflight 6/dk (429 + Retry-After) |
| 8 | `/api` yanıtlarında `Cache-Control` yoktu | canlı | `no-store` |
| 9 | HTTP zaman aşımları gevşekti (slowloris) | canlı | headers 10 sn, request 30 sn, kontrol aralığı 2 sn. `maxConnections` denendi ve **bilerek kullanılmadı** (400 yarım bağlantı meşru erişimi de kesti) |
| 10 | Oran sınırlayıcı anahtar haritası sınırsız büyüyebilirdi; oturum sayısı sınırsızdı | kod analizi | 5000 anahtar sınırı + periyodik temizlik; en çok 20 oturum |
| 11 | `OrderManager`: `__proto__`/`constructor` clientOrderId'li emir (Binance bu karakterlere izin verir) `Object.prototype`'i "mevcut emir" sayardı | birim test | `hasOwn` + ayrılmış adların reddi |
| 12 | systemd unit: `User=%i` şablon olmayan unit'te boş genişler → **root olarak çalışırdı**; `WantedBy=default.target` kullanıcı modu ile karışıktı | dosya analizi | Sistem unit'i (ayrıcalıksız `cryptobot`, tam sandbox) + ayrı kullanıcı unit'i |
| 13 | Docker konteyneri sertleştirilmemişti | dosya analizi | `read_only`, `cap_drop: ALL`, `no-new-privileges`, `pids_limit`, `mem_limit` |

## Doğrulananlar (saldırı denendi, sorun çıkmadı)
Kimliksiz 20 rota 401 · 12 middleware atlatma denemesi (büyük/küçük harf, `//`, `%00`, `..`) başarısız · path traversal yok ·
`__proto__`/`constructor` pair rotaları 404 · CSRF (yabancı/null/alt alan/port farkı Origin) 403 · `text/plain` ve form gövdesiyle CSRF işlemez ·
çerez tohumlama reddedildi · `X-Forwarded-Proto` taklidi etkisiz · canlı modda eski oturumla tüm risk anahtarları, kasa, pair işlemleri 428 ·
bozuk/1 MiB+/zararlı-KDF'li kasa dosyasında panel ve süreç ayakta · ağ yokken bot çökmeden outage yönetiyor.

## Sizin yapmanız gerekenler / bilinen sınırlar
- **`package-lock.json` yok** (ağ yok). Dockerfile bu yüzden bilerek derlemeyi reddeder: `npm install --package-lock-only` çalıştırıp dosyayı ekleyin.
- Doğrudan erişilebilen bir portta `TRUST_PROXY=true` kullanmak `X-Forwarded-For` taklidine izin verir (denendi). Portu yalnızca loopback'e bağlayın (compose.vps böyle).
- Canlı başlangıç özkaynağı dış para giriş/çıkışlarına göre yeniden ayarlanmaz; paper ↔ canlı bütçe hesabı farkı sürüyor (bkz. PORTFOLIO_POLICY dokümanı).
- BtcTurk OHLC çözünürlüğü adaptör yorumlarında "doğrulanmadı" olarak işaretli; canlıya almadan önce gerçek hesapla doğrulayın.
- Okunmayanlar: `backtest/*`, `shadowEngine`, `simulatedExchange`, indikatör/strateji matematiği (yalnızca güvenlik örüntüsü taraması yapıldı).
