import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./storage.js";

function sanitize(value, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return redact(value).slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/password|secret|api.?key|token|authorization/i.test(key))
    .map(([key, item]) => [key, sanitize(item, depth + 1)]));
}

export class CognitiveEventBus extends EventEmitter {
  constructor(dataDir, limit = 250) {
    super();
    this.limit = limit;
    this.file = path.join(dataDir, "cognitive-events.jsonl");
    this.history = [];
  }

  publish(type, detail = {}) {
    const event = { type, ts: new Date().toISOString(), detail: sanitize(detail) };
    this.history.push(event);
    this.history = this.history.slice(-this.limit);
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.emit(type, event);
    this.emit("event", event);
    return event;
  }

  recent(limit = 40) {
    return structuredClone(this.history.slice(-Math.max(1, Math.min(limit, this.limit))));
  }

  clear() {
    this.history = [];
    if (fs.existsSync(this.file)) fs.truncateSync(this.file, 0);
  }
}
