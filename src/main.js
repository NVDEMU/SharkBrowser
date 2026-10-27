const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');
const fetch = require('cross-fetch');

let mainWindow = null;
let dataFile = null;
let blocker = null;
let blockerReady = false;
const configuredSessions = new WeakSet();
const privateWindows = new Set();
const FALLBACK_FILTERS = [
  '||doubleclick.net^',
  '||googlesyndication.com^',
  '||googleadservices.com^',
  '||adnxs.com^',
  '||taboola.com^',
  '||outbrain.com^',
  '||criteo.com^',
  '||google-analytics.com^$third-party',
  '||googletagmanager.com^$third-party',
  '||connect.facebook.net^$third-party',
  '||hotjar.com^$third-party',
  '||mixpanel.com^$third-party',
  '||scorecardresearch.com^$third-party'
].join('\n');

const stats = { total: 0, ads: 0, trackers: 0, bySite: {}, recent: [] };
let allowlist = new Set();
let enabled = true;
let browserData = {
  bookmarks: [],
  history: [],
  downloads: [],
  permissions: {},
  sessionTabs: [],
  settings: {
    searchEngine: 'duckduckgo',
    homePage: 'shark://home',
    restoreSession: true,
    blockAds: true
  }
};

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
function classifyBlocked(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { category: 'tracker', domain: 'unknown' }; }
  const host = parsed.hostname.toLowerCase();
  const adDomains = ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adnxs.com', 'adsrvr.org', 'adform.net', 'taboola.com', 'outbrain.com', 'criteo.com'];
  const trackerDomains = ['google-analytics.com', 'googletagmanager.com', 'hotjar.com', 'mixpanel.com', 'segment.com', 'segment.io', 'amplitude.com', 'scorecardresearch.com', 'quantserve.com', 'clarity.ms', 'bat.bing.com', 'connect.facebook.net'];
  if (adDomains.some(domain => isDomain(host, domain)) || /\/(ads?|advert|banner)([/?._-]|$)/i.test(parsed.pathname)) return { category: 'ad', domain: host };
  if (trackerDomains.some(domain => isDomain(host, domain)) || /(analytics|tracking|tracker|telemetry|pixel|beacon)/i.test(host + parsed.pathname)) return { category: 'tracker', domain: host };
  return { category: 'ad', domain: host };
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
const resourceTypes = {
  mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet',
  script: 'script', image: 'image', font: 'font', object: 'object',
  xhr: 'xmlhttprequest', ping: 'ping', media: 'media', websocket: 'websocket',
  other: 'other'
};
function configureSession(ses, isPrivate) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);

  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!enabled || !browserData.settings.blockAds || !blocker || !details.url.startsWith('http')) return callback({});
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
    const choice = await dialog.showMessageBox(win || undefined, {
      type: 'question',
      title: 'Shark Browser — site permission',
      message: host + ' is requesting permission',
      detail: 'Permission requested: ' + permission + '. Allow this only if you trust this website.',
      buttons: ['Block', 'Allow'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }).catch(() => ({ response: 0 }));
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
    const save = await dialog.showSaveDialog(
      mainWindow && !mainWindow.isDestroyed() ? mainWindow : (BrowserWindow.fromWebContents(sourceContents?.hostWebContents || sourceContents) || undefined),
      { title: 'Save download', defaultPath: path.join(app.getPath('downloads'), filename) }
    ).catch(() => ({ canceled: true }));
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
  try {
    const fresh = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cachePath,
      read: file => fs.promises.readFile(file),
      write: (file, data) => fs.promises.writeFile(file, data)
    });
    blocker = fresh;
    blockerReady = true;
    console.log('Shark ad/tracker filter engine is ready.');
    emitStats();
  } catch (error) {
    console.warn('Using bundled fallback ad/tracker rules; full lists could not be loaded:', error.message);
    // Keep the working fallback engine; the next launch will retry the full lists.
  }
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

app.whenReady().then(() => {
  dataFile = path.join(app.getPath('userData'), 'shark-state.json');
  readState();
  blocker = ElectronBlocker.parse(FALLBACK_FILTERS);
  createWindow();
  initializeBlocker();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', saveState);

app.on('web-contents-created', (_event, contents) => {
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
ipcMain.handle('shark:set-blocking', (_event, value) => { enabled = Boolean(value); saveState(); emitStats(); return enabled; });
ipcMain.handle('shark:set-ad-blocking', (_event, value) => { browserData.settings.blockAds = Boolean(value); saveState(); emitStats(); return browserData.settings.blockAds; });
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
