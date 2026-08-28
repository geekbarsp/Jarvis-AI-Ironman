import express from "express";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import OpenAI, { toFile } from "openai";
import { AgentRuntime } from "./core/agent.js";
import { ConfigStore } from "./core/config.js";
import { MCPManager } from "./core/mcp.js";
import { RoutineLearner } from "./core/routines.js";
import { DataStore } from "./core/storage.js";
import { ToolRegistry } from "./core/tools.js";
import { BrowserWorkspaceBridge } from "./core/browser-bridge.js";
import { CognitiveCore } from "./core/cognitive-core.js";
import { normalizeSpeechText } from "./core/speech.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.JARVIS_DATA_DIR || process.env.JERVIS_DATA_DIR || __dirname;
const KEY_PATH = path.join(DATA_DIR, "api.txt");
const FISH_AUDIO_KEY_PATH = path.join(DATA_DIR, "fish-api.txt");
const GROQ_KEY_PATH = path.join(DATA_DIR, "groq-api.txt");
const GEMINI_KEY_PATH = path.join(DATA_DIR, "gemini-api.txt");
const FISH_AUDIO_VOICE_ID = process.env.FISH_AUDIO_VOICE_ID || "f22f684f44d74c4a86d72d95c296ba26";
const FISH_AUDIO_MODEL = process.env.FISH_AUDIO_MODEL || "s2.1-pro-free";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const LOCAL_MODEL = process.env.OLLAMA_MODEL || "gemma3:4b";
const WHISPER_SCRIPT = path.join(__dirname, "backend", "whisper_service.py");
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const ALLOWED_MODELS = new Set([
  `ollama:${LOCAL_MODEL}`,
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "groq:openai/gpt-oss-120b",
  "groq:openai/gpt-oss-20b",
  "gemini:gemini-3.7-flash",
  "gemini:gemini-3.6-flash",
]);

const configStore = new ConfigStore(DATA_DIR);
const dataStore = new DataStore(DATA_DIR);
const routineLearner = new RoutineLearner(DATA_DIR);
const mcpManager = new MCPManager(() => configStore.get());
const browserBridge = new BrowserWorkspaceBridge(DATA_DIR);
const cognitiveCore = new CognitiveCore(DATA_DIR);
const toolRegistry = new ToolRegistry({ dataStore, configStore, mcpManager, browserBridge, dataDir: DATA_DIR });
const agentRuntime = new AgentRuntime({
  configStore,
  dataStore,
  toolRegistry,
  routineLearner,
  cognitiveCore,
  credentials: { openai: () => readApiKey(), groq: () => readCredential(GROQ_KEY_PATH), gemini: () => readCredential(GEMINI_KEY_PATH) },
});

app.use(express.json({ limit: "1mb" }));

function readApiKey() {
  return readCredential(KEY_PATH);
}

function readCredential(file) {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").trim();
}

function readFishAudioKey() {
  if (!fs.existsSync(FISH_AUDIO_KEY_PATH)) return "";
  return fs.readFileSync(FISH_AUDIO_KEY_PATH, "utf8").trim();
}

function configureCloudFirstRuntime() {
  const groqConfigured = Boolean(readCredential(GROQ_KEY_PATH));
  const geminiConfigured = Boolean(readCredential(GEMINI_KEY_PATH));
  const current = configStore.get();
  if (current.llm.provider !== "ollama" || (!groqConfigured && !geminiConfigured)) return;
  configStore.update({
    llm: groqConfigured ? {
      provider: "groq",
      chatModel: "groq:openai/gpt-oss-120b",
      fastModel: "groq:openai/gpt-oss-20b",
    } : {
      provider: "gemini",
      chatModel: "gemini:gemini-3.7-flash",
      fastModel: "gemini:gemini-3.7-flash",
    },
  });
}

configureCloudFirstRuntime();

let fishVoiceCache = { loadedAt: 0, items: [] };

