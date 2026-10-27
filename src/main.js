const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu, clipboard, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');
const fetch = require('cross-fetch');
const { FALLBACK_FILTERS, resourceTypes, classifyBlocked } = require('./filtering');

let mainWindow = null;
let dataFile = null;
let passwordFile = null;
let passwordVault = [];
let passwordStorageAvailable = false;
let passwordStorageReason = 'Password storage has not initialized yet.';
let blocker = null;
let blockerReady = false;
const configuredSessions = new WeakSet();
const privateWindows = new Set();
const stats = { total: 0, ads: 0, trackers: 0, bySite: {}, recent: [] };
let allowlist = new Set();
let enabled = true;
let browserData = {
  bookmarks: [],
  history: [],
  downloads: [],
  extensions: [],
  permissions: {},
  sessionTabs: [],
  settings: {
    searchEngine: 'duckduckgo',
    homePage: 'shark://home',
    restoreSession: true,
    blockAds: true
  }
};


function passwordStorageStatus() {
  return { available: passwordStorageAvailable, reason: passwordStorageReason, count: passwordVault.length };
}
async function initializePasswordVault() {
  try {
    passwordStorageAvailable = await safeStorage.isAsyncEncryptionAvailable();
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      passwordStorageAvailable = false;
      passwordStorageReason = 'A system keyring is unavailable. Shark will not store passwords unencrypted.';
      return;
    }
    if (!passwordStorageAvailable) {
      passwordStorageReason = 'The operating system key store is unavailable. Shark will not store passwords unencrypted.';
      return;
    }
    passwordStorageReason = 'Passwords are encrypted with the operating system key store.';
    try {
      const bytes = await fs.promises.readFile(passwordFile);
      const decrypted = await safeStorage.decryptStringAsync(bytes);
      passwordVault = JSON.parse(decrypted.result);
      if (!Array.isArray(passwordVault)) throw new Error('Invalid password vault format');
      passwordVault = passwordVault.filter(item => item && typeof item.id === 'string' && typeof item.origin === 'string' && typeof item.username === 'string' && typeof item.password === 'string');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        passwordStorageAvailable = false;
        passwordStorageReason = 'The encrypted password vault could not be unlocked. The existing file was left untouched.';
        console.error('Password vault could not be unlocked:', error.message);
      }
    }
  } catch (error) {
    passwordStorageAvailable = false;
    passwordStorageReason = 'Secure password storage is unavailable on this system.';
    console.warn(passwordStorageReason, error.message);
  }
}
function canSavePasswordOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname));
  } catch { return false; }
}
function publicPassword(item) {
  return { id: item.id, origin: item.origin, username: item.username, addedAt: item.addedAt, updatedAt: item.updatedAt };
}
async function persistPasswordVault() {
  if (!passwordStorageAvailable) throw new Error(passwordStorageReason);
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(passwordVault));
  const temp = passwordFile + '.tmp';
  await fs.promises.writeFile(temp, encrypted, { mode: 0o600 });
  await fs.promises.rename(temp, passwordFile);
}
async function readPasswordVault() {
  if (!passwordStorageAvailable) return { ok: false, error: passwordStorageReason, entries: [] };
  return { ok: true, status: passwordStorageStatus(), entries: passwordVault.map(publicPassword) };
}


function publicExtension(entry) {
  return { id: entry.id, name: entry.name, version: entry.version, manifestVersion: entry.manifestVersion, enabled: Boolean(entry.enabled), error: entry.error || '' };
}
async function loadSavedExtensions() {
  const ses = session.fromPartition('persist:shark');
  for (const entry of browserData.extensions) {
    if (!entry || !entry.path) continue;
    try {
      const manifest = JSON.parse(await fs.promises.readFile(path.join(entry.path, 'manifest.json'), 'utf8'));
      const extension = await ses.extensions.loadExtension(entry.path, { allowFileAccess: false });
      Object.assign(entry, {
        id: extension.id,
        name: String(manifest.name || extension.name || 'Extension').slice(0, 200),
        version: String(manifest.version || extension.version || '').slice(0, 40),
        manifestVersion: Number(manifest.manifest_version) || 0,
        enabled: true,
        error: ''
      });
    } catch (error) {
      entry.enabled = false;
      entry.error = String(error.message || 'Could not load extension').slice(0, 500);
      console.warn('Could not load extension', entry.name, error.message);
    }
  }
  saveState();
}

function isWebUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
function safeHostname(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
function isDomain(host, domain) { return host === domain || host.endsWith('.' + domain); }
function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    allowlist = new Set(Array.isArray(state.allowlist) ? state.allowlist : []);
    enabled = state.enabled !== false;
    Object.assign(stats, state.stats || {});
    browserData = { ...browserData, ...(state.browserData || {}) };
    browserData.bookmarks = Array.isArray(browserData.bookmarks) ? browserData.bookmarks : [];
    browserData.history = Array.isArray(browserData.history) ? browserData.history.slice(0, 1000) : [];
    browserData.downloads = Array.isArray(browserData.downloads) ? browserData.downloads.slice(0, 300) : [];
    browserData.extensions = Array.isArray(browserData.extensions) ? browserData.extensions.slice(0, 100) : [];
    browserData.permissions = browserData.permissions || {};
    browserData.sessionTabs = Array.isArray(browserData.sessionTabs) ? browserData.sessionTabs : [];
    browserData.settings = { ...browserData.settings, ...(state.browserData?.settings || {}) };
  } catch {}
}
function saveState() {
  if (!dataFile) return;
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify({ allowlist: [...allowlist], enabled, stats, browserData }, null, 2), { mode: 0o600 });
  } catch (error) { console.error('Could not save Shark state:', error.message); }
}
function emitStats() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('blocking:stats', { ...stats, enabled, allowlist: [...allowlist], blockerReady });
  }
}
function recordBlock(details, category, domain) {
  const pageHost = safeHostname(details.referrer) || 'unknown';
  stats.total++;
  if (category === 'ad') stats.ads++; else stats.trackers++;
  stats.bySite[pageHost] ||= { total: 0, ads: 0, trackers: 0 };
  stats.bySite[pageHost].total++;
  stats.bySite[pageHost][category === 'ad' ? 'ads' : 'trackers']++;
  stats.recent.unshift({ url: String(details.url).slice(0, 500), domain, category, site: pageHost, time: Date.now() });
  stats.recent = stats.recent.slice(0, 100);
  if (stats.total % 5 === 0) saveState();
  emitStats();
}
function configureSession(ses, isPrivate) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);

  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!enabled || !blocker || !details.url.startsWith('http')) return callback({});
    const pageHost = safeHostname(details.referrer);
    if (pageHost && [...allowlist].some(domain => isDomain(pageHost, domain))) return callback({});
    try {
      const request = Request.fromRawDetails({
        url: details.url,
        type: resourceTypes[details.resourceType] || 'other',
        sourceUrl: details.referrer || undefined
      });
      const result = blocker.match(request);
      if (result && result.match) {
        const { category, domain } = classifyBlocked(details.url);
        // Never persist or expose request URLs originating in private windows.
        if (!isPrivate) recordBlock(details, category, domain);
        return callback({ cancel: true });
      }
    } catch (error) {
      console.warn('Ad/tracker filter match failed:', error.message);
    }
    callback({});
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const host = safeHostname(requestingOrigin || webContents?.getURL?.());
    return Boolean(host && browserData.permissions[host]?.[permission] === true);
  });
  ses.setPermissionRequestHandler(async (webContents, permission, callback, details) => {
    const url = details?.requestingUrl || webContents?.getURL?.() || '';
    const host = safeHostname(url);
    const safePermissions = new Set(['media', 'geolocation', 'notifications', 'clipboard-read', 'display-capture']);
    if (!host || !safePermissions.has(permission)) return callback(false);
    const prior = browserData.permissions[host]?.[permission];
    if (prior === true || prior === false) return callback(prior);
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.fromWebContents(webContents?.hostWebContents || webContents);
    const permissionDialog = {
      type: 'question',
      title: 'Shark Browser — site permission',
      message: host + ' is requesting permission',
      detail: 'Permission requested: ' + permission + '. Allow this only if you trust this website.',
      buttons: ['Block', 'Allow'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    };
    const choice = await (win ? dialog.showMessageBox(win, permissionDialog) : dialog.showMessageBox(permissionDialog)).catch(() => ({ response: 0 }));
    const allow = choice.response === 1;
    if (!isPrivate) {
      browserData.permissions[host] ||= {};
      browserData.permissions[host][permission] = allow;
      saveState();
    }
    callback(allow);
  });

  ses.on('will-download', async (_event, item, sourceContents) => {
    const filename = path.basename(item.getFilename() || 'download');
    const source = (() => { try { return new URL(item.getURL()).origin; } catch { return ''; } })();
    item.pause();
    const ownerWindow = BrowserWindow.fromWebContents(sourceContents?.hostWebContents || sourceContents);
    const saveOptions = { title: 'Save download', defaultPath: path.join(app.getPath('downloads'), filename) };
    const save = await (ownerWindow ? dialog.showSaveDialog(ownerWindow, saveOptions) : dialog.showSaveDialog(saveOptions)).catch(() => ({ canceled: true }));
    if (save.canceled || !save.filePath) { item.cancel(); return; }
    item.setSavePath(save.filePath);
    const record = {
      id: crypto.randomUUID(),
      filename,
      path: save.filePath,
      source,
      state: 'in-progress',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
      finishedAt: null
    };
    const publish = () => {
      if (isPrivate) return;
      const index = browserData.downloads.findIndex(entry => entry.id === record.id);
      if (index < 0) browserData.downloads.unshift({ ...record });
      else browserData.downloads[index] = { ...record };
      browserData.downloads = browserData.downloads.slice(0, 300);
      saveState();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('downloads:changed', browserData.downloads);
    };
    if (!isPrivate) publish();
    item.on('updated', (_event, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      if (state === 'interrupted') record.state = 'interrupted';
      publish();
    });
    item.once('done', (_event, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
      record.finishedAt = Date.now();
      publish();
      if (mainWindow && !mainWindow.isDestroyed() && !isPrivate) {
        mainWindow.webContents.send('browser:toast', record.state === 'completed' ? 'Download complete: ' + filename : 'Download ' + record.state + ': ' + filename);
      }
    });
    item.resume();
  });

  ses.on('spellcheck-dictionary-download-begin', () => {});
}

