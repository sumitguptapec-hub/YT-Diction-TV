import { initAuth, signIn, getStoredToken, clearStoredToken, completeRedirectSignIn } from "./auth.js";
import { searchYouTube, fetchCues } from "./youtubeApi.js";
import { SlotController } from "./slotController.js";
import { parseSrt } from "./srtParser.js";
import { initDriveAuth, signInToDrive, getStoredDriveToken, completeDriveRedirectSignIn } from "./driveAuth.js";
import * as driveApi from "./driveApi.js";
import * as storage from "./storage.js";

const el = (id) => document.getElementById(id);
const screens = ["signin", "search", "history", "favorites", "settings", "player", "drive"];

const state = {
  accessToken: null,
  searchResults: [],
  currentVideo: null, // { videoId, title, channelTitle, thumbnailUrl }
  resumePositionSec: 0,
};

let slotController = null;
let ytPlayer = null;
let pollTimer = null;
let localVideoObjectUrl = null;
let remotePollTimer = null;
let remoteLastSeenAt = 0;

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

// ---------- Drive ----------

// Breadcrumb of picked folders; last = current folder. Starts at "My
// Drive" -- same idea as the Android app's LocalBrowseScreen dirStack.
let driveDirStack = [{ id: driveApi.ROOT_FOLDER_ID, name: "My Drive" }];

el("btn-drive").addEventListener("click", async () => {
  driveDirStack = storage.settings.driveLastPath || [{ id: driveApi.ROOT_FOLDER_ID, name: "My Drive" }];
  showScreen("drive");
  let token = getStoredDriveToken();
  if (!token) {
    el("drive-status").textContent = "Requesting Drive access…";
    try {
      token = await signInToDrive();
    } catch (err) {
      el("drive-status").textContent = "Drive access failed: " + err.message;
      return;
    }
  }
  loadDriveFolder();
});

el("btn-drive-back").addEventListener("click", () => {
  if (driveDirStack.length > 1) {
    driveDirStack = driveDirStack.slice(0, -1);
    storage.settings.driveLastPath = driveDirStack;
    loadDriveFolder();
  } else {
    showScreen("search");
  }
});

async function loadDriveFolder() {
  const token = getStoredDriveToken();
  const current = driveDirStack[driveDirStack.length - 1];
  el("drive-folder-name").textContent = current.name;
  el("drive-grid").innerHTML = "";
  el("drive-status").textContent = "Loading…";
  try {
    const entries = await driveApi.listEntries(current.id, token);
    el("drive-status").textContent = entries.length === 0 ? "No videos found in this folder." : "";
    renderDriveGrid(entries);
  } catch (err) {
    el("drive-status").textContent = "Couldn't load Drive folder: " + err.message;
  }
}

function renderDriveGrid(entries) {
  const grid = el("drive-grid");
  grid.innerHTML = "";
  for (const entry of entries) {
    const card = document.createElement("div");
    card.className = "grid-item";
    if (entry.type === "folder") {
      card.innerHTML = `<div class="meta" style="text-align:center;padding:20px 0;font-size:40px;">📁</div><div class="meta"><div class="title">${escapeHtml(entry.name)}</div></div>`;
      card.addEventListener("click", () => {
        driveDirStack = [...driveDirStack, { id: entry.id, name: entry.name }];
        storage.settings.driveLastPath = driveDirStack;
        loadDriveFolder();
      });
    } else {
      const icon = entry.srtFileId ? "🎬 CC" : "🎬";
      card.innerHTML = `<div class="meta" style="text-align:center;padding:20px 0;font-size:32px;">${icon}</div><div class="meta"><div class="title">${escapeHtml(entry.name)}</div></div>`;
      card.addEventListener("click", () => openDriveVideo(entry));
    }
    grid.appendChild(card);
  }
}

// Drive videos have to be downloaded in full before they can play (see
// README) -- a large file can take a while, and res.blob() gives no
// feedback during that wait, which looks exactly like a hang. Reading the
// stream by hand lets the status line show real download progress instead.
async function fetchBlobWithProgress(url, options, onProgress) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const total = parseInt(res.headers.get("Content-Length") || "0", 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  return new Blob(chunks);
}

