# Deterministic model checker

This release includes `test/modelChecker.test.js`.

It checks the OrderManager execution-report state machine against an independent monotonic oracle:
- 720 complete permutations of six execution events
- 20,000 seeded random event sequences with duplicates/out-of-order delivery
- cumulative executed/quote quantities never decrease
- FILLED is not downgraded
- duplicate execution IDs do not double-count commission
- execution IDs remain unique in persisted state

The checker is deterministic (fixed seed) and does not connect to an exchange.

## Fix19 — Muhasebe/Bakiye Model Checker

`test/accountingModelChecker.test.js` üretim muhasebe fonksiyonlarından bağımsız basit bir hesap defteri kullanır.

Kontroller:
- USDT, BTC ve BNB komisyonlarının ayrı ayrı hesaba yansıması
- Alış/satış net miktarlarının bağımsız oracle ile eşleşmesi
- Base-asset satış komisyonunun pozisyon çıkışına dahil edilmesi
- Üçüncü varlık komisyonunun quote değerlemesi; fiyat yoksa `unresolved`
- Negatif bakiye, negatif pozisyon ve negatif cost-basis oluşmaması
- Parçalı satışlarda cost-basis'in iki kez düşülmemesi
- 50.000 deterministik rastgele işlem dizisi

Bu test gerçek Binance bağlantısı kullanmaz.

## Fix22 derin recovery/yarış denetimi

Fix22 testleri, REST, WebSocket, bakiye ve açık emir snapshotlarının eski/yeni
sıralarda gelmesi halinde çelişkili hesabın canlı kapısını açmamasını doğrular.
Ayrıca 5.000 rastgele executionReport + REST reconciliation sıralaması çalıştırılır
ve kümülatif executed quantity'nin geriye düşmediği kontrol edilir.

## Fix23 — Entry/Protective-Stop Race Checks

Fix23 adds regression coverage for the most dangerous entry window:
- WebSocket `FILLED` arriving while the create-order REST call is still pending.
- A stale REST create response returning `NEW` after a WebSocket `FILLED` event.
- A protective stop `FILLED` state already recorded before the local position receives `stopOrderId`.
- An unexpected protective-stop creation exception after the market buy is already recorded locally.

Safety invariant: a confirmed entry must not be treated as safely tradable unless its protective stop state is known; stale create responses must not regress a newer execution state.


## Fix25 — Cancel UNKNOWN güvenlik kilidi

Bir emir iptal API'si `UNKNOWN` döndürürse bu cevap artık `CANCELED` kabul edilmez.
İptal sonucu belirsiz kalır, `requiresReconciliation=true` olur ve canlı satış akışı
market emrine geçmeden durur. Böylece koruyucu stop gerçekte hâlâ açıkken ikinci
bir satış gönderilmesi engellenir.

## Fix26 — Live lifecycle chaos

`test/liveLifecycleChaos.test.js` adds end-to-end offline lifecycle checks:
- BUY -> protective STOP -> process restart -> reconciliation -> safe continuation
- BUY executed + STOP UNKNOWN -> restart remains unsafe
- BUY UNKNOWN -> restart reconciliation -> no second BUY
- STOP FILLED + delayed stale event -> closed position is not resurrected
- STOP cancel UNKNOWN -> market SELL is blocked
- consistent restart snapshot vs stale balance snapshot
- clientOrderId idempotency prevents duplicate BUY

These tests are deterministic and do not connect to Binance.


## Fix27 — canlı risk ayarları fail-closed

Canlı motorunda `maxConcurrentPositions`, `reserveCashPct`, `dailyLossLimitPct`, `killSwitchLossPct` ve `maxTradeQuote` ayarları finite/geçerli aralıkta değilse canlı işlem açılmaz. Eksik eski ayarlar güvenli varsayılanlarla tamamlanır; açıkça bozuk (`NaN`, negatif veya aralık dışı) değerler canlı kapısını kapatır. Parite `budgetPct` değeri de %0-100 aralığı dışında ise canlı alış reddedilir.
