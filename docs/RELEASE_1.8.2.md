# 1.8.2 — son denetim düzeltmeleri (1.8.1 üzerine)

Her madde `test/finalAudit.test.js` içinde regresyon testiyle kilitlidir (20 testin 17'si 1.8.1'de başarısız olur).

## Kritik
- **Hayalet pozisyon (1.8.0 kurtarma kodu):** `_repairRecoveredState`, FILLED giriş emri görüp yerel pozisyon yoksa pozisyonu yeniden kuruyordu; girişin sonradan satılıp satılmadığına bakmıyordu. Tamamlanmış her al-sat sonrası yeniden başlatmada hayalet pozisyon oluşuyor, stop kurulamayınca kurtarma başarısız oluyor ve canlı mod açılamıyordu. Artık girişe bağlı SELL dolumları düşülür ve hesapta gerçekten coin olduğu doğrulanır.
- **Periyodik mutabakat yıkıcıydı:** `reconcileAll()` geçici bir ağ hatasında sağlıklı koruyucu stop kaydını `UNKNOWN` yapıp botu kilitleyebilirdi. Yerine kaydı bozmayan `refreshPending()` geldi.
- **Fiyat stop seviyesinin altına inince koruma kurulamıyordu:** SELL-stop reddediliyor ve pozisyon korumasız kalıyordu. Artık kontrollü piyasa çıkışı yapılır.
- **Saat sapması:** mum kapanışı ve imza zaman damgası düzeltilmemiş yerel saati kullanıyordu; `-1021` hatasında emir (koruyucu stop dahil) yeniden denenmiyordu. Borsa saatine göre düzeltilmiş zaman (`nowMs`) ve güvenli tek yeniden deneme eklendi.

## Diğer
- Kâr koruma stopu her küçük yükselişte iptal+yeniden kuruluyordu; artık en az %0.25 iyileşme gerekir.
- Eksik mum (bakım/işlem yok) tüm pariteyi kör ediyordu; mum süresinin tam katı boşluklar kabul edilir, yanlış timeframe ve hizasız zaman damgası reddedilmeye devam eder.
- HTTP 418 (IP yasağı) artık yeniden denenmez (yasağı uzatırdı).
- Canlı motor nabız (ping) atmıyordu; paper/shadow gibi artık atıyor. Canlı modda kontrol sıklığı değişince 500 hatası veriyordu (`reschedule`). Shadow modda parite silme 500 veriyordu (`closePosition`).
- Canlı ön-kontrol ekranı "para çekme kapalı" ve "kill switch hazır"ı sabit yeşil gösteriyordu; artık gerçekten sorgular.
- `reset` canlı modda kill switch kilidini siliyordu; bozuk çerez WebSocket bağlantısında süreci çökertebiliyordu; giriş sınırlayıcı ters proxy arkasında herkesi kilitleyebiliyordu; bozuk `state.json` son sağlam `.bak` yedeğinin üstüne kopyalanabiliyordu.
- Kilit nedeni/kritik uyarı bayrakları temizlenmiyordu; panel eski nedeni sonsuza dek gösteriyordu. Panel artık nedenleri listeler.
- Tüm stratejilerde "Take-Profit (%)" etiketi artık satış hedefi olmayan eşiği yanlış anlatıyordu: "Kâr koruma eşiği (%)" olarak düzeltildi.

## Bilinen sınırlar
- Geriye dönük testte (`intrabarRiskExit`) yeni zirve bir sonraki mum için geçerlidir; canlıda stop dakikalık yoklamayla aynı mumda da yukarı taşınabilir. Backtest bu yüzden canlıdan biraz İYİMSER olabilir; parametre seçerken pay bırak.
- Kâr koruma stopunu taşımak iptal+yeniden kurma gerektirir (kısa korumasız pencere); başarısız olursa kontrollü piyasa çıkışı denenir.
- `package-lock.json` yoktur (ağ erişimi olan ortamda `npm install` ile üretip commit et).
- Gerçek borsa sözleşmesi test edilmedi; önce testnet (docs/PRE_API_CHECKLIST.md).
