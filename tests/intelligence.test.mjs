import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ActionEngine, ActionStatus } from "../core/actions.js";
import { ConfigStore } from "../core/config.js";
import { ContextEngine } from "../core/context.js";
import { CognitiveEventBus } from "../core/event-bus.js";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-intelligence-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("context engine builds cached structured context and emits meaningful changes", async (t) => {
  const directory = temporaryDirectory(t);
  const config = new ConfigStore(directory);
  config.update({ privacy: { clipboardMonitoring: true } });
  const events = new CognitiveEventBus(directory);
  let calls = 0;
  const adapter = {
    fast: async ({ includeClipboard }) => {
      calls += 1;
      const code = calls === 1;
      return {
        activeApplication: code ? "Code" : "chrome",
        activeWindow: code ? "index.js - Jarvis - Visual Studio Code" : "Documentation - Chrome",
        runningApps: code ? ["Code"] : ["Code", "chrome"],
        runningProcesses: [],
        windows: [{ processName: code ? "Code" : "chrome", title: code ? "index.js - Jarvis - Visual Studio Code" : "Documentation - Chrome", active: true }],
        monitors: [{ deviceName: "DISPLAY1", primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
        clipboard: includeClipboard ? "temporary clipboard" : null,
      };
    },
    slow: async () => ({ cpuPercent: 25, ram: { usedPercent: 50 }, disks: [] }),
  };
  const browserBridge = { current: () => ({ windows: [{ tabs: [{ title: "Docs", url: "https://example.com", active: true }] }] }) };
  const context = new ContextEngine({ adapter, configStore: config, eventBus: events, browserBridge, fastCacheMs: 10000, slowCacheMs: 10000 });
  const first = await context.snapshot();
  assert.equal(first.currentProject, "Jarvis");
  assert.equal(first.clipboard, "temporary clipboard");
  assert.equal(first.browserTabs[0].title, "Docs");
  assert.equal((await context.snapshot()).activeApplication, "Code");
  assert.equal(calls, 1);
  await context.snapshot(true);
  assert.ok(events.recent().some((event) => event.type === "WINDOW_CHANGED"));
  assert.ok(events.recent().some((event) => event.type === "APPLICATION_STARTED" && event.detail.application === "chrome"));
});

test("privacy mode suppresses sensitive context and activity events", async (t) => {
  const directory = temporaryDirectory(t);
  const config = new ConfigStore(directory);
  config.update({ privacy: { mode: true, clipboardMonitoring: true, browserTabHistory: true } });
  const events = new CognitiveEventBus(directory);
  const adapter = {
    fast: async ({ includeClipboard }) => ({ activeApplication: "Code", activeWindow: "Secret - Visual Studio Code", runningApps: ["Code"], runningProcesses: [], windows: [], monitors: [], clipboard: includeClipboard ? "secret" : null }),
    slow: async () => ({}),
  };
  const context = new ContextEngine({ adapter, configStore: config, eventBus: events, browserBridge: { current: () => ({ windows: [{ tabs: [{ title: "Private" }] }] }) } });
  const snapshot = await context.snapshot(true);
  assert.equal(snapshot.clipboard, null);
  assert.deepEqual(snapshot.browserTabs, []);
  assert.deepEqual(events.recent(), []);
});

test("action engine enforces risk, verifies outcomes, redacts history, and undoes", async (t) => {
  const directory = temporaryDirectory(t);
  const config = new ConfigStore(directory);
  const engine = new ActionEngine(directory, { configStore: config });
  await assert.rejects(
    () => engine.execute({ tool: "notes", arguments: { operation: "delete", text: "private note" } }, { descriptor: { riskLevel: "high" }, handler: async () => ({ text: "deleted" }) }),
    /confirmation/i,
  );
  const completed = await engine.execute(
    { tool: "notes", arguments: { operation: "delete", confirm: true, text: "private note" } },
    {
      descriptor: { riskLevel: "high" },
      handler: async () => ({ text: "deleted" }),
      verify: async () => ({ status: ActionStatus.PARTIAL_SUCCESS, evidence: ["One secondary item was unavailable."] }),
      createRollback: async () => ({ type: "restore_note", id: "note-1" }),
    },
  );
  assert.equal(completed.action.status, ActionStatus.PARTIAL_SUCCESS);
  assert.equal(completed.action.undoable, true);
  const disk = fs.readFileSync(path.join(directory, "action-history.json"), "utf8");
  assert.doesNotMatch(disk, /private note/);
  const undone = await engine.undoLast(async (rollback) => ({ text: `restored ${rollback.id}` }));
  assert.match(undone.text, /note-1/);
  assert.equal(engine.snapshot().undoable, null);
});

test("critical actions require full access even when confirmed", async (t) => {
  const directory = temporaryDirectory(t);
  const config = new ConfigStore(directory);
  const engine = new ActionEngine(directory, { configStore: config });
  await assert.rejects(
    () => engine.execute({ tool: "systemControl", arguments: { action: "shutdown", confirm: true } }, { handler: async () => ({ text: "never" }) }),
    /Full Access/,
  );
});
