# Strategy Gate 1.9.0

Bu sürüm, otomatik strateji taramasını yalnızca geçmiş getiriyi sıralayan bir araç olmaktan çıkarıp canlıya geçiş için fail-closed bir araştırma kapısına dönüştürür.

## Kapılar

1. **Kronolojik train / validation / blind OOS**
   - OOS verisi aday seçimine dahil edilmez.
   - Walk-forward foldları kronolojik ve çakışmasızdır.
2. **Ortak portföy simülasyonu**
   - Tek quote cash pool.
   - Varsayılan %10 nakit rezervi.
   - Varsayılan en fazla 3 açık pozisyon.
   - Varsayılan parite bütçe tavanı %30.
   - Semboller artık bağımsız 1000 TL/USDT hesapları gibi değerlendirilmez.
3. **Gerçekçi maliyetler**
   - Komisyon ve slippage tüm işlemlerde uygulanır.
4. **Monte Carlo**
   - OOS işlem getirileri deterministik bootstrap ile yeniden örneklenir.
   - Alt kuyruk (`p05`) ve negatif sonuç oranı raporlanır.
5. **Parametre duyarlılığı**
   - Stop-loss / kâr-koruma parametreleri %80–%120 aralığında beş noktada tekrar test edilir.
6. **LIVE_ELIGIBLE kapısı**
   - OOS pozitif olmalı.
   - Yeterli işlem örneklemi olmalı.
   - OOS drawdown ve profit factor sınırları geçilmeli.
   - Monte Carlo p05 pozitif olmalı ve negatif senaryo oranı %50'nin altında olmalı.
   - Parametre duyarlılığında en az %80 koşul pozitif olmalı.
   - En kötü parametre sonucu -%10'dan iyi olmalı.
   - Portföy limitleri güvenli sınırlar içinde olmalı.

Hiçbir kapı kâr garantisi değildir. `LIVE_ELIGIBLE` yalnızca seçilen stratejinin tanımlanan araştırma kriterlerini geçtiğini gösterir.

## Çalıştırma

```bash
npm run scan -- --months 60 --tf 1h,4h --symbols BTC/USDT,ETH/USDT,SOL/USDT --reserve 10 --max-positions 3 --budget 30 --mc 2000
```

Sonuç JSON'unda her timeframe için `liveGate` alanı bulunur:

- `eligible: true` → tanımlanan araştırma kapıları geçildi.
- `eligible: false` → `failed` alanı hangi kapıların geçmediğini gösterir.

Gerçek para için ayrıca exchange contract testleri, canlı mutabakat/recovery ve kontrollü küçük sermaye forward testi gerekir. Bu gate bunların yerine geçmez.
