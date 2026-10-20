# Platform support

The compatibility beta uses standard per-user storage on Windows, macOS and Linux. Existing Windows EFS profiles keep their encryption and recovery checks. Exact native build, startup and installation results accompany each published release in VALIDATION.md.

| Platform | Package | Runtime architecture |
| --- | --- | --- |
| Windows 10/11, including Home | Per-user Setup | x64 |
| macOS | DMG | Intel x64 or Apple Silicon ARM64 |
| Debian/Ubuntu Linux | DEB | x64 or ARM64 |

## Platform notes

The Windows build may run through x64 emulation on ARM Windows, but native Windows ARM packaging is not qualified. The bundled macOS Cua driver requires macOS 13 or newer. Native Linux tests use Ubuntu 24.04. Mac ZIP and Linux AppImage remain optional source-build targets. Only tested DMGs and DEBs are offered as qualified downloads. The AppImage could not start with its normal sandbox on the Ubuntu qualification host; no sandbox bypass is used to make it pass.

## Bundled components

The app bundles pinned ChatGPT and Grok runtimes, a Python ZIP reader and a Cua driver distribution matching its native OS/processor. Claude is opt-in and uses the user’s own official client. Gemini and Muse also use separately installed official clients; their availability depends on the host installation and account. Public program archives are hash-verified and retain licenses and platform guides. Source preparation does not read another app's sign-in files. The Unix terminal uses approved POSIX commands; Windows keeps PowerShell.

## Storage and protection

Fresh app folders use restricted user permissions. Keys added in Connections, messaging secrets and paired-sync credentials require protected OS secret storage. Linux plaintext basic_text is refused. Chats, browser files, advanced tool configuration and some provider sign-in files are not encrypted by Exomina in standard mode. Device disk encryption remains useful. Optional Windows EFS setup requires explicit confirmation and a recovery backup. It also protects Exomina's default project folder; other project folders are outside this operation.

## What the tests cover

The packaged QA starts a fresh synthetic profile, checks ordinary first-run readiness, the current signed-out connection catalog and the included ChatGPT/Grok runtimes, workspace/browser tools, the six standard themes and manual-update UI. Linux startup checks require a graphical display or Xvfb.

## Voice and desktop control

Built-in system speech currently requires Windows. ChatGPT Realtime voice is experimental. macOS computer control requires Accessibility/Screen Recording permissions; Linux control depends on display/session permissions.

Claude through a Claude plan needs Claude Code on the user's computer. Exomina installs Anthropic's official copy when the user turns it on; see [Using Claude](PRIVATE-BETA.md#using-claude).

## Signing and updates

Windows is unsigned. macOS is ad-hoc signed without Developer ID or notarization. Private release updates are manual.

## Build workflow

The Native beta packages workflow uses separate Intel/ARM Mac and x64/ARM Ubuntu hosts. It checks read-only DMG mount/copy/start/remove and native DEB install/start/remove. Chromium sandbox settings are retained. Only successfully qualified formats are uploaded, along with sanitized app-only reports, for one day. No profiles or unpacked apps are uploaded. The workflow prepares artifacts; it does not publish releases.
