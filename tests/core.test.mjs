import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../core/config.js";
import { rankByEmbedding } from "../core/embeddings.js";
import { MCPManager } from "../core/mcp.js";
import { DataStore, redact } from "../core/storage.js";
import { ToolRegistry } from "../core/tools.js";
import { PersonalAssistant } from "../core/personal.js";
import { ExtendedFeatures } from "../core/extended.js";
import { RoutineLearner } from "../core/routines.js";
import { completedToolFallback } from "../core/agent.js";
import { BrowserWorkspaceBridge, sanitizeBrowserUrl } from "../core/browser-bridge.js";
import { WorkspaceService, applicationMatchScore, normalizeWorkspaceName, resolveWindowBounds, windowMatchScore } from "../core/workspaces.js";
import { encodeMonoWav, shouldKeepVoiceOrbVisible } from "../src/audio.js";
import { normalizeSpeechText } from "../core/speech.js";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("hands-free PCM encoding produces a valid mono WAV", () => {
  const wav = encodeMonoWav([new Float32Array([0, 0.5, -0.5, 1, -1])], 16000);
  const view = new DataView(wav);
  assert.equal(Buffer.from(wav, 0, 4).toString(), "RIFF");
  assert.equal(Buffer.from(wav, 8, 4).toString(), "WAVE");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), 10);
});

test("voice orb remains visible through capture and response processing", () => {
  assert.equal(shouldKeepVoiceOrbVisible({ recording: true, status: "armed" }), true);
  assert.equal(shouldKeepVoiceOrbVisible({ status: "transcribing" }), true);
  assert.equal(shouldKeepVoiceOrbVisible({ status: "thinking" }), true);
  assert.equal(shouldKeepVoiceOrbVisible({ speaking: true, status: "armed" }), true);
  assert.equal(shouldKeepVoiceOrbVisible({ status: "armed", awake: false }), false);
});

