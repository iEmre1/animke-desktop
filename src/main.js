// Animke masaüstü uygulaması.
//
// Uygulama siteyi kopyalamaz; pencerede doğrudan https://animke.com açılır, yani
// siteye yapılan her güncelleme uygulamada da anında görünür. Uygulamanın
// tarayıcıdan farkı: Discord'da "Animke izliyor" durumu (iframe'deki gerçek
// dakikayla), reklam engelleme, başlık çubuğu, sistem tepsisinde çalışma.
//
// Pencere iki parçadan oluşur: üstte yerel bir başlık çubuğu (Geri/İleri/Yenile/
// Ayarlar) ve altında site. Sağdaki küçült/büyüt/kapat düğmelerini Windows çizer.
//
// Güvenlik: site uzaktan yüklendiği için sayfalara Node erişimi verilmez
// (contextIsolation + sandbox), site görünümü yalnızca Animke adresinde
// kalabilir, diğer bağlantılar varsayılan tarayıcıda açılır.

const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
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
const { PresenceManager } = require("./presence");
const { AdBlocker } = require("./ad-blocker");

const DEV = process.argv.includes("--dev");
const START_HIDDEN = process.argv.includes("--hidden"); // Windows açılışında tepside başla
const SITE_URL = (process.env.ANIMKE_URL || (DEV ? "http://localhost:3000" : "https://animke.com")).replace(/\/$/, "");
const SITE_ORIGINS = new Set([new URL(SITE_URL).origin, "https://animke.com", "https://www.animke.com"]);
// "Discord ile giriş" penceresi bu adreslerde uygulama içinde açılır.
const OAUTH_HOSTS = ["discord.com", "tangible-roadrunner.pikapod.net"];
const TITLEBAR_HEIGHT = 38;
const BG = "#090d16";
const ICON_PATH = path.join(__dirname, "..", "build", "icon.png");

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

