import fs from "node:fs";

const port = process.env.JARVIS_CDP_PORT || "9225";
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.url.includes("8787") && !item.url.includes("orb=1"));
if (!target) throw new Error("JARVIS renderer target is unavailable.");

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
await call("Runtime.evaluate", { expression: `document.querySelector('[aria-label="Open settings"]')?.click()` });
await new Promise((resolve) => setTimeout(resolve, 500));
const result = await call("Runtime.evaluate", {
  expression: `(() => {
    const panel = document.querySelector('.settings-panel');
    const cognitive = document.querySelector('.cognitive-debug');
    return {
      settingsVisible: Boolean(panel),
      cognitiveVisible: Boolean(cognitive),
      text: cognitive?.innerText || '',
      horizontalOverflow: panel ? panel.scrollWidth > panel.clientWidth : true,
      panelWidth: panel?.getBoundingClientRect().width || 0,
    };
  })()`,
  returnByValue: true,
});
const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
fs.writeFileSync("release/jarvis-cognitive-settings.png", Buffer.from(screenshot.data, "base64"));
console.log(JSON.stringify(result.result.value, null, 2));
socket.close();
