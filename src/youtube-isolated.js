// YouTube-specific isolated-world script.
//
// Instead of downloading and timing the caption file ourselves, we let
// YouTube's own player render its captions (in the chosen track), hide
// that rendering visually, and mirror the exact text into our interactive
// overlay. The timing is therefore YouTube's own and always matches the
// voice; we only add the hover dictionary and full-line translation.
import { startTracking, setLiveText, flashStatus, setEnabled } from "./overlay.js";

const runtime = typeof browser !== "undefined" ? browser : chrome;
const CHANNEL = "subtitleuebersetzer";

function shortLang(code) {
  return (code || "DE").split("-")[0].toLowerCase();
}

// YouTube's <video> sits in a zero-height wrapper, so anchor the overlay to
// the full player element; ignore other <video>s (thumbnail hover previews).
startTracking(null, {
  videoSelector: "#movie_player video",
  container: () => document.getElementById("movie_player"),
});

// Keep YouTube's caption layer rendering (so we can read it) but invisible.
// `opacity` rather than `display:none`, so the player keeps updating it.
function hideNativeCaptions() {
  if (document.getElementById("su-hide-yt-captions")) return;
  const style = document.createElement("style");
  style.id = "su-hide-yt-captions";
  style.textContent =
    "#movie_player .ytp-caption-window-container { opacity: 0 !important; }";
  (document.head || document.documentElement).appendChild(style);
}

// --- current video state ---------------------------------------------
let currentVideoId = null;
let needsTranslation = false; // caption track language != target language
let targetLang = "DE";
const lineCache = new Map(); // caption line -> translated line

async function handleCaptions({ videoId, tracks }) {
  if (!videoId || videoId === currentVideoId) return;
  currentVideoId = videoId;
  setLiveText("");

  const settingsRes = await runtime.runtime
    .sendMessage({ type: "get-settings" })
    .catch(() => null);
  const enabled = settingsRes?.settings?.enabled ?? true;
  setEnabled(enabled);
  if (!enabled) return;
  targetLang = settingsRes?.settings?.targetLang ?? "DE";
  const target = shortLang(targetLang);

  console.info(
    `[subtitleübersetzer] youtube video ${videoId}: target=${targetLang},`,
    `tracks=[${tracks.map((t) => `${t.languageCode}${t.isAutomatic ? "(auto)" : ""}`).join(", ")}]`
  );

  if (tracks.length === 0) {
    flashStatus("ⓘ Dieses Video hat keine Untertitel", 8000);
    return;
  }

  // Prefer a human-made track in the target language, then an automatic
  // one in the target language, then English, then anything.
  const nativeMatch =
    tracks.find((t) => shortLang(t.languageCode) === target && !t.isAutomatic) ||
    tracks.find((t) => shortLang(t.languageCode) === target);
  const source =
    nativeMatch ||
    tracks.find((t) => shortLang(t.languageCode) === "en" && !t.isAutomatic) ||
    tracks.find((t) => shortLang(t.languageCode) === "en") ||
    tracks.find((t) => !t.isAutomatic) ||
    tracks[0];

  needsTranslation = !nativeMatch;
  console.info(
    `[subtitleübersetzer] mirroring YouTube captions: ${source.languageCode}` +
      (needsTranslation ? ` → translated to ${targetLang}` : " (native)")
  );

  hideNativeCaptions();
  window.postMessage({ channel: CHANNEL, type: "yt-select-track", vssId: source.vssId }, "*");
}

// --- mirroring ---------------------------------------------------------
// Read what YouTube is displaying right now, one string per visual line.
function readNativeCaption() {
  const player = document.getElementById("movie_player");
  if (!player) return "";
  const lines = player.querySelectorAll(".caption-visual-line");
  if (lines.length > 0) {
    return [...lines]
      .map((line) =>
        [...line.querySelectorAll(".ytp-caption-segment")].map((s) => s.textContent).join("")
      )
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
  }
  return [...player.querySelectorAll(".ytp-caption-segment")]
    .map((s) => s.textContent.trim())
    .filter(Boolean)
    .join("\n");
}

async function translateLine(text) {
  if (lineCache.has(text)) return lineCache.get(text);
  const res = await runtime.runtime
    .sendMessage({ type: "translate-cues", cues: [{ start: 0, end: 0, text }] })
    .catch(() => null);
  const translated = res?.ok ? res.cues[0]?.translated ?? text : text;
  lineCache.set(text, translated);
  return translated;
}

let lastNative = null;
setInterval(async () => {
  if (!currentVideoId) return;
  const native = readNativeCaption();
  if (native === lastNative) return;
  lastNative = native;

  if (!native || !needsTranslation) {
    setLiveText(native);
    return;
  }
  // Show the translation once ready (cached lines appear instantly); only
  // apply if YouTube is still showing that same line.
  const translated = await translateLine(native);
  if (lastNative === native) setLiveText(translated);
}, 100);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.channel !== CHANNEL || message.type !== "yt-captions") return;

  handleCaptions(message).catch((err) =>
    console.warn("[subtitleübersetzer] yt-captions handling failed", err)
  );
});
