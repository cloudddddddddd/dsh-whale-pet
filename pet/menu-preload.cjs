// Preload for the control-panel window (contextIsolation: false, so the API
// lands directly on `window`).
const { ipcRenderer } = require('electron')

window.menuAPI = {
  /** Everything the panel needs to draw itself (lists + current state). */
  data: () => ipcRenderer.invoke('menu-data'),
  /** Fire a command at the pet (feed / expression / motion / scale / ...). */
  cmd: (command) => ipcRenderer.send('menu-cmd', command),
  /** State pushes so the panel stays in sync. */
  onState: (callback) => ipcRenderer.on('menu-state', (_event, state) => callback(state)),
  /** Close just the panel (the ✕ in the title bar). */
  close: () => ipcRenderer.send('menu-close'),
  /** Quit the whole pet application (the 退出 button). */
  quit: () => ipcRenderer.send('app-quit'),
}
