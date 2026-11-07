const runtime = typeof browser !== "undefined" ? browser : chrome;

// The 20 languages with the largest combination of native/second-language
// speakers and learners worldwide (blending native-speaker counts with
// popular-to-learn languages). Translation always uses the free, keyless
// provider — no account or API key needed for any of them.
const LANGUAGES = [
  ["EN-US", "English (US)"],
  ["EN-GB", "English (UK)"],
  ["ZH", "Chinese (Mandarin)"],
  ["ES", "Spanish"],
  ["HI", "Hindi"],
  ["AR", "Arabic"],
  ["BN", "Bengali"],
  ["PT-BR", "Portuguese (BR)"],
  ["PT-PT", "Portuguese (PT)"],
  ["RU", "Russian"],
  ["JA", "Japanese"],
  ["DE", "German"],
  ["FR", "French"],
  ["VI", "Vietnamese"],
  ["TR", "Turkish"],
  ["KO", "Korean"],
  ["IT", "Italian"],
  ["PL", "Polish"],
  ["UK", "Ukrainian"],
  ["NL", "Dutch"],
  ["SV", "Swedish"],
  ["ID", "Indonesian"],
];

const $enabled = document.getElementById("enabled");
const $targetLang = document.getElementById("targetLang");
const $glossLang = document.getElementById("glossLang");
const $pauseOnHover = document.getElementById("pauseOnHover");
const $quizAfterVideo = document.getElementById("quizAfterVideo");
const $save = document.getElementById("save");
const $status = document.getElementById("status");

for (const [code, label] of LANGUAGES) {
  $targetLang.appendChild(new Option(label, code));
  $glossLang.appendChild(new Option(label, code));
}

async function load() {
  const settings = await runtime.storage.sync.get({
    targetLang: "DE",
    enabled: true,
    glossLang: "EN-US",
    pauseOnHover: true,
    quizAfterVideo: true,
  });
  $quizAfterVideo.checked = settings.quizAfterVideo;
  $pauseOnHover.checked = settings.pauseOnHover;
  $targetLang.value = settings.targetLang;
  $enabled.checked = settings.enabled;
  $glossLang.value = settings.glossLang;
}

$save.addEventListener("click", async () => {
  await runtime.storage.sync.set({
    targetLang: $targetLang.value,
    enabled: $enabled.checked,
    glossLang: $glossLang.value,
    pauseOnHover: $pauseOnHover.checked,
    quizAfterVideo: $quizAfterVideo.checked,
  });
  $status.textContent = "Saved. Reload the video tab to apply.";
  setTimeout(() => ($status.textContent = ""), 2500);
});

document.getElementById("openQuiz").addEventListener("click", () => {
  runtime.runtime.sendMessage({ type: "open-quiz" });
  window.close();
});
document.getElementById("openList").addEventListener("click", () => {
  runtime.runtime.sendMessage({ type: "open-quiz", view: "list" });
  window.close();
});
runtime.storage.local.get({ vocab: {} }).then(({ vocab }) => {
  const n = Object.keys(vocab).length;
  document.getElementById("vocabCount").textContent = n ? `(${n})` : "";
});

load();
