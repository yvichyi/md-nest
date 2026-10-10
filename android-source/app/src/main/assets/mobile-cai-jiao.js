/* QQ-style landscape polish. A local-only favorite flag; no claim of cloud sync. */
(() => {
  "use strict";
  const heart = document.getElementById("favoriteBtn");
  const title = document.getElementById("songTitle");
  const artist = document.getElementById("songArtist");
  if (!heart || !title || !artist) return;
  const KEY = "vf.local-favorites.v1";
  let favorites = {};
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) favorites = saved;
  } catch (_) { favorites = {}; }
  const currentKey = () => {
    const name = (title.textContent || "").trim();
    const singer = (artist.textContent || "").trim();
    if (!name || name === "声音，是时间的另一种形状。") return "";
    return name + "\u0000" + singer;
  };
  function paint() {
    const key = currentKey();
    const liked = Boolean(key && favorites[key]);
    heart.disabled = !key;
    heart.classList.toggle("is-favorite", liked);
    heart.setAttribute("aria-pressed", String(liked));
    heart.setAttribute("aria-label",
      liked ? "从本地喜欢列表中移除" : "收藏当前歌曲到本地喜欢列表");
  }
  heart.addEventListener("click", () => {
    const key = currentKey();
    if (!key) return;
    if (favorites[key]) delete favorites[key];
    else favorites[key] = true;
    try { localStorage.setItem(KEY, JSON.stringify(favorites)); } catch (_) {}
    paint();
  });
  const observer = new MutationObserver(paint);
  observer.observe(title, {childList:true,characterData:true,subtree:true});
  observer.observe(artist, {childList:true,characterData:true,subtree:true});
  paint();
})();