async function initializeBlocker() {
  const cachePath = path.join(app.getPath('userData'), 'adblocker-cache.bin');
  // Restore a previously compiled filter database first, so a disconnected
  // first launch after an upgrade still gets its last working filter lists.
  try {
    const cached = await fs.promises.readFile(cachePath);
    blocker = ElectronBlocker.deserialize(cached);
    blockerReady = true;
    emitStats();
    console.log('Shark loaded its cached ad/tracker filter database.');
  } catch {}

  const refresh = async () => {
    try {
      const fresh = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
      await fs.promises.writeFile(cachePath + '.tmp', fresh.serialize());
      await fs.promises.rename(cachePath + '.tmp', cachePath);
      blocker = fresh;
      blockerReady = true;
      emitStats();
      console.log('Shark refreshed EasyList-compatible ad/tracker filters.');
      scheduleFilterRefresh(24 * 60 * 60 * 1000);
    } catch (error) {
      console.warn('Filter-list refresh failed; keeping the last working blocker:', error.message);
      scheduleFilterRefresh(60 * 60 * 1000);
    }
  };
  refresh();
}
let filterRefreshTimer = null;
function scheduleFilterRefresh(delayMs) {
  if (filterRefreshTimer) clearTimeout(filterRefreshTimer);
  filterRefreshTimer = setTimeout(() => initializeBlocker(), delayMs);
  if (typeof filterRefreshTimer.unref === 'function') filterRefreshTimer.unref();
}



