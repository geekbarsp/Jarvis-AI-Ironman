import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./storage.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked"]);

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function timeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Task timed out after ${ms}ms.`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function validateNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error("A task graph requires at least one node.");
  const ids = new Set();
  for (const node of nodes) {
    if (!node.id || ids.has(String(node.id))) throw new Error("Task node IDs must be present and unique.");
    if (!String(node.tool || "").trim()) throw new Error(`Task node ${node.id} requires a tool.`);
    if (containsSensitive(node.arguments)) throw new Error(`Task node ${node.id} contains credentials that cannot be stored in a durable graph.`);
    ids.add(String(node.id));
  }
  for (const node of nodes) for (const dependency of node.dependsOn || []) if (!ids.has(String(dependency))) throw new Error(`Unknown dependency ${dependency} for ${node.id}.`);
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  const visit = (id) => {
    if (visiting.has(id)) throw new Error("Task graph contains a dependency cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn || []) visit(String(dependency));
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function containsSensitive(value, key = "", depth = 0) {
  if (depth > 8) return false;
  if (/password|secret|api.?key|token|authorization/i.test(key)) return value !== undefined && value !== "";
  if (Array.isArray(value)) return value.some((item) => containsSensitive(item, "", depth + 1));
  if (value && typeof value === "object") return Object.entries(value).some(([childKey, item]) => containsSensitive(item, childKey, depth + 1));
  return false;
}

export class TaskGraphExecutor {
  constructor(dataDir, { runner, eventBus = null, concurrency = 3 } = {}) {
    this.file = path.join(dataDir, "task-graphs.json");
    this.runner = runner;
    this.events = eventBus;
    this.concurrency = Math.max(1, Math.min(Number(concurrency) || 3, 8));
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch { this.data = { version: 1, graphs: [] }; }
    this.controllers = new Map();
    this.recoverInterrupted();
  }

  persist() { atomicJson(this.file, this.data); }

  recoverInterrupted() {
    let changed = false;
    for (const graph of this.data.graphs) {
      if (graph.status !== "running") continue;
      graph.status = "paused";
      graph.reason = "Execution was interrupted and can be resumed.";
      for (const node of graph.nodes) if (node.status === "running") node.status = "pending";
      changed = true;
    }
    if (changed) this.persist();
  }

  create({ title, nodes, metadata = {} }) {
    validateNodes(nodes);
    const now = new Date().toISOString();
    const graph = {
      id: crypto.randomUUID(),
      title: redact(title || "Task graph").slice(0, 500),
      status: "pending",
      metadata,
      nodes: nodes.slice(0, 100).map((node) => ({
        id: String(node.id),
        name: redact(node.name || node.id).slice(0, 300),
        tool: String(node.tool || ""),
        arguments: node.arguments && typeof node.arguments === "object" ? node.arguments : {},
        dependsOn: [...new Set((node.dependsOn || []).map(String))],
        priority: Number(node.priority) || 0,
        maxRetries: Math.max(0, Math.min(Number(node.maxRetries) || 0, 5)),
        attempts: 0,
        timeoutMs: Math.max(100, Math.min(Number(node.timeoutMs) || 30000, 300000)),
        status: "pending",
        verification: null,
        error: "",
      })),
      createdAt: now,
      updatedAt: now,
    };
    this.data.graphs.push(graph);
    this.data.graphs = this.data.graphs.slice(-200);
    this.persist();
    this.events?.publish("TASK_GRAPH_CREATED", { graphId: graph.id, title: graph.title, nodes: graph.nodes.length });
    return structuredClone(graph);
  }

  get(id) { const graph = this.data.graphs.find((item) => item.id === id); return graph ? structuredClone(graph) : null; }
  list(limit = 30) { return structuredClone(this.data.graphs.slice(-limit).reverse()); }

  cancel(id, reason = "Cancelled by user.") {
    const graph = this.data.graphs.find((item) => item.id === id);
    if (!graph || TERMINAL.has(graph.status)) return false;
    this.controllers.get(id)?.abort(reason);
    graph.status = "cancelled";
    graph.reason = redact(reason).slice(0, 500);
    for (const node of graph.nodes) if (["pending", "running"].includes(node.status)) node.status = "cancelled";
    graph.updatedAt = new Date().toISOString();
    this.persist();
    this.events?.publish("TASK_GRAPH_CANCELLED", { graphId: id, reason });
    return true;
  }

  async run(id) {
    const graph = this.data.graphs.find((item) => item.id === id);
    if (!graph) throw new Error(`Unknown task graph: ${id}`);
    if (graph.status === "completed") return structuredClone(graph);
    if (typeof this.runner !== "function") throw new Error("Task graph action runner is unavailable.");
    const controller = new AbortController();
    this.controllers.set(id, controller);
    graph.status = "running";
    graph.reason = "";
    graph.updatedAt = new Date().toISOString();
    this.persist();
    this.events?.publish("TASK_GRAPH_STARTED", { graphId: id });

    const executeNode = async (node) => {
      node.status = "running";
      node.attempts += 1;
      node.startedAt = new Date().toISOString();
      this.persist();
      this.events?.publish("TASK_NODE_STARTED", { graphId: id, nodeId: node.id, tool: node.tool, attempt: node.attempts });
      try {
        const result = await timeout(Promise.resolve(this.runner(node.tool, structuredClone(node.arguments))), node.timeoutMs);
        const status = result?.action?.status || (result?.isError ? "FAILED" : "SUCCESS");
        if (result?.isError || status === "FAILED") throw new Error(result?.action?.verification?.evidence?.[0] || result?.text || "Action verification failed.");
        node.status = status === "PARTIAL_SUCCESS" ? "partial" : "completed";
        node.verification = result?.action?.verification || { status, evidence: ["Action runner completed."] };
        node.result = redact(result?.text || "").slice(0, 3000);
        node.completedAt = new Date().toISOString();
        this.events?.publish("TASK_NODE_COMPLETED", { graphId: id, nodeId: node.id, status: node.status });
      } catch (error) {
        node.error = redact(error?.message || String(error)).slice(0, 1000);
        if (node.attempts <= node.maxRetries && !controller.signal.aborted) node.status = "pending";
        else node.status = controller.signal.aborted ? "cancelled" : "failed";
        this.events?.publish("TASK_NODE_FAILED", { graphId: id, nodeId: node.id, error: node.error, retrying: node.status === "pending" });
      } finally {
        graph.updatedAt = new Date().toISOString();
        this.persist();
      }
    };

    while (!controller.signal.aborted) {
      const failed = new Set(graph.nodes.filter((node) => ["failed", "blocked", "cancelled"].includes(node.status)).map((node) => node.id));
      let changed = false;
      for (const node of graph.nodes.filter((item) => item.status === "pending")) {
        if (node.dependsOn.some((dependency) => failed.has(dependency))) { node.status = "blocked"; node.error = "A dependency did not complete."; changed = true; }
      }
      if (changed) this.persist();
      const completed = new Set(graph.nodes.filter((node) => ["completed", "partial"].includes(node.status)).map((node) => node.id));
      const ready = graph.nodes.filter((node) => node.status === "pending" && node.dependsOn.every((dependency) => completed.has(dependency))).sort((a, b) => b.priority - a.priority).slice(0, this.concurrency);
      if (!ready.length) break;
      await Promise.all(ready.map(executeNode));
    }

    if (controller.signal.aborted) graph.status = "cancelled";
    else if (graph.nodes.every((node) => ["completed", "partial"].includes(node.status))) graph.status = graph.nodes.some((node) => node.status === "partial") ? "partial" : "completed";
    else graph.status = "failed";
    graph.completedAt = new Date().toISOString();
    graph.updatedAt = graph.completedAt;
    this.controllers.delete(id);
    this.persist();
    this.events?.publish(graph.status === "failed" ? "TASK_GRAPH_FAILED" : "TASK_GRAPH_FINISHED", { graphId: id, status: graph.status });
    return structuredClone(graph);
  }
}
