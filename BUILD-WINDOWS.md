# Windows build notes

The current beta supports fresh Windows Home, Pro, Enterprise and Education profiles without mandatory EFS. Existing encrypted profiles keep their recovery checks. See [PRIVATE-BETA.md](PRIVATE-BETA.md) for installation, storage and current limits, and [BUILDING.md](BUILDING.md) for native source-build instructions.

Build on Windows x64 with Node.js 22.19 or newer and Git. Install dependencies with `npm ci --ignore-scripts`, install the pinned Electron program with `node node_modules/electron/install.js`, then run `npm run prepare:runtimes`, `npm test` and `npm run package`.

The resulting per-user Setup is under `release/`. Native installer and packaged startup checks must use fresh synthetic profiles in an explicitly chosen workspace temporary directory. Never use personal sign-in stores for build or test fixtures. See [scripts/PREPACKAGED-BUILD.md](scripts/PREPACKAGED-BUILD.md) when rebuilding an already prepared, verified package.
