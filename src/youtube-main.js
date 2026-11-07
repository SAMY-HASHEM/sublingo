// Runs in the PAGE's own JS context ("MAIN" world) on YouTube. Reads the
// caption track list from the player instance (works on first load and
// after YouTube's client-side navigation) and, on request from the
// isolated script, switches YouTube's own caption display to a chosen
// track. The isolated script then mirrors whatever YouTube renders, so the
// timing is YouTube's own and always matches the voice.
const CHANNEL = "subtitleuebersetzer";

function getPlayer() {
  return document.getElementById("movie_player");
}

function getPlayerResponse() {
  try {
    const response = getPlayer()?.getPlayerResponse?.();
    if (response) return response;
  } catch {
    // player API not ready yet
  }
  // First load, before the player exposes its API.
  return window.ytInitialPlayerResponse || null;
}

// The caption list normally lives at captions.playerCaptionsTracklistRenderer,
// but rather than depend on that exact shape, search for it.
function findCaptionTracks(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node.captionTracks)) return node.captionTracks;
  for (const key of Object.keys(node)) {
    const found = findCaptionTracks(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

let lastPostedVideoId = null;
let rawTracks = [];

function postCaptionsIfChanged() {
  const response = getPlayerResponse();
  const videoId = response?.videoDetails?.videoId;
  if (!videoId || videoId === lastPostedVideoId) return;

  rawTracks = findCaptionTracks(response) || [];
  const tracks = rawTracks.map((t) => ({
    vssId: t.vssId,
    languageCode: t.languageCode,
    name: t.name?.simpleText || t.languageCode,
    isAutomatic: t.kind === "asr",
  }));

  lastPostedVideoId = videoId;
  window.postMessage({ channel: CHANNEL, type: "yt-captions", videoId, tracks }, "*");
}

// Turn on YouTube's own captions for the chosen track. Its caption layer is
// hidden visually by the isolated script, but it keeps rendering — that
// rendered text is what we mirror.
function selectTrack(vssId) {
  const player = getPlayer();
  const track = rawTracks.find((t) => t.vssId === vssId);
  if (!player || !track) return;
  try {
    player.loadModule?.("captions");
    player.setOption?.("captions", "track", {
      languageCode: track.languageCode,
      ...(track.kind ? { kind: track.kind } : {}),
    });
    if (player.isSubtitlesOn && !player.isSubtitlesOn()) {
      (player.toggleSubtitlesOn || player.toggleSubtitles)?.call(player);
    }
  } catch {
    // older player without these APIs; user can enable CC manually
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (msg?.channel === CHANNEL && msg.type === "yt-select-track") {
    selectTrack(msg.vssId);
    // The player can reset its caption choice while a new video loads, so
    // re-apply a couple of times shortly after.
    setTimeout(() => selectTrack(msg.vssId), 1500);
    setTimeout(() => selectTrack(msg.vssId), 4000);
  }
});

// YouTube fires this on `document` when its SPA finishes navigating.
document.addEventListener("yt-navigate-finish", postCaptionsIfChanged);
// Fallback poll for first load and cases where the event doesn't fire.
setInterval(postCaptionsIfChanged, 1500);
postCaptionsIfChanged();
