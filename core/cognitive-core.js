import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CognitiveEventBus } from "./event-bus.js";
import { CognitiveMemory } from "./cognitive-memory.js";
import { GoalManager } from "./goals.js";
import { redact } from "./storage.js";

const execFileAsync = promisify(execFile);

export class WorkingMemory {
  constructor({ ttlMs = 30 * 60 * 1000, maxActions = 30 } = {}) {
    this.ttlMs = ttlMs;
    this.maxActions = maxActions;
    this.tasks = new Map();
  }

  begin(request, goalId, environment = {}) {
    this.cleanup();
    const id = crypto.randomUUID();
    const now = Date.now();
    const task = {
      id,
      request: redact(request).slice(0, 4000),
      intent: "pending interpretation",
      goalId,
      plan: [],
      actions: [],
      observations: [],
      entities: [],
      unresolved: [],
      environment,
      state: "active",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: now + this.ttlMs,
    };
    this.tasks.set(id, task);
    return structuredClone(task);
  }

  patch(id, value) {
    const task = this.tasks.get(id);
    if (!task) return null;
    Object.assign(task, value, { updatedAt: new Date().toISOString(), expiresAt: Date.now() + this.ttlMs });
    return structuredClone(task);
  }

  recordAction(id, action) {
    const task = this.tasks.get(id);
    if (!task) return null;
    task.actions.push({ ...action, result: redact(action.result).slice(0, 2500), ts: new Date().toISOString() });
    task.actions = task.actions.slice(-this.maxActions);
    if (!action.ok) task.unresolved.push(redact(action.result).slice(0, 500));
    task.unresolved = task.unresolved.slice(-10);
    return this.patch(id, {});
  }

  resolve(id, state = "completed") { return this.patch(id, { state, expiresAt: Date.now() + 5 * 60 * 1000 }); }

  cleanup(now = Date.now()) {
    for (const [id, task] of this.tasks) if (task.expiresAt <= now) this.tasks.delete(id);
  }

  get(id) { this.cleanup(); return this.tasks.has(id) ? structuredClone(this.tasks.get(id)) : null; }
  snapshot() { this.cleanup(); return [...this.tasks.values()].map((item) => structuredClone(item)); }
}

export class EnvironmentObserver {
  constructor({ cacheMs = 5000 } = {}) {
    this.cacheMs = cacheMs;
    this.cached = null;
    this.cachedAt = 0;
  }

  async snapshot(force = false) {
    if (!force && this.cached && Date.now() - this.cachedAt < this.cacheMs) return structuredClone(this.cached);
    let value = { platform: process.platform, observedAt: new Date().toISOString(), activeApplication: "", activeWindow: "", runningApps: [], source: "system_api" };
    if (process.platform === "win32") {
      const script = String.raw`$ErrorActionPreference='Stop'; Add-Type @'
using System; using System.Runtime.InteropServices;
public static class JarvisForeground { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id); }
'@; $h=[JarvisForeground]::GetForegroundWindow(); [uint32]$id=0; [void][JarvisForeground]::GetWindowThreadProcessId($h,[ref]$id); $active=Get-Process -Id $id -ErrorAction SilentlyContinue; $apps=Get-Process | Where-Object {$_.MainWindowTitle} | Sort-Object ProcessName -Unique | Select-Object -First 40 ProcessName,MainWindowTitle; [pscustomobject]@{activeApplication=$active.ProcessName;activeWindow=$active.MainWindowTitle;runningApps=@($apps | ForEach-Object {$_.ProcessName})} | ConvertTo-Json -Compress`;
      try {
        const encoded = Buffer.from(script, "utf16le").toString("base64");
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 3500, maxBuffer: 1024 * 1024 });
        value = { ...value, ...JSON.parse(stdout.trim()) };
      } catch (error) {
        value.error = String(error?.message || error).slice(0, 300);
      }
    }
    value.runningApps = [...new Set((value.runningApps || []).map(String))].slice(0, 40);
    this.cached = value;
    this.cachedAt = Date.now();
    return structuredClone(value);
  }
}

