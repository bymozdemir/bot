# Restart / Recovery Checker - Fix29

Bu tur canlı işlem motorunun süreç kapanması / yeniden başlatma senaryolarını doğrular.

Kontroller:
- Kalıcı kill-switch varken canlı başlangıcının açılmaması
- Borsadaki tanınmayan açık emrin canlı kapısını kapatması
- Yerelde açık görünüp borsada bulunamayan emrin canlı kapısını kapatması
- Borsada FILLED olmuş koruyucu stop ile yerel açık pozisyon uyuşmazlığının canlı kapısını kapatması
- Açık pozisyon + gerçek açık koruyucu stop + eşleşen bakiye durumunda recovery'nin güvenli kalması
- UNKNOWN market/stop sonuçlarında yeniden emir gönderilmemesi
- Kısmi stop + yeniden başlatma sonrasında kalan pozisyonun korunması

Fix29 kapsamı yalnızca test kapsamını genişletmiştir; üretim kodunda yeni davranış değişikliği yapılmamıştır.
