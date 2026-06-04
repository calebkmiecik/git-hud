const path = require('node:path');

// Writable per-user directory for config.json / state.json. `app` is injected
// so this module needs no Electron import and stays unit-testable.
function dataDir(app) {
  return app.getPath('userData');
}

function configFile(dir) {
  return path.join(dir, 'config.json');
}

// Read-only template shipped inside the app bundle (appDir = app.getAppPath()).
// (state.json's path is resolved inside state.js from the same data dir.)
function exampleFile(appDir) {
  return path.join(appDir, 'config.example.json');
}

module.exports = { dataDir, configFile, exampleFile };
