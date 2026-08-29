import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccessibilityService } from "../core/accessibility.js";
import { compactMessages, ModelProvider } from "../core/agent.js";
import { AutomationEngine, parseAutomationRule } from "../core/automations.js";
import { CognitiveEventBus } from "../core/event-bus.js";
import { ConfigStore } from "../core/config.js";
import { DataStore } from "../core/storage.js";
import { ProjectBrain } from "../core/project-brain.js";
import { NotificationService, ProactiveEngine } from "../core/proactive.js";
import { formatProviderError } from "../core/provider-errors.js";
import { TaskGraphExecutor } from "../core/task-graph.js";
import { ToolRegistry } from "../core/tools.js";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-advanced-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("task graphs enforce dependencies, retry failures, verify nodes, and persist completion", async (t) => {
  const directory = temporaryDirectory(t);
  const calls = [];
  let flaky = 0;
  const runner = async (tool) => {
    calls.push(tool);
    if (tool === "flaky" && flaky++ === 0) return { isError: true, text: "temporary failure", action: { status: "FAILED", verification: { evidence: ["temporary failure"] } } };
    return { text: `${tool} done`, action: { status: "SUCCESS", verification: { status: "SUCCESS", evidence: ["verified"] } } };
  };
  const executor = new TaskGraphExecutor(directory, { runner, concurrency: 2 });
  const graph = executor.create({ title: "Verified workflow", nodes: [
    { id: "a", tool: "first" }, { id: "b", tool: "flaky", maxRetries: 1 }, { id: "c", tool: "last", dependsOn: ["a", "b"] },
  ] });
  const result = await executor.run(graph.id);
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.find((node) => node.id === "b").attempts, 2);
  assert.ok(calls.indexOf("last") > calls.lastIndexOf("flaky"));
  assert.equal(new TaskGraphExecutor(directory, { runner }).get(graph.id).status, "completed");
  assert.throws(() => executor.create({ nodes: [{ id: "x", tool: "one", dependsOn: ["y"] }, { id: "y", tool: "two", dependsOn: ["x"] }] }), /cycle/);
  assert.throws(() => executor.create({ nodes: [{ id: "secret", tool: "securityTools", arguments: { password: "do-not-store" } }] }), /credentials/);
});

test("automation rules match events, respect cooldown, audit runs, and reject secrets", async (t) => {
  const directory = temporaryDirectory(t);
  let now = new Date("2026-08-29T10:00:00Z");
  const calls = [];
  const engine = new AutomationEngine(directory, { runner: async (tool, args) => { calls.push({ tool, args }); return { text: "done", action: { status: "SUCCESS" } }; }, now: () => now });
  const parsed = parseAutomationRule("When I launch VS Code, then open documentation");
  assert.equal(parsed.trigger.type, "APPLICATION_STARTED");
  engine.create({ ...parsed, cooldownMs: 60000 });
  await engine.handle({ type: "APPLICATION_STARTED", detail: { application: "VS Code" } });
  await engine.handle({ type: "APPLICATION_STARTED", detail: { application: "VS Code" } });
  assert.equal(calls.length, 1);
  assert.equal(engine.runs().at(0).status, "completed");
  now = new Date(now.getTime() + 61000);
  await engine.handle({ type: "APPLICATION_STARTED", detail: { application: "VS Code" } });
  assert.equal(calls.length, 2);
  assert.throws(() => engine.create({ trigger: { type: "X" }, actions: [{ tool: "x", arguments: { apiKey: "secret" } }] }), /Credentials/);
  assert.throws(() => engine.create({ trigger: { type: "X" }, actions: [{ tool: "systemControl", arguments: { action: "shutdown", confirm: true } }] }), /not allowed/);
  engine.close();
});

test("automation service emits schedule and battery state events for persistent rules", async (t) => {
  const directory = temporaryDirectory(t);
  const calls = [];
  const now = new Date("2026-08-29T18:00:00");
  const engine = new AutomationEngine(directory, { now: () => now, contextEngine: { snapshot: async () => ({ systemMetrics: { battery: { EstimatedChargeRemaining: 12, BatteryStatus: 1 } } }) }, runner: async (tool) => { calls.push(tool); return { action: { status: "SUCCESS" } }; } });
  engine.create({ name: "Evening", trigger: { type: "SCHEDULE_TICK", path: "detail.time", value: "18:00" }, actions: [{ tool: "eveningAction" }], cooldownMs: 60000 });
  engine.create({ name: "Low battery", trigger: { type: "BATTERY_STATE", path: "detail.percent", operator: "lte", value: 15 }, actions: [{ tool: "batteryAction" }], cooldownMs: 60000 });
  await engine.tick();
  assert.deepEqual(calls.sort(), ["batteryAction", "eveningAction"]);
  engine.close();
});

