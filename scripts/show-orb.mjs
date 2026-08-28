const port = process.env.JARVIS_CDP_PORT || "9225";
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && !item.url.includes("orb=1"));
if (!target) throw new Error("JARVIS renderer is unavailable.");
const visible = !process.argv.includes("--hide");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
socket.send(JSON.stringify({
  id: 1,
  method: "Runtime.evaluate",
  params: { expression: `window.jarvisDesktop.hideMainWindow(); window.jarvisDesktop.updateOrb({ visible: ${visible}, state: 'awake', level: ${visible ? 0.55 : 0} })` },
}));
await new Promise((resolve) => setTimeout(resolve, 700));
socket.close();
