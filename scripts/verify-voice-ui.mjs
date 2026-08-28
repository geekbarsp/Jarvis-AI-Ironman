const port = process.env.JARVIS_CDP_PORT || "9224";
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.url.includes("8787"));
if (!target) throw new Error("JARVIS renderer target is unavailable.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let requestId = 0;
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => reject(new Error("Voice UI verification timed out.")), 10000);
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result.result.value);
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
}

await evaluate(`document.querySelector('[aria-label="Open settings"]')?.click()`);
await new Promise((resolve) => setTimeout(resolve, 2500));
const result = await evaluate(`({
  optionCount: document.querySelectorAll('#voice-model option').length,
  selectedVoiceId: document.querySelector('#voice-model')?.value,
  selectedName: document.querySelector('#voice-model')?.selectedOptions[0]?.textContent,
  hasPreview: Boolean(document.querySelector('.voice-preview-button')),
  jarvisVoices: [...document.querySelectorAll('#voice-model option')].filter((item) => /jarvis/i.test(item.textContent)).length,
})`);
if (result.optionCount < 2 || !result.selectedVoiceId || !result.hasPreview) throw new Error("Voice selector is incomplete.");
console.log(JSON.stringify(result, null, 2));
socket.close();
