# SubLingo

Learn languages while you watch: subtitle translation, a hover/click word
dictionary, and full-line translation, on Crunchyroll and YouTube. Chrome
and Firefox extension built from one codebase.

## Architecture

`src/overlay.js` is the shared engine used by every supported site: it
renders the subtitle overlay, the per-word hover dictionary (pause + gloss
+ example sentences), the full-line "文A" translation button, and the
sync-offset control. It exposes a small API (`startTracking`,
`setActiveCues`, `translateAndStore`, `flashStatus`, `showOffsetControl`)
that site-specific code calls once it has subtitle cues.

Each supported site has its own pair of content scripts:

- **Crunchyroll** — `content-main.js` (page-context) intercepts the
  `/play` API call to learn the episode's audio/subtitle metadata,
  including the Japanese-original version's real translated tracks (a
  dub's own subtitle track is often just a same-language transcript, not
  a translation). `content-isolated.js` picks the best available track
  and feeds it to the shared engine.
- **YouTube** — `youtube-main.js` (page-context) reads the caption track
  list directly from the player instance (works across YouTube's
  client-side navigation between videos). `youtube-isolated.js` picks a
  track (native-language match preferred; otherwise translates the best
  available one) and feeds it to the shared engine.

Translation itself (`src/translator.js`, used from `src/background.js`)
uses a free, keyless Google Translate endpoint by default, with an
optional user-supplied DeepL key for higher quality where DeepL supports
the target language.

## Setup

```sh
npm install
npm run build      # outputs dist/chrome and dist/firefox
npm run watch       # rebuild on change
```

## Load in Chrome

`chrome://extensions` → enable Developer mode → "Load unpacked" → select
`dist/chrome`.

## Load in Firefox

`about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" →
select `dist/firefox/manifest.json`. (Temporary add-ons are removed on
restart; install the signed version from addons.mozilla.org for a
permanent install.)

## Adding a new site

1. Add a `<site>-main.js` (MAIN world) content script if the site's
   subtitle/caption data needs to be read from the page's own JS context
   (network interception, player API, embedded state).
2. Add a `<site>-isolated.js` content script that imports from
   `src/overlay.js`, turns whatever the main-world script found into
   `{ start, end, text }` cues, and calls `setActiveCues` (native
   language) or `translateAndStore` (needs translation).
3. Register both in `src/manifest.chrome.json` and
   `src/manifest.firefox.json` (`content_scripts` + `host_permissions`),
   and add the new entry points to `build.mjs`.

## Known limitations

- Netflix, Disney+, Amazon Prime Video, HBO Max, and Hulu are Widevine
  DRM-protected like Crunchyroll; supporting them means reverse-engineering
  each service's own API the same way, which needs live iteration against
  a real logged-in session (not something that can be done blind).
- YouTube's auto-generated ("ASR") captions can have overlapping,
  word-by-word rolling cues; manual (human-uploaded) caption tracks are
  preferred when available for a cleaner subtitle display.
