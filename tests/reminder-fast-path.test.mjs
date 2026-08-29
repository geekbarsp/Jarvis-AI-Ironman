import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntime, normalizeToolName } from "../core/agent.js";
import { ConfigStore } from "../core/config.js";
import { PersonalAssistant } from "../core/personal.js";
import { resolveReminderRemoval, resolveReminderScheduleCorrection, resolveStaleReminderReference } from "../core/reminder-intents.js";
import { DataStore } from "../core/storage.js";
import { ToolRegistry } from "../core/tools.js";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-reminder-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("schedule correction understands the reported work reminder request deterministically", () => {
  const args = resolveReminderScheduleCorrection(
    "edit my reminders. My work is from 6pm to 10pm. I don't have a work at 2pm.",
    {
      now: new Date("2026-08-28T22:00:00.000Z"),
      timezone: "Asia/Manila",
      reminders: [{ text: "Start work mode", at: "2026-08-29T06:00:00.000Z", done: false }],
    },
  );
  assert.equal(args.operation, "reconcileSchedule");
  assert.equal(args.startAt, "2026-08-29T10:00:00.000Z");
  assert.equal(args.endAt, "2026-08-29T14:00:00.000Z");
});

test("malformed provider channel tokens are removed from tool names", () => {
  assert.equal(normalizeToolName("reminders<|channel|>commentary"), "reminders");
  assert.equal(normalizeToolName(" reminders<|channel|>analysis "), "reminders");
});

test("stale wake-up references distinguish matching reminders from other 10 PM items", () => {
  const query = "and WAKE UP 10PM is still at the reminders.";
  const timezone = "Asia/Manila";
  const withWakeUp = resolveStaleReminderReference(query, { timezone, reminders: [
    { id: "wake", text: "WAKE UP", at: "2026-08-29T14:00:00.000Z", done: false },
    { id: "work", text: "End work", at: "2026-08-29T14:00:00.000Z", done: false },
  ] });
  assert.deepEqual(withWakeUp.matches.map((item) => item.id), ["wake"]);
  assert.deepEqual(withWakeUp.otherAtTime.map((item) => item.id), ["work"]);
  const withoutWakeUp = resolveStaleReminderReference(query, { timezone, reminders: [
    { id: "work", text: "End work", at: "2026-08-29T14:00:00.000Z", done: false },
  ] });
  assert.equal(withoutWakeUp.matches.length, 0);
  assert.equal(withoutWakeUp.otherAtTime[0].text, "End work");
});

test("named and all-reminder removal intents resolve active records locally", () => {
  const reminders = [
    { id: "end", text: "End work", at: "2026-08-29T14:00:00.000Z", done: false },
    { id: "other", text: "Drink water", at: "2026-08-29T15:00:00.000Z", done: false },
  ];
  assert.deepEqual(resolveReminderRemoval("remove my end work.", { reminders }).ids, ["end"]);
  assert.equal(resolveReminderRemoval("remove all my reminders.", { reminders }).matches.length, 2);
});

test("fast reminder removal verifies storage and never claims a missing deletion", async (t) => {
  const directory = temporaryDirectory(t);
  const configStore = new ConfigStore(directory);
  const registry = new ToolRegistry({
    dataStore: new DataStore(directory),
    configStore,
    mcpManager: { listTools: async () => [], call: async () => null },
    dataDir: directory,
  });
  t.after(() => { for (const timer of registry.personal.timers.values()) clearTimeout(timer); });
  registry.personal.reminders({ operation: "create", text: "End work", at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  const removed = await registry.fastCommand("remove my end work.");
  assert.match(removed.answer, /Removed 1 matching reminder/);
  assert.equal(registry.personal.activeReminders().length, 0);
  const repeated = await registry.fastCommand("remove my end work.");
  assert.match(repeated.answer, /No active reminder matched/);
  assert.doesNotMatch(repeated.answer, /Removed 1/);
  const invalid = await registry.execute("reminders", { operation: "cancel", id: "missing" });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.action.status, "FAILED");
});

test("reminder schedule reconciliation removes conflicts and leaves one start and end", (t) => {
  const directory = temporaryDirectory(t);
  const personal = new PersonalAssistant(directory, (value) => path.resolve(value));
  t.after(() => { for (const timer of personal.timers.values()) clearTimeout(timer); });
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(Date.now() + 5 * 60 * 60 * 1000);
  personal.data.reminders.push(
    { id: "wrong", text: "Start work at 2 PM", at: start.toISOString(), done: false },
    { id: "duplicate", text: "Start work mode", at: start.toISOString(), done: false },
  );
  personal.save();
  const result = JSON.parse(personal.reminders({ operation: "reconcileSchedule", topic: "work", startAt: start.toISOString(), endAt: end.toISOString(), startText: "Start work", endText: "End work" }));
  assert.equal(result.replaced, 2);
  assert.deepEqual(personal.activeReminders().map((item) => item.text), ["Start work", "End work"]);
  const ids = personal.activeReminders().map((item) => item.id);
  const repeated = JSON.parse(personal.reminders({ operation: "reconcileSchedule", topic: "work", startAt: start.toISOString(), endAt: end.toISOString(), startText: "Start work", endText: "End work" }));
  assert.equal(repeated.changed, false);
  assert.deepEqual(personal.activeReminders().map((item) => item.id), ids);
});

test("agent fast path completes clear reminder corrections without calling a model", async (t) => {
  const directory = temporaryDirectory(t);
  const configStore = new ConfigStore(directory);
  const dataStore = new DataStore(directory);
  let modelCalls = 0;
  const runtime = new AgentRuntime({
    configStore,
    dataStore,
    toolRegistry: {
      fastCommand: async () => ({
        answer: "Updated your work reminders: start at 6:00 PM and end at 10:00 PM.",
        tool: { name: "reminders", args: { operation: "reconcileSchedule" }, ok: true, result: "{}" },
      }),
    },
    routineLearner: { record() {} },
    cognitiveCore: null,
    credentials: { openai: () => "", groq: () => "", gemini: () => "" },
  });
  runtime.provider.chat = async () => { modelCalls += 1; throw new Error("The model should not be called."); };
  const result = await runtime.run({ messages: [{ role: "user", content: "edit my reminders. My work is from 6pm to 10pm. I don't have a work at 2pm." }] });
  assert.equal(result.fastPath, true);
  assert.equal(modelCalls, 0);
  assert.match(result.answer, /6:00 PM.*10:00 PM/);
  assert.ok(result.latencyMs < 500);
});
