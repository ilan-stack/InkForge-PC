const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inkforge', {
  savePng: (dataUrl) => ipcRenderer.invoke('save-png', dataUrl),
  saveProject: (json) => ipcRenderer.invoke('save-project', json),
  openProject: () => ipcRenderer.invoke('open-project'),
  onMenu: (channel, handler) => {
    const valid = ['menu:new', 'menu:open', 'menu:save', 'menu:export', 'menu:undo', 'menu:redo', 'menu:fit'];
    if (valid.includes(channel)) ipcRenderer.on(channel, handler);
  }
});
