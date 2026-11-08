# Animke Masaüstü

[Animke](https://animke.com) için Windows masaüstü uygulaması. Uygulama siteyi
kendi penceresinde açar; hesabın, listen ve izleme geçmişin sitedekiyle aynıdır.

**[⬇️ Son sürümü indir](https://github.com/iEmre1/animke-desktop/releases/latest/download/Animke-Setup.exe)**

## Özellikler

- **Discord durumu:** Discord'da "Animke izliyor" olarak izlediğin anime, sezon,
  bölüm ve çevirmen görünür. Video oynatıcı başka bir sitede (iframe) olsa bile
  gerçek dakika ve kalan süre gösterilir.
- **Reklam engelleme:** EasyList tabanlı filtrelerle reklam istekleri ve
  oynatıcıların açtığı reklam pencereleri engellenir.
- **Otomatik güncelleme:** Yeni sürümler arka planda indirilir.
- **Ekran uyumaz:** Video oynarken ekran kararmaz.
- **Her zaman güncel site:** Uygulama siteyi kopyalamaz, `animke.com`'u açar.

Ayarlar sistem tepsisindeki Animke simgesine sağ tıklayınca açılan menüdedir.

## Kurulum uyarısı

Uygulama ücretli bir kod imzalama sertifikasıyla imzalanmadığı için Windows ilk
kurulumda **"Windows bilgisayarınızı korudu"** uyarısı gösterebilir.
**Ek bilgi → Yine de çalıştır** ile devam edebilirsin. Uygulamanın tüm kaynak
kodu bu depodadır; yayınlanan kurulum dosyası GitHub Actions ile doğrudan bu
koddan derlenir ([Release iş akışı](.github/workflows/release.yml)).

## Güvenlik

- Sayfalara Node.js / Electron erişimi verilmez (`contextIsolation`, `sandbox`).
- Ana pencere yalnızca `animke.com` adresinde kalabilir; diğer bağlantılar
  varsayılan tarayıcında açılır.
- Siteye açılan arayüz (`window.animkeDesktop`) yalnızca Discord durumunu
  ayarlayabilir; ana süreç her mesajı doğrular.
- Kamera, mikrofon, konum gibi izinler reddedilir.

## Geliştirme

```bash
npm install
npm start          # animke.com ile çalıştır
npm run dev        # http://localhost:3000 ile çalıştır (geliştirici araçları: Ctrl+Shift+I)
npm run build      # dist/Animke-Setup.exe oluşturur
```

| Dosya | Görevi |
|---|---|
| `src/main.js` | Pencere, güvenlik kuralları, tepsi menüsü, güncelleme |
| `src/preload.js` | Siteye açılan arayüz ve oynatıcıdan video süresi okuma |
| `src/presence.js` | Discord durumunun oluşturulması |
| `src/discord-rpc.js` | Discord ile bağlantı (harici paket yok) |
| `src/ad-blocker.js` | Reklam engelleme |

### Yeni sürüm yayınlama

1. `package.json`'daki `version`'ı artır (ör. `1.0.1`).
2. `git commit -am "1.0.1" && git tag v1.0.1 && git push --follow-tags`
3. GitHub Actions kurulum dosyasını derleyip Releases'ta yayınlar; kullanıcıların
   uygulaması güncellemeyi kendiliğinden alır.

## Lisans

[MIT](LICENSE)
