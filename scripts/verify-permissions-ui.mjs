const port = process.env.JARVIS_CDP_PORT || "9225";
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && !item.url.includes("orb=1"));
if (!target) throw new Error("JARVIS renderer is unavailable.");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let requestId = 0;
function evaluate(expression, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => reject(new Error("Permission UI verification timed out.")), 15000);
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

await evaluate(`document.querySelector('[aria-label="Open settings"]')?.click()`);
await new Promise((resolve) => setTimeout(resolve, 1800));
const initial = await evaluate(`(() => ({
  voiceId: document.querySelector('#voice-model')?.value,
  voiceLabel: document.querySelector('#voice-model')?.selectedOptions[0]?.textContent,
  permissionButtons: document.querySelectorAll('.permission-segments button').length,
  activePermission: document.querySelector('.permission-segments button.active span')?.textContent,
}))()`);
await evaluate(`window.confirm = () => true; [...document.querySelectorAll('.permission-segments button')].find((button) => button.textContent.includes('Full access'))?.click()`);
await new Promise((resolve) => setTimeout(resolve, 800));
const full = await fetch("http://127.0.0.1:8787/api/config").then((response) => response.json()).then((config) => config.permissions?.mode);
await evaluate(`[...document.querySelectorAll('.permission-segments button')].find((button) => button.textContent.includes('Standard'))?.click()`);
await new Promise((resolve) => setTimeout(resolve, 800));
const restored = await fetch("http://127.0.0.1:8787/api/config").then((response) => response.json()).then((config) => config.permissions?.mode);
if (initial.voiceId !== "f22f684f44d74c4a86d72d95c296ba26" || !/Jarvis \| Iron Man/i.test(initial.voiceLabel || "")) throw new Error("Iron Man is not the selected default voice.");
if (initial.permissionButtons !== 3 || full !== "full" || restored !== "standard") throw new Error("Permission selector did not persist its modes.");
console.log(JSON.stringify({ initial, full, restored }, null, 2));
socket.close();