// Geliştirme modu kurulu uygulamanın ayarlarına/oturumuna dokunmasın ve
// kurulu uygulama açıkken de çalışabilsin.
if (DEV) app.setPath("userData", path.join(app.getPath("appData"), "Animke-dev"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null; // BaseWindow
let siteView = null; // site (WebContentsView)
let titleView = null; // başlık çubuğu (WebContentsView)
let presence = null;
let tray = null;
let isQuitting = false; // true değilken çarpı pencereyi tepsiye gizler
let htmlFullScreen = false; // video tam ekranı: başlık çubuğu gizlenir
const adBlocker = new AdBlocker();
const log = (msg) => DEV && console.log(msg);
const site = () => siteView?.webContents;

// --- Ayarlar ----------------------------------------------------------------------
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const settings = { adBlock: true, discord: true, openAtLogin: false, trayHintShown: false };
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

// --- Pencere boyutu/konumu hatırlansın -------------------------------------------
const statePath = () => path.join(app.getPath("userData"), "window-state.json");
function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return { width: 1400, height: 860 };
  }
}
function saveWindowState() {
  try {
    if (!win || win.isDestroyed()) return;
    fs.writeFileSync(statePath(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
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

// --- Pencere ----------------------------------------------------------------------
function layout() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  const bar = htmlFullScreen || win.isFullScreen() ? 0 : TITLEBAR_HEIGHT;
  titleView.setBounds({ x: 0, y: 0, width, height: bar });
  siteView.setBounds({ x: 0, y: bar, width, height: Math.max(0, height - bar) });
}

function sendTitlebarState() {
  const wc = site();
  if (!titleView || !wc || wc.isDestroyed()) return;
  titleView.webContents.send("titlebar:state", {
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
    title: wc.getTitle(),
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  presence?.setSuspended(false);
}

// Çarpıya basınca: pencere gizlenir, uygulama tepside çalışmaya devam eder.
function hideToTray() {
  if (!win) return;
  // Gizli pencerede ses gelmesin: tüm çerçevelerdeki videoları duraklat.
  for (const frame of site()?.mainFrame.framesInSubtree || []) {
    frame.executeJavaScript("document.querySelectorAll('video').forEach(v => v.pause())").catch(() => {});
  }
  presence?.setSuspended(true);
  win.hide();
  if (!settings.trayHintShown && tray) {
    settings.trayHintShown = true;
    saveSettings();
    tray.displayBalloon({
      iconType: "info",
      title: "Animke arka planda çalışıyor",
      content: "Hızlı açılması için tepside bekliyor. Tamamen kapatmak için simgeye sağ tıklayıp Çıkış'ı seç.",
    });
  }
}

function createWindow() {
  const state = loadWindowState();
  win = new BaseWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 420,
    minHeight: 500,
    backgroundColor: BG,
    title: "Animke",
    icon: ICON_PATH,
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: BG, symbolColor: "#cbd5e1", height: TITLEBAR_HEIGHT },
  });

  siteView = new WebContentsView({
    webPreferences: {
      ...secureWebPreferences,
      preload: path.join(__dirname, "preload.js"),
      // Preload başka sitelerin oynatıcı iframe'lerinde de çalışsın
      // (gerçek video süresini okumak ve reklam pencerelerini engellemek için).
      nodeIntegrationInSubFrames: true,
    },
  });
  siteView.setBackgroundColor(BG);
  titleView = new WebContentsView({
    webPreferences: { ...secureWebPreferences, preload: path.join(__dirname, "titlebar", "titlebar-preload.js") },
  });
  titleView.setBackgroundColor(BG);
  win.contentView.addChildView(siteView);
  win.contentView.addChildView(titleView);

  layout();
  for (const event of ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "restore"]) {
    win.on(event, layout);
  }
  if (state.maximized) win.maximize();

  win.on("close", (event) => {
    saveWindowState();
    if (!isQuitting) {
      event.preventDefault();
      hideToTray();
    }
  });
  // Windows kapanırken/oturum kapanırken tepside beklemeye çalışma, kapan.
  win.on("session-end", () => {
    isQuitting = true;
  });

  titleView.webContents.loadFile(path.join(__dirname, "titlebar", "titlebar.html"));
  titleView.webContents.once("did-finish-load", () => {
    sendTitlebarState();
    if (!START_HIDDEN) showWindow();
  });

  const wc = siteView.webContents;
  for (const event of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"]) {
    wc.on(event, sendTitlebarState);
  }

  // Video tam ekranı: başlık çubuğunu gizle, pencereyi tam ekran yap.
  wc.on("enter-html-full-screen", () => {
    htmlFullScreen = true;
    win.setFullScreen(true);
    layout();
  });
  wc.on("leave-html-full-screen", () => {
    htmlFullScreen = false;
    win.setFullScreen(false);
    layout();
  });

  // Site görünümü Animke'den başka bir adrese gidemez; o bağlantılar tarayıcıda açılır.
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
          parent: win,
          autoHideMenuBar: true,
          backgroundColor: BG,
          icon: ICON_PATH,
          webPreferences: { ...secureWebPreferences },
        },
      };
    }
    openExternal(url);
    return { action: "deny" };
  });

  // Klavye kısayolları.
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    let handled = true;
    if (key === "f5" || (input.control && key === "r")) wc.reload();
    else if (key === "f11") win.setFullScreen(!win.isFullScreen());
    else if (input.alt && key === "arrowleft" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (input.alt && key === "arrowright" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (input.control && (key === "=" || key === "+")) wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4));
    else if (input.control && key === "-") wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
    else if (input.control && key === "0") wc.setZoomLevel(0);
    else if (DEV && input.control && input.shift && key === "i") wc.toggleDevTools();
    else handled = false;
    if (handled) event.preventDefault();
  });

  // Site açılamazsa (internet yok) basit bir hata sayfası.
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: iptal edildi (normal)
    const html = `<!doctype html><meta charset="utf-8"><title>Bağlantı yok</title>
      <body style="background:${BG};color:#e5e7eb;font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
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

  wc.loadURL(SITE_URL);
}

// --- Başlık çubuğu komutları --------------------------------------------------------
ipcMain.on("titlebar:command", (event, name, payload) => {
  if (!titleView || event.sender !== titleView.webContents) return;
  const wc = site();
  if (!wc) return;
  switch (name) {
    case "back":
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      break;
    case "forward":
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      break;
    case "reload":
      wc.reload();
      break;
    case "home":
      wc.loadURL(SITE_URL);
      break;
    case "toggle-maximize":
      win.isMaximized() ? win.unmaximize() : win.maximize();
      break;
    case "settings": {
      const x = Number(payload?.x) || 0;
      const y = Number(payload?.y) || TITLEBAR_HEIGHT;
      buildSettingsMenu().popup({ window: win, x, y });
      break;
    }
  }
});

// --- Sayfalardan gelen mesajlar -------------------------------------------------------
const frameKey = (event) => `${event.sender.id}:${event.senderFrame?.processId}:${event.senderFrame?.routingId}`;
const fromSiteView = (event) => siteView && event.sender === siteView.webContents;

ipcMain.on("animke:version", (event) => {
  event.returnValue = app.getVersion();
});

ipcMain.on("animke:activity", (event, info) => {
  // Yalnızca ana çerçevedeki Animke sayfası durum ayarlayabilir.
  if (!fromSiteView(event) || event.senderFrame !== event.sender.mainFrame) return;
  if (!isSiteUrl(event.senderFrame.url)) return;
  presence?.setInfo(info);
});

ipcMain.on("animke:translator", (event, name) => {
  if (!fromSiteView(event) || event.senderFrame !== event.sender.mainFrame) return;
  if (!isSiteUrl(event.senderFrame.url)) return;
  presence?.setTranslator(typeof name === "string" ? name.slice(0, 80) : "");
});

ipcMain.on("animke:video", (event, state) => {
  if (!fromSiteView(event)) return;
  if (state !== null) {
    const currentTime = Number(state?.currentTime);
    const duration = Number(state?.duration);
    if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0 || duration > 6 * 3600) return;
    state = { currentTime, duration, paused: !!state.paused };
  }
  presence?.updateVideo(frameKey(event), state);
});

// --- Otomatik güncelleme ----------------------------------------------------------------
// Yeni sürümler herkese açık GitHub deposundan (iEmre1/animke-desktop) arka planda
// indirilir; hazır olunca kullanıcıya yeniden başlatmak isteyip istemediği sorulur.
let updateCheckManual = false;
let updateReady = null;
// electron-updater uygulama hazır olduktan sonra yüklenir (yalnızca paketlenmiş sürümde).
let autoUpdater = null;
function setupAutoUpdater() {
  if (DEV || !app.isPackaged) return;
  ({ autoUpdater } = require("electron-updater"));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", async (info) => {
    updateReady = info.version;
    tray?.setContextMenu(buildSettingsMenu());
    if (!win?.isVisible()) return; // tepside bekliyorsa rahatsız etme; menüde görünür
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      title: "Animke",
      message: `Yeni sürüm hazır (${info.version})`,
      detail: 'Şimdi yeniden başlatıp güncellemek ister misin? "Sonra" dersen uygulamadan çıktığında kurulur.',
      buttons: ["Yeniden başlat", "Sonra"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) installUpdateNow();
  });
  autoUpdater.on("update-not-available", () => {
    if (!updateCheckManual) return;
    updateCheckManual = false;
    dialog.showMessageBox(win, {
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
    dialog.showMessageBox(win, {
      type: "warning",
      title: "Animke",
      message: "Güncelleme denetlenemedi",
      detail: "İnternet bağlantını kontrol edip daha sonra tekrar dene.",
    });
  });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

function installUpdateNow() {
  isQuitting = true;
  autoUpdater?.quitAndInstall();
}

// --- Windows açılınca başlat ---------------------------------------------------------
function applyOpenAtLogin() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ["--hidden"] });
}

// --- Ayarlar menüsü (başlık çubuğundaki "Ayarlar" ve tepsi simgesi) -------------------
function buildSettingsMenu() {
  return Menu.buildFromTemplate([
    { label: `Animke ${app.getVersion()}`, enabled: false },
    ...(updateReady
      ? [{ label: `Güncellemeyi kur ve yeniden başlat (${updateReady})`, click: installUpdateNow }]
      : []),
    { type: "separator" },
    { label: "Animke'yi göster", click: showWindow },
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
        tray?.setContextMenu(buildSettingsMenu());
        site()?.reload();
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
        tray?.setContextMenu(buildSettingsMenu());
      },
    },
    {
      label: "Windows açılınca başlat",
      type: "checkbox",
      checked: settings.openAtLogin,
      enabled: app.isPackaged,
      click: (item) => {
        settings.openAtLogin = item.checked;
        saveSettings();
        applyOpenAtLogin();
        tray?.setContextMenu(buildSettingsMenu());
      },
    },
    { type: "separator" },
    {
      label: "Güncellemeleri denetle",
      enabled: app.isPackaged,
      click: () => {
        updateCheckManual = true;
        autoUpdater?.checkForUpdates().catch(() => {});
      },
    },
    { label: "Kaynak kodu (GitHub)", click: () => openExternal("https://github.com/iEmre1/animke-desktop") },
    { type: "separator" },
    {
      label: "Çıkış",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Animke");
  tray.setContextMenu(buildSettingsMenu());
  tray.on("click", showWindow);
}

// --- Video oynarken ekran uyumasın -------------------------------------------------------
let keepAwakeId = null;
function updateKeepAwake() {
  const video = presence?.currentVideo();
  const playing = !!video && !video.paused && !!win?.isVisible();
  if (playing && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start("prevent-display-sleep");
  } else if (!playing && keepAwakeId !== null) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
}

// Site görünümü ve başlık çubuğu dışındaki pencereler (Discord giriş penceresi)
// yeni pencere açamaz; bağlantıları tarayıcıda açılır. <webview> kullanılamaz.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  setImmediate(() => {
    if (contents === siteView?.webContents) return;
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });
    if (contents === titleView?.webContents) {
      contents.on("will-navigate", (event) => event.preventDefault());
    }
  });
});

// --- Uygulama yaşam döngüsü ------------------------------------------------------------
app.on("second-instance", showWindow);
app.on("before-quit", () => {
  isQuitting = true;
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId("com.animke.desktop");

  // Sitenin istemediği izinleri (kamera, mikrofon, konum...) reddet; tam ekran ve bildirim serbest.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["fullscreen", "notifications", "clipboard-sanitized-write"].includes(permission));
  });

  loadSettings();
  applyOpenAtLogin();
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
