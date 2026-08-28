import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TOPICS = ["identity", "preferences", "goals", "relationships", "health", "work", "projects", "places", "other"];
const STOP_WORDS = new Set(["about", "after", "again", "also", "because", "could", "from", "have", "into", "just", "that", "their", "there", "these", "they", "this", "what", "when", "where", "which", "with", "would", "your"]);

export function redact(text) {
  return String(text || "")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*\b/gi, "[REDACTED_AUTH]")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_CARD]")
    .replace(/((?:password|passwd|secret|api[_ -]?key|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 24000);
}

function tokens(text) {
  return new Set((String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((word) => !STOP_WORDS.has(word)));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return structuredClone(fallback); }
}

function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJsonLines(file, limit = 2000) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).slice(-limit);
}

function appendJsonLine(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function inferTopic(fact) {
  const text = fact.toLowerCase();
  const rules = [
    ["health", /health|medical|allerg|weight|exercise|sleep|doctor|calorie|diet/],
    ["preferences", /prefer|favorite|favourite|like|dislike|love|hate|usually/],
    ["goals", /goal|plan to|want to|aim|target|deadline/],
    ["relationships", /wife|husband|partner|friend|mother|father|brother|sister|family/],
    ["work", /job|company|client|coworker|manager|work|career/],
    ["projects", /project|codename|repository|repo|building|developing/],
    ["places", /live in|located|address|city|country|travel/],
    ["identity", /my name|i am|i'm|birthday|age|pronoun/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || "other";
}

export class DataStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.dialoguePath = path.join(dataDir, "memory.jsonl");
    this.diaryPath = path.join(dataDir, "diary.jsonl");
    this.graphPath = path.join(dataDir, "knowledge-graph.json");
    this.mealsPath = path.join(dataDir, "meals.json");
    this.dictationPath = path.join(dataDir, "dictation-history.jsonl");
  }

  appendDialogue(role, content, metadata = {}) {
    const clean = redact(content).trim();
    if (!clean) return;
    appendJsonLine(this.dialoguePath, { id: crypto.randomUUID(), ts: new Date().toISOString(), role, content: clean, ...metadata });
  }

  appendDiary(user, assistant) {
    appendJsonLine(this.diaryPath, {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      user: redact(user),
      assistant: redact(assistant),
    });
  }

  addFacts(facts) {
    const graph = readJson(this.graphPath, { version: 1, topics: Object.fromEntries(TOPICS.map((topic) => [topic, []])) });
    graph.topics ||= {};
    for (const candidate of facts || []) {
      const text = redact(typeof candidate === "string" ? candidate : candidate?.text).trim();
      if (text.length < 4) continue;
      const topic = TOPICS.includes(candidate?.topic) ? candidate.topic : inferTopic(text);
      graph.topics[topic] ||= [];
      const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const existing = graph.topics[topic].find((fact) => fact.normalized === normalized);
      if (existing) existing.updatedAt = new Date().toISOString();
      else graph.topics[topic].push({ id: crypto.randomUUID(), text, normalized, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      graph.topics[topic] = graph.topics[topic].slice(-250);
    }
    writeJson(this.graphPath, graph);
  }

  searchMemory(query, limit = 12) {
    const queryTokens = tokens(query);
    const dialogue = readJsonLines(this.dialoguePath, 3000).map((entry) => ({ type: "dialogue", ts: entry.ts, text: `${entry.role}: ${entry.content}` }));
    const diary = readJsonLines(this.diaryPath, 1000).map((entry) => ({ type: "diary", ts: entry.ts, text: `User: ${entry.user}\nJARVIS: ${entry.assistant}` }));
    const graph = readJson(this.graphPath, { topics: {} });
    const facts = Object.entries(graph.topics || {}).flatMap(([topic, values]) => (values || []).map((fact) => ({ type: `knowledge:${topic}`, ts: fact.updatedAt, text: fact.text })));
    const meals = this.getMeals({ limit: 100 }).map((meal) => ({ type: "meal", ts: meal.ts, text: `meal food ate nutrition: ${meal.description}; ${meal.calories || "unknown"} kcal` }));
    const all = [...dialogue, ...diary, ...facts, ...meals];
    return all.map((entry, index) => {
      const itemTokens = tokens(entry.text);
      let overlap = 0;
      for (const token of queryTokens) if (itemTokens.has(token)) overlap += 1;
      const ageDays = Math.max(0, (Date.now() - new Date(entry.ts || 0).getTime()) / 86400000);
      const recency = 1 / (1 + ageDays / 30);
      return { ...entry, overlap, score: overlap * 4 + recency, index };
    }).filter((entry) => entry.overlap > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, limit);
  }

  memoryContext(query, limit = 12) {
    return this.searchMemory(query, limit).map((entry) => `[${entry.type} ${String(entry.ts || "").slice(0, 10)}] ${entry.text}`).join("\n");
  }

  logMeal(meal) {
    const meals = readJson(this.mealsPath, []);
    const saved = {
      id: crypto.randomUUID(),
      ts: meal.ts || new Date().toISOString(),
      description: redact(meal.description || "meal"),
      calories: Number.isFinite(Number(meal.calories)) ? Number(meal.calories) : null,
      protein: Number.isFinite(Number(meal.protein)) ? Number(meal.protein) : null,
      carbs: Number.isFinite(Number(meal.carbs)) ? Number(meal.carbs) : null,
      fat: Number.isFinite(Number(meal.fat)) ? Number(meal.fat) : null,
    };
    meals.push(saved);
    writeJson(this.mealsPath, meals.slice(-5000));
    return saved;
  }

  getMeals({ from, to, limit = 50 } = {}) {
    return readJson(this.mealsPath, []).filter((meal) => (!from || meal.ts >= from) && (!to || meal.ts <= to)).slice(-limit);
  }

  deleteMeal(id) {
    const meals = readJson(this.mealsPath, []);
    const next = meals.filter((meal) => meal.id !== id);
    writeJson(this.mealsPath, next);
    return next.length !== meals.length;
  }

  addDictation(text, app = "") {
    appendJsonLine(this.dictationPath, { id: crypto.randomUUID(), ts: new Date().toISOString(), text: redact(text), app });
  }

  getDictations(limit = 200) {
    return readJsonLines(this.dictationPath, limit);
  }

  snapshot() {
    return {
      dialogue: readJsonLines(this.dialoguePath, 500),
      diary: readJsonLines(this.diaryPath, 500),
      graph: readJson(this.graphPath, { version: 1, topics: {} }),
      meals: this.getMeals({ limit: 500 }),
      dictation: this.getDictations(200),
    };
  }

  clear() {
    for (const file of [this.dialoguePath, this.diaryPath, this.dictationPath]) if (fs.existsSync(file)) fs.truncateSync(file, 0);
    writeJson(this.graphPath, { version: 1, topics: Object.fromEntries(TOPICS.map((topic) => [topic, []])) });
  }
}
