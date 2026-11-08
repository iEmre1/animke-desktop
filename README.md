# Animke Masaüstü

[Animke](https://animke.com) için Windows masaüstü uygulaması. Uygulama siteyi
kendi penceresinde açar; hesabın, listen ve izleme geçmişin sitedekiyle aynıdır.

**[⬇️ Son sürümü indir](https://github.com/iEmre1/animke-desktop/releases/latest/download/Animke-Setup.exe)**

## Özellikler

- **Discord durumu:** Discord'da "Animke izliyor" olarak izlediğin anime, sezon,
  bölüm ve çevirmen görünür. Video oynatıcı başka bir sitede (iframe) olsa bile
  gerçek dakika ve kalan süre gösterilir.
- **Reklam engelleme:** EasyList tabanlı filtrelerle reklam istekleri engellenir.
  Oynatıcıların açtığı reklam pencereleri ve yönlendirmeleri de engellenir; dış
  bağlantılar yalnızca sitede gerçekten tıklandıysa tarayıcıda açılır.
- **Bildirimler:** Listendeki animelerin yeni bölümleri ve yorumlarına gelen
  yanıtlar için Windows bildirimi (uygulama tepsideyken de).
- **Birlikte izleme (tam senkron):** Sitedeki "Birlikte İzle" odalarında durdur,
  oynat ve ileri sar başka sitelerin oynatıcılarında da herkese yansır; Discord
  durumunda "Odaya Katıl" düğmesi ve kişi sayısı görünür.
- **Oda davetleri uygulamada açılır:** Davet sayfasında "Uygulamada aç" seçilince
  (`animke://` bağlantısı) oda uygulamada açılır. Kopyalanan davet bağlantıları da
  algılanır. Sitedeki "Bağlantıyla Katıl" düğmesine ya da arama kutusuna davet
  bağlantısı yapıştırılarak da katılınabilir.
- **Mini oynatıcı:** Videoyu her zaman üstte duran küçük pencerede izle.
- **Medya tuşları:** Klavyedeki oynat/duraklat, sonraki/önceki tuşları (yalnızca
  sayfada video varken; yokken diğer uygulamalara bırakılır).
- **Otomatik güncelleme:** Yeni sürümler arka planda indirilir.
- **Ekran uyumaz:** Video oynarken ekran kararmaz.
- **Başlık çubuğu:** Geri, İleri, Yenile, Ana Sayfa ve Ayarlar düğmeleri.
- **Arka planda bekler:** Çarpıya basınca uygulama kapanmaz, sistem tepsisinde
  bekler ve anında açılır (video duraklatılır, Discord durumu silinir).
  Tamamen kapatmak için tepsi simgesine sağ tıklayıp **Çıkış**.
- **Windows açılınca başlat** (isteğe bağlı, tepside sessizce başlar).
- **Her zaman güncel site:** Uygulama siteyi kopyalamaz, `animke.com`'u açar.

Ayarlar başlık çubuğundaki **Ayarlar** düğmesinde ve tepsi simgesinin sağ tık
menüsündedir. Kısayollar: F5 yenile, F11 tam ekran, Alt+←/→ geri/ileri,
Ctrl +/−/0 yakınlaştır.

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
  ayarlayabilir ve birlikte izleme için videoyu oynatıp durdurabilir/sarabilir;
  bu komutlar yalnızca Animke'nin ana sayfasından kabul edilir ve ana süreç her
  mesajı doğrular.
- Kamera, mikrofon, konum gibi izinler reddedilir.

## Geliştirme

```bash
npm install
npm start          # animke.com ile çalıştır
npm run dev        # http://localhost:3000 ile çalıştır (ayrı ayar klasörü, geliştirici araçları: Ctrl+Shift+I)
npm run build      # dist/Animke-Setup.exe oluşturur
```

| Dosya | Görevi |
|---|---|
| `src/main.js` | Pencere, güvenlik kuralları, tepsi menüsü, güncelleme |
| `src/titlebar/` | Başlık çubuğu (Geri/İleri/Yenile/Ayarlar) |
| `src/preload.js` | Siteye açılan arayüz ve oynatıcıdan video süresi okuma |
| `src/presence.js` | Discord durumunun oluşturulması |
| `src/discord-rpc.js` | Discord ile bağlantı (harici paket yok) |
| `src/ad-blocker.js` | Reklam engelleme |
| `src/notifier.js` | Yeni bölüm ve yorum yanıtı bildirimleri |

### Yeni sürüm yayınlama

1. `package.json`'daki `version`'ı artır (ör. `1.0.1`).
2. `git commit -am "1.0.1" && git tag v1.0.1 && git push --follow-tags`
3. GitHub Actions kurulum dosyasını derleyip Releases'ta yayınlar; kullanıcıların
   uygulaması güncellemeyi kendiliğinden alır.

## Lisans

[MIT](LICENSE)
