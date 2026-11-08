// Windows bildirimleri: listendeki animelerin yeni bölümleri ve yorumlarına
// gelen yanıtlar. Uygulama tepside beklerken de çalışır.
//
// Kimin giriş yaptığı sitenin kendi oturumundan okunur (yalnızca kullanıcı
// kimliği ve adı); PocketBase'e herkese açık sorgular atılır, şifre/token
// hiçbir yere gönderilmez.

const { Notification } = require("electron");

const PB_URL = "https://tangible-roadrunner.pikapod.net";
const POLL_MS = 10 * 60 * 1000; // 10 dakikada bir
const FIRST_POLL_MS = 45 * 1000;
const WATCH_STATUSES = ["watching", "plan to watch", "plan_to_watch", "on hold", "on_hold"];
const ID_RE = /^[a-z0-9]{15}$/;

const pbDate = (d) => new Date(d).toISOString().replace("T", " "); // PocketBase biçimi
const q = (value) => `"${String(value).replace(/["\\]/g, "")}"`;
const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

async function pbList(collection, params) {
  const url = new URL(`${PB_URL}/api/collections/${collection}/records`);
  for (const [k, v] of Object.entries({ perPage: 200, skipTotal: 1, ...params })) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`PocketBase ${collection}: ${res.status}`);
  return (await res.json()).items || [];
}

class Notifier {
  /**
   * @param {object} opts
   * @param {() => Promise<{id: string, username: string} | null>} opts.getUser  giriş yapan kullanıcı
   * @param {(path: string) => void} opts.openPath  bildirime tıklanınca sitede açılacak sayfa
   * @param {object} opts.settings  kalıcı ayarlar (lastEpisodeCheck, lastCommentCheck, notify*)
   * @param {() => void} opts.save
   * @param {string} opts.icon
   */
  constructor({ getUser, openPath, settings, save, icon, log = () => {} }) {
    Object.assign(this, { getUser, openPath, settings, save, icon, log });
    this.notified = new Set(settings.notifiedEpisodes || []);
    this.timer = null;
  }

