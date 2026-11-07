// Vocabulary quiz + word list (extension page).
//
// Grading a free-text answer, without any account or API key:
//  1. The answer is translated to English with the free endpoint (so the
//     learner can answer in German, English, or anything else).
//  2. Dictionary match: if it contains one of the word's known meanings
//     ("busy", "occupied", ...) it's correct immediately.
//  3. Otherwise a small sentence-similarity model running locally in the
//     browser compares its meaning with the stored reference meanings.
//     Only the model weights (~23 MB, once, then cached) are downloaded;
//     the runtime code ships inside the extension.
import { pipeline, env } from "@huggingface/transformers";
import { freeTranslate } from "../translator.js";
import { grade as gradeAnswer } from "./grading.js";

const runtime = typeof browser !== "undefined" ? browser : chrome;

const MAX_LEVEL = 5; // level at which a word counts as learned
const PER_ROUND = 5;

// --- local model -----------------------------------------------------

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = {
  mjs: runtime.runtime.getURL("ort/ort-wasm-simd-threaded.mjs"),
  wasm: runtime.runtime.getURL("ort/ort-wasm-simd-threaded.wasm"),
};
// Extension pages aren't cross-origin isolated, so no SharedArrayBuffer:
// run single-threaded.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

const $modelStatus = document.getElementById("model-status");
let modelPromise = null;
let modelFailed = false;

function loadModel() {
  if (modelPromise) return modelPromise;
  $modelStatus.textContent = "KI zum Bewerten wird geladen…";
  modelPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p) => {
      if (p.status === "progress" && p.file?.endsWith(".onnx")) {
        $modelStatus.textContent =
          `KI wird einmalig heruntergeladen (~23 MB): ${Math.round(p.progress || 0)} %`;
      }
    },
  })
    .then((model) => {
      $modelStatus.textContent = "";
      return model;
    })
    .catch((err) => {
      console.warn("[subtitleübersetzer] model load failed", err);
      modelFailed = true;
      $modelStatus.textContent =
        "KI konnte nicht geladen werden – Bewertung nur per Wörterbuch.";
      return null;
    });
  return modelPromise;
}

const vecCache = new Map();
async function embed(model, text) {
  if (vecCache.has(text)) return vecCache.get(text);
  const out = await model(text, { pooling: "mean", normalize: true });
  vecCache.set(text, out.data);
  return out.data;
}

async function grade(entry, answer) {
  const model = await loadModel();
  return gradeAnswer(entry, answer, {
    embed: model ? (text) => embed(model, text) : null,
    translateToEnglish: async (text) => (await freeTranslate([text], "EN-US"))[0],
  });
}

// --- storage -------------------------------------------------------------

async function getVocab() {
  const { vocab } = await runtime.storage.local.get({ vocab: {} });
  return vocab;
}

async function updateEntry(key, patch) {
  const vocab = await getVocab();
  if (!vocab[key]) return;
  Object.assign(vocab[key], patch);
  await runtime.storage.local.set({ vocab });
}

// Least-known words first, then the ones not asked for the longest time.
function pickRound(vocab) {
  const entries = Object.entries(vocab);
  const learning = entries.filter(([, e]) => (e.level || 0) < MAX_LEVEL);
  const pool = learning.length > 0 ? learning : entries;
  pool.sort(([, a], [, b]) => (a.level || 0) - (b.level || 0) || (a.lastAsked || 0) - (b.lastAsked || 0));
  return pool.slice(0, PER_ROUND);
}

// --- quiz view -----------------------------------------------------------

const $ = (id) => document.getElementById(id);
let round = [];
let index = 0;
let correctCount = 0;
let current = null; // { key, entry, levelBefore, verdict }

// Renders the context sentence with the quizzed word highlighted, using DOM
// nodes rather than HTML strings (the sentence comes from subtitle text).
function renderContext(el, entry) {
  el.textContent = "";
  const ctx = entry.context || "";
  if (!ctx) return;
  const i = ctx.toLowerCase().indexOf(entry.word.toLowerCase());
  el.append("„");
  if (i < 0) {
    el.append(ctx);
  } else {
    const mark = document.createElement("mark");
    mark.textContent = ctx.slice(i, i + entry.word.length);
    el.append(ctx.slice(0, i), mark, ctx.slice(i + entry.word.length));
  }
  el.append("“");
}

function showQuestion() {
  const [key, entry] = round[index];
  current = { key, entry, levelBefore: entry.level || 0, verdict: null };
  $("progress").textContent = `Wort ${index + 1} von ${round.length}`;
  $("word").textContent = entry.word;
  renderContext($("context"), entry);
  $("answer").value = "";
  $("answer").disabled = false;
  $("check").disabled = false;
  $("dontknow").disabled = false;
  $("result").hidden = true;
  $("card").hidden = false;
  $("answer").focus();
}

