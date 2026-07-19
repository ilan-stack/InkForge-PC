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
- Save / Open native `.inkforge` project files (layers preserved); PNG export
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

## Roadmap (from the original InkForge feature set)
Smudge, Liquify, Selection + transform, text tool, filters/effects, animation timeline
with onion-skin + GIF export, brush library, and the AI (Gemini/Replicate) providers.
