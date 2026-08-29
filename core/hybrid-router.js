import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ROUTES = Object.freeze({ DIRECT: "DIRECT_COMMAND", TOOL: "LOCAL_TOOL", MEMORY: "LOCAL_MEMORY", LOCAL: "LOCAL_LLM", CODER: "LOCAL_CODER", CLOUD: "CLOUD_LLM", CACHE: "CACHE" });

function atomicJson(file, value) { const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file); }
function terms(value) { return new Set(String(value || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []); }
function similarity(left, right) { const a = terms(left); const b = terms(right); if (!a.size || !b.size) return 0; let common = 0; for (const item of a) if (b.has(item)) common += 1; return common / Math.max(a.size, b.size); }
function dayKey(date = new Date()) { return date.toISOString().slice(0, 10); }
function monthKey(date = new Date()) { return date.toISOString().slice(0, 7); }
export function estimateTokens(value) { return Math.max(1, Math.ceil(String(value || "").length / 4)); }

export class ResponseCache {
  constructor(dataDir, { maxEntries = 500 } = {}) {
    this.file = path.join(dataDir, "response-cache.json"); this.maxEntries = maxEntries;
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.data = { version: 1, entries: [] }; }
  }
  persist() { atomicJson(this.file, this.data); }
  get(query, route, { semantic = true } = {}) {
    const now = Date.now(); const normalized = String(query).trim().toLowerCase();
    this.data.entries = this.data.entries.filter((item) => Date.parse(item.expiresAt) > now);
    let entry = [...this.data.entries].reverse().find((item) => item.query === normalized && item.route === route);
    if (!entry && semantic) entry = [...this.data.entries].reverse().find((item) => item.route === route && similarity(item.query, normalized) >= 0.92);
    if (!entry) return null;
    entry.hits = (entry.hits || 0) + 1; entry.lastHitAt = new Date().toISOString(); this.persist();
    return structuredClone(entry);
  }
  set(query, route, answer, ttlMs, metadata = {}) {
    if (!answer || ttlMs <= 0) return null;
    const normalized = String(query).trim().toLowerCase();
    const entry = { id: crypto.randomUUID(), query: normalized, route, answer: String(answer).slice(0, 24000), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlMs).toISOString(), hits: 0, metadata };
    this.data.entries = this.data.entries.filter((item) => !(item.query === normalized && item.route === route));
    this.data.entries.push(entry); this.data.entries = this.data.entries.slice(-this.maxEntries); this.persist(); return entry;
  }
  stats() { return { entries: this.data.entries.length, hits: this.data.entries.reduce((sum, item) => sum + (item.hits || 0), 0) }; }
  clear() { this.data = { version: 1, entries: [] }; this.persist(); }
}

export class TokenBudgetManager {
  constructor(dataDir, configStore = null) {
    this.file = path.join(dataDir, "ai-usage.json"); this.configStore = configStore;
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.data = { version: 1, days: {}, months: {}, recentRoutes: [] }; }
  }
  persist() { atomicJson(this.file, this.data); }
  bucket(container, key) { return container[key] ||= { routes: {}, providers: {}, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0, cacheHits: 0, cloudEscalations: 0, requests: 0 }; }
  record({ route, provider = "none", promptTokens = 0, completionTokens = 0, estimatedCostUsd = 0, cacheHit = false, escalated = false, latencyMs = 0, intent = "unknown", confidence = 0 }) {
    const apply = (bucket) => {
      bucket.requests += 1; bucket.routes[route] = (bucket.routes[route] || 0) + 1; bucket.providers[provider] ||= { requests: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 };
      const item = bucket.providers[provider]; item.requests += 1; item.promptTokens += Number(promptTokens) || 0; item.completionTokens += Number(completionTokens) || 0; item.estimatedCostUsd += Number(estimatedCostUsd) || 0;
      bucket.promptTokens += Number(promptTokens) || 0; bucket.completionTokens += Number(completionTokens) || 0; bucket.estimatedCostUsd += Number(estimatedCostUsd) || 0; if (cacheHit) bucket.cacheHits += 1; if (escalated) bucket.cloudEscalations += 1;
    };
    apply(this.bucket(this.data.days, dayKey())); apply(this.bucket(this.data.months, monthKey()));
    this.data.recentRoutes.push({ ts: new Date().toISOString(), route, provider, intent, confidence, latencyMs, cacheHit }); this.data.recentRoutes = this.data.recentRoutes.slice(-300); this.persist();
  }
  canUseCloud({ explicit = false } = {}) {
    if (explicit) return { allowed: true, reason: "explicit provider request" };
    const config = this.configStore?.get()?.hybrid || {};
    const day = this.bucket(this.data.days, dayKey()); const month = this.bucket(this.data.months, monthKey());
    const dailyLimit = Number(config.dailyCloudTokenLimit) || 100000; const monthlyLimit = Number(config.monthlyCloudBudgetUsd) || 10;
    const cloudTokens = Object.entries(day.providers).filter(([provider]) => ["groq", "gemini", "openai", "compatible"].includes(provider)).reduce((sum, [, item]) => sum + item.promptTokens + item.completionTokens, 0);
    if (cloudTokens >= dailyLimit) return { allowed: false, reason: "daily cloud token limit reached", cloudTokens, dailyLimit };
    if (month.estimatedCostUsd >= monthlyLimit) return { allowed: false, reason: "monthly cloud budget reached", estimatedCostUsd: month.estimatedCostUsd, monthlyLimit };
    return { allowed: true, reason: "within budget", cloudTokens, dailyLimit };
  }
  snapshot() { return { today: structuredClone(this.bucket(this.data.days, dayKey())), month: structuredClone(this.bucket(this.data.months, monthKey())), budget: this.canUseCloud(), recentRoutes: structuredClone(this.data.recentRoutes.slice(-30).reverse()) }; }
  clear() { this.data = { version: 1, days: {}, months: {}, recentRoutes: [] }; this.persist(); }
}

