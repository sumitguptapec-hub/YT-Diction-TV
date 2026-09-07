import { initAuth, signIn, getStoredToken, clearStoredToken } from "./auth.js";
import { searchYouTube, fetchCues } from "./youtubeApi.js";
import { SlotController } from "./slotController.js";
import * as storage from "./storage.js";

const el = (id) => document.getElementById(id);
const screens = ["signin", "search", "history", "favorites", "settings", "player"];

const state = {
  accessToken: null,
  searchResults: [],
  currentVideo: null, // { videoId, title, channelTitle, thumbnailUrl }
  resumePositionSec: 0,
};

let slotController = null;
let ytPlayer = null;
let pollTimer = null;

// Polling instead of relying on window.onYouTubeIframeAPIReady: that global
// callback races against this being a deferred module script -- on-device
// testing found YouTube's iframe_api script can call it before this module
// ever attaches its own handler, so window.YT.Player ends up ready with
// nothing here ever finding out. Polling for window.YT directly sidesteps
// the ordering question entirely.
function whenYouTubeApiReady(callback) {
  if (window.YT && window.YT.Player) {
    callback();
    return;
  }
  const interval = setInterval(() => {
    if (window.YT && window.YT.Player) {
      clearInterval(interval);
      callback();
    }
  }, 50);
}

function showScreen(name) {
  for (const s of screens) el(`screen-${s}`).classList.toggle("hidden", s !== name);
}

function currentConfig() {
  return {
    linesPerSlot: storage.settings.linesPerSlot,
    slotSeconds: storage.settings.slotSeconds,
    mode: storage.settings.slotMode,
  };
}

// ---------- Sign-in ----------

el("btn-signin").addEventListener("click", async () => {
  el("signin-error").textContent = "";
  try {
    const token = await signIn();
    state.accessToken = token;
    showScreen("search");
  } catch (e) {
    el("signin-error").textContent = "Sign-in failed: " + e.message;
  }
});

el("btn-signout").addEventListener("click", () => {
  clearStoredToken();
  state.accessToken = null;
  showScreen("signin");
});

// ---------- Search ----------

el("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = el("search-input").value.trim();
  if (!query || !state.accessToken) return;
  el("search-status").textContent = "Searching…";
  el("search-results").innerHTML = "";
  try {
    const results = await searchYouTube(query, state.accessToken);
    state.searchResults = results;
    el("search-status").textContent = results.length === 0 ? `No results for "${query}".` : "";
    renderSearchResults(results);
  } catch (err) {
    el("search-status").textContent = "Search failed: " + err.message;
  }
});

function renderSearchResults(results) {
  const grid = el("search-results");
  grid.innerHTML = "";
  for (const r of results) {
    const card = document.createElement("div");
    card.className = "grid-item";
    card.innerHTML = `
      <img src="${r.thumbnailUrl}" alt="" loading="lazy" />
      <div class="meta">
        <div class="title">${escapeHtml(r.title)}</div>
        <div class="channel">${escapeHtml(r.channelTitle)}</div>
      </div>`;
    card.addEventListener("click", () => openVideo(r));
    grid.appendChild(card);
  }
}

el("btn-history").addEventListener("click", () => {
  renderList(el("history-list"), storage.history());
  showScreen("history");
});
el("btn-favorites").addEventListener("click", () => {
  renderList(el("favorites-list"), storage.favorites());
  showScreen("favorites");
});
el("btn-settings").addEventListener("click", () => {
  syncSettingsUi();
  showScreen("settings");
});

function renderList(container, items) {
  container.innerHTML = "";
  for (const v of items) {
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `
      <img src="${v.thumbnailUrl}" alt="" loading="lazy" />
      <div>
        <div class="title">${escapeHtml(v.title)}</div>
        <div class="channel">${escapeHtml(v.channelTitle)}</div>
      </div>`;
    row.addEventListener("click", () => openVideo(v));
    container.appendChild(row);
  }
}

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showScreen("search"));
});

// ---------- Settings ----------

function syncSettingsUi() {
  el("val-linesPerSlot").textContent = storage.settings.linesPerSlot;
  el("val-slotSeconds").textContent = storage.settings.slotSeconds + "s";
  el("val-speed").textContent = formatSpeed(storage.settings.playbackSpeed);
  el("subtitle-color-input").value = storage.settings.subtitleColor;
  el("two-lines-toggle").checked = storage.settings.subtitleTwoLines;
  setActiveSegment("mode-selector", "mode", storage.settings.slotMode);
  setActiveSegment("position-selector", "position", storage.settings.subtitlePosition);
}

function setActiveSegment(containerId, attr, value) {
  document.querySelectorAll(`#${containerId} button`).forEach((b) => {
    b.classList.toggle("active", b.dataset[attr] === value);
  });
}

