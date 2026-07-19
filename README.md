# InkForge (cross-platform)

A cross-platform rebuild of the InkForge drawing app, running on **Windows, macOS, and Linux** via Electron + an HTML5 canvas engine.

This is a ground-up port of the macOS-native (AppKit/CoreGraphics) InkForge, which cannot run on Windows. The drawing engine here is rebuilt on the web canvas stack so it produces a real Windows `.exe`.

## Features
- Layered canvas engine (add / delete, per-layer opacity, blend modes, visibility, thumbnails)
- Tools: Brush, Eraser, Smudge, Liquify, Fill bucket, Eyedropper, Line, Rectangle, Ellipse, Text, Rectangular Select, Move layer, Pan
- Pressure-sensitive brush (works with pen tablets via Pointer Events), soft/hard tips, spacing-based stamping
- Smudge (color pickup + smear) and Liquify (push) pixel tools
- Rectangular selection with marching ants; clips brush/shapes; Delete clears, Ctrl+A / Ctrl+D select-all / deselect
- Shapes with live preview and Shift-constrain (square / circle / 45° lines)
- Multi-line text tool (font, size, bold, brush color)
- Filters: grayscale, invert, sepia, blur, sharpen, brighten, darken, contrast ±, saturate, desaturate, hue shift
- Layer effects: drop shadow, outer glow, stroke
- Frame-by-frame **animation**: timeline with add / duplicate / delete, playback, onion-skinning, adjustable FPS
- **GIF export** (built-in GIF89a encoder, median-cut palette) and **WebM export**
- Brush presets: Pencil, Ink Pen, Marker, Airbrush, Soft Round
- **AI image generation** (Google Gemini / Replicate) - paste your own key in-app, generate from a prompt onto a new layer
- Save / Open native `.inkforge` project files (all frames + layers preserved); PNG export
- **Control knobs**: Rotate (real canvas rotation), Zoom, Size - drag to adjust, double-click to reset
- **Color panel**: HSB color wheel (hue ring + saturation/brightness square), H/S/B sliders, hex input, recent colors, and harmony swatches (Complementary / Analogous / Triad / Split)
- **Layer ops**: add, duplicate, merge-down, move up/down, delete
- Pan (space-drag / middle-mouse) and cursor-anchored zoom (wheel), undo / redo
- Neumorphic dark UI; `touch-action: none` so pen/touch never gets hijacked as a gesture

## Run in development
```bash
npm install
npm start
```

## Build installers
```bash
npm run dist:win     # Windows NSIS .exe  (run on Windows, or via CI)
npm run dist:mac     # macOS .dmg
npm run dist:linux   # Linux AppImage
```

### Building the Windows .exe from a Mac
electron-builder's Windows target is easiest on a Windows machine. This repo ships a
GitHub Actions workflow (`.github/workflows/build.yml`) that builds the `.exe` on a
Windows runner and attaches it to a GitHub Release on any `v*` tag (or via manual
"Run workflow").

## Status
Full feature port complete (v1.0.0): 13 tools, layers with blend modes, selection,
filters, layer effects, animation timeline with GIF/WebM export, brush presets, native
project save/load, and AI image generation. The Windows `.exe` is built on a GitHub
Actions runner on every `v*` tag and attached to the release.

### AI image generation
Open **AI ✦** and pick a provider:
- **Local · ComfyUI (this PC)** — generates on your own GPU via a local ComfyUI server
  (default `http://127.0.0.1:8188`). No API key, no cloud, no cost. Pick any installed
  checkpoint (e.g. DreamShaper 8, Juggernaut XL Lightning). The app builds a txt2img
  graph, queues it, and drops the result on a new layer.
- **Google Gemini / Replicate** — bring your own key (stored locally, never bundled).

All calls route through the app's main process, so there are no browser CORS issues.