function routeGuestShortcut(contents, event, input) {
  if (input.type !== 'keyDown') return;
  const key = String(input.key || '').toLowerCase();
  const mod = Boolean(input.control || input.meta);
  let command = null;
  if (mod && key === 'tab') command = input.shift ? 'previous-tab' : 'next-tab';
  else if (input.alt && key === 'arrowleft') command = 'back';
  else if (input.alt && key === 'arrowright') command = 'forward';
  if (!command) return;
  event.preventDefault();
  const host = contents.hostWebContents || contents;
  if (host && !host.isDestroyed()) host.send('browser:shortcut', command);
}

function sendFocusedShortcut(command) {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send('browser:shortcut', command);
}
function installApplicationMenu() {
  const template = [
    { label: 'Shark', submenu: [
      { role: 'about', label: 'About Shark Browser' },
      { type: 'separator' },
      { label: 'New Tab', accelerator: 'CommandOrControl+T', click: () => sendFocusedShortcut('new-tab') },
      { label: 'New Private Window', accelerator: 'CommandOrControl+Shift+N', click: () => createWindow({ isPrivate: true }) },
      { label: 'Close Tab', accelerator: 'CommandOrControl+W', click: () => sendFocusedShortcut('close-tab') },
      { type: 'separator' },
      { role: 'hide', visible: process.platform === 'darwin' },
      { role: 'quit' }
    ]},
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find in Page', accelerator: 'CommandOrControl+F', click: () => sendFocusedShortcut('find') }
    ]},
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'CommandOrControl+R', click: () => sendFocusedShortcut('reload') },
      { label: 'Force Reload', accelerator: 'CommandOrControl+Shift+R', click: () => sendFocusedShortcut('force-reload') },
      { label: 'Back', accelerator: 'Alt+Left', click: () => sendFocusedShortcut('back') },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => sendFocusedShortcut('forward') },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', click: () => sendFocusedShortcut('zoom-in') },
      { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: () => sendFocusedShortcut('zoom-out') },
      { label: 'Reset Zoom', accelerator: 'CommandOrControl+0', click: () => sendFocusedShortcut('zoom-reset') },
      { label: 'Print Page', accelerator: 'CommandOrControl+P', click: () => sendFocusedShortcut('print') },
      { role: 'togglefullscreen' },
      { type: 'separator' }, { role: 'toggleDevTools' }
    ]},
    { label: 'History', submenu: [
      { label: 'Show History', accelerator: 'CommandOrControl+H', click: () => sendFocusedShortcut('history') },
      { label: 'Reopen Closed Tab', accelerator: 'CommandOrControl+Shift+T', click: () => sendFocusedShortcut('reopen-tab') },
      { label: 'Downloads', accelerator: 'CommandOrControl+J', click: () => sendFocusedShortcut('downloads') }
    ]},
    { label: 'Bookmarks', submenu: [
      { label: 'Bookmark This Page', accelerator: 'CommandOrControl+D', click: () => sendFocusedShortcut('bookmark') },
      { label: 'Show Bookmarks', click: () => sendFocusedShortcut('bookmarks') },
      { label: 'Privacy & Blocking Statistics', click: () => sendFocusedShortcut('privacy') }
    ]},
    { label: 'Settings', submenu: [
      { label: 'Browser Settings', click: () => sendFocusedShortcut('settings') },
      { label: 'Clear Browsing Data', click: () => sendFocusedShortcut('clear-data') }
    ]},
    { label: 'Help', submenu: [
      { label: 'SharkBrowser on GitHub', click: () => shell.openExternal('https://github.com/NVDEMU/SharkBrowser') }
    ]}
  ];
  app.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow({ isPrivate = false } = {}) {
  const partition = isPrivate
    ? 'shark-private-' + crypto.randomUUID()
    : 'persist:shark';
  const ses = session.fromPartition(partition);
  configureSession(ses, isPrivate);
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: isPrivate ? 'Shark Browser — Private' : 'Shark Browser',
    backgroundColor: '#10151d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });
  if (isPrivate) privateWindows.add(win);
  win.loadFile(path.join(__dirname, 'index.html'), { query: isPrivate ? { private: '1', partition } : { partition } });
  win.on('closed', () => { privateWindows.delete(win); if (win === mainWindow) mainWindow = null; });
  if (!isPrivate) mainWindow = win;
  return win;
}

