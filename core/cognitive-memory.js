import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./storage.js";

const STOP = new Set(["about", "after", "again", "from", "have", "that", "this", "with", "would", "your", "jarvis"]);

function terms(value) {
  return new Set((String(value).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((term) => !STOP.has(term)));
}

function read(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return { version: 1, episodes: value.episodes || [], procedures: value.procedures || [], preferences: value.preferences || [] };
  } catch { return { version: 1, episodes: [], procedures: [], preferences: [] }; }
}

function write(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function relevance(query, item) {
  const queryTerms = terms(query);
  const itemTerms = terms(JSON.stringify(item));
  let overlap = 0;
  for (const term of queryTerms) if (itemTerms.has(term)) overlap += 1;
  const ageDays = Math.max(0, (Date.now() - new Date(item.updatedAt || item.ts || 0).getTime()) / 86400000);
  return overlap * 4 + 1 / (1 + ageDays / 30) + Number(item.confidence || 0);
}

export class CognitiveMemory {
  constructor(dataDir, eventBus) {
    this.file = path.join(dataDir, "cognitive-memory.json");
    this.eventBus = eventBus;
    this.data = read(this.file);
  }

  persist() { write(this.file, this.data); }

  recordEpisode({ goal, context = {}, actions = [], result = "", success = false, lesson = "" }) {
    if (!actions.length && !lesson) return null;
    const episode = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      goal: redact(goal).slice(0, 2000),
      context: { activeApplication: context.activeApplication || "", activeProject: context.activeProject || "" },
      actions: actions.slice(-20).map((item) => ({ name: item.name, ok: Boolean(item.ok) })),
      result: redact(result).slice(0, 3000),
      success: Boolean(success),
      lesson: redact(lesson).slice(0, 1500),
      importance: Math.min(1, 0.35 + actions.length * 0.08 + (!success ? 0.2 : 0.1)),
    };
    this.data.episodes.push(episode);
    this.consolidate();
    this.eventBus?.publish("MEMORY_CREATED", { type: "episode", id: episode.id, goal: episode.goal, success: episode.success });
    return structuredClone(episode);
  }

  learnProcedure(name, steps, success) {
    const normalizedSteps = steps.map((step) => redact(typeof step === "string" ? step : step.name || step.action)).filter(Boolean).slice(0, 20);
    if (normalizedSteps.length < 2) return null;
    const key = normalizedSteps.join(" > ").toLowerCase();
    let procedure = this.data.procedures.find((item) => item.key === key);
    const now = new Date().toISOString();
    if (!procedure) {
      procedure = { id: crypto.randomUUID(), key, name: redact(name).slice(0, 300), steps: normalizedSteps, uses: 0, successes: 0, confidence: 0.35, createdAt: now, updatedAt: now };
      this.data.procedures.push(procedure);
    }
    procedure.uses += 1;
    if (success) procedure.successes += 1;
    procedure.successRate = +(procedure.successes / procedure.uses).toFixed(2);
    procedure.confidence = +Math.min(0.98, 0.25 + procedure.uses * 0.08 + procedure.successRate * 0.35).toFixed(2);
    procedure.lastUsedAt = now;
    procedure.updatedAt = now;
    this.consolidate();
    this.eventBus?.publish("PROCEDURE_LEARNED", { id: procedure.id, name: procedure.name, confidence: procedure.confidence });
    return structuredClone(procedure);
  }

  observePreference(category, value, source = "user_instruction") {
    const clean = redact(value).trim().slice(0, 1000);
    if (!clean) return null;
    const key = `${category}:${clean}`.toLowerCase();
    let preference = this.data.preferences.find((item) => item.key === key);
    const now = new Date().toISOString();
    if (!preference) {
      preference = { id: crypto.randomUUID(), key, category, value: clean, evidenceCount: 0, confidence: 0.35, source, createdAt: now };
      this.data.preferences.push(preference);
    }
    preference.evidenceCount += 1;
    preference.confidence = +Math.min(0.98, 0.3 + preference.evidenceCount * 0.1).toFixed(2);
    preference.updatedAt = now;
    this.consolidate();
    return structuredClone(preference);
  }

  search(query, limit = 8) {
    return [...this.data.episodes.map((item) => ({ type: "episode", ...item })), ...this.data.procedures.map((item) => ({ type: "procedure", ...item })), ...this.data.preferences.map((item) => ({ type: "preference", ...item }))]
      .map((item) => ({ item, score: relevance(query, item) }))
      .filter(({ item, score }) => score >= 4 && (item.type !== "preference" || item.confidence >= 0.55))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ item }) => item);
  }

  context(query, limit = 6) {
    return this.search(query, limit).map((item) => {
      if (item.type === "episode") return `[observed episode ${item.ts.slice(0, 10)}] ${item.goal}; result: ${item.result}; success: ${item.success}`;
      if (item.type === "procedure") return `[learned procedure confidence=${item.confidence}] ${item.name}: ${item.steps.join(" -> ")}`;
      return `[learned preference confidence=${item.confidence} evidence=${item.evidenceCount}] ${item.value}`;
    }).join("\n");
  }

  consolidate(now = Date.now()) {
    const keepEpisode = (episode) => {
      const ageDays = (now - new Date(episode.ts).getTime()) / 86400000;
      return ageDays < 180 || episode.importance >= 0.7;
    };
    this.data.episodes = this.data.episodes.filter(keepEpisode).slice(-500);
    this.data.procedures = this.data.procedures.filter((item) => item.uses > 1 || now - new Date(item.updatedAt).getTime() < 180 * 86400000).slice(-250);
    this.data.preferences = this.data.preferences.filter((item) => item.evidenceCount > 1 || now - new Date(item.updatedAt).getTime() < 120 * 86400000).slice(-250);
    this.persist();
  }

  snapshot() {
    return { episodes: this.data.episodes.slice(-20), procedures: this.data.procedures.slice(-20), preferences: this.data.preferences.slice(-20) };
  }

  clear() {
    this.data = { version: 1, episodes: [], procedures: [], preferences: [] };
    this.persist();
  }
}
