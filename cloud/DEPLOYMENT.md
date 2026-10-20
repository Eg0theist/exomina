# Exomina private server deployment plan

Your favourite AI tools in one place.

**Status:** hosting deferred by the owner. This document is a prepared plan, not authorization to purchase or deploy. Monetization will be evaluated separately.

This is a reviewable setup plan, not a record of deployment. No server has been purchased, account signed in, or personal archive uploaded by following this document. The server code has offline tests.

## What this provides

An always-on Linux server hosts your Exomina chats and memory. Your phone reaches it through Tailscale and signs in with your one allowed Google account. The desktop pairs once, then synchronizes logical chat, note and imported-history records while it is open and idle. The server remains available when the PC is off; desktop changes made offline synchronize when the desktop reconnects. Provider credentials stay separate on each host and are not synchronized.

The phone uses server-side capabilities. This build does not remotely control Windows applications or the desktop browser when the PC is off. The server currently supplies memory, archive and conversation tools, plus the official subscription runtimes' own supported tools. API connections receive the supplied server tools. This is not a claim of full desktop-tool parity.

The existing WordPress site and its DNS can stay as they are. Start with the server's private Tailscale `*.ts.net` address; a different domain can be evaluated later.

## Proposed host and budget

Proposed starting size: one x86-64 Linux VM with 2 vCPUs and 4 GB RAM in Germany or Finland, running one user's workloads. Four GB is a starting allocation, not a load-test result. Avoid running local language models or several heavy agent jobs on this size.

As checked on 5 October 2026, Hetzner's published CX23 price is €5.49/month before VAT, or €6.53 with German 19% VAT. [Official current price table](https://docs.hetzner.com/de/general/infrastructure-and-availability/price-adjustment/)

| Item | Approximate monthly amount, German VAT included |
| --- | ---: |
| CX23 server | €6.53 |
| One public IPv4 address | €0.595 |
| Optional server backups, 20% of server price | €1.31 |
| Total with those options | €8.44 |

IPv4 is €0.50 before VAT; IPv6 has no additional charge. Backup pricing is 20% of the server price. These figures are an estimate subject to checkout rounding, availability and the customer's tax treatment. [IP pricing](https://docs.hetzner.com/cloud/servers/primary-ips/overview/), [backup billing](https://docs.hetzner.com/cloud/billing/faq/)

**Proposed approval ceiling: €10/month for hosting.** This is a purchasing limit to confirm before ordering, not an automatic spending cap. It excludes existing AI subscriptions, optional API/extra-usage charges, additional storage and any future domain. Confirm stock and the final order total before purchase. Do not substitute a more expensive plan automatically.

## 1. Prepare the host and encrypted storage

Use a supported Linux x86-64 distribution with Node.js 24, `findmnt`, `lsblk`, systemd and the official Linux Codex and Claude Code executables. Create a dedicated unprivileged `exomina` service account. Keep application source and prebuilt static assets under `/opt/exomina`; keep all private data under `/var/lib/exomina/private`.

Provision one of these before starting Exomina:

- A filesystem backed entirely by an unlocked dm-crypt/LUKS encrypted device. Every backing branch must be encrypted, including any LVM or RAID arrangement.
- A writable `fuse.gocryptfs` mount accessible to the service account. The backing directory contains ciphertext; the mount exposes plaintext only while unlocked. Mount ownership and FUSE access must be configured for the actual service account.

Choose the disk layout only after inspecting the new VM. This document deliberately provides no generic disk-format command: selecting the wrong block device would destroy data. Prefer a dedicated encrypted filesystem or container within the approved server storage, with a documented capacity and unlock procedure.

Make the mounted private directory owned by `exomina`, mode `0700`. The production launcher refuses an ordinary plaintext filesystem. It verifies `runtime-tmp` separately, then sets `TEMP`, `TMP` and `TMPDIR` there before opening its databases or starting native runtimes. A nested plaintext temporary mount also fails the check.

