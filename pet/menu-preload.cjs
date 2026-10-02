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
  /** 读取完整计时状态 */
  clockState: () => ipcRenderer.invoke('clock-state'),
  /** 发送计时命令（开始/暂停/取时/重置/设置…） */
  clockCmd: (command) => ipcRenderer.send('clock-cmd', command),
  /** 计时状态推送（用于每秒刷新显示） */
  onClock: (callback) => ipcRenderer.on('clock-state', (_event, state) => callback(state)),

  /** Close just the panel (the ✕ in the title bar). */
  close: () => ipcRenderer.send('menu-close'),
  /** Quit the whole pet application (the 退出 button). */
  quit: () => ipcRenderer.send('app-quit'),
}
