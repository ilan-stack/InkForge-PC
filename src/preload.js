const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inkforge', {
  savePng: (dataUrl) => ipcRenderer.invoke('save-png', dataUrl),
  onMenu: (channel, handler) => {
    const valid = ['menu:new', 'menu:export', 'menu:undo', 'menu:redo', 'menu:fit'];
    if (valid.includes(channel)) ipcRenderer.on(channel, handler);
  }
});
