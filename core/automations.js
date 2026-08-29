import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./storage.js";

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function getPath(value, dotted) {
  return String(dotted || "").split(".").reduce((item, key) => item?.[key], value);
}

function matchesValue(actual, expected, operator = "equals") {
  if (operator === "includes") return String(actual || "").toLowerCase().includes(String(expected || "").toLowerCase());
  if (operator === "gte") return Number(actual) >= Number(expected);
  if (operator === "lte") return Number(actual) <= Number(expected);
  return String(actual || "").toLowerCase() === String(expected || "").toLowerCase();
}

function containsSensitive(value, key = "", depth = 0) {
  if (depth > 8) return false;
  if (/password|secret|api.?key|token|authorization/i.test(key)) return value !== undefined && value !== "";
  if (Array.isArray(value)) return value.some((item) => containsSensitive(item, "", depth + 1));
  if (value && typeof value === "object") return Object.entries(value).some(([childKey, item]) => containsSensitive(item, childKey, depth + 1));
  return false;
}

function validateSafeActions(actions) {
  const blockedTools = new Set(["automations", "taskGraph", "securityTools", "advancedFileManagement", "developerTools", "phoneTools", "contacts", "workspaceDelete"]);
  const blockedOperations = /^(?:shutdown|restart|sleep|hibernate|delete|cancelAll|emptyRecycleBin|encrypt|decrypt|gitPush|pipInstall|pipUninstall)$/i;
  for (const action of actions) {
    if (!String(action?.tool || "").trim()) throw new Error("Every automation action requires a tool.");
    if (blockedTools.has(action.tool) || blockedOperations.test(String(action.arguments?.operation || action.arguments?.action || ""))) throw new Error(`${action.tool} is not allowed in unattended automations.`);
  }
}

export function parseAutomationRule(text) {
  const value = String(text || "").trim();
  const match = value.match(/\b(?:whenever|when)\s+(?:i\s+)?(?:launch|open|start)\s+(.+?)(?:,|\s+then\s+)\s*(.+)$/i);
  if (!match) return null;
  const application = match[1].trim();
  const clauses = match[2].split(/\s+and\s+/i);
  const actions = clauses.flatMap((clause) => {
    const action = clause.match(/\b(open|launch|start|close|quit)\s+(.+)/i);
    if (!action) return [];
    return [{ tool: "manageApps", arguments: { operation: /close|quit/i.test(action[1]) ? "close" : "open", target: action[2].trim(), ...(/close|quit/i.test(action[1]) ? { confirm: true } : {}) } }];
  });
  if (!actions.length) return null;
  return { name: `${application} workflow`, trigger: { type: "APPLICATION_STARTED", path: "detail.application", operator: "includes", value: application }, conditions: [], actions };
}

export class AutomationEngine {
  constructor(dataDir, { eventBus = null, runner = null, contextEngine = null, now = () => new Date() } = {}) {
    this.file = path.join(dataDir, "automations.json");
    this.events = eventBus;
    this.runner = runner;
    this.context = contextEngine;
    this.now = now;
    this.executing = new Set();
    this.timer = null;
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch { this.data = { version: 1, rules: [], runs: [] }; }
    this.listener = (event) => { this.handle(event).catch((error) => this.events?.publish("AUTOMATION_ENGINE_ERROR", { error: error.message })); };
    this.events?.on("event", this.listener);
  }

  persist() { atomicJson(this.file, this.data); }
  list() { return structuredClone(this.data.rules); }
  runs(limit = 30) { return structuredClone(this.data.runs.slice(-limit).reverse()); }

