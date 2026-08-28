const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jervisDesktop", {
  onDictationToggle(callback) {
    const listener = () => callback();
    ipcRenderer.on("jervis:dictation-toggle", listener);
    return () => ipcRenderer.removeListener("jervis:dictation-toggle", listener);
  },
  onDictationCancel(callback) {
    const listener = () => callback();
    ipcRenderer.on("jervis:dictation-cancel", listener);
    return () => ipcRenderer.removeListener("jervis:dictation-cancel", listener);
  },
  setDictationState(active) {
    ipcRenderer.send("jervis:dictation-state", Boolean(active));
  },
  pasteText(text) {
    ipcRenderer.send("jervis:paste-text", String(text || ""));
  },
  updateOrb(state) {
    ipcRenderer.send("jervis:orb-update", state || {});
  },
  onOrbState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("jervis:orb-state", listener);
    return () => ipcRenderer.removeListener("jervis:orb-state", listener);
  },
  openMainWindow() {
    ipcRenderer.send("jervis:open-main");
  },
  hideMainWindow() {
    ipcRenderer.send("jervis:hide-main");
  },
  getWindowState() {
    return ipcRenderer.invoke("jervis:window-state");
  },
});
