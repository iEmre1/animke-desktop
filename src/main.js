// Animke masaüstü uygulaması.
//
// Uygulama siteyi kopyalamaz; pencerede doğrudan https://animke.com açılır, yani
// siteye yapılan her güncelleme uygulamada da anında görünür. Uygulamanın
// tarayıcıdan farkı: Discord'da "Animke izliyor" durumu (iframe'deki gerçek
// dakikayla), reklam pencerelerinin engellenmesi ve masaüstü penceresi.
//
// Güvenlik: site uzaktan yüklendiği için sayfalara Node erişimi verilmez
// (contextIsolation + sandbox), pencere yalnızca Animke adresinde kalabilir,
// diğer bağlantılar varsayılan tarayıcıda açılır.

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Menu,
  Tray,
  session,
  powerSaveBlocker,
  nativeImage,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { autoUpdater } = require("electron-updater");
const { PresenceManager } = require("./presence");
const { AdBlocker } = require("./ad-blocker");

const DEV = process.argv.includes("--dev");
const SITE_URL = (process.env.ANIMKE_URL || (DEV ? "http://localhost:3000" : "https://animke.com")).replace(/\/$/, "");
const SITE_ORIGINS = new Set([
  new URL(SITE_URL).origin,
  "https://animke.com",
  "https://www.animke.com",
]);
// "Discord ile giriş" penceresi bu adreslerde uygulama içinde açılır.
const OAUTH_HOSTS = ["discord.com", "tangible-roadrunner.pikapod.net"];

const isSiteUrl = (raw) => {
  try {
    return SITE_ORIGINS.has(new URL(raw).origin);
  } catch {
    return false;
  }
};
const isOAuthUrl = (raw) => {
  try {
    const host = new URL(raw).hostname;
    return OAUTH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
};
const openExternal = (raw) => {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" || u.protocol === "http:") shell.openExternal(u.toString());
  } catch {
    // geçersiz adres: yok say
  }
};

// Bazı oynatıcılar "Electron" içeren tarayıcı kimliğini engelliyor; Chrome gibi görün.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/i, "")
  .replace(/\sanimke-desktop\/\S+/i, "")
  .replace(/\sAnimke\/\S+/i, "");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let presence = null;
let tray = null;
const adBlocker = new AdBlocker();
const log = (msg) => DEV && console.log(msg);

// --- Ayarlar (tepsi menüsünden değiştirilir) -------------------------------
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const settings = { adBlock: true, discord: true };
function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath(), "utf8")));
  } catch {
    // ilk açılış: varsayılanlar
  }
}
function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch {
    // yazılamazsa önemli değil
  }
}

