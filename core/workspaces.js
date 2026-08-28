import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_WINDOWS = 200;
const SYSTEM_CLASSES = new Set(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow", "Windows.UI.Core.CoreWindow"]);
const SYSTEM_PROCESSES = new Set(["dwm", "sihost", "searchhost", "startmenuexperiencehost", "shellexperiencehost", "textinputhost", "lockapp", "applicationframehost", "jarvis", "jarvis-whisper"]);
const BROWSERS = new Set(["chrome", "msedge"]);

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function safeName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 100 || /[\r\n\0]/.test(name)) throw new Error("A workspace name is required and must be 100 characters or fewer.");
  return name;
}

export function normalizeWorkspaceName(value) {
  return safeName(value).toLocaleLowerCase("en-US");
}

function normalizeExecutable(value) {
  return String(value || "").trim().replace(/\//g, "\\").toLowerCase();
}

function processKey(item) {
  return normalizeExecutable(item.executablePath) || String(item.processName || "").toLowerCase();
}

function titleTokens(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function titleSimilarity(left, right) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

export function applicationMatchScore(saved, current) {
  let score = 0;
  const savedExecutable = normalizeExecutable(saved.executablePath);
  const currentExecutable = normalizeExecutable(current.executablePath);
  if (savedExecutable && currentExecutable && savedExecutable === currentExecutable) score += 100;
  if (String(saved.processName || "").toLowerCase() === String(current.processName || "").toLowerCase()) score += 45;
  if (saved.applicationType && saved.applicationType === current.applicationType) score += 10;
  return score;
}

export function windowMatchScore(saved, current) {
  let score = applicationMatchScore(saved, current);
  if (saved.className && saved.className === current.className) score += 25;
  score += Math.round(titleSimilarity(saved.title, current.title) * 30);
  if (saved.monitor?.deviceName && saved.monitor.deviceName === current.monitor?.deviceName) score += 5;
  return score;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function resolveWindowBounds(savedWindow, monitors) {
  const available = Array.isArray(monitors) && monitors.length ? monitors : [{ deviceName: "fallback", primary: true, workArea: { x: 0, y: 0, width: 1280, height: 720 } }];
  const savedMonitor = savedWindow.monitor || {};
  const target = available.find((monitor) => monitor.deviceName === savedMonitor.deviceName)
    || available.find((monitor) => monitor.primary)
    || available[0];
  const work = target.workArea || target.bounds;
  const old = savedMonitor.workArea || savedMonitor.bounds || work;
  const sourceWidth = Math.max(1, Number(old.width) || work.width);
  const sourceHeight = Math.max(1, Number(old.height) || work.height);
  const width = clamp(Math.round((Number(savedWindow.width) || 800) * work.width / sourceWidth), 220, work.width);
  const height = clamp(Math.round((Number(savedWindow.height) || 600) * work.height / sourceHeight), 160, work.height);
  const relativeX = (Number(savedWindow.x) || old.x || 0) - (Number(old.x) || 0);
  const relativeY = (Number(savedWindow.y) || old.y || 0) - (Number(old.y) || 0);
  const x = clamp(Math.round(work.x + relativeX * work.width / sourceWidth), work.x, work.x + work.width - width);
  const y = clamp(Math.round(work.y + relativeY * work.height / sourceHeight), work.y, work.y + work.height - height);
  return { x, y, width, height, monitor: target };
}

function powershell(script, timeout = 30000) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Windows workspace helper timed out.")); }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Windows workspace helper failed (${code}).`));
    });
  });
}

const WINDOW_API = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class JarvisWorkspaceWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT minPosition, maxPosition; public RECT normalPosition; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szDevice; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}`;

function captureScript() {
  return `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -TypeDefinition @'\n${WINDOW_API}\n'@;