document.querySelectorAll('[data-step="linesPerSlot"]').forEach((b) =>
  b.addEventListener("click", () => {
    storage.settings.linesPerSlot = storage.settings.linesPerSlot + Number(b.dataset.delta);
    slotController?.onSlotConfigChanged();
    syncSettingsUi();
    renderOverlayLiveValues();
  })
);
document.querySelectorAll('[data-step="slotSeconds"]').forEach((b) =>
  b.addEventListener("click", () => {
    storage.settings.slotSeconds = storage.settings.slotSeconds + Number(b.dataset.delta);
    slotController?.onSlotConfigChanged();
    syncSettingsUi();
    renderOverlayLiveValues();
  })
);
el("mode-selector").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  storage.settings.slotMode = btn.dataset.mode;
  slotController?.onSlotConfigChanged();
  syncSettingsUi();
});
el("position-selector").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-position]");
  if (!btn) return;
  storage.settings.subtitlePosition = btn.dataset.position;
  syncSettingsUi();
  render();
});
el("subtitle-color-input").addEventListener("input", (e) => {
  storage.settings.subtitleColor = e.target.value;
  render();
});
el("two-lines-toggle").addEventListener("change", (e) => {
  storage.settings.subtitleTwoLines = e.target.checked;
  render();
});
function stepSpeed(delta) {
  const steps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const idx = steps.indexOf(storage.settings.playbackSpeed);
  const next = steps[Math.max(0, Math.min(steps.length - 1, (idx < 0 ? 3 : idx) + delta))];
  storage.settings.playbackSpeed = next;
  slotController?.applySpeed(next);
  syncSettingsUi();
  renderOverlayLiveValues();
}
el("speed-down").addEventListener("click", () => stepSpeed(-1));
el("speed-up").addEventListener("click", () => stepSpeed(1));
el("live-speed-down").addEventListener("click", () => stepSpeed(-1));
el("live-speed-up").addEventListener("click", () => stepSpeed(1));
function formatSpeed(s) {
  return Number.isInteger(s) ? `${s}x` : `${s}x`;
}

// ---------- Player ----------

function openVideo(video) {
  const hist = storage.history();
  const saved = hist.find((h) => h.videoId === video.videoId);
  state.resumePositionSec = saved?.lastPositionSec ?? 0;
  state.currentVideo = video;
  storage.recordHistory({ ...video, watchedAtEpochMs: Date.now(), lastPositionSec: state.resumePositionSec });

  showScreen("player");
  el("overlay-title").textContent = video.title;
  el("overlay-channel").textContent = video.channelTitle;
  el("btn-favorite").textContent = storage.isFavorite(video.videoId) ? "♥" : "♡";

  destroyPlayer();

  slotController = new SlotController({
    currentConfig,
    initialPositionSec: state.resumePositionSec,
    onPositionSave: (seconds) => {
      if (!state.currentVideo) return;
      storage.recordHistory({ ...state.currentVideo, watchedAtEpochMs: Date.now(), lastPositionSec: seconds });
    },
    onChange: render,
  });

  const load = () => {
    ytPlayer = new YT.Player("yt-player", {
      videoId: video.videoId,
      playerVars: { controls: 0, iv_load_policy: 3, cc_load_policy: 0, rel: 0, fs: 0, playsinline: 1 },
      events: {
        onReady: () => {
          slotController.attachPlayer(makePlaybackPort(ytPlayer));
          ytPlayer.seekTo(state.resumePositionSec, true);
          ytPlayer.playVideo();
          slotController.applySpeed(storage.settings.playbackSpeed);
          try { ytPlayer.unloadModule("captions"); } catch {}
          startPolling();
        },
        onStateChange: (e) => {
          slotController.onStateChange(e.data === YT.PlayerState.PLAYING);
          try { ytPlayer.unloadModule("captions"); } catch {}
        },
        onError: (e) => slotController.onPlaybackError(String(e.data)),
      },
    });
  };
  whenYouTubeApiReady(load);

  fetchCues(video.videoId).then((cues) => slotController.onCuesLoaded(cues));
}

function makePlaybackPort(player) {
  return {
    play: () => player.playVideo(),
    pause: () => player.pauseVideo(),
    seekTo: (seconds) => player.seekTo(seconds, true),
    setSpeed: (speed) => player.setPlaybackRate(speed),
  };
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
    const duration = ytPlayer.getDuration();
    if (duration > 0) slotController.onDuration(duration);
    slotController.onSecond(ytPlayer.getCurrentTime());
  }, 250);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function destroyPlayer() {
  stopPolling();
  slotController?.flushPosition();
  if (ytPlayer) {
    try { ytPlayer.destroy(); } catch {}
    ytPlayer = null;
  }
  slotController = null;
  el("yt-player").outerHTML = '<div id="yt-player"></div>';
}