  create(input) {
    const parsed = typeof input === "string" ? parseAutomationRule(input) : input;
    if (!parsed?.trigger?.type || !Array.isArray(parsed.actions) || !parsed.actions.length) throw new Error("Automation requires a trigger and at least one action.");
    if (containsSensitive(parsed.actions)) throw new Error("Credentials cannot be stored in a persistent automation.");
    validateSafeActions(parsed.actions);
    const now = this.now().toISOString();
    const rule = {
      id: crypto.randomUUID(),
      name: redact(parsed.name || "Automation").slice(0, 300),
      enabled: parsed.enabled !== false,
      trigger: parsed.trigger,
      conditions: Array.isArray(parsed.conditions) ? parsed.conditions.slice(0, 20) : [],
      actions: parsed.actions.slice(0, 20),
      cooldownMs: Math.max(parsed.trigger.type === "SCHEDULE_TICK" ? 60000 : 0, Math.min(Number(parsed.cooldownMs) || 30000, 86400000)),
      lastTriggeredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.data.rules.push(rule);
    this.persist();
    this.events?.publish("AUTOMATION_CREATED", { ruleId: rule.id, name: rule.name });
    return structuredClone(rule);
  }

  update(id, patch) {
    const rule = this.data.rules.find((item) => item.id === id);
    if (!rule) throw new Error(`Unknown automation: ${id}`);
    if (patch.actions && containsSensitive(patch.actions)) throw new Error("Credentials cannot be stored in a persistent automation.");
    if (patch.actions) validateSafeActions(patch.actions);
    for (const key of ["name", "enabled", "trigger", "conditions", "actions", "cooldownMs"]) if (patch[key] !== undefined) rule[key] = patch[key];
    rule.updatedAt = this.now().toISOString();
    this.persist();
    return structuredClone(rule);
  }

  delete(id) {
    const length = this.data.rules.length;
    this.data.rules = this.data.rules.filter((item) => item.id !== id);
    if (this.data.rules.length === length) return false;
    this.persist();
    this.events?.publish("AUTOMATION_DELETED", { ruleId: id });
    return true;
  }

  triggerMatches(rule, event) {
    if (rule.trigger.type !== event.type) return false;
    if (!rule.trigger.path) return true;
    return matchesValue(getPath(event, rule.trigger.path), rule.trigger.value, rule.trigger.operator);
  }

  conditionsMatch(rule, event) {
    return rule.conditions.every((condition) => matchesValue(getPath(event, condition.path), condition.value, condition.operator));
  }

  async handle(event) {
    if (!event?.type || event.type.startsWith("AUTOMATION_")) return [];
    const results = [];
    for (const rule of this.data.rules.filter((item) => item.enabled && this.triggerMatches(item, event) && this.conditionsMatch(item, event))) {
      if (this.executing.has(rule.id)) continue;
      if (rule.lastTriggeredAt && this.now().getTime() - new Date(rule.lastTriggeredAt).getTime() < rule.cooldownMs) continue;
      results.push(await this.execute(rule, event));
    }
    return results;
  }

  async execute(rule, event) {
    if (typeof this.runner !== "function") throw new Error("Automation action runner is unavailable.");
    this.executing.add(rule.id);
    const run = { id: crypto.randomUUID(), ruleId: rule.id, eventType: event.type, status: "running", actions: [], startedAt: this.now().toISOString() };
    this.data.runs.push(run);
    this.data.runs = this.data.runs.slice(-500);
    rule.lastTriggeredAt = run.startedAt;
    this.persist();
    this.events?.publish("AUTOMATION_TRIGGERED", { ruleId: rule.id, runId: run.id, eventType: event.type });
    try {
      for (const action of rule.actions) {
        try {
          const result = await this.runner(action.tool, structuredClone(action.arguments || {}));
          const ok = !result?.isError && result?.action?.status !== "FAILED";
          run.actions.push({ tool: action.tool, ok, status: result?.action?.status || (ok ? "SUCCESS" : "FAILED") });
          if (!ok) throw new Error(result?.action?.verification?.evidence?.[0] || result?.text || "Automation action failed.");
        } catch (error) {
          run.actions.push({ tool: action.tool, ok: false, error: redact(error.message).slice(0, 500) });
          throw error;
        }
      }
      run.status = "completed";
      this.events?.publish("AUTOMATION_COMPLETED", { ruleId: rule.id, runId: run.id });
    } catch (error) {
      run.status = "failed";
      run.error = redact(error.message).slice(0, 1000);
      this.events?.publish("AUTOMATION_FAILED", { ruleId: rule.id, runId: run.id, error: run.error });
    } finally {
      run.completedAt = this.now().toISOString();
      this.executing.delete(rule.id);
      this.persist();
    }
    return structuredClone(run);
  }

  async tick() {
    const date = this.now();
    const scheduleEvent = { type: "SCHEDULE_TICK", ts: date.toISOString(), detail: { time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`, weekday: date.toLocaleDateString("en-US", { weekday: "long" }) } };
    const results = await this.handle(scheduleEvent);
    if (this.context) {
      const context = await this.context.snapshot();
      const battery = context.systemMetrics?.battery;
      if (battery) results.push(...await this.handle({ type: "BATTERY_STATE", ts: date.toISOString(), detail: { percent: Number(battery.EstimatedChargeRemaining), status: Number(battery.BatteryStatus) } }));
    }
    return results;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => this.events?.publish("AUTOMATION_ENGINE_ERROR", { error: error.message })), 30000);
    this.timer.unref?.();
  }

  close() { if (this.timer) clearInterval(this.timer); this.timer = null; if (this.listener) this.events?.off("event", this.listener); }
}
