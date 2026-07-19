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
  frames: [{ layers: [] }],
  frame: 0,
  active: 0,
  fps: 12,
  get layers() { return this.frames[this.frame].layers; },
  set layers(v) { this.frames[this.frame].layers = v; },
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
const cam = { x: 0, y: 0, scale: 1, rot: 0 };  // rot in degrees

function applyCam() {
  wrap.style.transform = `translate(${cam.x}px, ${cam.y}px) rotate(${cam.rot}deg) scale(${cam.scale})`;
  $('#zoom-label').textContent = Math.round(cam.scale * 100) + '%';
  if (typeof updateKnobs === 'function') updateKnobs();
}
function fitToScreen() {
  const pad = 60;
  cam.rot = 0;
  const sw = stage.clientWidth - pad, sh = stage.clientHeight - pad;
  cam.scale = Math.min(sw / doc.width, sh / doc.height, 1);
  cam.x = (stage.clientWidth - doc.width * cam.scale) / 2;
  cam.y = (stage.clientHeight - doc.height * cam.scale) / 2;
  applyCam();
}
// screen (client) coords -> document pixel coords (undo translate, rotate, scale)
function toDoc(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  const x = clientX - r.left - cam.x;
  const y = clientY - r.top - cam.y;
  const rad = cam.rot * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    x: (x * cos + y * sin) / cam.scale,
    y: (-x * sin + y * cos) / cam.scale
  };
}

// ---------------------------------------------------------------- Compositing
function composite() {
  vctx.clearRect(0, 0, view.width, view.height);
  if (onionSkin && !playing && doc.frame > 0) {
    vctx.globalAlpha = 0.28;
    vctx.drawImage(flattenFrame(doc.frame - 1), 0, 0);
    vctx.globalAlpha = 1;
  }
  for (const l of doc.layers) {
    if (!l.visible || l.opacity <= 0) continue;
    vctx.globalAlpha = l.opacity;
    vctx.globalCompositeOperation = l.blend;
    vctx.drawImage(l.canvas, 0, 0);
  }
  vctx.globalAlpha = 1;
  vctx.globalCompositeOperation = 'source-over';
  if (selection && selection.w && selection.h) drawAnts();
}

function drawAnts() {
  const s = selection;
  vctx.save();
  vctx.lineWidth = 1;
  vctx.setLineDash([6, 4]);
  vctx.strokeStyle = '#000';
  vctx.lineDashOffset = -antsOffset;
  vctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
  vctx.strokeStyle = '#fff';
  vctx.lineDashOffset = -antsOffset + 5;
  vctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
  vctx.restore();
}

// Animate marching ants only when a selection is idle (no active drag)
let antsTick = 0;
function antsLoop() {
  requestAnimationFrame(antsLoop);
  if (!(selection && selection.w && selection.h)) return;
  if (stroke || smear || shape || selDrag || moving || panning) return;
  if (++antsTick % 5 !== 0) return;
  antsOffset = (antsOffset + 2) % 10;
  composite();
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
    if (selection && selection.w && selection.h) {
      this.ctx.beginPath();
      this.ctx.rect(selection.x, selection.y, selection.w, selection.h);
      this.ctx.clip();
    }
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
let shape = null;            // { start:{x,y}, snap } while dragging a shape
let pendingTextPos = null;   // doc-space anchor for the text dialog
let selection = null;        // { x, y, w, h } in doc coords, or null
let selDrag = null;          // { start:{x,y} } while dragging a marquee
let smear = null;            // { tip, last } while smudge/liquify dragging
let antsOffset = 0;          // marching-ants animation phase
let playing = false;         // animation playback active
let onionSkin = false;       // show previous frame as a ghost
let playTimer = null;

// Flatten one frame's visible layers to a standalone canvas
function flattenFrame(fi) {
  const frame = doc.frames[fi];
  const c = document.createElement('canvas');
  c.width = doc.width; c.height = doc.height;
  const cx = c.getContext('2d');
  for (const l of frame.layers) {
    if (!l.visible || l.opacity <= 0) continue;
    cx.globalAlpha = l.opacity; cx.globalCompositeOperation = l.blend;
    cx.drawImage(l.canvas, 0, 0);
  }
  return c;
}

// ---- Image-op helpers (disc sampling for smudge/liquify, filters, effects) ----
// Copy a soft-edged circular disc of radius r from src centered at (cx,cy)
function sampleDisc(src, cx, cy, r) {
  const d = Math.max(2, Math.ceil(r * 2));
  const c = document.createElement('canvas');
  c.width = c.height = d;
  const cx2 = c.getContext('2d', { willReadFrequently: true });
  cx2.drawImage(src, cx - r, cy - r, d, d, 0, 0, d, d);
  // soft radial alpha mask
  cx2.globalCompositeOperation = 'destination-in';
  const g = cx2.createRadialGradient(r, r, r * 0.25, r, r, r);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  cx2.fillStyle = g;
  cx2.beginPath(); cx2.arc(r, r, r, 0, Math.PI * 2); cx2.fill();
  return c;
}

// Solid-color silhouette of a canvas's alpha (for stroke/glow effects)
function silhouette(src, color) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const cx = c.getContext('2d');
  cx.drawImage(src, 0, 0);
  cx.globalCompositeOperation = 'source-in';
  cx.fillStyle = color;
  cx.fillRect(0, 0, c.width, c.height);
  return c;
}

