# Crypto Bot

**Amaç:** Güvenli Paper mod geliştirme ve doğrulaması. **Canlı işlem bu pakette onaylanmış değildir; canlı işlem kilidi kapalı kalmalıdır.**

## Kurulum ve ilk doğrulama

Gereksinim: Node.js 18 veya üstü.

```sh
npm ci
npm audit
npm run preflight
npm run test:batched
npm run test:clock
npm run test:server-integration
```

Testlerden biri başarısızsa atlandıysa veya ortam nedeniyle çalıştırılamadıysa bunu başarı olarak değerlendirmeyin. `npm ci` ve `npm audit` ağ erişimi olan temiz bir ortamda tamamlanmalıdır. Sonuçları tarihli raporlarla karşılaştırmak yerine, bu pakette yeniden çalıştırılmış sonuçları esas alın.

## Çalıştırma

```sh
npm start
```

İlk kurulumda panel kimlik doğrulamasını kurun ve varsayılan Paper ayarlarını doğrulayın. Gerçek API anahtarlarını ZIP'e, loglara veya hata raporlarına eklemeyin.

## Güvenlik durumu

- Varsayılan kullanım Paper modudur.
- Canlı işlem için gereken borsa sözleşmesi ve kurtarma doğrulaması tamamlanmış değildir. Gerçek hesap/sandbox emir akışları doğrulanmadan canlı işlem açılmamalıdır.
- Paribu emir kimliği/kurtarma denetimi `identity=false` durumundadır; Paribu canlı işlemi kullanmayın.
- Bu yazılım kâr garantisi vermez.

## Borsalar ve yetenekler

Borsa desteği tek bir listeyle sınırlı değildir: her adaptörün piyasa verisi, emir oluşturma, emir sorgulama, iptal, kimlik eşleştirme ve kurtarma davranışı ayrı ayrı doğrulanmalıdır. Kodda adaptör bulunması canlı emir akışının doğrulandığı anlamına gelmez. Güncel yetenek ve denetim durumu için `docs/EXCHANGE_CAPABILITY_MATRIX.md` ve `docs/EXCHANGE_AUDIT_2026-10-14_TR.md` dosyalarına bakın.

## Test listeleri

`group0`–`group5` dosyaları `npm run test:batched` tarafından kullanılır; silmeyin veya test dosyası eklerken güncellemeyi unutmayın. Testler bağımlılık gerektiriyorsa önce `npm ci` tamamlanmalıdır.

## Telegram

Telegram komutları yalnızca `.env` içinde doğru `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID` tanımlandığında etkinleşir. Grup/süpergrup kullanılıyorsa ayrıca `TELEGRAM_ALLOWED_USER_IDS=123456789,987654321` biçiminde komut kullanmasına izin verilen Telegram kullanıcı ID'lerini tanımlayın; grup kimliği kullanıcı kimliği yerine geçmez. Özel sohbette `TELEGRAM_CHAT_ID` sohbeti yetkilendirir; gönderici kimliği varsa sohbet sahibiyle veya izin listesindeki kullanıcıyla eşleşmelidir. Coin ekleme sihirbazı Paper modla sınırlıdır; ayarlar `/onayla` gelmeden kaydedilmez ve `/iptal` bekleyen kurulumu iptal eder. Telegram üzerinden canlı emir verilmez.

**Kâr/zarar komutları ve günlük rapor:** `/pozisyonlar` (kısa: `/kar`) her açık coin için adet, alış fiyatı, şimdiki fiyat, maliyet, güncel değer ve K/Z (tutar ve %) gösterir. `/rapor` botun çalışıp çalışmadığını, toplam özkaynağı, bugünkü ve başlangıçtan beri K/Z'yi, bugün kapanan işlemleri ve açık pozisyonları tek mesajda verir. Aynı rapor her gün **21:00'de (İstanbul)** kendiliğinden gönderilir. `.env` ayarları: `DAILY_REPORT=off` kapatır, `DAILY_REPORT_TIME=20:30` saati değiştirir. Bot 21:00'de kapalıysa ve 2 saat içinde açılırsa rapor geç gönderilir; aynı gün ikinci kez gönderilmez (son gönderim günü `state.json` içinde saklanır). Değerler tahminidir; komisyon ve kayma hariçtir. Sunucu tamamen çökerse bu rapor da gelmez; bunu yakalamak için `HEALTHCHECK_URL` kullan.

