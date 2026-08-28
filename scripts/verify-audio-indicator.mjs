const port = process.env.JARVIS_CDP_PORT || "9225";
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && /127\.0\.0\.1:(?:5173|8787)/.test(item.url));
if (!target) throw new Error("JARVIS renderer target is unavailable.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let requestId = 0;
function evaluate(expression, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => reject(new Error("Audio indicator verification timed out.")), 15000);
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result.result.value);
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise } }));
  });
}

await new Promise((resolve) => setTimeout(resolve, 1200));
const listening = await evaluate(`(() => {
  const core = document.querySelector('.core-visual');
  return { className: core?.className, level: Number(core?.style.getPropertyValue('--voice-level') || 0), bars: core?.querySelectorAll('.voice-wave i').length, label: document.querySelector('.core-title p')?.textContent };
})()`);
await evaluate(`document.querySelector('[aria-label="Open settings"]')?.click()`);
await new Promise((resolve) => setTimeout(resolve, 2200));
await evaluate(`document.querySelector('.voice-preview-button')?.click()`);
const speaking = await evaluate(`new Promise(async (resolve) => {
  let peak = 0; let speakingSeen = false;
  for (let index = 0; index < 70; index += 1) {
    const core = document.querySelector('.core-visual');
    const level = Number(core?.style.getPropertyValue('--voice-level') || 0);
    peak = Math.max(peak, level);
    speakingSeen ||= core?.classList.contains('speaking');
    if (speakingSeen && peak > .02) break;
    await new Promise((next) => setTimeout(next, 100));
  }
  resolve({ speakingSeen, peak, className: document.querySelector('.core-visual')?.className, label: document.querySelector('.core-title p')?.textContent });
})`, true);
if (listening.bars !== 7 || !/audio-active/.test(listening.className) || !speaking.speakingSeen || speaking.peak <= .02) throw new Error("Audio-reactive indicator did not activate correctly.");
console.log(JSON.stringify({ listening, speaking }, null, 2));
socket.close();
