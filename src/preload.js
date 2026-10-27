const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('shark', {
  getState: () => ipcRenderer.invoke('shark:get-state'),
  setBlocking: value => ipcRenderer.invoke('shark:set-blocking', value),
  allowSite: host => ipcRenderer.invoke('shark:allow-site', host),
  removeAllowSite: host => ipcRenderer.invoke('shark:remove-allow-site', host),
  clearStats: () => ipcRenderer.invoke('shark:clear-stats'),
  newPrivateWindow: () => ipcRenderer.invoke('shark:new-private-window'),
  openExternal: url => ipcRenderer.invoke('shark:open-external', url),
  onStats: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('blocking:stats', listener);
    return () => ipcRenderer.removeListener('blocking:stats', listener);
  }
});