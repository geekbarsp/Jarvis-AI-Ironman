import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function powershell(script, { wait = true } = {}) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    windowsHide: true,
    stdio: wait ? ["ignore", "pipe", "pipe"] : "ignore",
    detached: !wait,
  });
  if (!wait) {
    child.unref();
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `Windows helper failed (${code}).`)));
  });
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function safeName(value, label = "name") {
  const result = String(value || "").trim();
  if (!result || result.length > 100 || /[\r\n\0]/.test(result)) throw new Error(`A valid ${label} is required.`);
  return result;
}

function walk(root, visitor, { maxDepth = 8, maxEntries = 20000 } = {}) {
  let count = 0;
  const visit = (directory, depth) => {
    if (depth > maxDepth || count >= maxEntries) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= maxEntries) break;
      count += 1;
      const item = path.join(directory, entry.name);
      visitor(item, entry);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(item, depth + 1);
    }
  };
  visit(root, 0);
  return count;
}

function tokenize(expression) {
  const tokens = String(expression).match(/\d*\.?\d+(?:e[+-]?\d+)?|[()+\-*/%^]/gi) || [];
  if (tokens.join("").toLowerCase() !== String(expression).replace(/\s+/g, "").toLowerCase()) throw new Error("The calculation contains unsupported characters.");
  return tokens;
}

function calculate(expression) {
  const values = [];
  const ops = [];
  const priority = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3, "u-": 4 };
  const apply = () => {
    const op = ops.pop();
    if (op === "u-") {
      const value = values.pop();
      if (!Number.isFinite(value)) throw new Error("Invalid calculation.");
      values.push(-value);
      return;
    }
    const b = values.pop();
    const a = values.pop();
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Invalid calculation.");
    values.push(op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : op === "/" ? a / b : op === "%" ? a % b : a ** b);
  };
  let previous = "operator";
  for (const token of tokenize(expression)) {
    if (!Number.isNaN(Number(token))) { values.push(Number(token)); previous = "number"; continue; }
    if (token === "(" || (token === "-" && previous === "operator")) {
      ops.push(token === "-" ? "u-" : token);
      previous = "operator";
      continue;
    }
    if (token === ")") {
      while (ops.length && ops.at(-1) !== "(") apply();
      if (ops.pop() !== "(") throw new Error("Mismatched parentheses.");
      previous = "number";
      continue;
    }
    while (ops.length && ops.at(-1) !== "(" && (priority[ops.at(-1)] > priority[token] || (priority[ops.at(-1)] === priority[token] && token !== "^"))) apply();
    ops.push(token);
    previous = "operator";
  }
  while (ops.length) {
    if (ops.at(-1) === "(") throw new Error("Mismatched parentheses.");
    apply();
  }
  if (values.length !== 1 || !Number.isFinite(values[0])) throw new Error("Invalid calculation.");
  return values[0];
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, "r");
  try {
    let bytes = 0;
    do { bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null); if (bytes) hash.update(buffer.subarray(0, bytes)); } while (bytes);
    return hash.digest("hex");
  } finally { fs.closeSync(descriptor); }
}

const APP_ALIASES = {
  calculator: "calc.exe", notepad: "notepad.exe", paint: "mspaint.exe", explorer: "explorer.exe",
  settings: "ms-settings:", terminal: "wt.exe", chrome: "chrome.exe", edge: "msedge.exe", firefox: "firefox.exe",
  vscode: "code.exe", "visual studio code": "code.exe", spotify: "spotify.exe", discord: "discord.exe",
};

const UNIT_FACTORS = {
  mm: ["length", 0.001], cm: ["length", 0.01], m: ["length", 1], km: ["length", 1000], in: ["length", 0.0254], ft: ["length", 0.3048], yd: ["length", 0.9144], mi: ["length", 1609.344],
  mg: ["mass", 0.000001], g: ["mass", 0.001], kg: ["mass", 1], oz: ["mass", 0.028349523125], lb: ["mass", 0.45359237],
  ml: ["volume", 0.001], l: ["volume", 1], cup: ["volume", 0.2365882365], gal: ["volume", 3.785411784],
  s: ["time", 1], min: ["time", 60], h: ["time", 3600], day: ["time", 86400],
};

