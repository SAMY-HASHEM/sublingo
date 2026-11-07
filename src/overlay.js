// Shared subtitle-overlay + word-dictionary engine, used by every
// supported site's isolated-world content script. Site-specific code is
// only responsible for producing subtitle cues (via setActiveCues or
// translateAndStore) — everything about rendering, hover/click
// dictionary, full-line translation, and the sync-offset control lives
// here so adding a new site never means reimplementing the UI.

const runtime = typeof browser !== "undefined" ? browser : chrome;

let activeCues = []; // [{ start, end, text, translated }], sorted by start
let enabled = true;
let overlayEl = null;
let videoEl = null;
let rafHandle = null;
let lastShownText = null;
let activeStatus = null; // shown when no cue covers the current time

// Full-line translation state (shown while hovering the 文A button).
let currentCueLine = null;
let lastTransSource = null;
const fullTransCache = new Map();

// Timing offset for subtitles sourced from a different release/track than
// what's actually playing (e.g. a dub using a subbed release's timing).
let subtitleOffset = 0;

let onVideoChangeCb = null;
let liveMode = false;
let liveText = "";
// Per-site overrides: which <video> is the real player (pages can have
// several, e.g. hover previews), and which element to anchor the overlay
// to (some players wrap <video> in a zero-height box).
let videoSelector = "video";
let containerFor = null;

// Mouse events inside our UI must not reach the site's player — otherwise
// e.g. clicking a word also toggles YouTube's play/pause.
function shieldFromPlayer(el) {
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "click", "dblclick"]) {
    el.addEventListener(type, (e) => e.stopPropagation());
  }
}

function ensureOverlay() {
  if (overlayEl && document.body.contains(overlayEl)) return overlayEl;

  // Reloading the extension leaves the previous instance's elements on the
  // page (content-script DOM outlives the script), which showed up as two
  // subtitle bubbles / two 文A buttons. Clear any leftovers first.
  for (const id of ["subtitleuebersetzer-overlay", "su-tooltip", "su-word-panel", "su-offset"]) {
    document.querySelectorAll(`#${id}`).forEach((el) => el.remove());
  }

  overlayEl = document.createElement("div");
  overlayEl.id = "subtitleuebersetzer-overlay";
  Object.assign(overlayEl.style, {
    position: "absolute",
    left: "0",
    right: "0",
    bottom: "8%",
    textAlign: "center",
    zIndex: "2147483647",
    pointerEvents: "none",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
  });

  // A row holding the subtitle bubble and a small translate button.
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    alignItems: "flex-end",
    gap: "6px",
    maxWidth: "84%",
  });

  const bubble = document.createElement("div");
  bubble.id = "subtitleuebersetzer-text";
  Object.assign(bubble.style, {
    display: "inline-block",
    background: "rgba(0, 0, 0, 0.75)",
    color: "#fff",
    padding: "0.3em 0.6em",
    borderRadius: "4px",
    fontSize: "clamp(16px, 2.2vw, 28px)",
    lineHeight: "1.3",
    whiteSpace: "pre-line",
    // The words are interactive (hover to gloss, click for examples), so
    // the bubble must receive pointer events even though the container
    // does not (to keep the player controls clickable elsewhere).
    pointerEvents: "auto",
  });

  // Hovering the subtitle pauses the video so you can read a word; leaving
  // it resumes — unless a word has been clicked (pinned) for examples.
  bubble.addEventListener("mouseenter", pauseForHover);
  bubble.addEventListener("mouseleave", resumeAfterHover);

  // Small button beside the subtitle: hovering it pauses and shows the
  // whole line translated (same hover pattern as individual words).
  const transBtn = document.createElement("div");
  transBtn.id = "subtitleuebersetzer-transbtn";
  transBtn.textContent = "文A";
  transBtn.title = "Ganzen Satz übersetzen";
  Object.assign(transBtn.style, {
    flex: "0 0 auto",
    alignSelf: "center",
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    font: "700 12px system-ui, sans-serif",
    padding: "3px 5px",
    borderRadius: "4px",
    cursor: "pointer",
    pointerEvents: "auto",
    userSelect: "none",
  });
  transBtn.addEventListener("mouseenter", () => {
    transBtn.style.background = "#f47521";
    transBtn.style.color = "#000";
    if (!currentCueLine) return;
    pauseForHover();
    updateFullTranslation(currentCueLine);
  });
  transBtn.addEventListener("mouseleave", () => {
    transBtn.style.background = "rgba(0,0,0,0.6)";
    transBtn.style.color = "#fff";
    updateFullTranslation(null);
    resumeAfterHover();
  });

  row.appendChild(bubble);
  row.appendChild(transBtn);

  // Full-line translation, shown while hovering 文A. Positioned absolutely
  // ABOVE the subtitle so it never reflows the row — otherwise showing it
  // would push the button out from under the cursor and flicker.
  const trans = document.createElement("div");
  trans.id = "subtitleuebersetzer-fulltrans";
  Object.assign(trans.style, {
    display: "none",
    position: "absolute",
    left: "50%",
    bottom: "calc(100% + 8px)",
    transform: "translateX(-50%)",
    background: "rgba(20, 40, 60, 0.92)",
    color: "#ffd9a0",
    padding: "0.3em 0.7em",
    borderRadius: "6px",
    fontSize: "clamp(14px, 1.8vw, 22px)",
    lineHeight: "1.3",
    whiteSpace: "pre-line",
    maxWidth: "80vw",
    width: "max-content",
    textAlign: "center",
    pointerEvents: "none",
  });

  overlayEl.appendChild(row);
  overlayEl.appendChild(trans);
  shieldFromPlayer(overlayEl);
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function findVideoContainer(video) {
  const custom = containerFor?.(video);
  if (custom) return custom;
  // Most players wrap <video> in a positioned container; walking up to
  // find it keeps the overlay aligned as the player resizes/enters
  // fullscreen instead of pinning to <body>.
  let el = video.parentElement;
  while (el && el !== document.body) {
    const position = getComputedStyle(el).position;
    if (position === "relative" || position === "absolute") return el;
    el = el.parentElement;
  }
  return document.body;
}