app.whenReady().then(async () => {
  dataFile = path.join(app.getPath('userData'), 'shark-state.json');
  passwordFile = path.join(app.getPath('userData'), 'passwords.enc');
  readState();
  await initializePasswordVault();
  await loadSavedExtensions();
  blocker = ElectronBlocker.parse(FALLBACK_FILTERS);
  createWindow();
  installApplicationMenu();
  initializeBlocker();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', saveState);

app.on('web-contents-created', (_event, contents) => {
  contents.on('before-input-event', (event, input) => routeGuestShortcut(contents, event, input));
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) {
      const target = contents.hostWebContents || contents;
      if (target && !target.isDestroyed()) target.send('browser:new-tab', url);
    } else {
      try { const parsed = new URL(url); if (parsed.protocol === 'mailto:') shell.openExternal(url); } catch {}
    }
    return { action: 'deny' };
  });

  contents.on('context-menu', (_event, params) => {
    if (contents.getURL().startsWith('file://')) return;
    const host = contents.hostWebContents || contents;
    const menuItems = [];
    if (params.linkURL) {
      menuItems.push(
        { label: 'Open link in new tab', click: () => host.send('browser:new-tab', params.linkURL) },
        { label: 'Open link', click: () => contents.loadURL(params.linkURL).catch(() => {}) },
        { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }
    if (params.hasImageContents && params.srcURL) {
      menuItems.push({ label: 'Open image in new tab', click: () => host.send('browser:new-tab', params.srcURL) });
      menuItems.push({ label: 'Save image as…', click: async () => {
        const filename = path.basename(new URL(params.srcURL).pathname) || 'image';
        const result = await dialog.showSaveDialog({ title: 'Save image', defaultPath: path.join(app.getPath('downloads'), filename) });
        if (!result.canceled && result.filePath) contents.downloadURL(params.srcURL, { savePath: result.filePath });
      }});
      menuItems.push({ type: 'separator' });
    }
    if (params.selectionText) {
      menuItems.push({ label: 'Search selection with Shark', click: () => host.send('browser:new-tab', 'https://duckduckgo.com/?q=' + encodeURIComponent(params.selectionText)) });
      menuItems.push({ label: 'Copy selection', click: () => clipboard.writeText(params.selectionText) });
      menuItems.push({ type: 'separator' });
    }
    menuItems.push(
      { label: 'Back', enabled: contents.canGoBack(), click: () => contents.goBack() },
      { label: 'Forward', enabled: contents.canGoForward(), click: () => contents.goForward() },
      { label: 'Reload', click: () => contents.reload() },
      { type: 'separator' },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll' }
    );
    Menu.buildFromTemplate(menuItems).popup({ window: BrowserWindow.fromWebContents(host) || undefined });
  });
});

ipcMain.handle('shark:get-state', () => ({ ...stats, enabled, allowlist: [...allowlist], blockerReady }));
ipcMain.handle('shark:set-blocking', (_event, value) => { enabled = Boolean(value); browserData.settings.blockAds = enabled; saveState(); emitStats(); return enabled; });
ipcMain.handle('shark:set-ad-blocking', (_event, value) => { enabled = Boolean(value); browserData.settings.blockAds = enabled; saveState(); emitStats(); return enabled; });
ipcMain.handle('shark:allow-site', (_event, hostname) => {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (/^[a-z0-9.-]+$/.test(host) && !host.includes('..') && host.length <= 253) allowlist.add(host);
  saveState(); emitStats(); return [...allowlist];
});
ipcMain.handle('shark:remove-allow-site', (_event, hostname) => { allowlist.delete(String(hostname)); saveState(); emitStats(); return [...allowlist]; });
ipcMain.handle('shark:clear-stats', () => {
  stats.total = 0; stats.ads = 0; stats.trackers = 0; stats.bySite = {}; stats.recent = [];
  saveState(); emitStats(); return { ...stats, enabled, allowlist: [...allowlist], blockerReady };
});
ipcMain.handle('shark:new-private-window', () => { createWindow({ isPrivate: true }); return true; });

ipcMain.handle('browser:get-password-status', () => passwordStorageStatus());
ipcMain.handle('browser:get-passwords', async () => readPasswordVault());
ipcMain.handle('browser:save-password', async (_event, payload) => {
  if (!passwordStorageAvailable) return { ok: false, error: passwordStorageReason };
  if (!payload || !canSavePasswordOrigin(payload.origin)) return { ok: false, error: 'Passwords can only be saved for HTTPS websites (localhost is allowed for development).' };
  const origin = new URL(payload.origin).origin;
  const username = String(payload.username || '').trim().slice(0, 512);
  const password = String(payload.password || '').slice(0, 8192);
  if (!username || !password) return { ok: false, error: 'A username and password are required.' };
  const prior = passwordVault.findIndex(item => item.origin === origin && item.username === username);
  const now = Date.now();
  const entry = { id: prior >= 0 ? passwordVault[prior].id : crypto.randomUUID(), origin, username, password, addedAt: prior >= 0 ? passwordVault[prior].addedAt : now, updatedAt: now };
  if (prior >= 0) passwordVault[prior] = entry; else passwordVault.unshift(entry);
  try {
    await persistPasswordVault();
    return { ok: true, entry: publicPassword(entry), status: passwordStorageStatus(), entries: passwordVault.map(publicPassword) };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('browser:get-password-secret', async (_event, id) => {
  if (!passwordStorageAvailable) return { ok: false, error: passwordStorageReason };
  const entry = passwordVault.find(item => item.id === id);
  if (!entry) return { ok: false, error: 'Saved login not found.' };
  return { ok: true, origin: entry.origin, username: entry.username, password: entry.password };
});
ipcMain.handle('browser:delete-password', async (_event, id) => {
  if (!passwordStorageAvailable) return { ok: false, error: passwordStorageReason };
  const before = passwordVault.length;
  passwordVault = passwordVault.filter(item => item.id !== id);
  if (before !== passwordVault.length) {
    try { await persistPasswordVault(); } catch (error) { return { ok: false, error: error.message }; }
  }
  return { ok: true, status: passwordStorageStatus(), entries: passwordVault.map(publicPassword) };
});
ipcMain.handle('browser:export-bookmarks', async (_event, bookmarks) => {
  const safe = Array.isArray(bookmarks) ? bookmarks.filter(item => item && isWebUrl(item.url)).map(item => ({ title: String(item.title || item.url).slice(0, 300), url: String(item.url).slice(0, 4000), addedAt: Number(item.addedAt) || Date.now() })) : [];
  const target = await dialog.showSaveDialog(mainWindow || undefined, { title: 'Export bookmarks', defaultPath: path.join(app.getPath('documents'), 'Shark-Bookmarks.json'), filters: [{ name: 'JSON bookmarks', extensions: ['json'] }] }).catch(() => ({ canceled: true }));
  if (target.canceled || !target.filePath) return { ok: false, canceled: true };
  try { await fs.promises.writeFile(target.filePath, JSON.stringify({ format: 'shark-bookmarks', version: 1, bookmarks: safe }, null, 2), { mode: 0o600 }); return { ok: true, count: safe.length }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('browser:import-bookmarks', async () => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, { title: 'Import bookmarks', properties: ['openFile'], filters: [{ name: 'Bookmark files', extensions: ['json', 'html', 'htm'] }] }).catch(() => ({ canceled: true, filePaths: [] }));
  if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
  try {
    const source = await fs.promises.readFile(result.filePaths[0], 'utf8');
    let rows = [];
    if (/\.html?$/i.test(result.filePaths[0])) {
      const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = anchor.exec(source)) !== null) {
        const href = /href\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
        const title = match[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
        if (href && isWebUrl(href)) rows.push({ title: title || href, url: href, addedAt: Date.now() });
      }
    } else {
      const parsed = JSON.parse(source);
      rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.bookmarks) ? parsed.bookmarks : []);
    }
    const existing = new Set(browserData.bookmarks.map(item => item.url));
    const incoming = rows.filter(item => item && isWebUrl(item.url) && !existing.has(item.url)).map(item => ({ title: String(item.title || item.url).slice(0,300), url: String(item.url).slice(0,4000), addedAt: Date.now() }));
    browserData.bookmarks = [...incoming, ...browserData.bookmarks].slice(0,1000);
    saveState();
    return { ok: true, count: incoming.length, bookmarks: browserData.bookmarks };
  } catch (error) { return { ok: false, error: error.message }; }
});


ipcMain.handle('browser:get-extensions', () => browserData.extensions.map(publicExtension));
ipcMain.handle('browser:install-extension', async () => {
  const picked = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Choose an unpacked extension folder',
    properties: ['openDirectory']
  }).catch(() => ({ canceled: true, filePaths: [] }));
  if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, canceled: true };
  const extensionPath = path.resolve(picked.filePaths[0]);
  try {
    const manifest = JSON.parse(await fs.promises.readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
    if (!manifest || !manifest.name || !manifest.version || ![2, 3].includes(Number(manifest.manifest_version))) {
      return { ok: false, error: 'The folder does not contain a supported Chrome extension manifest (version 2 or 3).' };
    }
    const exists = browserData.extensions.find(entry => entry.path === extensionPath && entry.enabled);
    if (exists) return { ok: true, alreadyInstalled: true, extensions: browserData.extensions.map(publicExtension) };
    const ses = session.fromPartition('persist:shark');
    const extension = await ses.extensions.loadExtension(extensionPath, { allowFileAccess: false });
    const record = {
      id: extension.id,
      path: extensionPath,
      name: String(manifest.name || extension.name || 'Extension').slice(0, 200),
      version: String(manifest.version || extension.version || '').slice(0, 40),
      manifestVersion: Number(manifest.manifest_version) || 0,
      enabled: true,
      error: ''
    };
    browserData.extensions = [record, ...browserData.extensions.filter(entry => entry.path !== extensionPath)].slice(0, 100);
    saveState();
    return { ok: true, extensions: browserData.extensions.map(publicExtension) };
  } catch (error) {
    return { ok: false, error: String(error.message || 'Extension could not be loaded').slice(0, 800) };
  }
});
ipcMain.handle('browser:remove-extension', async (_event, extensionId) => {
  const entry = browserData.extensions.find(item => item.id === extensionId);
  if (!entry) return { ok: false, error: 'Extension not found.' };
  try {
    const ses = session.fromPartition('persist:shark');
    if (entry.enabled) ses.extensions.removeExtension(extensionId);
    browserData.extensions = browserData.extensions.filter(item => item.id !== extensionId);
    saveState();
    return { ok: true, extensions: browserData.extensions.map(publicExtension) };
  } catch (error) {
    return { ok: false, error: String(error.message || 'Could not remove extension').slice(0, 500) };
  }
});
ipcMain.handle('browser:toggle-extension', async (_event, extensionId, enabledFlag) => {
  const entry = browserData.extensions.find(item => item.id === extensionId);
  if (!entry) return { ok: false, error: 'Extension not found.' };
  try {
    const ses = session.fromPartition('persist:shark');
    if (!enabledFlag) {
      if (entry.enabled) ses.extensions.removeExtension(extensionId);
      entry.enabled = false; entry.error = '';
    } else {
      const manifest = JSON.parse(await fs.promises.readFile(path.join(entry.path, 'manifest.json'), 'utf8'));
      const loaded = await ses.extensions.loadExtension(entry.path, { allowFileAccess: false });
      entry.id = loaded.id;
      entry.name = String(manifest.name || loaded.name || entry.name).slice(0, 200);
      entry.version = String(manifest.version || loaded.version || entry.version).slice(0, 40);
      entry.manifestVersion = Number(manifest.manifest_version) || entry.manifestVersion;
      entry.enabled = true; entry.error = '';
    }
    saveState();
    return { ok: true, extensions: browserData.extensions.map(publicExtension) };
  } catch (error) {
    entry.enabled = false;
    entry.error = String(error.message || 'Could not toggle extension').slice(0, 500);
    saveState();
    return { ok: false, error: entry.error, extensions: browserData.extensions.map(publicExtension) };
  }
});