// Destructively apply a filter to the active layer
function applyFilter(type, amount) {
  const layer = doc.layer;
  const w = doc.width, h = doc.height;
  const snap = document.createElement('canvas');
  snap.width = w; snap.height = h;
  snap.getContext('2d').drawImage(layer.canvas, 0, 0);
  const ctx = layer.ctx;
  const a = amount / 100;
  const filters = {
    grayscale: `grayscale(${a})`,
    invert: `invert(${a})`,
    sepia: `sepia(${a})`,
    blur: `blur(${(a * 8).toFixed(2)}px)`,
    brighten: `brightness(${1 + a * 0.4})`,
    darken: `brightness(${1 - a * 0.4})`,
    'contrast-up': `contrast(${1 + a * 0.5})`,
    'contrast-down': `contrast(${1 - a * 0.5})`,
    saturate: `saturate(${1 + a})`,
    desaturate: `saturate(${1 - a})`,
    hue: `hue-rotate(${a * 180}deg)`
  };
  history.push(layer);
  if (type === 'sharpen') { sharpenLayer(ctx, w, h, a); }
  else {
    ctx.clearRect(0, 0, w, h);
    ctx.filter = filters[type] || 'none';
    ctx.drawImage(snap, 0, 0);
    ctx.filter = 'none';
  }
  composite(); updateThumb(doc.active);
}

// 3x3 unsharp-ish convolution
function sharpenLayer(ctx, w, h, strength) {
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  const s = src.data, o = out.data;
  const k = strength; // center weight boost
  const idx = (x, y) => (y * w + x) * 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      for (let ch = 0; ch < 3; ch++) {
        const c = s[i + ch];
        let sum = c * (1 + 4 * k);
        if (x > 0) sum -= s[idx(x - 1, y) + ch] * k;
        if (x < w - 1) sum -= s[idx(x + 1, y) + ch] * k;
        if (y > 0) sum -= s[idx(x, y - 1) + ch] * k;
        if (y < h - 1) sum -= s[idx(x, y + 1) + ch] * k;
        o[i + ch] = clamp(sum, 0, 255);
      }
      o[i + 3] = s[i + 3];
    }
  }
  ctx.putImageData(out, 0, 0);
}

// Destructively apply a layer effect to the active layer
function applyEffect(type, size, color) {
  const layer = doc.layer;
  const w = doc.width, h = doc.height;
  const original = document.createElement('canvas');
  original.width = w; original.height = h;
  original.getContext('2d').drawImage(layer.canvas, 0, 0);
  const ctx = layer.ctx;
  history.push(layer);
  ctx.clearRect(0, 0, w, h);
  if (type === 'shadow') {
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = size;
    ctx.shadowOffsetX = size * 0.6; ctx.shadowOffsetY = size * 0.6;
    ctx.drawImage(original, 0, 0);
    ctx.restore();
    ctx.drawImage(original, 0, 0);
  } else if (type === 'glow') {
    const sil = silhouette(original, color);
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = size;
    for (let i = 0; i < 3; i++) ctx.drawImage(sil, 0, 0);
    ctx.restore();
    ctx.drawImage(original, 0, 0);
  } else if (type === 'stroke') {
    const sil = silhouette(original, color);
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      ctx.drawImage(sil, Math.cos(a) * size, Math.sin(a) * size);
    }
    ctx.drawImage(original, 0, 0);
  }
  composite(); updateThumb(doc.active);
}

