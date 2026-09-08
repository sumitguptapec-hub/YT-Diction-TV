import { GOOGLE_CLIENT_ID } from "./config.js";

const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const TOKEN_STORAGE_KEY = "ytdictationweb.accessToken";
const TOKEN_EXPIRY_KEY = "ytdictationweb.accessTokenExpiresAt";

// Shaved 60s off whatever Google reports, so a token doesn't get treated as
// valid for a request that's actually going to land right at/after expiry.
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

let tokenClient = null;

// Google Identity Services' token client -- the web equivalent of the
// Android app's GoogleSignInClient + GoogleAuthUtil.getToken() combo, but
// simpler here: it runs the whole popup consent flow in-browser and just
// hands back an access token directly, no separate token-exchange step
// needed for a static site with no backend of its own.
export function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: YOUTUBE_READONLY_SCOPE,
    callback: () => {}, // overridden per-call in signIn()
  });
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function storeToken(token, expiresInSec) {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
  const expiresInMs = (Number(expiresInSec) || 3600) * 1000;
  localStorage.setItem(TOKEN_EXPIRY_KEY, String(Date.now() + expiresInMs - EXPIRY_SAFETY_MARGIN_MS));
}

// iOS "Add to Home Screen" apps run in a standalone WKWebView that can't
// complete GIS's popup-based flow -- the popup opens in a separate context
// that can't hand the token back, and the library throws a raw
// "null is not an object" error instead of a usable rejection. Google's own
// full-page OAuth redirect works fine there since it's just page
// navigation, so standalone mode uses that instead; completeRedirectSignIn()
// below picks the token back up once Google sends the page back.
export function signIn() {
  if (isStandalone()) {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: window.location.origin + "/",
      response_type: "token",
      scope: YOUTUBE_READONLY_SCOPE,
      prompt: "select_account",
      state: "main",
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    return new Promise(() => {}); // page is navigating away, never resolves here
  }
  return new Promise((resolve, reject) => {
    tokenClient.callback = (response) => {
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      storeToken(response.access_token, response.expires_in);
      resolve(response.access_token);
    };
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

// Called once at boot to pick up a token left in the URL fragment by the
// redirect above. Both this and driveAuth.js's equivalent check the same
// URL, so each only acts (and clears the hash) when `state` matches its own
// flow -- otherwise it leaves the fragment alone for the other one to see.
export function completeRedirectSignIn() {
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.slice(1));
  if (params.get("state") !== "main") return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  const token = params.get("access_token");
  if (!token) return { success: false, error: params.get("error") || "no token returned" };
  storeToken(token, params.get("expires_in"));
  return { success: true };
}

// Access tokens from this flow are short-lived (about an hour) and there's
// no refresh token in this browser-only flow. localStorage (rather than
// sessionStorage) means being closed and reopened -- including force-quit
// on iOS -- doesn't force a fresh sign-in on its own; only actual token
// expiry does. That expiry is checked here (not just left to whatever API
// call happens to fail first) so a dead token doesn't get treated as a
// valid sign-in with no explanation -- it used to, since localStorage was
// added, since nothing was tracking when the token actually goes stale.
export function getStoredToken() {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) return null;
  const expiresAt = Number(localStorage.getItem(TOKEN_EXPIRY_KEY));
  if (expiresAt && Date.now() >= expiresAt) {
    clearStoredToken();
    return null;
  }
  return token;
}

export function clearStoredToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
}