async function getFishVoices() {
  if (fishVoiceCache.items.length && Date.now() - fishVoiceCache.loadedAt < 10 * 60 * 1000) return fishVoiceCache.items;
  const apiKey = readFishAudioKey();
  if (!apiKey) return [];
  const querySets = [
    "page_size=50&page_number=1&self=true&language=en&sort_by=created_at",
    "page_size=20&page_number=1&language=en&title=Jarvis&sort_by=task_count",
    "page_size=30&page_number=1&language=en&sort_by=task_count",
  ];
  const responses = await Promise.all(querySets.map(async (query, index) => {
    const response = await fetch(`https://api.fish.audio/model?${query}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.items || []).map((voice) => ({ ...voice, personal: index === 0 }));
  }));
  const voices = [...new Map(responses.flat()
    .filter((voice) => voice.type === "tts" && voice.state === "trained" && (voice.languages || []).includes("en"))
    .map((voice) => [voice._id, { id: voice._id, name: voice.title || "Untitled voice", personal: voice.personal }])).values()];
  if (!voices.some((voice) => voice.id === FISH_AUDIO_VOICE_ID)) voices.unshift({ id: FISH_AUDIO_VOICE_ID, name: "Jarvis | Iron Man", personal: false });
  fishVoiceCache = { loadedAt: Date.now(), items: voices };
  return voices;
}

async function getOllamaModels() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.models) ? data.models.map((model) => model.name) : [];
  } catch {
    return [];
  }
}

class LocalWhisper {
  constructor() {
    this.process = null;
    this.ready = null;
    this.pending = new Map();
  }

  available() {
    const executable = process.env.JARVIS_WHISPER_EXE || process.env.JERVIS_WHISPER_EXE;
    const venvPython = path.join(__dirname, ".venv", "Scripts", "python.exe");
    return Boolean((executable && fs.existsSync(executable)) || fs.existsSync(venvPython) || fs.existsSync(WHISPER_SCRIPT));
  }

  async start() {
    if (this.process && this.ready) return this.ready;
    const executable = process.env.JARVIS_WHISPER_EXE || process.env.JERVIS_WHISPER_EXE;
    const venvPython = path.join(__dirname, ".venv", "Scripts", "python.exe");
    const command = executable && fs.existsSync(executable)
      ? executable
      : fs.existsSync(venvPython) ? venvPython : "python";
    const args = command === executable ? [] : [WHISPER_SCRIPT];
    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        HF_HOME: path.join(DATA_DIR, "models"),
        JARVIS_WHISPER_MODEL: process.env.JARVIS_WHISPER_MODEL || process.env.JERVIS_WHISPER_MODEL || configStore.get().speechRecognition.whisperModel,
        JARVIS_WHISPER_DEVICE: process.env.JARVIS_WHISPER_DEVICE || process.env.JERVIS_WHISPER_DEVICE || configStore.get().speechRecognition.device,
        JARVIS_WHISPER_MIN_CONFIDENCE: String(configStore.get().speechRecognition.minConfidence),
        JARVIS_WHISPER_NO_SPEECH_THRESHOLD: String(configStore.get().speechRecognition.noSpeechThreshold),
      },
    });
    this.process.stderr.on("data", (chunk) => console.error(`[whisper] ${String(chunk).trim()}`));
    this.process.on("exit", (code) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`Local Whisper stopped (${code ?? "unknown"}).`));
        fs.rmSync(request.path, { force: true });
      }
      this.pending.clear();
      this.process = null;
      this.ready = null;
    });

    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Local Whisper model startup timed out.")), 300000);
      const lines = readline.createInterface({ input: this.process.stdout });
      lines.on("line", (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "ready") {
          clearTimeout(timeout);
          resolve(event.model);
          return;
        }
        const request = this.pending.get(String(event.id || ""));
        if (!request) return;
        this.pending.delete(String(event.id));
        clearTimeout(request.timer);
        fs.rmSync(request.path, { force: true });
        if (event.type === "result") request.resolve(event);
        else request.reject(new Error(event.error || "Local transcription failed."));
      });
    });
    return this.ready;
  }

  async transcribe(buffer, extension) {
    await this.start();
    const id = crypto.randomUUID();
    const tempPath = path.join(os.tmpdir(), `jarvis-${id}.${extension}`);
    fs.writeFileSync(tempPath, buffer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fs.rmSync(tempPath, { force: true });
        reject(new Error("Local transcription timed out."));
      }, 120000);
      this.pending.set(id, { resolve, reject, timer, path: tempPath });
      this.process.stdin.write(`${JSON.stringify({ id, path: tempPath })}\n`);
    });
  }
}

const localWhisper = new LocalWhisper();

app.get("/api/status", async (_req, res) => {
  const ollamaModels = await getOllamaModels();
  const config = configStore.get();
  const openAiConfigured = Boolean(readApiKey());
  const groqConfigured = Boolean(readCredential(GROQ_KEY_PATH));
  const geminiConfigured = Boolean(readCredential(GEMINI_KEY_PATH));
  const recommendedModel = groqConfigured
    ? "groq:openai/gpt-oss-20b"
    : geminiConfigured ? "gemini:gemini-3.7-flash" : openAiConfigured ? DEFAULT_MODEL : `ollama:${LOCAL_MODEL}`;
  res.json({
    configured: openAiConfigured || groqConfigured || geminiConfigured,
    openAiConfigured,
    groqConfigured,
    geminiConfigured,
    recommendedModel,
    permissionMode: config.permissions?.mode || "standard",
    fishAudioConfigured: Boolean(readFishAudioKey()),
    model: DEFAULT_MODEL,
    localModel: LOCAL_MODEL,
    ollamaOnline: ollamaModels.length > 0,
    ollamaModels,
    localTranscription: localWhisper.available(),
    voiceId: FISH_AUDIO_VOICE_ID,
    voiceModel: FISH_AUDIO_MODEL,
    features: {
      agentPlanner: config.assistant.plannerEnabled,
      evaluator: config.assistant.evaluatorEnabled,
      knowledgeGraph: true,
      routineLearning: config.assistant.routineLearningEnabled,
      diary: true,
      nutrition: true,
      webTools: true,
      screenshots: true,
      localFiles: true,
      mcp: true,
      dictation: config.dictation.enabled,
      personalAutomation: true,
      reminders: true,
      contactsAndNotes: true,
      fileUtilities: true,
      referenceCompatibility: true,
      healthAndStudy: true,
      documentAndPdfTools: true,
      securityVault: true,
      deviceAndPhoneTools: true,
      adaptiveWorkspaceMemory: true,
      cognitiveAgent: true,
    },
  });
});

app.get("/api/config", (_req, res) => {
  const config = configStore.get();
  res.json({
    ...config,
    llm: { ...config.llm, apiKey: config.llm.apiKey ? "[configured]" : "" },
    tools: { ...config.tools, braveApiKey: config.tools.braveApiKey ? "[configured]" : "" },
  });
});

app.get("/api/routines", (_req, res) => {
  const config = configStore.get();
  res.json({ enabled: config.assistant.routineLearningEnabled, ...routineLearner.snapshot() });
});

app.delete("/api/routines", (_req, res) => {
  routineLearner.clear();
  res.json({ cleared: true });
});

app.get("/api/cognitive", (_req, res) => res.json(agentRuntime.cognitiveSnapshot()));

app.post("/api/cognitive/cancel", (_req, res) => {
  res.json({ cancelled: agentRuntime.cancel("Cancelled by user.") });
});

app.post("/api/cognitive/pause", (_req, res) => {
  res.json({ paused: cognitiveCore.pause("Paused by user.") });
});

app.post("/api/cognitive/resume", async (req, res) => {
  res.json({ resumed: await cognitiveCore.resume(req.body?.goalId) });
});

app.put("/api/config", async (req, res) => {
  const patch = req.body && typeof req.body === "object" ? structuredClone(req.body) : {};
  if (patch.llm?.apiKey === "[configured]") delete patch.llm.apiKey;
  if (patch.tools?.braveApiKey === "[configured]") delete patch.tools.braveApiKey;
  const config = configStore.update(patch);
  await mcpManager.refresh().catch(() => null);
  res.json({ saved: true, provider: config.llm.provider });
});

app.get("/api/tools", async (_req, res) => {
  const tools = await toolRegistry.list();
  res.json(tools.map(({ name, description, capabilities, riskLevel, requiresConfirmation, inputSchema }) => ({ name, description, capabilities, riskLevel, requiresConfirmation, inputSchema })));
});

app.get("/api/workspaces", (_req, res) => res.json(toolRegistry.workspaces.list()));
app.get("/api/workspaces/:name", (req, res) => {
  try { res.json(toolRegistry.workspaces.get(req.params.name)); }
  catch (error) { res.status(404).json({ error: error.message }); }
});

app.post("/api/workspaces/browser/pair", (req, res) => {
  try {
    const origin = String(req.headers.origin || "chrome-extension://local-companion");
    res.json(browserBridge.pair(origin));
  } catch (error) { res.status(403).json({ error: error.message }); }
});

function requireBrowserBridge(req, res, next) {
  if (!browserBridge.authorized(req.headers["x-jarvis-bridge-key"])) return res.status(401).json({ error: "Invalid browser companion key." });
  next();
}

app.get("/api/workspaces/browser/poll", requireBrowserBridge, async (req, res) => {
  try { res.json(await browserBridge.poll({ clientId: req.query.clientId, browser: req.query.browser })); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post("/api/workspaces/browser/respond", requireBrowserBridge, (req, res) => {
  try { res.json(browserBridge.respond(req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.get("/api/dashboard", async (_req, res) => {
  const readPrivateJson = (name, fallback) => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8")); }
    catch { return fallback; }
  };
  const personal = readPrivateJson("personal-data.json", { reminders: [] });
  const extended = readPrivateJson("extended-data.json", { calendar: [] });
  const now = Date.now();
  const tools = await toolRegistry.list();
  res.json({
    system: {
      memoryUsedPercent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      memoryUsedGb: +((os.totalmem() - os.freemem()) / 2 ** 30).toFixed(1),
      memoryTotalGb: +(os.totalmem() / 2 ** 30).toFixed(1),
      uptimeHours: +(os.uptime() / 3600).toFixed(1),
      cores: os.cpus().length,
      tools: tools.length,
    },
    reminders: (personal.reminders || [])
      .filter((item) => !item.done && new Date(item.at).getTime() >= now)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .slice(0, 5),
    events: (extended.calendar || [])
      .filter((item) => new Date(item.end || item.start).getTime() >= now)
      .sort((a, b) => String(a.start).localeCompare(String(b.start)))
      .slice(0, 5),
  });
});

app.get("/api/voices", async (_req, res) => {
  try {
    res.json({ defaultVoiceId: FISH_AUDIO_VOICE_ID, voices: await getFishVoices() });
  } catch (error) {
    res.status(502).json({ error: error?.message || "Fish Audio voices could not be loaded.", defaultVoiceId: FISH_AUDIO_VOICE_ID, voices: [{ id: FISH_AUDIO_VOICE_ID, name: "Jarvis | Iron Man", personal: false }] });
  }
});

app.post("/api/tools/refresh", async (_req, res) => res.json(await mcpManager.refresh()));

app.get("/api/memory", (_req, res) => res.json(dataStore.snapshot()));
app.get("/api/meals", (req, res) => res.json(dataStore.getMeals(req.query)));
app.delete("/api/meals/:id", (req, res) => res.json({ deleted: dataStore.deleteMeal(String(req.params.id)) }));
app.get("/api/dictation/history", (req, res) => res.json(dataStore.getDictations(Math.min(Number(req.query.limit) || 200, 1000))));
app.post("/api/dictation/history", (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Dictation text is required." });
  dataStore.addDictation(text, String(req.body?.app || ""));
  res.json({ saved: true });
});
app.post("/api/dictation/clean", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Dictation text is required." });
  res.json({ text: await agentRuntime.cleanDictation(text) });
});

app.post("/api/speech", async (req, res) => {
  const apiKey = readFishAudioKey();
  const text = normalizeSpeechText(req.body?.text).slice(0, 5000);
  const requestedVoiceId = String(req.body?.voiceId || FISH_AUDIO_VOICE_ID).trim();
  if (!apiKey) {
    return res.status(503).json({ error: "Add your Fish Audio API key to fish-api.txt and save the file." });
  }
  if (!text) return res.status(400).json({ error: "Speech text is required." });
  if (!/^[a-f0-9]{32}$/i.test(requestedVoiceId)) return res.status(400).json({ error: "A valid Fish Audio voice must be selected." });

  try {
    const response = await fetch(
      "https://api.fish.audio/v1/tts",
      {
        method: "POST",
        headers: {
          Accept: "audio/mpeg",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          model: FISH_AUDIO_MODEL,
        },
        body: JSON.stringify({
          text,
          reference_id: requestedVoiceId,
          format: "mp3",
          latency: "balanced",
          normalize: true,
          prosody: {
            speed: 0.98,
            volume: 0,
            normalize_loudness: true,
          },
        }),
      },
    );

    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      const upstreamMessage = details?.message || details?.reason;
      const message = response.status === 401
        ? "The Fish Audio API key was rejected. Check fish-api.txt and save it again."
        : response.status === 402
          ? "The Fish Audio account cannot use this voice or model."
          : response.status === 429
            ? "Fish Audio is rate-limiting voice requests. Try again shortly."
            : upstreamMessage || "Fish Audio speech generation failed.";
      return res.status(response.status).json({ error: message });
    }

    const audio = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", response.headers.get("content-type") || "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(audio);
  } catch (error) {
    res.status(502).json({ error: error?.message || "Could not reach Fish Audio." });
  }
});

app.post(
  "/api/transcribe",
  express.raw({ type: ["audio/*", "application/octet-stream"], limit: "25mb" }),
  async (req, res) => {
    const fishApiKey = readFishAudioKey();
    const openAiApiKey = readApiKey();
    const groqApiKey = readCredential(GROQ_KEY_PATH);
    if (!localWhisper.available() && !fishApiKey && !openAiApiKey && !groqApiKey) {
      return res.status(503).json({ error: "No local or cloud transcription engine is configured." });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "No microphone audio was received." });
    }

    try {
      const mimeType = String(req.headers["content-type"] || "audio/webm").split(";")[0];
      const extension = mimeType.includes("wav") ? "wav" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : mimeType.includes("mpeg") ? "mp3" : "webm";
      const transcriptionMode = String(req.headers["x-jarvis-transcription-mode"] || "wake");
      const transcribeCloud = async (apiKey, baseURL, model) => {
        const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
        const file = await toFile(req.body, `microphone.${extension}`, { type: mimeType });
        return client.audio.transcriptions.create({
          file,
          model,
          language: "en",
          prompt: "Transcribe every spoken word in English. Preserve the wake phrases JARVIS and WAKE UP JARVIS exactly when spoken.",
          response_format: "json",
        });
      };

      const cloudApiKey = groqApiKey || (transcriptionMode === "command" ? openAiApiKey : "");
      if (cloudApiKey) {
        try {
          const transcription = groqApiKey
            ? await transcribeCloud(groqApiKey, "https://api.groq.com/openai/v1", "whisper-large-v3-turbo")
            : await transcribeCloud(openAiApiKey, "", "gpt-4o-mini-transcribe");
          return res.json({ text: transcription.text || "", cloud: groqApiKey ? "groq" : "openai" });
        } catch (cloudError) {
          if (!localWhisper.available()) throw cloudError;
          console.error(`[transcription] Cloud ${transcriptionMode} pass failed, using local Whisper: ${cloudError?.message || cloudError}`);
        }
      }

      if (localWhisper.available()) {
        const result = await localWhisper.transcribe(req.body, extension);
        return res.json({ text: result.text || "", language: result.language || null, local: true });
      }
      if (fishApiKey) {
        const form = new FormData();
        form.append("audio", new Blob([req.body], { type: mimeType }), `microphone.${extension}`);
        form.append("ignore_timestamps", "true");
        const response = await fetch("https://api.fish.audio/v1/asr", {
          method: "POST",
          headers: { Authorization: `Bearer ${fishApiKey}` },
          body: form,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = response.status === 401
            ? "The Fish Audio API key was rejected."
            : response.status === 402
              ? "The Fish Audio account has no transcription credits."
              : data?.message || "Fish Audio transcription failed.";
          return res.status(response.status).json({ error: message });
        }
        return res.json({ text: data.text || "", language: data.language_code || null });
      }

      const transcription = groqApiKey
        ? await transcribeCloud(groqApiKey, "https://api.groq.com/openai/v1", "whisper-large-v3-turbo")
        : await transcribeCloud(openAiApiKey, "", "gpt-4o-mini-transcribe");
      res.json({ text: transcription.text || "" });
    } catch (error) {
      let message = error?.message || "Audio transcription failed.";
      if (error?.status === 401) {
        message = "The API key in api.txt was rejected. Check it and save the file again.";
      } else if (error?.status === 429) {
        message = "This OpenAI account has no available API quota for voice transcription.";
      }
      res.status(error?.status >= 400 && error?.status < 500 ? error.status : 500).json({ error: message });
    }
  },
);

app.post("/api/chat", async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const groqConfigured = Boolean(readCredential(GROQ_KEY_PATH));
  const geminiConfigured = Boolean(readCredential(GEMINI_KEY_PATH));
  const openAiConfigured = Boolean(readApiKey());
  const cloudDefault = groqConfigured
    ? "groq:openai/gpt-oss-20b"
    : geminiConfigured ? "gemini:gemini-3.7-flash" : openAiConfigured ? DEFAULT_MODEL : `ollama:${LOCAL_MODEL}`;
  const requestedModel = String(req.body?.model || cloudDefault);
  let model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : cloudDefault;
  if (requestedModel.startsWith("ollama:")) {
    if (groqConfigured || geminiConfigured || openAiConfigured) {
      model = cloudDefault;
    } else {
      const ollamaModels = await getOllamaModels();
      model = ollamaModels.includes(requestedModel.slice(7)) ? requestedModel : cloudDefault;
    }
  }

  const providerConfigured = model.startsWith("groq:") ? readCredential(GROQ_KEY_PATH)
    : model.startsWith("gemini:") ? readCredential(GEMINI_KEY_PATH) : readApiKey();
  if (!model.startsWith("ollama:") && !providerConfigured) {
    return res.status(503).json({ error: "The selected AI provider is not configured." });
  }
  if (!messages.length) {
    return res.status(400).json({ error: "A message is required." });
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  req.once("aborted", () => agentRuntime.cancel("Client disconnected."));

  try {
    await agentRuntime.run({ messages, model, emit: (event) => res.write(`${JSON.stringify(event)}\n`) });
  } catch (error) {
    let message = error?.message || "AI provider request failed.";
    if (error?.status === 401) {
      message = "The selected AI provider rejected its private API key.";
    } else if (error?.status === 429) {
      message = "This OpenAI account has no available API quota. Add billing or credits, then try again.";
    }
    res.write(`${JSON.stringify({ type: "error", error: message })}\n`);
  } finally {
    res.end();
  }
});

app.delete("/api/memory", (_req, res) => {
  agentRuntime.clearMemory();
  res.json({ cleared: true });
});

app.use(express.static(path.join(__dirname, "dist")));
app.use((_req, res, next) => {
  const indexPath = path.join(__dirname, "dist", "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  next();
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`JARVIS core listening at http://127.0.0.1:${PORT}`);
  if (localWhisper.available()) {
    localWhisper.start().catch((error) => console.error(`[whisper] Warmup failed: ${error?.message || error}`));
  }
});