function setTool(t) {
  tool = t;
  document.querySelectorAll('.tool[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === t));
  $('#status-tool').textContent = t[0].toUpperCase() + t.slice(1);
  const crosshair = ['line', 'rect', 'ellipse', 'text', 'select'].includes(t);
  view.style.cursor = (t === 'pan') ? 'grab' : (crosshair ? 'crosshair' : 'none');
}

// Draw a shape preview/commit onto a layer context (doc coords)
function drawShape(ctx, kind, x0, y0, x1, y1, shift) {
  ctx.save();
  if (selection && selection.w && selection.h) {
    ctx.beginPath(); ctx.rect(selection.x, selection.y, selection.w, selection.h); ctx.clip();
  }
  ctx.strokeStyle = brush.color;
  ctx.lineWidth = Math.max(1, brush.size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = brush.opacity;
  if (kind === 'line') {
    if (shift) {
      const dx = x1 - x0, dy = y1 - y0;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      x1 = x0 + Math.cos(ang) * len; y1 = y0 + Math.sin(ang) * len;
    }
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  } else if (kind === 'rect') {
    let w = x1 - x0, h = y1 - y0;
    if (shift) { const s = Math.max(Math.abs(w), Math.abs(h)); w = (Math.sign(w) || 1) * s; h = (Math.sign(h) || 1) * s; }
    ctx.strokeRect(x0, y0, w, h);
  } else if (kind === 'ellipse') {
    let rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
    if (shift) { const r = Math.max(rx, ry); rx = r; ry = r; }
    const cx = x0 + (Math.sign(x1 - x0) || 1) * rx, cy = y0 + (Math.sign(y1 - y0) || 1) * ry;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

// Stamp multi-line text onto the active layer at the pending anchor
function commitText() {
  const txt = $('#tx-text').value;
  if (!txt || !pendingTextPos) { pendingTextPos = null; return; }
  history.push(doc.layer);
  const ctx = doc.layer.ctx;
  const size = clamp(+$('#tx-size').value || 72, 6, 800);
  const font = $('#tx-font').value;
  const bold = $('#tx-bold').checked ? 'bold ' : '';
  ctx.save();
  ctx.fillStyle = brush.color;
  ctx.globalAlpha = brush.opacity;
  ctx.textBaseline = 'top';
  ctx.font = `${bold}${size}px ${font}`;
  txt.split('\n').forEach((line, i) =>
    ctx.fillText(line, pendingTextPos.x, pendingTextPos.y + i * size * 1.2));
  ctx.restore();
  composite(); updateThumb(doc.active);
  $('#tx-text').value = '';
  pendingTextPos = null;
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
    if (col) { setColorHex(col); addRecent(); }
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
  if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
    history.push(doc.layer);
    shape = { start: { x: p.x, y: p.y }, snap: doc.layer.ctx.getImageData(0, 0, doc.width, doc.height) };
    return;
  }
  if (tool === 'text') {
    pendingTextPos = { x: p.x, y: p.y };
    $('#text-dialog').showModal();
    return;
  }
  if (tool === 'select') {
    selDrag = { start: { x: p.x, y: p.y } };
    selection = { x: p.x, y: p.y, w: 0, h: 0 };
    return;
  }
  if (tool === 'smudge' || tool === 'liquify') {
    history.push(doc.layer);
    const r = Math.max(1, brush.size / 2);
    smear = { last: { x: p.x, y: p.y }, tip: sampleDisc(doc.layer.canvas, p.x, p.y, r), r };
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
  if (shape) {
    const ctx = doc.layer.ctx;
    ctx.putImageData(shape.snap, 0, 0);
    drawShape(ctx, tool, shape.start.x, shape.start.y, p.x, p.y, e.shiftKey);
    composite(); return;
  }
  if (selDrag) {
    const x0 = selDrag.start.x, y0 = selDrag.start.y;
    selection = { x: Math.min(x0, p.x), y: Math.min(y0, p.y), w: Math.abs(p.x - x0), h: Math.abs(p.y - y0) };
    composite(); return;
  }
  if (smear) {
    const ctx = doc.layer.ctx;
    const r = smear.r;
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = coalesced.length ? coalesced : [e];
    for (const ce of events) {
      const cp = toDoc(ce.clientX, ce.clientY);
      if (tool === 'smudge') {
        ctx.globalAlpha = 0.55 * brush.opacity;
        ctx.drawImage(smear.tip, cp.x - r, cp.y - r);
        smear.tip = sampleDisc(doc.layer.canvas, cp.x, cp.y, r);
      } else { // liquify push: drag a copy of trailing pixels toward the cursor
        const sample = sampleDisc(doc.layer.canvas, smear.last.x, smear.last.y, r);
        ctx.globalAlpha = 0.85;
        ctx.drawImage(sample, cp.x - r, cp.y - r);
      }
      smear.last = { x: cp.x, y: cp.y };
    }
    ctx.globalAlpha = 1;
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
  if (shape) { shape = null; updateThumb(doc.active); }
  if (smear) { smear = null; updateThumb(doc.active); }
  if (selDrag) {
    selDrag = null;
    if (selection && (selection.w < 3 || selection.h < 3)) selection = null;
    composite();
  }
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
  if (!['brush', 'eraser', 'smudge', 'liquify'].includes(tool)) { ring.style.display = 'none'; return; }
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
  doc.frames = [{ layers: [] }]; doc.frame = 0; doc.active = 0;
  view.width = w; view.height = h;
  Layer._id = 1;
  selection = null;
  const base = addLayer('Background', true);
  if (bg && bg !== 'transparent') {
    base.ctx.fillStyle = bg;
    base.ctx.fillRect(0, 0, w, h);
  }
  addLayer('Layer 1', true);
  $('#status-doc').textContent = `${w} × ${h}`;
  history.stack.length = 0; history.redoStack.length = 0;
  fitToScreen(); composite(); renderLayerList(); renderFrameList(); updateFrameStatus();
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

// ---------------------------------------------------------------- Save / Load
async function saveProject() {
  const data = {
    version: 2, width: doc.width, height: doc.height, fps: doc.fps,
    frame: doc.frame, active: doc.active,
    frames: doc.frames.map(fr => ({
      layers: fr.layers.map(l => ({
        name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend,
        png: l.canvas.toDataURL()
      }))
    }))
  };
  const json = JSON.stringify(data);
  if (window.inkforge?.saveProject) await window.inkforge.saveProject(json);
  else { // browser fallback
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'artwork.inkforge'; a.click();
  }
}
async function openProject() {
  if (!window.inkforge?.openProject) return;
  const json = await window.inkforge.openProject();
  if (!json) return;
  await loadProjectJson(json);
}
async function loadProjectJson(json) {
  const data = JSON.parse(json);
  stopPlay();
  doc.width = data.width; doc.height = data.height;
  doc.fps = data.fps || 12;
  view.width = data.width; view.height = data.height;
  Layer._id = 1;
  // v1 projects stored a flat `layers` array; v2 stores `frames`
  const srcFrames = data.frames || [{ layers: data.layers || [] }];
  const buildLayer = (ld) => new Promise((res) => {
    const l = new Layer(doc.width, doc.height, ld.name);
    l.visible = ld.visible; l.opacity = ld.opacity; l.blend = ld.blend;
    const img = new Image();
    img.onload = () => { l.ctx.drawImage(img, 0, 0); res(l); };
    img.onerror = () => res(l);
    img.src = ld.png;
  });
  doc.frames = [];
  for (const fr of srcFrames) {
    const layers = [];
    for (const ld of fr.layers) layers.push(await buildLayer(ld));
    doc.frames.push({ layers });
  }
  if (!doc.frames.length) doc.frames = [newFrame(null)];
  doc.frame = clamp(data.frame || 0, 0, doc.frames.length - 1);
  doc.active = clamp(data.active || 0, 0, doc.layers.length - 1);
  selection = null;
  history.stack.length = 0; history.redoStack.length = 0;
  $('#tl-fps').value = doc.fps;
  $('#status-doc').textContent = `${doc.width} × ${doc.height}`;
  fitToScreen(); composite(); renderLayerList(); renderFrameList(); updateFrameStatus();
}

// ---------------------------------------------------------------- Brush presets
const BRUSH_PRESETS = {
  Pencil:   { size: 4,  hardness: 0.95, opacity: 1 },
  Ink:      { size: 10, hardness: 0.9,  opacity: 1 },
  Marker:   { size: 26, hardness: 0.6,  opacity: 0.85 },
  Airbrush: { size: 60, hardness: 0.08, opacity: 0.25 },
  Soft:     { size: 80, hardness: 0.25, opacity: 0.8 }
};
function applyPreset(name) {
  const p = BRUSH_PRESETS[name]; if (!p) return;
  brush.size = p.size; brush.hardness = p.hardness; brush.opacity = p.opacity;
  $('#size').value = p.size; $('#size-val').textContent = p.size;
  $('#opacity').value = Math.round(p.opacity * 100); $('#opacity-val').textContent = Math.round(p.opacity * 100);
  $('#hardness').value = Math.round(p.hardness * 100); $('#hardness-val').textContent = Math.round(p.hardness * 100);
  updateKnobs();
  if (tool !== 'brush') setTool('brush');
}

// ---------------------------------------------------------------- Animation
function newFrame(copyFrom) {
  const layers = [];
  if (copyFrom) {
    for (const l of copyFrom.layers) {
      const nl = new Layer(doc.width, doc.height, l.name);
      nl.visible = l.visible; nl.opacity = l.opacity; nl.blend = l.blend;
      nl.ctx.drawImage(l.canvas, 0, 0);
      layers.push(nl);
    }
  } else {
    layers.push(new Layer(doc.width, doc.height, 'Layer 1'));
  }
  return { layers };
}
function addFrame(duplicate) {
  doc.frames.splice(doc.frame + 1, 0, newFrame(duplicate ? doc.frames[doc.frame] : null));
  doc.frame++; doc.active = 0;
  composite(); renderLayerList(); renderFrameList(); updateFrameStatus();
}
function deleteFrame() {
  if (doc.frames.length <= 1) return;
  doc.frames.splice(doc.frame, 1);
  doc.frame = clamp(doc.frame, 0, doc.frames.length - 1);
  doc.active = clamp(doc.active, 0, doc.layers.length - 1);
  composite(); renderLayerList(); renderFrameList(); updateFrameStatus();
}
function selectFrame(i) {
  doc.frame = clamp(i, 0, doc.frames.length - 1);
  doc.active = clamp(doc.active, 0, doc.layers.length - 1);
  composite(); renderLayerList(); renderFrameList(); updateFrameStatus();
}
function renderFrameList() {
  const list = $('#frame-list'); if (!list) return;
  list.innerHTML = '';
  doc.frames.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'frame-item' + (i === doc.frame ? ' selected' : '');
    li.innerHTML = `<div class="fthumb" style="background-image:url(${flattenFrame(i).toDataURL()})"></div><div class="fnum">${i + 1}</div>`;
    li.addEventListener('click', () => selectFrame(i));
    list.appendChild(li);
  });
}
function highlightFrame() {
  document.querySelectorAll('#frame-list .frame-item').forEach((el, i) => el.classList.toggle('selected', i === doc.frame));
}
function updateFrameStatus() { $('#status-frame').textContent = `Frame ${doc.frame + 1}/${doc.frames.length}`; }
function togglePlay() { playing ? stopPlay() : startPlay(); }
function startPlay() {
  if (doc.frames.length < 2) return;
  playing = true; $('#tl-play').textContent = '⏸';
  let f = doc.frame;
  playTimer = setInterval(() => {
    f = (f + 1) % doc.frames.length;
    doc.frame = f; composite(); highlightFrame(); updateFrameStatus();
  }, 1000 / doc.fps);
}
function stopPlay() {
  playing = false; $('#tl-play').textContent = '▶';
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
}

async function exportGif() {
  stopPlay();
  const delayCs = Math.max(2, Math.round(100 / doc.fps));
  const canvases = doc.frames.map((_, i) => flattenFrame(i));
  const bytes = buildGif(canvases, delayCs);
  await saveBinary(bytes, 'animation.gif', 'gif');
}
async function exportWebm() {
  stopPlay();
  if (!window.MediaRecorder) return;
  const c = document.createElement('canvas'); c.width = doc.width; c.height = doc.height;
  const cx = c.getContext('2d');
  const stream = c.captureStream(doc.fps);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(res => { rec.onstop = res; });
  rec.start();
  for (let f = 0; f < doc.frames.length; f++) {
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(flattenFrame(f), 0, 0);
    await new Promise(r => setTimeout(r, 1000 / doc.fps));
  }
  rec.stop(); await done;
  const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
  await saveBinary(buf, 'animation.webm', 'webm');
}

// Write raw bytes to disk (native dialog in Electron, download in browser)
async function saveBinary(bytes, defaultName, ext) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  const base64 = btoa(binary);
  if (window.inkforge?.saveFile) await window.inkforge.saveFile({ defaultName, ext, base64 });
  else { const a = document.createElement('a'); a.href = 'data:application/octet-stream;base64,' + base64; a.download = defaultName; a.click(); }
}

// ---------------------------------------------------------------- GIF89a encoder
function buildGif(frameCanvases, delayCs) {
  const w = doc.width, h = doc.height;
  const framePixels = frameCanvases.map(c => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data);
  // sample opaque colors across all frames for a shared palette
  const samples = [];
  const total = w * h * framePixels.length;
  const step = Math.max(1, Math.floor(total / 120000)) * 4;
  for (const d of framePixels) {
    for (let i = 0; i < d.length; i += step) {
      if (d[i + 3] < 128) continue;
      samples.push([d[i], d[i + 1], d[i + 2]]);
    }
  }
  let palette = samples.length ? medianCut(samples, 255) : [[0, 0, 0]];
  if (palette.length > 255) palette = palette.slice(0, 255);
  const transIndex = palette.length;
  const fullPalette = palette.slice();
  while (fullPalette.length < 256) fullPalette.push([0, 0, 0]);

  const cache = new Map();
  const nearest = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let idx = cache.get(key);
    if (idx !== undefined) return idx;
    let best = 0, bestD = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const dr = r - palette[p][0], dg = g - palette[p][1], db = b - palette[p][2];
      const dd = dr * dr + dg * dg + db * db;
      if (dd < bestD) { bestD = dd; best = p; if (!dd) break; }
    }
    cache.set(key, best);
    return best;
  };
  const indexed = framePixels.map(d => {
    const out = new Uint8Array(w * h);
    for (let px = 0, i = 0; px < out.length; px++, i += 4) {
      out[px] = d[i + 3] < 128 ? transIndex : nearest(d[i], d[i + 1], d[i + 2]);
    }
    return out;
  });

  const bytes = [];
  const pushStr = s => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };
  pushStr('GIF89a');
  bytes.push(w & 255, (w >> 8) & 255, h & 255, (h >> 8) & 255, 0xF7, 0, 0);
  for (const c of fullPalette) bytes.push(c[0], c[1], c[2]);
  bytes.push(0x21, 0xFF, 0x0B);
  pushStr('NETSCAPE2.0');
  bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);
  for (let f = 0; f < indexed.length; f++) {
    bytes.push(0x21, 0xF9, 0x04, 0x01, delayCs & 255, (delayCs >> 8) & 255, transIndex, 0x00);
    bytes.push(0x2C, 0, 0, 0, 0, w & 255, (w >> 8) & 255, h & 255, (h >> 8) & 255, 0x00);
    bytes.push(8);
    const lzw = lzwEncode(indexed[f], 8);
    for (let i = 0; i < lzw.length; i += 255) {
      const end = Math.min(i + 255, lzw.length);
      bytes.push(end - i);
      for (let j = i; j < end; j++) bytes.push(lzw[j]);
    }
    bytes.push(0x00);
  }
  bytes.push(0x3B);
  return new Uint8Array(bytes);
}
function medianCut(pixels, maxColors) {
  const makeBox = (px) => {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0, rs = 0, gs = 0, bs = 0;
    for (const p of px) {
      if (p[0] < rmin) rmin = p[0]; if (p[0] > rmax) rmax = p[0];
      if (p[1] < gmin) gmin = p[1]; if (p[1] > gmax) gmax = p[1];
      if (p[2] < bmin) bmin = p[2]; if (p[2] > bmax) bmax = p[2];
      rs += p[0]; gs += p[1]; bs += p[2];
    }
    const rr = rmax - rmin, gr = gmax - gmin, br = bmax - bmin;
    const n = px.length || 1;
    return { pixels: px, range: Math.max(rr, gr, br), widest: (rr >= gr && rr >= br) ? 0 : (gr >= br ? 1 : 2),
             avg: [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)] };
  };
  let boxes = [makeBox(pixels)];
  while (boxes.length < maxColors) {
    boxes.sort((a, b) => b.range - a.range);
    const box = boxes[0];
    if (!box || box.pixels.length < 2 || box.range === 0) break;
    boxes.shift();
    const ch = box.widest;
    box.pixels.sort((p, q) => p[ch] - q[ch]);
    const mid = box.pixels.length >> 1;
    boxes.push(makeBox(box.pixels.slice(0, mid)));
    boxes.push(makeBox(box.pixels.slice(mid)));
  }
  return boxes.map(b => b.avg);
}
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict, next;
  const reset = () => { dict = new Map(); for (let i = 0; i < clearCode; i++) dict.set('' + i, i); next = eoiCode + 1; codeSize = minCodeSize + 1; };
  const out = [];
  let cur = 0, curBits = 0;
  const write = (code) => {
    cur |= code << curBits; curBits += codeSize;
    while (curBits >= 8) { out.push(cur & 255); cur >>= 8; curBits -= 8; }
  };
  reset();
  write(clearCode);
  let prefix = '' + indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const combined = prefix + ',' + k;
    if (dict.has(combined)) { prefix = combined; }
    else {
      write(dict.get(prefix));
      if (next < 4096) {
        dict.set(combined, next);
        if (next === (1 << codeSize) && codeSize < 12) codeSize++;
        next++;
      } else { write(clearCode); reset(); }
      prefix = '' + k;
    }
  }
  write(dict.get(prefix));
  write(eoiCode);
  if (curBits > 0) out.push(cur & 255);
  return out;
}

