# Price Shock / Order Sizing Checker — fix28

Bu sürümde üretim koduna yeni risk yaması eklenmeden emir boyutlandırma ve fiyat şoku davranışı bağımsız testlerle zorlandı.

Kontroller:
- 10.000 rastgele fiyat/step kombinasyonu
- çok düşük ve çok yüksek fiyatlar
- `MARKET_LOT_SIZE` maxQty
- `minNotional` ile `maxTradeQuote` çelişkisi
- geçersiz fiyat (`0`, negatif, NaN, Infinity)
- `maxTradeQuote` ve miktar yuvarlama invariantları

Sonuç: 5/5 yeni test başarılı; toplam test: 241/241.
