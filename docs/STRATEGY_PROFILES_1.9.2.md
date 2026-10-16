# Strateji profilleri (1.9.2)

## Kontrollü profil
Panelde `Trend V2 (EMA + ADX + RSI + ATR)` seçilir. EMA trend yönü, ADX trend gücü, RSI dönüşü ve ATR tabanlı çıkış kullanır. Bu profil düşük riskli/garantili anlamına gelmez; sadece daha seçici sinyal hedefler.

## Agresif profil
Panelde `Agresif Kırılım (EMA + RSI + ADX + Hacim + ATR)` seçilir. Önceki kapanmış mumların zirvesinin aşılması, EMA üstü fiyat, minimum ADX, RSI aralığı ve ortalamanın üstünde hacim birlikte aranır. Kırılım penceresi ve hacim çarpanı ayarlanabilir. Daha fazla işlem ve daha yüksek oynaklık/kayıp ihtimali vardır.

## Risk ilkeleri
- Profil seçimi, canlı işlem iznini açmaz; kurulumun mevcut live güvenlik kapısı aynen geçerlidir.
- Agresif profil kaldıraç veya martingale açmaz.
- Başlangıç test kıyaslaması için kontrollü profil: işlem başına hedef risk %0,25, günlük kayıp sınırı %1; agresif: işlem başına hedef risk %0,75, günlük kayıp sınırı %3. Bunlar bu sürümde otomatik pozisyon boyutlandırmasına uygulanmış garantiler değildir; mevcut motorun gerçek pozisyon boyutlandırma ve günlük limit semantiği ayrıca doğrulanmalıdır.
- İki profili aynı semboller, zaman aralığı, paylaşılan portföy nakdi, komisyon, spread/kayma ve aynı OOS aralığında kıyasla. OOS verisi üzerinde parametre seçme.
- Canlı emir koruması (SL/TP/trailing, borsa kuralları, mutabakat) strateji sinyalinden ayrı güvenlik katmanıdır; stratejinin `sell` sinyali borsada koruyucu emir var demek değildir.