function attachOverlayTo(video) {
  const overlay = ensureOverlay();
  const container = findVideoContainer(video);
  if (overlay.parentElement !== container) {
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    container.appendChild(overlay);
  }
}

// Fetches (once, cached) and displays the full-line translation beneath
// the subtitle. `source` is the subtitle line in the target language.
function updateFullTranslation(rawSource) {
  const trans = document.getElementById("subtitleuebersetzer-fulltrans");
  if (!trans) return;
  if (!rawSource) {
    trans.style.display = "none";
    lastTransSource = null;
    return;
  }
  // Collapse the subtitle's internal line breaks into spaces so the whole
  // block is translated as one sentence, not line-by-line.
  const source = rawSource.replace(/\s*\n\s*/g, " ").trim();
  if (source === lastTransSource) return;
  lastTransSource = source;

  const cached = fullTransCache.get(source);
  if (cached !== undefined) {
    trans.textContent = cached;
    trans.style.display = cached ? "block" : "none";
    return;
  }

  trans.textContent = "…";
  trans.style.display = "block";
  runtime.runtime
    .sendMessage({ type: "gloss-word", word: source })
    .then((res) => {
      const line = res?.ok ? res.gloss : "";
      fullTransCache.set(source, line);
      // Only apply if this line is still the one on screen.
      if (lastTransSource === source) {
        trans.textContent = line;
        trans.style.display = line ? "block" : "none";
      }
    })
    .catch(() => {
      if (lastTransSource === source) trans.style.display = "none";
    });
}

// Renders the current subtitle. Cue text is split into per-word spans so
// each word can be hovered/clicked; plain status text is shown as-is.
function showText(text, interactive) {
  if (text === lastShownText) return;
  lastShownText = text;
  const bubble = document.getElementById("subtitleuebersetzer-text");
  if (!bubble) return;

  bubble.textContent = "";
  bubble.style.visibility = text ? "visible" : "hidden";
  if (!text) return;

  if (!interactive) {
    bubble.textContent = text;
    return;
  }

  // Split on whitespace but keep the whitespace so line breaks/spacing
  // are preserved; wrap non-space tokens in hoverable spans.
  for (const token of text.split(/(\s+)/)) {
    if (token.trim() === "") {
      bubble.appendChild(document.createTextNode(token));
      continue;
    }
    const span = document.createElement("span");
    span.textContent = token;
    span.className = "su-word";
    span.style.cursor = "pointer";
    span.style.borderRadius = "3px";
    span.addEventListener("mouseenter", () => onWordHover(span, token));
    span.addEventListener("mouseleave", () => {
      span.style.background = "";
    });
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      onWordClick(span, token);
    });
    bubble.appendChild(span);
  }
}