// ---------------------------------------------------------------- AI image gen
const AI_DEFAULT_MODEL = {
  gemini: 'gemini-2.0-flash-preview-image-generation',
  replicate: 'black-forest-labs/flux-schnell'
};
function fillAiFields(prov) {
  $('#ai-key').value = localStorage.getItem('inkforge.ai.key.' + prov) || '';
  $('#ai-model').value = localStorage.getItem('inkforge.ai.model.' + prov) || '';
  $('#ai-model').placeholder = AI_DEFAULT_MODEL[prov] || '(default)';
}
function loadAiSettings() { // on dialog open: restore stored provider + its fields
  const prov = localStorage.getItem('inkforge.ai.provider') || 'gemini';
  $('#ai-provider').value = prov;
  fillAiFields(prov);
}
function onAiProviderChange() { // on select change: persist new provider, load its fields
  const prov = $('#ai-provider').value;
  localStorage.setItem('inkforge.ai.provider', prov);
  fillAiFields(prov);
}
function saveAiSettings() {
  const prov = $('#ai-provider').value;
  localStorage.setItem('inkforge.ai.provider', prov);
  localStorage.setItem('inkforge.ai.key.' + prov, $('#ai-key').value.trim());
  localStorage.setItem('inkforge.ai.model.' + prov, $('#ai-model').value.trim());
}
async function aiGenerate() {
  saveAiSettings();
  const provider = $('#ai-provider').value;
  const key = $('#ai-key').value.trim();
  const model = $('#ai-model').value.trim() || AI_DEFAULT_MODEL[provider];
  const prompt = $('#ai-prompt').value.trim();
  const status = $('#ai-status');
  if (!key) { status.textContent = 'Enter your API key first.'; return; }
  if (!prompt) { status.textContent = 'Enter a prompt.'; return; }
  if (!window.inkforge?.aiGenerate) { status.textContent = 'AI generation only runs in the desktop app.'; return; }
  status.textContent = 'Generating… this can take 10-40s.';
  $('#ai-generate').disabled = true;
  try {
    const res = await window.inkforge.aiGenerate({ provider, key, model, prompt });
    if (!res || res.error) { status.textContent = 'Error: ' + (res?.error || 'no response'); return; }
    await placeAiImage('data:' + (res.mime || 'image/png') + ';base64,' + res.image);
    status.textContent = 'Done ✓ added as a new layer.';
  } catch (e) {
    status.textContent = 'Error: ' + (e.message || e);
  } finally {
    $('#ai-generate').disabled = false;
  }
}
async function placeAiImage(dataUrl) {
  const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
  const l = addLayer('AI Image', true);
  const scale = Math.min(doc.width / img.width, doc.height / img.height);
  const w = img.width * scale, h = img.height * scale;
  l.ctx.drawImage(img, (doc.width - w) / 2, (doc.height - h) / 2, w, h);
  composite(); renderLayerList(); updateThumb(doc.active);
}

