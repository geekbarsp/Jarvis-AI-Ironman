import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function sanitizeBrowserUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|auth|password|passwd|secret|session|api.?key|access.?key|code/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return ""; }
}

function sanitizeSnapshot(snapshot, browser) {
  return {
    browser: browser === "edge" ? "edge" : "chrome",
    capturedAt: new Date().toISOString(),
    windows: (Array.isArray(snapshot?.windows) ? snapshot.windows : []).filter((item) => !item.incognito).slice(0, 30).map((item) => ({
      browser: browser === "edge" ? "edge" : "chrome",
      state: ["normal", "minimized", "maximized", "fullscreen"].includes(item.state) ? item.state : "normal",
      focused: Boolean(item.focused),
      left: Number(item.left) || 0,
      top: Number(item.top) || 0,
      width: Math.max(200, Number(item.width) || 1000),
      height: Math.max(150, Number(item.height) || 700),
      tabs: (Array.isArray(item.tabs) ? item.tabs : []).slice(0, 200).map((tab, index) => ({
        url: sanitizeBrowserUrl(tab.url),
        title: String(tab.title || "").slice(0, 500),
        index: Number.isInteger(tab.index) ? tab.index : index,
        active: Boolean(tab.active),
        pinned: Boolean(tab.pinned),
      })).filter((tab) => tab.url),
    })).filter((item) => item.tabs.length),
  };
}

export class BrowserWorkspaceBridge {
  constructor(dataDir, { timeout = 3500 } = {}) {
    this.file = path.join(dataDir, "browser-bridge.json");
    this.timeout = timeout;
    this.clients = new Map();
    this.requests = [];
    this.pending = new Map();
    this.waiters = new Map();
    this.key = this.loadKey();
    this.latestSnapshot = { capturedAt: null, companionClients: [], windows: [] };
  }

  loadKey() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (/^[a-f0-9]{64}$/i.test(value.key)) return value.key;
    } catch {}
    const key = crypto.randomBytes(32).toString("hex");
    atomicJson(this.file, { key, createdAt: new Date().toISOString() });
    return key;
  }

  pair(origin) {
    if (!/^(?:chrome|edge)-extension:\/\//i.test(String(origin || ""))) throw new Error("Browser companion pairing is only available to an installed extension.");
    return { key: this.key };
  }

  authorized(value) { return typeof value === "string" && value.length === this.key.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(this.key)); }

  deliver(clientId, browser) {
    const request = this.requests.find((item) => item.expiresAt > Date.now() && !item.delivered.has(clientId) && (!item.browsers?.length || item.browsers.includes(browser)));
    if (!request) return null;
    request.delivered.add(clientId);
    return { id: request.id, type: request.type, payload: request.payload };
  }

  poll({ clientId, browser }) {
    const id = String(clientId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128);
    if (!id) throw new Error("A browser companion client ID is required.");
    const kind = browser === "edge" ? "edge" : "chrome";
    this.clients.set(id, { browser: kind, lastSeen: Date.now() });
    const immediate = this.deliver(id, kind);
    if (immediate) return Promise.resolve({ request: immediate });
    const previous = this.waiters.get(id);
    if (previous) { clearTimeout(previous.timer); previous.resolve({ request: null }); }
    return new Promise((resolve) => {
      const waiter = { resolve, browser: kind, timer: setTimeout(() => { this.waiters.delete(id); resolve({ request: null }); }, 20000) };
      this.waiters.set(id, waiter);
    });
  }

  respond({ clientId, browser, requestId, result, error }) {
    const pending = this.pending.get(String(requestId || ""));
    if (!pending) return { accepted: false };
    const id = String(clientId || "");
    pending.responses.set(id, { browser: browser === "edge" ? "edge" : "chrome", result, error: String(error || "") });
    if ([...pending.expected].every((client) => pending.responses.has(client))) pending.finish();
    return { accepted: true };
  }

  async request(type, payload = {}, browsers = []) {
    const activeClients = [...this.clients.entries()].filter(([, item]) => Date.now() - item.lastSeen < 30000 && (!browsers.length || browsers.includes(item.browser)));
    if (!activeClients.length) throw new Error("Chrome/Edge workspace companion is not connected. Load the JARVIS browser extension first.");
    const id = crypto.randomUUID();
    const request = { id, type, payload, browsers, delivered: new Set(), expiresAt: Date.now() + this.timeout };
    this.requests.push(request);
    for (const [clientId, waiter] of this.waiters) {
      const delivered = this.deliver(clientId, waiter.browser);
      if (!delivered) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(clientId);
      waiter.resolve({ request: delivered });
    }
    return new Promise((resolve) => {
      const pending = {
        expected: new Set(activeClients.map(([clientId]) => clientId)),
        responses: new Map(),
        finish: () => {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          this.requests = this.requests.filter((item) => item.id !== id);
          resolve([...pending.responses.values()]);
        },
      };
      pending.timer = setTimeout(pending.finish, this.timeout);
      this.pending.set(id, pending);
    });
  }

  async capture() {
    const responses = await this.request("capture");
    const snapshots = responses.filter((item) => !item.error).map((item) => sanitizeSnapshot(item.result, item.browser));
    this.latestSnapshot = { capturedAt: new Date().toISOString(), companionClients: snapshots.map((item) => item.browser), windows: snapshots.flatMap((item) => item.windows) };
    return structuredClone(this.latestSnapshot);
  }

  current() { return structuredClone(this.latestSnapshot); }

  async restore(snapshot, { exclusions = [] } = {}) {
    const excluded = exclusions.map((item) => String(item).toLowerCase());
    const windows = (snapshot.windows || []).filter((window) => !excluded.some((item) => `${window.browser} ${window.tabs.map((tab) => tab.title).join(" ")}`.toLowerCase().includes(item)));
    if (!windows.length) return { restoredWindows: 0, restoredTabs: 0 };
    const browsers = [...new Set(windows.map((item) => item.browser))];
    const responses = await this.request("restore", { windows }, browsers);
    const failures = responses.filter((item) => item.error).map((item) => ({ browser: item.browser, error: item.error }));
    const restored = responses.filter((item) => !item.error).map((item) => item.result || {});
    return {
      restoredWindows: restored.reduce((sum, item) => sum + (Number(item.restoredWindows) || 0), 0),
      restoredTabs: restored.reduce((sum, item) => sum + (Number(item.restoredTabs) || 0), 0),
      failures,
    };
  }
}
