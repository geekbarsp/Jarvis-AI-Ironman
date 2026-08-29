import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function unique(values, limit = 200) {
  return [...new Set((values || []).filter(Boolean).map(String))].slice(0, limit);
}

function safeClone(value) {
  return value == null ? value : structuredClone(value);
}

function powershellJson(script, timeout = 5000) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  }).then(({ stdout }) => JSON.parse(stdout.trim() || "{}"));
}

function projectFromContext(activeApplication, activeWindow, windows) {
  const active = String(activeApplication || "").toLowerCase();
  const title = String(activeWindow || "");
  if (active === "code" || active === "code - insiders") {
    const parts = title.split(/\s+-\s+/).map((item) => item.trim()).filter(Boolean);
    const marker = parts.findIndex((item) => /visual studio code/i.test(item));
    const project = marker > 0 ? parts[marker - 1] : parts.at(-2);
    if (project && !/visual studio code/i.test(project)) return project;
  }
  const focused = (windows || []).find((item) => item.active);
  const commandLine = String(focused?.commandLine || "");
  const matches = [...commandLine.matchAll(/(?:^|\s)(?:--folder-uri\s+)?["']?([A-Za-z]:\\[^"']+?)["']?(?=\s--|$)/g)];
  const candidate = matches.at(-1)?.[1];
  return candidate ? path.basename(candidate.replace(/[\\/]+$/, "")) : "";
}

function directoryFromContext(activeApplication, windows) {
  if (!/^code(?: - insiders)?$/i.test(String(activeApplication || ""))) return "";
  const focused = (windows || []).find((item) => item.active);
  const commandLine = String(focused?.commandLine || "");
  const quoted = [...commandLine.matchAll(/["']([A-Za-z]:\\[^"']+)["']/g)].map((match) => match[1]);
  return quoted.findLast((item) => !/\\code(?: - insiders)?\.exe$/i.test(item)) || "";
}

export class WindowsContextAdapter {
  constructor() {
    this.cpuSample = null;
  }

  cpuUsage() {
    const current = os.cpus().map((cpu) => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0) }));
    if (!this.cpuSample || this.cpuSample.length !== current.length) {
      this.cpuSample = current;
      return null;
    }
    let idle = 0;
    let total = 0;
    current.forEach((sample, index) => {
      idle += sample.idle - this.cpuSample[index].idle;
      total += sample.total - this.cpuSample[index].total;
    });
    this.cpuSample = current;
    return total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 1000) / 10)) : null;
  }

  async fast({ includeClipboard = false } = {}) {
    const base = {
      activeApplication: "",
      activeWindow: "",
      windows: [],
      runningApps: [],
      runningProcesses: [],
      monitors: [],
      clipboard: null,
    };
    if (process.platform !== "win32") {
      return { ...base, runningProcesses: unique(os.cpus().map((cpu) => cpu.model), 10) };
    }
    const clipboard = includeClipboard ? "$clipboard=try{Get-Clipboard -Raw -ErrorAction Stop}catch{$null};" : "$clipboard=$null;";
    const script = String.raw`$ErrorActionPreference='SilentlyContinue'; Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class JarvisContextNative {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
}
'@; $foreground=[JarvisContextNative]::GetForegroundWindow(); [uint32]$activeId=0; [void][JarvisContextNative]::GetWindowThreadProcessId($foreground,[ref]$activeId); $processes=Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine; $byId=@{}; foreach($p in $processes){$byId[[int]$p.ProcessId]=$p}; $windows=@(Get-Process | Where-Object {$_.MainWindowHandle -ne 0 -and $_.MainWindowTitle} | ForEach-Object {$p=$byId[[int]$_.Id]; [pscustomobject]@{processId=$_.Id;processName=$_.ProcessName;title=$_.MainWindowTitle;executablePath=$p.ExecutablePath;commandLine=$p.CommandLine;active=($_.MainWindowHandle -eq $foreground)}}); Add-Type -AssemblyName System.Windows.Forms; $monitors=@([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {[pscustomobject]@{deviceName=$_.DeviceName;primary=$_.Primary;bounds=[pscustomobject]@{x=$_.Bounds.X;y=$_.Bounds.Y;width=$_.Bounds.Width;height=$_.Bounds.Height};workArea=[pscustomobject]@{x=$_.WorkingArea.X;y=$_.WorkingArea.Y;width=$_.WorkingArea.Width;height=$_.WorkingArea.Height}}}); ${clipboard} [pscustomobject]@{activeProcessId=[int]$activeId;windows=$windows;runningProcesses=@($processes | Select-Object -First 400 ProcessId,Name,ExecutablePath);monitors=$monitors;clipboard=$clipboard} | ConvertTo-Json -Depth 6 -Compress`;
    const observed = await powershellJson(script, 6500);
    const windows = Array.isArray(observed.windows) ? observed.windows : observed.windows ? [observed.windows] : [];
    const activeWindow = windows.find((item) => item.active) || {};
    const processes = Array.isArray(observed.runningProcesses) ? observed.runningProcesses : observed.runningProcesses ? [observed.runningProcesses] : [];
    return {
      ...base,
      activeApplication: String(activeWindow.processName || ""),
      activeWindow: String(activeWindow.title || ""),
      windows: windows.slice(0, 100),
      runningApps: unique(windows.map((item) => item.processName), 100),
      runningProcesses: processes.slice(0, 400),
      monitors: Array.isArray(observed.monitors) ? observed.monitors : observed.monitors ? [observed.monitors] : [],
      clipboard: typeof observed.clipboard === "string" ? observed.clipboard.slice(0, 8000) : null,
    };
  }

  async slow() {
    const metrics = {
      cpuPercent: this.cpuUsage(),
      ram: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
        usedPercent: Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10,
      },
      uptimeSeconds: os.uptime(),
      networkInterfaces: Object.entries(os.networkInterfaces()).map(([name, addresses]) => ({
        name,
        addresses: (addresses || []).filter((item) => !item.internal).map((item) => ({ address: item.address, family: item.family })),
      })).filter((item) => item.addresses.length),
      disks: [],
      battery: null,
      usbDevices: [],
      audioDevices: [],
      gpu: [],
    };
    if (process.platform !== "win32") return metrics;
    const script = String.raw`$ErrorActionPreference='SilentlyContinue'; $battery=Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus; $disks=@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace); $usb=@(Get-PnpDevice -PresentOnly | Where-Object {$_.InstanceId -like 'USB*'} | Select-Object -First 60 FriendlyName,Class,Status,InstanceId); $audio=@(Get-PnpDevice -PresentOnly -Class AudioEndpoint | Select-Object -First 30 FriendlyName,Status,InstanceId); $gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,VideoModeDescription); [pscustomobject]@{battery=$battery;disks=$disks;usbDevices=$usb;audioDevices=$audio;gpu=$gpu} | ConvertTo-Json -Depth 5 -Compress`;
    try { return { ...metrics, ...(await powershellJson(script, 7500)) }; }
    catch (error) { return { ...metrics, error: String(error?.message || error).slice(0, 300) }; }
  }
}

