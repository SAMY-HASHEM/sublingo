import { freeTranslate, freeExamples, freeMeanings, dictionaryDefinitions } from "./translator.js";

const runtime = typeof browser !== "undefined" ? browser : chrome;

// In-memory cache, keyed by `${targetLang} ${text}`. Cleared on
// service-worker restart; subtitle lines repeat often enough within a
// single episode that this alone avoids most redundant API calls.
const cache = new Map();

async function getSettings() {
  const stored = await runtime.storage.sync.get({
    targetLang: "DE",
    enabled: true,
    // Language for the hover/click word dictionary.
    glossLang: "EN-US",
    quizAfterVideo: true,
  });
  return stored;
}

// --- word dictionary (hover / click) ---------------------------------
//
// Learners hover a word they don't know to see its meaning, and click it
// for example sentences. Both the gloss and the example sentences come
// from the free, keyless translation endpoint (no DeepL key required),
// run in the background worker (content scripts are blocked by CORS from
// it), and are cached.

const glossCache = new Map();
const exampleCache = new Map();

async function glossWord(word) {
  const { targetLang, glossLang } = await getSettings();

  const key = `${glossLang}:${word}`;
  if (glossCache.has(key)) return glossCache.get(key);

  // The subtitle is in the target language, so that's the source here.
  // Single-word glosses use the free, keyless provider — no setup needed.
  const sourceLang = (targetLang || "DE").split("-")[0];
  const [translation] = await freeTranslate([word], glossLang, sourceLang);
  const result = translation ?? word;
  glossCache.set(key, result);
  return result;
}

async function wordExamples(word) {
  const { targetLang, glossLang } = await getSettings();
  const key = `${glossLang}:${word}`;
  if (exampleCache.has(key)) return exampleCache.get(key);

  // Example sentences in the subtitle language, then each translated to
  // the dictionary language — both via the CORS-friendly free endpoint.
  const sentences = await freeExamples(word, targetLang);
  if (sentences.length === 0) {
    exampleCache.set(key, []);
    return [];
  }
  const glosses = await freeTranslate(sentences, glossLang, targetLang);
  const examples = sentences.map((source, i) => ({
    source,
    gloss: glosses[i] ?? "",
  }));
  exampleCache.set(key, examples);
  return examples;
}

async function handleTranslateCues(cues) {
  const { targetLang } = await getSettings();

  const uncached = [];
  for (const cue of cues) {
    const key = `${targetLang} ${cue.text}`;
    if (!cache.has(key)) uncached.push(cue.text);
  }

  if (uncached.length > 0) {
    const translations = await freeTranslate(uncached, targetLang);
    uncached.forEach((text, i) => {
      cache.set(`${targetLang} ${text}`, translations[i]);
    });
  }

  return cues.map((cue) => ({
    ...cue,
    translated: cache.get(`${targetLang} ${cue.text}`) ?? cue.text,
  }));
}

runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "translate-cues") return undefined;

  handleTranslateCues(message.cues)
    .then((cues) => sendResponse({ ok: true, cues }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));

  return true; // keep the message channel open for the async response
});

runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "get-settings") return undefined;
  getSettings().then((settings) => sendResponse({ ok: true, settings }));
  return true;
});

runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "gloss-word") return undefined;
  glossWord(message.word)
    .then((gloss) => sendResponse({ ok: true, gloss }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true;
});

runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "word-examples") return undefined;
  wordExamples(message.word)
    .then((examples) => sendResponse({ ok: true, examples }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true;
});


// --- starred words (vocabulary list) ---------------------------------
//
// Stored in storage.local (not sync: sync has a ~100 KB quota, and a
// growing word list with context sentences would outgrow it). Keyed by
// language + lowercased word, so the same spelling in two languages
// doesn't collide.

const vocabKey = (lang, word) => `${lang}:${word.toLowerCase()}`;

async function getVocab() {
  const { vocab } = await runtime.storage.local.get({ vocab: {} });
  return vocab;
}

async function saveVocab(vocab) {
  await runtime.storage.local.set({ vocab });
}

async function starWord({ word, context }) {
  const { targetLang, glossLang } = await getSettings();
  const vocab = await getVocab();
  const key = vocabKey(targetLang, word);
  if (vocab[key]) return vocab[key];

  const lang = (targetLang || "DE").split("-")[0];
  // Reference meanings for grading the quiz are gathered once, here, so
  // the quiz itself works even when offline later.
  const [gloss, meanings, definitions, contextEn] = await Promise.all([
    freeTranslate([word], glossLang, lang).then((r) => r[0] ?? ""),
    freeMeanings(word, lang),
    dictionaryDefinitions(word, lang),
    context ? freeTranslate([context], "EN-US", lang).then((r) => r[0] ?? "") : "",
  ]);

  vocab[key] = {
    word,
    lang: targetLang,
    gloss,
    meanings,
    definitions,
    context: context || "",
    contextEn,
    addedAt: Date.now(),
    level: 0,
    correct: 0,
    wrong: 0,
    lastAsked: 0,
  };
  await saveVocab(vocab);
  return vocab[key];
}