async function openDriveVideo(entry) {
  const token = getStoredDriveToken();
  el("drive-status").textContent = "Downloading video…";
  try {
    const blob = await fetchBlobWithProgress(
      driveApi.mediaUrl(entry.id),
      { headers: { Authorization: `Bearer ${token}` } },
      (received, total) => {
        const mb = (received / 1048576).toFixed(1);
        el("drive-status").textContent = total
          ? `Downloading video… ${Math.round((received / total) * 100)}% (${mb} MB)`
          : `Downloading video… ${mb} MB`;
      }
    );
    el("drive-status").textContent = "";
    const ctrl = playBlobAsVideo(blob, { title: entry.name, subtitle: "Google Drive" });
    if (entry.srtFileId) {
      const srtText = await driveApi.fetchSrtCues(entry.srtFileId, token);
      ctrl.onCuesLoaded(parseSrt(srtText));
    } else {
      ctrl.onCuesLoaded([]);
    }
  } catch (err) {
    el("drive-status").textContent = "Couldn't play video: " + err.message;
  }
}

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
  el("btn-favorite").classList.remove("hidden");
  el("btn-favorite").textContent = storage.isFavorite(video.videoId) ? "♥" : "♡";

  destroyPlayer(); // replaces both player elements with fresh nodes -- must happen before the visibility toggles below

  el("yt-player").classList.remove("hidden");
  el("local-video-player").classList.add("hidden");

  slotController = new SlotController({
    currentConfig,
    initialPositionSec: state.resumePositionSec,
    onPositionSave: (seconds) => {
      if (!state.currentVideo) return;
      storage.recordHistory({ ...state.currentVideo, watchedAtEpochMs: Date.now(), lastPositionSec: seconds });
    },
    onChange: render,
  });
  startRemotePolling();

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

// Shared by local-file and Drive playback -- both end up with a Blob to
// play and an optional cues promise, driven through the same plain <video>
// element the YouTube path's SlotController abstraction doesn't care is a
// different backend. No stable identity to key History/Favorites off
// across sessions for either source, so both skip that, same as the
// Android app's local-video handling.
function playBlobAsVideo(blob, { title, subtitle }) {
  state.currentVideo = null;
  state.resumePositionSec = 0;

  showScreen("player");
  el("overlay-title").textContent = title;
  el("overlay-channel").textContent = subtitle;
  el("btn-favorite").classList.add("hidden");

  destroyPlayer(); // replaces #local-video-player with a fresh node -- must happen before grabbing videoEl below

  el("yt-player").classList.add("hidden");
  const videoEl = el("local-video-player");
  videoEl.classList.remove("hidden");

  slotController = new SlotController({
    currentConfig,
    initialPositionSec: 0,
    onPositionSave: () => {}, // no persistent identity to save against
    onChange: render,
  });
  startRemotePolling();

  localVideoObjectUrl = URL.createObjectURL(blob);
  videoEl.src = localVideoObjectUrl;
  slotController.attachPlayer(makeVideoPlaybackPort(videoEl));

  videoEl.addEventListener("loadedmetadata", () => {
    slotController?.onDuration(videoEl.duration);
    videoEl.play();
  });
  videoEl.addEventListener("timeupdate", () => slotController?.onSecond(videoEl.currentTime));
  videoEl.addEventListener("play", () => slotController?.onStateChange(true));
  videoEl.addEventListener("pause", () => slotController?.onStateChange(false));
  videoEl.addEventListener("error", () => {
    const code = videoEl.error?.code;
    // Codes 3/4 mean the browser's media decoder rejected the file outright
    // -- the most common real-world cause is an old MPEG-4 Part 2 (Xvid/
    // DivX) codec inside the container, which no browser (not just this
    // app) can decode; only actual H.264/HEVC/VP8/VP9 content plays.
    const message =
      code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE
        ? "This browser can't decode this file's video codec (common with older MPEG-4 Part 2 / DivX / Xvid files). Re-encode it to H.264 (e.g. with the free HandBrake app) and try again."
        : "Video playback error.";
    slotController?.onPlaybackError(message);
  });

  slotController.applySpeed(storage.settings.playbackSpeed);
  return slotController;
}

// A browser can't browse a USB drive/filesystem the way the Android app
// does, but a plain file picker lets someone choose a video (and its
// matching .srt) straight from their device -- this is the web-appropriate
// equivalent.
function openLocalVideo(videoFile, srtFile) {
  const ctrl = playBlobAsVideo(videoFile, {
    title: videoFile.name.replace(/\.[^/.]+$/, ""),
    subtitle: "Local file",
  });
  if (srtFile) {
    srtFile.text().then((text) => ctrl.onCuesLoaded(parseSrt(text)));
  } else {
    ctrl.onCuesLoaded([]);
  }
}

