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
  floatAspect: 16 / 9,
};

let slotController = null;
let ytPlayer = null;
let pollTimer = null;
let localVideoObjectUrl = null;
let remotePollTimer = null;
let remoteLastSeenAt = 0;
let floatDrag = null; // {mode: "move"|"resize", startX, startY, startLeft, startTop, startWidth}

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
  el("subtitle-highlight-input").value = storage.settings.subtitleHighlightColor;
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
  if (slotController) layoutVideoAndSubtitles();
});
el("subtitle-color-input").addEventListener("input", (e) => {
  storage.settings.subtitleColor = e.target.value;
  render();
});
el("subtitle-highlight-input").addEventListener("input", (e) => {
  storage.settings.subtitleHighlightColor = e.target.value;
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
  state.floatAspect = 16 / 9; // YouTube's embed is always 16:9
  applyFloatingLayout();
  applyResumePillPosition();
  applyLikedBadgePosition();
  updateLikedBadge();

  destroyPlayer(); // replaces both player elements with fresh nodes -- must happen before the visibility toggles below

  el("yt-player-wrapper").classList.remove("hidden");
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
  updateLikedBadge(); // hides it -- local/Drive video has no favorite identity to check
  state.floatAspect = 16 / 9; // corrected below once the file's real dimensions are known

  destroyPlayer(); // replaces #local-video-player with a fresh node -- must happen before grabbing videoEl below

  el("yt-player-wrapper").classList.add("hidden");
  const videoEl = el("local-video-player");
  videoEl.classList.remove("hidden");
  applyFloatingLayout(); // after destroyPlayer(), which would otherwise wipe out the sizing this sets on local-video-player
  applyResumePillPosition();

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
    if (videoEl.videoWidth && videoEl.videoHeight) {
      state.floatAspect = videoEl.videoWidth / videoEl.videoHeight;
      layoutVideoAndSubtitles(); // corrects the fit now that the file's real aspect ratio (not the 16:9 default) is known
    }
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
  }, 500);
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

// ---------- Floating video ----------