$commands=@{}; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $commands[[int]$_.ProcessId]=$_.CommandLine };
$foreground=[JarvisWorkspaceWin]::GetForegroundWindow().ToInt64(); $handles=New-Object System.Collections.Generic.List[System.IntPtr];
$callback=[JarvisWorkspaceWin+EnumWindowsProc]{ param($h,$l) if([JarvisWorkspaceWin]::IsWindowVisible($h)){[void]$handles.Add($h)}; return $true }; [JarvisWorkspaceWin]::EnumWindows($callback,[IntPtr]::Zero)|Out-Null;
$windows=@(); $z=0; foreach($h in $handles){
  $length=[JarvisWorkspaceWin]::GetWindowTextLength($h); if($length -le 0){continue}; $title=New-Object Text.StringBuilder ($length+1); [void][JarvisWorkspaceWin]::GetWindowText($h,$title,$title.Capacity);
  $class=New-Object Text.StringBuilder 256; [void][JarvisWorkspaceWin]::GetClassName($h,$class,$class.Capacity); [uint32]$processId=0; [void][JarvisWorkspaceWin]::GetWindowThreadProcessId($h,[ref]$processId);
  try{$process=Get-Process -Id $processId -ErrorAction Stop}catch{continue}; $exe=''; try{$exe=$process.Path}catch{};
  $rect=New-Object JarvisWorkspaceWin+RECT; if(-not [JarvisWorkspaceWin]::GetWindowRect($h,[ref]$rect)){continue}; if(($rect.Right-$rect.Left)-lt 80 -or ($rect.Bottom-$rect.Top)-lt 50){continue};
  $placement=New-Object JarvisWorkspaceWin+WINDOWPLACEMENT; $placement.length=[Runtime.InteropServices.Marshal]::SizeOf($placement); [void][JarvisWorkspaceWin]::GetWindowPlacement($h,[ref]$placement);
  $monitorHandle=[JarvisWorkspaceWin]::MonitorFromWindow($h,2); $monitor=New-Object JarvisWorkspaceWin+MONITORINFOEX; $monitor.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($monitor); [void][JarvisWorkspaceWin]::GetMonitorInfo($monitorHandle,[ref]$monitor);
  $state=if($placement.showCmd -eq 2){'minimized'}elseif($placement.showCmd -eq 3){'maximized'}else{'normal'}; $fullscreen=[math]::Abs($rect.Left-$monitor.rcMonitor.Left)-le 2 -and [math]::Abs($rect.Top-$monitor.rcMonitor.Top)-le 2 -and [math]::Abs($rect.Right-$monitor.rcMonitor.Right)-le 2 -and [math]::Abs($rect.Bottom-$monitor.rcMonitor.Bottom)-le 2; $savedRect=if($state -eq 'minimized'){$placement.normalPosition}else{$rect};
  $windows += [pscustomobject]@{handle=$h.ToInt64();processId=[int]$processId;processName=$process.ProcessName;executablePath=$exe;commandLine=$commands[[int]$processId];title=$title.ToString();className=$class.ToString();x=$savedRect.Left;y=$savedRect.Top;width=$savedRect.Right-$savedRect.Left;height=$savedRect.Bottom-$savedRect.Top;state=$state;fullscreen=$fullscreen;active=($h.ToInt64() -eq $foreground);zOrder=$z;monitor=[pscustomobject]@{deviceName=$monitor.szDevice;primary=(($monitor.dwFlags -band 1)-eq 1);bounds=[pscustomobject]@{x=$monitor.rcMonitor.Left;y=$monitor.rcMonitor.Top;width=$monitor.rcMonitor.Right-$monitor.rcMonitor.Left;height=$monitor.rcMonitor.Bottom-$monitor.rcMonitor.Top};workArea=[pscustomobject]@{x=$monitor.rcWork.Left;y=$monitor.rcWork.Top;width=$monitor.rcWork.Right-$monitor.rcWork.Left;height=$monitor.rcWork.Bottom-$monitor.rcWork.Top}}}; $z++;
}; $windows | ConvertTo-Json -Depth 7 -Compress`;
}

function layoutScript(actions, activeHandle) {
  const json = JSON.stringify(actions).replace(/'/g, "''");
  return `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WINDOW_API}\n'@; $actions=ConvertFrom-Json '${json}'; foreach($a in @($actions)){ $h=[IntPtr]([int64]$a.handle); [void][JarvisWorkspaceWin]::ShowWindowAsync($h,9); [void][JarvisWorkspaceWin]::SetWindowPos($h,[IntPtr]::Zero,[int]$a.x,[int]$a.y,[int]$a.width,[int]$a.height,0x0014); if($a.state -eq 'maximized' -or $a.fullscreen){[void][JarvisWorkspaceWin]::ShowWindowAsync($h,3)}elseif($a.state -eq 'minimized'){[void][JarvisWorkspaceWin]::ShowWindowAsync($h,2)}else{[void][JarvisWorkspaceWin]::ShowWindowAsync($h,9)} }; ${activeHandle ? `[void][JarvisWorkspaceWin]::SetForegroundWindow([IntPtr]([int64]${activeHandle}))` : ""}`;
}

