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
  return items
    .map((item) => {
      const videoId = item.id?.videoId;
      if (!videoId) return null;
      return {
        videoId,
        title: decodeHtml(item.snippet.title),
        channelTitle: decodeHtml(item.snippet.channelTitle),
        thumbnailUrl: item.snippet.thumbnails?.medium?.url ?? item.snippet.thumbnails?.default?.url ?? "",
      };
    })
    .filter(Boolean);
}

export async function fetchCues(videoId) {
  try {
    const res = await fetch(`/api/captions?videoId=${encodeURIComponent(videoId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.cues ?? [];
  } catch {
    return [];
  }
}

const decodeEl = typeof document !== "undefined" ? document.createElement("textarea") : null;
function decodeHtml(s) {
  if (!decodeEl) return s;
  decodeEl.innerHTML = s;
  return decodeEl.value;
}