function tick() {
  rafHandle = requestAnimationFrame(tick);
  if (!videoEl || !enabled) return;

  // Live mode: the site script feeds us the exact text its own player is
  // showing right now, so timing is the player's own.
  if (liveMode) {
    if (liveText) {
      currentCueLine = liveText;
      showText(liveText, true);
    } else {
      currentCueLine = null;
      showText(activeStatus ?? "", false);
      updateFullTranslation(null);
    }
    return;
  }

  const t = videoEl.currentTime - subtitleOffset;
  const cue = activeCues.find((c) => t >= c.start && t <= c.end);
  if (cue) {
    currentCueLine = cue.translated ?? cue.text;
    showText(currentCueLine, true);
  } else {
    currentCueLine = null;
    showText(activeStatus ?? "", false);
    updateFullTranslation(null);
  }
}

function startLoop() {
  if (rafHandle) return;
  rafHandle = requestAnimationFrame(tick);
}

// --- word dictionary --------------------------------------------------
//
// Hover a subtitle word to pause and see its meaning; click it to pin a
// panel of example sentences. Leaving the subtitle resumes playback,
// unless a word is pinned.

let hoverPaused = false; // we paused the video for reading
let pinned = false; // a word panel is open; don't auto-resume

function cleanWord(token) {
  // Strip surrounding punctuation/quotes but keep intra-word marks
  // (apostrophes, hyphens) and letters including umlauts/ß.
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

// User setting: pause the video while hovering subtitle words (default on).
let pauseOnHover = true;
// Resuming is delayed slightly so moving the mouse from a word to the 文A
// button (or back) doesn't flicker pause → play → pause.
let resumeTimer = null;

function pauseForHover() {
  clearTimeout(resumeTimer);
  if (!pauseOnHover || !videoEl || videoEl.paused) return;
  videoEl.pause();
  hoverPaused = true;
}

function resumeAfterHover() {
  hideTooltip();
  if (pinned) return;
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    // Only resume what we paused ourselves — never a pause the user made.
    if (!pinned && hoverPaused && videoEl) {
      videoEl.play().catch(() => {});
      hoverPaused = false;
    }
  }, 200);
}

function toolLayer() {
  return videoEl ? findVideoContainer(videoEl) : document.body;
}

function positionAbove(el, span) {
  const container = toolLayer();
  const cRect = container.getBoundingClientRect();
  const wRect = span.getBoundingClientRect();
  el.style.left = `${wRect.left - cRect.left + wRect.width / 2}px`;
  el.style.top = `${wRect.top - cRect.top}px`;
}

let tooltipEl = null;
function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = "none";
}

function ensureTooltip() {
  if (tooltipEl && tooltipEl.isConnected) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.id = "su-tooltip";
  Object.assign(tooltipEl.style, {
    position: "absolute",
    zIndex: "2147483647",
    transform: "translate(-50%, calc(-100% - 10px))",
    background: "#111",
    color: "#fff",
    padding: "6px 10px",
    borderRadius: "6px",
    font: "500 15px/1.3 system-ui, sans-serif",
    maxWidth: "320px",
    textAlign: "center",
    boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
    pointerEvents: "none",
    display: "none",
  });
  toolLayer().appendChild(tooltipEl);
  return tooltipEl;
}

async function onWordHover(span, token) {
  span.style.background = "rgba(244,117,33,0.5)";
  const word = cleanWord(token);
  if (!word) return;

  const tip = ensureTooltip();
  tip.textContent = "…";
  tip.style.display = "block";
  positionAbove(tip, span);

  const res = await runtime.runtime
    .sendMessage({ type: "gloss-word", word })
    .catch(() => null);

  // The subtitle may have changed while we waited; only show if still hovered.
  if (span.style.background === "") return;
  tip.textContent = res?.ok ? `${word} → ${res.gloss}` : "—";
  positionAbove(tip, span);
}

let panelEl = null;
function hidePanel() {
  if (panelEl) panelEl.remove();
  panelEl = null;
  pinned = false;
  resumeAfterHover();
}

