> **TARİHSEL GELİŞTİRME KAYDI — GÜNCEL TEST SONUCU DEĞİLDİR.** Bu dosya önceki bir geliştirme aşamasında alınmış sonuçları korur. Güncel Paper Final doğrulama kaydı: Termux üzerinde `npm run test:batched`, `EXIT_CODE=0`; **67/67 dosya, 526 test, 526 başarılı, 0 başarısız, 0 atlanan** (2026-10-13). Güncel durum için kök dizindeki `TEST_RESULTS_2026-10-13_TR.txt` dosyasını esas alın.

# Birleştirme ve doğrulama raporu — PAPER

## Birleştirilen kaynaklar
- `crypto-bot-v195-stage14-decision-ui.zip`: ana taban; karar ekranı ve entegrasyon korumaları korunmuştur.
- `crypto-bot-v195-paper-stage13-aggressivefix.zip`: agresif kırılım stratejisinin ATR başlangıç stopu ve stop sıkılaştırma düzeltmeleri seçici olarak aktarılmıştır.

## Uygulanan değişiklikler
- Agresif kırılım sinyali, stratejiye özgü başlangıç stop mesafesini `suggestedStopDistance` olarak bildirir.
- Paper motoru ve backtest motoru bu stop mesafesini pozisyonun ilk stop seviyesine aktarır.
- Ortak risk çıkışı, mum içi stop kontrolü ve trailing-stop güncellemesi daha sıkı olan başlangıç/ATR stopunu gevşetmez.
- Stage14 karar görünümü ve kısa mumların yalnızca paper modda desteklenmesi kuralı korunmuştur.
- ATR stop aktarımı ve stop seviyesinin gevşetilmemesi için regresyon testleri eklendi.
- `group0`–`group5` test listeleri yeni test dosyasını kapsayacak şekilde güncellendi.

## Doğrulama
- ZIP bütünlük kontrolü: başarılı.
- Proje JavaScript sözdizimi: 132/132 dosya başarılı (node_modules hariç).
- Hedefli strateji/stop/backtest/paper/karar görünümü testleri: 42/42 başarılı; ayrı çalıştırmalarda bazı testler tekrar edildi.
- İzole test grupları: `group0+group1` 160/160 geçti; `group2+group3` 194/194 geçti; `group4+group5` 155 geçti, 1 test çalıştırılamadı.
- Tek engel `test/serverIntegration.test.js`: ortamda `express`, `dotenv` ve `ws` bağımlılıkları kurulamadığı için HTTP/WebSocket entegrasyonu doğrulanamadı. `npm ci` bu çalışma ortamında zaman aşımına uğradı. Termux'ta bağımlılıklar kurulduktan sonra `npm ci` ve `npm test`/`npm run test:batched` yeniden çalıştırılmalıdır.

## Güvenlik ve sınırlar
- Bu paket kârlılık garantisi değildir; 60 aylık geçmiş test ve en az bir haftalık paper çalışma gerekir.
- Canlı işlem doğrulaması yapılmadı. Bu paket yalnızca PAPER testleri için kullanılmalıdır; gerçek API anahtarları eklenmemelidir.
