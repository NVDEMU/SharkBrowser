const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let mainWindow;
let privateWindows = new Set();
const blockedDomains = new Set([
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'adservice.google.com', 'adnxs.com', 'adsrvr.org', 'adform.net',
  'taboola.com', 'outbrain.com', 'criteo.com', 'scorecardresearch.com',
  'quantserve.com', 'facebook.net', 'connect.facebook.net',
  'analytics.google.com', 'google-analytics.com', 'googletagmanager.com',
  'hotjar.com', 'segment.io', 'segment.com', 'mixpanel.com',
  'amplitude.com', 'branch.io', 'appsflyer.com', 'adjust.com',
  'pixel.facebook.com', 'bat.bing.com', 'clarity.ms'
]);
const stats = { total: 0, ads: 0, trackers: 0, bySite: {}, recent: [] };
let allowlist = new Set();
let enabled = true;
let dataFile;

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    allowlist = new Set(state.allowlist || []);
    enabled = state.enabled !== false;
    Object.assign(stats, state.stats || {});
  } catch {}
}
function saveState() {
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify({ allowlist: [...allowlist], enabled, stats }, null, 2));
  } catch (e) { console.error('Could not save browser state:', e.message); }
}
function isDomain(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}
function classify(url, resourceType) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const domain = [...blockedDomains].find(d => isDomain(host, d));
  if (domain) return { category: 'tracker', domain, host };
  if (/(^|[.-])(ads?|adserver|advertising|analytics|tracking|tracker|pixel|telemetry)([.-]|$)/i.test(host)
      && !/(adobe|adobeanalytics)/i.test(host)) return { category: 'tracker', domain: host, host };
  if (/(^|\/)(ads?|adservice|advert|banner)[^/]*(\/|\?|$)/i.test(url)) return { category: 'ad', domain: host, host };
  return null;
}
function emitStats() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('blocking:stats', { ...stats, enabled, allowlist: [...allowlist] });
  }
}
function recordBlock(details, match) {
  const page = (() => { try { return new URL(details.referrer || details.url).hostname; } catch { return 'unknown'; } })();
  stats.total++;
  if (match.category === 'ad') stats.ads++; else stats.trackers++;
  stats.bySite[page] ||= { total: 0, ads: 0, trackers: 0 };
  stats.bySite[page].total++;
  stats.bySite[page][match.category === 'ad' ? 'ads' : 'trackers']++;
  stats.recent.unshift({ url: details.url.slice(0, 500), domain: match.domain, category: match.category, site: page, time: Date.now() });
  stats.recent.length = Math.min(stats.recent.length, 100);
  if (stats.total % 5 === 0) saveState();
  emitStats();
}
function configureBlocking(ses) {
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!enabled || details.url.startsWith('devtools://') || details.url.startsWith('chrome-extension://')) return callback({});
    const page = (() => { try { return new URL(details.referrer || '').hostname.toLowerCase(); } catch { return ''; } })();
    if ([...allowlist].some(d => page === d || page.endsWith('.' + d))) return callback({});
    const match = classify(details.url, details.resourceType);
    if (match) { recordBlock(details, match); return callback({ cancel: true }); }
    callback({});
  });
}
function createWindow({ isPrivate = false } = {}) {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'Shark Browser',
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
  win.loadFile(path.join(__dirname, 'index.html'), { query: isPrivate ? { private: '1' } : {} });
  win.on('closed', () => { privateWindows.delete(win); if (win === mainWindow) mainWindow = null; });
  if (!isPrivate) mainWindow = win;
  return win;
}

app.whenReady().then(() => {
  dataFile = path.join(app.getPath('userData'), 'shark-state.json');
  readState();
  configureBlocking(session.defaultSession);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', saveState);

ipcMain.handle('shark:get-state', () => ({ ...stats, enabled, allowlist: [...allowlist] }));
ipcMain.handle('shark:set-blocking', (_event, value) => { enabled = Boolean(value); saveState(); emitStats(); return enabled; });
ipcMain.handle('shark:allow-site', (_event, hostname) => {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..')) return [...allowlist];
  allowlist.add(host); saveState(); emitStats(); return [...allowlist];
});
ipcMain.handle('shark:remove-allow-site', (_event, hostname) => { allowlist.delete(String(hostname)); saveState(); emitStats(); return [...allowlist]; });
ipcMain.handle('shark:clear-stats', () => {
  stats.total = 0; stats.ads = 0; stats.trackers = 0; stats.bySite = {}; stats.recent = [];
  saveState(); emitStats(); return stats;
});
ipcMain.handle('shark:new-private-window', () => { createWindow({ isPrivate: true }); return true; });
ipcMain.handle('shark:open-external', (_event, url) => {
  try { const parsed = new URL(url); if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) shell.openExternal(parsed.toString()); } catch {}
});
