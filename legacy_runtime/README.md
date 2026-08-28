# Jarvis Compatibility Resources

This directory preserves reusable resources from the local MIT-licensed repository at:

`C:\Users\Jay\Documents\GitHub\jarvis-ai-assistant`

The original interface is intentionally not included. JERVIS keeps its existing Electron UI and adapts capabilities through bounded tools in `core/extended.js`, `core/personal.js`, and `core/tools.js`.

## Included

- Python engine source that parses successfully
- Face-detection cascade resource
- Source architecture and API documentation
- Original startup audio and icon assets
- Original MIT license

## Excluded

- Groq, Gemini, and other credential configuration files
- Password vault keys and password JSON
- Contacts, command history, health, expense, reminder, calendar, memory, and database files
- Virtual environments, caches, bytecode, reports, recordings, and generated output
- Batch launchers and the legacy Eel/web interface
- Two source modules that fail Python parsing

The preserved Python code is reference material and is not executed directly. Several original handlers run unrestricted shell commands, mutate files without confirmation, start monitoring threads during import, or return placeholder success messages. JERVIS replaces those behaviors with native, hidden-process implementations and explicit confirmation gates.