async function unstarWord({ word }) {
  const { targetLang } = await getSettings();
  const vocab = await getVocab();
  delete vocab[vocabKey(targetLang, word)];
  await saveVocab(vocab);
}

runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "star-word") {
    starWord(message)
      .then((entry) => sendResponse({ ok: true, entry }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }
  if (message?.type === "unstar-word") {
    unstarWord(message).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "is-starred") {
    Promise.all([getSettings(), getVocab()]).then(([s, vocab]) =>
      sendResponse({ ok: true, starred: Boolean(vocab[vocabKey(s.targetLang, message.word)]) })
    );
    return true;
  }
  return undefined;
});

// --- quiz after each video --------------------------------------------

let lastQuizOpenedAt = 0;

function openQuizTab(hash = "") {
  return runtime.tabs.create({ url: runtime.runtime.getURL(`quiz/quiz.html${hash}`) });
}

runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "open-quiz") {
    openQuizTab(message.view === "list" ? "#list" : "").then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type !== "video-ended") return undefined;
  (async () => {
    const { quizAfterVideo } = await getSettings();
    const vocab = await getVocab();
    // Only quiz when there's something to ask, and never open two quiz tabs
    // in quick succession (e.g. a short video ending twice).
    if (!quizAfterVideo || Object.keys(vocab).length === 0) return;
    if (Date.now() - lastQuizOpenedAt < 60_000) return;
    lastQuizOpenedAt = Date.now();
    await openQuizTab();
  })().finally(() => sendResponse({ ok: true }));
  return true;
});

// --- live subtitles (local speech-recognition helper) ----------------
//
// For dubs without a subtitle track in their own language, a local helper
// (asr-helper/sublingo_asr.py) transcribes the PC's audio output with
// NVIDIA's Nemotron ASR model and streams the text over a WebSocket.
// Only extensions may connect to it, so the socket lives here (its Origin
// is moz-extension://…); each tab that wants live text holds a Port to us
// and gets the lines forwarded. The Port's pings also keep this
// non-persistent background script awake while live mode is in use.

const ASR_URL = "ws://127.0.0.1:8765";
const livePorts = new Map(); // Port -> { lang }
let asrSocket = null;
let asrConnected = false;
let asrRetryTimer = null;

function asrBroadcast(message) {
  for (const port of livePorts.keys()) {
    try {
      port.postMessage(message);
    } catch {
      // port already gone
    }
  }
}

function asrSendDesiredState() {
  if (!asrSocket || asrSocket.readyState !== WebSocket.OPEN) return;
  const ports = [...livePorts.values()];
  asrSocket.send(
    JSON.stringify(
      ports.length > 0
        ? { type: "start", lang: ports[ports.length - 1].lang }
        : { type: "stop" }
    )
  );
}

function asrConnect() {
  clearTimeout(asrRetryTimer);
  if (livePorts.size === 0) return;
  if (asrSocket && asrSocket.readyState <= WebSocket.OPEN) return;

  let socket;
  try {
    socket = new WebSocket(ASR_URL);
  } catch {
    asrRetryTimer = setTimeout(asrConnect, 3000);
    return;
  }
  asrSocket = socket;
  socket.onopen = () => {
    asrConnected = true;
    asrBroadcast({ type: "status", connected: true });
    asrSendDesiredState();
  };
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "line") asrBroadcast({ type: "line", text: msg.text, final: msg.final });
  };
  socket.onclose = () => {
    if (asrSocket === socket) asrSocket = null;
    if (asrConnected || livePorts.size > 0) asrBroadcast({ type: "status", connected: false });
    asrConnected = false;
    if (livePorts.size > 0) asrRetryTimer = setTimeout(asrConnect, 3000);
  };
}

runtime.runtime.onConnect.addListener((port) => {
  if (port.name !== "live-asr") return;
  livePorts.set(port, { lang: "de-DE" });
  port.onMessage.addListener((msg) => {
    if (msg?.type === "start") {
      livePorts.set(port, { lang: msg.lang || "de-DE" });
      if (asrConnected) {
        port.postMessage({ type: "status", connected: true });
        asrSendDesiredState();
      } else {
        asrConnect();
      }
    }
    // "ping" needs no reply; receiving it keeps the background alive.
  });
  port.onDisconnect.addListener(() => {
    livePorts.delete(port);
    asrSendDesiredState();
    if (livePorts.size === 0 && asrSocket) {
      asrSocket.close();
      asrSocket = null;
    }
  });
});
