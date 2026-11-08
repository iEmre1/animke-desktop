// Discord durumunu yönetir: siteden gelen anime bilgisi (başlık, sezon/bölüm,
// kapak) + sayfadaki herhangi bir çerçevedeki <video>'nun gerçek süresi.
// Uygulama içinde başka sitelerin oynatıcılarına (iframe) de erişebildiğimiz için
// gerçek dakika gösterilebiliyor; tarayıcıda bu mümkün değil.

const { DiscordRPC } = require("./discord-rpc");

const VIDEO_STALE_MS = 15_000; // bu süredir haber gelmeyen video yok sayılır
const RETRY_MS = 15_000;

const truncate = (s, max) => {
  const str = String(s || "").trim();
  return [...str].length > max ? [...str].slice(0, max - 1).join("") + "…" : str;
};
const atLeast2 = (s) => (s.length >= 2 ? s : s.padEnd(2, " "));
const isHttps = (u) => {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};
const isHttp = (u) => {
  try {
    return ["https:", "http:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};

class PresenceManager {
  constructor({ siteUrl, log = () => {} }) {
    this.siteUrl = siteUrl;
    this.log = log;
    this.rpc = new DiscordRPC();
    this.enabled = true;
    this.suspended = false; // pencere tepsiye gizlendiyse durum gösterilmez
    this.info = null; // { title, subtitle, image, url, openedAt }
    this.translator = ""; // izlenen çevirinin (fansub) adı
    this.videos = new Map(); // frameKey -> { currentTime, duration, paused, at }
    this.lastSentKey = "";
    this.lastStart = 0;
    this.lastTry = 0;
    this.active = false;
    this.timer = setInterval(() => this.tick(), 5_000);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.tick(true);
  }

  setSuspended(suspended) {
    this.suspended = !!suspended;
    this.tick(true);
  }

  setInfo(info) {
    if (!info || !info.title) {
      this.info = null;
    } else {
      const sameEpisode =
        this.info && this.info.title === info.title && this.info.subtitle === info.subtitle;
      this.info = {
        title: String(info.title),
        subtitle: String(info.subtitle || ""),
        image: String(info.image || ""),
        url: String(info.url || ""),
        openedAt: sameEpisode ? this.info.openedAt : Date.now(),
      };
    }
    this.tick(true);
  }

  setTranslator(name) {
    this.translator = String(name || "").trim();
    this.tick();
  }

  updateVideo(frameKey, state) {
    if (!state) {
      this.videos.delete(frameKey);
    } else {
      this.videos.set(frameKey, { ...state, at: Date.now() });
    }
    this.tick();
  }

  removeFramesWithPrefix(prefix) {
    for (const key of this.videos.keys()) if (key.startsWith(prefix)) this.videos.delete(key);
  }

  currentVideo() {
    const now = Date.now();
    let best = null;
    for (const [key, v] of this.videos) {
      if (now - v.at > VIDEO_STALE_MS) {
        this.videos.delete(key);
        continue;
      }
      // Oynayan video öncelikli, sonra en uzun (reklam videolarını elemek için).
      if (!best || (!v.paused && best.paused) || (v.paused === best.paused && v.duration > best.duration)) {
        best = v;
      }
    }
    return best;
  }

  buildActivity() {
    const info = this.info;
    const video = this.currentVideo();
    const paused = video ? video.paused : false;

    const activity = {
      type: 3, // "İzliyor"
      status_display_type: 2, // üye listesinde anime adı görünsün
      details: atLeast2(truncate(info.title, 128)),
    };
    // "Sezon 1 · Bölüm 3 · FansubAdı"
    let state = truncate([info.subtitle, this.translator].filter(Boolean).join(" · "), 100);
    if (paused) state = truncate(`${state} · Duraklatıldı`.replace(/^ · /, ""), 128);
    if (state) activity.state = atLeast2(state);

    let start = 0;
    if (video && !paused && video.duration > 0) {
      start = Date.now() - Math.max(0, Math.min(video.currentTime, video.duration)) * 1000;
      activity.timestamps = { start: Math.round(start), end: Math.round(start + video.duration * 1000) };
    } else if (!video) {
      start = info.openedAt; // video okunamadıysa: bölüm açılalı geçen süre
      activity.timestamps = { start };
    }

    const assets = { small_image: `${this.siteUrl}/icon.png`, small_text: "Animke" };
    if (isHttps(info.image) && info.image.length <= 256) {
      assets.large_image = info.image;
      assets.large_text = atLeast2(truncate(info.title, 128));
    }
    activity.assets = assets;

    if (isHttp(info.url) && info.url.length <= 512) {
      activity.buttons = [{ label: "Animke'de İzle", url: info.url }];
    }

    const key = JSON.stringify([info.title, info.subtitle, this.translator, info.image, info.url, paused, !!video]);
    return { activity, key, start };
  }

  async tick(force = false) {
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    try {
      if (!this.enabled || this.suspended || !this.info) {
        if (this.active) {
          await this.rpc.setActivity(null).catch(() => {});
          this.active = false;
          this.lastSentKey = "";
        }
        return;
      }

      const { activity, key, start } = this.buildActivity();
      const seeked = Math.abs(start - this.lastStart) > 3_000;
      const unchanged = key === this.lastSentKey && !seeked;
      if (unchanged && this.active) return;
      if (!force && !this.active && Date.now() - this.lastTry < RETRY_MS && key === this.lastSentKey) return;

      this.lastTry = Date.now();
      this.lastSentKey = key;
      this.lastStart = start;
      try {
        await this.rpc.setActivity(activity);
        this.active = true;
        this.log(`Discord durumu: ${activity.details} | ${activity.state || ""}${activity.timestamps?.end ? " (gerçek süre)" : ""}`);
      } catch (err) {
        this.active = false;
        if (this.rpc.connected) {
          // Eski Discord sürümleri bazı alanları reddedebilir; sade hâliyle dene.
          delete activity.status_display_type;
          delete activity.buttons;
          await this.rpc
            .setActivity(activity)
            .then(() => (this.active = true))
            .catch((e) => this.log(`Discord: ${e.message}`));
        } else {
          this.log(`Discord: ${err.message}`);
        }
      }
    } finally {
      this.busy = false;
      if (this.pending) {
        this.pending = false;
        setImmediate(() => this.tick());
      }
    }
  }

  async dispose() {
    clearInterval(this.timer);
    await this.rpc.setActivity(null).catch(() => {});
    this.rpc.close();
  }
}

module.exports = { PresenceManager };