**Reboots require an unlock plan.** The initial conservative configuration requires the owner/operator to unlock and mount storage after a server reboot, then restart Exomina. Until that happens, the app is unavailable and fails closed. Tailscale resuming does not unlock storage. Unattended recovery needs a separately reviewed key-release mechanism; putting the unlock key beside ciphertext on the same unencrypted disk weakens the intended protection. Keep the recovery secret in a separate encrypted backup and test restoration.

Before a full at-rest claim, also verify swap, core dumps, system logs, runtime home/cache paths and tools that ignore temporary-directory environment variables. `PrivateTmp=true` isolates `/tmp`; it does not itself encrypt it. Disable core dumps, use encrypted or disabled swap, and either bind hard-coded temporary paths into protected storage or verify the selected runtime does not write private content there. Encryption at rest does not prevent the running server, its administrator or the selected AI provider from processing plaintext.

## 2. Install the server artifact, not Windows dependencies

Build the frontend on the prepared development machine with `npm run build`. Copy the matching `dist/`, `cloud/` and `desktop/` source directories, preserving their relative paths, into `/opt/exomina`. Keep license notices and version information with that artifact. Exclude personal `data`, authentication files, exports, test fixtures, Windows executables and `node_modules`.

Do **not** run this repository's root `npm ci` on Linux: its desktop manifest explicitly depends on a Windows Claude executable. The current cloud runtime import graph uses Node built-ins and local modules; it can start from the prebuilt artifact without Electron, React build tools or an npm install on the server. Install official Linux provider executables separately and pin the versions tested for this deployment. [Claude Linux installation](https://code.claude.com/docs/en/setup), [Codex CLI](https://learn.chatgpt.com/docs/cli)

Set `EXOMINA_CODEX_PATH` and `EXOMINA_CLAUDE_PATH` to real, executable Linux paths, for example under `/usr/local/bin` or a root-managed `/opt` directory. The supplied systemd unit uses `ProtectHome=true`; a launcher that resolves into an install under `/home/...` will therefore fail. The server does not currently offer direct ZIP archive upload; import on the desktop and synchronize the resulting records. The bundled Windows Python archive reader is not a Linux runtime.

## 3. Configure private networking and Google sign-in

Install Tailscale on the server, phone and desktop using the owner's account. Limit access to the server to the owner's devices in the tailnet policy; do not share this node or invite other users. Keep the Exomina listener on `127.0.0.1:4178`. Public HTTP/HTTPS ports are not needed for the application.

After the loopback service is ready, publish it **inside the tailnet**:

```sh
tailscale serve --bg http://127.0.0.1:4178
tailscale serve status
```

Follow Tailscale's HTTPS enablement prompt if required. Use **Serve**, not **Funnel**: Funnel exposes services to the public internet. Background Serve configuration survives Tailscale/server restarts, subject to the underlying app being available. [Official Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve)

Create a Google OAuth **Web application** client for this private app. Set the exact authorized redirect URI to:

```text
https://YOUR-SERVER.YOUR-TAILNET.ts.net/auth/callback
```

Use that same HTTPS origin for `EXOMINA_PUBLIC_URL`, with no path. Configure the consent screen and the owner as an allowed test user if the Google project is in testing. Complete a real callback test for the chosen hostname; domain/consent requirements depend on the Google project's configuration. Google's callback URI must match exactly. [Google web-server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server)

The app independently checks the verified Google email against `EXOMINA_OWNER_EMAIL`, verifies ID-token signatures and audience, and pins the owner's Google subject. There is no public signup. Google sign-in to Exomina grants access to this app; it does not connect an AI subscription.

## 4. Store configuration and adapt systemd

Copy `cloud/server.env.example` to `/var/lib/exomina/private/server.env` on the unlocked encrypted mount. Make it readable only by the account that needs it (`0600`). Fill in the private URL, exact owner email, Google client ID/secret, provider executable paths and a freshly generated 32-byte base64 vault key. Keep a separate encrypted backup of the vault key. Do not paste secrets into chat, shell command arguments, screenshots or source control; edit the protected file locally with logging/history disabled as appropriate.

Review `cloud/exomina.service` for the actual host before installing it:

- Match `RequiresMountsFor` to the **actual encrypted mount path**, including `/var/lib/exomina/private` if that is the mount. Add ordering/dependencies for the chosen unlock/mount service; a directory dependency cannot unlock encryption by itself.
- Confirm the Node 24 executable used by `ExecStart` and the provider paths are reachable under `ProtectSystem`/`ProtectHome`.
- Set the service account's home and writable runtime/cache locations inside encrypted storage; create them with owner-only permissions. Review explicit `HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME` and native runtime behavior during acceptance testing.
- Add `LimitCORE=0` and review the host's crash/swap policy. Keep service logs free of prompts, tokens and exports. The template writes process stdout/stderr to the system journal, which normally lives outside the private data directory.
- Keep the service unprivileged, with `UMask=0077`, `NoNewPrivileges=true`, read-only system files and narrowly scoped writable paths. Do not relax those protections simply to make a failing provider start; trace and fix its specific path or sandbox requirement.

Then validate the unit with `systemd-analyze verify`, load it with `systemctl daemon-reload`, and start it. Verify the actual mount and files before enabling startup. Check for the generic loopback-ready message, and confirm no public listener was created.

## 5. Connect subscriptions on this host

Each official runtime needs its own sign-in **on the server**, in Exomina's isolated configuration directory. Do not copy the desktop's authentication files. Run setup as the `exomina` account with a minimal environment, encrypted runtime home/temp paths, and no inherited API keys. Keep any login URLs or one-time codes private.

For Codex, set `CODEX_HOME=/var/lib/exomina/private/codex-home` and use the official `codex login --device-auth` flow from the server terminal. Device login may first need enabling in ChatGPT security/workspace settings. Open the displayed official link on your device and enter its one-time code. [Codex headless authentication](https://learn.chatgpt.com/docs/auth)

For Claude, set `CLAUDE_CONFIG_DIR=/var/lib/exomina/private/claude-home` and use the official Claude Code login. Choose the claude.ai subscription account. On SSH, the browser may display a code that must be pasted into the runtime's terminal prompt. [Claude authentication and separate configuration directories](https://code.claude.com/docs/en/authentication)

**This build does not yet provide a complete phone-only first-time subscription setup.** Its Codex connection button currently requests the browser callback flow, and its Claude button does not expose an interactive terminal-code input. Use assisted official terminal setup for the initial server login and renew it if required. Refresh connections afterward and verify authentication type before the first small, owner-approved model turn.

Subscriptions and provider limits still apply. Programmatic Claude usage may have its own allowance; provider-side extra usage/credits can be billable if enabled. Exomina does not switch these billing options off or silently fall back to an API key. Optional API connections are explicit, separate, and can incur their provider's charges. [Claude plan and programmatic usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

## 6. Accept the deployment before importing personal data

Use synthetic conversations first. Confirm all of the following on the actual server and phone:

1. A signed-out client and another Google identity cannot access chats, tools, sync or device management. The app is unreachable outside the allowed tailnet policy.
2. HTTPS login, logout, session expiry, phone refresh, streaming replies, approvals and cancellation work through Serve. Test a small subscription turn only with the owner's approval and selected provider/model.
3. Pair a synthetic desktop profile; verify automatic bidirectional chats/notes/archive synchronization, offline edits, deletion, recovery copies after conflicts, token revocation and re-pairing. Do not synchronize raw live SQLite files.
4. Exercise native runtime status/login, a model turn and temporary files; inspect the actual resulting storage, caches and logs for plaintext outside the protected boundary. Confirm the plaintext-volume startup rejection on a separate synthetic path.
5. Reboot and follow the documented unlock procedure. Confirm the app remains unavailable before unlock, returns afterward, and interrupted jobs do not duplicate paid requests.
6. Stop the app and create a consistent encrypted backup including its databases, archive, credentials and vault key recovery material. Restore to an isolated test location. Host snapshots alone are not proof of a consistent, recoverable app backup; an extra attached volume may require its own backup arrangement.

Only after those checks should the real desktop be paired and personal history uploaded. Record the exact host, runtime versions, security configuration, test results, backup destination and recovery procedure. Keep the private server URL and recovery material in the owner's password manager. No public release or unattended-availability promise is implied by this plan.
