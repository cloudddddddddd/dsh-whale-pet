// Preload (contextIsolation: false): expose `window.pet` in the same world as
// the renderer, so callbacks cross no bridge. Loads only local files; the
// renderer only talks to loopback DSH.
const { ipcRenderer } = require('electron')

window.pet = {
  onState: (callback) => ipcRenderer.on('pet-state', (_event, payload) => callback(payload)),
  onManifest: (callback) => ipcRenderer.on('pet-manifest', (_event, manifest) => callback(manifest)),
  onScale: (callback) => ipcRenderer.on('pet-scale', (_event, metrics) => callback(metrics)),
  onSessions: (callback) => ipcRenderer.on('pet-sessions', (_event, sessions) => callback(sessions)),
  onDebug: (callback) => ipcRenderer.on('pet-debug', (_event, debug) => callback(debug)),
  onInteractResult: (callback) => ipcRenderer.on('pet-interact-result', (_event, result) => callback(result)),
  onExpression: (callback) => ipcRenderer.on('pet-expression', (_event, payload) => callback(payload)),
  onCursor: (callback) => ipcRenderer.on('pet-cursor', (_event, payload) => callback(payload)),
  onHand: (callback) => ipcRenderer.on('pet-hand', (_event, payload) => callback(payload)),
  onIdleShow: (callback) => ipcRenderer.on('pet-idle-show', () => callback()),
  onClockAlert: (callback) => ipcRenderer.on('pet-clock-alert', (_event, payload) => callback(payload)),
  onProp: (callback) => ipcRenderer.on('pet-prop', (_event, payload) => callback(payload)),
  onGaze: (callback) => ipcRenderer.on('pet-gaze', (_event, payload) => callback(payload)),
  onMotion: (callback) => ipcRenderer.on('pet-motion', (_event, payload) => callback(payload)),
  toggleWeb: () => ipcRenderer.send('pet-toggle-web'),
  openMenu: () => ipcRenderer.send('pet-menu'),
  reportLook: (state) => ipcRenderer.send('pet-look', state),
  interact: (action) => ipcRenderer.send('pet-interact', action),
  dragStart: () => ipcRenderer.send('pet-drag-start'),
  dragMove: (delta) => ipcRenderer.send('pet-drag-move', delta),
  dragEnd: () => ipcRenderer.send('pet-drag-end'),
}
