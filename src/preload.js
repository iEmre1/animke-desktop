// Her çerçevede (ana sayfa + başka sitelerin oynatıcı iframe'leri) çalışır.
// Güvenlik: sayfalara Node/Electron erişimi verilmez; yalnızca birkaç dar
// mesaj kanalı açılır ve ana süreç her mesajı doğrular.

const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Sandbox'lı preload'da process.isMainFrame her zaman yok; bu karşılaştırma
// başka sitelerin iframe'lerinde de güvenle çalışır.
const isMainFrame = window.top === window;

// --- Video durumu (tüm çerçeveler) -----------------------------------------
// Sayfadaki en uzun <video>'nun süresini birkaç saniyede bir ana sürece bildirir.
// Ana süreç bunu Discord durumundaki ilerleme çubuğu için kullanır.
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

// --- Reklam açılır pencereleri (yalnızca iframe'ler) -----------------------
// Fansub oynatıcıları tıklamada reklam penceresi açar. Ana sitenin kendi
// window.open'ına dokunulmaz (Discord ile giriş penceresi buna ihtiyaç duyar).
if (!isMainFrame) {
  webFrame
    // null yerine sahte bir pencere döndürülür; bazı oynatıcılar dönen pencereye
    // dokunur (focus vb.) ve null alınca oynatma bozulur.
    .executeJavaScript(
      "(() => { const fake = { closed: true, close() {}, focus() {}, blur() {}, postMessage() {}," +
        " location: { href: '', assign() {}, replace() {} }, document: { write() {}, close() {} } };" +
        " window.open = function () { return fake; }; })();",
    )
    .catch(() => {});
}

// --- Siteye açılan arayüz (yalnızca ana çerçeve) ---------------------------
if (isMainFrame) {
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
  });
}
