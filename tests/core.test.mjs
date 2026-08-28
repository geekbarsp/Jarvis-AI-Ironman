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
import { encodeMonoWav } from "../src/audio.js";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jervis-test-"));
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
  for (const name of ["manageApps", "systemControl", "clipboard", "reminders", "notes", "contacts", "fileUtilities", "utilities", "featureCatalogue", "healthWellness", "studyTools", "calendarTools", "documentTools", "creativeTools", "securityTools", "deviceDiagnostics", "advancedFileManagement", "developerTools", "phoneTools"]) assert.equal(names.has(name), true);
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
  await extended.documents({ operation: "textToPdf", text: "Private JERVIS document", output: pdf }, [allowed]);
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
