// Reklam engelleme (EasyList tabanlı Ghostery filtreleri).
//
// Yalnızca ağ istekleri engellenir; Animke'nin kendi adresleri ve sitenin
// kullandığı servisler (PocketBase, AniList, Discord) asla engellenmez.
// Filtre listesi diske kaydedilir (internetsiz de çalışır) ve haftada bir
// kendiliğinden yenilenir; yenileme başarısız olursa eski liste kullanılmaya
// devam eder.

const path = require("node:path");
const fs = require("node:fs/promises");
const { app, session } = require("electron");
const { ElectronBlocker } = require("@ghostery/adblocker-electron");

const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 1 hafta
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // tepside uzun süre açık kalırsa diye

const FIRST_PARTY_HOSTS = [
  "animke.com",
  "localhost",
  "pikapod.net",
  "anilist.co",
  "discord.com",
  "discordapp.com",
  "githubusercontent.com",
  "github.com",
  // Sitenin kendi ziyaretçi istatistikleri (Google Analytics) engellenmesin.
  "googletagmanager.com",
  "google-analytics.com",
];

const isFirstParty = (raw) => {
  try {
    const host = new URL(raw).hostname;
    return FIRST_PARTY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return true; // ayrıştırılamayan adres: dokunma
  }
};

const cachePath = () => path.join(app.getPath("userData"), "adblock-engine.bin");

async function cacheAge() {
  try {
    const stat = await fs.stat(cachePath());
    return Date.now() - stat.mtimeMs;
  } catch {
    return Infinity;
  }
}

/** İnternetten güncel listeyi indirir ve diske yazar. */
async function downloadEngine() {
  const engine = await ElectronBlocker.fromPrebuiltAdsOnly(fetch);
  await fs.writeFile(cachePath(), engine.serialize());
  return engine;
}

/** Diskteki listeyi okur (yoksa indirir). */
async function loadEngine() {
  try {
    return ElectronBlocker.deserialize(await fs.readFile(cachePath()));
  } catch {
    return downloadEngine();
  }
}

class AdBlocker {
  constructor() {
    this.blocker = null;
    this.enabled = false;
    this.handlerInstalled = false;
    this.refreshTimer = null;
  }

  async refreshIfStale() {
    if ((await cacheAge()) < REFRESH_AFTER_MS) return;
    try {
      this.blocker = await downloadEngine();
    } catch (err) {
      // çevrimdışı vb.: eski liste ile devam
      console.warn("Reklam filtreleri yenilenemedi:", err?.message || err);
    }
  }

  async enable() {
    try {
      if (!this.blocker) this.blocker = await loadEngine();
    } catch (err) {
      console.warn("Reklam filtreleri yüklenemedi:", err?.message || err);
      return false;
    }
    this.enabled = true;

    if (!this.handlerInstalled) {
      this.handlerInstalled = true;
      session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
        // Ana sayfa yüklemesi ve Animke'nin kendi istekleri her zaman serbest.
        if (!this.enabled || !this.blocker || details.resourceType === "mainFrame" || isFirstParty(details.url)) {
          callback({});
          return;
        }
        this.blocker.onBeforeRequest(details, callback);
      });
    }

    // Liste eskiyse arka planda yenile; uygulama günlerce açık kalırsa da kontrol et.
    this.refreshIfStale();
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.enabled && this.refreshIfStale(), CHECK_EVERY_MS);
    }
    return true;
  }

  disable() {
    this.enabled = false;
  }
}

module.exports = { AdBlocker };