// ---------------------------------------------------------------- Knobs
function setZoomCentered(scale) {
  scale = clamp(scale, 0.05, 32);
  const cx = stage.clientWidth / 2, cy = stage.clientHeight / 2;
  const k = scale / cam.scale;
  cam.x = cx - (cx - cam.x) * k;
  cam.y = cy - (cy - cam.y) * k;
  cam.scale = scale; applyCam();
}
function setBrushSize(v) {
  brush.size = clamp(Math.round(v), 1, 400);
  $('#size').value = brush.size; $('#size-val').textContent = brush.size;
  updateKnobs();
}
function knobFrac(name) {
  if (name === 'rotate') return (cam.rot + 180) / 360;
  if (name === 'zoom') return clamp((Math.log(cam.scale) - Math.log(0.05)) / (Math.log(32) - Math.log(0.05)), 0, 1);
  return (brush.size - 1) / 399;
}
function updateKnobs() {
  const set = (name, label) => {
    const el = document.querySelector(`.knob[data-knob="${name}"]`); if (!el) return;
    el.querySelector('.dial-val').textContent = label;
    el.querySelector('.dial-ind').style.transform = `rotate(${-135 + knobFrac(name) * 270}deg)`;
  };
  set('rotate', Math.round(cam.rot) + '°');
  set('zoom', Math.round(cam.scale * 100) + '%');
  set('size', String(Math.round(brush.size)));
}
function initKnob(name, get, apply, min, max, step) {
  const el = document.querySelector(`.knob[data-knob="${name}"]`); if (!el) return;
  const dial = el.querySelector('.dial');
  let startY = null, startVal = 0;
  dial.addEventListener('pointerdown', (e) => { dial.setPointerCapture(e.pointerId); startY = e.clientY; startVal = get(); e.preventDefault(); });
  dial.addEventListener('pointermove', (e) => { if (startY == null) return; apply(clamp(startVal + (startY - e.clientY) * step, min, max)); });
  const end = () => { startY = null; };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  dial.addEventListener('dblclick', () => { apply(name === 'rotate' ? 0 : (name === 'zoom' ? 1 : get())); });
}

