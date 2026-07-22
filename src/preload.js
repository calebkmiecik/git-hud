const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  onUpdate: (cb) => {
    ipcRenderer.removeAllListeners('hud:update');
    ipcRenderer.on('hud:update', (_e, payload) => cb(payload));
  },
  onOpenSettings: (cb) => {
    ipcRenderer.removeAllListeners('hud:openSettings');
    ipcRenderer.on('hud:openSettings', () => cb());
  },
  onAgentEvent: (cb) => {
    ipcRenderer.removeAllListeners('hud:agentEvent');
    ipcRenderer.on('hud:agentEvent', (_e, payload) => cb(payload));
  },
  onCost: (cb) => {
    ipcRenderer.removeAllListeners('hud:cost');
    ipcRenderer.on('hud:cost', (_e, payload) => cb(payload));
  },
  onSetView: (cb) => {
    ipcRenderer.removeAllListeners('hud:setView');
    ipcRenderer.on('hud:setView', (_e, mode) => cb(mode));
  },
  getCost: () => ipcRenderer.invoke('hud:getCost'),
  getPicker: () => ipcRenderer.invoke('hud:getPicker'),
  setEnabled: (repoPath, on) => ipcRenderer.invoke('hud:setEnabled', repoPath, on),
  addRoot: () => ipcRenderer.invoke('hud:addRoot'),
  removeRoot: (rootPath) => ipcRenderer.invoke('hud:removeRoot', rootPath),
  getWinPos: () => ipcRenderer.invoke('hud:winPos'),
  moveWin: (x, y) => ipcRenderer.send('hud:moveWin', x, y),
  openExternal: (repoPath, target) => ipcRenderer.invoke('hud:openExternal', repoPath, target),
  getDetail: (repoPath) => ipcRenderer.invoke('hud:getDetail', repoPath),
  setBase: (repoPath, branch) => ipcRenderer.invoke('hud:setBase', repoPath, branch),
  push: (repoPath) => ipcRenderer.invoke('hud:push', repoPath),
});
