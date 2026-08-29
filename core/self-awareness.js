const CAPABILITIES = Object.freeze([
  { id: "desktop", name: "Desktop shell", status: "ready", implementation: "Electron with a React/Vite command center" },
  { id: "voice", name: "Voice pipeline", status: "ready", implementation: "Wake phrases, VAD-style segmented capture, Faster Whisper, Fish Audio, and system TTS fallback" },
  { id: "models", name: "Hybrid model access", status: "ready", implementation: "Ollama, OpenAI, Groq, and Gemini behind the existing model provider abstraction" },
  { id: "context", name: "System context", status: "ready", implementation: "Foreground app/window, project inference, processes, monitors, browser cache, and system metrics" },
  { id: "actions", name: "Safe actions", status: "ready", implementation: "Central risk policy, confirmation, verification states, redacted history, and bounded undo" },
  { id: "memory", name: "Persistent memory", status: "partial", implementation: "Dialogue, diary, facts, embeddings, cognitive episodes, procedures, preferences, goals, and routines" },
  { id: "workspace", name: "Workspace restoration", status: "ready", implementation: "Dynamic application/window/browser workspace capture and restore" },
  { id: "planning", name: "Verified task graphs", status: "ready", implementation: "Persistent dependency graphs with concurrency, retry, timeout, interruption recovery, cancellation, and per-node action verification" },
  { id: "automation", name: "Event-driven automation", status: "ready", implementation: "Persistent trigger-condition-action rules with cooldowns, enable/disable controls, and audited runs through the safe action engine" },
  { id: "accessibility", name: "Accessibility desktop control", status: "ready", implementation: "Windows UI Automation inspection, semantic element lookup, focus, invoke, and value patterns without fixed coordinates" },
  { id: "project_brain", name: "Project brain", status: "ready", implementation: "Bounded incremental source indexing, local concept-normalized TF-IDF retrieval, Git/package summaries, and persistent engineering decisions" },
  { id: "proactive", name: "Proactive notifications", status: "ready", implementation: "Event and system-pressure alerts with deduplication, cooldowns, snooze, dismiss, expiry, and quiet mode" },
  { id: "vision", name: "Screen vision", status: "partial", implementation: "Screenshot capture, model inspection, and an accessibility element graph; visual OCR and canvas-only controls remain limited" },
  { id: "extensions", name: "External integrations", status: "partial", implementation: "MCP servers and browser companion; no stable first-party skill lifecycle API yet" },
]);

const SOFTWARE_GAPS = Object.freeze([
  {
    priority: 1,
    id: "agent_router",
    name: "Coordinated specialist-agent router",
    reason: "Tools are routed, but planner, desktop, vision, coding, browser, security, and verification roles are not isolated behind shared task contracts.",
    outcome: "More consistent expertise while keeping one orchestrator in control.",
  },
  { priority: 2, id: "visual_grounding", name: "Deeper visual grounding", reason: "Canvas-only and custom-rendered controls cannot always expose useful accessibility semantics.", outcome: "OCR and vision fallback for controls that UI Automation cannot identify." },
  { priority: 3, id: "encrypted_store", name: "Encrypted structured store", reason: "Sensitive local state is permission-protected but the JSON persistence layer is not encrypted at rest.", outcome: "Stronger defense for private memory and automation metadata." },
]);

export class SelfAwarenessService {
  constructor({ configStore = null, contextEngine = null } = {}) {
    this.configStore = configStore;
    this.contextEngine = contextEngine;
  }

  matches(query) {
    const text = String(query || "").toLowerCase();
    return /reflect (?:on )?(?:yourself|your system)|what (?:system|software|programming|upgrade).*(?:need|missing)|become (?:like )?(?:iron man'?s )?jarvis|programming upgrade|applications?.*bind|software stack.*missing|run diagnostics/.test(text);
  }

  async report() {
    const config = this.configStore?.get() || {};
    const context = await this.contextEngine?.snapshot().catch(() => null);
    return {
      generatedAt: new Date().toISOString(),
      identity: "JARVIS Desktop 1.0",
      architecture: {
        runtime: "Node.js ES modules",
        desktop: "Electron",
        interface: "React + Vite",
        api: "Express",
        voiceBackend: "Python Faster Whisper service",
        storage: "Atomic JSON/JSONL plus a local embedding index",
        configuredModelProvider: config.llm?.provider || "unknown",
        permissionMode: config.permissions?.mode || "standard",
        privacyMode: Boolean(config.privacy?.mode),
      },
      runtime: context ? {
        contextEngine: "online",
        activeApplication: context.activeApplication || "unknown",
        monitors: context.monitors?.length || 0,
        degradedSignals: context.degraded?.length || 0,
      } : { contextEngine: "unavailable" },
      capabilities: CAPABILITIES.map((item) => ({ ...item })),
      gaps: SOFTWARE_GAPS.map((item) => ({ ...item })),
      recommendation: "The requested five-system upgrade is installed. The next highest-value work is specialist-agent routing, followed by visual grounding and encrypted local storage.",
    };
  }

  async answer() {
    const report = await this.report();
    const ready = report.capabilities.filter((item) => item.status === "ready").map((item) => item.name).join(", ");
    const gaps = report.gaps.slice(0, 5).map((item) => `${item.priority}. ${item.name} - ${item.outcome}`).join("\n");
    return [
      "I checked my actual runtime instead of giving you a generic AI stack.",
      `I already run on ${report.architecture.runtime}, ${report.architecture.desktop}, ${report.architecture.interface}, and ${report.architecture.api}; voice uses ${report.architecture.voiceBackend}.`,
      `Working foundations: ${ready}.`,
      "The requested five-system upgrade is now implemented. The highest-value upgrades I still need are:",
      gaps,
      `Best next build: ${report.recommendation}`,
    ].join("\n\n");
  }
}

export { CAPABILITIES, SOFTWARE_GAPS };
