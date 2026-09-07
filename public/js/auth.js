import { GOOGLE_CLIENT_ID } from "./config.js";

const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const TOKEN_STORAGE_KEY = "ytdictationweb.accessToken";

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

export function signIn() {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (response) => {
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      sessionStorage.setItem(TOKEN_STORAGE_KEY, response.access_token);
      resolve(response.access_token);
    };
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

// Access tokens from this flow are short-lived (about an hour) and there's
// no refresh token in this browser-only flow -- sessionStorage just avoids
// re-prompting on a page reload within that window; expect an occasional
// re-sign-in.
export function getStoredToken() {
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function clearStoredToken() {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}
