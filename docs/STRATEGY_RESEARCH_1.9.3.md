# Strateji Araştırma Paketi 1.9.3-research1

## Bu sürümde
- Tarihsel mum verisi aralıkları `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w` olarak genişletildi.
- Kombinasyon stratejisinde aynı evaluate çağrısı içindeki aynı indikatör/periyot hesabı önbelleğe alınıyor.
- Otomatik strateji taramasına EMA 8/21, 9/21, 12/26 kesişimleri ve ADX 14/20, ADX 14/25, ADX 20/20, ADX 20/25 gibi trend gücü koşulları eklendi.
- Bu değişiklikler canlı işlem stratejisini otomatik olarak değiştirmez; yalnızca backtest/araştırma aday havuzunu genişletir.

## Hızlı yerel test
```bash
npm run test:research
```

## Önerilen karşılaştırma sırası
İlk önce küçük pilotlar çalıştırın; 1m/3m verisi ve çoklu sembol kombinasyonları yoğun kaynak kullanabilir. Her mum aralığını ayrı tarayın, aynı maliyet varsayımlarını koruyun ve sonuçları OOS/walk-forward doğrulaması olmadan kârlı kabul etmeyin.

Örnek pilot (tek sembol, 16 ay; internetten herkese açık tarihsel mum verisi indirir):
```bash
node src/backtest/strategyScanner.js --months 16 --tf 5m --symbols BTC/USDT --max-candidates 36 --train-months 8 --validation-months 4 --oos-months 4 --fee 0.1 --slip 0.05 --mc 1000
```

Ardından `1m`, `3m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w` aralıklarını aynı maliyet ve eğitim/doğrulama/OOS oranlarıyla ayrı ayrı deneyin. Scalping sonuçlarında özellikle spread/slippage duyarlılığına bakın.

## Güvenlik
Bu sürümde canlı emir gönderimi yapılmadı. Araştırma tarayıcısı geçmiş veriyi indirip backtest raporu üretir. Canlı API anahtarları eklemeyin; paper modu ve mevcut canlı işlem kilitleri korunmalıdır.
