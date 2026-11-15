'use strict';

const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, dialog, shell,
  Tray, Menu, nativeImage, globalShortcut, screen
} = require('electron');
const path = require('path');
const fs = require('fs');

// Keep the recorder running at full speed even when its window is minimised or covered.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const ICON = path.join(__dirname, 'assets', 'icon.png');
const PRELOAD = path.join(__dirname, 'preload.js');

let mainWin = null;
let miniWin = null;
let tray = null;
let settings = null;
let uiState = 'idle';
let lastMini = { state: 'idle', sec: 0 };
let isQuitting = false;
let selected = { id: null, systemAudio: true };

let writer = null;
let currentFile = null;
let bytesWritten = 0;

/* ---------------------------------------------------------- settings -- */

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function defaultSettings() {
  return {
    outputDir: path.join(app.getPath('videos'), 'NV Screen Recorder'),
    fps: 30,
    quality: 'balanced',
    resolution: 'original',
    format: 'auto',
    countdown: 3,
    systemAudio: true,
    micAudio: true,
    micDeviceId: 'default'
  };
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { ...defaultSettings(), ...raw };
  } catch (_) {
    return defaultSettings();
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (_) { /* non-fatal */ }
}

/* ----------------------------------------------------------- windows -- */

function isRecordingState() {
  return uiState === 'recording' || uiState === 'paused';
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 640,
    height: 800,
    minWidth: 540,
    minHeight: 660,
    show: false,
    backgroundColor: '#0e1118',
    title: 'NV Screen Recorder',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  mainWin.setMenu(null);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());

  mainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWin.on('close', (e) => {
    // Never lose a recording because the window was closed: hide to tray instead.
    if (!isQuitting && (isRecordingState() || uiState === 'prepare' || uiState === 'countdown')) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function showMini() {
  if (miniWin && !miniWin.isDestroyed()) {
    if (!miniWin.isVisible()) miniWin.showInactive();
    return;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 310;
  const h = 52;
  miniWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(wa.x + wa.width / 2 - w / 2),
    y: wa.y + 8,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'NV Recorder Bar',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  miniWin.setAlwaysOnTop(true, 'screen-saver');
  // Keeps the control bar out of the recording itself (Windows 10 2004+).
  miniWin.setContentProtection(true);
  miniWin.loadFile(path.join(__dirname, 'renderer', 'mini.html'));
  miniWin.webContents.on('did-finish-load', () => sendMini(lastMini));
  miniWin.once('ready-to-show', () => { if (miniWin && !miniWin.isDestroyed()) miniWin.showInactive(); });
  miniWin.on('closed', () => { miniWin = null; });
}

function closeMini() {
  if (miniWin && !miniWin.isDestroyed()) miniWin.close();
  miniWin = null;
}

function sendMini(payload) {
  if (miniWin && !miniWin.isDestroyed() && !miniWin.webContents.isLoading()) {
    miniWin.webContents.send('mini:update', payload);
  }
}

/* -------------------------------------------------------------- tray -- */

function buildTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', showMain);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const rec = isRecordingState();
  tray.setToolTip(rec ? (uiState === 'paused' ? 'NV Screen Recorder - Paused' : 'NV Screen Recorder - Recording') : 'NV Screen Recorder');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show NV Screen Recorder', click: showMain },
    { type: 'separator' },
    { label: rec ? 'Stop recording (Ctrl+Shift+R)' : 'Start recording (Ctrl+Shift+R)', click: () => runCmd('toggle') },
    { label: uiState === 'paused' ? 'Resume (Ctrl+Shift+P)' : 'Pause (Ctrl+Shift+P)', enabled: rec, click: () => runCmd('pause') },
    { type: 'separator' },
    { label: 'Quit', click: quitApp }
  ]));
}

/* ---------------------------------------------------- commands to UI -- */

// Runs a command inside the recorder page. userGesture=true lets Chromium
// accept the screen-capture request even when it came from a hotkey or tray.
function runCmd(cmd) {
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.webContents
    .executeJavaScript(`window.nvCmd && window.nvCmd(${JSON.stringify(cmd)})`, true)
    .catch(() => {});
}

function quitApp() {
  if (isRecordingState()) {
    isQuitting = true;
    runCmd('stop');
    setTimeout(() => app.exit(0), 10000); // failsafe if saving takes too long
  } else {
    isQuitting = true;
    app.quit();
  }
}

