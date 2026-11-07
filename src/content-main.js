// Runs in the PAGE's own JS context ("MAIN" world) so it can wrap the
// page's own fetch and see the `/play` metadata call Crunchyroll's
// frontend makes when an episode loads. Cannot use chrome.* APIs here
// — everything is relayed to content-isolated.js via window.postMessage,
// which has the browser.storage/runtime access needed to act on it.
//
// Why we need this call specifically: Crunchyroll's `subtitles` field
// on a dubbed version's own /play response is often just a same-language
// transcript of that dub (not a real translation) — the genuine
// translated-from-Japanese subtitle tracks only live under the
// Japanese-audio version of the episode, which has its own distinct
// episode guid listed in this response's `versions` array. We can't
// know the guid ahead of time, so we intercept this call to learn it
// (see content-isolated.js for the follow-up fetch).
// Any API version: Crunchyroll moved from /playback/v3/ to /playback/v4/.
const PLAY_URL_RE = /\/playback\/v\d+\/([^/]+)\/web\/([^/]+)\/play(\?|$)/i;
const CHANNEL = "subtitleuebersetzer";

function extractAuthHeader(init) {
  if (!init || !init.headers) return null;
  try {
    return new Headers(init.headers).get("authorization");
  } catch {
    return null;
  }
}

function emitPlayData(url, guid, platform, authHeader, data) {
  window.postMessage(
    { channel: CHANNEL, type: "play-data", url, guid, platform, authHeader, data },
    "*"
  );
}

const originalFetch = window.fetch;
window.fetch = async function patchedFetch(...args) {
  const response = await originalFetch.apply(this, args);
  try {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? "";
    const match = url.match(PLAY_URL_RE);
    if (match) {
      const authHeader = extractAuthHeader(args[1]);
      response
        .clone()
        .json()
        .then((data) => emitPlayData(url, match[1], match[2], authHeader, data))
        .catch(() => {});
    }
  } catch {
    // Never let interception break the page's real network request.
  }
  return response;
};

// Crunchyroll's web client sends its API calls (including /play) through
// an XMLHttpRequest-based client, not fetch — so watch XHR as well.
const XHR = window.XMLHttpRequest.prototype;
const originalOpen = XHR.open;
const originalSetHeader = XHR.setRequestHeader;
const originalSend = XHR.send;

XHR.open = function patchedOpen(method, url, ...rest) {
  try {
    this.__suUrl = String(url);
    this.__suAuth = null;
  } catch {
    // ignore
  }
  return originalOpen.call(this, method, url, ...rest);
};

XHR.setRequestHeader = function patchedSetHeader(name, value) {
  try {
    if (String(name).toLowerCase() === "authorization") this.__suAuth = value;
  } catch {
    // ignore
  }
  return originalSetHeader.call(this, name, value);
};

XHR.send = function patchedSend(...args) {
  try {
    const url = this.__suUrl || "";
    const match = url.match(PLAY_URL_RE);
    if (match) {
      this.addEventListener("load", () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          let data = this.response;
          if (this.responseType === "" || this.responseType === "text") {
            data = JSON.parse(this.responseText);
          } else if (typeof data === "string") {
            data = JSON.parse(data);
          }
          if (data && typeof data === "object") {
            emitPlayData(url, match[1], match[2], this.__suAuth, data);
          }
        } catch {
          // not JSON / unexpected shape — ignore
        }
      });
    }
  } catch {
    // Never let interception break the page's real network request.
  }
  return originalSend.apply(this, args);
};
