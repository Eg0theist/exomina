# Publishing Exomina updates

The desktop Update button opens Settings → Updates. With automatic downloading
enabled, Exomina checks at startup and every six hours, downloads a new Windows
x64 package, verifies it, and waits for **Apply update**. Applying requires an
idle app and uses the installed updater and Windows administrator prompt.
There is no public release server configured in this preview.

## Release source

Before packaging a public build, set `feedUrl` in `build/update-channel.json` to
the HTTPS address where customers will find `latest.json`. The address ships
inside the application, so customers do not have to enter it. This preview's
Settings → Updates → Update source can override it. An empty override uses the
address shipped with the app.

A static website/CDN can serve the JSON and ZIP. GitHub Releases can also host
both files: use `https://github.com/OWNER/REPO/releases/latest/download/latest.json`
as the feed, and a tagged release's `/releases/download/TAG/` as the download
base below. Exomina follows HTTPS redirects without using account credentials.

## Create a release

1. Configure the feed. `npm run package` advances the version automatically:
   `0.5.0-beta.4` becomes `0.5.0-beta.5`; a stable `0.5.0` becomes `0.5.1`.
   It synchronizes `package.json`, the root package lock and desktop metadata
   before packaging. Ordinary `npm run build` and QA keep the version.
   Major and minor release lines are chosen deliberately. For example, set
   `0.6.0-beta.0` in the manifest to start the next beta line; packaging advances
   it to `0.6.0-beta.1` and synchronizes the other metadata for you.
   A failed package attempt may leave a skipped version number; retrying gets
   another number so distinct update attempts are never mislabeled as the same version.
2. Run `npm test` and the relevant QA. Local customization uses `npm run package`.
   Public distribution uses `npm run package:public` (or `npm run package:official`),
   with a trusted signing identity supplied through the build environment.
3. Run:

   ```powershell
   npm run release:update -- --base-url https://YOUR-HOST/releases/0.4.1/ --notes-file release-notes.txt
   ```

4. Upload the generated ZIP from `release/public` and the accompanying
   `latest.json`. Upload the ZIP first, then publish the JSON that points to it.

The command creates files locally; it does not upload or publish anything. The
ZIP contains the stamped `win-unpacked` program files, without chats, account
stores or source. The JSON includes the ZIP's exact size and SHA-256, the same
build ID/version/date as the ZIP, and optional plain text release notes.

```json
{
  "format": 1,
  "id": "THE-PACKAGED-BUILD-ID",
  "version": "0.4.1",
  "builtAt": "2026-10-07T12:00:00.000Z",
  "notes": "Release notes",
  "windows": {
    "x64": {
      "url": "https://YOUR-HOST/releases/0.4.1/Exomina-0.4.1-BUILD-ID-windows-x64.zip",
      "size": 123456789,
      "sha256": "THE-64-CHARACTER-SHA256"
    }
  }
}
```

Older versions are ignored. A different build of the same version must have a
later build date. Interrupted or invalid downloads do not become installable;
the last verified download remains usable. A cancelled or failed installation
waits for the user to retry. Ordinary local builds in `Source/release` remain
available through the same Apply update button.

Local customization builds remain unsigned. The public build path requires
`WIN_CSC_LINK` (or `CSC_LINK`), its password and the expected public certificate's
`EXOMINA_PUBLISHER_THUMBPRINT` in the build environment, fails
when signing is unavailable, and verifies the publisher signatures on Exomina,
its four Windows interop libraries, installer and generated uninstaller before
embedding. Packaged vendor binary hashes must equal the prepared source inputs.
Public update export also
refuses unsigned application artifacts. Keep signing credentials out of source.

Windows interop is compiled during the build. Installed startup, desktop,
speech and busy-state helpers load those libraries without invoking a C# compiler.
Pinned third-party runtimes retain their upstream executable bytes and signatures.
Integrity inventories are generated after application signing. Each public build
uses a fresh output directory; release evidence identifies its build ID and hashes.
Certificate rotation requires an explicit change to the expected publisher pin.

Signing establishes publisher identity and file integrity. It does not guarantee
SmartScreen reputation or antivirus acceptance. Test the exact installer and
update hashes on clean Windows systems with stock Defender and Bitdefender:
install, start, connect a provider, open a terminal, scan storage, update and
uninstall. Record product versions, detection names, process ancestry and hashes.
Submit confirmed false-positive evidence through the vendor's review channel:
https://www.bitdefender.com/consumer/support/answer/29358/
Do not add broad exclusions or change firewall policy as part of the installer.
No sample is uploaded by the build scripts. Vendor review and clean-VM tests
remain release work; the local machine's exception cannot establish compatibility.
# Customized installations

Publisher builds use `npm run package:official`. Ordinary `npm run package` rebuilds retain the installed official source baseline when available. Program-only release ZIPs carry a checksum-verified `exomina-source` snapshot. Do not strip that directory when publishing.

For the installed App/Source layout, global updates compare the installed baseline, customized Source and incoming release. Settings → Updates → Prepare merged update creates a separate workspace. Review with AI opens a chat bound to that workspace. The assistant resolves conflicts and calls `app_update_verify`, which asks permission to install dependencies (lifecycle scripts disabled), prepare the pinned Electron runtime, run tests and package. Checks execute code under the user's Windows account; they are compatibility checks, not a sandbox for malicious source. No publisher should promise arbitrary edits will remain compatible.

Verification binds the final source and package. Applying rechecks them, and the elevated installer enforces the approved file receipt before activation. The previous App remains available. After startup, journaled Source promotion retains the entire original Source as `Source.previous-<plan-id>`. Source side files stay in that preserved copy. Settings, extensions, chats and sign-ins stay outside these program changes. Database migration rollback is not automatic.

Legacy releases without an official baseline cannot safely infer it from edited source. Global replacement is blocked until a verified baseline is installed separately with the customized copy preserved. Direct edits to installed program files are also blocked; port them into Source for a reviewed rebuild.

The per-user beta uses its whole-installer route. Its installer refuses customized or baseline-less program copies; use a different empty installation folder to preserve those versions. The automatic merge/apply flow above is for the installed App/Source layout.
