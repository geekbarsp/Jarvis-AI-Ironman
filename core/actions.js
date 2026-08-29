import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./storage.js";

export const RiskLevel = Object.freeze({ SAFE: "safe", LOW: "low", MEDIUM: "medium", HIGH: "high", CRITICAL: "critical" });
export const ActionStatus = Object.freeze({ SUCCESS: "SUCCESS", PARTIAL_SUCCESS: "PARTIAL_SUCCESS", FAILED: "FAILED", UNKNOWN: "UNKNOWN" });

const RISK_ORDER = [RiskLevel.SAFE, RiskLevel.LOW, RiskLevel.MEDIUM, RiskLevel.HIGH, RiskLevel.CRITICAL];
const DELETE_OPERATIONS = /^(?:uninstall|emptyRecycleBin|batchRename|organize|gitPush|shutdown|restart|sleep|hibernate)$/i;
const WRITE_OPERATIONS = /^(?:write|save|create|add|log|open|restore|update|compress|extract|install|gitCommit|encrypt|decrypt)$/i;

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function safeValue(value, key = "", depth = 0) {
  const hidden = /password|secret|token|authorization|api.?key|text|message|content/i;
  if (hidden.test(key)) return "[PRIVATE]";
  if (depth > 4) return "[TRUNCATED]";
  if (typeof value === "string") return redact(value).slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeValue(item, key, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, safeValue(child, childKey, depth + 1)]));
  return value;
}

function safeArguments(args) {
  return safeValue(args || {});
}

function normalizeStatus(value, fallback = ActionStatus.SUCCESS) {
  return Object.values(ActionStatus).includes(value) ? value : fallback;
}

export class PermissionEngine {
  constructor(configStore = null) { this.configStore = configStore; }

  classify(tool, args = {}, descriptor = {}) {
    const operation = String(args.operation || args.action || "");
    const readOnly = /^(?:status|list|search|read|inspect|preview|gitStatus|gitDiff|pipList|details|battery|packages|system|disk|network|usb|apps|processes|pythonPackages|scanUrl|portScan)$/i.test(operation);
    let risk = Object.values(RiskLevel).includes(descriptor.riskLevel) ? descriptor.riskLevel : RiskLevel.LOW;
    if (readOnly) risk = RiskLevel.SAFE;
    if (/^(?:shutdown|restart)$/i.test(operation)) risk = RiskLevel.CRITICAL;
    else if (DELETE_OPERATIONS.test(operation) || (descriptor.requiresConfirmation && !readOnly)) risk = RiskLevel.HIGH;
    else if (WRITE_OPERATIONS.test(operation) && RISK_ORDER.indexOf(risk) < RISK_ORDER.indexOf(RiskLevel.MEDIUM)) risk = RiskLevel.MEDIUM;
    if (["webSearch", "fetchWebPage", "getWeather", "getLocation", "searchMemory", "fetchMeals", "workspaceList", "workspaceInspect", "deviceDiagnostics", "featureCatalogue", "utilities", "getSystemContext", "selfDiagnostics"].includes(tool)) risk = RiskLevel.SAFE;
    return risk;
  }

  assess(request, descriptor = {}) {
    const riskLevel = request.riskLevel || this.classify(request.tool, request.arguments, descriptor);
    const mode = this.configStore?.get().permissions?.mode || "standard";
    const confirmationRequired = [RiskLevel.HIGH, RiskLevel.CRITICAL].includes(riskLevel);
    if (riskLevel === RiskLevel.CRITICAL && mode !== "full") {
      return { allowed: false, riskLevel, confirmationRequired: true, reason: "Critical actions require Full Access." };
    }
    if (confirmationRequired && request.arguments?.confirm !== true) {
      return { allowed: false, riskLevel, confirmationRequired: true, reason: `${riskLevel.toUpperCase()} risk action requires explicit confirmation.` };
    }
    return { allowed: true, riskLevel, confirmationRequired, reason: "Allowed by the current permission policy." };
  }
}

export class ActionHistory {
  constructor(dataDir, limit = 250) {
    this.file = path.join(dataDir, "action-history.json");
    this.limit = limit;
    try { this.items = JSON.parse(fs.readFileSync(this.file, "utf8")).items || []; }
    catch { this.items = []; }
  }

  add(item) {
    this.items.push(item);
    this.items = this.items.slice(-this.limit);
    atomicJson(this.file, { version: 1, items: this.items });
    return structuredClone(item);
  }

  update(id, patch) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    atomicJson(this.file, { version: 1, items: this.items });
    return structuredClone(item);
  }

  undoable() { return [...this.items].reverse().find((item) => item.rollback && !item.undoneAt && item.status !== ActionStatus.FAILED) || null; }
  recent(limit = 30) { return structuredClone(this.items.slice(-Math.max(1, Math.min(Number(limit) || 30, this.limit))).reverse()); }
}

