// Parses WebVTT and SubStation Alpha (.ass/.ssa) subtitle text into a
// common cue list: [{ start, end, text }] with start/end in seconds.

function timeToSeconds(h, m, s, frac) {
  return (
    Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac || "0"}`)
  );
}

export function parseVTT(raw) {
  const cues = [];
  const blocks = raw.replace(/\r/g, "").split(/\n\n+/);
  const timeRe =
    /(\d{2}):(\d{2}):(\d{2})[.,](\d+)\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d+)/;

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;

    const timeLineIndex = lines.findIndex((l) => timeRe.test(l));
    if (timeLineIndex === -1) continue;

    const match = lines[timeLineIndex].match(timeRe);
    const start = timeToSeconds(match[1], match[2], match[3], match[4]);
    const end = timeToSeconds(match[5], match[6], match[7], match[8]);
    const text = lines
      .slice(timeLineIndex + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .trim();

    if (text) cues.push({ start, end, text });
  }

  return cues;
}

export function parseASS(raw) {
  const cues = [];
  const lines = raw.replace(/\r/g, "").split("\n");

  let formatFields = null;

  for (const line of lines) {
    if (/^Format:/i.test(line)) {
      formatFields = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line) || !formatFields) continue;

    const value = line.slice(line.indexOf(":") + 1);
    const parts = value.split(",");
    // "Text" is the last format field and may itself contain commas,
    // so rejoin anything past the known field count.
    const textFieldIndex = formatFields.indexOf("text");
    const fixedParts = parts.slice(0, textFieldIndex);
    const text = parts.slice(textFieldIndex).join(",");

    const startIndex = formatFields.indexOf("start");
    const endIndex = formatFields.indexOf("end");
    const start = parseAssAbsoluteTime(fixedParts[startIndex]);
    const end = parseAssAbsoluteTime(fixedParts[endIndex]);
    if (start == null || end == null) continue;

    const cleanText = text
      .replace(/\{[^}]*\}/g, "") // strip override tags like {\an8}
      .replace(/\\N/gi, "\n")
      .trim();

    if (cleanText) cues.push({ start, end, text: cleanText });
  }

  return cues;
}

function parseAssAbsoluteTime(t) {
  const m = t && t.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  if (!m) return null;
  return (
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100
  );
}

export function detectFormatAndParse(raw) {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("WEBVTT")) return parseVTT(raw);
  if (/^\[Script Info\]/im.test(trimmed) || /^\[Events\]/im.test(trimmed)) {
    return parseASS(raw);
  }
  // Fallback: try VTT-style timestamps anyway.
  return parseVTT(raw);
}
