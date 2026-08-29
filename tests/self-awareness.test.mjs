import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../core/config.js";
import { SelfAwarenessService } from "../core/self-awareness.js";
import { DataStore } from "../core/storage.js";
import { ToolRegistry } from "../core/tools.js";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-awareness-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("self-awareness reports the real architecture and completed five-system upgrade", async (t) => {
  const directory = temporaryDirectory(t);
  const configStore = new ConfigStore(directory);
  const service = new SelfAwarenessService({ configStore, contextEngine: { snapshot: async () => ({ activeApplication: "Code", monitors: [{}, {}], degraded: [] }) } });
  const report = await service.report();
  assert.equal(report.architecture.runtime, "Node.js ES modules");
  assert.equal(report.architecture.desktop, "Electron");
  assert.equal(report.runtime.monitors, 2);
  assert.equal(report.gaps[0].id, "agent_router");
  for (const id of ["planning", "automation", "accessibility", "project_brain", "proactive"]) assert.equal(report.capabilities.find((item) => item.id === id)?.status, "ready");
  assert.match(report.recommendation, /requested five-system upgrade is installed/i);
  assert.doesNotMatch(await service.answer(), /install rasa|pip install/i);
});

test("upgrade reflection questions bypass the model and use self-diagnostics", async (t) => {
  const directory = temporaryDirectory(t);
  const configStore = new ConfigStore(directory);
  const registry = new ToolRegistry({
    dataStore: new DataStore(directory),
    configStore,
    mcpManager: { listTools: async () => [], call: async () => null },
    dataDir: directory,
  });
  const result = await registry.fastCommand("Reflect yourself and tell me what programming systems you still need to become like Iron Man's JARVIS.");
  assert.match(result.answer, /actual runtime/i);
  assert.match(result.answer, /verified task graphs/i);
  assert.match(result.answer, /proactive notifications/i);
  assert.deepEqual(result.tools.map((item) => item.name), ["selfDiagnostics"]);
});
