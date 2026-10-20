# Private phone access

Settings → Connections & sync → Phone access connects your own phone to your awake
computer. It is separate from Private Exomina sync. No server is rented or deployed
by the desktop update.

Use a dedicated HTTPS hostname on a server you control. Its website operator can
ship code that uses the phone's keys. Encryption protects traffic and the relay
database, but does not remove that trust. This release is for owner-hosted private
testing. Physical Android/iOS compatibility has not been verified.

## Server

Use Node 24 or newer. Copy the bundle's cloud/ and dist/ directories to
/opt/exomina-phone. The account/relay service requires no npm install. Create an
unprivileged exomina-phone service user and an owner-only /var/lib/exomina-phone
directory for SQLite. Never upload the desktop's Private folder, provider account
stores, chat database or remote-connection.json.

Create an owner-only /etc/exomina-phone.env with:

    EXOMINA_ACCOUNTS_DB=/var/lib/exomina-phone/accounts.sqlite
    EXOMINA_ACCOUNTS_SECRET=<at least 32 randomly generated characters>
    EXOMINA_ACCOUNTS_PORT=4180
    EXOMINA_PHONE_DIST=/opt/exomina-phone/dist
    EXOMINA_TRUST_PROXY=1

Generate the secret on your server. Use the same environment for the service and
invitation CLI. Run this systemd unit with appropriate local paths:

    [Unit]
    Description=Exomina private phone relay
    After=network-online.target

    [Service]
    User=exomina-phone
    Group=exomina-phone
    WorkingDirectory=/opt/exomina-phone
    EnvironmentFile=/etc/exomina-phone.env
    ExecStart=/usr/bin/node /opt/exomina-phone/cloud/accounts-start.mjs
    Restart=on-failure
    NoNewPrivileges=true
    PrivateTmp=true
    ProtectSystem=strict
    ProtectHome=true
    ReadWritePaths=/var/lib/exomina-phone
    UMask=0077

    [Install]
    WantedBy=multi-user.target

The process binds to loopback. Put Caddy on the same server in front:

    your-private-phone-host.example {
        reverse_proxy 127.0.0.1:4180
    }

Only expose HTTPS to Caddy, not port 4180. Only enable EXOMINA_TRUST_PROXY behind
your own proxy. Back up SQLite consistently, including its WAL where appropriate,
and keep an encrypted copy of the environment file. No DNS or certificate setup
has been performed by this update.

## Pair

With the server environment loaded, create a one-use invitation:

    node /opt/exomina-phone/cloud/accounts-cli.mjs invite owner@example.com

Give the code privately to the computer owner. Enter it with the HTTPS relay
address in desktop Phone access. A new account's first computer activates; later
computers need approval/recovery from an existing device.

Turn on Allow phone control (off by default), click Pair a phone, scan the QR and
name the phone. Compare the confirmation codes on both screens before ticking
the matching-code box and approving. The QR is single-use and expires in ten
minutes. If the phone reports it was already used, approve nothing and show a new
QR code.

The browser must support WebCrypto X25519 and Ed25519 and IndexedDB. Unsupported
browsers report an error. Add the page to the home screen if desired. The phone
portal has no offline chat or service worker cache.

## Controls and limits

Switching off Allow phone control closes the desktop subscription immediately.
Requests queued while off do not execute on re-enable. Remove phone forgets the
local desktop pin before attempting server revocation. A relay network failure
cannot restore that local pin; retry server-side revocation if needed.

Forget this phone deletes its local keys; also remove it in desktop Settings to
revoke its server record. Removal cannot erase plaintext already seen.

The phone supports chats, work status, questions, one-time approvals, notes and
usage. Provider sign-ins, permissions, permanent grants, updates and remote
configuration remain desktop controls. Approvals bind to exact pending details;
account/security changes must be accepted on the computer. Tasks use the desktop
tools the owner already enabled.

Static keys provide no forward secrecy. Desktop keys use OS-backed safeStorage;
another process running as the same Windows user is inside that trust boundary.
Keep both operating systems and devices protected.

## Update

Keep the account database and environment file. Replace cloud/ and dist/ from the
new bundle and restart the service. Keep desktop and phone assets from the same
release together. The server never needs provider credentials.