test("accessibility control uses semantic selectors and requires confirmation for mutations", async () => {
  const requests = [];
  const service = new AccessibilityService({ adapter: { perform: async (operation, args) => { requests.push({ operation, args }); return operation === "invoke" ? { invoked: true, name: args.name } : { found: true, name: args.name }; } } });
  assert.equal((await service.execute({ operation: "find", windowTitle: "Settings", name: "Save" })).found, true);
  await assert.rejects(service.execute({ operation: "invoke", windowTitle: "Settings", automationId: "save" }), /confirm=true/);
  assert.equal((await service.execute({ operation: "invoke", windowTitle: "Settings", automationId: "save", confirm: true })).invoked, true);
  assert.equal("x" in requests[1].args || "y" in requests[1].args, false);
});

test("project brain incrementally indexes source, ranks matching files, and remembers decisions", async (t) => {
  const directory = temporaryDirectory(t);
  const project = path.join(directory, "project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "node_modules"));
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "brain-test", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(project, "src", "auth.js"), "export function authenticateToken(token) { return Boolean(token); }");
  fs.writeFileSync(path.join(project, "src", "ui.js"), "export const button = 'save';");
  fs.writeFileSync(path.join(project, "node_modules", "ignored.js"), "authenticateToken secret");
  const brain = new ProjectBrain(directory);
  const summary = await brain.scan(project);
  assert.equal(summary.name, "brain-test");
  assert.equal(summary.files, 3);
  assert.equal(brain.search(project, "authentication token")[0].path, path.join("src", "auth.js"));
  const decision = brain.rememberDecision(project, "Use semantic UI selectors", "Coordinates are fragile");
  assert.match(decision.reason, /fragile/);
  assert.equal(new ProjectBrain(directory).summary(project).decisions.length, 1);
  assert.equal((await brain.scan(project)).lastScan.changed, 0);
});

test("proactive notifications deduplicate failures, honor quiet mode, snooze, and detect pressure", (t) => {
  const directory = temporaryDirectory(t);
  let clock = Date.parse("2026-08-29T10:00:00Z");
  const service = new NotificationService(directory, { clock: () => clock });
  const first = service.notify({ message: "Action failed", dedupeKey: "failure:x", cooldownMs: 60000 });
  assert.equal(service.notify({ message: "Action failed", dedupeKey: "failure:x", cooldownMs: 60000 }).suppressed, true);
  service.snooze(first.id, 30);
  assert.equal(service.list().length, 0);
  clock += 31 * 60000;
  assert.equal(service.list().length, 1);
  service.settings({ quiet: true });
  assert.equal(service.notify({ message: "quiet" }).reason, "quiet_mode");
  service.settings({ quiet: false });
  const engine = new ProactiveEngine(directory, { clock: () => clock });
  const pressure = engine.evaluateContext({ systemMetrics: { memoryPercent: 94, batteryPercent: 10, charging: false, diskFreePercent: 8 } });
  assert.equal(pressure.filter((item) => !item.suppressed).length, 3);
});

test("proactive engine converts verified system failures into cooldown-aware alerts", (t) => {
  const directory = temporaryDirectory(t);
  const events = new CognitiveEventBus(directory);
  const engine = new ProactiveEngine(directory, { eventBus: events });
  engine.start();
  events.publish("TASK_GRAPH_FAILED", { graphId: "g1", error: "A dependency failed." });
  events.publish("TASK_GRAPH_FAILED", { graphId: "g1", error: "A dependency failed." });
  assert.equal(engine.notifications.list().length, 1);
  engine.stop();
});

test("all five systems are exposed through the verified JARVIS tool registry", async (t) => {
  const directory = temporaryDirectory(t);
  const configStore = new ConfigStore(directory);
  configStore.update({ tools: { allowedRoots: [directory] } });
  const registry = new ToolRegistry({ dataStore: new DataStore(directory), configStore, mcpManager: { listTools: async () => [], call: async () => null }, dataDir: directory });
  const names = new Set((await registry.list()).map((tool) => tool.name));
  for (const name of ["taskGraph", "automations", "accessibility", "projectBrain", "notifications"]) assert.ok(names.has(name), `${name} should be registered`);
  const created = await registry.execute("taskGraph", { operation: "create", title: "Registry proof", nodes: [{ id: "calculate", tool: "utilities", arguments: { operation: "calculate", expression: "6 * 7" } }] });
  const graph = JSON.parse(created.text);
  const run = await registry.execute("taskGraph", { operation: "run", id: graph.id });
  assert.equal(run.action.status, "SUCCESS");
  assert.equal(JSON.parse(run.text).nodes[0].verification.status, "SUCCESS");
  registry.automations.close();
  registry.proactive.stop();
});