// --- Pencere boyutu/konumu hatırlansın -------------------------------------
const statePath = () => path.join(app.getPath("userData"), "window-state.json");
function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return { width: 1400, height: 860 };
  }
}
function saveWindowState(win) {
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(statePath(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
  } catch {
    // yazılamazsa önemli değil
  }
}

const secureWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false,
};

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 380,
    minHeight: 500,
    backgroundColor: "#090d16",
    title: "Animke",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      ...secureWebPreferences,
      preload: path.join(__dirname, "preload.js"),
      // Preload'ın başka sitelerin oynatıcı iframe'lerinde de çalışması için
      // (gerçek video süresini okumak ve reklam pencerelerini engellemek).
      nodeIntegrationInSubFrames: true,
    },
  });
  if (state.maximized) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", () => saveWindowState(mainWindow));

  const wc = mainWindow.webContents;

  // Ana pencere Animke'den başka bir adrese gidemez; o bağlantılar tarayıcıda açılır.
  wc.on("will-navigate", (event, url) => {
    if (!isSiteUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });

  // Yeni pencereler: giriş penceresi uygulama içinde, sitenin kendi bağlantıları
  // tarayıcıda; iframe'lerin (reklamların) açtıkları engellenir.
  wc.setWindowOpenHandler((details) => {
    const { url } = details;
    const referrer = details.referrer?.url || "";
    const fromThirdParty = referrer && !isSiteUrl(referrer) && !isOAuthUrl(referrer);
    if (fromThirdParty) return { action: "deny" };

    if (url === "about:blank" || isOAuthUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 760,
          parent: mainWindow,
          autoHideMenuBar: true,
          backgroundColor: "#090d16",
          webPreferences: { ...secureWebPreferences },
        },
      };
    }
    openExternal(url);
    return { action: "deny" };
  });

  // Klavye kısayolları: F5 yenile, F11 tam ekran, Alt+Sol/Sağ geri/ileri.
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F5") {
      wc.reload();
      event.preventDefault();
    } else if (input.key === "F11") {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    } else if (input.alt && input.key === "ArrowLeft" && wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack();
      event.preventDefault();
    } else if (input.alt && input.key === "ArrowRight" && wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward();
      event.preventDefault();
    } else if (DEV && input.control && input.shift && input.key.toLowerCase() === "i") {
      wc.toggleDevTools();
    }
  });

  // Site açılamazsa (internet yok) basit bir hata sayfası.
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: iptal edildi (normal)
    const html = `<!doctype html><meta charset="utf-8"><title>Animke</title>
      <body style="background:#090d16;color:#e5e7eb;font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
      <div style="text-align:center"><h2>Animke'ye bağlanılamadı</h2>
      <p style="color:#9ca3af">İnternet bağlantını kontrol et. (${String(desc).replace(/[<>&]/g, "")})</p>
      <button onclick="location.href='${SITE_URL}'" style="background:#1e90e0;color:#fff;border:0;border-radius:10px;padding:10px 18px;font-size:14px;cursor:pointer">Tekrar dene</button></div>`;
    wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
    log(`yükleme hatası: ${code} ${desc} ${url}`);
  });

  // Sayfa yenilenince / başka sayfaya geçince eski çerçevelerin video bilgisi silinsin.
  wc.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) presence?.removeFramesWithPrefix(`${wc.id}:`);
  });

  mainWindow.loadURL(SITE_URL);
}

// --- Sayfalardan gelen mesajlar ---------------------------------------------
const frameKey = (event) => `${event.sender.id}:${event.senderFrame?.processId}:${event.senderFrame?.routingId}`;
const fromMainWindow = (event) => mainWindow && event.sender === mainWindow.webContents;

ipcMain.on("animke:version", (event) => {
  event.returnValue = app.getVersion();
});

ipcMain.on("animke:activity", (event, info) => {
  // Yalnızca ana penceredeki Animke sayfası durum ayarlayabilir.
  if (!fromMainWindow(event) || event.senderFrame !== event.sender.mainFrame) return;
  if (!isSiteUrl(event.senderFrame.url)) return;
  presence?.setInfo(info);
});

ipcMain.on("animke:translator", (event, name) => {
  if (!fromMainWindow(event) || event.senderFrame !== event.sender.mainFrame) return;
  if (!isSiteUrl(event.senderFrame.url)) return;
  presence?.setTranslator(typeof name === "string" ? name.slice(0, 80) : "");
});

ipcMain.on("animke:video", (event, state) => {
  if (!fromMainWindow(event)) return;
  if (state !== null) {
    const currentTime = Number(state?.currentTime);
    const duration = Number(state?.duration);
    if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0 || duration > 6 * 3600) return;
    state = { currentTime, duration, paused: !!state.paused };
  }
  presence?.updateVideo(frameKey(event), state);
});

