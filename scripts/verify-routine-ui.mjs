const port = process.env.JARVIS_CDP_PORT || "9225";
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && !item.url.includes("orb=1"));
if (!target) throw new Error("JARVIS renderer is unavailable.");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let requestId = 0;
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener("message", listener);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result.result.value);
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
}

await evaluate(`document.querySelector('[aria-label="Open settings"]')?.click()`);
await new Promise((resolve) => setTimeout(resolve, 1000));
const initial = await evaluate(`({ title: document.querySelector('.routine-heading label')?.textContent, summary: document.querySelector('.routine-summary')?.textContent, enabled: document.querySelector('.routine-heading [role="switch"]')?.getAttribute('aria-checked') })`);
await evaluate(`document.querySelector('.routine-heading [role="switch"]')?.click()`);
await new Promise((resolve) => setTimeout(resolve, 500));
const disabled = await fetch("http://127.0.0.1:8787/api/routines").then((response) => response.json()).then((data) => data.enabled);
await evaluate(`document.querySelector('.routine-heading [role="switch"]')?.click()`);
await new Promise((resolve) => setTimeout(resolve, 500));
const enabled = await fetch("http://127.0.0.1:8787/api/routines").then((response) => response.json()).then((data) => data.enabled);
await evaluate(`window.confirm = () => true; document.querySelector('.routine-summary button')?.click()`);
await new Promise((resolve) => setTimeout(resolve, 500));
const observations = await fetch("http://127.0.0.1:8787/api/routines").then((response) => response.json()).then((data) => data.observations);
if (initial.title !== "Behavioral pattern learning" || !initial.summary.includes("1 observations") || initial.enabled !== "true") throw new Error("Routine learning summary did not render.");
if (disabled !== false || enabled !== true || observations !== 0) throw new Error("Routine learning controls did not persist correctly.");
console.log(JSON.stringify({ initial, disabled, enabled, observations }, null, 2));
socket.close();
