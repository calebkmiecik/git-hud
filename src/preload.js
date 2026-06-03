const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  onUpdate: (cb) => {
    ipcRenderer.removeAllListeners('hud:update');
    ipcRenderer.on('hud:update', (_e, payload) => cb(payload));
  },
});
