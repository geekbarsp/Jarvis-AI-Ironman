import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function normalize(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function powershellJson(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `Application discovery failed (${code}).`));
      try { resolve(JSON.parse(stdout.trim() || "[]")); } catch { resolve([]); }
    });
  });
}

export class ApplicationIndex {
  constructor(dataDir, { ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.file = path.join(dataDir, "application-index.json");
    this.ttlMs = ttlMs;
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch { this.data = { version: 1, updatedAt: null, applications: [], aliases: {} }; }
    this.data.aliases ||= {};
  }

  save() { atomicJson(this.file, this.data); }
  setAlias(alias, target) {
    const key = normalize(alias); const value = String(target || "").trim();
    if (!key || !value) throw new Error("Both an application alias and target are required.");
    this.data.aliases[key] = value;
    this.save();
    return { alias: key, target: value };
  }
  aliases() { return structuredClone(this.data.aliases); }

  async refresh(force = false) {
    if (!force && this.data.updatedAt && Date.now() - Date.parse(this.data.updatedAt) < this.ttlMs) return this.list();
    let applications = [];
    if (process.platform === "win32") {
      const script = `$items=@();
Get-StartApps | ForEach-Object { $items += [pscustomobject]@{name=$_.Name;command=('shell:AppsFolder\\'+$_.AppID);source='start-apps'} };
$roots=@([Environment]::GetFolderPath('CommonStartMenu'),[Environment]::GetFolderPath('StartMenu'));
foreach($root in $roots){
  if(Test-Path -LiteralPath $root){
    Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $items += [pscustomobject]@{name=$_.BaseName;command=$_.FullName;source='start-menu'} }
  }
};
@($items | Sort-Object name -Unique) | ConvertTo-Json -Compress`;
      try { applications = await powershellJson(script); } catch {}
    }
    applications = (Array.isArray(applications) ? applications : applications ? [applications] : []).filter((item) => item.name && item.command).slice(0, 5000);
    this.data.applications = applications;
    this.data.updatedAt = new Date().toISOString();
    this.save();
    return this.list();
  }

  list() { return structuredClone(this.data.applications || []); }
  resolve(value) {
    const original = String(value || "").trim();
    const key = normalize(original);
    const alias = this.data.aliases[key];
    const target = alias || original;
    const normalizedTarget = normalize(target);
    const exact = (this.data.applications || []).find((item) => normalize(item.name) === normalizedTarget);
    const partial = exact || (this.data.applications || []).find((item) => normalize(item.name).includes(normalizedTarget) || normalizedTarget.includes(normalize(item.name)));
    return { input: original, alias: alias || null, name: partial?.name || target, command: partial?.command || target, indexed: Boolean(partial) };
  }
  search(query, limit = 20) {
    const needle = normalize(query);
    return this.list().filter((item) => normalize(item.name).includes(needle)).slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
  }
}

function result(intent, tool, argumentsValue, confidence = 0.98, extra = {}) {
  return { route: "DIRECT_COMMAND", intent, confidence, complexity: 0, requiresTools: true, requiresInternet: false, tool, arguments: argumentsValue, ...extra };
}

export class DirectCommandParser {
  constructor(applicationIndex) { this.apps = applicationIndex; }

  parse(input) {
    const text = String(input || "").trim();
    const lower = text.toLowerCase().replace(/^jarvis[,:]?\s*/i, "").trim();
    let match;
    match = lower.match(/^(?:remember (?:that )?)?(?:when i say )?(.+?)\s+(?:means|mean|is)\s+(.+?)(?:\.|$)/i);
    if (match && /remember|when i say|\bmeans\b/i.test(lower)) return { route: "LOCAL_MEMORY", intent: "application_alias", confidence: 0.99, complexity: 0, requiresTools: false, requiresInternet: false, alias: match[1].trim(), target: match[2].trim(), cacheable: false };
    match = lower.match(/^(?:open|launch|start|bring up|i need)\s+(.+?)(?:\.|$)/i);
    if (match) {
      const target = match[1].trim();
      if (/^(?:work|coding|valorant|.+) mode$/i.test(target)) return result("restore_mode", "workspaceRestore", { name: target.replace(/\s+mode$/i, " Mode") }, 0.96);
      if (/^(?:downloads|download folder)$/i.test(target)) return result("open_folder", "manageApps", { operation: "open", target: path.join(os.homedir(), "Downloads") });
      const resolved = this.apps.resolve(target);
      return result("open_application", "manageApps", { operation: "open", target: resolved.command }, resolved.indexed || resolved.alias ? 0.995 : 0.93, { target: resolved.name });
    }
    match = lower.match(/^(?:close|quit|exit)\s+(.+?)(?:\.|$)/i);
    if (match) return result("close_application", "manageApps", { operation: "close", target: this.apps.resolve(match[1]).name, confirm: true }, 0.97);
    match = lower.match(/^(?:set\s+)?volume(?:\s+to)?\s+(\d{1,3})(?:\s*%|\.|$)/i);
    if (match && Number(match[1]) <= 100) return result("set_volume", "systemControl", { action: "volumeSet", value: Number(match[1]) });
    if (/^(?:mute|mute (?:the )?(?:sound|volume|audio))\.?$/i.test(lower)) return result("mute", "systemControl", { action: "mute" });
    if (/^(?:volume down|turn it down|lower (?:the )?(?:sound|volume)|lower it)\.?$/i.test(lower)) return result("volume_down", "systemControl", { action: "volumeDown" });
    if (/^(?:volume up|turn it up|raise (?:the )?(?:sound|volume)|raise it)\.?$/i.test(lower)) return result("volume_up", "systemControl", { action: "volumeUp" });
    if (/^(?:play music|play|pause|play pause)\.?$/i.test(lower)) return result("media_play_pause", "systemControl", { action: "playPause" });
    if (/^(?:take (?:a )?screenshot|capture (?:the )?screen)\.?$/i.test(lower)) return result("screenshot", "screenshot", {});
    if (/^(?:lock (?:my |the )?(?:computer|pc)|lock)\.?$/i.test(lower)) return result("lock_computer", "systemControl", { action: "lock" });
    if (/^(?:restart|reboot)(?: (?:my|the) (?:computer|pc))?\.?$/i.test(lower)) return result("restart_computer", "systemControl", { action: "restart", confirm: true });
    if (/^(?:shutdown|shut down)(?: (?:my|the) (?:computer|pc))?\.?$/i.test(lower)) return result("shutdown_computer", "systemControl", { action: "shutdown", confirm: true });
    if (/^(?:what(?:'s| is) )?(?:my )?(?:cpu usage|ram usage|memory usage|system status)\??$/i.test(lower)) return result("system_metrics", "getSystemContext", { quick: "metrics" }, 0.99, { cacheTtlMs: 5000 });
    if (/^(?:what|which) apps? (?:are )?running\??$|^list running apps?\.?$/i.test(lower)) return result("running_applications", "getSystemContext", { quick: "apps" }, 0.99, { cacheTtlMs: 3000 });
    match = lower.match(/^(?:search|find) (?:my )?files?(?: for| named| called)?\s+(.+?)(?:\.|$)/i)
      || lower.match(/^find\s+(.+?\.[a-z0-9]{1,8})$/i);
    if (match) return result("search_files", "localFiles", { operation: "search", query: match[1].trim() }, 0.96, { cacheTtlMs: 10000 });
    match = lower.match(/^(?:save|remember) (?:this|my current setup) as (.+?)(?:\.|$)/i);
    if (match) return result("save_mode", "workspaceSave", { name: match[1].trim() }, 0.98);
    return null;
  }
}
