const SERVER = "http://127.0.0.1:8787";
const CLIENT_ID_KEY = "jarvisClientId";
const BRIDGE_KEY = "jarvisBridgeKey";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function browserKind() {
  return navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
}

async function identity() {
  const stored = await chrome.storage.local.get([CLIENT_ID_KEY, BRIDGE_KEY]);
  const clientId = stored[CLIENT_ID_KEY] || crypto.randomUUID();
  let key = stored[BRIDGE_KEY] || "";
  if (!stored[CLIENT_ID_KEY]) await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId });
  if (!key) {
    const response = await fetch(`${SERVER}/api/workspaces/browser/pair`, { method: "POST" });
    if (!response.ok) throw new Error("JARVIS companion pairing failed.");
    key = (await response.json()).key;
    await chrome.storage.local.set({ [BRIDGE_KEY]: key });
  }
  return { clientId, key, browser: browserKind() };
}

async function capture() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return {
    windows: windows.filter((window) => !window.incognito).map((window) => ({
      state: window.state,
      focused: window.focused,
      incognito: window.incognito,
      left: window.left,
      top: window.top,
      width: window.width,
      height: window.height,
      tabs: (window.tabs || []).map((tab) => ({ url: tab.url, title: tab.title, index: tab.index, active: tab.active, pinned: tab.pinned })),
    })),
  };
}

async function restore(payload, browser) {
  const requested = (payload.windows || []).filter((window) => window.browser === browser);
  const existingTabs = await chrome.tabs.query({});
  const existingUrls = new Set(existingTabs.map((tab) => tab.url));
  let restoredWindows = 0;
  let restoredTabs = 0;
  for (const saved of requested) {
    const tabs = [...saved.tabs].sort((a, b) => a.index - b.index);
    const missing = tabs.filter((tab) => !existingUrls.has(tab.url));
    if (!missing.length) continue;
    const created = await chrome.windows.create({
      url: missing.map((tab) => tab.url),
      left: saved.left,
      top: saved.top,
      width: saved.width,
      height: saved.height,
      focused: saved.focused,
      state: "normal",
    });
    if (["minimized", "maximized", "fullscreen"].includes(saved.state)) await chrome.windows.update(created.id, { state: saved.state });
    restoredWindows += 1;
    restoredTabs += missing.length;
    const createdTabs = await chrome.tabs.query({ windowId: created.id });
    for (let index = 0; index < missing.length; index += 1) {
      if (missing[index].pinned && createdTabs[index]) await chrome.tabs.update(createdTabs[index].id, { pinned: true });
    }
    const activeIndex = missing.findIndex((tab) => tab.active);
    if (activeIndex >= 0 && createdTabs[activeIndex]) await chrome.tabs.update(createdTabs[activeIndex].id, { active: true });
    missing.forEach((tab) => existingUrls.add(tab.url));
  }
  return { restoredWindows, restoredTabs };
}

async function cycle() {
  for (;;) {
    try {
      const { clientId, key, browser } = await identity();
      const response = await fetch(`${SERVER}/api/workspaces/browser/poll?clientId=${encodeURIComponent(clientId)}&browser=${browser}`, { headers: { "X-Jarvis-Bridge-Key": key } });
      if (response.status === 401) {
        await chrome.storage.local.remove(BRIDGE_KEY);
        await sleep(1000);
        continue;
      }
      const { request } = await response.json();
      if (request) {
        let result = null;
        let error = "";
        try { result = request.type === "capture" ? await capture() : await restore(request.payload, browser); }
        catch (requestError) { error = requestError.message; }
        await fetch(`${SERVER}/api/workspaces/browser/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Jarvis-Bridge-Key": key },
          body: JSON.stringify({ clientId, browser, requestId: request.id, result, error }),
        });
      }
    } catch { await sleep(1500); }
  }
}

cycle();
