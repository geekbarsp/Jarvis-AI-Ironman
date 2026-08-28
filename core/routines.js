import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./storage.js";

const STOP_WORDS = new Set(["a", "an", "the", "to", "for", "please", "can", "could", "would", "you", "me", "my", "jarvis", "wake", "up"]);

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { version: 1, events: [] }; }
}

function write(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function period(hour) {
  if (hour < 5) return "late night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 22) return "evening";
  return "late night";
}

function category(text) {
  const rules = [
    ["communications", /message|email|call|discord|whatsapp|contact/],
    ["files", /file|folder|document|pdf|download|desktop|backup|rename/],
    ["system", /volume|brightness|computer|windows?|minimize|shutdown|restart|clipboard/],
    ["applications", /open|launch|close|chrome|discord|spotify|notepad|app/],
    ["planning", /plan|calendar|schedule|remind|agenda|routine|task/],
    ["wellbeing", /meal|food|water|exercise|sleep|health|mood/],
    ["research", /search|find|look up|research|weather|news/],
  ];
  return rules.find(([, expression]) => expression.test(text))?.[0] || "general";
}

function signature(query) {
  return redact(query).toLowerCase()
    .replace(/\b(?:wake\s+up\s+)?jarvis\b/g, " ")
    .replace(/\b\d+(?::\d+)?\b/g, "#")
    .replace(/[^a-z#\s]/g, " ")
    .replace(/\s+/g, " ").trim().split(" ")
    .filter((word) => word && !STOP_WORDS.has(word)).slice(0, 12).join(" ");
}

export class RoutineLearner {
  constructor(dataDir) {
    this.file = path.join(dataDir, "routine-learning.json");
  }

  record(query, tools = [], at = new Date(), environment = {}) {
    const normalized = signature(query);
    if (normalized.length < 3 || normalized.includes("redacted")) return null;
    const data = read(this.file);
    const cutoff = at.getTime() - 120 * 86400000;
    data.events = (data.events || []).filter((event) => new Date(event.ts).getTime() >= cutoff).slice(-1499);
    const event = {
      id: crypto.randomUUID(),
      ts: at.toISOString(),
      signature: normalized,
      sample: redact(query).slice(0, 160),
      category: category(normalized),
      period: period(at.getHours()),
      dayType: [0, 6].includes(at.getDay()) ? "weekends" : "weekdays",
      tools: [...new Set(tools.map(String))].slice(0, 12),
      activeApplication: String(environment.activeApplication || "").slice(0, 100),
      runningApps: [...new Set((environment.runningApps || []).map(String))].slice(0, 30),
    };
    data.events.push(event);
    write(this.file, data);
    return event;
  }

  insights(at = new Date()) {
    const events = read(this.file).events || [];
    const groups = new Map();
    for (const event of events) {
      const key = `${event.signature}|${event.period}|${event.dayType}`;
      const group = groups.get(key) || { signature: event.signature, sample: event.sample, category: event.category, period: event.period, dayType: event.dayType, count: 0, tools: new Set(), lastSeen: event.ts };
      group.count += 1;
      group.lastSeen = group.lastSeen > event.ts ? group.lastSeen : event.ts;
      for (const tool of event.tools || []) group.tools.add(tool);
      groups.set(key, group);
    }
    const currentPeriod = period(at.getHours());
    const currentDayType = [0, 6].includes(at.getDay()) ? "weekends" : "weekdays";
    return [...groups.values()].filter((group) => group.count >= 3).map((group) => ({
      ...group,
      tools: [...group.tools],
      confidence: Math.min(0.98, +(0.5 + group.count * 0.08).toFixed(2)),
      relevantNow: group.period === currentPeriod && group.dayType === currentDayType,
      label: `${group.sample} - ${group.period} on ${group.dayType}`,
    })).sort((left, right) => Number(right.relevantNow) - Number(left.relevantNow) || right.count - left.count || right.lastSeen.localeCompare(left.lastSeen)).slice(0, 20);
  }

  context(at = new Date()) {
    const patterns = this.insights(at).slice(0, 6);
    const habits = this.habits().slice(0, 4);
    return [
      ...patterns.map((pattern) => `- Often requests "${pattern.sample}" in the ${pattern.period} on ${pattern.dayType} (${pattern.count} observations).`),
      ...habits.map((habit) => `- When ${habit.triggerApplication} is active, ${habit.companionApplication} is often also open (confidence ${habit.confidence}, ${habit.observations} observations). This is a suggestion signal only.`),
    ].join("\n");
  }

  habits() {
    const events = (read(this.file).events || []).filter((event) => event.activeApplication && event.runningApps?.length);
    const groups = new Map();
    for (const event of events) {
      for (const app of event.runningApps) {
        if (app.toLowerCase() === event.activeApplication.toLowerCase()) continue;
        const key = `${event.activeApplication.toLowerCase()}|${app.toLowerCase()}`;
        const item = groups.get(key) || { triggerApplication: event.activeApplication, companionApplication: app, observations: 0, lastSeen: event.ts };
        item.observations += 1;
        if (event.ts > item.lastSeen) item.lastSeen = event.ts;
        groups.set(key, item);
      }
    }
    return [...groups.values()].filter((item) => item.observations >= 3).map((item) => ({
      ...item,
      confidence: Math.min(0.95, +(0.4 + item.observations * 0.09).toFixed(2)),
    })).sort((left, right) => right.confidence - left.confidence || right.lastSeen.localeCompare(left.lastSeen)).slice(0, 20);
  }

  snapshot(at = new Date()) {
    const data = read(this.file);
    return { observations: (data.events || []).length, insights: this.insights(at), habits: this.habits() };
  }

  clear() {
    write(this.file, { version: 1, events: [] });
  }
}
