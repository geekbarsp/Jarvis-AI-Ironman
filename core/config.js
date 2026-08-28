import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  llm: {
    provider: "groq",
    baseUrl: "http://127.0.0.1:11434",
    apiKey: "",
    chatModel: "groq:openai/gpt-oss-120b",
    fastModel: "groq:openai/gpt-oss-20b",
    embeddingModel: "nomic-embed-text",
    temperature: 0.45,
    contextSize: 8192,
    providerFallback: true,
    groqModel: "openai/gpt-oss-120b",
    geminiModel: "gemini-3.6-flash",
  },
  assistant: {
    name: "JARVIS",
    wakeAliases: ["wake up jarvis", "jarvis", "jarves", "jarviss", "service"],
    stopCommands: ["stop", "cancel", "quiet", "never mind", "nevermind"],
    timezone: "Asia/Manila",
    location: "Manila, Philippines",
    plannerEnabled: true,
    evaluatorEnabled: true,
    memoryDigestEnabled: true,
    routineLearningEnabled: true,
    toolResultDigestEnabled: true,
    toolSelectionStrategy: "llm",
    maxAgentTurns: 7,
    maxConsecutiveFailures: 3,
    maxToolRetries: 2,
    agentTimeoutMs: 120000,
  },
  dictation: {
    enabled: true,
    hotkey: "CommandOrControl+Alt+D",
    removeFillers: false,
    customDictionary: [],
    historyLimit: 200,
  },
  speechRecognition: {
    whisperModel: "base.en",
    device: "cpu",
    minConfidence: 0.18,
    noSpeechThreshold: 0.7,
  },
  workspaceMemory: {
    restoreTimeoutMs: 12000,
    excludedProcesses: ["TabTip", "NVIDIA Overlay"],
    excludedWindowClasses: ["CEF-OSC-WIDGET", "ShellHandwritingCanvas"],
  },
  permissions: {
    mode: "standard",
  },
  tools: {
    braveApiKey: "",
    allowedRoots: [
      path.join(os.homedir(), "Desktop"),
      path.join(os.homedir(), "Documents"),
      path.join(os.homedir(), "Downloads"),
    ],
  },
  mcpServers: {},
});

function merge(base, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(base);
  const output = structuredClone(base);
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === "object" && !Array.isArray(item) && output[key] && typeof output[key] === "object") {
      output[key] = merge(output[key], item);
    } else {
      output[key] = item;
    }
  }
  return output;
}

export class ConfigStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.path = path.join(dataDir, "config.json");
    this.value = this.load();
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.path)) {
      const initial = structuredClone(DEFAULT_CONFIG);
      this.write(initial);
      return initial;
    }
    try {
      return merge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(this.path, "utf8")));
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  get() {
    return structuredClone(this.value);
  }

  update(patch) {
    this.value = merge(this.value, patch);
    this.write(this.value);
    return this.get();
  }

  write(value) {
    const temporary = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.path);
  }
}
