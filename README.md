# NV Screen Recorder

A light screen recorder for Windows 10 / 11. Records your screen (or a single window) with the
mouse pointer, system sound and your microphone, exactly as it appears.

## Features

- Full screen or single window recording, mouse pointer included
- System audio (what you hear) and microphone (your voice), mixed into one track
- Saves **MP4** (H.264) using the graphics card encoder when available, so the PC stays smooth
- Recording is streamed to disk every second: memory use stays flat, and a crash or power cut
  does not lose the whole video
- Small floating bar with timer, pause and stop. It is hidden from the recording itself
- Global hotkeys: `Ctrl+Shift+R` start / stop, `Ctrl+Shift+P` pause / resume
- Tray icon, optional start countdown, frame rate 15 / 24 / 30 / 60, quality and resolution caps

## Get the Windows .exe (GitHub Actions)

1. Create a new repository on GitHub (private is fine).
2. Upload everything in this folder, **including the hidden `.github` folder**.
3. Open the repository's **Actions** tab. The build starts automatically on every push
   (or press **Run workflow**).
4. After about 3-5 minutes, open the finished run and download **NV-Screen-Recorder-Windows**.
   It contains:
   - `NV-Screen-Recorder-Setup-1.0.0.exe` - installer
   - `NV-Screen-Recorder-Portable-1.0.0.exe` - runs without installing

To publish a release instead, create a tag such as `v1.0.0`; the exe files are attached to it.

## Run from source (optional)

```
npm install
npm start
```

## Build locally on Windows (optional)

```
npm install
npm run dist
```

The files appear in `dist/`.

## Tips for the lightest recording

- 30 fps + Balanced quality is the sweet spot. For old PCs use 24 fps and Max 720p.
- Keep the file format on MP4. WebM may use more CPU on some PCs.
- Use headphones when System audio and Microphone are both on.

## Notes

- Windows may ask for microphone permission the first time.
- Pointer and sound are captured through Windows' own capture APIs, so what you see and hear is what is saved.
- Recordings are saved to `Videos\NV Screen Recorder` by default. You can change this in the app.
