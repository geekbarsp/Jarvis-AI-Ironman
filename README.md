# JARVIS Desktop

Private Windows voice assistant with a local agent runtime. The current interface is intentionally independent from the reference project; its backend behavior is adapted from the feature set described by `isair/jarvis`.

## Runtime Features

- Continuous wake-name listening, hot follow-ups, stop commands, and echo filtering
- Local Faster Whisper transcription with VAD, confidence, and no-speech filtering
- Fish Audio speech output with system speech fallback
- Local-first hybrid routing across deterministic commands, local tools/memory, Ollama general/coder models, and last-resort Groq/Gemini/OpenAI escalation
- Persistent exact/semantic response cache, provider health fallback, daily cloud-token limits, monthly budget controls, and local usage telemetry
- Cached Windows Start-app/Start-menu discovery with durable natural-language application aliases
- Task planning, constrained tool routing, multi-step execution, result digestion, and answer evaluation
- Persistent cognitive goals, bounded working memory, environment perception, verified action reflections, cancellation, and failure ceilings
- Central privacy-aware system context with foreground app/window, project inference, running apps/processes, monitors, cached browser state, system metrics, and meaningful change events
- Central validated action lifecycle with operation-level risk, explicit confirmation gates, structured verification states, redacted history, and extensible undo
- Persistent verified task graphs with dependencies, bounded concurrency, retries, timeouts, cancellation, interruption recovery, and per-node proof
- Event-driven automations for application/project events, schedules, and battery state with conditions, cooldowns, enable/disable controls, safe-action restrictions, and run audits
- Accessibility-first Windows control using semantic UI Automation selectors, focus, invoke, and value patterns instead of fixed coordinates
- Incremental project brain with allowed-root enforcement, fast local concept-normalized source retrieval, package/Git summaries, and durable engineering decisions
- Proactive failure, memory, battery, and disk notifications with deduplication, cooldowns, snooze, dismiss, expiry, and quiet mode
- Selective episodic memory, reusable procedures with success/confidence tracking, confidence-rated user preferences, and memory decay
- Separate explicit workspace modes, repeated-command routines, and application co-occurrence habits
- Redacted dialogue memory, diary history, semantic embeddings, and topic-organized knowledge facts
- Nutrition logging, retrieval, totals, and explicit-intent deletion
- Screenshot vision, DuckDuckGo/Brave/Wikipedia web search, page extraction, Open-Meteo weather, configured location, and safe local-file access
- Persistent stdio MCP servers with dynamic discovery, refresh, invocation, and tool-search widening
- System-wide dictation with local transcription, optional filler cleanup, custom dictionary, history, and universal paste
- Personal app/site launching, app closing, media/volume keys, device status, locking, and confirmed power controls
- Persistent reminders with native editing, atomic schedule correction/deduplication, sub-model fast paths, Windows notifications, private notes, contacts, WhatsApp/email/phone links, and clipboard control
- Folder sizing, recent/large-file discovery, streamed duplicate detection, ZIP compression/extraction, calculations, conversions, and secure password generation
- Hidden helper processes: JARVIS does not open command or PowerShell console windows
- Private calendar, health/wellness logs, BMI/calorie estimates, flashcard decks, and quiz generation
- QR codes, color palettes, screen color sampling, image conversion, and text/image/Office/HTML-to-PDF workflows
- PDF merge, split, text extraction, repacking, rotation, and watermarking
- AES-256-GCM file vault, URL heuristics, bounded port checks, redacted backups, Recycle Bin control, file organization, and batch renaming
- Windows system/battery/disk/network/USB/startup/process diagnostics plus Android ADB inspection
- Git status/diff/confirmed commit/push and confirmed Python package management

## Desktop Controls

Run `release/JARVIS-1.0.0-portable.exe`. JARVIS listens continuously when hands-free mode is enabled.

Press `Ctrl+Alt+D` to start system-wide dictation, then press it again to transcribe and paste into the focused application. Press `Escape` to cancel an active dictation.

## Configuration

Runtime data is stored under `%APPDATA%\JARVIS`:

