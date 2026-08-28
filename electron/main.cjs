const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, screen, session, shell, Tray } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const APP_ROOT = path.join(__dirname, "..");
const SERVER_PORT = 8787;
const isDev = process.argv.includes("--dev");
let mainWindow = null;
let orbWindow = null;
let tray = null;
let escapeRegistered = false;
let isQuitting = false;
let lastOrbState = { visible: false, state: "awake", level: 0.25 };

app.setName("JERVIS");

function migrateCredentials(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  for (const filename of ["api.txt", "fish-api.txt", "groq-api.txt", "gemini-api.txt"]) {
    const source = path.join(APP_ROOT, filename);
    const destination = path.join(dataDir, filename);
    if (!fs.existsSync(destination) && fs.existsSync(source) && fs.statSync(source).size > 1) {
      fs.copyFileSync(source, destination);
    }
  }
}

async function waitForServer(url, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/status`);
      if (response.ok) return;
    } catch {
      // The local server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("The local JERVIS core did not start.");
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function positionOrbWindow() {
  if (!orbWindow) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  const [orbWidth, orbHeight] = orbWindow.getSize();
  orbWindow.setPosition(x + width - orbWidth - 22, y + height - orbHeight - 18, false);
}

function createOrbWindow(url) {
  const window = new BrowserWindow({
    width: 340,
    height: 340,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.loadURL(`${url}/?orb=1`);
  window.webContents.once("did-finish-load", () => window.webContents.send("jervis:orb-state", lastOrbState));
  window.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
  });
  orbWindow = window;
  positionOrbWindow();
}

function createTray() {
  tray = new Tray(path.join(APP_ROOT, "assets", "jervis-icon.png"));
  tray.setToolTip("JERVIS - listening in the background");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open JERVIS", click: showMainWindow },
    { type: "separator" },
    { label: "Quit JERVIS", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", showMainWindow);
}

function createWindow(url) {
  const isTrustedOrigin = (candidate) => /^http:\/\/127\.0\.0\.1:(?:5173|8787)(?:\/|$)/.test(candidate || "");
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => (
    permission === "media" && isTrustedOrigin(requestingOrigin)
  ));
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(permission === "media" && isTrustedOrigin(details.requestingUrl));
  });
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 880,
    minHeight: 620,
    show: false,
    backgroundColor: "#080b0f",
    title: "JERVIS",
    icon: path.join(APP_ROOT, "assets", "jervis-icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
      spellcheck: true,
      backgroundThrottling: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (!destination.startsWith(url)) event.preventDefault();
  });
  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });
  window.loadURL(url);
  mainWindow = window;
  window.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  createOrbWindow(url);
  createTray();
}

function readDictationHotkey(dataDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    return config.dictation?.hotkey || "CommandOrControl+Alt+D";
  } catch {
    return "CommandOrControl+Alt+D";
  }
}

function setEscapeShortcut(active) {
  if (active && !escapeRegistered) {
    escapeRegistered = globalShortcut.register("Escape", () => mainWindow?.webContents.send("jervis:dictation-cancel"));
  } else if (!active && escapeRegistered) {
    globalShortcut.unregister("Escape");
    escapeRegistered = false;
  }
}

function pasteIntoForeground(text) {
  const value = String(text || "").slice(0, 50000);
  if (!value) return;
  clipboard.writeText(value);
  if (process.platform === "win32") {
    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 120; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"], { windowsHide: true, stdio: "ignore" });
  }
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

app.on("second-instance", () => {
  showMainWindow();
});

app.whenReady().then(async () => {
  try {
    const dataDir = app.getPath("userData");
    migrateCredentials(dataDir);
    process.env.JERVIS_DATA_DIR = dataDir;
    process.env.PORT = String(SERVER_PORT);
    if (app.isPackaged) {
      process.env.JERVIS_WHISPER_EXE = path.join(process.resourcesPath, "jervis-whisper.exe");
    }
    await import(pathToFileURL(path.join(APP_ROOT, "server.js")).href);
    const appUrl = isDev ? "http://127.0.0.1:5173" : `http://127.0.0.1:${SERVER_PORT}`;
    await waitForServer(`http://127.0.0.1:${SERVER_PORT}`);
    createWindow(appUrl);
    const requestedHotkey = readDictationHotkey(dataDir);
    const hotkeys = [...new Set([requestedHotkey, "CommandOrControl+Alt+D", "CommandOrControl+Shift+Space"])];
    const registeredHotkey = hotkeys.find((hotkey) => globalShortcut.register(hotkey, () => {
      shell.beep();
      mainWindow?.webContents.send("jervis:dictation-toggle");
    }));
    if (registeredHotkey) console.log(`JERVIS dictation shortcut: ${registeredHotkey}`);
    else console.error(`Could not register a dictation shortcut (tried ${hotkeys.join(", ")}).`);
  } catch (error) {
    console.error(error);
    dialog.showErrorBox("JERVIS could not start", error?.message || String(error));
    app.quit();
  }
});

ipcMain.on("jervis:dictation-state", (_event, active) => {
  setEscapeShortcut(Boolean(active));
  console.log(`JERVIS dictation: ${active ? "recording" : "stopped"}`);
});
ipcMain.on("jervis:paste-text", (_event, text) => pasteIntoForeground(text));
ipcMain.on("jervis:open-main", showMainWindow);
ipcMain.on("jervis:hide-main", () => mainWindow?.hide());
ipcMain.handle("jervis:window-state", () => ({
  mainVisible: Boolean(mainWindow?.isVisible()),
  orbVisible: Boolean(orbWindow?.isVisible()),
}));
ipcMain.on("jervis:orb-update", (_event, state) => {
  lastOrbState = {
    visible: Boolean(state?.visible),
    state: String(state?.state || "awake").slice(0, 32),
    level: Math.max(0, Math.min(1, Number(state?.level) || 0)),
  };
  if (!orbWindow || orbWindow.isDestroyed()) return;
  orbWindow.webContents.send("jervis:orb-state", lastOrbState);
  if (lastOrbState.visible) {
    positionOrbWindow();
    orbWindow.showInactive();
  } else {
    orbWindow.hide();
  }
});

app.on("window-all-closed", () => {});
app.on("before-quit", () => { isQuitting = true; });
app.on("will-quit", () => globalShortcut.unregisterAll());