**Tüm komutlar** (`/yardim`, `/help`, `/yardım` veya `/start` hepsini ve ne işe yaradıklarını listeler):

| Komut | Ne yapar |
|---|---|
| `/durum` | Bot çalışıyor mu, mod, borsa, kill switch, nakit, pozisyon sayısı, motorun son kontrol zamanı |
| `/bakiye` | Nakit ve açık varlıklar |
| `/pozisyonlar` (`/kar`, `/kz`, `/pnl`) | Her coinin alış fiyatı, adedi, şimdiki fiyatı, K/Z |
| `/rapor` (`/ozet`) | Günlük rapor |
| `/islemler [sayı]` | Son kapanan işlemler (varsayılan 10, en fazla 20): giriş/çıkış, K/Z, kapanış sebebi |
| `/neden` | Her coin için botun neden beklediği: son sinyal, sağlanan/eksik şartlar, genel engeller (kill switch, azami pozisyon, günlük limit) |
| `/haftalik`, `/aylik` | Son 7 / 30 gün: K/Z, kazanma oranı, en iyi/en kötü işlem, en büyük düşüş |
| `/coinler` | Listedeki coinler: strateji, mum aralığı, bütçe payı, açık/kapalı |
| `/ayarlar` | Risk ve genel ayarlar (salt-okunur) |
| `/fiyat BTC` | Anlık fiyat (borsadan son 1 dakikalık mum kapanışı; alınamazsa son bilinen fiyat) |
| `/log`, `/log hata` | Son 10 olay / yalnızca hata ve uyarılar. Token, API anahtarı ve parolalar maskelenir |
| `/basla`, `/bitir` | Paper botu başlat / motoru durdur |
| `/coin_ekle`, `/onayla`, `/iptal` | Paper coin ekleme sihirbazı |

**Mesaj etiketi:** Her giden mesajın başına `[PAPER · Binance]` gibi mod ve borsa etiketi eklenir. Birden fazla bot/sunucu aynı sohbete yazıyorsa `.env` içine `BOT_LABEL=ev-sunucu` yazın: `[PAPER · Binance · ev-sunucu]`.

**Otomatik bildirimler** (komut gerekmez):

| Olay | Mesaj |
|---|---|
| Her gün 21:00 (İstanbul) | 🌙 GÜNLÜK RAPOR |
| Her Pazar 20:00 (İstanbul) | 📅 HAFTALIK RAPOR |
| Pozisyon açıldı / işlem kapandı | Fiyat, adet, K/Z, kapanış sebebi |
| Günlük zarar limitinin %80'i ve %100'ü | ⚠ / 🚨 (günde bir kez) |
| Kill switch devreye girdi / kaldırıldı | 🛑 / ✅ |
| Fiyat stop'a yaklaştı | ⚠ (eşik: stop'a %1 kala) |
| Borsadan veri gelmiyor / geri geldi | 📡 / ✅ |
| Bot çöktü / açılışta başlatılamadı | 💥 / ⚠ |

`.env` ayarları: `WEEKLY_REPORT=off`, `WEEKLY_REPORT_TIME=19:00`, `ALERTS=off` (tüm otomatik uyarılar), `TRADE_ALERTS=off`, `RISK_ALERTS=off`, `DATA_ALERTS=off`, `STOP_WARN_PCT=1`, `DATA_STALE_MIN=5`. Motor (`paperEngine`) kendi alım/satım bildirimini de gönderiyorsa mesajlar iki kez gelebilir; bu durumda `TRADE_ALERTS=off` yazın.

## Kayıtlar ve hassas veriler

Çalışma günlükleri varsayılan olarak `data/bot.log`, durum ve Paper kayıtları `data/state.json` konumundadır. `BOT_DATA_DIR` tanımlıysa günlük yolu bu dizine taşınır. Dosyaları paylaşmadan önce token, API anahtarı, parola ve kişisel bilgileri kontrol edip temizleyin.

## Güncel denetim kayıtları

- `docs/AUDIT_2026-10-14_STAGE5_TR.md` — güvenlik denetimi ve açık bulgular.
- `docs/EXCHANGE_AUDIT_2026-10-14_TR.md` — borsa bazlı doğrulama durumu.
- `TEST_RESULTS_CURRENT_TR.txt` — bu paket için mevcut test kanıtı ve doğrulanmamış adımlar.

`docs/history/` içindeki belgeler yalnızca gerektiğinde teknik geçmişi araştırmak içindir; güncel durum veya geçerli test sonucu yerine kullanılmamalıdır.
