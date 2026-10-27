const { contextBridge, ipcRenderer } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

contextBridge.exposeInMainWorld('shark', {
  guestPreloadUrl: pathToFileURL(path.join(__dirname, 'guest-preload.js')).toString(),
  getState: () => ipcRenderer.invoke('shark:get-state'),
  setBlocking: value => ipcRenderer.invoke('shark:set-blocking', value),
  setAdBlocking: value => ipcRenderer.invoke('shark:set-ad-blocking', value),
  allowSite: host => ipcRenderer.invoke('shark:allow-site', host),
  removeAllowSite: host => ipcRenderer.invoke('shark:remove-allow-site', host),
  clearStats: () => ipcRenderer.invoke('shark:clear-stats'),
  newPrivateWindow: () => ipcRenderer.invoke('shark:new-private-window'),
  openExternal: url => ipcRenderer.invoke('shark:open-external', url),
  getBrowserData: () => ipcRenderer.invoke('browser:get-data'),
  saveBookmarks: items => ipcRenderer.invoke('browser:save-bookmarks', items),
  saveHistory: items => ipcRenderer.invoke('browser:save-history', items),
  clearHistory: () => ipcRenderer.invoke('browser:clear-history'),
  saveSettings: settings => ipcRenderer.invoke('browser:save-settings', settings),
  saveSession: tabs => ipcRenderer.invoke('browser:save-session', tabs),
  getDownloads: () => ipcRenderer.invoke('browser:get-downloads'),
  getExtensions: () => ipcRenderer.invoke('browser:get-extensions'),
  installExtension: () => ipcRenderer.invoke('browser:install-extension'),
  removeExtension: id => ipcRenderer.invoke('browser:remove-extension', id),
  toggleExtension: (id, enabled) => ipcRenderer.invoke('browser:toggle-extension', id, enabled),
  getPasswordStatus: () => ipcRenderer.invoke('browser:get-password-status'),
  getPasswords: () => ipcRenderer.invoke('browser:get-passwords'),
  savePassword: payload => ipcRenderer.invoke('browser:save-password', payload),
  getPasswordSecret: id => ipcRenderer.invoke('browser:get-password-secret', id),
  deletePassword: id => ipcRenderer.invoke('browser:delete-password', id),
  exportBookmarks: items => ipcRenderer.invoke('browser:export-bookmarks', items),
  importBookmarks: () => ipcRenderer.invoke('browser:import-bookmarks'),
  openDownload: id => ipcRenderer.invoke('browser:open-download', id),
  revealDownload: id => ipcRenderer.invoke('browser:reveal-download', id),
  removeDownload: id => ipcRenderer.invoke('browser:remove-download', id),
  clearDownloads: () => ipcRenderer.invoke('browser:clear-downloads'),
  clearData: options => ipcRenderer.invoke('browser:clear-data', options),
  onStats: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('blocking:stats', listener);
    return () => ipcRenderer.removeListener('blocking:stats', listener);
  },
  onDownloads: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('downloads:changed', listener);
    return () => ipcRenderer.removeListener('downloads:changed', listener);
  },
  onNewTab: callback => {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on('browser:new-tab', listener);
    return () => ipcRenderer.removeListener('browser:new-tab', listener);
  },
  onToast: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('browser:toast', listener);
    return () => ipcRenderer.removeListener('browser:toast', listener);
  },
  onShortcut: callback => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('browser:shortcut', listener);
    return () => ipcRenderer.removeListener('browser:shortcut', listener);
  },
  onZoomPage: callback => {
    const listener = (_event, direction) => callback(direction);
    ipcRenderer.on('browser:zoom-page', listener);
    return () => ipcRenderer.removeListener('browser:zoom-page', listener);
  }
});