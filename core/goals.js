import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./storage.js";

const STATUSES = new Set(["pending", "active", "blocked", "completed", "failed", "cancelled"]);
const TRANSITIONS = {
  pending: new Set(["active", "cancelled"]),
  active: new Set(["blocked", "completed", "failed", "cancelled"]),
  blocked: new Set(["active", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(["active"]),
  cancelled: new Set(["active"]),
};

function read(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return { version: 1, goals: Array.isArray(value.goals) ? value.goals : [] };
  } catch { return { version: 1, goals: [] }; }
}

function write(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export class GoalManager {
  constructor(dataDir, eventBus) {
    this.file = path.join(dataDir, "cognitive-goals.json");
    this.eventBus = eventBus;
    this.data = read(this.file);
  }

  persist() { write(this.file, this.data); }

  create(description, { priority = "normal", completionCriteria = "The user request is fulfilled and important actions are verified.", parentGoalId = null } = {}) {
    const now = new Date().toISOString();
    const goal = {
      id: crypto.randomUUID(),
      description: redact(description).slice(0, 2000),
      priority,
      status: "active",
      completionCriteria: redact(completionCriteria).slice(0, 1000),
      parentGoalId,
      dependencies: [],
      subgoals: [],
      plan: [],
      createdAt: now,
      updatedAt: now,
    };
    this.data.goals.push(goal);
    this.data.goals = this.data.goals.slice(-500);
    this.persist();
    this.eventBus?.publish("GOAL_CREATED", { goalId: goal.id, description: goal.description, priority });
    return structuredClone(goal);
  }

  get(id) { return this.data.goals.find((goal) => goal.id === id) || null; }

  setPlan(id, steps) {
    const goal = this.get(id);
    if (!goal) throw new Error(`Unknown goal: ${id}`);
    const plan = steps.slice(0, 20).map((step, index) => ({
      id: step.id || `${id}:${index + 1}`,
      action: redact(typeof step === "string" ? step : step.action).slice(0, 1000),
      status: step.status || "pending",
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : index ? [`${id}:${index}`] : [],
      expectedResult: redact(step.expectedResult || "Action completes without an error.").slice(0, 500),
    }));
    goal.plan = plan;
    goal.subgoals = goal.plan.map((step) => step.id);
    goal.updatedAt = new Date().toISOString();
    this.persist();
    this.eventBus?.publish("PLAN_CREATED", { goalId: id, steps: goal.plan });
    return structuredClone(goal.plan);
  }

  markStep(id, index, status, observation = "") {
    const goal = this.get(id);
    const step = goal?.plan?.[index];
    if (!step) return null;
    step.status = status;
    step.observation = redact(observation).slice(0, 1500);
    step.updatedAt = new Date().toISOString();
    goal.updatedAt = step.updatedAt;
    this.persist();
    return structuredClone(step);
  }

  transition(id, status, reason = "") {
    if (!STATUSES.has(status)) throw new Error(`Invalid goal status: ${status}`);
    const goal = this.get(id);
    if (!goal) throw new Error(`Unknown goal: ${id}`);
    if (goal.status !== status && !TRANSITIONS[goal.status]?.has(status)) throw new Error(`Cannot move goal from ${goal.status} to ${status}.`);
    goal.status = status;
    goal.reason = redact(reason).slice(0, 1000);
    goal.updatedAt = new Date().toISOString();
    this.persist();
    this.eventBus?.publish(`GOAL_${status.toUpperCase()}`, { goalId: id, reason: goal.reason });
    return structuredClone(goal);
  }

  revisePlan(id, steps, reason) {
    const plan = this.setPlan(id, steps);
    this.eventBus?.publish("PLAN_REVISED", { goalId: id, reason: redact(reason).slice(0, 1000) });
    return plan;
  }

  active() { return structuredClone(this.data.goals.filter((goal) => ["active", "blocked"].includes(goal.status))); }
  list(limit = 50) { return structuredClone(this.data.goals.slice(-limit)); }
  recoverInterrupted() {
    let changed = false;
    for (const goal of this.data.goals.filter((item) => item.status === "active")) {
      goal.status = "blocked";
      goal.reason = "Execution was interrupted when JARVIS stopped or restarted.";
      goal.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) this.persist();
  }
  clear() { this.data = { version: 1, goals: [] }; this.persist(); }
}
