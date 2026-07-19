// InkForge renderer — layered canvas drawing engine
// Sections: Document/Layers · History · Viewport · Brush engine · Tools · Input · UI

const $ = (sel) => document.querySelector(sel);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- Document
class Layer {
  constructor(w, h, name) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.name = name;
    this.visible = true;
    this.opacity = 1;
    this.blend = 'source-over';
    this.id = Layer._id++;
  }
}
Layer._id = 1;

const doc = {
  width: 1920,
  height: 1080,
  layers: [],
  active: 0,
  get layer() { return this.layers[this.active]; }
};

// ---------------------------------------------------------------- History
const history = {
  stack: [],
  redoStack: [],
  limit: 40,
  push(layer) {
    this.stack.push({ id: layer.id, data: layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height) });
    if (this.stack.length > this.limit) this.stack.shift();
    this.redoStack.length = 0;
  },
  undo() { this._apply(this.stack, this.redoStack); },
  redo() { this._apply(this.redoStack, this.stack); },
  _apply(from, to) {
    const snap = from.pop();
    if (!snap) return;
    const layer = doc.layers.find(l => l.id === snap.id);
    if (!layer) return;
    to.push({ id: layer.id, data: layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height) });
    layer.ctx.putImageData(snap.data, 0, 0);
    composite(); renderLayerList();
  }
};

// ---------------------------------------------------------------- Viewport
const view = $('#view');
const vctx = view.getContext('2d', { willReadFrequently: true });
const wrap = $('#canvas-wrap');
const stage = $('#stage');
const cam = { x: 0, y: 0, scale: 1 };

function applyCam() {
  wrap.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`;
  $('#zoom-label').textContent = Math.round(cam.scale * 100) + '%';
}
function fitToScreen() {
  const pad = 60;
  const sw = stage.clientWidth - pad, sh = stage.clientHeight - pad;
  cam.scale = Math.min(sw / doc.width, sh / doc.height, 1);
  cam.x = (stage.clientWidth - doc.width * cam.scale) / 2;
  cam.y = (stage.clientHeight - doc.height * cam.scale) / 2;
  applyCam();
}
// screen (client) coords -> document pixel coords
function toDoc(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return {
    x: (clientX - r.left - cam.x) / cam.scale,
    y: (clientY - r.top - cam.y) / cam.scale
  };
}

// ---------------------------------------------------------------- Compositing
function composite() {
  vctx.clearRect(0, 0, view.width, view.height);
  for (const l of doc.layers) {
    if (!l.visible || l.opacity <= 0) continue;
    vctx.globalAlpha = l.opacity;
    vctx.globalCompositeOperation = l.blend;
    vctx.drawImage(l.canvas, 0, 0);
  }
  vctx.globalAlpha = 1;
  vctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------- Brush engine
const brush = {
  color: '#1a1a1a',
  size: 12,
  opacity: 1,
  hardness: 0.8,
  usePressure: true
};

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Build a soft round brush tip once (fixed resolution); scaled per-stamp via drawImage
function makeStampTip(size, rgb, hardness) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const cx = c.getContext('2d');
  const r = size / 2;
  const grad = cx.createRadialGradient(r, r, r * hardness, r, r, r);
  grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},1)`);
  grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
  cx.fillStyle = grad;
  cx.beginPath();
  cx.arc(r, r, r, 0, Math.PI * 2);
  cx.fill();
  return c;
}

// A stroke stamps the tip along interpolated points with spacing
class Stroke {
  constructor(tool) {
    this.tool = tool;             // 'brush' | 'eraser'
    this.last = null;
    this.carry = 0;               // leftover distance for spacing
    this.ctx = doc.layer.ctx;
    this.rgb = hexToRgb(brush.color);
    this.ctx.save();
    this.ctx.globalCompositeOperation =
      tool === 'eraser' ? 'destination-out' : 'source-over';
    this.ctx.globalAlpha = brush.opacity;
    // build the soft tip once for this stroke (128px), scaled per stamp
    this.tip = makeStampTip(128, this.rgb, brush.hardness);
  }
  _stampAt(x, y, pressure) {
    const radius = Math.max(0.5, (brush.size / 2) * (brush.usePressure ? (0.15 + pressure * 0.85) : 1));
    this.ctx.drawImage(this.tip, x - radius, y - radius, radius * 2, radius * 2);
    return radius;
  }
  to(x, y, pressure) {
    if (!this.last) {
      this._stampAt(x, y, pressure);
      this.last = { x, y, p: pressure };
      return;
    }
    const dx = x - this.last.x, dy = y - this.last.y;
    const dist = Math.hypot(dx, dy);
    const radius = Math.max(0.5, (brush.size / 2));
    const spacing = Math.max(1, radius * 0.18);
    let d = this.carry;
    while (d <= dist) {
      const t = dist === 0 ? 0 : d / dist;
      const px = this.last.x + dx * t;
      const py = this.last.y + dy * t;
      const pr = this.last.p + (pressure - this.last.p) * t;
      this._stampAt(px, py, pr);
      d += spacing;
    }
    this.carry = d - dist;
    this.last = { x, y, p: pressure };
  }
  end() { this.ctx.restore(); }
}

