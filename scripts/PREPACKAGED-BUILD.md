# Rebuilding only the Windows installer

`npm run package` builds the app and regenerates the NSIS path limits automatically in `afterPack`.

When reusing an existing audited `release/win-unpacked` image, regenerate its limits before compiling:

```powershell
node scripts/beta-installer-path-limits.mjs --app release/win-unpacked
npx electron-builder --config scripts/beta-installer-config.mjs --prepackaged release/win-unpacked --win nsis --x64
```

The generated include is derived from the longest shipping file/directory path. Do not reuse limits from a different image. This installer uses legacy NSIS file operations and refuses installation or temporary paths that exceed its safe limits before changing program files. Validate first install, reinstall, boundary refusals and complete uninstall against the final Setup file. Keep all QA temporary files in an isolated workspace fixture; never inherit an account runtime's temporary directory.