function currentFloatAspect() {
  return state.floatAspect || 16 / 9;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Applies (or removes) the floating box's position/size from storage, so a
// previously-enabled float mode resumes automatically on the next video
// instead of needing to be turned back on and re-positioned every time.
function applyFloatingLayout() {
  const container = el("player-container");
  const enabled = storage.settings.floatingEnabled;
  container.classList.toggle("floating", enabled);
  el("float-drag-handle").classList.toggle("hidden", !enabled);
  el("float-resize-handle").classList.toggle("hidden", !enabled);
  if (!enabled) {
    container.style.left = "";
    container.style.top = "";
    container.style.width = "";
    container.style.height = "";
  } else {
    const aspect = currentFloatAspect();
    const saved = storage.settings.floatBox;
    const width = clamp(saved?.width ?? Math.min(240, window.innerWidth - 24), 100, window.innerWidth - 8);
    const height = width / aspect;
    const left = clamp(saved?.left ?? window.innerWidth - width - 12, 0, Math.max(0, window.innerWidth - width));
    const top = clamp(saved?.top ?? 80, 0, Math.max(0, window.innerHeight - height));
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    container.style.left = `${left}px`;
    container.style.top = `${top}px`;
  }
  layoutVideoAndSubtitles();
}

// Sizes the actual video content (not just its container) to a true
// aspect-fitted rect, and moves the subtitle box into any real dead space
// next to it (full width) instead of overlaying the picture, whenever
// there's enough of it to be worth using -- e.g. a 16:9 video in a taller
// portrait viewport, or a shrunk floating box. Falls back to the normal
// overlay (.pos-top/.pos-bottom) when the video already fills the
// container in that dimension, so nothing changes for a landscape video
// filling a landscape screen. Runs after any container size/position
// change, or the video's aspect ratio becoming known.
function layoutVideoAndSubtitles() {
  const container = el("player-container");
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  if (!cw || !ch) return;
  const aspect = currentFloatAspect();

  let vw, vh;
  if (cw / ch > aspect) {
    vh = ch;
    vw = vh * aspect;
  } else {
    vw = cw;
    vh = vw / aspect;
  }
  const vx = (cw - vw) / 2;
  const vy = (ch - vh) / 2;

  for (const id of ["yt-player-wrapper", "local-video-player"]) {
    const videoEl = el(id);
    videoEl.style.left = `${vx}px`;
    videoEl.style.top = `${vy}px`;
    videoEl.style.width = `${vw}px`;
    videoEl.style.height = `${vh}px`;
  }

  const MIN_DEADSPACE = 44; // px -- below this it's not worth relocating subtitles into
  const spaceBelow = ch - (vy + vh);
  const spaceAbove = vy;
  const pos = storage.settings.subtitlePosition;
  const subtitleBox = el("subtitle-box");
  if (pos === "bottom" && spaceBelow >= MIN_DEADSPACE) {
    subtitleBox.classList.add("in-deadspace");
    subtitleBox.style.top = `${vy + vh}px`;
    subtitleBox.style.height = `${spaceBelow}px`;
  } else if (pos === "top" && spaceAbove >= MIN_DEADSPACE) {
    subtitleBox.classList.add("in-deadspace");
    subtitleBox.style.top = "0px";
    subtitleBox.style.height = `${spaceAbove}px`;
  } else {
    subtitleBox.classList.remove("in-deadspace");
    subtitleBox.style.top = "";
    subtitleBox.style.height = "";
  }
}

el("btn-toggle-float").addEventListener("click", () => {
  storage.settings.floatingEnabled = !storage.settings.floatingEnabled;
  applyFloatingLayout();
});

// Dragging/resizing happens via two small dedicated handle elements rather
// than the video body itself -- a YouTube embed is a cross-origin iframe,
// and touches landing on it never reach this page's own pointer listeners,
// so grabbing the video directly wouldn't work for YouTube playback at all.
el("float-drag-handle").addEventListener("pointerdown", (e) => {
  const rect = el("player-container").getBoundingClientRect();
  floatDrag = { mode: "move", startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
});

el("float-resize-handle").addEventListener("pointerdown", (e) => {
  const rect = el("player-container").getBoundingClientRect();
  floatDrag = { mode: "resize", startX: e.clientX, startY: e.clientY, startWidth: rect.width };
});

window.addEventListener("pointermove", (e) => {
  if (!floatDrag) return;
  const container = el("player-container");
  if (floatDrag.mode === "move") {
    const width = container.offsetWidth;
    const height = container.offsetHeight;
    const left = clamp(floatDrag.startLeft + (e.clientX - floatDrag.startX), 0, Math.max(0, window.innerWidth - width));
    const top = clamp(floatDrag.startTop + (e.clientY - floatDrag.startY), 0, Math.max(0, window.innerHeight - height));
    container.style.left = `${left}px`;
    container.style.top = `${top}px`;
  } else {
    const rect = container.getBoundingClientRect();
    const aspect = currentFloatAspect();
    // Cap by whichever edge (right or bottom) the box would hit first, so
    // a tall/narrow video (e.g. a vertically-shot phone recording) can't be
    // resized past the bottom of the screen just because it still has
    // horizontal room.
    const maxWidthByRight = window.innerWidth - rect.left - 8;
    const maxWidthByBottom = (window.innerHeight - rect.top - 8) * aspect;
    const width = clamp(floatDrag.startWidth + (e.clientX - floatDrag.startX), 100, Math.min(maxWidthByRight, maxWidthByBottom));
    container.style.width = `${width}px`;
    container.style.height = `${width / aspect}px`;
  }
  layoutVideoAndSubtitles();
});

window.addEventListener("resize", () => {
  if (slotController) layoutVideoAndSubtitles();
});

// ---------- Screen lock ----------

let lockSwipeStart = null;
let lastLockIconTap = 0;

el("btn-lock-screen").addEventListener("click", () => {
  el("lock-overlay").classList.remove("hidden");
});

function unlockScreen() {
  el("lock-overlay").classList.add("hidden");
}

// Primary unlock: swipe up starting from near the bottom-center of the
// screen. Backup unlock (asked for explicitly, in case the swipe is
// unreliable or hard to discover): double-tap the lock icon within the
// overlay -- its own tap also bubbles up to these same listeners, but a
// plain tap never satisfies the swipe-distance check below, so it's a
// harmless no-op there.
el("lock-overlay").addEventListener("pointerdown", (e) => {
  lockSwipeStart = { x: e.clientX, y: e.clientY };
});
el("lock-overlay").addEventListener("pointerup", (e) => {
  if (!lockSwipeStart) return;
  const start = lockSwipeStart;
  lockSwipeStart = null;
  const startedNearBottomCenter =
    start.y > window.innerHeight * 0.8 && Math.abs(start.x - window.innerWidth / 2) < window.innerWidth * 0.25;
  const movedUpFarEnough = start.y - e.clientY > window.innerHeight * 0.15;
  const stayedRoughlyVertical = Math.abs(e.clientX - start.x) < window.innerWidth * 0.3;
  if (startedNearBottomCenter && movedUpFarEnough && stayedRoughlyVertical) {
    unlockScreen();
  }
});
el("lock-overlay").addEventListener("pointercancel", () => {
  lockSwipeStart = null;
});
el("lock-icon").addEventListener("click", () => {
  const now = Date.now();
  if (now - lastLockIconTap < 600) unlockScreen();
  lastLockIconTap = now;
});

// ---------- Screen off (audio-only) ----------

// Purely a visual toggle -- playback keeps running underneath, so audio
// keeps playing, but nothing is rendered except one big play/pause button.
// This is unrelated to (and much simpler than) actually keeping audio
// playing after leaving the app or locking the phone, which is a genuine
// OS-level restriction -- see the autopictureinpicture attribute on
// #local-video-player for the closest real answer to that, which only
// applies to local/Drive video, not YouTube's embedded iframe.
el("btn-screen-off").addEventListener("click", () => {
  el("screen-off-overlay").classList.remove("hidden");
  render();
});
el("screen-off-playpause").addEventListener("click", (e) => {
  e.stopPropagation(); // don't also trigger the overlay's own tap-to-exit handler below
  slotController?.togglePlayPause();
});
el("screen-off-overlay").addEventListener("click", () => {
  el("screen-off-overlay").classList.add("hidden");
});

function endFloatDrag() {
  if (!floatDrag) return;
  floatDrag = null;
  const container = el("player-container");
  storage.settings.floatBox = {
    left: parseFloat(container.style.left) || 0,
    top: parseFloat(container.style.top) || 0,
    width: parseFloat(container.style.width) || container.offsetWidth,
  };
}
window.addEventListener("pointerup", endFloatDrag);
window.addEventListener("pointercancel", endFloatDrag);

el("btn-player-back").addEventListener("click", () => {
  destroyPlayer();
  showScreen("search");
});
el("btn-prev-slot").addEventListener("click", () => slotController?.channelDown());
el("btn-next-slot").addEventListener("click", () => slotController?.channelUp());
el("btn-play-pause").addEventListener("click", () => slotController?.togglePlayPause());
el("btn-toggle-overlay").addEventListener("click", () => slotController?.toggleOverlay());
// Draggable/relocatable, remembered across videos -- same idea as the
// floating video box, but simpler (position only, no resize/aspect ratio).
// A plain element in our own page (not a cross-origin iframe like YouTube),
// so it can be dragged directly rather than needing a separate handle.
let resumeDrag = null;
let resumePillJustDragged = false;

function applyResumePillPosition() {
  const pill = el("resume-pill");
  const pos = storage.settings.resumePillPos;
  if (!pos) {
    pill.style.left = "";
    pill.style.top = "";
    pill.style.right = "";
    pill.style.bottom = "";
    return;
  }
  const width = pill.offsetWidth || 120;
  const height = pill.offsetHeight || 44;
  pill.style.right = "auto";
  pill.style.bottom = "auto";
  pill.style.left = `${clamp(pos.left, 0, Math.max(0, window.innerWidth - width))}px`;
  pill.style.top = `${clamp(pos.top, 0, Math.max(0, window.innerHeight - height))}px`;
}

el("resume-pill").addEventListener("pointerdown", (e) => {
  const rect = el("resume-pill").getBoundingClientRect();
  resumeDrag = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top, moved: false };
});
window.addEventListener("pointermove", (e) => {
  if (!resumeDrag) return;
  const dx = e.clientX - resumeDrag.startX;
  const dy = e.clientY - resumeDrag.startY;
  if (Math.abs(dx) > 6 || Math.abs(dy) > 6) resumeDrag.moved = true;
  if (!resumeDrag.moved) return;
  const pill = el("resume-pill");
  const width = pill.offsetWidth;
  const height = pill.offsetHeight;
  pill.style.right = "auto";
  pill.style.bottom = "auto";
  pill.style.left = `${clamp(resumeDrag.startLeft + dx, 0, Math.max(0, window.innerWidth - width))}px`;
  pill.style.top = `${clamp(resumeDrag.startTop + dy, 0, Math.max(0, window.innerHeight - height))}px`;
});
window.addEventListener("pointerup", () => {
  if (!resumeDrag) return;
  const wasMoved = resumeDrag.moved;
  resumeDrag = null;
  if (!wasMoved) return;
  resumePillJustDragged = true;
  const pill = el("resume-pill");
  storage.settings.resumePillPos = { left: parseFloat(pill.style.left), top: parseFloat(pill.style.top) };
});
window.addEventListener("pointercancel", () => {
  resumeDrag = null;
});

el("resume-pill").addEventListener("click", () => {
  if (resumePillJustDragged) {
    resumePillJustDragged = false; // this click is the tail end of a drag, not a tap -- skip the resume action
    return;
  }
  slotController?.channelUp();
});
function updateLikedBadge() {
  const liked = !!state.currentVideo && storage.isFavorite(state.currentVideo.videoId);
  el("liked-badge").classList.toggle("hidden", !liked);
}

el("btn-favorite").addEventListener("click", () => {
  if (!state.currentVideo) return;
  storage.toggleFavorite(state.currentVideo);
  el("btn-favorite").textContent = storage.isFavorite(state.currentVideo.videoId) ? "♥" : "♡";
  updateLikedBadge();
});

// Draggable/relocatable and remembered across videos, just like the resume
// pill above -- a plain always-on-top marker, not a button, so it's just
// dragged directly with no tap action to distinguish from a drag.
let likedBadgeDrag = null;

function applyLikedBadgePosition() {
  const badge = el("liked-badge");
  const pos = storage.settings.likedBadgePos;
  if (!pos) {
    badge.style.left = "";
    badge.style.top = "";
    badge.style.right = "";
    return;
  }
  const width = badge.offsetWidth || 32;
  const height = badge.offsetHeight || 32;
  badge.style.right = "auto";
  badge.style.left = `${clamp(pos.left, 0, Math.max(0, window.innerWidth - width))}px`;
  badge.style.top = `${clamp(pos.top, 0, Math.max(0, window.innerHeight - height))}px`;
}

el("liked-badge").addEventListener("pointerdown", (e) => {
  const rect = el("liked-badge").getBoundingClientRect();
  likedBadgeDrag = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
});
window.addEventListener("pointermove", (e) => {
  if (!likedBadgeDrag) return;
  const badge = el("liked-badge");
  const width = badge.offsetWidth;
  const height = badge.offsetHeight;
  badge.style.right = "auto";
  badge.style.left = `${clamp(likedBadgeDrag.startLeft + (e.clientX - likedBadgeDrag.startX), 0, Math.max(0, window.innerWidth - width))}px`;
  badge.style.top = `${clamp(likedBadgeDrag.startTop + (e.clientY - likedBadgeDrag.startY), 0, Math.max(0, window.innerHeight - height))}px`;
});
window.addEventListener("pointerup", () => {
  if (!likedBadgeDrag) return;
  likedBadgeDrag = null;
  const badge = el("liked-badge");
  storage.settings.likedBadgePos = { left: parseFloat(badge.style.left), top: parseFloat(badge.style.top) };
});
window.addEventListener("pointercancel", () => {
  likedBadgeDrag = null;
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
    const bubbleStyle = `color:${storage.settings.subtitleColor};background-color:${storage.settings.subtitleHighlightColor}`;
    subtitleBox.innerHTML = `<div class="bubble" style="${bubbleStyle}">${escapeHtml(slotController.currentSubtitleText)}</div>`;
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

  el("screen-off-playpause").textContent = slotController.isPlaying ? "⏸" : "▶";
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