function conciseReflection(expected, observed, success) {
  return {
    expectedResult: expected || "Action completes without an error.",
    observedResult: redact(observed).slice(0, 1500),
    success,
    newInformation: success ? [] : ["The action returned an error and the current plan may need revision."],
    nextRecommendedAction: success ? "Continue to the next incomplete plan step." : "Inspect the error, retry only if recoverable, otherwise revise the plan.",
  };
}

export class CognitiveCore {
  constructor(dataDir, { workingMemory, environment, eventBus } = {}) {
    this.events = eventBus || new CognitiveEventBus(dataDir);
    this.workingMemory = workingMemory || new WorkingMemory();
    this.environment = environment || new EnvironmentObserver();
    this.goals = new GoalManager(dataDir, this.events);
    this.goals.recoverInterrupted();
    this.memory = new CognitiveMemory(dataDir, this.events);
    this.activeTask = null;
  }

  async begin(request, { observe = true } = {}) {
    if (this.activeTask) this.cancel("Replaced by a newer user command.");
    const goal = this.goals.create(request);
    const environment = observe
      ? await this.environment.snapshot()
      : { platform: process.platform, observedAt: new Date().toISOString(), activeApplication: "", activeWindow: "", runningApps: [], source: "deferred_for_fast_response" };
    const working = this.workingMemory.begin(request, goal.id, environment);
    this.activeTask = { taskId: working.id, goalId: goal.id, failures: 0, startedAt: Date.now(), controller: new AbortController() };
    this.events.publish("USER_COMMAND", { taskId: working.id, request });
    this.events.publish("ENVIRONMENT_OBSERVED", { taskId: working.id, activeApplication: environment.activeApplication, activeWindow: environment.activeWindow, runningApps: environment.runningApps });
    return this.state();
  }

  applyPlan(steps, taskId = this.activeTask?.taskId) {
    if (!this.activeTask || this.activeTask.taskId !== taskId) return [];
    const plan = this.goals.setPlan(this.activeTask.goalId, steps.map((action) => ({ action })));
    this.workingMemory.patch(this.activeTask.taskId, { plan, intent: steps.length ? "multi-step task" : "direct response" });
    return plan;
  }

  recordTool(name, args, result, taskId = this.activeTask?.taskId) {
    if (!this.activeTask || this.activeTask.taskId !== taskId) return null;
    const goal = this.goals.get(this.activeTask.goalId);
    const index = Math.min(this.workingMemory.get(this.activeTask.taskId)?.actions.length || 0, Math.max(0, (goal?.plan?.length || 1) - 1));
    const expected = goal?.plan?.[index]?.expectedResult || `${name} completes without an error.`;
    const ok = !result.isError;
    const observed = String(result.text || JSON.stringify(result));
    const reflection = conciseReflection(expected, observed, ok);
    this.workingMemory.recordAction(this.activeTask.taskId, { name, args, ok, result: observed, reflection });
    if (goal?.plan?.length) this.goals.markStep(goal.id, index, ok ? "completed" : "failed", observed);
    this.activeTask.failures = ok ? 0 : this.activeTask.failures + 1;
    this.events.publish(ok ? "ACTION_COMPLETED" : "ACTION_FAILED", { goalId: goal?.id, tool: name, verification: { verified: true, ok }, reflection });
    this.events.publish("REFLECTION_CREATED", { goalId: goal?.id, tool: name, reflection });
    return reflection;
  }

  relevantMemory(query) { return this.memory.context(query); }

