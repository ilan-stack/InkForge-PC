# InkForge (cross-platform)

A cross-platform rebuild of the InkForge drawing app, running on **Windows, macOS, and Linux** via Electron + an HTML5 canvas engine.

This is a ground-up port of the macOS-native (AppKit/CoreGraphics) InkForge, which cannot run on Windows. The drawing engine here is rebuilt on the web canvas stack so it produces a real Windows `.exe`.

## Features (v0.1)
- Layered canvas engine (add / delete / reorder, per-layer opacity, blend modes, visibility)
- Tools: Brush, Eraser, Fill bucket, Eyedropper, Move layer, Pan
- Pressure-sensitive brush (works with pen tablets via Pointer Events), soft/hard tips, spacing-based stamping
- Pan (space-drag / middle-mouse) and cursor-anchored zoom (wheel)
- Undo / redo, New canvas dialog, PNG export via native save dialog
- Neumorphic dark UI in the spirit of the original

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