el("btn-player-back").addEventListener("click", () => {
  destroyPlayer();
  showScreen("search");
});
el("btn-prev-slot").addEventListener("click", () => slotController?.channelDown());
el("btn-next-slot").addEventListener("click", () => slotController?.channelUp());
el("btn-play-pause").addEventListener("click", () => slotController?.togglePlayPause());
el("btn-toggle-overlay").addEventListener("click", () => slotController?.toggleOverlay());
el("resume-pill").addEventListener("click", () => slotController?.channelUp());
el("btn-favorite").addEventListener("click", () => {
  if (!state.currentVideo) return;
  storage.toggleFavorite(state.currentVideo);
  el("btn-favorite").textContent = storage.isFavorite(state.currentVideo.videoId) ? "♥" : "♡";
});

// Keyboard shortcuts -- a web-appropriate stand-in for the TV remote's
// physical buttons. Space/Enter mirrors the Android app's "OK also steps
// forward" behavior; arrow keys map to prev/next slot and 10s seek, which
// reads more naturally on a keyboard than the TV's seconds-adjustment
// mapping would.
document.addEventListener("keydown", (e) => {
  if (el("screen-player").classList.contains("hidden") || !slotController) return;
  switch (e.code) {
    case "Space":
    case "Enter":
      e.preventDefault();
      slotController.channelUp();
      break;
    case "ArrowUp":
      slotController.channelUp();
      break;
    case "ArrowDown":
      slotController.channelDown();
      break;
    case "ArrowRight":
      slotController.seekRelative(10);
      break;
    case "ArrowLeft":
      slotController.seekRelative(-10);
      break;
    case "KeyC":
      slotController.toggleOverlay();
      break;
  }
});

// ---------- Render ----------

function render() {
  if (!slotController) return;

  const subtitleBox = el("subtitle-box");
  if (slotController.currentSubtitleText) {
    subtitleBox.classList.remove("hidden");
    subtitleBox.classList.toggle("pos-top", storage.settings.subtitlePosition === "top");
    subtitleBox.classList.toggle("pos-bottom", storage.settings.subtitlePosition === "bottom");
    subtitleBox.innerHTML = `<div class="bubble" style="color:${storage.settings.subtitleColor}">${escapeHtml(slotController.currentSubtitleText)}</div>`;
    if (storage.settings.subtitleTwoLines && slotController.nextSubtitleText) {
      subtitleBox.innerHTML += `<div id="subtitle-next" style="color:${storage.settings.subtitleColor}">${escapeHtml(slotController.nextSubtitleText)}</div>`;
    }
  } else {
    subtitleBox.classList.add("hidden");
  }

  const hud = el("hud");
  if (slotController.hudText) {
    hud.textContent = slotController.hudText;
    hud.classList.remove("hidden");
  } else {
    hud.classList.add("hidden");
  }

  el("resume-pill").classList.toggle("hidden", slotController.isPlaying);

  const timeline = el("timeline");
  if (slotController.showTimeline && slotController.durationSec > 0) {
    timeline.classList.remove("hidden");
    const pct = Math.min(100, Math.max(0, (slotController.lastKnownSecond / slotController.durationSec) * 100));
    el("timeline-fill").style.width = pct + "%";
    el("time-current").textContent = formatTime(slotController.lastKnownSecond);
    el("time-duration").textContent = formatTime(slotController.durationSec);
  } else {
    timeline.classList.add("hidden");
  }

  el("player-overlay").classList.toggle("hidden", !slotController.overlayVisible);
  if (slotController.overlayVisible) {
    const label = slotController.isReady
      ? `Slot ${slotController.activeSlotIndex + 1} of ${slotController.slots.length}`
      : "Loading…";
    const captionNote = slotController.isReady && !slotController.hasCaptions
      ? ` — no captions, using ${storage.settings.slotSeconds}s pacing`
      : "";
    el("overlay-slot-info").textContent = label + captionNote;
    renderOverlayLiveValues();
  }
}

function renderOverlayLiveValues() {
  el("live-linesPerSlot").textContent = storage.settings.linesPerSlot;
  el("live-slotSeconds").textContent = storage.settings.slotSeconds + "s";
  el("live-speed").textContent = formatSpeed(storage.settings.playbackSpeed);
}

function formatTime(totalSeconds) {
  const total = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---------- Boot ----------

function boot() {
  initAuth();
  const token = getStoredToken();
  if (token) {
    state.accessToken = token;
    showScreen("search");
  } else {
    showScreen("signin");
  }
}
boot();
