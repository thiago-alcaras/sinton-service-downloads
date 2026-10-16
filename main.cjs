const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { autoUpdater } = require('electron-updater');

const SITE_URL = 'https://sinton-tv.onrender.com/';
const SITE_ORIGIN = new URL(SITE_URL).origin;
const SERVICE_ORIGIN = 'http://127.0.0.1:11472';
let serviceProcess;
let mainWindow;
let serviceOwned = false;
let serviceStartError;

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
  catch (error) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Serviço Sinton',
      message: 'O serviço local não iniciou.',
      detail: `${error.message || 'Não foi possível iniciar o serviço de reprodução.'}\n\nO Sinton vai abrir normalmente, mas a reprodução local pode ficar indisponível. Nenhum outro processo será encerrado.`,
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
  checkForUpdates().catch(error => console.warn('Não foi possível verificar atualizações do Sinton:', error.message));
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
  serviceStartError = undefined;
  serviceProcess.once('error', error => { serviceStartError = error; serviceProcess = undefined; });
  serviceProcess.once('exit', (code, signal) => { if (code && !serviceStartError) serviceStartError = new Error(`O serviço foi encerrado durante a inicialização (código ${code}${signal ? `, ${signal}` : ''}).`); serviceProcess = undefined; });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!serviceProcess || serviceProcess.exitCode !== null) break;
    try { await serviceHealth(); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (serviceProcess && serviceProcess.exitCode === null) {
    serviceProcess.kill();
    serviceProcess = undefined;
  }
  // A valid service that won the port race is reusable. Never terminate an
  // unrelated process just because it owns the configured service port.
  try { await serviceHealth(); serviceOwned = false; return; }
  catch (error) {
    if (serviceStartError?.code === 'EADDRINUSE' || /address already in use|EADDRINUSE/i.test(serviceStartError?.message || '')) {
      throw new Error('A porta local 11472 já está em uso por outro serviço. Feche esse serviço ou altere sua porta e abra o Sinton novamente.');
    }
    if (serviceStartError) throw new Error(`O processo do serviço não pôde iniciar: ${serviceStartError.message}`);
    throw new Error(`O serviço não respondeu em 10 segundos na porta 11472 (${error.message}).`);
  }
}

async function checkForUpdates() {
  const cachePath = path.join(app.getPath('userData'), 'update-check.json');
  let releases;
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Date.now() - cached.checkedAt < 12 * 60 * 60 * 1000 && Array.isArray(cached.releases)) releases = cached.releases;
  } catch {}
  if (!releases) {
    const response = await fetch('https://api.github.com/repos/thiago-alcaras/sinton-service-downloads/releases?per_page=50', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sinton-Desktop-Updater' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`GitHub respondeu ${response.status}`);
    releases = await response.json();
    try { fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: Date.now(), releases })); } catch {}
  }
  const current = app.getVersion();
  const versioned = releases
    .filter(release => !release.draft && /^v\d+\.\d+\.\d+$/.test(release.tag_name || '') && (release.assets || []).some(asset => asset.name.startsWith(`Sinton-Setup-${release.tag_name.slice(1)}-`) || asset.name.startsWith(`Sinton-${release.tag_name.slice(1)}-`)))
    .map(release => ({ ...release, version: release.tag_name.slice(1) }))
    .sort((left, right) => compareVersions(right.version, left.version));
  const latest = versioned[0];
  if (!latest || compareVersions(latest.version, current) <= 0) return;
  const reminderPath = path.join(app.getPath('userData'), 'update-reminder.json');
  try { if (JSON.parse(fs.readFileSync(reminderPath, 'utf8')).version === latest.version) return; } catch {}

  if (process.platform === 'win32') {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `https://github.com/thiago-alcaras/sinton-service-downloads/releases/download/${encodeURIComponent(latest.tag_name)}/`,
    });
    autoUpdater.on('error', error => console.warn('Atualizador do Sinton:', error.message));
    autoUpdater.on('update-downloaded', async () => {
      if (!mainWindow) return;
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'Atualização do Sinton pronta',
        message: `A versão ${latest.version} já foi baixada.`,
        detail: 'Reinicie agora para concluir a atualização ou escolha Depois para instalar ao fechar o aplicativo.',
        buttons: ['Reiniciar agora', 'Depois'], defaultId: 0, cancelId: 1,
      });
      if (choice.response === 0) autoUpdater.quitAndInstall();
    });
    await autoUpdater.checkForUpdates();
    return;
  }

  // The current macOS releases are unsigned. We can detect a new version and
  // open the right installer, but macOS requires an Apple signing identity for
  // silent in-place installation.
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const asset = latest.assets.find(item => item.name === `Sinton-${latest.version}-${arch}.dmg`);
  if (!asset || !mainWindow) return;
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'info', title: 'Atualização do Sinton disponível',
    message: `A versão ${latest.version} está disponível.`,
    detail: 'No macOS, a instalação automática exige um certificado Apple Developer. Baixe o instalador para atualizar.',
    buttons: ['Baixar atualização', 'Depois'], defaultId: 0, cancelId: 1,
  });
  if (choice.response === 0) shell.openExternal(asset.browser_download_url);
  else try { fs.writeFileSync(reminderPath, JSON.stringify({ version: latest.version })); } catch {}
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

app.on('before-quit', () => {
  if (serviceOwned && serviceProcess && serviceProcess.exitCode === null) serviceProcess.kill();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) start(); });
