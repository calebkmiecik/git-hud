const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  onUpdate: (cb) => ipcRenderer.on('hud:update', (_e, payload) => cb(payload)),
});
