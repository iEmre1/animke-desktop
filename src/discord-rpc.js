// Discord Rich Presence — Discord masaüstü uygulamasının yerel IPC kanalı üzerinden.
// Harici paket yok. Protokol: [op uint32 LE][uzunluk uint32 LE][JSON]
//   op 0 = el sıkışma, op 1 = komut/yanıt, op 2 = kapat.

const net = require("node:net");
const path = require("node:path");

// Sitedeki "Discord ile giriş" uygulaması; durumdaki "… izliyor" adı buradan gelir.
const CLIENT_ID = "1568664150836772964";

function pipePaths() {
  const paths = [];
  for (let i = 0; i < 10; i++) {
    if (process.platform === "win32") {
      paths.push(`\\\\.\\pipe\\discord-ipc-${i}`);
    } else {
      const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || "/tmp";
      paths.push(path.join(dir, `discord-ipc-${i}`));
    }
  }
  return paths;
}

function connectTo(pipe) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

class DiscordRPC {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.nonce = 0;
    this.connecting = null;
  }

  get connected() {
    return !!this.socket;
  }

  send(op, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    const header = Buffer.alloc(8);
    header.writeUInt32LE(op, 0);
    header.writeUInt32LE(body.length, 4);
    this.socket.write(Buffer.concat([header, body]));
  }

  next(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error("Discord yanıt vermedi"));
      }, timeoutMs);
      this.waiters.push({
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readUInt32LE(0);
      const len = this.buffer.readUInt32LE(4);
      if (this.buffer.length < 8 + len) break;
      const raw = this.buffer.subarray(8, 8 + len).toString("utf8");
      this.buffer = this.buffer.subarray(8 + len);
      if (op === 2) {
        this.close();
        return;
      }
      let msg = null;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      this.waiters.shift()?.resolve(msg);
    }
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w.reject(new Error("Discord bağlantısı kapandı")));
    socket?.destroy();
  }

  async connect() {
    if (this.socket) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let socket = null;
      for (const pipe of pipePaths()) {
        try {
          socket = await connectTo(pipe);
          break;
        } catch {
          // sonraki kanalı dene
        }
      }
      if (!socket) throw new Error("Discord çalışmıyor");

      this.socket = socket;
      socket.on("data", (d) => this.onData(d));
      socket.on("error", () => this.close());
      socket.on("close", () => {
        if (this.socket === socket) this.close();
      });

      this.send(0, { v: 1, client_id: CLIENT_ID });
      const ready = await this.next();
      if (ready?.evt !== "READY") {
        this.close();
        throw new Error("Discord el sıkışması başarısız");
      }
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** activity null ise durumu temizler. */
  async setActivity(activity) {
    if (!activity && !this.socket) return;
    await this.connect();
    const nonce = String(++this.nonce);
    this.send(1, { cmd: "SET_ACTIVITY", nonce, args: { pid: process.pid, activity } });
    const reply = await this.next();
    if (reply?.evt === "ERROR") {
      throw new Error(`Discord durumu reddetti: ${JSON.stringify(reply.data)}`);
    }
  }
}

module.exports = { DiscordRPC };
