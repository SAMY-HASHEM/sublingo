// Free, keyless translation via Google's public endpoint. This is the
// extension's only translation provider: no account, no API key, no
// setup — the whole point is that a normal user never has to think about
// any of that. DeepL-style two-letter/region codes are normalised to the
// codes this endpoint expects.
const GT_ENDPOINT = "https://translate.googleapis.com/translate_a/single";

function toGoogleLang(code) {
  const c = (code || "").toUpperCase();
  if (c.startsWith("EN")) return "en";
  if (c.startsWith("PT")) return "pt";
  if (c.startsWith("ZH")) return "zh-CN";
  return (code || "").split("-")[0].toLowerCase();
}

// Example usages for a word, from Google's dictionary data (dt=ex).
// Returns sentences in the source language; the caller translates them.
// Same CORS-friendly endpoint as freeTranslate, so no host permission or
// key is needed.
export async function freeExamples(word, sourceLang) {
  const sl = sourceLang ? toGoogleLang(sourceLang) : "auto";
  const url =
    `${GT_ENDPOINT}?client=gtx&sl=${sl}&tl=en&dt=ex` +
    `&q=${encodeURIComponent(word)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const group = data[13]?.[0] ?? [];
    return group
      .map((item) => (item[0] || "").replace(/<\/?b>/g, "").trim())
      .filter(Boolean)
      .slice(0, 6);
  } catch {
    return [];
  }
}

export async function freeTranslate(texts, targetLang, sourceLang) {
  if (texts.length === 0) return [];
  const tl = toGoogleLang(targetLang);
  const sl = sourceLang ? toGoogleLang(sourceLang) : "auto";

  const results = [];
  for (const text of texts) {
    const url =
      `${GT_ENDPOINT}?client=gtx&sl=${sl}&tl=${tl}&dt=t` +
      `&q=${encodeURIComponent(text)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      // data[0] is an array of [translatedChunk, sourceChunk, ...].
      const translated = (data[0] ?? []).map((seg) => seg[0]).join("");
      results.push(translated || text);
    } catch {
      results.push(text);
    }
  }
  return results;
}

// All English meanings the dictionary knows for a word (e.g. "beschäftigt"
// → busy, employed, engaged, occupied, preoccupied). Used as reference
// answers when grading the vocabulary quiz.
export async function freeMeanings(word, sourceLang) {
  const sl = sourceLang ? toGoogleLang(sourceLang) : "auto";
  const url =
    `${GT_ENDPOINT}?client=gtx&sl=${sl}&tl=en&dt=t&dt=bd` +
    `&q=${encodeURIComponent(word)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    const gloss = (data[0] ?? []).map((s) => s?.[0] ?? "").join("").trim();
    if (gloss) out.push(gloss);
    for (const entry of data[1] ?? []) {
      for (const term of entry?.[1] ?? []) if (term) out.push(term);
    }
    return [...new Set(out.map((s) => s.toLowerCase()))];
  } catch {
    return [];
  }
}

// Wiktionary's Wikimedia language codes are plain ISO codes ("de", "fr").
const WIKT = "https://en.wiktionary.org/api/rest_v1/page/definition/";

function cleanWiktionary(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/\.mw-parser-output[^}]*}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function wiktionaryDefs(word, lang) {
  try {
    const res = await fetch(WIKT + encodeURIComponent(word));
    if (!res.ok) return [];
    const data = await res.json();
    const defs = [];
    for (const entry of data[lang] ?? []) {
      for (const d of entry.definitions ?? []) {
        const text = cleanWiktionary(d.definition || "");
        if (text) defs.push(text);
      }
    }
    return defs;
  } catch {
    return [];
  }
}

// A definition that only describes grammar ("past participle of X",
// "first-person singular present of X") rather than meaning.
const FORM_OF_RE =
  /\b(?:participle|inflection|plural|form|tense|singular|comparative|superlative|genitive|dative|accusative|nominative|infinitive|imperative|present|past|preterite|subjunctive|person)\b[^()]*?\bof ([\p{L}-]+)(?:\s*\([^)]*\))?\s*$/iu;

// Definitions that point at a related base word worth following — grammar
// forms plus "female equivalent of", "diminutive of" and the like. Unlike
// FORM_OF_RE these lines are kept, since they still carry meaning.
const FOLLOW_RE =
  /\b(?:participle|inflection|plural|form|tense|singular|comparative|superlative|genitive|dative|accusative|nominative|infinitive|imperative|present|past|preterite|subjunctive|person|equivalent|diminutive|feminine|masculine|variant|spelling)\b[^()]*?\bof ([\p{L}-]+)(?:\s*\([^)]*\))?\s*$/iu;

// English definitions from Wiktionary. Subtitle words may be capitalised
// or not (sentence start, German nouns), so both spellings are looked up.
// Inflected forms ("beschäftigt" = "past participle of beschäftigen") also
// pull in the base word, which is where senses like "to concern oneself"
// live.
export async function dictionaryDefinitions(word, sourceLang) {
  const lang = (sourceLang || "de").split("-")[0].toLowerCase();
  const variants = [...new Set([
    word,
    word[0].toUpperCase() + word.slice(1),
    word.toLowerCase(),
  ])];
  const defs = [];
  for (const v of variants) defs.push(...(await wiktionaryDefs(v, lang)));

  const lemmas = new Set();
  for (const d of defs) {
    const m = d.match(FOLLOW_RE);
    if (m && !variants.includes(m[1])) lemmas.add(m[1]);
  }
  for (const lemma of [...lemmas].slice(0, 2)) {
    defs.push(...(await wiktionaryDefs(lemma, lang)));
  }
  return [...new Set(defs.filter((d) => !FORM_OF_RE.test(d)))].slice(0, 12);
}