test("system integration requests create and execute the five-node graph immediately", async (t) => {
  const directory = temporaryDirectory(t);
  const configStore = new ConfigStore(directory);
  const registry = new ToolRegistry({ dataStore: new DataStore(directory), configStore, mcpManager: { listTools: async () => [], call: async () => null }, dataDir: directory });
  registry.accessibility.adapter = { perform: async () => ({ window: "JARVIS // Personal Intelligence", elements: [] }) };
  registry.extended.diagnostics = async () => JSON.stringify({ platform: "test", online: true });
  const result = await registry.fastCommand("Proceed with creating and running the system-integration-test graph for automations, accessibility, project brain, notifications, and device diagnostics.");
  assert.match(result.answer, /completed\. 5\/5 nodes verified/i);
  assert.match(result.answer, /Automation service: completed/);
  assert.equal(result.tools.length, 2);
  assert.deepEqual(result.tools.map((item) => item.args.operation), ["create", "run"]);
  const graph = registry.taskGraphs.get(result.tools[1].args.id);
  assert.equal(graph.nodes.length, 5);
  assert.ok(graph.nodes.every((node) => node.status === "completed"));
  registry.automations.close();
  registry.proactive.stop();
});

test("provider fallback identifies quota failures and continues to another configured provider", async (t) => {
  const directory = temporaryDirectory(t);
  const configStore = new ConfigStore(directory);
  const calls = [];
  const provider = new ModelProvider(configStore, { groq: () => "configured", gemini: () => "configured", openai: () => "configured" });
  provider.cloudChat = async (target) => {
    calls.push(target.provider);
    if (target.provider === "groq") { const error = new Error("rate limited"); error.status = 429; throw error; }
    return { role: "assistant", content: "fallback worked" };
  };
  const response = await provider.chat({ messages: [{ role: "user", content: "hello" }], model: "groq:openai/gpt-oss-20b" });
  assert.equal(response.content, "fallback worked");
  assert.deepEqual(calls, ["groq", "gemini"]);

  configStore.update({ llm: { providerFallback: false } });
  await assert.rejects(provider.chat({ messages: [{ role: "user", content: "hello" }], model: "groq:openai/gpt-oss-20b" }), (error) => {
    assert.equal(error.jarvisProvider, "groq");
    assert.match(formatProviderError(error), /^Groq reached its quota or rate limit/);
    return true;
  });
  assert.match(formatProviderError({ providerFailures: [{ provider: "groq", status: 429 }, { provider: "gemini", status: 401 }, { provider: "ollama", status: null }] }), /Groq: quota.*Gemini: API key rejected.*local Ollama: unavailable/);
});

test("local fallback retries tool-incompatible Ollama models without native tools", async (t) => {
  const directory = temporaryDirectory(t);
  const configStore = new ConfigStore(directory);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.tools) return { ok: false, status: 400, text: async () => "model does not support tools" };
    return { ok: true, status: 200, json: async () => ({ message: { role: "assistant", content: "LOCAL_FALLBACK_OK" } }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const provider = new ModelProvider(configStore, { groq: () => "", gemini: () => "", openai: () => "" });
  const response = await provider.chat({ messages: [{ role: "user", content: "hello" }], tools: [{ name: "stop", description: "Stop", inputSchema: { type: "object", properties: {} } }], model: "ollama:gemma3:4b" });
  assert.equal(response.content, "LOCAL_FALLBACK_OK");
  assert.equal(response.jarvisNativeTools, false);
  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools);
  assert.equal(requests[1].tools, undefined);
});

test("oversized cloud requests compact context and retry without native tool schemas", async (t) => {
  const directory = temporaryDirectory(t);
  const configStore = new ConfigStore(directory);
  configStore.update({ llm: { providerFallback: false } });
  const provider = new ModelProvider(configStore, { groq: () => "configured", gemini: () => "", openai: () => "" });
  const attempts = [];
  provider.cloudChat = async (_target, options) => {
    attempts.push(options);
    if (attempts.length === 1) { const error = new Error("request too large"); error.status = 413; throw error; }
    return { role: "assistant", content: "COMPACT_OK" };
  };
  const messages = [{ role: "system", content: `identity ${"x".repeat(50000)} tool instructions` }, ...Array.from({ length: 20 }, (_item, index) => ({ role: index % 2 ? "assistant" : "user", content: `${index}:${"y".repeat(10000)}` }))];
  const response = await provider.chat({ messages, tools: [{ name: "stop", description: "stop", inputSchema: { type: "object", properties: {} } }], model: "groq:openai/gpt-oss-20b" });
  assert.equal(response.content, "COMPACT_OK");
  assert.equal(response.jarvisNativeTools, false);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].tools.length, 0);
  assert.ok(JSON.stringify(attempts[1].messages).length < 26000);
  const compact = compactMessages(messages, 12000);
  assert.match(compact[0].content, /^identity/);
  assert.match(compact.at(-1).content, /^19:/);
});
