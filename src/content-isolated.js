// Crunchyroll-specific isolated-world script. All rendering, dictionary,
// and full-line-translation UI lives in overlay.js (shared across every
// supported site); this file's only job is turning Crunchyroll's
// playback data into subtitle cues.
import { detectFormatAndParse } from "./subtitle-parser.js";
import {
  startTracking,
  setActiveCues,
  translateAndStore,
  flashStatus,
  setLiveText,
  resetSubtitleOffset,
  setEnabled,
} from "./overlay.js";

const runtime = typeof browser !== "undefined" ? browser : chrome;
const CHANNEL = "subtitleuebersetzer";

// Crunchyroll dub tracks (episode "versions") often only expose a
// same-language transcript as their "subtitles" entry, not a genuine
// translation. The real translated-from-Japanese tracks live under the
// Japanese-audio version of the episode — a different episode guid,
// found in `data.versions`. This maps our DeepL target-language codes
// to the Crunchyroll subtitle-locale codes so we can skip DeepL
// entirely when Crunchyroll already ships that language natively.
const DEEPL_TO_CR_LOCALE = {
  DE: "de-DE",
  "EN-US": "en-US",
  "EN-GB": "en-US",
  ES: "es-419",
  FR: "fr-FR",
  IT: "it-IT",
  "PT-BR": "pt-BR",
  "PT-PT": "pt-PT",
  RU: "ru-RU",
  PL: "pl-PL",
  NL: "nl-NL",
  TR: "tr-TR",
  KO: "ko-KR",
  ZH: "zh-CN",
};

const processedGuids = new Set();
let videoDuration = 0;

// Dub versions frequently ship a "forced/signs" track that only renders
// on-screen text (a handful of cues across a whole episode) rather than
// dialogue. Real dialogue runs well above this rate, so anything sparser
// is treated as signs-only (and the dub is transcribed live instead).
const SIGNS_ONLY_CUES_PER_MINUTE = 3;

function looksLikeSignsOnly(cues) {
  const minutes = (videoDuration || 0) / 60;
  if (minutes > 1) return cues.length / minutes < SIGNS_ONLY_CUES_PER_MINUTE;
  return cues.length < 25;
}

async function handlePlayData({ url, guid, platform, authHeader, data }) {
  if (!guid || processedGuids.has(guid)) return;
  processedGuids.add(guid);
  stopLiveSubtitles();
  resetSubtitleOffset();

  const settingsRes = await runtime.runtime
    .sendMessage({ type: "get-settings" })
    .catch(() => null);
  const enabled = settingsRes?.settings?.enabled ?? true;
  setEnabled(enabled);
  if (!enabled) {
    console.info("[subtitleübersetzer] disabled in settings");
    return;
  }
  const targetLang = settingsRes?.settings?.targetLang ?? "DE";

  const crTarget = DEEPL_TO_CR_LOCALE[targetLang];
  console.info(
    `[subtitleübersetzer] episode ${guid}: audio=${data.audioLocale}, target=${targetLang} (${crTarget}),`,
    `captions=[${Object.keys(data.captions || {})}], subtitles=[${Object.keys(data.subtitles || {})}]`
  );

  // Case 1: target language matches the audio you're actually listening
  // to (e.g. a German learner watching the German dub). Only the dub's own
  // [CC] track is word-for-word what the voices say; a same-language
  // "subtitle" track is translated from the Japanese and doesn't match the
  // dub. Without [CC], transcribe the dub live (local speech recognition).
  if (crTarget && data.audioLocale === crTarget) {
    const ccTrack = data.captions?.[crTarget];
    if (ccTrack?.url) {
      try {
        const cues = detectFormatAndParse(await (await fetch(ccTrack.url)).text());
        if (cues.length > 0 && !looksLikeSignsOnly(cues)) {
          setActiveCues(cues.map((c) => ({ ...c, translated: c.text })));
          console.info(`[subtitleübersetzer] using official ${crTarget} [CC] track (${cues.length} cues)`);
          return;
        }
      } catch (err) {
        console.warn("[subtitleübersetzer] couldn't fetch [CC] track", err);
      }
    }

    console.info(`[subtitleübersetzer] no ${crTarget} [CC] for this dub; starting live subtitles`);
    startLiveSubtitles(data.audioLocale);
    return;
  }

  // Case 2: target language differs from the audio (e.g. Japanese audio,
  // subtitles wanted in another language) — same Japanese-version source.
  await loadFromJapaneseVersion({ url, data, guid, platform, authHeader, crTarget });
}

// Our extra /play call (for the Japanese version's subtitle list) opens a
// stream session on the account. Crunchyroll limits concurrent streams, so
// close it right away the same way the web player does (best-effort).
function releasePlaySession(contentId, videoToken, authHeader) {
  if (!contentId || !videoToken || !authHeader) return;
  try {
    fetch(`https://www.crunchyroll.com/playback/v1/token/${contentId}/${videoToken}`, {
      method: "DELETE",
      headers: { authorization: authHeader },
      credentials: "include",
    }).catch(() => {});
  } catch {
    // ignore
  }
}

