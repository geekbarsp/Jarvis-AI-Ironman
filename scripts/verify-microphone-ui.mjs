const debugPort = process.env.JERVIS_CDP_PORT || "9223";
const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && /127\.0\.0\.1:(?:5173|8787)/.test(item.url));
if (!target) throw new Error("JERVIS renderer target is unavailable.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

let requestId = 0;
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => reject(new Error("Renderer verification timed out.")), 10000);
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise((resolve) => setTimeout(resolve, 800));
const opened = await call("Runtime.evaluate", {
  expression: `(() => {
    const existing = document.querySelector(".settings-panel");
    if (existing) return true;
    const button = [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === "Open settings");
    button?.click();
    return Boolean(button);
  })()`,
  returnByValue: true,
});
if (!opened.result.value) throw new Error("Settings button was not rendered.");
await new Promise((resolve) => setTimeout(resolve, 500));
const evaluation = await call("Runtime.evaluate", {
  expression: `(async () => {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    return {
      deviceCount: devices.length,
      labels: devices.map((device, index) => device.label || ("Microphone " + (index + 1))),
      selected: document.querySelector("#microphone")?.value,
      optionCount: document.querySelectorAll("#microphone option").length,
      hasTestButton: Boolean(document.querySelector(".microphone-test-button")),
      panel: document.querySelector(".settings-panel")?.getBoundingClientRect().toJSON(),
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});

if (!evaluation.result.value.hasTestButton) throw new Error("Microphone test control was not rendered.");
await call("Runtime.evaluate", { expression: 'document.querySelector(".microphone-test-button").click()' });
await new Promise((resolve) => setTimeout(resolve, 2800));
const signal = await call("Runtime.evaluate", {
  expression: `({
    state: document.querySelector(".microphone-meter")?.className.split(" ").at(-1),
    message: document.querySelector(".microphone-message")?.textContent,
    levelWidth: document.querySelector(".microphone-meter > span")?.style.width,
  })`,
  returnByValue: true,
});

console.log(JSON.stringify({ ...evaluation.result.value, signalTest: signal.result.value }, null, 2));
socket.close();