ipcMain.handle('browser:get-data', () => browserData);
ipcMain.handle('browser:save-bookmarks', (_event, items) => {
  if (!Array.isArray(items)) return browserData.bookmarks;
  browserData.bookmarks = items.filter(item => item && isWebUrl(item.url)).slice(0, 1000).map(item => ({
    title: String(item.title || item.url).slice(0, 300), url: String(item.url).slice(0, 4000), addedAt: Number(item.addedAt) || Date.now()
  }));
  saveState(); return browserData.bookmarks;
});
ipcMain.handle('browser:save-history', (_event, items) => {
  if (!Array.isArray(items)) return browserData.history;
  browserData.history = items.filter(item => item && isWebUrl(item.url)).slice(0, 1000).map(item => ({
    title: String(item.title || item.url).slice(0, 300), url: String(item.url).slice(0, 4000), time: Number(item.time) || Date.now()
  }));
  saveState(); return browserData.history;
});
ipcMain.handle('browser:clear-history', () => { browserData.history = []; saveState(); return true; });
ipcMain.handle('browser:save-settings', (_event, settings) => {
  if (settings && typeof settings === 'object') {
    const engines = new Set(['duckduckgo', 'google', 'bing', 'brave']);
    if (engines.has(settings.searchEngine)) browserData.settings.searchEngine = settings.searchEngine;
    if (settings.homePage === 'shark://home' || isWebUrl(settings.homePage)) browserData.settings.homePage = String(settings.homePage).slice(0, 4000);
    browserData.settings.restoreSession = settings.restoreSession !== false;
    if (typeof settings.blockAds === 'boolean') { browserData.settings.blockAds = settings.blockAds; enabled = settings.blockAds; }
  }
  saveState(); return browserData.settings;
});
ipcMain.handle('browser:save-session', (_event, tabs) => {
  if (!Array.isArray(tabs)) return browserData.sessionTabs;
  browserData.sessionTabs = tabs.filter(isWebUrl).slice(0, 40).map(url => String(url).slice(0, 4000));
  saveState(); return true;
});
ipcMain.handle('browser:get-downloads', () => browserData.downloads);
ipcMain.handle('browser:open-download', async (_event, id) => {
  const item = browserData.downloads.find(entry => entry.id === id && entry.state === 'completed');
  if (!item || !fs.existsSync(item.path)) return { ok: false, error: 'The downloaded file is no longer available.' };
  const error = await shell.openPath(item.path);
  return { ok: !error, error: error || '' };
});
ipcMain.handle('browser:reveal-download', (_event, id) => {
  const item = browserData.downloads.find(entry => entry.id === id && entry.state === 'completed');
  if (!item || !fs.existsSync(item.path)) return false;
  shell.showItemInFolder(item.path); return true;
});
ipcMain.handle('browser:remove-download', (_event, id) => {
  browserData.downloads = browserData.downloads.filter(item => item.id !== id);
  saveState(); return browserData.downloads;
});
ipcMain.handle('browser:clear-downloads', () => {
  browserData.downloads = browserData.downloads.filter(item => item.state === 'in-progress');
  saveState(); return browserData.downloads;
});
ipcMain.handle('browser:clear-data', async (_event, options = {}) => {
  if (options.history) browserData.history = [];
  if (options.cookies || options.siteData) {
    await session.fromPartition('persist:shark').clearStorageData({
      storages: options.cookies && !options.siteData
        ? ['cookies']
        : ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem']
    });
  }
  if (options.cache || options.siteData) await session.fromPartition('persist:shark').clearCache();
  if (options.permissions) browserData.permissions = {};
  saveState(); return true;
});
ipcMain.handle('browser:zoom', (_event, direction) => {
  const webContents = BrowserWindow.getAllWindows().map(win => win.webContents).find(wc => wc && !wc.isDestroyed());
  if (webContents) webContents.send('browser:zoom-page', direction);
  return true;
});