// ---------------------------------------------------------------- Color system
const WHEEL = { cx: 110, cy: 110, rOuter: 106, rInner: 84, sqX: 56, sqY: 56, sq: 108 };
let hsb = { h: 0, s: 0, v: 10 };
let harmMode = 'analog';
let wheelMode = null;
const recent = [];

function hsbToRgb(h, s, v) {
  s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
function rgbToHsb(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return { h, s: mx ? (d / mx) * 100 : 0, v: mx * 100 };
}
function rgbToHex(r, g, b) { return '#' + [r, g, b].map(x => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0')).join(''); }

function setColorHex(hex) {
  hex = ('' + hex).replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return;
  const rgb = hexToRgb('#' + hex);
  const c = rgbToHsb(rgb.r, rgb.g, rgb.b);
  hsb.h = c.h; hsb.s = c.s; hsb.v = c.v;
  applyColorFromHsb();
}
function applyColorFromHsb() {
  const rgb = hsbToRgb(hsb.h, hsb.s, hsb.v);
  const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
  brush.color = hex;
  const ci = $('#color'); if (ci) ci.value = hex;
  $('#hex').value = hex.slice(1);
  $('#cur-swatch').style.background = hex;
  $('#hsb-h').value = Math.round(hsb.h); $('#hsb-h-val').textContent = Math.round(hsb.h);
  $('#hsb-s').value = Math.round(hsb.s); $('#hsb-s-val').textContent = Math.round(hsb.s);
  $('#hsb-b').value = Math.round(hsb.v); $('#hsb-b-val').textContent = Math.round(hsb.v);
  drawColorWheel(); renderHarmony();
}
function drawColorWheel() {
  const cnv = $('#color-wheel'); if (!cnv) return;
  const cx = cnv.getContext('2d');
  cx.clearRect(0, 0, cnv.width, cnv.height);
  const mid = (WHEEL.rOuter + WHEEL.rInner) / 2;
  cx.lineWidth = WHEEL.rOuter - WHEEL.rInner;
  for (let a = 0; a < 360; a++) {
    const rgb = hsbToRgb(a, 100, 100);
    cx.beginPath(); cx.strokeStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
    cx.arc(WHEEL.cx, WHEEL.cy, mid, (a - 0.5) * Math.PI / 180, (a + 1.5) * Math.PI / 180); cx.stroke();
  }
  const base = hsbToRgb(hsb.h, 100, 100);
  cx.fillStyle = `rgb(${base.r},${base.g},${base.b})`; cx.fillRect(WHEEL.sqX, WHEEL.sqY, WHEEL.sq, WHEEL.sq);
  let g1 = cx.createLinearGradient(WHEEL.sqX, 0, WHEEL.sqX + WHEEL.sq, 0);
  g1.addColorStop(0, 'rgba(255,255,255,1)'); g1.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = g1; cx.fillRect(WHEEL.sqX, WHEEL.sqY, WHEEL.sq, WHEEL.sq);
  let g2 = cx.createLinearGradient(0, WHEEL.sqY, 0, WHEEL.sqY + WHEEL.sq);
  g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,1)');
  cx.fillStyle = g2; cx.fillRect(WHEEL.sqX, WHEEL.sqY, WHEEL.sq, WHEEL.sq);
  const ha = hsb.h * Math.PI / 180;
  cx.beginPath(); cx.arc(WHEEL.cx + Math.cos(ha) * mid, WHEEL.cy + Math.sin(ha) * mid, 6, 0, Math.PI * 2);
  cx.strokeStyle = '#fff'; cx.lineWidth = 2; cx.stroke();
  const mx = WHEEL.sqX + hsb.s / 100 * WHEEL.sq, my = WHEEL.sqY + (1 - hsb.v / 100) * WHEEL.sq;
  cx.beginPath(); cx.arc(mx, my, 6, 0, Math.PI * 2); cx.strokeStyle = hsb.v > 55 ? '#000' : '#fff'; cx.lineWidth = 2; cx.stroke();
}
function wheelPointer(e) {
  const cnv = $('#color-wheel'); const r = cnv.getBoundingClientRect();
  const x = (e.clientX - r.left) * (cnv.width / r.width);
  const y = (e.clientY - r.top) * (cnv.height / r.height);
  const dx = x - WHEEL.cx, dy = y - WHEEL.cy, dist = Math.hypot(dx, dy);
  if (wheelMode === null) wheelMode = (dist >= WHEEL.rInner - 4 && dist <= WHEEL.rOuter + 6) ? 'hue' : 'sb';
  if (wheelMode === 'hue') {
    let a = Math.atan2(dy, dx) * 180 / Math.PI; if (a < 0) a += 360; hsb.h = a;
  } else {
    hsb.s = clamp((x - WHEEL.sqX) / WHEEL.sq * 100, 0, 100);
    hsb.v = clamp((1 - (y - WHEEL.sqY) / WHEEL.sq) * 100, 0, 100);
  }
  applyColorFromHsb();
}
function addRecent() {
  const hex = brush.color;
  const i = recent.indexOf(hex); if (i >= 0) recent.splice(i, 1);
  recent.unshift(hex); if (recent.length > 10) recent.pop();
  renderRecent();
}
function renderRecent() {
  const el = $('#recent'); if (!el) return; el.innerHTML = '';
  recent.forEach(hex => { const d = document.createElement('div'); d.className = 'sw'; d.style.background = hex; d.title = hex; d.addEventListener('click', () => { setColorHex(hex); }); el.appendChild(d); });
}
function renderHarmony() {
  const el = $('#harmony'); if (!el) return; el.innerHTML = '';
  const base = hsb.h;
  let hues = { comp: [base, base + 180], analog: [base - 30, base, base + 30], triad: [base, base + 120, base + 240], split: [base, base + 150, base + 210] }[harmMode] || [base];
  hues.forEach(h => {
    h = ((h % 360) + 360) % 360;
    const rgb = hsbToRgb(h, hsb.s || 70, hsb.v || 90);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    const d = document.createElement('div'); d.className = 'sw'; d.style.background = hex; d.title = hex;
    d.addEventListener('click', () => { hsb.h = h; if (!hsb.s) hsb.s = 70; if (hsb.v < 20) hsb.v = 90; applyColorFromHsb(); addRecent(); });
    el.appendChild(d);
  });
}

// ---------------------------------------------------------------- Layer ops
function duplicateLayer() {
  const src = doc.layer;
  const nl = new Layer(doc.width, doc.height, src.name + ' copy');
  nl.opacity = src.opacity; nl.blend = src.blend; nl.visible = src.visible;
  nl.ctx.drawImage(src.canvas, 0, 0);
  doc.layers.splice(doc.active + 1, 0, nl); doc.active++;
  renderLayerList(); composite();
}
function mergeDown() {
  if (doc.active === 0) return;
  const top = doc.layer, below = doc.layers[doc.active - 1];
  below.ctx.globalAlpha = top.opacity; below.ctx.globalCompositeOperation = top.blend;
  below.ctx.drawImage(top.canvas, 0, 0);
  below.ctx.globalAlpha = 1; below.ctx.globalCompositeOperation = 'source-over';
  doc.layers.splice(doc.active, 1); doc.active--;
  renderLayerList(); composite();
}
function moveLayer(dir) {
  const ni = doc.active + dir;
  if (ni < 0 || ni >= doc.layers.length) return;
  const [l] = doc.layers.splice(doc.active, 1);
  doc.layers.splice(ni, 0, l); doc.active = ni;
  renderLayerList(); composite();
}

// ---------------------------------------------------------------- UI wiring
function bindUI() {
  document.querySelectorAll('.tool[data-tool]').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  $('#color').addEventListener('input', e => setColorHex(e.target.value));
  const sync = (id, valId, apply, fmt = (v) => v) => {
    const el = $('#' + id);
    el.addEventListener('input', e => { apply(+e.target.value); $('#' + valId).textContent = fmt(+e.target.value); });
  };
  $('#size').addEventListener('input', e => setBrushSize(+e.target.value));
  sync('opacity', 'opacity-val', v => brush.opacity = v / 100);
  sync('hardness', 'hardness-val', v => brush.hardness = v / 100);

  // Knobs
  initKnob('rotate', () => cam.rot, v => { cam.rot = v; applyCam(); }, -180, 180, 1);
  initKnob('zoom', () => cam.scale * 100, v => setZoomCentered(v / 100), 5, 3200, 2.5);
  initKnob('size', () => brush.size, v => setBrushSize(v), 1, 400, 1);

  // Color panel
  const wheel = $('#color-wheel');
  wheel.addEventListener('pointerdown', e => { wheel.setPointerCapture(e.pointerId); wheelMode = null; wheelPointer(e); });
  wheel.addEventListener('pointermove', e => { if (wheelMode !== null && e.buttons) wheelPointer(e); });
  wheel.addEventListener('pointerup', () => { if (wheelMode !== null) { wheelMode = null; addRecent(); } });
  $('#hsb-h').addEventListener('input', e => { hsb.h = +e.target.value; applyColorFromHsb(); });
  $('#hsb-s').addEventListener('input', e => { hsb.s = +e.target.value; applyColorFromHsb(); });
  $('#hsb-b').addEventListener('input', e => { hsb.v = +e.target.value; applyColorFromHsb(); });
  ['#hsb-h', '#hsb-s', '#hsb-b'].forEach(id => $(id).addEventListener('change', addRecent));
  $('#hex').addEventListener('change', e => { setColorHex(e.target.value); addRecent(); });
  document.querySelectorAll('.hbtn').forEach(b => b.addEventListener('click', () => {
    harmMode = b.dataset.harm;
    document.querySelectorAll('.hbtn').forEach(x => x.classList.toggle('active', x === b));
    renderHarmony();
  }));

  // Layer ops
  $('#btn-dup-layer').addEventListener('click', duplicateLayer);
  $('#btn-merge-layer').addEventListener('click', mergeDown);
  $('#btn-up-layer').addEventListener('click', () => moveLayer(1));
  $('#btn-down-layer').addEventListener('click', () => moveLayer(-1));
  $('#pressure').addEventListener('change', e => brush.usePressure = e.target.checked);
  $('#preset').addEventListener('change', e => applyPreset(e.target.value));

  // Timeline / animation
  $('#btn-animate').addEventListener('click', () => {
    const tl = $('#timeline');
    tl.classList.toggle('hidden');
    if (!tl.classList.contains('hidden')) { renderFrameList(); updateFrameStatus(); }
    applyCam();
  });
  $('#tl-play').addEventListener('click', togglePlay);
  $('#tl-add').addEventListener('click', () => addFrame(false));
  $('#tl-dup').addEventListener('click', () => addFrame(true));
  $('#tl-del').addEventListener('click', deleteFrame);
  $('#tl-onion').addEventListener('change', e => { onionSkin = e.target.checked; composite(); });
  $('#tl-fps').addEventListener('change', e => { doc.fps = clamp(+e.target.value || 12, 1, 60); });
  $('#tl-gif').addEventListener('click', exportGif);
  $('#tl-webm').addEventListener('click', exportWebm);

  // AI
  $('#btn-ai').addEventListener('click', () => { loadAiSettings(); $('#ai-dialog').showModal(); });
  $('#ai-provider').addEventListener('change', onAiProviderChange);
  $('#ai-key').addEventListener('change', saveAiSettings);
  $('#ai-model').addEventListener('change', saveAiSettings);
  $('#ai-generate').addEventListener('click', aiGenerate);

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
  $('#tx-ok').addEventListener('click', () => setTimeout(commitText, 0));
  $('#btn-save').addEventListener('click', saveProject);
  $('#btn-open').addEventListener('click', openProject);
  $('#btn-filters').addEventListener('click', () => $('#filters-dialog').showModal());
  $('#btn-effects').addEventListener('click', () => $('#effects-dialog').showModal());
  $('#fx-amt').addEventListener('input', e => $('#fx-amt-val').textContent = e.target.value);
  document.querySelectorAll('#filters-dialog .chip').forEach(ch =>
    ch.addEventListener('click', () => applyFilter(ch.dataset.filter, +$('#fx-amt').value)));
  $('#ef-size').addEventListener('input', e => $('#ef-size-val').textContent = e.target.value);
  document.querySelectorAll('#effects-dialog .chip').forEach(ch =>
    ch.addEventListener('click', () => applyEffect(ch.dataset.effect, +$('#ef-size').value, $('#ef-color').value)));
  $('#text-dialog').addEventListener('close', () => {
    if ($('#text-dialog').returnValue !== 'ok') { pendingTextPos = null; $('#tx-text').value = ''; }
  });

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
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'Space') { spaceDown = true; view.style.cursor = 'grab'; e.preventDefault(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); return; }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); exportPng(); return; }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); $('#new-dialog').showModal(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openProject(); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selection = { x: 0, y: 0, w: doc.width, h: doc.height }; composite(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); selection = null; composite(); return; }
    if (mod && e.key === '0') { e.preventDefault(); fitToScreen(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection && selection.w && selection.h) {
      e.preventDefault(); history.push(doc.layer);
      doc.layer.ctx.clearRect(selection.x, selection.y, selection.w, selection.h);
      composite(); updateThumb(doc.active); return;
    }
    const map = { b: 'brush', e: 'eraser', g: 'fill', i: 'eyedropper', v: 'move', h: 'pan',
                  l: 'line', r: 'rect', o: 'ellipse', t: 'text', s: 'smudge', w: 'liquify', m: 'select' };
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
    window.inkforge.onMenu('menu:open', openProject);
    window.inkforge.onMenu('menu:save', saveProject);
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
document.querySelector('.hbtn[data-harm="analog"]')?.classList.add('active');
setColorHex('#1a1a1a');
newDocument(1920, 1080, '#ffffff');
updateKnobs();
requestAnimationFrame(antsLoop);
