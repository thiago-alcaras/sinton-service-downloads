const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const SITE_URL = 'https://sinton-tv.onrender.com/';
const SITE_ORIGIN = new URL(SITE_URL).origin;
const SERVICE_ORIGIN = 'http://127.0.0.1:11472';
let serviceProcess;
let mainWindow;
let serviceOwned = false;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start);
}

async function start() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Sinton', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Exibir', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }] },
    { label: 'Ajuda', submenu: [{ label: 'Abrir Sinton Web', click: () => shell.openExternal(SITE_URL) }] },
  ]));

  try { await ensureService(); }
  catch {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Serviço Sinton',
      message: 'O serviço local não iniciou.',
      detail: 'O Sinton abrirá normalmente. Feche outros aplicativos que possam usar a porta 11472 e reinicie o aplicativo para tentar novamente.',
      buttons: ['Continuar'],
    });
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#080d16',
    title: 'Sinton',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'sinton.ico' : 'sinton.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const permissions = mainWindow.webContents.session;
  const localPermissions = new Set(['local-network', 'local-network-access', 'loopback-network']);
  permissions.setPermissionRequestHandler((webContents, permission, callback, details) => {
    let requestingOrigin = '';
    try { requestingOrigin = new URL(details?.requestingUrl || webContents.getURL()).origin; } catch {}
    callback(requestingOrigin === SITE_ORIGIN && localPermissions.has(permission));
  });
  permissions.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    let origin = requestingOrigin;
    try { if (details?.requestingUrl) origin = new URL(details.requestingUrl).origin; } catch { return false; }
    return origin === SITE_ORIGIN && localPermissions.has(permission);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    let url;
    try { url = new URL(target); } catch { event.preventDefault(); return; }
    const allowed = url.origin === SITE_ORIGIN || (url.protocol === 'https:' && (url.hostname === 'accounts.google.com' || url.hostname.endsWith('.google.com')));
    if (!allowed) {
      event.preventDefault();
      if (url.protocol === 'https:') shell.openExternal(url.href);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') dialog.showErrorBox('Sinton', 'A interface foi reiniciada. Feche e abra o Sinton novamente se o problema continuar.');
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  await mainWindow.loadURL(SITE_URL);
}

async function serviceHealth() {
  const response = await fetch(`${SERVICE_ORIGIN}/health`, {
    headers: { Origin: SITE_ORIGIN },
    signal: AbortSignal.timeout(1200),
  });
  if (!response.ok) throw new Error('Serviço indisponível');
  const data = await response.json();
  if (!data.ok || data.service !== 'sinton-local') throw new Error('Outro serviço está usando a porta local');
  return data;
}

async function ensureService() {
  try { await serviceHealth(); return; } catch {}
  const resources = process.resourcesPath;
  const serviceRoot = path.join(resources, 'sinton-service');
  const entry = path.join(serviceRoot, 'server', 'local-service.js');
  const runtime = path.join(serviceRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin', ...(process.platform === 'win32' ? [] : ['node']));
  if (!fs.existsSync(entry) || !fs.existsSync(runtime)) throw new Error('Arquivos do serviço local ausentes');
  serviceProcess = spawn(runtime, [entry], {
    cwd: serviceRoot,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'production', ENABLE_TORRENTS: 'true', SINTON_SERVICE_PORT: '11472', SINTON_ALLOWED_ORIGINS: SITE_ORIGIN },
  });
  serviceOwned = true;
  serviceProcess.once('error', () => { serviceProcess = undefined; });
  serviceProcess.once('exit', () => { serviceProcess = undefined; });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!serviceProcess || serviceProcess.exitCode !== null) break;
    try { await serviceHealth(); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (serviceProcess && serviceProcess.exitCode === null) {
    serviceProcess.kill();
    serviceProcess = undefined;
  }
  // If an older service won the race to the port, allow the web UI to explain its status.
  await serviceHealth();
  serviceOwned = false;
}

app.on('before-quit', () => {
  if (serviceOwned && serviceProcess && serviceProcess.exitCode === null) serviceProcess.kill();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) start(); });
