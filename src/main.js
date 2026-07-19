const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// 2D canvas paint apps are more reliable with software compositing; this avoids
// intermittent GPU canvas-blanking seen on some Windows/Intel/AMD driver combos.
app.disableHardwareAcceleration();

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#23262b',
    title: 'InkForge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  Menu.setApplicationMenu(buildMenu());
}

function buildMenu() {
  const send = (channel) => () => mainWindow?.webContents.send(channel);
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Canvas', accelerator: 'CmdOrCtrl+N', click: send('menu:new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('menu:open') },
        { label: 'Save Project…', accelerator: 'CmdOrCtrl+S', click: send('menu:save') },
        { label: 'Export PNG…', accelerator: 'CmdOrCtrl+E', click: send('menu:export') },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('menu:undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: send('menu:redo') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Fit to Screen', accelerator: 'CmdOrCtrl+0', click: send('menu:fit') },
        { role: 'toggleDevTools' }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

// Save a PNG (base64 data URL) to disk via native dialog
ipcMain.handle('save-png', async (_evt, dataUrl) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export PNG',
    defaultPath: 'inkforge-artwork.png',
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  });
  if (canceled || !filePath) return { ok: false };
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return { ok: true, filePath };
});

ipcMain.handle('save-project', async (_evt, json) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Project',
    defaultPath: 'artwork.inkforge',
    filters: [{ name: 'InkForge Project', extensions: ['inkforge'] }]
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, json);
  return { ok: true, filePath };
});

ipcMain.handle('open-project', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Project',
    properties: ['openFile'],
    filters: [{ name: 'InkForge Project', extensions: ['inkforge'] }]
  });
  if (canceled || !filePaths[0]) return null;
  return fs.readFileSync(filePaths[0], 'utf8');
});

ipcMain.handle('save-file', async (_evt, { defaultName, ext, base64 }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export',
    defaultPath: defaultName,
    filters: [{ name: (ext || 'file').toUpperCase(), extensions: [ext || 'bin'] }]
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return { ok: true, filePath };
});

// ---- AI image generation (runs in main to avoid renderer CORS) ----
async function geminiGenerate(key, model, prompt) {
  const m = model || 'gemini-2.0-flash-preview-image-generation';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error?.message || ('HTTP ' + res.status) };
  const parts = data.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inlineData?.data);
  if (!img) return { error: 'No image returned (model may not support image output).' };
  return { image: img.inlineData.data, mime: img.inlineData.mimeType || 'image/png' };
}

async function replicateGenerate(key, model, prompt) {
  const m = model || 'black-forest-labs/flux-schnell';
  const create = await fetch(`https://api.replicate.com/v1/models/${m}/predictions`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Prefer': 'wait' },
    body: JSON.stringify({ input: { prompt } })
  });
  let pred = await create.json().catch(() => ({}));
  if (!create.ok) return { error: pred.detail || pred.title || ('HTTP ' + create.status) };
  let tries = 0;
  while (pred.status && !['succeeded', 'failed', 'canceled'].includes(pred.status) && tries++ < 60) {
    await new Promise(r => setTimeout(r, 1500));
    const p = await fetch(pred.urls.get, { headers: { 'Authorization': 'Bearer ' + key } });
    pred = await p.json();
  }
  if (pred.status !== 'succeeded') return { error: 'Generation ' + (pred.status || 'failed') + (pred.error ? ': ' + pred.error : '') };
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  if (!out) return { error: 'No output produced.' };
  const imgRes = await fetch(out);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  return { image: buf.toString('base64'), mime: imgRes.headers.get('content-type') || 'image/png' };
}

ipcMain.handle('ai-generate', async (_evt, { provider, key, model, prompt }) => {
  try {
    if (provider === 'gemini') return await geminiGenerate(key, model, prompt);
    if (provider === 'replicate') return await replicateGenerate(key, model, prompt);
    return { error: 'Unknown provider' };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
