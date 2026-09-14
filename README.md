# YT Dictation (web)

A web version of the YT Dictation Android TV app: search YouTube, then watch
a video a few caption lines (or seconds) at a time, auto-pausing between
slots. Works in any modern browser, including Safari on iPhone/iPad.

Feature parity with the Android app: YouTube search + sign-in, dictation-pace
playback with a circular progress ring, subtitle overlay driven by real
captions, History/Favorites, settings for lines-per-slot/seconds/mode/
subtitle color/position/two-line toggle/speed, local video file playback
(pick a file from your device instead of browsing a USB drive -- a browser
can't do the latter, but can do the former), and Google Drive browsing +
playback.

Not included: physical remote-control key mapping obviously doesn't apply to
touch/keyboard -- replaced with on-screen buttons and keyboard shortcuts
(Space/Enter = next slot, arrow keys = prev/next slot and 10s seek, C =
toggle info panel).

## How it's built

- Plain HTML/CSS/JS, no framework, no build step -- open `public/index.html`
  and it just runs, once deployed.
- One serverless function (`api/captions.js`) proxies YouTube's caption data,
  since that endpoint doesn't allow direct browser requests from third-party
  pages (CORS). Everything else (search, sign-in, video playback) talks to
  Google/YouTube directly from the browser.
- Deploys to [Vercel](https://vercel.com) as a static site + one function --
  free tier is enough for personal use.

## 1. Create a Google OAuth client for the web

This is separate from the Android app's OAuth client -- web apps need a
different client type.

1. Go to [Google Cloud Console](https://console.cloud.google.com), and
   switch to the same project as the Android app (**YT Diction TV**) -- or a
   different one, doesn't matter, as long as the **YouTube Data API v3** is
   enabled there (it already is, on that project).
2. Left sidebar → **Google Auth Platform** (or **OAuth consent screen**, on
   older-UI projects) → **Clients** → **Create client**.
3. Application type: **Web application**.
4. Name it anything (e.g. "YT Dictation Web").
5. Leave **Authorized redirect URIs** empty -- this app uses Google
   Identity Services' token flow, which only needs **Authorized JavaScript
   origins**.
6. **Authorized JavaScript origins**: leave this page open for now -- you'll
   come back and add the real URL after deploying in step 2. For now you can
   add `http://localhost:3000` so local testing works.
7. Click **Create**. Copy the **Client ID** (ends in
   `.apps.googleusercontent.com`).
8. Open `public/js/config.js` in this project and paste it in:
   ```js
   export const GOOGLE_CLIENT_ID = "PASTE_YOUR_CLIENT_ID_HERE";
   ```

## 2. Deploy to Vercel

You don't have Node.js or git installed on this machine, so skip any
instructions that mention `npx` or `git push` — everything below uses only
GitHub's and Vercel's websites.

### 2a. Put the code on GitHub

1. Go to [github.com/signup](https://github.com/signup) if you don't
   already have a GitHub account. Free.
2. Once logged in, go to [github.com/new](https://github.com/new) to create
   a new repository.
   - **Repository name**: `yt-dictation-web` (or anything).
   - Leave it **Public** (fine for this) or set **Private** if you prefer —
     either works with Vercel's free tier.
   - **Do not** check "Add a README file" — leave the repo completely empty.
   - Click **Create repository**.
3. GitHub now shows a page with setup instructions ("Quick setup"). Look for
   a link that says **"uploading an existing file"** (it's a plain text link
   in the first paragraph) and click it.
4. In Windows Explorer, open the `YTDictationWeb` folder, select
   **everything inside it** (the `api` folder, `public` folder,
   `package.json`, `vercel.json`, `README.md`, `server.js` — select all with
   Ctrl+A) and drag that selection onto the GitHub upload page in your
   browser.
5. Wait for the upload progress bars to finish, then scroll down and click
   the green **Commit changes** button.

Your code is now on GitHub. You should see the `api` and `public` folders
listed on the repository's main page.

### 2b. Import it into Vercel

1. Go to [vercel.com](https://vercel.com) and click **Sign Up**. Choose
   **Continue with GitHub** — this lets Vercel see your repositories (you'll
   be asked to authorize it; that's expected and needed).
2. Once you land on the Vercel dashboard, click **Add New...** (top right) →
   **Project**.
3. You'll see a list of your GitHub repositories — find `yt-dictation-web`
   and click **Import** next to it.
4. Vercel shows a configuration screen. You don't need to change anything —
   it will say "Other" or leave Framework Preset blank, since this isn't
   built with a framework. Just click **Deploy**.
5. Wait about 30–60 seconds. Vercel shows a success screen with a URL like
   `https://yt-dictation-web-xxxx.vercel.app` — that's your app's URL. Copy
   it (click it, or use the "Copy" icon next to it).

### 2c. Connect the OAuth client to that URL

1. Back in Google Cloud Console → **Google Auth Platform** → **Clients** →
   click the Web application client you created in step 1.
2. Under **Authorized JavaScript origins**, click **+ Add URI** and paste
   the Vercel URL from step 2b.5 — **exactly as shown, with no trailing
   slash** (e.g. `https://yt-dictation-web-xxxx.vercel.app`, not
   `.../vercel.app/`).
3. Click **Save**. This can take a few minutes to take effect.

### 2d. Test it

Open the Vercel URL from step 2b.5 on your phone, laptop, or iPad's browser.
Click **Sign in with Google**, search for a video, and play it.

### Making a code change later

If I (or you) edit any file in this project afterward, you'll need to
re-upload it to GitHub for Vercel to pick it up: go to the file's page on
GitHub (or the repo's main page), use **Add file → Upload files** to
re-upload the changed file(s) over the old ones, and commit. Vercel
automatically redeploys within a minute or two of any change landing on
GitHub — no need to touch Vercel itself again.

## 3. Add yourself as a test user (if not already)

Same as the Android app: Google Auth Platform → **Audience** → **Test
users** → make sure your Google account is listed. Since this reuses the
same project as the Android app, it likely already is.

## Local testing (optional, before deploying)

Requires Node.js installed locally (this dev machine didn't have it, so this
was verified via a Python static server instead -- good enough to check the
UI, but `/api/captions` won't respond without Node):

```bash
npm run dev
```

Then open http://localhost:3000. Sign-in will only work once
`http://localhost:3000` is added to the OAuth client's authorized origins
(step 1.6 above).

## AI Summary setup (`api/summarize.js`)

The 🧠 Summary button needs an LLM API key set as an environment variable in
Vercel (**Settings → Environments → Production → Environment Variables**),
same place as `REMOTE_TOKEN`. Two options, tried in this order:

1. **`GEMINI_API_KEY`** (recommended -- genuinely free, no billing account
   needed): get one from [Google AI Studio](https://aistudio.google.com/apikey).
   This is *not* the same thing as Google Cloud's enterprise Vertex AI
   product, which requires a GCP billing account and service-account auth --
   AI Studio's API is the free-tier-friendly one.
2. **`ANTHROPIC_API_KEY`** (fallback, real pay-per-use cost): from
   [console.anthropic.com](https://console.anthropic.com). Used automatically
   if `GEMINI_API_KEY` isn't set.

Either one, added and the project redeployed, is enough for the button to
work.

## Google Drive: worth testing here even though Android couldn't

The Android app hit an unresolved, account-level Google OAuth restriction
blocking `drive.readonly` for every client/project it tried (both the old
`GoogleSignInClient` API and the newer `AuthorizationClient` API) -- see the
support case draft in the parent folder. This web app requests Drive access
through yet another, completely different mechanism (Google Identity
Services' browser token-client flow), requested lazily the first time you
tap the ☁ icon rather than bundled into sign-in. It's genuinely unknown
whether the same account-level block applies here too -- this hasn't been
testable from this environment (the OAuth consent popup can't be driven
through browser automation the way most of the rest of this was verified).
**Try it on the real deployed site and tell me what happens** -- either it
works (in which case the block really was specific to Android's native SDKs)
or it fails with the same "not permitted to request scopes" error (in which
case it's confirmed universal, useful to add to the support case).

Drive video playback here works by downloading the full file into memory
before playing (like local file playback) rather than true streaming --
fine for typical video sizes, but there's no seeking within the video until
it's fully downloaded, and very large files will be slow to start and
memory-heavy. Worth revisiting with a proper streaming approach if Drive
turns out to work at all.

## Known limitations vs. the Android app

- **Remote-control key mapping** (Channel Up/Down, colour buttons, numeric
  keypad) doesn't apply to a touch/keyboard device -- replaced with on-screen
  buttons plus keyboard shortcuts (Space/Enter = next slot, arrow keys =
  prev/next slot and 10s seek, C = toggle info panel).
- **Access tokens expire after about an hour** with no silent refresh (this
  flow doesn't get a refresh token) -- expect an occasional re-sign-in
  compared to the Android app's longer-lived session. This applies
  separately to the YouTube and Drive tokens.
- **Local/Drive video History and Favorites**: not tracked, same as the
  Android app's local-video handling -- no stable identity to key them off
  across sessions.
- **Vercel Framework Preset was silently misconfigured as "Node" instead of
  "Other" since the project was first created.** This is the single biggest
  bug found in this whole project, and it wasn't in any of this repo's code
  -- it was a Vercel dashboard setting. Under "Node", Vercel treats the
  whole project as one custom Node server (looking for an entry point like
  `server.js`) and appears to route every `/api/*` request through a
  degraded request object -- confirmed directly: every deployed function
  received `req = {query: {...}}` and *nothing else*, no `method`, no
  `headers`, no `body`, ever. That single fact was the real explanation for
  three things that looked like separate bugs: `api/summarize.js`'s
  `req.method !== "POST"` check was unconditionally true (`undefined !==
  "POST"`), so it rejected every request since the feature was built;
  `req.body` being permanently `undefined` meant it would have failed even
  past that; and forwarding the user's access token for captions had no
  chance of working since `req.headers` never existed. Fixed via
  `vercel project update --framework other`, confirmed with a real
  deployment: `/api/summarize` now correctly parses POST bodies and calls
  the Claude API for real (verified end-to-end, blocked only by an
  unrelated low-balance error on the Anthropic account, not a bug here).
  If a future serverless function acts like it's being called with no
  `req.headers`/`req.method`, check this setting first before assuming a
  code bug.

- **YouTube captions -- now correctly diagnosed, still not reliable for
  most videos.** `api/captions.js` uses an unofficial, reverse-engineered
  YouTube endpoint (there's no official API for fetching captions on videos
  you don't own). With the Framework Preset bug above now fixed, forwarding
  the signed-in user's `youtube.readonly` access token *does* genuinely
  bypass the `"Sign in to confirm you're not a bot"` anonymous-traffic
  block that Vercel's datacenter IP otherwise triggers for most videos --
  confirmed with a real token vs. no token, back to back, on 6 real search
  results across 3 topics: every one stopped being blocked. But the actual
  caption data still doesn't come through for most of them, and a raw test
  against the same endpoint with the same token reveals why:
  `ACCESS_TOKEN_SCOPE_INSUFFICIENT` -- `youtube.readonly` is enough to
  prove "this is a real authenticated user" (which is all the bot-check
  cares about) but not enough to authorize this specific internal caption
  API, which needs a scope only Google's own first-party apps can request.
  There's no third-party-requestable OAuth scope that resolves this. Only
  one video (an old, extremely high-traffic one, likely served from a
  heavily-cached path regardless of caller) has worked consistently through
  this entire investigation. When captions fail the info panel (☰) reports
  why: no `.srt` (local/Drive), no en/hi track found (with whatever
  languages *were* found), or the specific block/scope reason.

- **AI Summary fallback for when captions fail.** Since captions are
  unreliable, the 🧠 Summary button doesn't just give up when they're
  missing: it automatically generates a general summary from the video's
  title and description (the official, reliable `videos.list` endpoint --
  not the blocked one), and offers a "paste transcript" box for the full,
  detailed, timestamped version. YouTube's own video page has a "Show
  transcript" panel that works fine in *your* browser (it's only this
  deployment's server IP that hits the scope wall above) -- copy that,
  paste it in, and it's parsed and summarized exactly like real captions
  would, including tap-to-seek on each entry. This path is unaffected by
  everything above and is the reliable way to get a detailed summary today.
