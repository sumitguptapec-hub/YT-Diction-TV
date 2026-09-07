// Ported 1:1 from the Android app's SlotBuilder.kt. How a slot's end
// boundary is chosen depends on config.mode:
// - "both" (default): linesPerSlot caption lines or slotSeconds seconds,
//   whichever is longer.
// - "linesOnly": exactly linesPerSlot caption lines, no time floor.
// - "timeOnly": fixed slotSeconds-wide windows, ignoring captions entirely.
// With no captions at all, it always falls back to fixed slotSeconds
// windows regardless of mode.
export function buildSlots(cues, config, durationSec) {
  if (cues.length === 0 || config.mode === "timeOnly") {
    return buildFixedWindows(durationSec, config.slotSeconds);
  }

  const sorted = [...cues].sort((a, b) => a.startSec - b.startSec);
  const slots = [];
  let slotStart = 0;
  let i = 0;
  while (i < sorted.length) {
    const group = sorted.slice(i, Math.min(i + config.linesPerSlot, sorted.length));
    const lastCueEnd = group[group.length - 1].endSec;
    let slotEnd;
    if (config.mode === "linesOnly") {
      slotEnd = lastCueEnd;
    } else {
      // "both"
      slotEnd = Math.max(lastCueEnd, slotStart + config.slotSeconds);
    }
    slots.push({ startSec: slotStart, endSec: slotEnd });
    slotStart = slotEnd;
    i += config.linesPerSlot;
  }
  if (durationSec > slotStart) {
    slots.push({ startSec: slotStart, endSec: durationSec });
  }
  return slots;
}

function buildFixedWindows(durationSec, slotSeconds) {
  if (durationSec <= 0) return [{ startSec: 0, endSec: slotSeconds }];
  const slots = [];
  let start = 0;
  while (start < durationSec) {
    const end = Math.min(start + slotSeconds, durationSec);
    slots.push({ startSec: start, endSec: end });
    start = end;
  }
  return slots;
}
