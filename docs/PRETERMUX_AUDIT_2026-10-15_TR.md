# Termux Öncesi Denetim Raporu — 2026-10-15

## İncelenen aday
`crypto-bot-2.1-live-candle-confirmation-paper-v8-test-groups.zip`

## 2026-10-15 ek tur düzeltmeleri (v9 adayı)
- Alternatif borsa tarihsel veri önbelleği artık borsa/parite/zaman aralığı/ay metaverisini doğruluyor; bozuk, sırasız, geçersiz OHLCV veya pencere dışı mum içeren önbelleği reddedip yeniden indirmeye çalışıyor. Önbellek yazımı doğrudan `writeFileSync` yerine atomik yazma ve `0600` dosya izniyle yapılıyor.
- Karşılaştırma betiği geçersiz `startIndex` değerini erken reddediyor ve kapsama süresini son mumun süresini de hesaba katarak ölçüyor.
- Yeni önbellek doğrulama testi eklendi. Dört hedefli test dosyası ve parity: 20/20 geçti.
- Dağıtım ZIP'inden boş `node_modules` dizinleri ve kaynak yedek `.bak` dosyaları çıkarıldı; bağımlılıklar temiz kurulumla kurulmalı.

## Bu turda yapılan önceki düzeltmeler
- `group5` test listesine üç yeni test dosyası eklendi: `compareLiveCandleBacktest.test.js`, `liveCandleConfirmation.test.js`, `multiExchangeData.test.js`. Önceki toplu test çalıştırıcısı bu dosyalar listede olmadığı için daha çalıştırılmadan hata veriyordu.
- `test/parity.test.js` temel PaperEngine/backtest eşitliğini doğrularken yeni canlı mum filtresini kapatacak şekilde düzeltildi. Filtrenin kendisi ayrı testlerle doğrulanıyor; böylece yeni özellik eski motor eşitliği testini yanlış biçimde bozmaz.
- Tarihsel karşılaştırma raporuna gerçek veri kapsamı eklendi: kaç aylık veri bulunduğu, istenen dönemin yüzde kaçının kapsandığı, mum sayısı ve boşluk sayısı rapora yazılıyor. Kapsam %95'in altındaysa açık uyarı veriliyor; kısa veri penceresi 60 aylık kanıt gibi sunulmuyor.

## Test çalıştırıcısı güncellemesi
- `scripts/runTestsBatched.js` artık `--group group2` ve `--groups group0,group1` seçeneklerini destekliyor; tüm test listesi tutarlılığını yine seçilen gruplardan bağımsız doğruluyor.
- Bu güncellemeden sonra resmi çalıştırıcıyla group0: 12 dosya / 122 test, group1: 12 / 78, group2: 12 / 115, group3: 11 / 157 ve group4: 11 / 254 başarılı oldu; bu beş grubun toplamı 58 dosya ve 726 test, sıfır başarısız/atlanan.
- İlk group5 denemesi ortamın 300 saniyelik komut sınırına takıldı. Daha kısa dosya zaman aşımıyla tekrar çalıştırıldığında group5 tamamlandı: 29 dosya / 150 test, 149 geçti, 1 başarısız, 0 atlandı. Group0–4 ile birlikte resmi çalıştırıcı gruplar halinde 87 dosyanın tümünü kapsadı: 876 test, 875 geçti, 1 başarısız, 0 atlandı.

## Test sonuçları
- 87 test dosyası ayrı Node süreçlerinde çalıştırıldı.
- Toplam: 876 test; 875 geçti, 1 başarısız, 0 atlandı.
- Tek başarısız test: `test/serverIntegration.test.js`. Gerçek `server.js` HTTP/WebSocket entegrasyonu için `express`, `dotenv` ve `ws` kurulu değil.
- `npm ci --ignore-scripts --no-audit --no-fund` denendi ancak registry DNS erişimi (`EAI_AGAIN`) nedeniyle zaman sınırında tamamlanamadı. Bu yüzden gerçek sunucu entegrasyonunu başarılı saymak mümkün değil.
- Canlı mum, tarihsel karşılaştırma, alternatif borsa normalizasyonu/cache doğrulama ve motor/backtest parite testleri: 20/20 geçti.
- `node scripts/offlinePreflight.js`: başarılı. Varsayılan mod `paper`; canlı işlem kilidi kapalı.
- Paper fuzz: 1.000.000 adım ve 17.280 saatlik kaos simülasyonu tamamlandı; 16 başarılı sentetik al-sat çevrimi.
- Portföy politikası fuzz: 1.000.000 adım tamamlandı.
- JavaScript sözdizimi: 174/174 dosya geçti.
- Tam `npm audit` doğrulanamadı; npm registry DNS hatası. Bu, temiz güvenlik denetimi sonucu değildir.

## Açık riskler / Termux öncesi engeller
1. Gerçek bağımlılık kurulumu ve `serverIntegration` testi ağ erişimi olan ortamda tamamlanmalı.
2. Güncel `npm audit` raporu alınmalı ve bulgular incelenmeli.
3. OKX/BtcTurk/Paribu geçmiş mum uç noktaları bu ortamda gerçek ağ üzerinden doğrulanamadı; mevcut testler şema/normalizasyon testleridir, borsa sunucularının 60 aylık veri verdiğini kanıtlamaz.
4. Gerçek 60 aylık veri ile filtre açık/kapalı backtest henüz üretilmedi. Tarihsel OHLC tabanlı onay, gerçek mum içi akışın birebir simülasyonu değildir.
5. Önceki denetimlerdeki canlı emir kimliği/kurtarma kapıları ve borsa bazlı live-contract audit ayrıca çözülmeden canlı kullanım düşünülmemeli.

## v9 ek tur doğrulamaları
- `node scripts/offlinePreflight.js`: başarılı; paper varsayılan, canlı kilit kapalı.
- `node scripts/paperFuzz.js`: 1.000.000 adım ve 17.280 saatlik kaos senaryosu geçti (16 sentetik başarılı al-sat çevrimi).
- `node scripts/portfolioPolicyFuzz.js`: 1.000.000 adım geçti.
- JavaScript sözdizimi: 174/174 geçti.
- Güncel tüm test dosyaları yeniden çalıştırıldı: 87 dosya, 877 test, 876 geçti, 1 başarısız, 0 atlanan. Tek başarısız yine `serverIntegration.test.js` ve eksik `express`/`dotenv`/`ws` bağımlılıkları.

## Karar
**Termux'a temiz kurulum aşamasına geçme onayı henüz verilmedi.** Kod tarafındaki test kapsamı ve düzeltmeler ilerledi; ancak ağ bağımlılığı doğrulamaları ve gerçek geçmiş veri testi eksik. Canlı işlem kilidi kapalı kalmalıdır.
