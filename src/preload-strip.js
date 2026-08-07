// Preload for the always-on taskbar strip. Deliberately tiny: the strip only
// consumes cost/usage snapshots and can ask main to open the full HUD.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('strip', {
  onCost: (cb) => {
    ipcRenderer.removeAllListeners('hud:cost');
    ipcRenderer.on('hud:cost', (_e, payload) => cb(payload));
  },
  onGeometry: (cb) => {
    ipcRenderer.removeAllListeners('strip:geometry');
    ipcRenderer.on('strip:geometry', (_e, g) => cb(g));
  },
  onStyle: (cb) => {
    ipcRenderer.removeAllListeners('strip:style');
    ipcRenderer.on('strip:style', (_e, s) => cb(s));
  },
  openHud: () => ipcRenderer.send('strip:openHud'),
  menu: () => ipcRenderer.send('strip:menu'),
});