async function onWordClick(span, token) {
  const word = cleanWord(token);
  if (!word) return;
  pinned = true;
  if (!videoEl.paused) {
    videoEl.pause();
    hoverPaused = true;
  }

  if (panelEl) panelEl.remove();
  panelEl = document.createElement("div");
  panelEl.id = "su-word-panel";
  Object.assign(panelEl.style, {
    position: "absolute",
    left: "50%",
    bottom: "20%",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    width: "min(560px, 80%)",
    maxHeight: "45%",
    overflowY: "auto",
    background: "rgba(15,15,18,0.97)",
    color: "#fff",
    padding: "14px 16px",
    borderRadius: "10px",
    font: "15px/1.45 system-ui, sans-serif",
    boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
    pointerEvents: "auto",
  });

  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "8px",
  });
  const title = document.createElement("div");
  title.textContent = word;
  title.style.fontSize = "20px";
  title.style.fontWeight = "700";
  const close = document.createElement("button");
  close.textContent = "✕";
  Object.assign(close.style, {
    cursor: "pointer",
    border: "none",
    background: "transparent",
    color: "#fff",
    fontSize: "18px",
  });
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    hidePanel();
  });
  // ⭐ save the word (with the subtitle line it came from) to the
  // vocabulary list, which the post-video quiz draws from.
  const context = (currentCueLine || span.parentElement?.textContent || "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  const star = document.createElement("button");
  star.title = "Wort speichern";
  Object.assign(star.style, {
    cursor: "pointer",
    border: "none",
    background: "transparent",
    fontSize: "22px",
    lineHeight: "1",
    color: "#ffd166",
    marginRight: "auto",
    marginLeft: "10px",
  });
  let starred = false;
  const renderStar = () => {
    star.textContent = starred ? "★" : "☆";
    star.title = starred ? "Aus der Wortliste entfernen" : "In die Wortliste speichern";
  };
  renderStar();
  runtime.runtime
    .sendMessage({ type: "is-starred", word })
    .then((res) => {
      starred = Boolean(res?.starred);
      renderStar();
    })
    .catch(() => {});
  star.addEventListener("click", async (e) => {
    e.stopPropagation();
    starred = !starred;
    renderStar();
    const res = await runtime.runtime
      .sendMessage(starred ? { type: "star-word", word, context } : { type: "unstar-word", word })
      .catch(() => null);
    if (!res?.ok) {
      starred = !starred;
      renderStar();
    }
  });

  header.style.justifyContent = "flex-start";
  header.append(title, star, close);

  const gloss = document.createElement("div");
  gloss.style.color = "#f4a261";
  gloss.style.marginBottom = "10px";
  gloss.textContent = "…";

  const examplesBox = document.createElement("div");
  examplesBox.textContent = "Beispiele werden geladen…";
  examplesBox.style.opacity = "0.85";

  panelEl.append(header, gloss, examplesBox);
  shieldFromPlayer(panelEl);
  toolLayer().appendChild(panelEl);

  const [glossRes, exRes] = await Promise.all([
    runtime.runtime.sendMessage({ type: "gloss-word", word }).catch(() => null),
    runtime.runtime.sendMessage({ type: "word-examples", word }).catch(() => null),
  ]);

  if (!panelEl) return; // closed while loading
  gloss.textContent = glossRes?.ok ? glossRes.gloss : "";

  examplesBox.textContent = "";
  const examples = exRes?.ok ? exRes.examples : [];
  if (examples.length === 0) {
    examplesBox.textContent = "Keine Beispielsätze gefunden.";
    return;
  }
  for (const ex of examples) {
    const item = document.createElement("div");
    item.style.margin = "8px 0";
    item.style.borderTop = "1px solid rgba(255,255,255,0.12)";
    item.style.paddingTop = "8px";
    const src = document.createElement("div");
    src.textContent = ex.source;
    const tr = document.createElement("div");
    tr.textContent = ex.gloss;
    tr.style.opacity = "0.7";
    tr.style.fontSize = "13px";
    item.append(src, tr);
    examplesBox.appendChild(item);
  }
}

function findAndTrackVideo() {
  const video = document.querySelector(videoSelector);
  if (video && video !== videoEl) {
    videoEl = video;
    attachOverlayTo(video);
    startLoop();
    if (!video.dataset.suEndedBound) {
      video.dataset.suEndedBound = "1";
      // Lets the background open the vocabulary quiz after each video.
      video.addEventListener("ended", () => {
        runtime.runtime.sendMessage({ type: "video-ended" }).catch(() => {});
      });
    }
    onVideoChangeCb?.(video);
  }
}

// --- public API ---------------------------------------------------------

