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

// Local ComfyUI (Stable Diffusion) — build a txt2img graph, queue it, poll, fetch the PNG
async function comfyuiGenerate(serverUrl, model, prompt) {
  const base = (serverUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  const ckpt = model || 'DreamShaper_8_pruned.safetensors';
  const low = ckpt.toLowerCase();
  let steps = 20, cfg = 7, w = 512, h = 512, sampler = 'euler', sched = 'normal';
  if (low.includes('lightning')) { steps = 6; cfg = 2; w = 1024; h = 1024; sched = 'sgm_uniform'; }
  else if (low.includes('xl')) { steps = 25; cfg = 6; w = 1024; h = 1024; }
  const seed = Math.floor(Math.random() * 1e15);
  const wf = {
    "3": { class_type: "KSampler", inputs: { seed, steps, cfg, sampler_name: sampler, scheduler: sched, denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: w, height: h, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "lowres, bad anatomy, blurry, watermark, text", clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "InkForge", images: ["8", 0] } }
  };
  let res;
  try {
    res = await fetch(base + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'inkforge' }) });
  } catch (e) {
    return { error: `Can't reach ComfyUI at ${base}. Is it running? (${e.message})` };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: (data.error && (data.error.message || JSON.stringify(data.error))) || ('HTTP ' + res.status) };
  const pid = data.prompt_id;
  if (!pid) return { error: 'ComfyUI did not queue the job (no prompt_id).' };
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const hr = await fetch(base + '/history/' + pid);
    const hist = await hr.json().catch(() => ({}));
    const entry = hist[pid];
    if (entry && entry.status && entry.status.status_str === 'error') return { error: 'ComfyUI reported a generation error (check the model/prompt).' };
    if (entry && entry.outputs) {
      for (const nid in entry.outputs) {
        const imgs = entry.outputs[nid].images;
        if (imgs && imgs.length) {
          const im = imgs[0];
          const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'output' });
          const ir = await fetch(base + '/view?' + q.toString());
          const buf = Buffer.from(await ir.arrayBuffer());
          return { image: buf.toString('base64'), mime: 'image/png' };
        }
      }
    }
  }
  return { error: 'Timed out waiting for ComfyUI (generation took too long).' };
}

ipcMain.handle('ai-generate', async (_evt, { provider, key, model, prompt }) => {
  try {
    if (provider === 'gemini') return await geminiGenerate(key, model, prompt);
    if (provider === 'replicate') return await replicateGenerate(key, model, prompt);
    if (provider === 'comfyui') return await comfyuiGenerate(key, model, prompt);
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