// Loads subtitles from the Japanese-original version of the episode
// (which carries real translated tracks in many languages). Prefers an
// official track in the target language; otherwise translates the best
// available one (English, else whatever exists) to the target via DeepL.
// (Used when the audio language differs from the target language.)
async function loadFromJapaneseVersion({ url, data, guid, platform, authHeader, crTarget }) {
  let subtitleMap = data.subtitles || {};
  const jaVersion = (data.versions || []).find((v) => v.audio_locale === "ja-JP");

  if (jaVersion && jaVersion.guid !== guid) {
    try {
      // Reuse the exact /play URL the player called (same API version and
      // query string), just swapping in the Japanese version's guid.
      const jaUrl = url && url.includes(`/${guid}/`)
        ? new URL(url.replace(`/${guid}/`, `/${jaVersion.guid}/`), location.href).href
        : `https://www.crunchyroll.com/playback/v4/${jaVersion.guid}/web/${platform}/play`;
      const res = await fetch(jaUrl, {
        headers: authHeader ? { authorization: authHeader } : {},
        credentials: "include",
      });
      if (res.ok) {
        const jaData = await res.json();
        subtitleMap = jaData.subtitles || subtitleMap;
        releasePlaySession(jaVersion.guid, jaData.token, authHeader);
      }
    } catch (err) {
      console.warn("[subtitleübersetzer] couldn't fetch Japanese-version subtitles", err);
    }
  }

  const locales = Object.keys(subtitleMap).filter((k) => k !== "none");
  if (locales.length === 0) {
    flashStatus("ⓘ Keine Untertitel für diese Folge verfügbar", 8000);
    return;
  }

  const nativeMatch = Boolean(crTarget && locales.includes(crTarget));
  const sourceLocale = nativeMatch
    ? crTarget
    : locales.includes("en-US")
      ? "en-US"
      : locales[0];
  const subUrl = subtitleMap[sourceLocale]?.url;
  if (!subUrl) {
    flashStatus("ⓘ Keine passenden Untertitel verfügbar", 8000);
    return;
  }

  try {
    const cues = detectFormatAndParse(await (await fetch(subUrl)).text());
    if (cues.length === 0) {
      flashStatus("ⓘ Untertitel leer", 6000);
      return;
    }

    if (nativeMatch) {
      // Crunchyroll already ships this exact language — use as-is, no cost.
      setActiveCues(cues.map((c) => ({ ...c, translated: c.text })));
      console.info(`[subtitleübersetzer] official ${crTarget} from Japanese version (${cues.length} cues)`);
      flashStatus(`✅ Untertitel geladen`, 4000);
    } else {
      console.info(`[subtitleübersetzer] translating ${sourceLocale} → target (${cues.length} cues)`);
      flashStatus(`⏳ Übersetze Untertitel (${sourceLocale} → Deutsch)…`, 8000);
      translateAndStore(cues);
    }

  } catch (err) {
    console.warn("[subtitleübersetzer] couldn't fetch subtitle file", err);
    flashStatus("ⓘ Untertitel konnten nicht geladen werden", 6000);
  }
}

// --- live subtitles -----------------------------------------------------
// Text comes from the local speech-recognition helper (asr-helper/) via the
// background script. Lines appear as they're spoken and fade out shortly
// after the speaker stops.
const LIVE_HOLD_MS = 3500;
let livePort = null;
let livePing = null;
let liveClear = null;
let liveConnected = false;

function startLiveSubtitles(audioLocale) {
  stopLiveSubtitles();
  setLiveText("");
  flashStatus("🎙 Live-Untertitel: verbinde…", 5000);
  const port = runtime.runtime.connect({ name: "live-asr" });
  livePort = port;
  port.onMessage.addListener((msg) => {
    if (msg.type === "status") {
      liveConnected = msg.connected;
      flashStatus(
        msg.connected
          ? "🎙 Live-Untertitel aktiv"
          : "🎙 Live-Untertitel: Helfer läuft nicht (sublingo-asr starten)",
        msg.connected ? 3000 : 0
      );
    } else if (msg.type === "line") {
      setLiveText(msg.text);
      clearTimeout(liveClear);
      liveClear = setTimeout(() => setLiveText(""), LIVE_HOLD_MS);
    }
  });
  port.onDisconnect.addListener(() => {
    if (livePort === port) livePort = null;
  });
  port.postMessage({ type: "start", lang: audioLocale });
  livePing = setInterval(() => {
    try {
      port.postMessage({ type: "ping" });
    } catch {
      // background restarted; reconnect
      clearInterval(livePing);
      startLiveSubtitles(audioLocale);
    }
  }, 10000);
}

function stopLiveSubtitles() {
  clearInterval(livePing);
  clearTimeout(liveClear);
  liveConnected = false;
  if (livePort) {
    try {
      livePort.disconnect();
    } catch {
      // already gone
    }
    livePort = null;
  }
}

startTracking((video) => {
  video.addEventListener("loadedmetadata", () => {
    videoDuration = video.duration || 0;
  });
  videoDuration = video.duration || 0;
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.channel !== CHANNEL) return;

  if (message.type === "play-data") {
    handlePlayData(message).catch((err) =>
      console.warn("[subtitleübersetzer] play-data handling failed", err)
    );
  }
});
