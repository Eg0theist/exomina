# Installation and updates

Exomina's own source code and documentation are open source under [Apache-2.0](LICENSE). You are encouraged to modify them, build upon them and distribute your own versions, including commercial versions, with the required notices. Third-party software and provider services retain their respective terms.

## Install

Download the installer for your operating system and processor from [Releases](https://github.com/Eg0theist/exomina/releases).

- **Windows:** run the x64 Setup. Installation is per user and supports Windows 10/11 Home, Pro, Enterprise and Education. Fresh installs do not require EFS or a recovery-key setup.
- **macOS:** choose ARM64 for Apple Silicon or x64 for Intel. Open the DMG and drag **Exomina Beta** to Applications.
- **Debian/Ubuntu Linux:** choose AMD64 for x64 or ARM64 for an ARM computer. Install the DEB through your package manager so dependencies are resolved.

For example, on Debian/Ubuntu x64, run this from the download folder:

```sh
sudo apt install ./Exomina-Beta-0.6.0-linux-amd64.deb
```

Use the `linux-arm64.deb` file on ARM64. A normal local user profile and a graphical desktop are required. See each release's validation report for the exact tested OS versions.

Open **Connections**, follow the chosen card and start a chat. ChatGPT and Grok clients are included; Claude uses your own official client through its opt-in switch. Gemini and Muse need their official clients installed separately. Node.js and npm are not needed to use Exomina. Provider plans, limits and API charges apply to your own account. Cloud connections require internet. Local models and the Ollama server are installed separately.

Windows builds are unsigned. Mac builds use ad-hoc signing without Apple notarization. Your operating system may ask for launch confirmation; trusted-publisher status has not been established. For help, see [SUPPORT.md](SUPPORT.md).

## Update or uninstall

Download and install the next release using the same method. On macOS, replace the app in Applications; on Linux, install the newer DEB. Updates are manual for this beta.

On Windows, update in the existing installation folder. Setup refuses to replace customized program files or move a registered installation to another folder. For an older beta without a verified baseline, preserve its program files and source before uninstalling it, then install the new release into an empty folder. Keep app data and projects separate from the program folder.

Uninstall removes the program and keeps app data and project files. Program updates also preserve those files.

## Your data

Fresh profiles use private user permissions. Saved connection keys use Windows DPAPI, macOS Keychain or a protected Linux system secret store. Linux refuses a plaintext fallback: if the secret store is unavailable, protected keys cannot be saved or read, but the app can still open. macOS may prompt for Keychain access.

Chats, advanced tool configuration and some official-runtime sign-in files are not encrypted by Exomina in standard mode. Use device disk encryption for protection at rest. Per-user permissions do not protect against malware running as the signed-in user.

Existing Windows EFS profiles stay encrypted and retain their recovery checks. Full-folder EFS remains optional where Windows supports it. It also protects Exomina's default project folder; other project folders are outside that operation. If enabled, keep the password-protected recovery backup outside the program folder.

| System | Program | App data |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Programs\Exomina Beta` | `%LOCALAPPDATA%\Exomina\Private` |
| macOS | `Exomina Beta.app` in Applications | `~/Library/Application Support/Exomina/Private` |
| Linux | DEB-managed installation | `${XDG_CONFIG_HOME:-~/.config}/Exomina/Private` |

The default project folder is **Documents/Exomina/Workspace**. Choose another local workspace if Documents is redirected. Existing profile locations are preserved when detected.

## Using Claude

There are two ways to connect Claude. Pick the one that matches how you pay.

- **Anthropic API (pay per use):** in **Connections**, add a Claude Console API key. Charges go to your Console account, not your Claude plan.
- **Your Claude plan (Pro/Max):** in **Connections**, find **Claude** under Subscriptions and choose **Turn on Claude**. Exomina then:
  1. looks for Claude Code on your computer, and runs Anthropic's official installer if it is missing;
  2. opens Anthropic's own sign-in page in your browser;
  3. uses your plan's models and limits once you are signed in.

  Use the switch on the Claude card to turn it off again.

Exomina uses Anthropic's official Claude Code and sign-in page. The connection starts off until you enable it and uses your account's access and limits. Exomina keeps its Claude sign-in separate from any Claude Code you already use in a terminal.

Because Claude Code offers more than one sign-in method, Exomina accepts any of them, including a Console sign-in. The card tells you when usage is billed as API usage.

## Voice previews

Previews let you hear a ChatGPT or Claude voice before you pick it. They are optional. To turn them on, open **Settings → Voice** and choose **Add voice previews**. Exomina then:

1. finds the Codex (ChatGPT) and Claude desktop apps installed on your computer;
2. copies their voice recordings into Exomina's private data folder, after checking each file;
3. makes the gentler **Clear** version of each ChatGPT recording on your computer, so you can choose Clear or Original.

If the apps are somewhere unusual, Exomina offers **choose its folder**. **Update from my apps** refreshes the copies and **Remove** deletes them.

Voice previews use sound files from your installed apps and stay on your computer. Voice features also work without previews.

Linux has no desktop versions of these apps to copy from. If Exomina cannot find an app on your computer, use **choose its folder**.

## Current limits

- **Grok Imagine:** ask Grok to create an image, edit an attached image, or make a video. It uses your Grok account; Grok checks your plan and media limits. Successful images and MP4 videos appear in chat with a Save button (up to 20 MiB per file).
- **Voice:** built-in dictation and system spoken replies need Windows. ChatGPT Realtime is experimental. Voice previews are optional and copied from your own apps (see [Voice previews](#voice-previews)).
- **Computer use:** macOS and Linux need the matching OS permissions and a supported desktop session.
- **Windows paths:** Setup refuses overly long program or temporary paths before copying files. A shorter local path may be needed; release validation records the tested limits.
- **Mac and Linux downloads:** use the DMG or DEB for your processor. ZIP and AppImage are optional source-build targets.

## Reporting problems

Report problems through [Issues](https://github.com/Eg0theist/exomina/issues), following [FEEDBACK.md](FEEDBACK.md). Remove credentials, recovery material and private conversations from reports. Third-party components and providers retain their own licenses and service terms.
