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
let orbShapeRects = 0;

app.setName("JARVIS");

function migrateLegacyData(dataDir) {
  const legacyDir = path.join(path.dirname(dataDir), "JERVIS");
  if (legacyDir.toLowerCase() === dataDir.toLowerCase() || !fs.existsSync(legacyDir)) return;
  if (!fs.existsSync(dataDir)) {
    fs.renameSync(legacyDir, dataDir);
    return;
  }
  for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
    const destination = path.join(dataDir, entry.name);
    if (!fs.existsSync(destination)) fs.cpSync(path.join(legacyDir, entry.name), destination, { recursive: entry.isDirectory() });
  }
}

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
  throw new Error("The local JARVIS core did not start.");
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

function circularWindowShape(size, margin = 2) {
  const radius = size / 2 - margin;
  const center = size / 2;
  const rectangles = [];
  for (let y = margin; y < size - margin; y += 1) {
    const distance = y + 0.5 - center;
    const halfWidth = Math.sqrt(Math.max(0, radius * radius - distance * distance));
    const x = Math.max(margin, Math.floor(center - halfWidth));
    const right = Math.min(size - margin, Math.ceil(center + halfWidth));
    if (right > x) rectangles.push({ x, y, width: right - x, height: 1 });
  }
  return rectangles;
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
  if (typeof window.setShape === "function") {
    const shape = circularWindowShape(340);
    window.setShape(shape);
    orbShapeRects = shape.length;
  }
  window.loadURL(`${url}/?orb=1`);
  window.webContents.once("did-finish-load", () => window.webContents.send("jarvis:orb-state", lastOrbState));
  window.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
  });
  orbWindow = window;
  positionOrbWindow();
}

function createTray() {
  tray = new Tray(path.join(APP_ROOT, "assets", "jarvis-icon.png"));
  tray.setToolTip("JARVIS - listening in the background");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open JARVIS", click: showMainWindow },
    { type: "separator" },
    { label: "Quit JARVIS", click: () => { isQuitting = true; app.quit(); } },
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
    title: "JARVIS",
    icon: path.join(APP_ROOT, "assets", "jarvis-icon.png"),
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
    escapeRegistered = globalShortcut.register("Escape", () => mainWindow?.webContents.send("jarvis:dictation-cancel"));
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
    migrateLegacyData(dataDir);
    migrateCredentials(dataDir);
    process.env.JARVIS_DATA_DIR = dataDir;
    process.env.PORT = String(SERVER_PORT);
    if (app.isPackaged) {
      process.env.JARVIS_WHISPER_EXE = path.join(process.resourcesPath, "jarvis-whisper.exe");
    }
    await import(pathToFileURL(path.join(APP_ROOT, "server.js")).href);
    const appUrl = isDev ? "http://127.0.0.1:5173" : `http://127.0.0.1:${SERVER_PORT}`;
    await waitForServer(`http://127.0.0.1:${SERVER_PORT}`);
    createWindow(appUrl);
    const requestedHotkey = readDictationHotkey(dataDir);
    const hotkeys = [...new Set([requestedHotkey, "CommandOrControl+Alt+D", "CommandOrControl+Shift+Space"])];
    const registeredHotkey = hotkeys.find((hotkey) => globalShortcut.register(hotkey, () => {
      shell.beep();
      mainWindow?.webContents.send("jarvis:dictation-toggle");
    }));
    if (registeredHotkey) console.log(`JARVIS dictation shortcut: ${registeredHotkey}`);
    else console.error(`Could not register a dictation shortcut (tried ${hotkeys.join(", ")}).`);
  } catch (error) {
    console.error(error);
    dialog.showErrorBox("JARVIS could not start", error?.message || String(error));
    app.quit();
  }
});

ipcMain.on("jarvis:dictation-state", (_event, active) => {
  setEscapeShortcut(Boolean(active));
  console.log(`JARVIS dictation: ${active ? "recording" : "stopped"}`);
});
ipcMain.on("jarvis:paste-text", (_event, text) => pasteIntoForeground(text));
ipcMain.on("jarvis:open-main", showMainWindow);
ipcMain.on("jarvis:hide-main", () => mainWindow?.hide());
ipcMain.handle("jarvis:window-state", () => ({
  mainVisible: Boolean(mainWindow?.isVisible()),
  orbVisible: Boolean(orbWindow?.isVisible()),
  orbShapeRects,
}));
ipcMain.on("jarvis:orb-update", (_event, state) => {
  lastOrbState = {
    visible: Boolean(state?.visible),
    state: String(state?.state || "awake").slice(0, 32),
    level: Math.max(0, Math.min(1, Number(state?.level) || 0)),
  };
  if (!orbWindow || orbWindow.isDestroyed()) return;
  orbWindow.webContents.send("jarvis:orb-state", lastOrbState);
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
