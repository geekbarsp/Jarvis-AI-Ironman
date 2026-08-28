import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CognitiveCore, WorkingMemory } from "../core/cognitive-core.js";
import { CognitiveEventBus } from "../core/event-bus.js";
import { CognitiveMemory } from "../core/cognitive-memory.js";
import { GoalManager } from "../core/goals.js";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cognitive-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("working memory expires completed and stale task context", () => {
  const memory = new WorkingMemory({ ttlMs: 20, maxActions: 2 });
  const task = memory.begin("Fix the project", "goal-1", { activeApplication: "Code" });
  memory.recordAction(task.id, { name: "inspect", ok: true, result: "found it" });
  memory.recordAction(task.id, { name: "edit", ok: true, result: "changed" });
  memory.recordAction(task.id, { name: "test", ok: true, result: "passed" });
  assert.equal(memory.get(task.id).actions.length, 2);
  memory.cleanup(Date.now() + 100);
  assert.equal(memory.get(task.id), null);
});

test("goals persist subgoals, dependencies, completion, and plan revision", (t) => {
  const directory = temporaryDirectory(t);
  const goals = new GoalManager(directory);
  const goal = goals.create("Repair login", { priority: "high" });
  const first = goals.setPlan(goal.id, ["Inspect error", "Update authentication", "Run tests"]);
  assert.equal(first.length, 3);
  assert.deepEqual(first[1].dependsOn, [first[0].id]);
  goals.markStep(goal.id, 0, "completed", "Error reproduced");
  const revised = goals.revisePlan(goal.id, ["Inspect middleware", "Run tests"], "The first observation changed the plan.");
  assert.equal(revised.length, 2);
  goals.transition(goal.id, "completed", "Tests passed");
  const restored = new GoalManager(directory).get(goal.id);
  assert.equal(restored.status, "completed");
  assert.equal(restored.plan[0].action, "Inspect middleware");
});

test("episodic and procedural memory persist, retrieve selectively, and track confidence", (t) => {
  const directory = temporaryDirectory(t);
  const memory = new CognitiveMemory(directory);
  memory.recordEpisode({
    goal: "Fix Next.js authentication build",
    context: { activeApplication: "Code", activeProject: "Portal" },
    actions: [{ name: "inspect", ok: true }, { name: "build", ok: true }],
    result: "Authentication build passed",
    success: true,
    lesson: "Verify middleware imports before rebuilding.",
  });
  memory.learnProcedure("Deploy Portal", ["Run tests", "Build project", "Verify deployment"], true);
  const procedure = memory.learnProcedure("Deploy Portal", ["Run tests", "Build project", "Verify deployment"], true);
  assert.equal(procedure.uses, 2);
  assert.equal(procedure.successRate, 1);
  assert.ok(procedure.confidence > 0.7);
  assert.match(memory.context("authentication build"), /observed episode/);
  const restored = new CognitiveMemory(directory);
  assert.equal(restored.snapshot().episodes.length, 1);
  assert.equal(restored.snapshot().procedures[0].uses, 2);
});

test("cognitive core observes, plans, verifies actions, reflects, and completes", async (t) => {
  const directory = temporaryDirectory(t);
  const environment = { snapshot: async () => ({ source: "system_api", activeApplication: "Code", activeWindow: "Jarvis", runningApps: ["Code"] }) };
  const core = new CognitiveCore(directory, { environment });
  const state = await core.begin("Inspect and fix the build");
  core.applyPlan(["Inspect build", "Run verification"], state.taskId);
  const reflection = core.recordTool("developerTools", { operation: "gitStatus" }, { text: "Tool error: build failed", isError: true }, state.taskId);
  assert.equal(reflection.success, false);
  assert.match(reflection.nextRecommendedAction, /revise/i);
  assert.equal(core.state(state.taskId).failures, 1);
  core.recordTool("developerTools", { operation: "gitStatus" }, { text: "Build passed" }, state.taskId);
  core.finish("Fixed and verified.", [{ name: "inspect", ok: true }, { name: "build", ok: true }], { taskId: state.taskId, success: true });
  const snapshot = core.snapshot();
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.goals.at(-1).status, "completed");
  assert.equal(snapshot.memories.episodes.at(-1).success, true);
  assert.equal(snapshot.memories.procedures.length, 1);
});

test("new commands cancel older work and explicit cancellation aborts the task", async (t) => {
  const directory = temporaryDirectory(t);
  const environment = { snapshot: async () => ({ source: "system_api", runningApps: [] }) };
  const core = new CognitiveCore(directory, { environment });
  const first = await core.begin("Old goal");
  const firstSignal = core.signal();
  const second = await core.begin("Do this first");
  assert.equal(firstSignal.aborted, true);
  assert.equal(core.goals.get(first.goalId).status, "cancelled");
  const secondSignal = core.signal();
  assert.equal(core.cancel("Jarvis stop"), true);
  assert.equal(secondSignal.aborted, true);
  assert.equal(core.goals.get(second.goalId).status, "cancelled");
});

test("interrupted persistent goals become blocked and can be resumed after restart", async (t) => {
  const directory = temporaryDirectory(t);
  const environment = { snapshot: async () => ({ source: "system_api", activeApplication: "Code", runningApps: ["Code"] }) };
  const firstCore = new CognitiveCore(directory, { environment });
  const original = await firstCore.begin("Continue this work after restart");
  const restartedCore = new CognitiveCore(directory, { environment });
  assert.equal(restartedCore.goals.get(original.goalId).status, "blocked");
  assert.equal(await restartedCore.resume(original.goalId), true);
  assert.equal(restartedCore.state().goal.status, "active");
  restartedCore.cancel();
});

test("cognitive event logs redact secrets and expose bounded structured summaries", (t) => {
  const directory = temporaryDirectory(t);
  const events = new CognitiveEventBus(directory, 2);
  events.publish("ACTION_STARTED", { token: "hidden", detail: "password=do-not-store" });
  events.publish("ACTION_COMPLETED", { ok: true });
  events.publish("TASK_FINISHED", { apiKey: "hidden", result: "done" });
  assert.equal(events.recent(10).length, 2);
  const disk = fs.readFileSync(path.join(directory, "cognitive-events.jsonl"), "utf8");
  assert.doesNotMatch(disk, /do-not-store|hidden/);
  assert.match(disk, /REDACTED/);
});