// --- Otomatik güncelleme -------------------------------------------------------
// Yeni sürümler herkese açık GitHub deposundan (iEmre1/animke-desktop) arka planda
// indirilir; hazır olunca kullanıcıya yeniden başlatmak isteyip istemediği sorulur.
let updateCheckManual = false;
function setupAutoUpdater() {
  if (DEV || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Animke",
      message: `Yeni sürüm hazır (${info.version})`,
      detail: "Şimdi yeniden başlatıp güncellemek ister misin? \"Sonra\" dersen uygulamayı kapattığında kurulur.",
      buttons: ["Yeniden başlat", "Sonra"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on("update-not-available", () => {
    if (!updateCheckManual) return;
    updateCheckManual = false;
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Animke",
      message: "En son sürümü kullanıyorsun",
      detail: `Sürüm ${app.getVersion()}`,
    });
  });
  autoUpdater.on("error", (err) => {
    log(`güncelleme hatası: ${err?.message || err}`);
    if (!updateCheckManual) return;
    updateCheckManual = false;
    dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Animke",
      message: "Güncelleme denetlenemedi",
      detail: "İnternet bağlantını kontrol edip daha sonra tekrar dene.",
    });
  });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

// --- Sistem tepsisi ---------------------------------------------------------------
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: `Animke ${app.getVersion()}`, enabled: false },
    { type: "separator" },
    {
      label: "Animke'yi göster",
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: "Reklam engelleme",
      type: "checkbox",
      checked: settings.adBlock,
      click: async (item) => {
        settings.adBlock = item.checked;
        saveSettings();
        if (item.checked) await adBlocker.enable();
        else adBlocker.disable();
        mainWindow?.webContents.reload();
      },
    },
    {
      label: "Discord'da izlediğimi göster",
      type: "checkbox",
      checked: settings.discord,
      click: (item) => {
        settings.discord = item.checked;
        saveSettings();
        presence?.setEnabled(item.checked);
      },
    },
    { type: "separator" },
    {
      label: "Güncellemeleri denetle",
      enabled: app.isPackaged,
      click: () => {
        updateCheckManual = true;
        autoUpdater.checkForUpdates().catch(() => {});
      },
    },
    {
      label: "Kaynak kodu (GitHub)",
      click: () => openExternal("https://github.com/iEmre1/animke-desktop"),
    },
    { type: "separator" },
    { label: "Çıkış", click: () => app.quit() },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "build", "icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Animke");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => {
    if (!mainWindow) return;
    mainWindow.isVisible() && !mainWindow.isMinimized() ? mainWindow.focus() : (mainWindow.show(), mainWindow.restore());
  });
}

// --- Video oynarken ekran uyumasın -------------------------------------------------
let keepAwakeId = null;
function updateKeepAwake() {
  const video = presence?.currentVideo();
  const playing = !!video && !video.paused;
  if (playing && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start("prevent-display-sleep");
  } else if (!playing && keepAwakeId !== null) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
}

// Ana pencere dışındaki pencereler (Discord giriş penceresi) yeni pencere
// açamaz; bağlantıları tarayıcıda açılır. <webview> hiçbir yerde kullanılamaz.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  if (contents.getType() !== "window") return;
  setImmediate(() => {
    if (mainWindow && contents === mainWindow.webContents) return;
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });
  });
});

// --- Uygulama yaşam döngüsü ---------------------------------------------------
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  // Sitenin istemediği izinleri (kamera, mikrofon, konum...) reddet; tam ekran ve bildirim serbest.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["fullscreen", "notifications", "clipboard-sanitized-write"].includes(permission));
  });

  loadSettings();
  presence = new PresenceManager({ siteUrl: SITE_URL.startsWith("https:") ? SITE_URL : "https://animke.com", log });
  presence.setEnabled(settings.discord);
  setInterval(updateKeepAwake, 5_000);

  // Reklam filtreleri pencere açılmadan yüklensin ki ilk sayfada da çalışsın
  // (en fazla birkaç saniye bekler; olmazsa engellemesiz devam eder).
  const ready = settings.adBlock
    ? Promise.race([adBlocker.enable(), new Promise((r) => setTimeout(r, 4_000))])
    : Promise.resolve();
  ready.finally(() => {
    createWindow();
    createTray();
    setupAutoUpdater();
  });
});

app.on("window-all-closed", async () => {
  await presence?.dispose();
  app.quit();
});
