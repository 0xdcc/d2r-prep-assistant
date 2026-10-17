'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { JobEngine } = require('./engine/jobs');
const { loadManifest, targetMatrix } = require('./engine/manifest');
const { validateRequest } = require('./engine/ipc-schema');
const { assert } = require('./engine/errors');
const { directory, noLinks, regularFile } = require('./engine/paths');
const { redact, exportNewLog } = require('./engine/log');

const LINKS = Object.freeze({
  signing: 'https://sideloadly.io/',
  python: 'https://www.python.org/downloads/',
  dotnet: 'https://dotnet.microsoft.com/en-us/download/dotnet',
  llvm: 'https://releases.llvm.org/',
  spirv: 'https://github.com/KhronosGroup/SPIRV-Cross/releases/tag/vulkan-sdk-1.4.357.0',
  upstream: 'https://github.com/d2r-mobile/d2r-mobile',
  xcode: 'https://developer.apple.com/xcode/'
});
const rendererRoot = path.join(__dirname, 'renderer');
const entryUrl = pathToFileURL(path.join(rendererRoot, 'index.html')).href;
const root = path.resolve(__dirname, '..');
const cache = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'D2RPrepAssistant') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'D2R Prep Assistant') : path.join(os.homedir(), '.cache', 'd2r-prep-assistant');
app.setPath('userData', cache);
app.setName('D2R Prep Assistant');
let window;
let engine;
let manifest;
let allowQuit = false;
let closing = false;
let pickerBusy = false;
const selections = new Map();

function selected(token, kind) {
  if (token === null) return null;
  const record = selections.get(token);
  assert(record?.kind === kind, 'SELECTION', 'Choose this folder using the native picker first.');
  return record.path;
}

async function chooseFolder(kind) {
  assert(!engine.busy && !pickerBusy, 'BUSY', 'Wait for the current operation or folder dialog.');
  pickerBusy = true;
  try {
    const result = await dialog.showOpenDialog(window, { title: kind === 'input' ? 'Choose own-files folder · ExeFS + RomFS' : 'Choose output folder', properties: ['openDirectory', ...(kind === 'output' ? ['createDirectory'] : [])] });
    if (result.canceled) return null;
    const chosen = await directory(result.filePaths[0]);
    const token = crypto.randomUUID();
    for (const [oldToken, record] of selections) if (record.kind === kind) selections.delete(oldToken);
    selections.set(token, { kind, path: chosen });
    return { token, path: chosen };
  } finally { pickerBusy = false; }
}

async function request(method, payload) {
  validateRequest(method, payload);
  switch (method) {
    case 'bootstrap': return { product: 'D2R Prep Assistant', version: app.getVersion(), platform: process.platform, arch: process.arch, cache, matrix: targetMatrix(process.platform, process.arch, manifest), manifest: { status: manifest.status, reason: manifest.reason || '', targets: manifest.targets.map(target => ({ id: target.id, commit: target.sourceCommit, sourceBytes: target.source.bytes, shellBytes: target.shell.bytes })) }, state: engine.snapshot() };
    case 'chooseFolder': return chooseFolder(payload.kind);
    case 'startJob': {
      assert(!pickerBusy, 'BUSY', 'Close the folder dialog first.');
      return engine.start(payload.kind, { target: payload.target, input: selected(payload.inputToken, 'input'), output: selected(payload.outputToken, 'output'), consent: payload.consent });
    }
    case 'cancel': return engine.cancel();
    case 'snapshot': return engine.snapshot();
    case 'openHelp': {
      const result = await dialog.showMessageBox(window, { type: 'info', title: 'Open official website / 打开官方网站', message: LINKS[payload.id], detail: 'This opens your browser. No local files are uploaded. Signing is separate; certificates may expire. / 将打开浏览器，不上传本地文件。签名独立进行，证书可能到期。', buttons: ['Cancel / 取消', 'Open / 打开'], defaultId: 0, cancelId: 0 });
      if (result.response === 1) await shell.openExternal(LINKS[payload.id]);
      return { opened: result.response === 1 };
    }
    case 'revealResult': {
      const state = engine.snapshot();
      assert(!engine.busy && state.status === 'succeeded' && state.kind === 'prepare' && state.result?.path, 'NO_RESULT', 'No verified IPA is available.');
      await regularFile(state.result.path);
      shell.showItemInFolder(state.result.path);
      return { revealed: true };
    }
    case 'exportLog': {
      assert(!engine.busy && engine.lastLog, 'NO_LOG', 'Wait for an operation to finish before exporting logs.');
      const result = await dialog.showOpenDialog(window, { title: 'Choose log folder — creates a new unique file / 选择日志文件夹：新建唯一文件，不覆盖', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled) return { exported: false };
      const contents = redact(await fs.readFile(engine.lastLog.filename, 'utf8'), [...selections.values()].map(record => record.path));
      const destination = await exportNewLog(result.filePaths[0], contents);
      return { exported: true, path: destination };
    }
    default: throw new Error('Unreachable IPC method.');
  }
}

async function createWindow() {
  window = new BrowserWindow({ width: 1200, height: 850, minWidth: 880, minHeight: 690, backgroundColor: '#f7f5f0', title: 'D2R Prep Assistant', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', async event => {
    if (allowQuit || !engine.busy) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      const result = await dialog.showMessageBox(window, { type: 'warning', message: 'Cancel operation and quit? / 取消任务并退出？', detail: 'Child processes will be stopped and job staging removed. Your originals remain unchanged. / 将停止子进程并清理暂存，不修改原始文件。', buttons: ['Keep running / 继续运行', 'Cancel and quit / 取消并退出'], defaultId: 0, cancelId: 0 });
      if (result.response === 1) { await engine.cancel(); allowQuit = true; app.quit(); }
    } finally { closing = false; }
  });
  await window.loadFile(path.join(rendererRoot, 'index.html'));
}

app.whenReady().then(async () => {
  manifest = loadManifest(path.join(root, 'manifests', 'upstream.json'));
  engine = new JobEngine({ cache, manifest });
  await engine.initialize();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const filename = fileURLToPath(details.url);
      allowed = ['index.html', 'styles.css', 'app.js'].some(name => filename === path.join(rendererRoot, name));
    } catch { allowed = false; }
    callback({ cancel: !allowed });
  });
  ipcMain.handle('prep:request', async (event, method, payload) => {
    try {
      assert(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === entryUrl, 'IPC_SENDER', 'Untrusted IPC sender.');
      return { ok: true, value: await request(method, payload) };
    } catch (error) { return { ok: false, error: { code: error.code || 'ERROR', message: redact(error.message, [cache]) } }; }
  });
  engine.on('event', event => { if (window && !window.isDestroyed()) window.webContents.send('prep:event', event); });
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => { dialog.showErrorBox('D2R Prep Assistant', redact(error.message, [cache])); app.exit(1); });

app.on('before-quit', event => {
  if (engine?.busy && !allowQuit) {
    event.preventDefault();
    if (window && !window.isDestroyed()) window.close();
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
