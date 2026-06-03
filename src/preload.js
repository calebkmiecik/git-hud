const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  onUpdate: (cb) => {
    ipcRenderer.removeAllListeners('hud:update');
    ipcRenderer.on('hud:update', (_e, payload) => cb(payload));
  },
  getPicker: () => ipcRenderer.invoke('hud:getPicker'),
  setEnabled: (repoPath, on) => ipcRenderer.invoke('hud:setEnabled', repoPath, on),
  addRoot: () => ipcRenderer.invoke('hud:addRoot'),
  removeRoot: (rootPath) => ipcRenderer.invoke('hud:removeRoot', rootPath),
  getWinPos: () => ipcRenderer.invoke('hud:winPos'),
  moveWin: (x, y) => ipcRenderer.send('hud:moveWin', x, y),
});
