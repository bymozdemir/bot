# 1.9.1 User-Defined Portfolio Policy

Portfolio composition is not hard-coded as 5 speculative + 5 core (or any other fixed mix).

## User controls
- `maxPositions`: portfolio-wide maximum open positions (1-100)
- `reserveCashPct`: portfolio cash reserve (0-99%)
- Each portfolio bucket:
  - `maxPositions`: bucket maximum; `0` means no bucket count limit
  - `maxCapitalPct`: bucket maximum capital share; `0` means no bucket capital cap
- Each pair has `portfolioClass` (default `core`). The UI currently exposes `core` (Ana) and `speculative` (Spekülatif); custom buckets are supported by the state/API.

## Enforcement
The same policy is enforced at Paper entry, Live entry gate, and shared-cash strategy validation. Existing legacy `maxConcurrentPositions` and `reserveCashPct` fields remain synchronized for backward compatibility.

## Scanner
The scanner accepts a policy JSON and a separate symbol-to-category JSON mapping:
- `--policy-json '{...}'`
- `--categories-json '{"BTC/USDT":"core","XYZ/USDT":"speculative"}'`

The Strategy Gate no longer requires a fixed maximum of 3 positions or a fixed 10% reserve. Those values are user policy inputs.


## Uyarı: 0 = SINIRSIZ (1.9.2 notu)
Kategori `maxPositions` ve `maxCapitalPct` alanlarında **0 değeri "kapalı" değil "sınırsız"** demektir.
Bir kategoriyi engellemek için 0 girmek tam tersi sonuç verir. Engellemek için pariteyi devre dışı bırak ya da küçük pozitif bir limit gir.
Kategori adı olarak `constructor`, `__proto__`, `prototype` kullanılamaz. Politika üst sınırı: en fazla 50 açık pozisyon.

## Paper ↔ canlı bütçe farkı (bilinen, değiştirilmedi)
Paper motoru `budgetPct`'yi **günün başlangıç özkaynağı**ndan hesaplar (30/30/30 sıraya bağlı değildir). Canlı motor ise **kalan serbest bakiye**den hesaplar (30 → 21 → 14.7 şeklinde küçülür).
Canlıdaki hesap, gerçek bakiyeyi aşmamak için bilinçli olarak korundu; paper sonuçlarını canlı büyüklüklerinin birebir tahmini sayma.