function applicationType(processName) {
  const name = String(processName || "").toLowerCase();
  if (name === "chrome") return "chrome";
  if (name === "msedge") return "edge";
  if (name === "code") return "vscode";
  return "generic";
}

function vscodeArguments(commandLine, executablePath) {
  if (!/\bcode(?: - insiders)?\.exe$/i.test(executablePath || "")) return [];
  const values = String(commandLine || "").match(/"[^"]+"|\S+/g) || [];
  return values.slice(1).map((value) => value.replace(/^"|"$/g, "")).filter((value) => !value.startsWith("--") && fs.existsSync(value) && fs.statSync(value).isDirectory()).slice(0, 3);
}

export class WindowsWorkspaceAdapter {
  async capture({ excludedProcesses = [], excludedWindowClasses = [] } = {}) {
    if (process.platform !== "win32") throw new Error("Adaptive Workspace Memory currently requires Windows.");
    const text = await powershell(captureScript(), 20000);
    const parsed = text ? JSON.parse(text) : [];
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const configuredProcesses = new Set(excludedProcesses.map((item) => String(item).toLowerCase()));
    const configuredClasses = new Set(excludedWindowClasses.map(String));
    const windows = values.filter((item) => {
      const processName = String(item.processName || "").toLowerCase();
      return item.title && !SYSTEM_CLASSES.has(item.className) && !configuredClasses.has(item.className) && !SYSTEM_PROCESSES.has(processName) && !configuredProcesses.has(processName);
    }).slice(0, MAX_WINDOWS).map((item) => ({
      ...item,
      applicationType: applicationType(item.processName),
      launchArguments: vscodeArguments(item.commandLine, item.executablePath),
      commandLine: undefined,
    }));
    const monitorMap = new Map(windows.map((item) => [item.monitor?.deviceName, item.monitor]).filter(([name]) => name));
    return { windows, monitors: [...monitorMap.values()] };
  }

  async launch(application) {
    const executable = String(application.executablePath || "");
    const terminalFallback = String(application.processName || "").toLowerCase() === "windowsterminal" ? "wt.exe" : "";
    const command = executable && fs.existsSync(executable) ? executable : terminalFallback;
    if (!command) throw new Error(`${application.processName || "Application"} is no longer installed at ${executable || "its saved path"}.`);
    const args = application.applicationType === "vscode" ? application.launchArguments || [] : [];
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false, shell: false });
      child.once("spawn", () => { child.unref(); resolve(); });
      child.once("error", reject);
    });
    return { launched: true, processName: application.processName };
  }

  async applyLayout(actions, activeHandle) {
    if (!actions.length) return;
    await powershell(layoutScript(actions, activeHandle), 20000);
  }
}

function snapshotApplications(windows) {
  const values = new Map();
  for (const window of windows) {
    const key = processKey(window);
    if (!key || values.has(key)) continue;
    values.set(key, {
      id: crypto.randomUUID(),
      processName: window.processName,
      executablePath: window.executablePath,
      launchArguments: window.launchArguments || [],
      applicationType: window.applicationType || applicationType(window.processName),
    });
  }
  return [...values.values()];
}

function excluded(item, exclusions) {
  const text = `${item.processName || ""} ${item.executablePath || ""} ${item.title || ""}`.toLowerCase();
  return exclusions.some((value) => text.includes(String(value).toLowerCase()));
}

