// localStorage-backed settings/history/favorites, mirroring the Android
// app's Prefs.kt. Browser localStorage is per-origin already, so no key
// prefixing beyond a shared namespace is needed.

const KEY_PREFIX = "ytdictationweb.";
const MAX_HISTORY = 100;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(KEY_PREFIX + key, JSON.stringify(value));
}

export const settings = {
  get linesPerSlot() {
    return clampInt(readJson("linesPerSlot", 3), 1, 5);
  },
  set linesPerSlot(v) {
    writeJson("linesPerSlot", clampInt(v, 1, 5));
  },
  get slotSeconds() {
    return clampInt(readJson("slotSeconds", 15), 5, 60);
  },
  set slotSeconds(v) {
    writeJson("slotSeconds", clampInt(v, 5, 60));
  },
  get slotMode() {
    return readJson("slotMode", "both");
  },
  set slotMode(v) {
    writeJson("slotMode", v);
  },
  get subtitlePosition() {
    return readJson("subtitlePosition", "top");
  },
  set subtitlePosition(v) {
    writeJson("subtitlePosition", v);
  },
  get subtitleColor() {
    return readJson("subtitleColor", "#4CAF50");
  },
  set subtitleColor(v) {
    writeJson("subtitleColor", v);
  },
  get subtitleHighlightColor() {
    return readJson("subtitleHighlightColor", "#000000");
  },
  set subtitleHighlightColor(v) {
    writeJson("subtitleHighlightColor", v);
  },
  get subtitleTwoLines() {
    return readJson("subtitleTwoLines", false);
  },
  set subtitleTwoLines(v) {
    writeJson("subtitleTwoLines", v);
  },
  get playbackSpeed() {
    return readJson("playbackSpeed", 1);
  },
  set playbackSpeed(v) {
    writeJson("playbackSpeed", v);
  },
  // Breadcrumb of the last Drive folder browsed (array of {id, name}), so
  // reopening Drive picks up where you left off instead of always starting
  // at "My Drive" -- deep folder structures otherwise mean re-navigating
  // every single time.
  get driveLastPath() {
    return readJson("driveLastPath", null);
  },
  set driveLastPath(v) {
    writeJson("driveLastPath", v);
  },
  // Floating/movable video mode -- remembered across videos and sessions so
  // it doesn't need re-enabling and re-positioning every time.
  get floatingEnabled() {
    return readJson("floatingEnabled", false);
  },
  set floatingEnabled(v) {
    writeJson("floatingEnabled", v);
  },
  get floatBox() {
    return readJson("floatBox", null); // {left, top, width} in px, or null before it's ever been positioned
  },
  set floatBox(v) {
    writeJson("floatBox", v);
  },
  get resumePillPos() {
    return readJson("resumePillPos", null); // {left, top} in px, or null to use the default corner position
  },
  set resumePillPos(v) {
    writeJson("resumePillPos", v);
  },
  get likedBadgePos() {
    return readJson("likedBadgePos", null); // {left, top} in px, or null to use the default corner position
  },
  set likedBadgePos(v) {
    writeJson("likedBadgePos", v);
  },
};

export function history() {
  return readJson("history", []);
}

export function recordHistory(entry) {
  const updated = [entry, ...history().filter((h) => h.videoId !== entry.videoId)];
  writeJson("history", updated.slice(0, MAX_HISTORY));
}

export function favorites() {
  return readJson("favorites", []);
}

export function isFavorite(videoId) {
  return favorites().some((f) => f.videoId === videoId);
}

export function toggleFavorite(video) {
  const current = favorites();
  const updated = current.some((f) => f.videoId === video.videoId)
    ? current.filter((f) => f.videoId !== video.videoId)
    : [video, ...current];
  writeJson("favorites", updated);
}

function clampInt(v, min, max) {
  return Math.max(min, Math.min(max, Math.round(v)));
}