// ---------------------------------------------------------------- Flood fill
function floodFill(x, y, hex) {
  x = Math.round(x); y = Math.round(y);
  const ctx = doc.layer.ctx;
  const w = doc.width, h = doc.height;
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const idx = (px, py) => (py * w + px) * 4;
  const start = idx(x, y);
  const target = [data[start], data[start + 1], data[start + 2], data[start + 3]];
  const rgb = hexToRgb(hex);
  const fill = [rgb.r, rgb.g, rgb.b, 255];
  if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === fill[3]) return;
  const tol = 32;
  const match = (i) =>
    Math.abs(data[i] - target[0]) <= tol &&
    Math.abs(data[i + 1] - target[1]) <= tol &&
    Math.abs(data[i + 2] - target[2]) <= tol &&
    Math.abs(data[i + 3] - target[3]) <= tol;
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    let ny = cy;
    while (ny >= 0 && match(idx(cx, ny))) ny--;
    ny++;
    let spanL = false, spanR = false;
    while (ny < h && match(idx(cx, ny))) {
      const i = idx(cx, ny);
      data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fill[3];
      if (cx > 0) {
        if (match(idx(cx - 1, ny))) { if (!spanL) { stack.push([cx - 1, ny]); spanL = true; } }
        else spanL = false;
      }
      if (cx < w - 1) {
        if (match(idx(cx + 1, ny))) { if (!spanR) { stack.push([cx + 1, ny]); spanR = true; } }
        else spanR = false;
      }
      ny++;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function pickColor(x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
  // sample the composited view
  const p = vctx.getImageData(x, y, 1, 1).data;
  if (p[3] === 0) return null;
  return '#' + [p[0], p[1], p[2]].map(v => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- Tools/input
let tool = 'brush';
let stroke = null;
let panning = false;
let panStart = null;
let moving = false;
let moveStart = null;
let spaceDown = false;

function setTool(t) {
  tool = t;
  document.querySelectorAll('.tool[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === t));
  $('#status-tool').textContent = t[0].toUpperCase() + t.slice(1);
  view.style.cursor = (t === 'pan') ? 'grab' : 'none';
}

view.addEventListener('pointerdown', (e) => {
  view.setPointerCapture(e.pointerId);
  const p = toDoc(e.clientX, e.clientY);
  const pressure = (e.pointerType === 'pen') ? e.pressure : 1;
  const activeTool = (spaceDown || e.button === 1) ? 'pan' : tool;

  if (activeTool === 'pan') {
    panning = true; panStart = { x: e.clientX - cam.x, y: e.clientY - cam.y };
    view.style.cursor = 'grabbing';
    return;
  }
  if (tool === 'eyedropper') {
    const col = pickColor(p.x, p.y);
    if (col) { brush.color = col; $('#color').value = col; }
    return;
  }
  if (tool === 'fill') {
    history.push(doc.layer);
    floodFill(p.x, p.y, brush.color);
    composite(); updateThumb(doc.active);
    return;
  }
  if (tool === 'move') {
    history.push(doc.layer);
    moving = true; moveStart = { x: p.x, y: p.y, snap: doc.layer.ctx.getImageData(0,0,doc.width,doc.height) };
    return;
  }
  // brush / eraser
  history.push(doc.layer);
  stroke = new Stroke(tool);
  stroke.to(p.x, p.y, pressure);
  composite();
});

view.addEventListener('pointermove', (e) => {
  const p = toDoc(e.clientX, e.clientY);
  $('#status-pos').textContent = `${Math.round(p.x)}, ${Math.round(p.y)}`;
  updateCursorRing(e.clientX, e.clientY);

  if (panning) {
    cam.x = e.clientX - panStart.x; cam.y = e.clientY - panStart.y; applyCam(); return;
  }
  if (moving) {
    const dx = Math.round(p.x - moveStart.x), dy = Math.round(p.y - moveStart.y);
    const ctx = doc.layer.ctx;
    ctx.clearRect(0, 0, doc.width, doc.height);
    ctx.putImageData(moveStart.snap, dx, dy);
    composite(); return;
  }
  if (stroke) {
    const pressure = (e.pointerType === 'pen') ? e.pressure : 1;
    // coalesced events give smoother, higher-rate strokes;
    // fall back to the event itself when none are reported (empty on some devices/synthetic events)
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = coalesced.length ? coalesced : [e];
    for (const ce of events) {
      const cp = toDoc(ce.clientX, ce.clientY);
      const pr = (ce.pointerType === 'pen') ? ce.pressure : pressure;
      stroke.to(cp.x, cp.y, pr);
    }
    composite();
  }
});

function endPointer() {
  if (stroke) { stroke.end(); stroke = null; updateThumb(doc.active); }
  if (moving) { moving = false; updateThumb(doc.active); }
  if (panning) { panning = false; view.style.cursor = (tool === 'pan') ? 'grab' : 'none'; }
}
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);

// Zoom with wheel (anchored at cursor)
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newScale = clamp(cam.scale * factor, 0.05, 32);
  const k = newScale / cam.scale;
  cam.x = mx - (mx - cam.x) * k;
  cam.y = my - (my - cam.y) * k;
  cam.scale = newScale;
  applyCam();
}, { passive: false });

// Cursor ring shows brush size
function updateCursorRing(clientX, clientY) {
  const ring = $('#cursor-ring');
  if (tool === 'pan' || tool === 'move' || tool === 'fill' || tool === 'eyedropper') {
    ring.style.display = 'none'; return;
  }
  const r = brush.size * cam.scale;
  ring.style.display = 'block';
  ring.style.width = ring.style.height = r + 'px';
  ring.style.left = (clientX - stage.getBoundingClientRect().left) + 'px';
  ring.style.top = (clientY - stage.getBoundingClientRect().top) + 'px';
}
stage.addEventListener('pointerleave', () => { $('#cursor-ring').style.display = 'none'; });

// ---------------------------------------------------------------- Layers UI
function addLayer(name, makeActive = true) {
  const l = new Layer(doc.width, doc.height, name || `Layer ${doc.layers.length + 1}`);
  doc.layers.push(l);
  if (makeActive) doc.active = doc.layers.length - 1;
  renderLayerList(); composite();
  return l;
}
function deleteLayer() {
  if (doc.layers.length <= 1) return;
  doc.layers.splice(doc.active, 1);
  doc.active = clamp(doc.active, 0, doc.layers.length - 1);
  renderLayerList(); composite();
}
function updateThumb(i) {
  const l = doc.layers[i];
  const item = $(`#layer-list [data-i="${i}"] .thumb`);
  if (l && item) item.style.backgroundImage = `url(${l.canvas.toDataURL()})`;
}
function renderLayerList() {
  const list = $('#layer-list');
  list.innerHTML = '';
  doc.layers.forEach((l, i) => {
    const li = document.createElement('li');
    li.className = 'layer-item' + (i === doc.active ? ' selected' : '');
    li.dataset.i = i;
    li.innerHTML = `
      <span class="vis">${l.visible ? '👁' : '🚫'}</span>
      <span class="thumb" style="background-image:url(${l.canvas.toDataURL()})"></span>
      <span class="name"><input value="${l.name}" /></span>
      <span class="drag">⋮⋮</span>`;
    li.addEventListener('pointerdown', (e) => {
      if (e.target.closest('input') || e.target.classList.contains('vis')) return;
      doc.active = i; syncLayerControls(); renderLayerList();
    });
    li.querySelector('.vis').addEventListener('click', () => { l.visible = !l.visible; composite(); renderLayerList(); });
    li.querySelector('input').addEventListener('change', (e) => { l.name = e.target.value; });
    list.appendChild(li);
  });
  syncLayerControls();
}
function syncLayerControls() {
  const l = doc.layer; if (!l) return;
  $('#layer-opacity').value = Math.round(l.opacity * 100);
  $('#layer-op-val').textContent = Math.round(l.opacity * 100);
  $('#blend-mode').value = l.blend;
}

// ---------------------------------------------------------------- New document
function newDocument(w, h, bg) {
  doc.width = w; doc.height = h;
  doc.layers = []; doc.active = 0;
  view.width = w; view.height = h;
  Layer._id = 1;
  const base = addLayer('Background', true);
  if (bg && bg !== 'transparent') {
    base.ctx.fillStyle = bg;
    base.ctx.fillRect(0, 0, w, h);
  }
  addLayer('Layer 1', true);
  $('#status-doc').textContent = `${w} × ${h}`;
  history.stack.length = 0; history.redoStack.length = 0;
  fitToScreen(); composite(); renderLayerList();
}

// ---------------------------------------------------------------- Export
async function exportPng() {
  // flatten to a temp canvas
  const out = document.createElement('canvas');
  out.width = doc.width; out.height = doc.height;
  const octx = out.getContext('2d', { willReadFrequently: true });
  for (const l of doc.layers) {
    if (!l.visible || l.opacity <= 0) continue;
    octx.globalAlpha = l.opacity; octx.globalCompositeOperation = l.blend;
    octx.drawImage(l.canvas, 0, 0);
  }
  const dataUrl = out.toDataURL('image/png');
  if (window.inkforge?.savePng) {
    await window.inkforge.savePng(dataUrl);
  } else {
    // browser fallback (for preview/testing outside Electron)
    const a = document.createElement('a');
    a.href = dataUrl; a.download = 'inkforge-artwork.png'; a.click();
  }
}

// ---------------------------------------------------------------- UI wiring
function bindUI() {
  document.querySelectorAll('.tool[data-tool]').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  $('#color').addEventListener('input', e => brush.color = e.target.value);
  const sync = (id, valId, apply, fmt = (v) => v) => {
    const el = $('#' + id);
    el.addEventListener('input', e => { apply(+e.target.value); $('#' + valId).textContent = fmt(+e.target.value); });
  };
  sync('size', 'size-val', v => brush.size = v);
  sync('opacity', 'opacity-val', v => brush.opacity = v / 100);
  sync('hardness', 'hardness-val', v => brush.hardness = v / 100);
  $('#pressure').addEventListener('change', e => brush.usePressure = e.target.checked);

  $('#layer-opacity').addEventListener('input', e => {
    doc.layer.opacity = +e.target.value / 100;
    $('#layer-op-val').textContent = e.target.value; composite();
  });
  $('#blend-mode').addEventListener('change', e => { doc.layer.blend = e.target.value; composite(); });

  $('#btn-add-layer').addEventListener('click', () => addLayer());
  $('#btn-del-layer').addEventListener('click', deleteLayer);
  $('#btn-undo').addEventListener('click', () => history.undo());
  $('#btn-redo').addEventListener('click', () => history.redo());
  $('#btn-fit').addEventListener('click', fitToScreen);
  $('#btn-export').addEventListener('click', exportPng);
  $('#btn-new').addEventListener('click', () => $('#new-dialog').showModal());

  $('#nc-create').addEventListener('click', (e) => {
    // let the dialog close, then read values
    setTimeout(() => {
      const w = clamp(+$('#nc-w').value, 1, 8192);
      const h = clamp(+$('#nc-h').value, 1, 8192);
      newDocument(w, h, $('#nc-bg').value);
    }, 0);
  });

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { spaceDown = true; view.style.cursor = 'grab'; e.preventDefault(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); return; }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); exportPng(); return; }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); $('#new-dialog').showModal(); return; }
    if (mod && e.key === '0') { e.preventDefault(); fitToScreen(); return; }
    const map = { b: 'brush', e: 'eraser', g: 'fill', i: 'eyedropper', v: 'move', h: 'pan' };
    if (!mod && map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
    if (e.key === '[') { brush.size = clamp(brush.size - 2, 1, 400); $('#size').value = brush.size; $('#size-val').textContent = brush.size; }
    if (e.key === ']') { brush.size = clamp(brush.size + 2, 1, 400); $('#size').value = brush.size; $('#size-val').textContent = brush.size; }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceDown = false; view.style.cursor = (tool === 'pan') ? 'grab' : 'none'; }
  });

  // Electron menu hooks
  if (window.inkforge?.onMenu) {
    window.inkforge.onMenu('menu:new', () => $('#new-dialog').showModal());
    window.inkforge.onMenu('menu:export', exportPng);
    window.inkforge.onMenu('menu:undo', () => history.undo());
    window.inkforge.onMenu('menu:redo', () => history.redo());
    window.inkforge.onMenu('menu:fit', fitToScreen);
  }
  window.addEventListener('resize', () => applyCam());
}

// ---------------------------------------------------------------- Boot
bindUI();
setTool('brush');
newDocument(1920, 1080, '#ffffff');
