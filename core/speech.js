const ENTITIES = new Map([
  ["&amp;", "and"],
  ["&lt;", "less than"],
  ["&gt;", "greater than"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&nbsp;", " "],
]);

export function normalizeSpeechText(input) {
  return String(input || "")
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " link ")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\d)\s*\*\s*(\d)/g, "$1 times $2")
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_\n]+)_{1,3}/g, "$1")
    .replace(/[|*]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES.get(entity) || " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, ". ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}
