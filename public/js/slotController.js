import { buildSlots } from "./slotBuilder.js";

// Ported from the Android app's SlotController.kt. Owns the configurable
// slot-pacing playback: tracks slot boundaries built by buildSlots(),
// auto-pauses when the active slot's end is reached, and exposes
// channelUp()/channelDown() for stepping through slots manually.
//
// Backend-agnostic: attachPlayer() takes a small {play,pause,seekTo,setSpeed}
// object (a "PlaybackPort", same idea as the Android app's interface of the
// same name) so this class doesn't need to know it's driving a YouTube
// IFrame player specifically.
//
// There's no built-in per-second callback in a plain web page the way the
// Android YouTube player library provides one, so the caller is expected to
// poll player.getCurrentTime()/getDuration() on an interval and forward them
// via onSecond()/onDuration() -- exactly how the Android app's ExoPlayer
// (local/Drive video) branch already has to work.
//
// onChange is called after any state change, for a caller with no reactive
// framework to just re-render from.
export class SlotController {
  constructor({ currentConfig, onPositionSave, initialPositionSec = 0, onChange = () => {} }) {
    this.currentConfig = currentConfig;
    this.onPositionSave = onPositionSave;
    this.onChange = onChange;

    this.player = null;
    this.lastCues = [];
    this.lastSavedSecond = initialPositionSec;

    this.lastKnownSecond = initialPositionSec;
    this.showTimeline = false;
    this.hudText = null;
    this.slots = [];
    this.activeSlotIndex = 0;
    this.hasCaptions = true;
    this.isPlaying = false;
    this.durationSec = 0;
    this.currentSubtitleText = null;
    this.nextSubtitleText = null;
    this.timeProgress = 0;
    this.showTimeProgress = false;
    this.isReady = false;
    this.overlayVisible = false;

    this._resumeRequestId = 0;
    this._durationKnown = false;
    this._hideTimelineTimer = null;
    this._hideHudTimer = null;
  }

  attachPlayer(port) {
    this.player = port;
  }

  showHud(text) {
    this.hudText = text;
    clearTimeout(this._hideHudTimer);
    this._hideHudTimer = setTimeout(() => {
      this.hudText = null;
      this.onChange();
    }, 2500);
    this.onChange();
  }

  onCuesLoaded(cues) {
    if (this.isReady) return; // captions don't change mid-video
    this.isReady = true;
    this.lastCues = cues;
    this.hasCaptions = cues.length > 0;
    this._rebuildSlots();
    this.onChange();
  }

  onDuration(seconds) {
    if (!(seconds > 0)) return;
    this.durationSec = seconds;
    // Rebuild exactly once, the first time a real duration arrives -- see
    // the Android SlotController for why later re-fires must be ignored
    // (a seek can make the player re-report metadata mid-playback, and
    // rebuilding then would snap a just-advanced slot index back).
    if (!this._durationKnown) {
      this._durationKnown = true;
      this._rebuildSlots();
    }
    this.onChange();
  }

  onSecond(second) {
    this.lastKnownSecond = second;
    const currentIndex = this.lastCues.findIndex(
      (c) => this.lastKnownSecond >= c.startSec && this.lastKnownSecond < c.endSec
    );
    this.currentSubtitleText = currentIndex >= 0 ? this.lastCues[currentIndex].text : null;
    this.nextSubtitleText =
      currentIndex >= 0 && this.lastCues[currentIndex + 1] ? this.lastCues[currentIndex + 1].text : null;

    if (this.lastKnownSecond - this.lastSavedSecond >= 5) {
      this.lastSavedSecond = this.lastKnownSecond;
      this._savePosition();
    }

    const slot = this.slots[this.activeSlotIndex];
    if (slot) {
      const config = this.currentConfig();
      this.showTimeProgress = this.isReady && config.mode !== "linesOnly";
      if (this.showTimeProgress) {
        this.timeProgress = clamp((this.lastKnownSecond - slot.startSec) / config.slotSeconds, 0, 1);
      }

      // Don't evaluate the pause boundary until we know whether real
      // captions exist -- otherwise the video plays under a provisional
      // fixed-time fallback slot and pauses there, then pauses AGAIN once
      // real caption data arrives and recomputes a later true boundary.
      if (this.isReady && this.isPlaying && this.lastKnownSecond >= slot.endSec - 0.15) {
        this.player?.pause();
      }
    }
    this.onChange();
  }

  onStateChange(playing) {
    this.isPlaying = playing;
    this.onChange();
  }

  onPlaybackError(message) {
    console.error("Playback error:", message);
  }

  onSlotConfigChanged() {
    this._rebuildSlots();
    this.onChange();
  }

  toggleOverlay() {
    this.overlayVisible = !this.overlayVisible;
    this.onChange();
  }

  channelUp() {
    const slot = this.slots[this.activeSlotIndex];
    if (!slot) return;
    if (this.activeSlotIndex < this.slots.length - 1) this.activeSlotIndex += 1;
    this._seekAndPlay(slot.endSec);
  }

  channelDown() {
    if (this.activeSlotIndex > 0) this.activeSlotIndex -= 1;
    const slot = this.slots[this.activeSlotIndex];
    if (!slot) return;
    this._seekAndPlay(slot.startSec);
  }

  // A known YouTube IFrame Player quirk: calling play() in the same instant
  // as seekTo() can race and get silently dropped -- give the seek a brief
  // moment to land before asking to play, with one backup retry.
  _seekAndPlay(second) {
    const requestId = ++this._resumeRequestId;
    this.player?.seekTo(second);
    setTimeout(() => {
      if (requestId === this._resumeRequestId) this.player?.play();
    }, 200);
    setTimeout(() => {
      if (requestId === this._resumeRequestId && !this.isPlaying) {
        this.player?.seekTo(second);
        this.player?.play();
      }
    }, 900);
    this.onChange();
  }

  flushPosition() {
    this._savePosition();
  }

  _savePosition() {
    // Don't save a resume point right at the very end -- replaying should
    // start over, not reopen 2 seconds from the finish.
    const position =
      this.durationSec > 0 && this.lastKnownSecond >= this.durationSec * 0.95 ? 0 : this.lastKnownSecond;
    this.onPositionSave(position);
  }

  togglePlayPause() {
    if (this.isPlaying) this.player?.pause();
    else this.player?.play();
  }

  seekRelative(deltaSeconds) {
    const ceiling = this.durationSec > 0 ? this.durationSec : Number.MAX_VALUE;
    const target = clamp(this.lastKnownSecond + deltaSeconds, 0, ceiling);
    this.player?.seekTo(target);
    this.lastKnownSecond = target;
    if (this.slots.length > 0) {
      let idx = 0;
      for (let i = 0; i < this.slots.length; i++) {
        if (this.slots[i].startSec <= target + 0.001) idx = i;
      }
      this.activeSlotIndex = idx;
    }
    this.showTimeline = true;
    clearTimeout(this._hideTimelineTimer);
    this._hideTimelineTimer = setTimeout(() => {
      this.showTimeline = false;
      this.onChange();
    }, 3000);
    this.onChange();
  }

  applySpeed(speed) {
    this.player?.setSpeed(speed);
  }

  _rebuildSlots() {
    const newSlots = buildSlots(this.lastCues, this.currentConfig(), this.durationSec);
    if (newSlots.length === 0) return;
    this.slots = newSlots;
    let idx = 0;
    for (let i = 0; i < newSlots.length; i++) {
      if (newSlots[i].startSec <= this.lastKnownSecond + 0.001) idx = i;
    }
    this.activeSlotIndex = idx;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
