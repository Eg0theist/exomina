# Build from source

Build on the target operating system and processor with Node.js 24.22.1 or newer and Git. Windows packaging targets x64; macOS/Linux packaging uses the host processor architecture.

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
npm run build
npm test
```

The tests serve the built phone interface and use the pinned Python reader for
archive fixtures. Prepare the runtimes above and build before running the suite.
Muse's optional real-runtime integration check accepts an explicitly chosen
`EXOMINA_MUSE_TEST_RUNTIME`; other Muse tests use synthetic clients. Install
Muse separately and ensure its native executable is on PATH to use that connection.

Choose the command for your operating system:

```sh
npm run package:beta   # Windows beta installer
npm run package:mac    # macOS
npm run package:linux  # Linux
```

Installers are written under `release/`, `release-darwin/` or `release-linux/`. Public runtime archives are pinned and checked by SHA-256.

For an existing editable Windows installation, `npm run package` builds and stages a local update while preserving its official source baseline. A new signed Windows distribution uses `npm run package:official`; publisher identity, update trust and exact-candidate qualification are described in [publishing updates](PUBLIC-UPDATES.md). Building the renderer does not qualify an installer.

Use fresh synthetic profiles and an explicitly chosen workspace temporary folder for packaged checks. Never use personal account stores as fixtures. Native qualification covers Windows Setup, macOS DMGs and Debian/Ubuntu DEBs. Mac ZIP and Linux AppImage are optional source-build targets, with installation not qualified for this release; the AppImage failed normal-sandbox startup on the Ubuntu qualification host.

See [Windows build notes](BUILD-WINDOWS.md), [prepackaged build instructions](scripts/PREPACKAGED-BUILD.md) and [platform support](SUPPORT.md) for additional details. User installation steps are in the [installation guide](BETA.md).
