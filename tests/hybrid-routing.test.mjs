import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApplicationIndex, DirectCommandParser } from "../core/command-router.js";
import { HybridRouter, ResponseCache, ROUTES, TokenBudgetManager } from "../core/hybrid-router.js";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-hybrid-"));
  const config = {
    llm: { chatModel: "groq:openai/gpt-oss-20b", groqModel: "openai/gpt-oss-20b", geminiModel: "gemini-3.7-flash", openaiModel: "gpt-5.6-luna", localGeneralModel: "gemma3:4b", localCoderModel: "qwen2.5-coder:7b", localFallbackModel: "gemma3:4b" },
    hybrid: { dailyCloudTokenLimit: 1000, monthlyCloudBudgetUsd: 5 },
  };
  const configStore = { get: () => config };
  const apps = new ApplicationIndex(dataDir);
  apps.data.applications = [
    { name: "Spotify", command: "shell:AppsFolder\\Spotify", source: "test" },
    { name: "Visual Studio Code", command: "code", source: "test" },
  ];
  return { dataDir, configStore, apps };
}

test("deterministic commands route locally without an LLM", () => {
  const { apps } = fixture();
  const parser = new DirectCommandParser(apps);
  assert.deepEqual(parser.parse("Open Spotify").arguments, { operation: "open", target: "shell:AppsFolder\\Spotify" });
  assert.deepEqual(parser.parse("set volume to 50%").arguments, { action: "volumeSet", value: 50 });
  assert.equal(parser.parse("what is my CPU usage?").tool, "getSystemContext");
  assert.equal(parser.parse("take a screenshot").tool, "screenshot");
  assert.equal(parser.parse("lock my computer").tool, "systemControl");
});

test("application aliases persist and are resolved before execution", () => {
  const { dataDir, apps } = fixture();
  apps.setAlias("music", "Spotify");
  const reloaded = new ApplicationIndex(dataDir);
  reloaded.data.applications = apps.data.applications;
  assert.equal(reloaded.resolve("music").command, "shell:AppsFolder\\Spotify");
});

test("router is local first, uses a coder locally, and reserves cloud for complexity", () => {
  const { dataDir, configStore, apps } = fixture();
  const usage = new TokenBudgetManager(dataDir, configStore);
  const router = new HybridRouter({ configStore, usage, directParser: new DirectCommandParser(apps) });
  assert.equal(router.classify("Hello, how are you?", { requestedModel: "groq:openai/gpt-oss-20b" }).route, ROUTES.LOCAL);
  assert.equal(router.classify("Write a JavaScript function for sorting").route, ROUTES.CODER);
  assert.equal(router.classify("Search the web for today's weather").route, ROUTES.LOCAL);
  const complex = router.classify("Compare, analyze, evaluate, and prove a comprehensive strategy using multiple sources");
  assert.equal(complex.route, ROUTES.CLOUD);
  assert.equal(router.chooseModel(complex, "ollama:gemma3:4b").model, "groq:openai/gpt-oss-20b");
  assert.equal(router.chooseModel(router.classify("Hello"), "groq:openai/gpt-oss-20b").model, "ollama:gemma3:4b");
});

test("exact and semantic response caching avoids repeated provider work", () => {
  const { dataDir } = fixture();
  const cache = new ResponseCache(dataDir);
  cache.set("Explain local routing architecture", ROUTES.LOCAL, "Local answer", 60000);
  assert.equal(cache.get("Explain local routing architecture", ROUTES.LOCAL).answer, "Local answer");
  assert.equal(cache.get("Local routing architecture: explain", ROUTES.LOCAL).answer, "Local answer");
  assert.equal(cache.stats().hits, 2);
});