export class PersonalAssistant {
  constructor(dataDir, allowedPath) {
    this.dataDir = dataDir;
    this.allowedPath = allowedPath;
    this.file = path.join(dataDir, "personal-data.json");
    this.timers = new Map();
    this.data = this.load();
    this.restoreReminders();
  }

  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { reminders: value.reminders || [], notes: value.notes || [], contacts: value.contacts || [] };
    } catch { return { reminders: [], notes: [], contacts: [] }; }
  }

  save() { atomicJson(this.file, this.data); }

  notify(title, message) {
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle=${psQuote(title)}; $n.BalloonTipText=${psQuote(message)}; $n.Visible=$true; $n.ShowBalloonTip(5000); Start-Sleep -Seconds 6; $n.Dispose()`;
    return powershell(script, { wait: false });
  }

  schedule(item) {
    const delay = new Date(item.at).getTime() - Date.now();
    if (delay <= 0 || delay > 2_147_000_000) return;
    this.timers.set(item.id, setTimeout(() => {
      this.notify("JARVIS Reminder", item.text);
      item.done = true;
      this.timers.delete(item.id);
      this.save();
    }, delay));
  }

  restoreReminders() {
    for (const item of this.data.reminders.filter((entry) => !entry.done)) this.schedule(item);
  }

  async apps(args) {
    const operation = args.operation || "open";
    const target = safeName(args.target, "app, website, or path");
    if (operation === "open") {
      if (/^https?:\/\//i.test(target)) await powershell(`Start-Process ${psQuote(target)}`);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) await powershell(`Start-Process ${psQuote(target)}`);
      else if (fs.existsSync(target)) await powershell(`Start-Process ${psQuote(target)}`);
      else {
        const app = APP_ALIASES[target.toLowerCase()] || target;
        await powershell(`$ErrorActionPreference='Stop'; try { Start-Process ${psQuote(app)} } catch { $match=Get-StartApps | Where-Object { $_.Name -like ${psQuote(`*${target}*`)} } | Select-Object -First 1; if(-not $match){throw}; Start-Process ('shell:AppsFolder\\'+$match.AppID) }`);
      }
      return `Opened ${target}.`;
    }
    if (operation === "close") {
      if (args.confirm !== true) throw new Error("Closing an app requires confirm=true after the user explicitly asks.");
      const processName = path.basename(APP_ALIASES[target.toLowerCase()] || target).replace(/\.exe$/i, "");
      if (!/^[\w.-]+$/.test(processName)) throw new Error("That process name cannot be closed safely.");
      await powershell(`$p=Get-Process -Name ${psQuote(processName)} -ErrorAction SilentlyContinue; if($p){$p | Stop-Process -Force}else{Write-Output 'not-running'}`);
      return `Closed ${target}.`;
    }
    throw new Error("Unknown app operation.");
  }

  async system(args) {
    const action = String(args.action || "status").toLowerCase();
    if (action === "status") {
      const disks = fs.readdirSync("C:\\", { withFileTypes: true }).length;
      return JSON.stringify({ platform: os.version(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryTotalGb: +(os.totalmem() / 2 ** 30).toFixed(1), memoryFreeGb: +(os.freemem() / 2 ** 30).toFixed(1), uptimeHours: +(os.uptime() / 3600).toFixed(1), homeEntries: disks }, null, 2);
    }
    const keyCodes = { mute: 0xAD, volumeDown: 0xAE, volumeUp: 0xAF, next: 0xB0, previous: 0xB1, playPause: 0xB3 };
    const canonical = Object.keys(keyCodes).find((key) => key.toLowerCase() === action.replace(/[\s_-]/g, "").toLowerCase());
    if (canonical) {
      await powershell(`Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte a, byte b, uint c, uint d); }'; [K]::keybd_event(${keyCodes[canonical]},0,0,0); [K]::keybd_event(${keyCodes[canonical]},0,2,0)`);
      return `System action completed: ${canonical}.`;
    }
    if (action.replace(/[\s_-]/g, "") === "volumeset") {
      const value = Math.max(0, Math.min(100, Number(args.value)));
      if (!Number.isFinite(value)) throw new Error("Volume must be between 0 and 100.");
      await powershell(`Add-Type -TypeDefinition @'\nusing System; using System.Runtime.InteropServices;\n[Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioEndpointVolume { int a(); int b(); int c(); int d(); int SetMasterVolumeLevel(float l, Guid g); int SetMasterVolumeLevelScalar(float l, Guid g); }\n[Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume aev); }\n[Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }\n[ComImport, Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] class MMDeviceEnumerator {}\npublic class Audio { public static void Set(float value){ var e=(IMMDeviceEnumerator)new MMDeviceEnumerator(); IMMDevice d; e.GetDefaultAudioEndpoint(0,1,out d); IAudioEndpointVolume v; var id=typeof(IAudioEndpointVolume).GUID; d.Activate(ref id,23,IntPtr.Zero,out v); v.SetMasterVolumeLevelScalar(value,Guid.Empty); } }\n'@; [Audio]::Set(${value / 100})`);
      return `Volume set to ${Math.round(value)}%.`;
    }
    if (action === "lock") {
      await powershell("rundll32.exe user32.dll,LockWorkStation");
      return "Computer locked.";
    }
    const shortcuts = { showDesktop: "^{ESC}", minimizeAll: "#m", altTab: "%{TAB}", copy: "^c", paste: "^v", save: "^s", undo: "^z", selectAll: "^a" };
    const shortcut = Object.keys(shortcuts).find((key) => key.toLowerCase() === action.replace(/[\s_-]/g, "").toLowerCase());
    if (shortcut) {
      await powershell(`$w=New-Object -ComObject WScript.Shell; $w.SendKeys(${psQuote(shortcuts[shortcut])})`);
      return `Keyboard action completed: ${shortcut}.`;
    }
    if (["brightnessup", "brightnessdown"].includes(action.replace(/[\s_-]/g, ""))) {
      const change = action.replace(/[\s_-]/g, "") === "brightnessup" ? 10 : -10;
      await powershell(`$m=Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop; $b=Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness; $v=[math]::Max(0,[math]::Min(100,$b.CurrentBrightness+(${change}))); $m.WmiSetBrightness(1,$v) | Out-Null; Write-Output $v`);
      return `Brightness adjusted ${change > 0 ? "up" : "down"}.`;
    }
    if (["shutdown", "restart", "sleep", "hibernate"].includes(action)) {
      if (args.confirm !== true) throw new Error(`${action} requires confirm=true after explicit user confirmation.`);
      const command = action === "shutdown" ? "Stop-Computer" : action === "restart" ? "Restart-Computer" : action === "hibernate" ? "shutdown.exe /h" : "rundll32.exe powrprof.dll,SetSuspendState 0,1,0";
      await powershell(command, { wait: false });
      return `${action} requested.`;
    }
    throw new Error("Unsupported system action.");
  }

  async clipboard(args) {
    if ((args.operation || "read") === "read") return powershell("Get-Clipboard -Raw");
    const text = String(args.text || "").slice(0, 100000);
    await powershell(`Set-Clipboard -Value ${psQuote(text)}`);
    return "Clipboard updated.";
  }

  reminders(args) {
    const operation = args.operation || "list";
    if (operation === "list") return JSON.stringify(this.data.reminders.filter((item) => !item.done), null, 2);
    if (operation === "create") {
      const at = new Date(args.at);
      if (!Number.isFinite(at.getTime()) || at <= new Date()) throw new Error("The reminder time must be a valid future date/time.");
      const item = { id: crypto.randomUUID(), text: safeName(args.text, "reminder text"), at: at.toISOString(), done: false };
      this.data.reminders.push(item); this.save(); this.schedule(item);
      return JSON.stringify(item, null, 2);
    }
    if (operation === "cancel") {
      const item = this.data.reminders.find((entry) => entry.id === args.id && !entry.done);
      if (!item) return JSON.stringify({ cancelled: false, count: 0, reminders: [] });
      item.done = true; clearTimeout(this.timers.get(item.id)); this.timers.delete(item.id); this.save();
      return JSON.stringify({ cancelled: true, count: 1, reminders: [item] });
    }
    if (operation === "cancelMany" || operation === "cancelAll") {
      const ids = new Set((Array.isArray(args.ids) ? args.ids : []).map(String));
      const matching = this.data.reminders.filter((item) => !item.done && (operation === "cancelAll" || ids.has(item.id)));
      for (const item of matching) {
        item.done = true;
        clearTimeout(this.timers.get(item.id));
        this.timers.delete(item.id);
      }
      if (matching.length) this.save();
      return JSON.stringify({ cancelled: matching.length > 0, count: matching.length, reminders: matching });
    }
    if (operation === "update") {
      const item = this.data.reminders.find((entry) => entry.id === args.id && !entry.done);
      if (!item) return "No active reminder matched that ID.";
      const at = args.at ? new Date(args.at) : new Date(item.at);
      if (!Number.isFinite(at.getTime()) || at <= new Date()) throw new Error("The reminder time must be a valid future date/time.");
      clearTimeout(this.timers.get(item.id));
      this.timers.delete(item.id);
      item.text = args.text ? safeName(args.text, "reminder text") : item.text;
      item.at = at.toISOString();
      this.save();
      this.schedule(item);
      return JSON.stringify(item, null, 2);
    }
    if (operation === "reconcileSchedule") {
      const topic = safeName(args.topic, "schedule topic").toLowerCase();
      const startAt = new Date(args.startAt);
      const endAt = new Date(args.endAt);
      if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) throw new Error("The schedule must have valid start and end times.");
      if (endAt <= new Date()) throw new Error("The schedule end time must be in the future.");
      const matching = this.data.reminders.filter((item) => !item.done && String(item.text || "").toLowerCase().includes(topic));
      const sameTime = (left, right) => new Date(left).getTime() === right.getTime();
      const expectedStartText = safeName(args.startText || `Start ${topic}`, "reminder text");
      const expectedEndText = safeName(args.endText || `End ${topic}`, "reminder text");
      const sameText = (left, right) => String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
      const existingStart = matching.find((item) => sameText(item.text, expectedStartText) && sameTime(item.at, startAt));
      const existingEnd = matching.find((item) => sameText(item.text, expectedEndText) && sameTime(item.at, endAt));
      const retained = new Set([existingStart?.id, existingEnd?.id].filter(Boolean));
      const superseded = matching.filter((item) => !retained.has(item.id));
      for (const item of superseded) {
        item.done = true;
        clearTimeout(this.timers.get(item.id));
        this.timers.delete(item.id);
      }
      const created = [];
      if (!existingStart) created.push({ id: crypto.randomUUID(), text: expectedStartText, at: startAt.toISOString(), done: startAt <= new Date() });
      if (!existingEnd) created.push({ id: crypto.randomUUID(), text: expectedEndText, at: endAt.toISOString(), done: false });
      this.data.reminders.push(...created);
      if (superseded.length || created.length) this.save();
      for (const item of created.filter((entry) => !entry.done)) this.schedule(item);
      return JSON.stringify({ topic, replaced: superseded.length, created: created.length, changed: Boolean(superseded.length || created.length), reminders: [existingStart, existingEnd, ...created].filter(Boolean) }, null, 2);
    }
    throw new Error("Unknown reminder operation.");
  }

  activeReminders() { return structuredClone(this.data.reminders.filter((item) => !item.done)); }

  collection(kind, args) {
    const values = this.data[kind];
    const operation = args.operation || "list";
    if (operation === "list") return JSON.stringify(values, null, 2);
    if (operation === "search") {
      const query = String(args.query || "").toLowerCase();
      return JSON.stringify(values.filter((item) => JSON.stringify(item).toLowerCase().includes(query)), null, 2);
    }
    if (operation === "save") {
      const item = kind === "notes"
        ? { id: crypto.randomUUID(), title: safeName(args.title || "Note", "title"), text: String(args.text || "").slice(0, 20000), createdAt: new Date().toISOString() }
        : { id: crypto.randomUUID(), name: safeName(args.name, "contact name"), phone: String(args.phone || "").replace(/[^+\d]/g, ""), email: String(args.email || "").trim(), createdAt: new Date().toISOString() };
      values.push(item); this.save(); return JSON.stringify(item, null, 2);
    }
    if (operation === "delete") {
      if (args.confirm !== true) throw new Error("Deletion requires confirm=true after an explicit user request.");
      const index = values.findIndex((item) => item.id === args.id);
      if (index < 0) return "No item matched that ID.";
      values.splice(index, 1); this.save(); return "Deleted.";
    }
    throw new Error(`Unknown ${kind} operation.`);
  }

  async contactAction(args) {
    const contact = this.data.contacts.find((item) => item.id === args.id || item.name.toLowerCase() === String(args.name || "").toLowerCase());
    if (!contact) throw new Error("Contact not found.");
    const action = args.action || "whatsapp";
    if (action === "email") await this.apps({ operation: "open", target: `mailto:${contact.email}` });
    else if (action === "call") await this.apps({ operation: "open", target: `tel:${contact.phone}` });
    else await this.apps({ operation: "open", target: `https://wa.me/${contact.phone.replace(/\D/g, "")}?text=${encodeURIComponent(args.message || "")}` });
    return `Opened ${action} for ${contact.name}.`;
  }

  files(args, roots) {
    const root = this.allowedPath(args.path || roots[0], roots);
    const operation = args.operation || "recent";
    if (operation === "size") {
      let bytes = 0; let files = 0;
      walk(root, (item, entry) => { if (entry.isFile()) { try { bytes += fs.statSync(item).size; files += 1; } catch {} } });
      return JSON.stringify({ path: root, files, bytes, gigabytes: +(bytes / 2 ** 30).toFixed(3) });
    }
    if (operation === "recent" || operation === "large") {
      const found = [];
      walk(root, (item, entry) => { if (entry.isFile()) { try { const stat = fs.statSync(item); found.push({ path: item, bytes: stat.size, modified: stat.mtime.toISOString() }); } catch {} } });
      found.sort(operation === "large" ? (a, b) => b.bytes - a.bytes : (a, b) => b.modified.localeCompare(a.modified));
      return JSON.stringify(found.slice(0, Math.min(Number(args.limit) || 30, 100)), null, 2);
    }
    if (operation === "duplicates") {
      const sizes = new Map();
      walk(root, (item, entry) => { if (entry.isFile()) { try { const size = fs.statSync(item).size; if (size > 0) sizes.set(size, [...(sizes.get(size) || []), item]); } catch {} } });
      const groups = [];
      for (const candidates of [...sizes.values()].filter((items) => items.length > 1)) {
        const hashes = new Map();
        for (const item of candidates) { const hash = hashFile(item); hashes.set(hash, [...(hashes.get(hash) || []), item]); }
        groups.push(...[...hashes.values()].filter((items) => items.length > 1));
      }
      return JSON.stringify(groups.slice(0, 100), null, 2);
    }
    if (operation === "compress") {
      if (args.confirm !== true) throw new Error("Creating an archive requires confirm=true after an explicit user request.");
      const output = this.allowedPath(args.output, roots);
      if (!output.toLowerCase().endsWith(".zip")) throw new Error("Archive output must end in .zip.");
      return powershell(`Compress-Archive -LiteralPath ${psQuote(root)} -DestinationPath ${psQuote(output)} -Force`).then(() => `Created ${output}.`);
    }
    if (operation === "extract") {
      if (args.confirm !== true) throw new Error("Extracting an archive requires confirm=true after an explicit user request.");
      const output = this.allowedPath(args.output, roots);
      return powershell(`Expand-Archive -LiteralPath ${psQuote(root)} -DestinationPath ${psQuote(output)} -Force`).then(() => `Extracted to ${output}.`);
    }
    throw new Error("Unknown file utility operation.");
  }

  utilities(args) {
    const operation = args.operation || "calculate";
    if (operation === "calculate") return String(calculate(args.expression));
    if (operation === "password") {
      const length = Math.max(12, Math.min(Number(args.length) || 20, 128));
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
      return Array.from(crypto.randomBytes(length), (value) => alphabet[value % alphabet.length]).join("");
    }
    if (operation === "dice") return String(crypto.randomInt(1, Math.max(2, Math.min(Number(args.sides) || 6, 1000)) + 1));
    if (operation === "coin") return crypto.randomInt(0, 2) ? "heads" : "tails";
    if (operation === "age") {
      const birth = new Date(args.birthDate); if (!Number.isFinite(birth.getTime()) || birth > new Date()) throw new Error("A valid past birthDate is required.");
      const today = new Date(); let years = today.getFullYear() - birth.getFullYear(); const beforeBirthday = today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate()); if (beforeBirthday) years -= 1;
      return JSON.stringify({ years, birthDate: birth.toISOString().slice(0, 10) });
    }
    if (operation === "convert") {
      const from = String(args.from || "").toLowerCase(); const to = String(args.to || "").toLowerCase(); const value = Number(args.value);
      if (from === "c" && to === "f") return String((value * 9) / 5 + 32);
      if (from === "f" && to === "c") return String(((value - 32) * 5) / 9);
      if (!UNIT_FACTORS[from] || !UNIT_FACTORS[to] || UNIT_FACTORS[from][0] !== UNIT_FACTORS[to][0]) throw new Error("Those units are not compatible.");
      return String((value * UNIT_FACTORS[from][1]) / UNIT_FACTORS[to][1]);
    }
    throw new Error("Unknown utility operation.");
  }
}