test("speech text removes Markdown without reading formatting characters", () => {
  const spoken = normalizeSpeechText("## **Status**\n* Build passed\n* Open [GitHub](https://github.com)\n\n`npm test` and 2 * 3 = 6.");
  assert.equal(spoken, "Status. Build passed. Open GitHub. npm test and 2 times 3 = 6.");
  assert.doesNotMatch(spoken, /[*#|`]/);
  assert.equal(normalizeSpeechText("```js\nconst value = true;\n```"), "Code block omitted.");
});

function workspaceState(windows = []) {
  return {
    windows,
    monitors: [
      { deviceName: "DISPLAY1", primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    ],
  };
}

function workspaceWindow(overrides = {}) {
  return {
    handle: 10,
    processId: 100,
    processName: "Code",
    executablePath: "C:\\Apps\\Code.exe",
    launchArguments: ["C:\\Projects\\Jarvis"],
    applicationType: "vscode",
    title: "Jarvis - Visual Studio Code",
    className: "Chrome_WidgetWin_1",
    x: 50,
    y: 40,
    width: 1200,
    height: 800,
    state: "normal",
    fullscreen: false,
    active: true,
    zOrder: 0,
    monitor: { deviceName: "DISPLAY1", primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    ...overrides,
  };
}

class FakeWorkspaceAdapter {
  constructor(state) { this.state = state; this.launched = []; this.layouts = []; this.fail = new Set(); }
  async capture() { return structuredClone(this.state); }
  async launch(application) {
    this.launched.push(application.processName);
    if (this.fail.has(application.processName)) throw new Error(`${application.processName} is missing.`);
  }
  async applyLayout(actions, activeHandle) { this.layouts.push({ actions, activeHandle }); }
}

test("adaptive workspaces persist arbitrary names, update, list, inspect, and delete", async (t) => {
  const directory = temporaryDirectory(t);
  const adapter = new FakeWorkspaceAdapter(workspaceState([workspaceWindow()]));
  const service = new WorkspaceService(directory, { adapter, logger: { log() {} }, restoreTimeout: 0 });
  const saved = await service.capture("Random Client Setup");
  assert.equal(saved.name, "Random Client Setup");
  assert.equal(normalizeWorkspaceName("  RANDOM client   setup "), "random client setup");
  assert.equal(service.get("random CLIENT setup").windows.length, 1);
  assert.equal(service.list()[0].applications, 1);
  adapter.state = workspaceState([workspaceWindow({ title: "Updated project" })]);
  const updated = await service.update("Random Client Setup", { captureCurrentState: true });
  assert.equal(updated.windows[0].title, "Updated project");
  assert.equal(new WorkspaceService(directory, { adapter }).get("random client setup").windows[0].title, "Updated project");
  assert.equal(service.delete("RANDOM CLIENT SETUP").deleted, true);
  assert.deepEqual(service.list(), []);
});

test("workspace matching, monitor fallback, duplicate prevention, exclusions, and partial failure", async (t) => {
  const code = workspaceWindow();
  const discord = workspaceWindow({ handle: 20, processId: 200, processName: "Discord", executablePath: "C:\\Apps\\Discord.exe", applicationType: "generic", title: "Discord", active: false });
  assert.ok(applicationMatchScore(code, { ...code, title: "Changed" }) >= 100);
  assert.ok(windowMatchScore(code, { ...code, title: "Jarvis project - Code" }) > applicationMatchScore(code, code));
  const fallback = resolveWindowBounds({ ...code, x: 2600, monitor: { deviceName: "MISSING", workArea: { x: 1920, y: 0, width: 1920, height: 1080 } } }, [{ deviceName: "DISPLAY1", primary: true, workArea: { x: 0, y: 0, width: 1280, height: 720 } }]);
  assert.ok(fallback.x >= 0 && fallback.x + fallback.width <= 1280);

  const directory = temporaryDirectory(t);
  const adapter = new FakeWorkspaceAdapter(workspaceState([code, discord]));
  const service = new WorkspaceService(directory, { adapter, logger: { log() {} }, restoreTimeout: 0 });
  await service.capture("Work Mode");
  adapter.state = workspaceState([{ ...code, handle: 99 }]);
  let result = await service.restore("Work Mode", { exclusions: ["Discord"] });
  assert.deepEqual(adapter.launched, []);
  assert.ok(result.reused.includes("Code"));
  adapter.fail.add("Discord");
  result = await service.restore("Work Mode");
  assert.ok(adapter.launched.includes("Discord"));
  assert.ok(result.failures.some((item) => item.application === "Discord"));
  assert.ok(adapter.layouts.length >= 1);
});

test("browser workspace bridge captures grouped tabs and removes secrets from URLs", async (t) => {
  const directory = temporaryDirectory(t);
  const bridge = new BrowserWorkspaceBridge(directory, { timeout: 500 });
  const poll = bridge.poll({ clientId: "chrome-test", browser: "chrome" });
  const capture = bridge.capture();
  const request = (await poll).request;
  bridge.respond({
    clientId: "chrome-test",
    browser: "chrome",
    requestId: request.id,
    result: { windows: [{ focused: true, tabs: [{ url: "https://example.com/page?token=secret&view=1", title: "Example", index: 0, active: true }] }] },
  });
  const snapshot = await capture;
  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0].tabs[0].url, "https://example.com/page?view=1");
  assert.equal(sanitizeBrowserUrl("chrome://settings"), "");
});

test("successful reminder tools produce a confirmation instead of a step-limit error", () => {
  const at = "2026-08-28T10:00:00.000Z";
  const answer = completedToolFallback([{
    name: "reminders",
    args: { operation: "create", text: "Work from 6:00 PM to 10:00 PM", at },
    ok: true,
    result: JSON.stringify({ text: "Work from 6:00 PM to 10:00 PM", at }),
  }], "Asia/Manila");

  assert.match(answer, /Friday, August 28 at 6:00 PM/);
  assert.match(answer, /Work from 6:00 PM to 10:00 PM/);
  assert.doesNotMatch(answer, /available tool steps/);
});

test("successful workspace tools produce deterministic confirmations", () => {
  assert.equal(completedToolFallback([{ name: "workspaceSave", args: { name: "Night Mode" }, ok: true }]), 'Workspace "Night Mode" saved from the current desktop.');
  assert.equal(completedToolFallback([{ name: "workspaceRestore", args: { name: "Night Mode" }, ok: true, result: JSON.stringify({ failures: [] }) }]), 'Workspace "Night Mode" restored.');
});

test("configuration merges defaults and writes atomically", (t) => {
  const directory = temporaryDirectory(t);
  const store = new ConfigStore(directory);
  const updated = store.update({ assistant: { location: "Cebu, Philippines" } });
  assert.equal(updated.assistant.location, "Cebu, Philippines");
  assert.equal(updated.assistant.plannerEnabled, true);
  assert.equal(new ConfigStore(directory).get().assistant.location, "Cebu, Philippines");
});

test("memory redacts secrets, searches graph facts, and preserves nutrition on clear", (t) => {
  const directory = temporaryDirectory(t);
  const store = new DataStore(directory);
  assert.doesNotMatch(redact("email me at user@example.com token=secret-value"), /user@example|secret-value/);
  store.appendDialogue("user", "My project codename is Silver Beacon");
  store.addFacts([{ topic: "projects", text: "The user's project codename is Silver Beacon" }]);
  const meal = store.logMeal({ description: "oatmeal", calories: 320 });
  assert.match(store.memoryContext("project codename"), /Silver Beacon/);
  assert.equal(store.getMeals()[0].id, meal.id);
  store.clear();
  assert.equal(store.memoryContext("project codename"), "");
  assert.equal(store.getMeals()[0].description, "oatmeal");
});

test("embedding ranking orders the closest vector first", () => {
  const ranked = rankByEmbedding([1, 0], [[0, 1], [0.9, 0.1]]);
  assert.equal(ranked[0].index, 1);
});

test("local file tool enforces configured roots", async (t) => {
  const directory = temporaryDirectory(t);
  const allowed = path.join(directory, "allowed");
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(allowed, "note.txt"), "private note");
  const configStore = new ConfigStore(directory);
  configStore.update({ tools: { allowedRoots: [allowed] } });
  const dataStore = new DataStore(directory);
  const mcpManager = { listTools: async () => [], call: async () => null, refresh: async () => ({ tools: [], errors: {} }) };
  const registry = new ToolRegistry({ dataStore, configStore, mcpManager, dataDir: directory });
  assert.match((await registry.execute("localFiles", { operation: "read", path: path.join(allowed, "note.txt") })).text, /private note/);
  await assert.rejects(() => registry.execute("localFiles", { operation: "read", path: path.join(directory, "outside.txt") }), /restricted/);
});

test("AI permission modes enforce boundaries and full-drive access", async (t) => {
  const directory = temporaryDirectory(t);
  const allowed = path.join(directory, "allowed");
  const outside = path.join(directory, "outside.txt");
  fs.mkdirSync(allowed);
  fs.writeFileSync(outside, "full access verified");
  const configStore = new ConfigStore(directory);
  configStore.update({ tools: { allowedRoots: [allowed] }, permissions: { mode: "standard" } });
  const registry = new ToolRegistry({ dataStore: new DataStore(directory), configStore, mcpManager: { listTools: async () => [] }, dataDir: directory });
  await assert.rejects(() => registry.execute("phoneTools", { operation: "status" }), /Full Access/);
  configStore.update({ permissions: { mode: "restricted" } });
  await assert.rejects(() => registry.execute("localFiles", { operation: "read", path: outside }), /Restricted/);
  configStore.update({ permissions: { mode: "full" } });
  assert.match((await registry.execute("localFiles", { operation: "read", path: outside })).text, /full access verified/);
});

test("routine learning requires repetition, redacts secrets, and clears independently", (t) => {
  const directory = temporaryDirectory(t);
  const learner = new RoutineLearner(directory);
  learner.record("Open my work calendar", ["calendarTools"], new Date("2026-08-24T08:00:00"));
  learner.record("Open my work calendar", ["calendarTools"], new Date("2026-08-25T08:20:00"));
  assert.equal(learner.insights(new Date("2026-08-26T08:00:00")).length, 0);
  learner.record("Open my work calendar", ["calendarTools"], new Date("2026-08-26T08:10:00"));
  learner.record("password=do-not-store", [], new Date("2026-08-26T09:00:00"));
  const snapshot = learner.snapshot(new Date("2026-08-27T08:00:00"));
  assert.equal(snapshot.observations, 3);
  assert.equal(snapshot.insights[0].count, 3);
  assert.match(snapshot.insights[0].label, /morning on weekdays/);
  assert.match(learner.context(new Date("2026-08-27T08:00:00")), /work calendar/);
  const environment = { activeApplication: "Code", runningApps: ["Code", "Chrome", "Discord"] };
  learner.record("Inspect my project", ["localFiles"], new Date("2026-08-27T10:00:00"), environment);
  learner.record("Run my project", ["developerTools"], new Date("2026-08-27T10:10:00"), environment);
  learner.record("Build my project", ["developerTools"], new Date("2026-08-27T10:20:00"), environment);
  assert.ok(learner.snapshot().habits.some((habit) => habit.triggerApplication === "Code" && habit.companionApplication === "Chrome" && habit.confidence >= 0.67));
  learner.clear();
  assert.deepEqual(learner.snapshot().insights, []);
});

test("MCP manager discovers and invokes stdio tools", async (t) => {
  const fixture = path.join(import.meta.dirname, "mcp-fixture.mjs");
  const config = { mcpServers: { fixture: { command: process.execPath, args: [fixture] } } };
  const manager = new MCPManager(() => config);
  t.after(() => manager.close());
  const tools = await manager.listTools();
  assert.equal(tools[0].name, "mcp__fixture__echo");
  const result = await manager.call("mcp__fixture__echo", { text: "ready" });
  assert.equal(result.text, "echo:ready");
});

test("personal utilities calculate, convert, persist notes, and schedule reminders", (t) => {
  const directory = temporaryDirectory(t);
  const personal = new PersonalAssistant(directory, (value) => path.resolve(value));
  assert.equal(personal.utilities({ operation: "calculate", expression: "(8 + 2) * -3" }), "-30");
  assert.equal(personal.utilities({ operation: "convert", value: 1, from: "km", to: "m" }), "1000");
  const note = JSON.parse(personal.collection("notes", { operation: "save", title: "Private", text: "Remember this" }));
  assert.match(personal.collection("notes", { operation: "search", query: "remember" }), /Remember this/);
  const reminder = JSON.parse(personal.reminders({ operation: "create", text: "Test", at: new Date(Date.now() + 60000).toISOString() }));
  assert.match(reminder.id, /-/);
  assert.match(personal.reminders({ operation: "list" }), /Test/);
  personal.reminders({ operation: "cancel", id: reminder.id });
  personal.collection("notes", { operation: "delete", id: note.id, confirm: true });
  for (const timer of personal.timers.values()) clearTimeout(timer);
});

test("personal-assistant command families are registered", async (t) => {
  const directory = temporaryDirectory(t);
  const configStore = new ConfigStore(directory);
  const registry = new ToolRegistry({ dataStore: new DataStore(directory), configStore, mcpManager: { listTools: async () => [] }, dataDir: directory });
  const names = new Set((await registry.list()).map((tool) => tool.name));
  for (const name of ["manageApps", "systemControl", "clipboard", "reminders", "notes", "contacts", "fileUtilities", "utilities", "featureCatalogue", "healthWellness", "studyTools", "calendarTools", "documentTools", "creativeTools", "securityTools", "deviceDiagnostics", "advancedFileManagement", "developerTools", "phoneTools", "workspaceSave", "workspaceRestore", "workspaceUpdate", "workspaceDelete", "workspaceList", "workspaceInspect"]) assert.equal(names.has(name), true);
  const deleteWorkspace = (await registry.list()).find((tool) => tool.name === "workspaceDelete");
  assert.equal(deleteWorkspace.riskLevel, "high");
  assert.equal(deleteWorkspace.requiresConfirmation, true);
  assert.ok((await registry.select("Remember my current setup as Night Mode")).some((tool) => tool.name === "workspaceSave"));
  assert.ok((await registry.select("Open my Night Mode workspace")).some((tool) => tool.name === "workspaceRestore"));
  assert.ok((await registry.select("Activate my Work Mode")).some((tool) => tool.name === "workspaceRestore"));
});

test("extended compatibility features persist data and create safe artifacts", async (t) => {
  const directory = temporaryDirectory(t);
  const allowed = path.join(directory, "allowed");
  fs.mkdirSync(allowed);
  const guard = (value) => {
    const resolved = path.resolve(value);
    assert.equal(resolved === allowed || resolved.startsWith(`${allowed}${path.sep}`), true);
    return resolved;
  };
  const extended = new ExtendedFeatures(directory, guard);
  assert.match(extended.catalogue({ query: "PDF" }), /text to PDF/);
  extended.health({ operation: "log", type: "water", value: 500, unit: "ml" });
  assert.match(extended.health({ operation: "summary" }), /water/);
  assert.match(extended.health({ operation: "bmi", weightKg: 70, heightCm: 175 }), /22\.9/);
  extended.study({ operation: "add", deck: "code", question: "HTTP success?", answer: "200" });
  assert.match(extended.study({ operation: "quiz", deck: "code" }), /HTTP success/);
  extended.calendar({ operation: "add", title: "Test meeting", start: new Date(Date.now() + 3600000).toISOString() });
  assert.match(extended.calendar({ operation: "briefing" }), /Test meeting/);

  const pdf = path.join(allowed, "note.pdf");
  await extended.documents({ operation: "textToPdf", text: "Private JARVIS document", output: pdf }, [allowed]);
  assert.equal(fs.readFileSync(pdf).subarray(0, 4).toString(), "%PDF");
  const qr = path.join(allowed, "code.png");
  await extended.creative({ operation: "qrCode", text: "https://example.com", output: qr }, [allowed]);
  assert.equal(fs.readFileSync(qr).subarray(1, 4).toString(), "PNG");

  const secret = path.join(allowed, "secret.txt");
  const vault = path.join(allowed, "secret.jvault");
  const restored = path.join(allowed, "restored.txt");
  fs.writeFileSync(secret, "private value");
  await extended.security({ operation: "encrypt", path: secret, output: vault, password: "test password", confirm: true }, [allowed]);
  await extended.security({ operation: "decrypt", path: vault, output: restored, password: "test password", confirm: true }, [allowed]);
  assert.equal(fs.readFileSync(restored, "utf8"), "private value");
});
