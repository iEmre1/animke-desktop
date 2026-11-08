// Başlık çubuğu (yerel dosya) için dar arayüz: yalnızca belirli komutlar gönderilir.
const { contextBridge, ipcRenderer } = require("electron");

const COMMANDS = new Set(["back", "forward", "reload", "home", "settings", "toggle-maximize"]);

contextBridge.exposeInMainWorld("titlebar", {
  command: (name, payload) => {
    if (COMMANDS.has(name)) ipcRenderer.send("titlebar:command", name, payload ?? null);
  },
  onState: (callback) => {
    ipcRenderer.on("titlebar:state", (_event, state) => callback(state));
  },
});
