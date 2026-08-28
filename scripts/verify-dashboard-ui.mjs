import fs from "node:fs";

const targets = await fetch("http://127.0.0.1:9224/json").then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.url.includes("8787"));
if (!target) throw new Error("JERVIS renderer target is unavailable.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let requestId = 0;
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => reject(new Error(`${method} timed out.`)), 10000);
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await call("Page.enable");
const layout = await call("Runtime.evaluate", {
  expression: `(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    bodyOverflow: { x: document.body.scrollWidth > innerWidth, y: document.body.scrollHeight > innerHeight },
    columns: [...document.querySelectorAll('.workspace > *')].map((node) => ({ className: node.className, rect: node.getBoundingClientRect().toJSON() })),
    core: document.querySelector('.core-visual')?.getBoundingClientRect().toJSON(),
    dashboard: document.querySelector('.system-panel')?.innerText.includes('32'),
    settingsButton: Boolean(document.querySelector('[aria-label="Open settings"]')),
    microphoneButton: Boolean(document.querySelector('[aria-label="Toggle voice input"]')),
  }))()`,
  returnByValue: true,
});
const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
fs.writeFileSync("release/jervis-dashboard.png", Buffer.from(screenshot.data, "base64"));
console.log(JSON.stringify(layout.result.value, null, 2));
socket.close();
