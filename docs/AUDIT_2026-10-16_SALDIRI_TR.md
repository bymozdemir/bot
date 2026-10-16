# Saldırı denetimi — 2026-10-16

Test: 91 dosya / 925 test, 924 geçti. Başarısız tek test `serverIntegration` (denetim ortamında express/ws/dotenv kurulamadı; ağ kapalıydı, kod hatası değil).

## Uygulanan düzeltmeler
1. `src/execution.js` `validateCandleSeries`: O/H/L/C > 0 zorunlu (0/negatif fiyat artık reddedilir).
2. `src/paperEngine.js`: önceki kapanıştan >%30 sapan tek tick, sonraki turda (10 dk içinde, ±%5) doğrulanmadıkça atlanır; son bilinen fiyat korunur.
3. `src/telegramCommands.js`: `from.id` de yetkili chat id ile eşleşmeli (grup chat id kullanılırsa yabancı üyeler komut veremez).
4. `test/engine2.test.js`: gerçekçi olmayan 100→83000 sıçrama yerine sabit 83000 serisi.
5. Yeni testler: `test/tickSanity.test.js`.

## Açık / kapsam dışı
- HTTP/WS katmanı canlı saldırıya uğramadı (bağımlılıklar kurulamadı); yalnızca kod okuyarak incelendi.
- `/api/login`, `/api/logout` Origin kontrolü yok; Host allow-list yok; `unhandledRejection` süreci kapatır (düşük etki).
- `npm audit` çalıştırılmadı.
- Kârlılık kanıtlanmadı: yalnızca sentetik rejimlerde denendi. `macd_momentum`, `bollinger_reversion`, `ema_cross` (1s) maliyet nedeniyle önerilmez.
- Canlı işlem kilitleri 11 adaptörde sağlam; canlıya geçilmemeli.
