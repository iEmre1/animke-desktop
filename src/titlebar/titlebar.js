// Başlık çubuğunun düğmeleri. `window.titlebar` arayüzü titlebar-preload.js'den gelir.
const $ = (id) => document.getElementById(id);

$("back").addEventListener("click", () => window.titlebar.command("back"));
$("forward").addEventListener("click", () => window.titlebar.command("forward"));
$("reload").addEventListener("click", () => window.titlebar.command("reload"));
$("home").addEventListener("click", () => window.titlebar.command("home"));
$("pip").addEventListener("click", () => window.titlebar.command("pip"));
$("settings").addEventListener("click", (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  window.titlebar.command("settings", { x: Math.round(rect.left), y: Math.round(rect.bottom) });
});

// Başlık çubuğuna çift tıklayınca pencere büyür/küçülür (Windows alışkanlığı).
document.querySelector(".bar").addEventListener("dblclick", (e) => {
  if (e.target.closest("button")) return;
  window.titlebar.command("toggle-maximize");
});

window.titlebar.onState((state) => {
  $("back").disabled = !state.canGoBack;
  $("forward").disabled = !state.canGoForward;
  $("pip").disabled = !state.hasVideo;
  $("reload").classList.toggle("loading", !!state.loading);
  $("title").textContent = state.title || "Animke";
  document.title = state.title || "Animke";
});