export class WorkspaceService {
  constructor(dataDir, { adapter = new WindowsWorkspaceAdapter(), browserBridge = null, configStore = null, logger = console, restoreTimeout = 12000 } = {}) {
    this.file = path.join(dataDir, "workspaces.json");
    this.adapter = adapter;
    this.browserBridge = browserBridge;
    this.configStore = configStore;
    this.logger = logger;
    this.restoreTimeout = restoreTimeout;
    this.data = this.load();
  }

  captureOptions() {
    return this.configStore?.get().workspaceMemory || {};
  }

  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { version: 1, workspaces: Array.isArray(value.workspaces) ? value.workspaces : [] };
    } catch { return { version: 1, workspaces: [] }; }
  }

  persist() { atomicJson(this.file, this.data); }

  find(name) {
    const normalized = normalizeWorkspaceName(name);
    return this.data.workspaces.find((item) => item.normalizedName === normalized) || null;
  }

  list() {
    return this.data.workspaces.map((item) => ({ id: item.id, name: item.name, createdAt: item.createdAt, updatedAt: item.updatedAt, applications: item.applications.length, windows: item.windows.length, browserWindows: item.browser?.windows?.length || 0 }));
  }

  get(name) {
    const workspace = this.find(name);
    if (!workspace) throw new Error(`No workspace named "${safeName(name)}" was found.`);
    return structuredClone(workspace);
  }

  async capture(name, { overwrite = false } = {}) {
    const displayName = safeName(name);
    const existing = this.find(displayName);
    if (existing && !overwrite) throw new Error(`A workspace named "${existing.name}" already exists. Ask JARVIS to update it instead.`);
    this.logger.log(`[Workspace] Capturing workspace: ${displayName}`);
    const [desktop, browser] = await Promise.all([
      this.adapter.capture(this.captureOptions()),
      this.browserBridge?.capture().catch((error) => ({ windows: [], unavailable: error.message })) || Promise.resolve({ windows: [], unavailable: "Browser companion not connected." }),
    ]);
    const now = new Date().toISOString();
    const workspace = {
      id: existing?.id || crypto.randomUUID(),
      name: displayName,
      normalizedName: normalizeWorkspaceName(displayName),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      applications: snapshotApplications(desktop.windows),
      windows: desktop.windows.map((window) => ({ ...window, handle: undefined })),
      monitors: desktop.monitors,
      browser,
      metadata: { platform: "win32", schemaVersion: 1 },
    };
    if (existing) this.data.workspaces[this.data.workspaces.indexOf(existing)] = workspace;
    else this.data.workspaces.push(workspace);
    this.persist();
    this.logger.log(`[Workspace] Detected ${workspace.applications.length} applications`);
    this.logger.log(`[Workspace] Detected ${workspace.windows.length} visible windows`);
    this.logger.log(`[Workspace] Browser reported ${(browser.windows || []).reduce((total, item) => total + (item.tabs?.length || 0), 0)} tabs`);
    this.logger.log("[Workspace] Saved successfully");
    return workspace;
  }

  async update(name, { captureCurrentState = true, additions = [], removals = [] } = {}) {
    const existing = this.get(name);
    if (captureCurrentState) return this.capture(existing.name, { overwrite: true });
    existing.applications = existing.applications.filter((item) => !excluded(item, removals));
    existing.windows = existing.windows.filter((item) => !excluded(item, removals));
    if (additions.length) {
      const current = await this.adapter.capture(this.captureOptions());
      const candidates = snapshotApplications(current.windows).filter((item) => excluded(item, additions));
      for (const item of candidates) if (!existing.applications.some((saved) => applicationMatchScore(saved, item) >= 100)) existing.applications.push(item);
      existing.windows.push(...current.windows.filter((item) => excluded(item, additions)).map((item) => ({ ...item, handle: undefined })));
    }
    existing.updatedAt = new Date().toISOString();
    this.data.workspaces[this.data.workspaces.findIndex((item) => item.id === existing.id)] = existing;
    this.persist();
    return existing;
  }

  delete(name) {
    const workspace = this.get(name);
    this.data.workspaces = this.data.workspaces.filter((item) => item.id !== workspace.id);
    this.persist();
    return { deleted: true, name: workspace.name };
  }

  async restore(name, { exclusions = [], additions = [] } = {}) {
    const workspace = this.get(name);
    this.logger.log(`[Workspace] Restoring: ${workspace.name}`);
    const before = await this.adapter.capture(this.captureOptions());
    const capturedBrowsers = new Set((workspace.browser?.windows || []).map((item) => item.browser === "edge" ? "msedge" : "chrome"));
    const applications = workspace.applications.filter((item) => !excluded(item, exclusions) && !capturedBrowsers.has(String(item.processName || "").toLowerCase()));
    const reused = [];
    const failures = [];
    const failedApplications = new Set();
    const launch = [];
    for (const application of applications) {
      if (before.windows.some((item) => applicationMatchScore(application, item) >= 45)) {
        reused.push(application.processName);
        this.logger.log(`[Workspace] Reusing running ${application.processName}`);
      }
      else launch.push(application);
    }
    await Promise.all(launch.map(async (application) => {
      try {
        this.logger.log(`[Workspace] Launching ${application.processName}`);
        await this.adapter.launch(application);
      }
      catch (error) {
        this.logger.error?.(`[Workspace] ${application.processName}: ${error.message}`);
        failedApplications.add(application.processName);
        failures.push({ application: application.processName, error: error.message });
      }
    }));
    for (const addition of additions) {
      try { await this.adapter.launch({ processName: path.basename(addition, path.extname(addition)), executablePath: addition, applicationType: "generic" }); }
      catch (error) { failedApplications.add(addition); failures.push({ application: addition, error: error.message }); }
    }

    let browserResult = null;
    if (workspace.browser?.windows?.length) {
      try {
        this.logger.log("[Workspace] Opening browser session");
        browserResult = await this.browserBridge?.restore(workspace.browser, { exclusions });
      }
      catch (error) {
        failures.push({ application: "Browser tabs", error: error.message });
        const browserApps = workspace.applications.filter((item) => capturedBrowsers.has(String(item.processName || "").toLowerCase()) && !excluded(item, exclusions));
        await Promise.all(browserApps.map(async (application) => {
          if (before.windows.some((item) => applicationMatchScore(application, item) >= 45)) return;
          try { await this.adapter.launch(application); }
          catch (launchError) { failedApplications.add(application.processName); failures.push({ application: application.processName, error: launchError.message }); }
        }));
      }
    }

    const configuredTimeout = Number(this.captureOptions().restoreTimeoutMs);
    const deadline = Date.now() + (Number.isFinite(configuredTimeout) ? configuredTimeout : this.restoreTimeout);
    let current = before;
    do {
      if (launch.length) await new Promise((resolve) => setTimeout(resolve, 650));
      current = await this.adapter.capture(this.captureOptions());
      if (launch.every((application) => current.windows.some((item) => applicationMatchScore(application, item) >= 45))) break;
    } while (Date.now() < deadline);

    const monitors = current.monitors.length ? current.monitors : before.monitors;
    const usedHandles = new Set();
    const actions = [];
    let activeHandle = null;
    for (const savedWindow of workspace.windows.filter((item) => !excluded(item, exclusions) && !BROWSERS.has(String(item.processName || "").toLowerCase()))) {
      const match = current.windows.filter((item) => !usedHandles.has(item.handle)).map((item) => ({ item, score: windowMatchScore(savedWindow, item) })).sort((a, b) => b.score - a.score)[0];
      if (!match || match.score < 45) {
        failures.push({ application: savedWindow.processName, error: `Window not found: ${savedWindow.title}` });
        continue;
      }
      usedHandles.add(match.item.handle);
      const bounds = resolveWindowBounds(savedWindow, monitors);
      actions.push({ handle: match.item.handle, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, state: savedWindow.state, fullscreen: savedWindow.fullscreen });
      if (savedWindow.active) activeHandle = match.item.handle;
    }
    try {
      this.logger.log("[Workspace] Restoring window positions");
      await this.adapter.applyLayout(actions, activeHandle);
    }
    catch (error) { failures.push({ application: "Window layout", error: error.message }); }
    this.logger.log("[Workspace] Restore complete");
    return { name: workspace.name, restoredApplications: applications.length - failedApplications.size, reused, launched: launch.map((item) => item.processName), positionedWindows: actions.length, browser: browserResult, failures };
  }
}