export class HybridRouter {
  constructor({ configStore, usage, directParser = null } = {}) { this.configStore = configStore; this.usage = usage; this.directParser = directParser; }
  classify(query, { requestedModel = "" } = {}) {
    const text = String(query || "").trim(); const lower = text.toLowerCase();
    const direct = this.directParser?.parse(text); if (direct) return direct;
    // The model stored by the UI is a preference, not an instruction to spend cloud
    // quota. Cloud is explicit only when the user asks for it in this message.
    const providerMatch = text.match(/\b(?:use|ask|with)\s+(gpt|openai|gemini|groq)\b/i);
    const explicitProvider = Boolean(providerMatch);
    const cloudProvider = providerMatch ? ({ gpt: "openai", openai: "openai", gemini: "gemini", groq: "groq" })[providerMatch[1].toLowerCase()] : "";
    const coding = /\b(?:code|coding|program|function|class|repository|repo|debug|stack trace|syntax error|typescript|javascript|python|react|node\.js|sql)\b/i.test(text);
    const internet = /\b(?:latest|today'?s|current news|search the web|online research|internet|live price|weather|forecast)\b/i.test(text);
    const memory = /\b(?:what do you remember|do you remember|recall|what did i say|what (?:is|are) my preferences?|earlier conversation)\b/i.test(text);
    const multiReasoning = (text.match(/\b(?:compare|analyze|evaluate|tradeoff|architecture|strategy|prove|derive|investigate)\b/gi) || []).length;
    const steps = (text.match(/\b(?:and then|after that|first|next|finally|step)\b/gi) || []).length;
    let complexity = coding ? 3 : 2;
    if (multiReasoning >= 2 || steps >= 3) complexity = 4;
    if ((internet && /comprehensive|deep|complex|multiple sources/i.test(text)) || multiReasoning >= 4) complexity = 5;
    if (memory) return { route: ROUTES.MEMORY, intent: "memory_retrieval", complexity: 1, confidence: 0.94, requiresTools: false, requiresInternet: false, cacheable: false };
    if (/\b(?:apps? running|cpu|ram|memory usage|battery|disk|network|active window|system status)\b/i.test(text)) return { route: ROUTES.TOOL, intent: "local_system_query", complexity: 1, confidence: 0.91, requiresTools: true, requiresInternet: false, cacheTtlMs: 5000 };
    if (coding) return { route: ROUTES.CODER, intent: "coding", complexity, confidence: 0.9, requiresTools: /\b(?:this project|repo|file|run|fix|change)\b/i.test(text), requiresInternet: internet, cacheable: false };
    if (explicitProvider || complexity === 5) return { route: ROUTES.CLOUD, intent: internet ? "complex_research" : "complex_reasoning", complexity, confidence: explicitProvider ? 0.99 : 0.82, requiresTools: internet, requiresInternet: internet, explicitCloud: explicitProvider, cloudProvider, cacheTtlMs: internet ? 5 * 60 * 1000 : 6 * 60 * 60 * 1000 };
    return { route: ROUTES.LOCAL, intent: internet ? "internet_assisted" : "conversation", complexity, confidence: 0.9, requiresTools: internet, requiresInternet: internet, cacheTtlMs: internet ? 5 * 60 * 1000 : 6 * 60 * 60 * 1000 };
  }
  chooseModel(decision, requestedModel = "") {
    const config = this.configStore.get(); const hybrid = config.hybrid || {}; const llm = config.llm || {};
    if (decision.route === ROUTES.CLOUD) {
      const budget = this.usage?.canUseCloud({ explicit: decision.explicitCloud }) || { allowed: true };
      const targets = { groq: `groq:${llm.groqModel}`, gemini: `gemini:${llm.geminiModel}`, openai: llm.openaiModel || "gpt-5.6-luna" };
      const preferredProvider = decision.cloudProvider || hybrid.cloudFallbackOrder?.[0] || "groq";
      const cloudModel = requestedModel && /^(?:groq:|gemini:|gpt-|openai-compatible:)/.test(requestedModel) ? requestedModel : targets[preferredProvider] || targets.groq;
      if (budget.allowed) return { model: cloudModel, route: ROUTES.CLOUD, budget };
      return { model: `ollama:${llm.localReasoningModel || llm.localGeneralModel || llm.localFallbackModel}`, route: decision.intent === "coding" ? ROUTES.CODER : ROUTES.LOCAL, budget, downgraded: true };
    }
    if (decision.route === ROUTES.CODER) return { model: `ollama:${llm.localCoderModel || llm.localGeneralModel || llm.localFallbackModel}`, route: ROUTES.CODER };
    return { model: `ollama:${llm.localGeneralModel || llm.localFallbackModel}`, route: decision.route };
  }
}
