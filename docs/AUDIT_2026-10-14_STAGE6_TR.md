# 2.0.9 düzeltme notu (2026-10-14)

Kaynak: paperEngine.js denetim bulguları. Her madde için regresyon testi `test/paperAuditFixes2.test.js` içindedir
(düzeltmeden önceki kodda başarısız olduğu doğrulandı). Chaos testine (`paperRedTeam4`) muhasebe değişmezi eklendi.

| # | Bulgu | Düzeltme |
|---|-------|----------|
| 1 | Paritesi silinen açık pozisyon izlenmiyor | `_tick` artık `state.paper.positions` içindeki sahipsiz pozisyonları da gezer (yalnızca stop izlenir, strateji sinyali uygulanmaz). Fiyat, stop ve kill switch güncel veriyle çalışır. |
| 1b | `DELETE /api/pairs/:symbol` closePosition sonucuna bakmıyor | Satış başarısızsa parite SİLİNMEZ, 409 döner. `?force=true`: eskimiş ama mevcut son fiyattan satmayı kullanıcı onaylar. |
| 2 | Takılan fetch botu kilitliyor | `fetchCandles` / `fetchSymbolRules` için zaman aşımı (varsayılan 20 sn, `settings.fetchTimeoutMs`, 1–120 sn). `stop()` busy kilidini bırakır; busy kilidini yalnızca onu açan tick kapatır; 10 dk'dan uzun takılan tick için watchdog. |
| 3 | Break-even stop zarara satıyor | Tampon artık komisyon+kaymadan hesaplanır: `(1+fee)/((1-slip)(1-fee)) - 1` + %0.05 pay. Pozisyonda `breakEvenBufferPct` olarak saklanır; paper motor, backtest ve strateji aynı değeri kullanır. Eski kayıtlar `ensureState` ile tamamlanır. |
| 4 | Sembolde `/` yoksa her tur çöküyor | `pairSupported` güvenli; bozuk/null parite kaydı yalnızca kendini atlatır, diğer pozisyonlar izlenmeye devam eder. |
| 5 | Son fiyat yokken giriş fiyatından satış | `closePosition`/`closeAll` fiyatsız veya eskimiş (3 poll / en az 3 dk) fiyatla satmaz. |
| 6 | Başarısız satışta sinyal tüketiliyor | `sellAt` sonucu kontrol edilir; pozisyon açık kalır, SELL sinyali ve stop mumu sonraki turda yeniden denenir. |
| 7 | Veri kesintisinde zarar limitleri atlanıyor | Limitler kesintide de değerlendirilir. Taze fiyatlı pozisyonlar kapanır; verisiz pozisyon eski fiyattan satılmaz ve motor durdurulmaz (aksi halde stop izlemesi biterdi). Kesintiden sonra stop taraması, son taranan muma kadar yeterli mum ister (en fazla 1000). |
| 8 | Kill switch yarım kalabilir | Kilit diske yazılamasa bile RAM'de uygulanır; `closeAll` bir pozisyonda hata alsa da diğerlerini dener. |
| 9 | Paper dolum iyimser | Varsayılan DEĞİŞMEDİ (backtest ile birebir eşleşme `parity.test.js` ile korunur). İsteğe bağlı: `settings.paperConservativeFill=true` → alım/satım, açılış ile gözlenen fiyatın kötüsünden dolar. |

Değişmeyenler: her işlem ~%0.30 maliyetlidir (strateji kenar payı bunu aşmalı); canlı motor (`liveEngine.js`) bu sürümde
dokunulmadı, onun break-even tamponu hâlâ eski %0.20 varsayılanını kullanır. Canlı işlem onaylı değildir.

## 2.0.10 — ikinci tur (ortak katman ve kalıcı kayıt)

| # | Bulgu | Düzeltme |
|---|-------|----------|
| 10 | `fetchWithRetry` zaman aşımı sayacını başlıklar gelince durduruyordu; sunucu gövdeyi yarıda bırakırsa `res.json()` sonsuza dek asılıyordu (TÜM borsa adaptörleri, canlı motor dahil). Yerel sunucuyla kanıtlandı. | Gövde, sayaç açıkken tamponlanır; aynı arayüz (status/headers/json/text) korunur. Test: `test/httpBodyTimeout.test.js`. |
| 11 | `state.json` bozuk ve `.bak` yoksa varsayılana dönülürken kill switch kaydı, açık pozisyon ve emir defteri sessizce siliniyordu. | Bot KILITLI başlar (kilit nedeni panelde görünür). `null`/dizi gibi geçerli ama durum olmayan JSON da yedek yoluna gider. |

Gözden geçirilip değişiklik gerektirmeyenler: canlı `buy()` akışı (stop ön-kontrolü alımdan önce, kısmi dolum iptali, dolum sonrası
pozisyon önce deftere yazılıyor), `tick()` koruma-yeniden-kurma sırası, `atomicWrite`, ayar doğrulama beyaz listesi.
Henüz incelenmeyenler: `liveEngine.sell()`, `reconciliation.js`, `orderManager.js`, adaptörlerin emir yuvarlama/hata kodu eşlemeleri.

## 2.0.11 — üçüncü tur (emir yöneticisi ve backtest)

| # | Bulgu | Düzeltme |
|---|-------|----------|
| 12 | `splitSymbol` sabit kasa listesiyle çalışıyordu (USD/GBP yok): Kraken, Bitstamp, Coinbase, OKX gibi USD/EUR/GBP kasalı çiftlerde baz-varlık komisyonu düşülmüyor, pozisyon miktarı komisyon kadar şişiyordu (1.0 yerine 0.999). | Kanonik `BAZ/KASA` biçimi doğrudan ayrılır; liste yalnızca slash'sız semboller için yedek (USD, GBP eklendi). Test: `orderSymbolSplit.test.js`. |
| 13 | Emir borsaya GİTTİKTEN sonra yanıt işleme veya diske yazma hatası, emri "REJECTED" kaydediyordu (borsada emir var, yerelde yok → korumasız coin). Disk hatası ayrıca istisna fırlatıp `buy()/sell()` akışını yarıda kesiyordu. | Gönderim ve sonrası ayrıldı: gönderim sonrası hata → `UNKNOWN` (mutabakatla çözülür), diske yazma hatası bellekteki kaydı bozmaz (`lastSaveError`). Gönderim ÖNCESİ PENDING kaydı yazılamazsa emir hiç gönderilmez. `submitMarket/Stop/TakeProfit/Oco`, `cancel`, `reconcile`, WebSocket dolum olayı. Test: `orderManagerPostSend.test.js`. |
| 14 | Backtest ileriye bakma denetimi yoktu. | Simülatörün stratejiye verdiği pencere izlenir; ileriye bakan sahte simülatörde test kırılır (mutasyonla doğrulandı). 8 stratejinin hepsi temiz. Test: `backtestNoLookahead.test.js`. |

Not: Tüm borsa adaptörlerinde `liveTradingVerified: false`; `OrderManager.assertLiveCapability()` bu yüzden HİÇBİR borsada canlı emre izin vermez.
Bu kasıtlı bir güvenlik kilididir ve gerçek hesap/sandbox kanıtı olmadan kaldırılmamalıdır.
Reconciliation, yönetilen coin bakiyesinin yerel defterle birebir eşleşmesini ister: bot hesabında aynı coinden dışarıdan bakiye bulunmamalıdır
(ideal: ayrı alt hesap).
