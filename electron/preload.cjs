const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jarvisDesktop", {
  onDictationToggle(callback) {
    const listener = () => callback();
    ipcRenderer.on("jarvis:dictation-toggle", listener);
    return () => ipcRenderer.removeListener("jarvis:dictation-toggle", listener);
  },
  onDictationCancel(callback) {
    const listener = () => callback();
    ipcRenderer.on("jarvis:dictation-cancel", listener);
    return () => ipcRenderer.removeListener("jarvis:dictation-cancel", listener);
  },
  setDictationState(active) {
    ipcRenderer.send("jarvis:dictation-state", Boolean(active));
  },
  pasteText(text) {
    ipcRenderer.send("jarvis:paste-text", String(text || ""));
  },
  updateOrb(state) {
    ipcRenderer.send("jarvis:orb-update", state || {});
  },
  onOrbState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("jarvis:orb-state", listener);
    return () => ipcRenderer.removeListener("jarvis:orb-state", listener);
  },
  openMainWindow() {
    ipcRenderer.send("jarvis:open-main");
  },
  hideMainWindow() {
    ipcRenderer.send("jarvis:hide-main");
  },
  getWindowState() {
    return ipcRenderer.invoke("jarvis:window-state");
  },
});
