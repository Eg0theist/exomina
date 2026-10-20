# Build from source

Build on the target operating system and processor with Node.js 22.19 or newer and Git. Windows packaging targets x64; macOS/Linux packaging uses the host processor architecture.

## Prepare

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
```

On Windows, prepare the provider runtimes:

```sh
npm run prepare:runtimes
```

On macOS/Linux:

```sh
node scripts/prepare-native-vendor.mjs
node scripts/prepare-grok-runtime.mjs
```

Linux builders also need `pkg-config` and `libsecret-1-dev`. The native qualification workflow installs the display libraries needed for packaged checks.

## Test and package

```sh
npm test
```

Choose the command for your operating system:

```sh
npm run package        # Windows
npm run package:mac    # macOS
npm run package:linux  # Linux
```

Installers are written under `release/`, `release-darwin/` or `release-linux/`. Public runtime archives are pinned and checked by SHA-256. Generated binaries, installation outputs and personal data are excluded from Git.

Use fresh synthetic profiles and an explicitly chosen workspace temporary folder for packaged checks. Never use personal account stores as fixtures. Native qualification covers Windows Setup, macOS DMGs and Debian/Ubuntu DEBs. Mac ZIP and Linux AppImage are optional source-build targets, with installation not qualified for this release; the AppImage failed normal-sandbox startup on the Ubuntu qualification host.

See [Windows build notes](BUILD-WINDOWS.md), [prepackaged build instructions](scripts/PREPACKAGED-BUILD.md) and [platform support](SUPPORT.md) for additional details. User installation steps are in the [installation guide](PRIVATE-BETA.md).
