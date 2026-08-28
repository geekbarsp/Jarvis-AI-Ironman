import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function cosine(left, right) {
  if (!left?.length || left.length !== right?.length) return -1;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    a += left[index] ** 2;
    b += right[index] ** 2;
  }
  return a && b ? dot / Math.sqrt(a * b) : -1;
}

export class EmbeddingIndex {
  constructor(dataDir) {
    this.path = path.join(dataDir, "semantic-memory.json");
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.path, "utf8")); } catch { return { version: 1, entries: [] }; }
  }

  add(items, vectors) {
    if (!items.length || items.length !== vectors.length) return;
    const index = this.read();
    const known = new Set(index.entries.map((entry) => entry.id));
    items.forEach((item, position) => {
      const text = String(item.text || "").slice(0, 12000);
      const id = crypto.createHash("sha256").update(`${item.type || "memory"}\0${text}`).digest("hex");
      if (!text || known.has(id) || !Array.isArray(vectors[position])) return;
      index.entries.push({ id, type: item.type || "memory", ts: item.ts || new Date().toISOString(), text, vector: vectors[position] });
    });
    index.entries = index.entries.slice(-5000);
    const temporary = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(index), { mode: 0o600 });
    fs.renameSync(temporary, this.path);
  }

  search(vector, limit = 8) {
    return this.read().entries.map((entry) => ({ ...entry, score: cosine(vector, entry.vector) }))
      .filter((entry) => entry.score > 0.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  clear() {
    if (fs.existsSync(this.path)) fs.rmSync(this.path, { force: true });
  }
}

export function rankByEmbedding(queryVector, itemVectors) {
  return itemVectors.map((vector, index) => ({ index, score: cosine(queryVector, vector) })).sort((a, b) => b.score - a.score);
}