export class ContextEngine {
  constructor({ adapter = new WindowsContextAdapter(), configStore = null, eventBus = null, browserBridge = null, fastCacheMs = 4000, slowCacheMs = 30000 } = {}) {
    this.adapter = adapter;
    this.configStore = configStore;
    this.events = eventBus;
    this.browserBridge = browserBridge;
    this.fastCacheMs = fastCacheMs;
    this.slowCacheMs = slowCacheMs;
    this.fastCache = null;
    this.slowCache = null;
    this.lastContext = null;
  }

  privacy() {
    const value = this.configStore?.get().privacy || {};
    return {
      mode: Boolean(value.mode),
      activityHistory: value.activityHistory !== false,
      clipboardMonitoring: Boolean(value.clipboardMonitoring),
      browserTabHistory: value.browserTabHistory !== false,
    };
  }

  async cached(kind, force, loader) {
    const cache = kind === "fast" ? this.fastCache : this.slowCache;
    const ttl = kind === "fast" ? this.fastCacheMs : this.slowCacheMs;
    if (!force && cache && Date.now() - cache.at < ttl) return safeClone(cache.value);
    try {
      const value = await loader();
      this[`${kind}Cache`] = { at: Date.now(), value };
      return safeClone(value);
    } catch (error) {
      return { ...(cache?.value || {}), error: String(error?.message || error).slice(0, 300) };
    }
  }

  publishChanges(previous, current, privacy) {
    if (!previous || !this.events || !privacy.activityHistory || privacy.mode) return;
    if (previous?.activeWindow && previous.activeWindow !== current.activeWindow) {
      this.events.publish("WINDOW_CHANGED", { application: current.activeApplication, title: current.activeWindow, project: current.currentProject });
    }
    const before = new Set(previous?.runningApps || []);
    const after = new Set(current.runningApps || []);
    for (const application of after) if (!before.has(application)) this.events.publish("APPLICATION_STARTED", { application });
    for (const application of before) if (!after.has(application)) this.events.publish("APPLICATION_CLOSED", { application });
  }

  async snapshot(force = false) {
    const privacy = this.privacy();
    const fast = await this.cached("fast", force, () => this.adapter.fast({ includeClipboard: privacy.clipboardMonitoring && !privacy.mode }));
    const slow = await this.cached("slow", force, () => this.adapter.slow());
    const browser = privacy.mode || !privacy.browserTabHistory ? { windows: [] } : this.browserBridge?.current?.() || { windows: [] };
    const context = {
      observedAt: new Date().toISOString(),
      platform: process.platform,
      activeApplication: fast.activeApplication || "",
      activeWindow: fast.activeWindow || "",
      currentProject: projectFromContext(fast.activeApplication, fast.activeWindow, fast.windows),
      currentDirectory: directoryFromContext(fast.activeApplication, fast.windows),
      runningApps: unique(fast.runningApps),
      runningProcesses: fast.runningProcesses || [],
      windows: fast.windows || [],
      browserWindows: browser.windows || [],
      browserTabs: (browser.windows || []).flatMap((window) => window.tabs || []).slice(0, 300),
      monitors: fast.monitors || [],
      clipboard: privacy.mode ? null : fast.clipboard ?? null,
      systemMetrics: slow,
      privacyMode: privacy.mode,
      degraded: [fast.error, slow.error].filter(Boolean),
      source: "context_engine",
    };
    this.publishChanges(this.lastContext, context, privacy);
    this.lastContext = safeClone(context);
    return safeClone(context);
  }

  clearCache() {
    this.fastCache = null;
    this.slowCache = null;
  }
}

export { directoryFromContext, projectFromContext };
