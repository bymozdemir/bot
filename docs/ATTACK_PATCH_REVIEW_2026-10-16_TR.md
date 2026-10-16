# Saldırı betikleri ve mum yamaları incelemesi — 2026-10-16

## Uygulanan / zaten mevcut olanlar
- `src/execution.js` zaten OHLC fiyatlarının pozitif olmasını şart koşuyordu. `test/tickSanity.test.js` bu davranışı test ediyor; sıfır ve negatif fiyat senaryoları geçti.
- `group5` içinde `test/tickSanity.test.js` zaten listelenmişti.
- `test/engine2.test.js` içindeki 100 -> 83000 yapay sıçrama, 83000 sabit serisiyle değiştirilmişti. Bu, testin fiyat-sıçraması kuralıyla çelişen fixture'ını kaldırıyor; ayrı bir regresyon testi olarak gerçek sıçrama davranışı ayrıca yazılmalı.
- `src/store.js` içine bozuk geçmiş kapsayıcılarını normalize eden ve bozuk `paper`/`settings` köklerinde kilit koyan kontroller eklendi. `paper.trades`, `equityHistory`, `costs`, `stats` bozuk tipteyse güvenli şekle getirilir.
- `test/storeStateSanity.test.js` eklendi ve `group5` listesine alındı.

## `fix_candle_ve_tick_korumasi.patch` neden aynen uygulanmadı?
Yamanın `paperEngine.tick()` içinde şüpheli fiyat görünce `throw` etmesi, o sembolün `processPair()` aşamasına gitmesini engelliyor. Açık pozisyonun stop/trailing-stop değerlendirmesi de aynı aşamada yapıldığı için ani ama gerçek bir düşüşte koruyucu çıkış bir tur gecikebilir. Bu yüzden kodu olduğu gibi eklemek risk yönetimini zayıflatabilir. Önce şüpheli fiyatın yeni pozisyonları durdurması ile mevcut pozisyonun risk çıkışlarını güvenli şekilde sürdürmesi ayrıştırılmalı; bu ZIP'te bu riskli yamayı eklemedim.

## Saldırı betikleri bulguları
- `a1_feed.js`: 20/21 senaryo savunuldu. “prototype kirletme mumu” senaryosunun ZAYIF sonucu, `JSON.parse` ile gelen `__proto__` alanının kendi veri özelliği olması nedeniyle tek başına prototype pollution kanıtı değil; bu testin gerçek etkiyi (ör. `({}).polluted`) doğrulaması gerekir.
- `a2_zeroprice.js`: sıfır/negatif mum reddediliyor ve son bilinen fiyat korunuyor. %60 flash-crash senaryosu şüpheli sayılıp o turda işlenmiyor; bu, yukarıdaki risk nedeniyle ayrıca iki ardışık tur testi gerektiriyor.
- `a3_vault_store_auth.js`: kasa şifreleme, dosya izni, auth ve kilit testlerinin çoğu geçti. `paper.trades='x'` için yükleme katmanında normalize edilmemiş durum doğrulandı ve bu ZIP'te düzeltildi. “state dosyasında mode=live varsa otomatik canlıya geçer” beklentisi tek başına canlı emir açıldığı anlamına gelmez; `LIVE_TRADING_ENABLED`, hesap kanıtı ve LiveEngine kapıları ayrıca değerlendirilmelidir.
- `a4_accounting.js`: komisyon/kayma örneğinde beklenen ve gerçek adet/PnL eşleşti. `trades='x'` senaryosunda kapanış sırasında diziye normalize edilmesi olumlu.
- `a6_telegram.js`: grup kullanıcı yetkilendirmesi v13 testleriyle uyumlu. `edited_message` üzerinden komut işlenmesi testte tetiklendi; ürün gereksinimine göre bunun reddedilmesi ayrıca düşünülebilir.
- Betikler ilk haliyle `/home/claude/work/bot` sabit yoluna bağlıydı; bu inceleme için çalışma kopyasına uyarlanarak çalıştırıldı. Bunlar üretim entegrasyon testleri değil, saldırı senaryolarıdır.

## Bu turda doğrulananlar
- `offlinePreflight.js`: başarılı.
- İlgili güvenlik, Telegram, vault, mum ve state testleri: 53/53 başarılı.
- Tam test paketi, bağımlılık/entegrasyon ve gerçek borsa ağ testleri bu turda tamamlanmış sayılmaz.

## Ek düzeltme — ani fiyat sıçramasında açık pozisyon (v15 adayı)
- Önceki akışta >%30 fiyat sıçraması onay beklerken `throw` ediliyordu; açık pozisyon da `processPair()` aşamasına ulaşamadığı için stop kontrolü atlanabiliyordu.
- Yeni davranış: pozisyon YOKSA şüpheli tick reddedilir; açık pozisyon VARSA sembol risk-çıkışı için işlenir (`riskOnly=true`) ve aynı turda yeni alımlar `entryPauseReason` ile durdurulur.
- `test/engine2.test.js` içine sert düşüşte stop'un çalıştığını ve girişin duraklatıldığını doğrulayan regresyon testi eklendi.
- Bu test ve `test/tickSanity.test.js` birlikte: 40/40 test geçti. Tam test paketi henüz çalıştırılmadı.
