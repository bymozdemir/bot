# 2.1 birleşik aday — karşılaştırma ve doğrulama raporu

Tarih: 2026-10-15  
Durum: **Paper doğrulama adayı; canlı işlem onaylı değil.**

## Karşılaştırılan arşivler

- `bot-guncel-2.0.11.zip`
- `bot-guncel-duzeltilmis-5.zip`
- `bot-guncel-lovable-sondosya.zip`
- `bot-lovable-sondansonra-temiz.zip`
- `crypto-bot-v2.0.8-exchange-audit-step6.zip`
- `bot-guncel-2.0.9.zip`
- `bot-guncel.zip`

ZIP bütünlüğü yedi arşivin tamamında kontrol edildi. Dosya adları/sürüm etiketleri kronoloji kanıtı olarak kullanılmadı; içerik hash'leri ve dosya farkları karşılaştırıldı.

## Birleştirme kararı

`2.0.11` kaynak ağacı temel alındı. Bunun nedeni yalnızca sürüm etiketi değil: paper motorunda daha geniş güvenlik düzeltmeleri, açık pozisyonun başarısız satışta korunması, eski/fiyatsız fiyatla kapatmayı engelleme, zaman aşımı/watchdog, komisyon-kayma tabanlı break-even tamponu, backtest ile ortak maliyet mantığı, daha sıkı bozuk state kurtarması ve gövde okunana kadar süren HTTP zaman aşımı bu ağaçta mevcut.

Diğer varyantlardan aşağıdaki doğrulanabilir iyileştirmeler seçilerek birleştirildi:

- Koruyucu emir kısmi dolumunda hem dolan emir hem karşı bacak kesin iptal edilmeden yeni SELL oluşturmama; OCO'nun karşı bacağı otomatik iptal ettiğini varsaymama.
- Canlı motorun eksik `safeToTrade` alanında güvenli kabul etmek yerine kilitli başlaması ve eşzamansız stop güncellemesi sırasında başka bir risk kilidini yanlışlıkla açmaması.
- Borsa bakiyesi, açık emir kayıtları ve yerel dust değerlerinde bozuk/negatif/sonlu olmayan veriyi mutabakat başarısı saymama.
- Atomik yazmada kısa yazımları döngüyle tamamlama, dosya `fsync` hatasını gizlememe ve dizin girdisini uygun platformlarda eşitleme.
- Test çalıştırıcısında zaman aşımı sonrası alt süreçlerin stdout/stderr borularını açık bırakıp tüm paketi asılı tutmasını önleyen zorunlu kapanış.
- İlgili regresyon testleri.

## 2.1 için ek güvenlik düzeltmeleri

1. **Koruyucu emir `FILLED` olsa da anlamlı miktar kalırsa pozisyon silinmez.** Kalan miktar korunur; eski koruyucu bacaklar iptal edilir ve kalan miktar için tek stop kurulmaya çalışılır. İptal veya stop kurulumu doğrulanamazsa işlem güvenlik kapısı kapalı kalır.
2. **Borsa emri eksik/tanınmayan durumla dönerse `NEW` varsayılmaz.** Emir `UNKNOWN` ve mutabakat gerektiriyor olarak işaretlenir.
3. **OCO cevabı iki bacağı da clientOrderId ile doğrulamıyorsa** başarı sayılmaz; sonuç belirsiz tutulur.
4. **Geçersiz take-profit `limitPrice`** borsaya gönderilmeden reddedilir.
5. **Emir kaydı kalıcı yazılamazsa** canlı işlem kapısı bellek içinde kapatılır ve kalıcılaştırma yeniden denenir. Kalıcı disk arızasında borsadan kesin gözlenen emir durumu bellekte korunur; güvenlik kilidi kapalı kalır.
6. `FILLED` + anlamlı kalan miktar senaryosu için regresyon testi eklendi.

## Gerçekleştirilen doğrulamalar

- Yedi ZIP'in arşiv bütünlüğü: başarılı.
- `node --check`: 168 JavaScript dosyası, 0 sözdizimi hatası.
- `scripts/offlinePreflight.js`: başarılı; varsayılan mod `paper`, canlı işlem kilidi kapalı.
- Odaklı güvenlik testleri: 91/91 geçti.
- Birleşik test paketi: 84/84 test dosyası çalıştırıldı; 851 testin 850'si geçti, 1'i başarısız, 0 atlandı. Tek başarısız test `test/serverIntegration.test.js`; `express`, `dotenv` ve `ws` bağımlılıkları bu ortamda kurulu olmadığından gerçek HTTP/WebSocket entegrasyonu çalıştırılamadı. Bu test başarılı sayılmadı.
- `scripts/paperFuzz.js`: 1.000.000 adım; 62.231 yeniden başlatma, 62.231 serileştirme, 658.513 kilit işlemi; 100 işlem ve kaos koşusunda 9 alış/7 satış gözlendi.
- `scripts/portfolioPolicyFuzz.js`: 1.000.000 adım tamamlandı.
- `scripts/liveContractAudit.js`: beklenen kapı sonucu RED (çıkış kodu 1). Paribu ve Midas RED; diğer dokuz adaptör YELLOW; hiçbir gerçek borsa GREEN değil.
- `test:clock` bu doğrulama turunda tamamlanmadı.
- Ağ erişimli temiz `npm ci` ve güncel `npm audit` bu ortamda tamamlanmadı.
- Gerçek borsa/demo/testnet emir oluşturma, sorgulama, iptal ve kurtarma akışları bu mock testlerle kanıtlanmış değildir.

## Açık kapılar

1. Temiz Termux ortamında `npm ci` ve `npm audit`.
2. Bağımlılıklar kurulduktan sonra `test/serverIntegration.test.js` tekrar çalıştırılmalı.
3. `test:clock` altı tarih turu tamamlanmalı.
4. Gerçek/demo hesaplarda her borsa için kimlik, emir sorgulama, iptal, kısmi dolum ve yeniden başlatma kurtarması ayrı ayrı kanıtlanmalı.
5. Paribu ve Midas RED kaldığı sürece bu adaptörler canlı işlem için kullanılmamalı.

**Sonuç:** Bu ZIP karşılaştırma ve kod tarafı iyileştirmeleri birleştirilmiş `2.1` paper adayını temsil eder; “mükemmel”, kârlılığı kanıtlanmış veya canlıya hazır olarak tanımlanamaz. Canlı işlem kilidi kapalı kalmalıdır.
