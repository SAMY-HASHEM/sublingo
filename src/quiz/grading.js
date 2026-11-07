// Grading of a free-text vocabulary answer. Kept separate from the quiz UI
// so it can be tested outside the browser. `embed(text)` must return a
// normalized sentence vector (or be null when no model is available), and
// `translateToEnglish(text)` returns the answer in English.

// Calibrated against Xenova/all-MiniLM-L6-v2 with real right/wrong answers.
// Similarity alone isn't enough: short everyday words ("fast", "ate") score
// deceptively high against almost anything. So an answer must also be
// closer to the word's meanings than to every common word below — like an
// invisible multiple choice. Wrong answers landed at margins of −0.15 or
// lower; correct ones at +0.04 or higher.
export const CORRECT_AT = 0.42;
export const CORRECT_MARGIN = 0.05;
export const ALMOST_AT = 0.37;
export const ALMOST_MARGIN = -0.2;

export const DISTRACTORS = (
  "go come walk run eat drink sleep sit stand see look hear say speak tell ask answer give take bring buy sell pay open close start stop begin end win lose find play work learn teach read write sing dance swim fly drive ride wait stay leave arrive live die love hate like want need know think believe remember forget understand help try use make build break cut wash clean cook laugh cry smile shout fight kill " +
  "fast slow quick big small large tiny long short tall high low hot cold warm cool new old young good bad happy sad angry afraid tired hungry thirsty sick healthy rich poor strong weak easy difficult hard soft loud quiet beautiful ugly dirty full empty closed right wrong true false early late " +
  "cheerful glad joyful calm nervous proud shy brave lazy clever stupid funny serious kind friendly polite rude honest cheap expensive safe dangerous heavy light dark bright wet dry thin thick near far noisy boring interesting important normal strange famous ready busy alone together lonely bored excited surprised " +
  "house home car food water money time day night year friend family man woman child dog cat book school city country tree fruit bread door window room street world thing person"
).split(" ");

const STOPWORDS = new Set(
  "a an the to of in on at for with and or be is are was were it its that this i me my you your one oneself someone something sth sb very".split(" ")
);

function stem(w) {
  return w.replace(/(ing|ed|es|s)$/, "");
}

export function contentTokens(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Returns { verdict: "good" | "almost" | "bad", score, via }.
export async function grade(entry, answer, { embed, translateToEnglish }) {
  const answerEn = (await translateToEnglish(answer)) || answer;
  const answerTokens = new Set([...contentTokens(answerEn), ...contentTokens(answer)]);

  // 1. Dictionary match: a known single-word meaning appears in the answer.
  for (const meaning of [...(entry.meanings || []), entry.gloss || ""]) {
    const tokens = contentTokens(meaning);
    if (tokens.length === 1 && answerTokens.has(tokens[0])) {
      return { verdict: "good", score: 1, via: "dictionary" };
    }
  }
  const glossTokens = contentTokens(entry.gloss);
  if (glossTokens.length > 0 && glossTokens.every((t) => answerTokens.has(t))) {
    return { verdict: "good", score: 1, via: "dictionary" };
  }

  // 2. Meaning similarity with the local model.
  if (!embed) return { verdict: "bad", score: 0, via: "none" };
  const refs = [...(entry.meanings || []), ...(entry.definitions || [])].filter(Boolean);
  const a = await embed(answerEn);
  const refVecs = [];
  for (const ref of refs) refVecs.push(await embed(ref));
  let target = 0;
  for (const r of refVecs) target = Math.max(target, cosine(a, r));

  // Nearest everyday word — skipping only those that literally are one of
  // the word's dictionary meanings (e.g. "fast" when the saved word is
  // "schnell"). Deliberately not by similarity: embeddings place opposites
  // like fast/slow close together, and "slow" must stay as a counter-check.
  const ownTokens = new Set(
    [...(entry.meanings || []), entry.gloss].flatMap((m) => contentTokens(m))
  );
  let nearest = 0;
  for (const word of DISTRACTORS) {
    if (ownTokens.has(stem(word))) continue;
    nearest = Math.max(nearest, cosine(a, await embed(word)));
  }
  const margin = target - nearest;

  const verdict =
    target >= CORRECT_AT && margin >= CORRECT_MARGIN ? "good"
    : target >= ALMOST_AT && margin >= ALMOST_MARGIN ? "almost"
    : "bad";
  return { verdict, score: target, margin, via: "model" };
}
