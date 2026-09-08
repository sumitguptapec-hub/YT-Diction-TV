import { GOOGLE_CLIENT_ID } from "./config.js";

const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_TOKEN_STORAGE_KEY = "ytdictationweb.driveAccessToken";
const DRIVE_TOKEN_EXPIRY_KEY = "ytdictationweb.driveAccessTokenExpiresAt";
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

// Separate token client from the YouTube one in auth.js, requested lazily
// the first time Drive browsing is opened rather than bundled into the
// initial sign-in -- mirrors the Android app's final architecture (a
// dedicated on-demand authorization step per scope, not one bundled
// request), and lets this scope's grant be tested/observed independently.
let driveTokenClient = null;

export function initDriveAuth() {
  driveTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_READONLY_SCOPE,
    callback: () => {},
  });
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function storeDriveToken(token, expiresInSec) {
  localStorage.setItem(DRIVE_TOKEN_STORAGE_KEY, token);
  const expiresInMs = (Number(expiresInSec) || 3600) * 1000;
  localStorage.setItem(DRIVE_TOKEN_EXPIRY_KEY, String(Date.now() + expiresInMs - EXPIRY_SAFETY_MARGIN_MS));
}

// Same iOS "Add to Home Screen" popup limitation as auth.js -- see the
// comment there. Uses its own `state` value ("drive") so the two flows,
// which both redirect back to this exact same URL, can tell each other's
// returning tokens apart.
export function signInToDrive() {
  if (isStandalone()) {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: window.location.origin + "/",
      response_type: "token",
      scope: DRIVE_READONLY_SCOPE,
      prompt: "select_account",
      state: "drive",
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    return new Promise(() => {}); // page is navigating away, never resolves here
  }
  return new Promise((resolve, reject) => {
    driveTokenClient.callback = (response) => {
      if (response.error) {
        reject(new Error(`${response.error}: ${response.error_description ?? ""}`));
        return;
      }
      storeDriveToken(response.access_token, response.expires_in);
      resolve(response.access_token);
    };
    driveTokenClient.requestAccessToken({ prompt: "" });
  });
}

// See auth.js's getStoredToken() for why expiry is checked here rather
// than trusted purely on presence.
export function getStoredDriveToken() {
  const token = localStorage.getItem(DRIVE_TOKEN_STORAGE_KEY);
  if (!token) return null;
  const expiresAt = Number(localStorage.getItem(DRIVE_TOKEN_EXPIRY_KEY));
  if (expiresAt && Date.now() >= expiresAt) {
    clearStoredDriveToken();
    return null;
  }
  return token;
}

export function clearStoredDriveToken() {
  localStorage.removeItem(DRIVE_TOKEN_STORAGE_KEY);
  localStorage.removeItem(DRIVE_TOKEN_EXPIRY_KEY);
}

// Boot-time counterpart to auth.js's completeRedirectSignIn() -- see that
// function's comment for why each flow only acts on its own `state` value.
export function completeDriveRedirectSignIn() {
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.slice(1));
  if (params.get("state") !== "drive") return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  const token = params.get("access_token");
  if (!token) return { success: false, error: params.get("error") || "no token returned" };
  storeDriveToken(token, params.get("expires_in"));
  return { success: true };
}
