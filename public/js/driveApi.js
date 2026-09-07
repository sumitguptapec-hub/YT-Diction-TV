// Direct browser fetch works here -- unlike YouTube's innertube captions
// endpoint, Google's Drive API sends proper CORS headers for authenticated
// client requests, so no server-side proxy is needed.
const VIDEO_EXTENSIONS = new Set(["mp4", "mkv", "webm", "avi", "mov", "m4v", "3gp"]);
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
export const ROOT_FOLDER_ID = "root";

export async function listEntries(folderId, accessToken) {
  const query = `'${folderId}' in parents and trashed = false`;
  const url =
    "https://www.googleapis.com/drive/v3/files" +
    `?q=${encodeURIComponent(query)}&fields=${encodeURIComponent("files(id,name,mimeType)")}&pageSize=1000`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
  const data = await res.json();
  const files = data.files ?? [];

  const srtIdByStem = new Map(
    files.filter((f) => f.name.toLowerCase().endsWith(".srt")).map((f) => [stem(f.name).toLowerCase(), f.id])
  );

  const folders = files
    .filter((f) => f.mimeType === FOLDER_MIME_TYPE)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => ({ type: "folder", id: f.id, name: f.name }));

  const videos = files
    .filter((f) => f.mimeType !== FOLDER_MIME_TYPE && isVideoFile(f))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => ({
      type: "video",
      id: f.id,
      name: stem(f.name),
      srtFileId: srtIdByStem.get(stem(f.name).toLowerCase()) ?? null,
    }));

  return [...folders, ...videos];
}

export async function fetchSrtCues(fileId, accessToken) {
  const res = await fetch(mediaUrl(fileId), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return "";
  return res.text();
}

export function mediaUrl(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
}

function isVideoFile(file) {
  return file.mimeType.startsWith("video/") || VIDEO_EXTENSIONS.has(stem2ext(file.name));
}
function stem(name) {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? name : name.slice(0, idx);
}
function stem2ext(name) {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}