  finish(answer, actions = [], { success = true, taskId = this.activeTask?.taskId } = {}) {
    if (!this.activeTask || this.activeTask.taskId !== taskId) return null;
    const active = this.activeTask;
    const task = this.workingMemory.get(active.taskId);
    const goal = this.goals.get(active.goalId);
    const finalSuccess = success && !active.controller.signal.aborted;
    if (goal) this.goals.transition(goal.id, finalSuccess ? "completed" : active.controller.signal.aborted ? "cancelled" : "failed", answer);
    this.workingMemory.resolve(active.taskId, finalSuccess ? "completed" : "failed");
    const meaningful = actions.length > 0 || (task?.plan?.length || 0) > 1 || !finalSuccess;
    this.memory.recordEpisode({ goal: goal?.description || task?.request, context: task?.environment, actions, result: answer, success: finalSuccess, lesson: meaningful ? finalSuccess ? "The verified action sequence completed the goal." : "Review the failed action and revise before retrying." : "" });
    if (actions.length > 1) this.memory.learnProcedure(goal?.description || "Task procedure", actions, finalSuccess);
    this.events.publish("TASK_FINISHED", { goalId: active.goalId, success: finalSuccess, durationMs: Date.now() - active.startedAt });
    this.activeTask = null;
    return { success: finalSuccess };
  }

  pause(reason = "Paused by user.") {
    if (!this.activeTask) return false;
    this.goals.transition(this.activeTask.goalId, "blocked", reason);
    this.workingMemory.patch(this.activeTask.taskId, { state: "paused" });
    this.events.publish("TASK_PAUSED", { goalId: this.activeTask.goalId, reason });
    return true;
  }

  async resume(goalId) {
    if (this.activeTask) {
      this.goals.transition(this.activeTask.goalId, "active", "Resumed by user.");
      this.workingMemory.patch(this.activeTask.taskId, { state: "active" });
      this.events.publish("TASK_RESUMED", { goalId: this.activeTask.goalId });
      return true;
    }
    const goal = goalId ? this.goals.get(goalId) : this.goals.active().filter((item) => item.status === "blocked").at(-1);
    if (!goal || goal.status !== "blocked") return false;
    const environment = await this.environment.snapshot(true);
    const working = this.workingMemory.begin(goal.description, goal.id, environment);
    this.workingMemory.patch(working.id, { plan: goal.plan || [], intent: "resumed task" });
    this.activeTask = { taskId: working.id, goalId: goal.id, failures: 0, startedAt: Date.now(), controller: new AbortController() };
    this.goals.transition(goal.id, "active", "Resumed by user after interruption.");
    this.events.publish("TASK_RESUMED", { goalId: goal.id, recovered: true });
    return true;
  }

  cancel(reason = "Cancelled by user.") {
    if (!this.activeTask) return false;
    const active = this.activeTask;
    active.controller.abort(reason);
    const goal = this.goals.get(active.goalId);
    if (goal && ["active", "blocked"].includes(goal.status)) this.goals.transition(goal.id, "cancelled", reason);
    this.workingMemory.resolve(active.taskId, "cancelled");
    this.events.publish("TASK_CANCELLED", { goalId: active.goalId, reason });
    this.activeTask = null;
    return true;
  }

  signal() { return this.activeTask?.controller.signal; }
  state(taskId = this.activeTask?.taskId) {
    if (!this.activeTask || this.activeTask.taskId !== taskId) return null;
    return { ...this.activeTask, controller: undefined, workingMemory: this.workingMemory.get(this.activeTask.taskId), goal: this.goals.get(this.activeTask.goalId) };
  }

  snapshot() {
    const active = this.state();
    return {
      active: active ? { taskId: active.taskId, failures: active.failures, startedAt: active.startedAt, goal: active.goal, workingMemory: active.workingMemory } : null,
      goals: this.goals.list(25),
      memories: this.memory.snapshot(),
      events: this.events.recent(50),
    };
  }

  clear() {
    this.cancel("Memory cleared by user.");
    this.workingMemory.tasks.clear();
    this.goals.clear();
    this.memory.clear();
    this.events.clear();
  }
}