/* --------------------------------------------------------------- IPC -- */

function pad(n) { return String(n).padStart(2, '0'); }

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({ version: app.getVersion() }));

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    settings = { ...settings, ...(patch || {}) };
    saveSettings();
    return settings;
  });

  ipcMain.handle('dir:choose', async () => {
    const res = await dialog.showOpenDialog(mainWin, {
      title: 'Choose where recordings are saved',
      defaultPath: settings.outputDir,
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    settings.outputDir = res.filePaths[0];
    saveSettings();
    return settings.outputDir;
  });

  ipcMain.handle('dir:open', async () => {
    try { fs.mkdirSync(settings.outputDir, { recursive: true }); } catch (_) {}
    return shell.openPath(settings.outputDir);
  });

  ipcMain.handle('sources:list', async () => {
    const list = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    });
    return list
      .filter((s) => s.name !== 'NV Recorder Bar')
      .map((s) => ({
        id: s.id,
        name: s.name,
        isScreen: s.id.startsWith('screen:'),
        thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : ''
      }))
      .sort((a, b) => Number(b.isScreen) - Number(a.isScreen));
  });

  ipcMain.handle('source:select', (_e, id, systemAudio) => {
    selected = { id, systemAudio: !!systemAudio };
    return true;
  });

  ipcMain.handle('rec:start', (_e, ext) => {
    const dir = settings.outputDir;
    fs.mkdirSync(dir, { recursive: true });
    currentFile = path.join(dir, `NV_Recording_${stamp()}.${ext === 'webm' ? 'webm' : 'mp4'}`);
    bytesWritten = 0;
    writer = fs.createWriteStream(currentFile);
    writer.on('error', (err) => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('rec:error', err.message);
    });
    return currentFile;
  });

  // Chunks are streamed straight to disk, so memory use stays flat however long you record.
  ipcMain.on('rec:chunk', (_e, data) => {
    if (!writer) return;
    const buf = Buffer.from(data);
    bytesWritten += buf.length;
    writer.write(buf);
  });

  ipcMain.handle('rec:stop', () => new Promise((resolve) => {
    if (!writer) return resolve(null);
    const file = currentFile;
    const w = writer;
    writer = null;
    w.end(() => resolve({ path: file, size: bytesWritten }));
  }));

  ipcMain.handle('rec:abort', () => new Promise((resolve) => {
    if (!writer) return resolve(true);
    const file = currentFile;
    const w = writer;
    writer = null;
    w.end(() => {
      try { fs.unlinkSync(file); } catch (_) {}
      resolve(true);
    });
  }));

  ipcMain.handle('file:open', (_e, p) => shell.openPath(p));
  ipcMain.handle('file:reveal', (_e, p) => { shell.showItemInFolder(p); return true; });

  ipcMain.on('ui:state', (_e, s) => {
    uiState = s.state === 'prepare' ? 'prepare' : s.state;
    lastMini = s;

    if (s.state === 'prepare') {
      if (mainWin && !mainWin.isDestroyed()) mainWin.minimize();
      showMini();
    } else if (s.state === 'countdown' || s.state === 'recording' || s.state === 'paused') {
      showMini();
    } else if (s.state === 'idle') {
      closeMini();
      showMain();
      if (isQuitting) app.quit();
    }
    sendMini(s);
    updateTray();
  });

  ipcMain.on('mini:cmd', (_e, cmd) => {
    if (cmd === 'pause' || cmd === 'stop') runCmd(cmd);
  });
}

/* --------------------------------------------------------- lifecycle -- */

app.on('second-instance', showMain);

app.whenReady().then(() => {
  settings = loadSettings();

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'audioCapture', 'videoCapture'].includes(permission));
  });

  // The recorder page asks for the screen; we hand it the source chosen in our own picker.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 }
      });
      const src = sources.find((s) => s.id === selected.id) || sources.find((s) => s.id.startsWith('screen:'));
      if (!src) return callback({});
      const response = { video: src };
      if (selected.systemAudio) response.audio = 'loopback';
      callback(response);
    } catch (_) {
      callback({});
    }
  });

  registerIpc();
  createMainWindow();
  buildTray();

  globalShortcut.register('CommandOrControl+Shift+R', () => runCmd('toggle'));
  globalShortcut.register('CommandOrControl+Shift+P', () => runCmd('pause'));
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