  start() {
    if (!Notification.isSupported()) return;
    // İlk açılışta geçmişe dönük bildirim yağmasın: şu andan itibaren başla.
    const now = new Date().toISOString();
    this.settings.lastEpisodeCheck ||= now;
    this.settings.lastCommentCheck ||= now;
    this.save();
    setTimeout(() => this.poll(), FIRST_POLL_MS);
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  async poll() {
    let user = null;
    try {
      user = await this.getUser();
    } catch {
      return;
    }
    if (!user || !ID_RE.test(user.id)) return;
    if (this.settings.notifyEpisodes) await this.checkEpisodes(user).catch((e) => this.log(`bölüm bildirimi: ${e.message}`));
    if (this.settings.notifyReplies) await this.checkReplies(user).catch((e) => this.log(`yanıt bildirimi: ${e.message}`));
  }

  show(title, body, path) {
    const n = new Notification({ title, body, icon: this.icon, silent: false });
    n.on("click", () => this.openPath(path));
    n.show();
  }

  // --- Yeni bölümler --------------------------------------------------------
  async checkEpisodes(user) {
    const since = this.settings.lastEpisodeCheck;
    const checkedAt = new Date().toISOString();

    const statusFilter = WATCH_STATUSES.map((s) => `status=${q(s)}`).join("||");
    const bookmarks = await pbList("bookmarks", {
      filter: `user=${q(user.id)} && (${statusFilter})`,
      fields: "animeId,animeTitle",
    });
    const titles = new Map(); // anilistId -> başlık
    for (const b of bookmarks) if (/^\d+$/.test(String(b.animeId))) titles.set(String(b.animeId), b.animeTitle || "Anime");
    if (!titles.size) {
      this.settings.lastEpisodeCheck = checkedAt;
      this.save();
      return;
    }

    // Katalogda bir dizinin sezonları farklı animecix_id'lerle tutuluyor.
    const cixToAnilist = new Map();
    for (const ids of chunk([...titles.keys()], 40)) {
      const animes = await pbList("animes", {
        // anilist_id bazı kayıtlarda sayı, bazılarında metin olarak tutuluyor.
        filter: ids.map((id) => `anilist_id=${id}||anilist_id=${q(id)}`).join("||"),
        fields: "anilist_id,animecix_id",
      });
      for (const a of animes) if (a.animecix_id) cixToAnilist.set(String(a.animecix_id), String(a.anilist_id));
    }

    const fresh = [];
    for (const ids of chunk([...cixToAnilist.keys()], 40)) {
      const episodes = await pbList("episodes", {
        filter: `created>${q(pbDate(since))} && (${ids.map((id) => `anime_id=${q(id)}`).join("||")})`,
        fields: "anime_id,episode_number,season_number,created",
        sort: "created",
      });
      for (const ep of episodes) {
        const anilistId = cixToAnilist.get(String(ep.anime_id));
        const season = Number(ep.season_number) > 0 ? Number(ep.season_number) : 1;
        const number = Number(ep.episode_number);
        if (!anilistId || !number) continue;
        // Aynı bölümü farklı çeviriler yüklese de tek bildirim.
        const key = `${anilistId}|${season}|${number}`;
        if (this.notified.has(key)) continue;
        this.notified.add(key);
        fresh.push({ anilistId, season, number, title: titles.get(anilistId) });
      }
    }

    this.settings.lastEpisodeCheck = checkedAt;
    this.settings.notifiedEpisodes = [...this.notified].slice(-500);
    this.save();

    if (fresh.length > 3) {
      const names = [...new Set(fresh.map((f) => f.title))];
      this.show(
        "Yeni bölümler çıktı",
        `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` ve ${names.length - 3} anime daha` : ""}`,
        "/",
      );
      return;
    }
    for (const f of fresh) {
      const season = f.season > 1 ? `&season=${f.season}` : "";
      this.show(
        f.title,
        `${f.season > 1 ? `Sezon ${f.season} · ` : ""}${f.number}. bölüm yayında`,
        `/anime/watch?anime=${f.anilistId}&ep=${f.number}${season}`,
      );
    }
  }

  // --- Yorum yanıtları ve bahsetmeler ---------------------------------------
  async checkReplies(user) {
    const since = this.settings.lastCommentCheck;
    const checkedAt = new Date().toISOString();
    const safeName = /^[\w.-]{1,40}$/.test(user.username || "") ? user.username : "";
    const mention = safeName ? ` || content~${q(`@${safeName}`)}` : "";

    const comments = await pbList("comments", {
      filter: `created>${q(pbDate(since))} && user!=${q(user.id)} && parent!="" && (parent.user=${q(user.id)}${mention})`,
      expand: "user,parent",
      fields: "id,content,animeId,episodeNumber,parent,expand.user.username,expand.parent.user",
      sort: "created",
      perPage: 20,
    });
    this.settings.lastCommentCheck = checkedAt;
    this.save();

    const mentionRe = safeName ? new RegExp(`@${safeName.replace(/[.-]/g, "\\$&")}(?![\\w.-])`, "i") : null;
    for (const c of comments.slice(-5)) {
      const isReply = c.expand?.parent?.user === user.id;
      if (!isReply && !(mentionRe && mentionRe.test(c.content || ""))) continue;
      const author = c.expand?.user?.username || "Biri";
      const text = String(c.content || "").replace(/\s+/g, " ").trim();
      this.show(
        isReply ? `${author} yorumuna yanıt verdi` : `${author} senden bahsetti`,
        text.length > 120 ? `${text.slice(0, 119)}…` : text,
        `/anime/watch?anime=${encodeURIComponent(c.animeId)}&ep=${Number(c.episodeNumber) || 1}#comment-${c.id}`,
      );
    }
  }
}

module.exports = { Notifier };
