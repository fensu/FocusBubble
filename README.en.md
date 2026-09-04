# Focus Bubble

[简体中文](README.md) | **English** | [日本語](README.ja.md)

A desktop visual focus tool designed to be ADHD-friendly. The area around your pointer stays clear while the periphery is gently dimmed and blurred, helping attention stay on the current task instead of being pulled away by the corners of the screen.

Fully open source and fully local: no account, no cloud, no telemetry — all settings stay on your machine.

> ⚠️ **Health & Safety Warning**
>
> This software continuously changes screen brightness and clarity distribution. **If you experience flickering, eye pain, headache, dizziness, or visual disturbances while using it, close the app immediately and rest.** Consult a doctor before use if you have a history of photosensitive epilepsy, migraine, or eye conditions. A notice is shown on first launch and the effects are off by default — enable them manually after acknowledging.

## Features

### Two Focus Modes

| Mode | Description |
| --- | --- |
| Bubble | An elliptical clear area around the pointer; horizontal and vertical stretch are independently adjustable |
| Band | A rounded-rectangular clear area with adjustable width and height; its center can offset from the pointer (remote-control style adjustment in the panel) |

Each mode keeps its own feather, blur, dim, and follow-smoothing settings — adjusting one mode never affects the other.

### How the Blur Works

Peripheral blur uses each platform's native rendering path: Windows captures the desktop via the system API and processes it in GPU shaders; macOS uses the system frosted-glass effect (no screen-recording permission needed). If the native path is unavailable, it falls back to Canvas dimming (no blur).

### Visual Comfort

- Gentle default peripheral dimming (~30%) with a wide feathered transition — no hard bright/dark edges
- The clear area follows the pointer smoothly; the mask softens automatically during fast movement to avoid a harsh "searchlight" feel
- Presets: Low motion (light dim + wide feather + slow follow) / Strong focus (short-term intensity)

### More

- System tray: toggle effects / open panel / quit; closing the window minimizes to tray by default
- In-app manual update check with background download and install
- 7 interface languages: 中文, English, 日本語, 한국어, Deutsch, Français, Español
- Settings stored per platform, never cross-contaminated

## Roadmap

- Multi-monitor: follow the screen the pointer is on
- Global hotkeys
- Linux support

## FAQ

- **The app won't open on macOS?** On first run, allow Focus Bubble in System Settings → Privacy & Security (standard flow for unsigned apps: right-click the app icon → Open, or click "Open Anyway" in Settings).
- **A yellow border around the screen on Windows 10?** This is normal — the system's privacy indicator for screen capture. It does not affect usage (not present on Windows 11).
- **Passthrough is on but there's no mask?** Check the "Effects" toggle in the top-right corner — passthrough and effects are two independent switches; the status panel shows a warning while effects are off.

## Getting Started

- **Windows**: open the panel → click "Start Passthrough" (enables GPU rendering) → make sure "Effects" is on. **Both switches must be on** for the full blurred mask; passthrough alone just shows the original image. A warning appears in the status panel while effects are off.
- **macOS**: no passthrough switch needed — turn on "Effects" and the frosted-glass mask appears.
- Universal: modes and sliders apply in real time; "Reset defaults" restores everything.

## Development

Requirements:

- Node.js ≥ 20.19 (22 LTS recommended)
- Rust stable via [rustup](https://rustup.rs/) (MSVC toolchain on Windows)
- Windows 10 1903+ or macOS 12+

```bash
npm install          # install frontend dependencies
npm run desktop:dev  # dev mode with hot reload
```

Build locally with `npm run tauri build`; per-platform installers are on [GitHub Releases](https://github.com/fensu/FocusBubble/releases).

## Project Structure

```text
src/                    Control panel and overlay UI (React)
src-tauri/src/
  lib.rs                App entry: windows, tray, updates, commands
  renderer/mod.rs       Render parameter model & visual comfort layer (shared)
  platform/windows.rs   Windows rendering pipeline
  platform/macos.rs     macOS frosted-glass rendering
docs/                   Architecture and design documents
```

## Friends

[LINUX DO](https://linux.do/)