export class ActionEngine {
  constructor(dataDir, { permissionEngine = null, configStore = null, eventBus = null, history = null } = {}) {
    this.permissions = permissionEngine || new PermissionEngine(configStore);
    this.events = eventBus;
    this.history = history || new ActionHistory(dataDir);
    this.volatileRollbacks = new Map();
  }

  async execute(request, { descriptor = {}, handler, verify = null, createRollback = null } = {}) {
    if (!request?.tool || typeof handler !== "function") throw new TypeError("An action tool and handler are required.");
    const action = {
      id: request.id || crypto.randomUUID(),
      tool: String(request.tool),
      arguments: request.arguments && typeof request.arguments === "object" ? request.arguments : {},
      requestedAt: new Date().toISOString(),
    };
    const decision = this.permissions.assess(action, descriptor);
    this.events?.publish("ACTION_REQUESTED", { actionId: action.id, tool: action.tool, riskLevel: decision.riskLevel });
    if (!decision.allowed) {
      this.events?.publish("ACTION_DENIED", { actionId: action.id, tool: action.tool, riskLevel: decision.riskLevel, reason: decision.reason });
      const error = new Error(decision.reason);
      error.code = "ACTION_CONFIRMATION_REQUIRED";
      error.riskLevel = decision.riskLevel;
      throw error;
    }
    const startedAt = Date.now();
    this.events?.publish("ACTION_STARTED", { actionId: action.id, tool: action.tool, riskLevel: decision.riskLevel });
    try {
      const result = await handler();
      const verification = verify ? await verify(result) : { status: result?.isError ? ActionStatus.FAILED : ActionStatus.SUCCESS, evidence: result?.isError ? [String(result.text || "Tool reported an error.")] : ["The action handler completed without an error."] };
      const status = normalizeStatus(verification?.status, result?.isError ? ActionStatus.FAILED : ActionStatus.SUCCESS);
      const rollback = status !== ActionStatus.FAILED && createRollback ? await createRollback(result) : null;
      if (rollback?.volatileText !== undefined) this.volatileRollbacks.set(action.id, rollback);
      const persistedRollback = rollback?.volatileText !== undefined ? { type: rollback.type, volatile: true } : rollback;
      const record = this.history.add({
        id: action.id,
        tool: action.tool,
        arguments: safeArguments(action.arguments),
        riskLevel: decision.riskLevel,
        status,
        verification: { ...verification, status },
        rollback: persistedRollback || null,
        requestedAt: action.requestedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      });
      this.events?.publish("ACTION_COMPLETED", { actionId: action.id, tool: action.tool, riskLevel: decision.riskLevel, status, durationMs: record.durationMs });
      return { ...result, ...(status === ActionStatus.FAILED ? { isError: true } : {}), action: { id: record.id, riskLevel: record.riskLevel, status: record.status, verification: record.verification, undoable: Boolean(record.rollback) } };
    } catch (error) {
      const record = this.history.add({ id: action.id, tool: action.tool, arguments: safeArguments(action.arguments), riskLevel: decision.riskLevel, status: ActionStatus.FAILED, verification: { status: ActionStatus.FAILED, evidence: [redact(error?.message || String(error)).slice(0, 1000)] }, rollback: null, requestedAt: action.requestedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt });
      this.events?.publish("ACTION_FAILED", { actionId: action.id, tool: action.tool, riskLevel: decision.riskLevel, error: error?.message || String(error), durationMs: record.durationMs });
      throw error;
    }
  }

  async undoLast(resolver) {
    const original = this.history.undoable();
    if (!original) return { text: "There is no reversible JARVIS action to undo.", action: { status: ActionStatus.UNKNOWN, undoable: false } };
    if (typeof resolver !== "function") throw new TypeError("An undo resolver is required.");
    this.events?.publish("ACTION_UNDO_STARTED", { actionId: original.id, tool: original.tool });
    try {
      const rollback = this.volatileRollbacks.get(original.id) || original.rollback;
      if (rollback?.volatile && !this.volatileRollbacks.has(original.id)) throw new Error("That private rollback data expired when JARVIS restarted.");
      const result = await resolver(structuredClone(rollback), structuredClone(original));
      this.history.update(original.id, { undoneAt: new Date().toISOString() });
      this.volatileRollbacks.delete(original.id);
      this.events?.publish("ACTION_UNDONE", { actionId: original.id, tool: original.tool });
      return { ...(result || {}), text: result?.text || `Undid ${original.tool}.`, action: { id: original.id, status: ActionStatus.SUCCESS, undoable: false } };
    } catch (error) {
      this.events?.publish("ACTION_UNDO_FAILED", { actionId: original.id, tool: original.tool, error: error?.message || String(error) });
      throw error;
    }
  }

  snapshot(limit = 30) { return { recent: this.history.recent(limit), undoable: safeClone(this.history.undoable()) }; }
}

function safeClone(value) { return value == null ? value : structuredClone(value); }