function makeVideoPlaybackPort(videoEl) {
  return {
    play: () => videoEl.play(),
    pause: () => videoEl.pause(),
    seekTo: (seconds) => { videoEl.currentTime = seconds; },
    setSpeed: (speed) => { videoEl.playbackRate = speed; },
  };
}

el("btn-local-video").addEventListener("click", () => el("local-file-input").click());
el("local-file-input").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  const videoFile = files.find((f) => f.type.startsWith("video/") || !f.name.toLowerCase().endsWith(".srt"));
  const srtFile = files.find((f) => f.name.toLowerCase().endsWith(".srt"));
  if (videoFile) openLocalVideo(videoFile, srtFile);
  e.target.value = ""; // allow picking the same file again later
});

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

// Lets an iPhone Action Button (via a Shortcut hitting api/remote.js) drive
// next/previous slot without touching the screen -- see that file's
// comment for why polling is needed instead of a direct signal. Baselines
// against whatever command is already stored before acting on anything, so
// a stale press from before this video was even opened doesn't fire the
// instant playback starts.
async function startRemotePolling() {
  stopRemotePolling();
  try {
    const initial = await fetch("/api/remote").then((r) => r.json());
    remoteLastSeenAt = initial?.at ?? 0;
  } catch (err) {
    console.error("Remote polling: initial baseline fetch failed", err);
    remoteLastSeenAt = 0;
  }
  remotePollTimer = setInterval(async () => {
    if (!slotController) return;
    try {
      const command = await fetch("/api/remote").then((r) => r.json());
      if (command && command.at > remoteLastSeenAt) {
        remoteLastSeenAt = command.at;
        if (command.action === "prev") slotController.channelDown();
        else slotController.channelUp();
      }
    } catch (err) {
      console.error("Remote polling: poll failed", err);
    }
  }, 1500);
}

function stopRemotePolling() {
  if (remotePollTimer) clearInterval(remotePollTimer);
  remotePollTimer = null;
}

function destroyPlayer() {
  stopPolling();
  stopRemotePolling();
  slotController?.flushPosition();
  if (ytPlayer) {
    try { ytPlayer.destroy(); } catch {}
    ytPlayer = null;
  }
  slotController = null;
  el("yt-player").outerHTML = '<div id="yt-player"></div>';

  // Reset via outerHTML (not just clearing .src) so any listeners attached
  // by a previous openLocalVideo() call are dropped along with the old
  // element, instead of accumulating across repeated local-video plays.
  const oldVideoEl = el("local-video-player");
  oldVideoEl.pause();
  oldVideoEl.outerHTML = '<video id="local-video-player" class="hidden" playsinline></video>';
  if (localVideoObjectUrl) {
    URL.revokeObjectURL(localVideoObjectUrl);
    localVideoObjectUrl = null;
  }
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

  const ring = el("progress-ring");
  ring.classList.toggle("hidden", !slotController.showTimeProgress);
  if (slotController.showTimeProgress) {
    const circumference = 113.1; // 2 * PI * r(18), matches the SVG circle's radius
    el("progress-ring-fill").style.strokeDashoffset = String(circumference * (1 - slotController.timeProgress));
  }

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
  initDriveAuth();

  // Pick up a token left in the URL fragment by the iOS home-screen
  // redirect-based sign-in (see auth.js/driveAuth.js) before deciding which
  // screen to show -- on a normal browser these both just see no fragment
  // and return null immediately.
  const mainResult = completeRedirectSignIn();
  const driveResult = completeDriveRedirectSignIn();

  const token = getStoredToken();
  if (token) {
    state.accessToken = token;
    showScreen("search");
  } else {
    showScreen("signin");
    if (mainResult && !mainResult.success) {
      el("signin-error").textContent = "Sign-in failed: " + mainResult.error;
    }
  }

  if (driveResult && driveResult.success && token) {
    // Returning from the Drive-scope redirect with the token now stored --
    // reopen Drive browsing, same as if the cloud icon had just succeeded.
    el("btn-drive").click();
  }
}
boot();