// Begins polling for the page's <video> element and attaches the overlay
// once found. Most single-page-app players replace the element between
// videos, so this keeps running for the page's lifetime rather than
// stopping after the first match. `onVideoChange` (optional) fires with
// the new element each time a different one is found — useful for sites
// where re-detecting the video is how you notice a new video loaded.
export function startTracking(onVideoChange, options = {}) {
  onVideoChangeCb = onVideoChange || null;
  if (options.videoSelector) videoSelector = options.videoSelector;
  if (options.container) containerFor = options.container;
  findAndTrackVideo();
  setInterval(findAndTrackVideo, 1000);
}

export function setActiveCues(cues) {
  liveMode = false;
  activeCues = cues;
}

// Show exactly this text now (empty string hides the subtitle). Used by
// sites where we mirror the player's own caption rendering instead of
// timing a subtitle file ourselves.
export function setLiveText(text) {
  liveMode = true;
  liveText = text || "";
}

export function resetSubtitleOffset() {
  subtitleOffset = 0;
}

export function setEnabled(v) {
  enabled = v;
  if (!v) showText("", false);
}

// Translates cues in the background so a slow/failed API call doesn't
// block subtitle rendering; cues show in the source language until
// translations arrive.
export async function translateAndStore(cues) {
  liveMode = false;
  activeCues = cues.map((c) => ({ ...c, translated: null }));

  const CHUNK = 100;
  for (let i = 0; i < cues.length; i += CHUNK) {
    const chunk = cues.slice(i, i + CHUNK);
    try {
      const response = await runtime.runtime.sendMessage({
        type: "translate-cues",
        cues: chunk,
      });
      if (!response?.ok) {
        console.warn("[subtitleübersetzer]", response?.error);
        continue;
      }
      for (const translatedCue of response.cues) {
        const target = activeCues.find(
          (c) => c.start === translatedCue.start && c.text === translatedCue.text
        );
        if (target) target.translated = translatedCue.translated;
      }
    } catch (err) {
      console.warn("[subtitleübersetzer] translation request failed", err);
    }
  }
}

// Shown in the subtitle position when there is nothing else to display
// (e.g. a video with no subtitle track at all, or a status message).
let statusTimer = null;
export function flashStatus(text, ms = 6000) {
  activeStatus = text;
  clearTimeout(statusTimer);
  if (text && ms) statusTimer = setTimeout(() => (activeStatus = null), ms);
}

// A subtitle track sourced from a different release/track than what's
// actually playing is often a little off in timing, so a constant offset
// is useful. This small control (and the , / . keys) lets the user nudge
// it live.
export function showOffsetControl() {
  if (document.getElementById("su-offset")) return;
  const bar = document.createElement("div");
  bar.id = "su-offset";
  Object.assign(bar.style, {
    position: "absolute",
    right: "12px",
    bottom: "18%",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 8px",
    borderRadius: "6px",
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    font: "12px system-ui, sans-serif",
  });

  const label = document.createElement("span");
  const render = () => (label.textContent = `Sync ${subtitleOffset >= 0 ? "+" : ""}${subtitleOffset.toFixed(1)}s`);

  const mk = (text, delta) => {
    const b = document.createElement("button");
    b.textContent = text;
    Object.assign(b.style, {
      cursor: "pointer",
      border: "none",
      borderRadius: "4px",
      padding: "2px 8px",
      background: "#f47521",
      color: "#000",
      fontWeight: "600",
    });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      subtitleOffset = Math.round((subtitleOffset + delta) * 10) / 10;
      render();
    });
    return b;
  };

  bar.append(mk("−0.5s", -0.5), label, mk("+0.5s", 0.5));
  render();
  (videoEl ? findVideoContainer(videoEl) : document.body).appendChild(bar);

  // Keyboard: "," earlier, "." later (matches common media-player sync keys).
  document.addEventListener("keydown", (e) => {
    if (!document.getElementById("su-offset")) return;
    if (e.key === ",") { subtitleOffset -= 0.5; render(); }
    else if (e.key === ".") { subtitleOffset += 0.5; render(); }
  });
}

runtime.storage.sync
  .get({ pauseOnHover: true })
  .then((s) => (pauseOnHover = s.pauseOnHover))
  .catch(() => {});

runtime.storage.onChanged.addListener((changes) => {
  if (changes.pauseOnHover) pauseOnHover = changes.pauseOnHover.newValue;
  if (changes.enabled) setEnabled(changes.enabled.newValue);
});
