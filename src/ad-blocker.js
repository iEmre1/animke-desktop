// Reklam engelleme (EasyList tabanlı Ghostery filtreleri).
//
// Yalnızca ağ istekleri engellenir; Animke'nin kendi adresleri ve sitenin
// kullandığı servisler (PocketBase, AniList, Discord) asla engellenmez.
// Filtre listesi ilk açılışta indirilir ve diske kaydedilir; sonraki
// açılışlarda internetsiz de çalışır.

const path = require("node:path");
const fs = require("node:fs/promises");
const { app, session } = require("electron");
const { ElectronBlocker } = require("@ghostery/adblocker-electron");

const FIRST_PARTY_HOSTS = [
  "animke.com",
  "localhost",
  "pikapod.net",
  "anilist.co",
  "discord.com",
  "discordapp.com",
  "githubusercontent.com",
  "github.com",
];

const isFirstParty = (raw) => {
  try {
    const host = new URL(raw).hostname;
    return FIRST_PARTY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return true; // ayrıştırılamayan adres: dokunma
  }
};

class AdBlocker {
  constructor() {
    this.blocker = null;
    this.enabled = false;
    this.blockedCount = 0;
  }

  async load() {
    if (this.blocker) return;
    const cachePath = path.join(app.getPath("userData"), "adblock-engine.bin");
    this.blocker = await ElectronBlocker.fromPrebuiltAdsOnly(fetch, {
      path: cachePath,
      read: fs.readFile,
      write: fs.writeFile,
    });
  }

  async enable() {
    try {
      await this.load();
    } catch (err) {
      console.warn("Reklam filtreleri yüklenemedi:", err?.message || err);
      return false;
    }
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      // Ana sayfa yüklemesi ve Animke'nin kendi istekleri her zaman serbest.
      if (!this.enabled || details.resourceType === "mainFrame" || isFirstParty(details.url)) {
        callback({});
        return;
      }
      this.blocker.onBeforeRequest(details, (response) => {
        if (response?.cancel) this.blockedCount++;
        callback(response);
      });
    });
    this.enabled = true;
    return true;
  }

  disable() {
    this.enabled = false;
    session.defaultSession.webRequest.onBeforeRequest(null);
  }
}

module.exports = { AdBlocker };
