const port = process.env.JARVIS_CDP_PORT || "9225";
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const mainTarget = targets.find((item) => item.type === "page" && !item.url.includes("orb=1"));
const orbTarget = targets.find((item) => item.type === "page" && item.url.includes("orb=1"));
if (!mainTarget || !orbTarget) throw new Error("JARVIS main or orb renderer is unavailable.");

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let requestId = 0;
  return {
    evaluate(expression, awaitPromise = false) {
      return new Promise((resolve, reject) => {
        const id = ++requestId;
        const timer = setTimeout(() => reject(new Error("Orb verification timed out.")), 10000);
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
    },
    close: () => socket.close(),
  };
}

const main = await connect(mainTarget);
const orb = await connect(orbTarget);
await main.evaluate(`window.jarvisDesktop.updateOrb({ visible: true, state: 'awake', level: 0.62 })`);
await new Promise((resolve) => setTimeout(resolve, 500));
const revealed = await orb.evaluate(`(() => {
  const core = document.querySelector('.core-visual');
  return {
    visibility: document.visibilityState,
    transparent: getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)',
    className: core?.className,
    level: Number(core?.style.getPropertyValue('--voice-level') || 0),
    bars: core?.querySelectorAll('.voice-wave i').length,
  };
})()`);

await main.evaluate(`window.jarvisDesktop.hideMainWindow()`);
await new Promise((resolve) => setTimeout(resolve, 500));
const background = await main.evaluate(`window.jarvisDesktop.getWindowState().then((windows) => ({ windows, rendererActive: document.visibilityState, microphoneActive: Boolean(document.querySelector('.core-visual.audio-active')) }))`, true);
await main.evaluate(`window.jarvisDesktop.updateOrb({ visible: true, state: 'speaking', level: 0.81 })`);
await new Promise((resolve) => setTimeout(resolve, 300));
const speaking = await orb.evaluate(`({ visibility: document.visibilityState, className: document.querySelector('.core-visual')?.className, level: Number(document.querySelector('.core-visual')?.style.getPropertyValue('--voice-level') || 0) })`);
await orb.evaluate(`document.querySelector('.core-visual')?.click()`);
await new Promise((resolve) => setTimeout(resolve, 300));
const reopened = await main.evaluate(`document.visibilityState`);
await main.evaluate(`window.jarvisDesktop.updateOrb({ visible: false, state: 'armed', level: 0 })`);

console.log(JSON.stringify({ revealed, background, speaking, reopened }, null, 2));
if (revealed.visibility !== "visible" || !revealed.transparent || revealed.bars !== 7 || revealed.level !== 0.62) throw new Error("Transparent orb did not reveal correctly.");
if (background.windows.mainVisible || !background.windows.orbVisible || background.windows.orbShapeRects < 300 || !background.microphoneActive) throw new Error("JARVIS did not remain active with a circular orb after the main window was hidden.");
if (!speaking.className.includes("speaking") || speaking.level !== 0.81 || reopened !== "visible") throw new Error("Orb state or reopen interaction failed.");
main.close();
orb.close();