async function applyVerdict(verdict) {
  current.verdict = verdict;
  const { key, entry, levelBefore } = current;
  const level =
    verdict === "good" ? Math.min(MAX_LEVEL, levelBefore + 1)
    : verdict === "almost" ? levelBefore
    : 0;
  await updateEntry(key, {
    level,
    lastAsked: Date.now(),
    correct: (entry.correct || 0) + (verdict === "good" ? 1 : 0),
    wrong: (entry.wrong || 0) + (verdict === "bad" ? 1 : 0),
  });
}

function showResult(verdict) {
  const { entry } = current;
  const labels = {
    good: "✅ Richtig!",
    almost: "🟡 Fast – in die richtige Richtung",
    bad: "❌ Leider nicht",
  };
  $("verdict").textContent = labels[verdict];
  $("verdict").className = `verdict ${verdict}`;
  $("solution").textContent = entry.gloss || entry.word;
  const extra = [...new Set([...(entry.meanings || []), ...(entry.definitions || []).slice(0, 2)])];
  $("solution-extra").textContent = extra.length ? extra.join(" · ") : "";
  $("override").hidden = verdict === "good";
  $("result").hidden = false;
  $("next").focus();
}

async function check() {
  const answer = $("answer").value.trim();
  if (!answer) return;
  $("check").disabled = true;
  $("dontknow").disabled = true;
  $("answer").disabled = true;
  $("verdict").textContent = "";
  const { verdict } = await grade(current.entry, answer);
  if (verdict === "good") correctCount += 1;
  await applyVerdict(verdict);
  showResult(verdict);
}

async function dontKnow() {
  $("check").disabled = true;
  $("dontknow").disabled = true;
  $("answer").disabled = true;
  await applyVerdict("bad");
  showResult("bad");
}

// The model can't judge vague descriptions perfectly; let the learner
// correct it.
async function override() {
  correctCount += 1;
  await applyVerdict("good");
  showResult("good");
}

function next() {
  index += 1;
  if (index < round.length) {
    showQuestion();
    return;
  }
  $("card").hidden = true;
  $("progress").textContent = "";
  $("summary").textContent = `${correctCount} von ${round.length} richtig`;
  $("done").hidden = false;
}

async function startRound() {
  $("done").hidden = true;
  $("empty").hidden = true;
  const vocab = await getVocab();
  round = pickRound(vocab);
  index = 0;
  correctCount = 0;
  if (round.length === 0) {
    $("card").hidden = true;
    $("progress").textContent = "";
    $("empty").hidden = false;
    return;
  }
  loadModel(); // start downloading/warming up while the first word is read
  showQuestion();
}

$("check").addEventListener("click", check);
$("dontknow").addEventListener("click", dontKnow);
$("override").addEventListener("click", override);
$("next").addEventListener("click", next);
$("again").addEventListener("click", startRound);
$("close").addEventListener("click", () => window.close());
$("answer").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!$("check").disabled) check();
  }
});

// --- word list view --------------------------------------------------------

async function renderList() {
  const vocab = await getVocab();
  const entries = Object.entries(vocab).sort(([, a], [, b]) => (b.addedAt || 0) - (a.addedAt || 0));
  const learned = entries.filter(([, e]) => (e.level || 0) >= MAX_LEVEL).length;
  $("list-count").textContent =
    `${entries.length} Wörter gespeichert · ${learned} gelernt`;

  const tbody = document.querySelector("#list tbody");
  tbody.textContent = "";
  for (const [key, e] of entries) {
    const tr = document.createElement("tr");
    const cells = [
      e.word,
      e.gloss || "",
      e.context || "",
      "●".repeat(e.level || 0) + "○".repeat(MAX_LEVEL - (e.level || 0)),
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i === 0) td.style.fontWeight = "700";
      if (i === 2) td.className = "ctx";
      if (i === 3) td.className = "dots";
      tr.appendChild(td);
    });
    const del = document.createElement("button");
    del.textContent = "Entfernen";
    del.addEventListener("click", async () => {
      const v = await getVocab();
      delete v[key];
      await runtime.storage.local.set({ vocab: v });
      renderList();
    });
    const td = document.createElement("td");
    td.appendChild(del);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

// --- views -------------------------------------------------------------------

function showView(name) {
  $("view-quiz").hidden = name !== "quiz";
  $("view-list").hidden = name !== "list";
  $("tab-quiz").classList.toggle("active", name === "quiz");
  $("tab-list").classList.toggle("active", name === "list");
  if (name === "list") renderList();
  else startRound();
}

$("tab-quiz").addEventListener("click", () => {
  location.hash = "";
  showView("quiz");
});
$("tab-list").addEventListener("click", () => {
  location.hash = "list";
  showView("list");
});

showView(location.hash === "#list" ? "list" : "quiz");
