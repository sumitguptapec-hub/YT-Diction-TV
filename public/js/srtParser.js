// Ported from the Android app's SrtParser.kt -- parses standard .srt text
// into the same {startSec, endSec, text} cue shape YouTube captions use, so
// SlotBuilder/SlotController don't need to care where cues came from.
const TIMING_REGEX = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;
const TAG_REGEX = /<[^>]*>/g;

export function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) continue;
    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;
    const match = TIMING_REGEX.exec(lines[timingIndex]);
    if (!match) continue;
    const start = toSeconds(match[1], match[2], match[3], match[4]);
    const end = toSeconds(match[5], match[6], match[7], match[8]);
    const cueText = lines
      .slice(timingIndex + 1)
      .map((l) => l.replace(TAG_REGEX, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n")
      .trim();
    if (cueText.length > 0 && end > start) {
      cues.push({ startSec: start, endSec: end, text: cueText });
    }
  }
  return cues.sort((a, b) => a.startSec - b.startSec);
}

function toSeconds(h, m, s, ms) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}
