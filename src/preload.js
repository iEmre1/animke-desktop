// Her çerçevede (ana sayfa + başka sitelerin oynatıcı iframe'leri) çalışır.
// Güvenlik: sayfalara Node/Electron erişimi verilmez; yalnızca birkaç dar
// mesaj kanalı açılır ve ana süreç her mesajı doğrular.

const { contextBridge, ipcRenderer } = require("electron");

// Sandbox'lı preload'da process.isMainFrame her zaman yok; bu karşılaştırma
// başka sitelerin iframe'lerinde de güvenle çalışır.
const isMainFrame = window.top === window;

// --- Reklam açılır pencereleri (yalnızca iframe'ler) -----------------------
// Fansub oynatıcıları tıklamada reklam penceresi açar. window.open, sayfanın
// kendi kodları çalışmadan ÖNCE etkisizleştirilir (executeInMainWorld eşzamanlı
// çalışır). null yerine sahte pencere döner; bazı oynatıcılar null'da bozuluyor.
// Ana sitenin window.open'ına dokunulmaz (Discord ile giriş penceresi için).
if (!isMainFrame) {
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        const fake = {
          closed: true,
          opener: null,
          close() {},
          focus() {},
          blur() {},
          postMessage() {},
          location: { href: "", assign() {}, replace() {} },
          document: { write() {}, writeln() {}, open() {}, close() {} },
        };
        try {
          Object.defineProperty(window, "open", { value: () => fake, writable: false, configurable: false });
        } catch {
          window.open = () => fake;
        }
      },
    });
  } catch {
    // çerçeve kapanmış vb.
  }
}

// --- Video durumu (tüm çerçeveler) -----------------------------------------
// Sayfadaki en uzun <video>'nun süresini birkaç saniyede bir ana sürece bildirir.
// Ana süreç bunu Discord durumu, ekranın uyumaması ve medya tuşları için kullanır.
let lastSent = "";
function reportVideo() {
  let best = null;
  for (const video of document.querySelectorAll("video")) {
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration < 60) continue; // reklam/önizleme değil
    if (!best || duration > best.duration) {
      best = { currentTime: Number(video.currentTime) || 0, duration, paused: video.paused || video.ended };
    }
  }
  const key = best ? `${Math.round(best.currentTime / 3)}|${best.duration}|${best.paused}` : "none";
  if (key === lastSent) return;
  lastSent = key;
  ipcRenderer.send("animke:video", best);
}

window.addEventListener("DOMContentLoaded", () => {
  setInterval(reportVideo, 3_000);
  for (const name of ["play", "pause", "seeked", "ended", "loadedmetadata"]) {
    document.addEventListener(name, (e) => e.target instanceof HTMLVideoElement && reportVideo(), true);
  }
});
window.addEventListener("pagehide", () => ipcRenderer.send("animke:video", null));

// --- Birlikte izleme: kullanıcının oynat/duraklat/sarma işlemleri ----------------------
// Uygulamanın kendisi videoyu senkron için değiştirdiğinde video'ya
// data-animke-sync-until damgası konur; o süre içindeki olaylar kullanıcıdan gelmiyor.
function mainVideo() {
  let best = null;
  for (const video of document.querySelectorAll("video")) {
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration < 60) continue;
    if (!best || duration > best.duration) best = video;
  }
  return best;
}

window.addEventListener("DOMContentLoaded", () => {
  for (const name of ["play", "pause", "seeked"]) {
    document.addEventListener(
      name,
      (event) => {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement) || video !== mainVideo()) return;
        if (Number(video.dataset.animkeSyncUntil || 0) > Date.now()) return;
        ipcRenderer.send("animke:party-event", {
          type: name,
          currentTime: Number(video.currentTime) || 0,
          duration: Number(video.duration) || 0,
          paused: video.paused || video.ended,
        });
      },
      true,
    );
  }
});

// --- Ana çerçeve -------------------------------------------------------------
if (isMainFrame) {
  // Kullanıcının sitede GERÇEKTEN tıkladığı bağlantılar bildirilir. Uygulama dış
  // bağlantıyı yalnızca böyle bir tıklamanın sonucuysa tarayıcıda açar; reklam
  // kodlarının açmaya çalıştıkları engellenir.
  const reportClick = (event) => {
    if (!event.isTrusted) return;
    const link = event.target?.closest?.("a[href]");
    if (link?.href) ipcRenderer.send("animke:link-click", link.href);
  };
  document.addEventListener("click", reportClick, true);
  document.addEventListener("auxclick", reportClick, true);

  contextBridge.exposeInMainWorld("animkeDesktop", {
    isDesktop: true,
    version: ipcRenderer.sendSync("animke:version"),
    /** { title, subtitle, image, url } — izlenen anime; null ile temizlenir. */
    setActivity: (info) => {
      if (info === null) return ipcRenderer.send("animke:activity", null);
      if (!info || typeof info !== "object") return;
      ipcRenderer.send("animke:activity", {
        title: String(info.title ?? "").slice(0, 200),
        subtitle: String(info.subtitle ?? "").slice(0, 200),
        image: String(info.image ?? "").slice(0, 500),
        url: String(info.url ?? "").slice(0, 600),
      });
    },
    clearActivity: () => ipcRenderer.send("animke:activity", null),
    /** İzlenen çevirinin (fansub) adı; Discord durumunda bölümün yanında görünür. */
    setTranslator: (name) => ipcRenderer.send("animke:translator", String(name ?? "").slice(0, 80)),
    /** Önceki/sonraki bölümün adresi; klavyedeki medya tuşları için. */
    setEpisodeNav: (nav) =>
      ipcRenderer.send("animke:episode-nav", {
        prev: String(nav?.prev ?? "").slice(0, 600),
        next: String(nav?.next ?? "").slice(0, 600),
      }),
    /** Birlikte izleme odası: Discord'da "Odaya Katıl" ve kişi sayısı; null ile kaldırılır. */
    setParty: (party) => {
      if (!party || typeof party !== "object") return ipcRenderer.send("animke:party", null);
      ipcRenderer.send("animke:party", {
        id: String(party.id ?? "").slice(0, 64),
        url: String(party.url ?? "").slice(0, 300),
        size: Number(party.size) || 1,
        max: Number(party.max) || 1,
      });
    },
    /** Birlikte izleme: iframe oynatıcılar dahil videoyu okur ve kontrol eder. */
    party: {
      getState: () => ipcRenderer.invoke("animke:party-state"),
      control: (command) =>
        ipcRenderer.invoke("animke:party-control", {
          playing: !!command?.playing,
          position: Number(command?.position) || 0,
        }),
      onEvent: (listener) => {
        if (typeof listener !== "function") return () => {};
        const handler = (_event, data) => listener(data);
        ipcRenderer.on("animke:party-event", handler);
        return () => ipcRenderer.removeListener("animke:party-event", handler);
      },
    },
  });
}
