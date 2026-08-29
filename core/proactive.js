import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

const DEFAULT_SETTINGS = Object.freeze({ enabled: true, quiet: false, intervalMs: 60000, maxVisible: 50 });

export class NotificationService {
  constructor(dataDir, { eventBus = null, clock = () => Date.now() } = {}) {
    this.file = path.join(dataDir, "notifications.json");
    this.events = eventBus;
    this.clock = clock;
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch { this.data = { version: 1, settings: { ...DEFAULT_SETTINGS }, items: [] }; }
    this.data.settings = { ...DEFAULT_SETTINGS, ...(this.data.settings || {}) };
  }

  persist() { atomicJson(this.file, this.data); }

  notify({ message, title = "JARVIS", category = "general", priority = "normal", dedupeKey = "", cooldownMs = 15 * 60 * 1000, expiresAt = null, detail = {} }) {
    if (!this.data.settings.enabled || this.data.settings.quiet) return { suppressed: true, reason: this.data.settings.quiet ? "quiet_mode" : "disabled" };
    const now = this.clock();
    const key = String(dedupeKey || `${category}:${message}`).slice(0, 300);
    const duplicate = this.data.items.find((item) => item.dedupeKey === key && now - Date.parse(item.createdAt) < Math.max(0, Number(cooldownMs) || 0));
    if (duplicate) return { suppressed: true, reason: "cooldown", existingId: duplicate.id };
    const item = {
      id: crypto.randomUUID(), title: String(title).slice(0, 120), message: String(message).slice(0, 1000),
      category: String(category).slice(0, 80), priority: ["low", "normal", "high", "critical"].includes(priority) ? priority : "normal",
      dedupeKey: key, detail, createdAt: new Date(now).toISOString(), expiresAt, dismissedAt: null, snoozedUntil: null,
    };
    this.data.items.push(item);
    this.data.items = this.data.items.slice(-500);
    this.persist();
    this.events?.publish("NOTIFICATION_CREATED", { id: item.id, category: item.category, priority: item.priority, message: item.message });
    return structuredClone(item);
  }

  list({ includeDismissed = false, limit = 50 } = {}) {
    const now = this.clock();
    return this.data.items.filter((item) => (includeDismissed || !item.dismissedAt) && (!item.expiresAt || Date.parse(item.expiresAt) > now) && (!item.snoozedUntil || Date.parse(item.snoozedUntil) <= now))
      .slice(-Math.max(1, Math.min(Number(limit) || 50, 200))).reverse().map((item) => structuredClone(item));
  }

  dismiss(id) {
    const item = this.data.items.find((entry) => entry.id === id);
    if (!item) throw new Error("Notification not found.");
    item.dismissedAt = new Date(this.clock()).toISOString();
    this.persist();
    return structuredClone(item);
  }

  snooze(id, minutes = 30) {
    const item = this.data.items.find((entry) => entry.id === id);
    if (!item) throw new Error("Notification not found.");
    item.snoozedUntil = new Date(this.clock() + Math.max(1, Math.min(Number(minutes) || 30, 10080)) * 60000).toISOString();
    this.persist();
    return structuredClone(item);
  }

  settings(update = null) {
    if (update) {
      this.data.settings = { ...this.data.settings, ...update };
      this.persist();
    }
    return structuredClone(this.data.settings);
  }
}

export class ProactiveEngine {
  constructor(dataDir, { eventBus = null, contextEngine = null, clock = () => Date.now() } = {}) {
    this.events = eventBus;
    this.context = contextEngine;
    this.notifications = new NotificationService(dataDir, { eventBus, clock });
    this.listener = (event) => this.handleEvent(event);
    this.timer = null;
  }

  handleEvent(event) {
    if (!event || String(event.type).startsWith("NOTIFICATION_")) return null;
    const failures = new Set(["ACTION_FAILED", "AUTOMATION_FAILED", "TASK_GRAPH_FAILED"]);
    if (!failures.has(event.type)) return null;
    return this.notifications.notify({
      title: "JARVIS needs attention", message: event.detail?.error || event.detail?.message || `${event.type.replaceAll("_", " ").toLowerCase()}.`,
      category: "failure", priority: "high", dedupeKey: `${event.type}:${event.detail?.graphId || event.detail?.automationId || event.detail?.tool || "general"}`, cooldownMs: 10 * 60 * 1000,
      detail: event.detail || {},
    });
  }

  evaluateContext(context) {
    if (!context) return [];
    const results = [];
    const memory = Number(context.metrics?.memoryPercent ?? context.systemMetrics?.memoryPercent ?? context.systemMetrics?.ram?.usedPercent);
    if (memory >= 90) results.push(this.notifications.notify({ message: `Memory usage is ${Math.round(memory)}%. Closing unused apps may improve reliability.`, category: "system", priority: "high", dedupeKey: "system:memory-pressure", cooldownMs: 30 * 60 * 1000 }));
    const battery = Number(context.metrics?.batteryPercent ?? context.systemMetrics?.batteryPercent ?? context.systemMetrics?.battery?.EstimatedChargeRemaining);
    const batteryStatus = Number(context.systemMetrics?.battery?.BatteryStatus);
    const charging = context.metrics?.charging ?? context.systemMetrics?.charging ?? ([2, 6, 7, 8, 9, 11].includes(batteryStatus) ? true : batteryStatus ? false : undefined);
    if (Number.isFinite(battery) && battery <= 15 && charging === false) results.push(this.notifications.notify({ message: `Battery is at ${Math.round(battery)}%. Connect the charger soon.`, category: "battery", priority: "high", dedupeKey: "system:low-battery", cooldownMs: 30 * 60 * 1000 }));
    const diskFree = Number(context.metrics?.diskFreePercent ?? context.systemMetrics?.diskFreePercent ?? (context.systemMetrics?.disks || []).reduce((lowest, disk) => {
      const percent = Number(disk.Size) > 0 ? Number(disk.FreeSpace) / Number(disk.Size) * 100 : Number.NaN;
      return Number.isFinite(percent) ? Math.min(lowest, percent) : lowest;
    }, 100));
    if (Number.isFinite(diskFree) && diskFree <= 10) results.push(this.notifications.notify({ message: `Only ${Math.round(diskFree)}% disk space is free.`, category: "storage", priority: "high", dedupeKey: "system:disk-pressure", cooldownMs: 6 * 60 * 60 * 1000 }));
    return results;
  }

  async tick() { return this.evaluateContext(await this.context?.snapshot()); }
  start() {
    if (this.timer) return;
    this.events?.on("event", this.listener);
    const interval = Math.max(15000, Number(this.notifications.settings().intervalMs) || 60000);
    this.timer = setInterval(() => this.tick().catch(() => {}), interval);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.events?.off("event", this.listener); }
}
