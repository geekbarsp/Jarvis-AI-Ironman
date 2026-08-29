import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { redact } from "./storage.js";

const execFileAsync = promisify(execFile);
const EXCLUDED = new Set([".git", "node_modules", "dist", "build", "release", ".venv", "venv", "models", "coverage", "__pycache__"]);
const TEXT_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".py", ".json", ".md", ".txt", ".html", ".css", ".scss", ".sql", ".yml", ".yaml", ".toml", ".ini", ".env.example", ".cjs", ".mjs"]);
const STOP = new Set(["this", "that", "with", "from", "have", "will", "your", "into", "const", "function", "return", "import", "export"]);
const CONCEPTS = new Map([
  ["authenticate", "auth"], ["authentication", "auth"], ["authorization", "auth"], ["login", "auth"],
  ["settings", "config"], ["configuration", "config"], ["configure", "config"],
  ["alerts", "notification"], ["notify", "notification"], ["notifications", "notification"],
  ["remove", "delete"], ["removed", "delete"], ["deletion", "delete"],
  ["errors", "failure"], ["failed", "failure"], ["fails", "failure"],
  ["tests", "test"], ["testing", "test"], ["verified", "verify"], ["verification", "verify"],
]);
const INDEX_VERSION = 2;

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function terms(value) {
  const separated = String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_./\\-]+/g, " ").toLowerCase();
  return (separated.match(/[a-z0-9]{3,}/g) || []).filter((term) => !STOP.has(term)).map((term) => CONCEPTS.get(term) || term);
}

function frequencies(value) {
  const output = {};
  for (const term of terms(value)) output[term] = (output[term] || 0) + 1;
  return output;
}

function walk(root, visitor, limit = 5000) {
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < limit) {
    const directory = queue.shift();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (seen >= limit) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (EXCLUDED.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      seen += 1;
      if (entry.isDirectory()) queue.push(child);
      else visitor(child);
    }
  }
}

async function git(root, args) {
  try { return (await execFileAsync("git", ["-C", root, ...args], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch { return ""; }
}

export class ProjectBrain {
  constructor(dataDir, { eventBus = null } = {}) {
    this.file = path.join(dataDir, "project-brain.json");
    this.events = eventBus;
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch { this.data = { version: INDEX_VERSION, projects: [] }; }
  }

  persist() { atomicJson(this.file, this.data); }
  find(root) { const resolved = path.resolve(root); return this.data.projects.find((item) => item.root.toLowerCase() === resolved.toLowerCase()); }

  async scan(root) {
    const resolved = path.resolve(root);
    if (!fs.statSync(resolved).isDirectory()) throw new Error("Project path must be a directory.");
    const existing = this.find(resolved);
    const previous = new Map((existing?.files || []).map((item) => [item.path, item]));
    const files = [];
    let changed = 0;
    walk(resolved, (file) => {
      const relative = path.relative(resolved, file);
      const extension = path.extname(file).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension) && !["package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod"].includes(path.basename(file))) return;
      let stat;
      try { stat = fs.statSync(file); } catch { return; }
      if (stat.size > 512 * 1024) return;
      const prior = previous.get(relative);
      if (existing?.indexVersion === INDEX_VERSION && prior && prior.mtimeMs === stat.mtimeMs && prior.size === stat.size) { files.push(prior); return; }
      let content;
      try { content = fs.readFileSync(file, "utf8"); } catch { return; }
      const clean = redact(content).slice(0, 12000);
      files.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs, terms: frequencies(`${relative} ${clean}`), excerpt: clean.slice(0, 4000) });
      changed += 1;
    });
    let packageInfo = {};
    try {
      const value = JSON.parse(fs.readFileSync(path.join(resolved, "package.json"), "utf8"));
      packageInfo = { name: value.name, scripts: value.scripts || {}, dependencies: Object.keys(value.dependencies || {}), devDependencies: Object.keys(value.devDependencies || {}) };
    } catch {}
    const now = new Date().toISOString();
    const project = {
      id: existing?.id || crypto.randomUUID(),
      indexVersion: INDEX_VERSION,
      name: packageInfo.name || path.basename(resolved),
      root: resolved,
      files,
      package: packageInfo,
      git: { branch: await git(resolved, ["branch", "--show-current"]), status: (await git(resolved, ["status", "--short"])).split("\n").filter(Boolean).slice(0, 100) },
      decisions: existing?.decisions || [],
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastScan: { changed, indexed: files.length },
    };
    if (existing) this.data.projects[this.data.projects.indexOf(existing)] = project;
    else this.data.projects.push(project);
    this.data.projects = this.data.projects.slice(-50);
    this.persist();
    this.events?.publish("PROJECT_INDEXED", { projectId: project.id, name: project.name, changed, indexed: files.length });
    return this.summary(project);
  }

  summary(projectOrRoot) {
    const project = typeof projectOrRoot === "string" ? this.find(projectOrRoot) : projectOrRoot;
    if (!project) throw new Error("Project has not been indexed.");
    const extensions = {};
    for (const file of project.files) extensions[path.extname(file.path) || "other"] = (extensions[path.extname(file.path) || "other"] || 0) + 1;
    return { id: project.id, name: project.name, root: project.root, files: project.files.length, languages: extensions, package: project.package, git: project.git, decisions: project.decisions, lastScan: project.lastScan, updatedAt: project.updatedAt };
  }

  search(root, query, limit = 10) {
    const project = this.find(root);
    if (!project) throw new Error("Project has not been indexed. Scan it first.");
    const queryTerms = terms(query);
    const documentFrequency = {};
    for (const term of queryTerms) documentFrequency[term] = project.files.filter((file) => file.terms[term]).length;
    return project.files.map((file) => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = file.terms[term] || 0;
        const idf = Math.log((project.files.length + 1) / ((documentFrequency[term] || 0) + 1)) + 1;
        score += (1 + Math.log(Math.max(1, tf))) * idf;
        if (file.path.toLowerCase().includes(term)) score += 4;
      }
      return { path: file.path, score: +score.toFixed(3), excerpt: file.excerpt.slice(0, 1200), size: file.size };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(Number(limit) || 10, 30)));
  }

  rememberDecision(root, decision, reason = "") {
    const project = this.find(root);
    if (!project) throw new Error("Project has not been indexed. Scan it first.");
    const item = { id: crypto.randomUUID(), decision: redact(decision).slice(0, 2000), reason: redact(reason).slice(0, 3000), createdAt: new Date().toISOString() };
    project.decisions.push(item);
    project.decisions = project.decisions.slice(-300);
    this.persist();
    return structuredClone(item);
  }

  list() { return this.data.projects.map((project) => this.summary(project)); }
}
