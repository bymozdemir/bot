> **TARİHSEL GELİŞTİRME KAYDI — GÜNCEL TEST SONUCU DEĞİLDİR.** Bu dosya önceki bir geliştirme aşamasında alınmış sonuçları korur. Güncel Paper Final doğrulama kaydı: Termux üzerinde `npm run test:batched`, `EXIT_CODE=0`; **67/67 dosya, 526 test, 526 başarılı, 0 başarısız, 0 atlanan** (2026-10-13). Güncel durum için kök dizindeki `TEST_RESULTS_2026-10-13_TR.txt` dosyasını esas alın.

# Birleştirilmiş Crypto Bot — 1.9.4-merged

## Birleştirme yaklaşımı
Sürüm numaraları sıralama ölçütü olarak kullanılmadı. Güvenlik-hardened dalı çakışan uygulama dosyalarında başlangıç noktası olarak korundu; diğer dallardaki eksik testler/dokümanlar eklendi. Araştırma dalından daha geniş Binance mum aralıkları, EMA-kesişimi/ADX araştırma adayları ve kombinasyon tarayıcısı alındı. Agresif kırılım stratejisi kayıt defterine bağlandı; CLI testi bu yeni strateji sayısına göre düzeltildi. Kilit dosyası, package-lock bulunan daldan alındı.

## Doğrulama durumu
- Seçilmiş güvenlik, canlı motoru, kurtarma, portföy, parity, emir, mutabakat ve user-data-stream testleri: 100/100 geçti.
- Agresif strateji, CLI ve araştırma aralığı testleri: 11/11 geçti.
- Offline preflight: başarılı; varsayılan mod paper, canlı işlem kilidi kapalı.
- JavaScript sözdizimi kontrolü: bütün JS dosyaları geçti.
- Tam `npm test` paketi henüz yeşil olarak onaylanmadı: birleşik paketin ilk tam çalıştırmasında CLI testi, agresif strateji eklendiği için eski 32 sonuç beklentisiyle 36 sonuçta hata verdi; beklenti düzeltildi. Sonraki tam koşu uzun süre sonra test koşucusu özet üretmeden takıldı. Bu yüzden tam test sonucu **doğrulanmadı** olarak kalır.

## Canlı kullanım uyarısı
Bu paket gerçek para için onaylı değildir. Borsa API sözleşmeleri ve koruyucu emir davranışları her borsada test/sandbox veya çok küçük kontrollü hesapla doğrulanmadan canlı mod kullanılmamalıdır. Özellikle canlı TP/trailing, borsa bazlı emir kuralları, gerçek TRY/USDT hesap mutabakatı ve 5xx/UNKNOWN emir sonuçları ayrıca doğrulanmalıdır.