- `config.json`: providers, models, location, memory behavior, dictation, file roots, and MCP servers
- `api.txt`: optional OpenAI key
- `groq-api.txt`, `gemini-api.txt`: private Groq and Gemini keys
- `fish-api.txt`: Fish Audio key
- `personal-data.json`: reminders, notes, and contacts
- `extended-data.json`: private calendar, health, and flashcard data
- `memory.jsonl`, `diary.jsonl`, `knowledge-graph.json`, `semantic-memory.json`: private memory
- `cognitive-goals.json`: persistent goals, subgoals, dependencies, plans, completion criteria, and status
- `cognitive-memory.json`: meaningful episodes, learned procedures, and confidence-rated preferences
- `cognitive-events.jsonl`: redacted goal, action, verification, reflection, and lifecycle events
- `action-history.json`: bounded redacted action outcomes, verification evidence, and rollback metadata (private clipboard contents remain memory-only)
- `task-graphs.json`, `automations.json`: durable verified workflows and audited trigger rules (credentials are rejected)
- `project-brain.json`, `notifications.json`: bounded project index/decisions and proactive alert state
- `application-index.json`: locally discovered Windows apps and user-taught aliases
- `response-cache.json`, `ai-usage.json`: expiring model answers and private routing/token statistics
- `meals.json`, `dictation-history.jsonl`: nutrition and dictation records

## Cognitive Runtime

`CognitiveCore` wraps the existing `AgentRuntime`; it does not replace the configured Groq, Gemini, OpenAI, or Ollama provider. At the start of a command it observes the foreground application and visible application set, creates a persistent goal, and opens expiring working memory. Plans and tool results update that task state. Each result is recorded as an observed success or failure with a concise expected-versus-observed reflection.

Completed meaningful tasks can create episodes and multi-action procedures. Retrieval is lexical, relevance-ranked, recency-aware, bounded, and labeled by source. Weak preference or habit evidence is retained at low confidence but is not injected into model context until the confidence threshold is met. Saved workspace modes remain explicit user-created snapshots and are never conflated with learned habits.

The Settings dialog includes a developer-safe Cognitive Agent summary. Full structured state is available locally at `GET /api/cognitive`; cancellation, pause, and resume controls are exposed under `/api/cognitive/*`. These endpoints expose summaries and observations, never private model chain of thought.

Live privacy-aware computer state is available at `GET /api/context`, and bounded action history is available at `GET /api/actions`. `POST /api/actions/undo` reverses the latest supported action. Privacy Mode can also be enabled conversationally; while active, JARVIS does not write conversation, diary, semantic, routine, or cognitive history and blocks screen capture.

Hybrid routing statistics are available locally at `GET /api/usage` and `GET /api/routing`. The UI's model selector is the preferred cloud-escalation model; ordinary prompts remain local-first. A user can explicitly say “use Groq”, “use Gemini”, or “use GPT” to request cloud processing. Configure `hybrid.dailyCloudTokenLimit` and `hybrid.monthlyCloudBudgetUsd` in `config.json`; explicit provider requests are still honored.

Advanced-system summaries are available locally at `GET /api/task-graphs`, `/api/automations`, `/api/automation-runs`, `/api/projects`, and `/api/notifications`. Mutations are performed through the matching AI tools so they pass through the central permission, verification, and audit lifecycle.

Example MCP entry in `config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\Jay\\Documents"],
      "env": {}
    }
  }
}
```

MCP environment variables are opt-in. JARVIS does not automatically forward API keys or the full desktop environment to MCP child processes.

## Reference Compatibility

Reusable engine source and assets from the local MIT-licensed `jarvis-ai-assistant` repository are preserved under `legacy_runtime/vendor`. Its API keys, password data, personal databases/JSON, caches, generated files, broken Python modules, batch launchers, and separate UI are excluded.

The preserved Python source is not executed directly. JARVIS replaces unrestricted shell execution and placeholder handlers with bounded native tools, allowed-folder enforcement, hidden subprocesses, and explicit confirmation for destructive operations. See `legacy_runtime/README.md` for the import policy.

## Development

```powershell
npm install
npm test
npm run desktop
npm run package:win
```

Ollama models used by the default configuration:

```powershell
ollama pull gemma3:4b
ollama pull nomic-embed-text
# Optional, then set llm.localCoderModel in config.json:
ollama pull qwen2.5-coder:7b
```
