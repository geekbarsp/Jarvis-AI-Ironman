# JERVIS Desktop

Private Windows voice assistant with a local agent runtime. The current interface is intentionally independent from the reference project; its backend behavior is adapted from the feature set described by `isair/jarvis`.

## Runtime Features

- Continuous wake-name listening, hot follow-ups, stop commands, and echo filtering
- Local Faster Whisper transcription with VAD, confidence, and no-speech filtering
- Fish Audio speech output with system speech fallback
- Ollama, OpenAI, Groq, and Gemini chat providers with Groq/Gemini outage fallback
- Task planning, constrained tool routing, multi-step execution, result digestion, and answer evaluation
- Redacted dialogue memory, diary history, semantic embeddings, and topic-organized knowledge facts
- Nutrition logging, retrieval, totals, and explicit-intent deletion
- Screenshot vision, DuckDuckGo/Brave/Wikipedia web search, page extraction, Open-Meteo weather, configured location, and safe local-file access
- Persistent stdio MCP servers with dynamic discovery, refresh, invocation, and tool-search widening
- System-wide dictation with local transcription, optional filler cleanup, custom dictionary, history, and universal paste
- Personal app/site launching, app closing, media/volume keys, device status, locking, and confirmed power controls
- Persistent reminders with Windows notifications, private notes, contacts, WhatsApp/email/phone links, and clipboard control
- Folder sizing, recent/large-file discovery, streamed duplicate detection, ZIP compression/extraction, calculations, conversions, and secure password generation
- Hidden helper processes: JERVIS does not open command or PowerShell console windows
- Private calendar, health/wellness logs, BMI/calorie estimates, flashcard decks, and quiz generation
- QR codes, color palettes, screen color sampling, image conversion, and text/image/Office/HTML-to-PDF workflows
- PDF merge, split, text extraction, repacking, rotation, and watermarking
- AES-256-GCM file vault, URL heuristics, bounded port checks, redacted backups, Recycle Bin control, file organization, and batch renaming
- Windows system/battery/disk/network/USB/startup/process diagnostics plus Android ADB inspection
- Git status/diff/confirmed commit/push and confirmed Python package management

## Desktop Controls

Run `release/JERVIS-1.0.0-portable.exe`. JERVIS listens continuously when hands-free mode is enabled.

Press `Ctrl+Alt+D` to start system-wide dictation, then press it again to transcribe and paste into the focused application. Press `Escape` to cancel an active dictation.

## Configuration

Runtime data is stored under `%APPDATA%\JERVIS`:

- `config.json`: providers, models, location, memory behavior, dictation, file roots, and MCP servers
- `api.txt`: optional OpenAI key
- `groq-api.txt`, `gemini-api.txt`: private Groq and Gemini keys
- `fish-api.txt`: Fish Audio key
- `personal-data.json`: reminders, notes, and contacts
- `extended-data.json`: private calendar, health, and flashcard data
- `memory.jsonl`, `diary.jsonl`, `knowledge-graph.json`, `semantic-memory.json`: private memory
- `meals.json`, `dictation-history.jsonl`: nutrition and dictation records

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

MCP environment variables are opt-in. JERVIS does not automatically forward API keys or the full desktop environment to MCP child processes.

## Reference Compatibility

Reusable engine source and assets from the local MIT-licensed `jarvis-ai-assistant` repository are preserved under `legacy_runtime/vendor`. Its API keys, password data, personal databases/JSON, caches, generated files, broken Python modules, batch launchers, and separate UI are excluded.

The preserved Python source is not executed directly. JERVIS replaces unrestricted shell execution and placeholder handlers with bounded native tools, allowed-folder enforcement, hidden subprocesses, and explicit confirmation for destructive operations. See `legacy_runtime/README.md` for the import policy.

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
```
