// Direct browser fetch works here (unlike the innertube captions endpoint)
// because Google's public REST APIs send proper CORS headers for
// bearer-token client requests.
export async function searchYouTube(query, accessToken) {
  const url =
    "https://www.googleapis.com/youtube/v3/search" +
    `?part=snippet&type=video&maxResults=30&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const err = new Error(`YouTube search failed: ${res.status}`);
    err.status = res.status; // lets callers tell an expired/revoked token (401) apart from other failures
    throw err;
  }
  const data = await res.json();
  const items = data.items || [];
  const results = items
    .map((item) => {
      const videoId = item.id?.videoId;
      if (!videoId) return null;
      return {
        videoId,
        title: decodeHtml(item.snippet.title),
        channelTitle: decodeHtml(item.snippet.channelTitle),
        thumbnailUrl: item.snippet.thumbnails?.medium?.url ?? item.snippet.thumbnails?.default?.url ?? "",
        durationText: "",
      };
    })
    .filter(Boolean);

  // search.list deliberately doesn't return duration -- a second call to
  // videos.list is the documented way to get it. Best-effort: if this call
  // fails for any reason, results still show, just without durations.
  if (results.length > 0) {
    try {
      const durations = await fetchDurations(results.map((r) => r.videoId), accessToken);
      for (const r of results) r.durationText = durations.get(r.videoId) ?? "";
    } catch {
      // leave durationText blank on every result
    }
  }
  return results;
}

async function fetchDurations(videoIds, accessToken) {
  const url =
    "https://www.googleapis.com/youtube/v3/videos" +
    `?part=contentDetails&id=${videoIds.map(encodeURIComponent).join(",")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return new Map();
  const data = await res.json();
  const map = new Map();
  for (const item of data.items || []) {
    map.set(item.id, formatIsoDuration(item.contentDetails?.duration));
  }
  return map;
}

// YouTube reports duration as an ISO 8601 duration, e.g. "PT4M13S" or
// "PT1H2M3S" -- format as the usual m:ss / h:mm:ss for display.
function formatIsoDuration(iso) {
  if (!iso) return "";
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return "";
  const h = Number(match[1] || 0);
  const m = Number(match[2] || 0);
  const s = Number(match[3] || 0);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// The access token goes in a header, never the query string, regardless --
// it must not end up in a URL, log or referrer. Forwarding it was tried as
// a fix for YouTube blocking most caption requests from this deployment's
// IP with "Sign in to confirm you're not a bot"; a same-video A/B test
// (real token vs. no token, back to back) showed it makes no reliable
// difference, so this is kept only because sending it is still correct
// practice, not because it resolves the block. See README.
export async function fetchCues(videoId, accessToken) {
  try {
    const res = await fetch(`/api/captions?videoId=${encodeURIComponent(videoId)}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (!res.ok) return { cues: [], availableLangs: [], blockedReason: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      cues: data.cues ?? [],
      availableLangs: data.availableLangs ?? [],
      blockedReason: data.blockedReason ?? null,
    };
  } catch (err) {
    return { cues: [], availableLangs: [], blockedReason: String(err) };
  }
}

// Used as the AI Summary fallback when captions aren't available -- title
// and description come from the same reliable, official videos.list
// endpoint already used for duration, not the blocked caption endpoint.
export async function fetchVideoDetails(videoId, accessToken) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) return null;
  return { title: decodeHtml(item.snippet.title), description: item.snippet.description ?? "" };
}

const decodeEl = typeof document !== "undefined" ? document.createElement("textarea") : null;
function decodeHtml(s) {
  if (!decodeEl) return s;
  decodeEl.innerHTML = s;
  return decodeEl.value;
}
