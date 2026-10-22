# Publishing Exomina updates

## Distribution channels

Authenticated automatic delivery in this document targets signed Windows x64
installations. macOS/Linux packages and existing per-user Windows beta packages
retain their manual update process and separate native qualification workflows.
The public source release alone does not activate automatic delivery or migrate
an existing beta profile into the signed Windows installation layout.

Exomina discovers signed releases at startup and every six hours. With automatic
downloads enabled, it downloads and verifies new packages in the background.
Installation requires the user's choice, an idle app and Windows administrator
consent. Customized installations prepare and verify a separate three-way merge.

The client, publisher tools and GitHub workflows are implemented in source.
Live distribution requires a repository, publisher identities, protected release
environment and installation qualification. Empty configuration fails closed.
A local build does not activate a public channel.

## Publisher configuration

Release versions follow major.minor.patch. Feature releases advance the minor
number, compatible fixes and security maintenance advance the patch number,
and incompatible changes advance the major number. Local builds and retries
keep that version and receive unique build IDs. Choose a release deliberately
with `node scripts/prepare-version.mjs --release patch`, `minor` or `major`;
use `--set VERSION` to name a preview such as 0.7.0-rc.1 when a separate test
channel is useful. A public tag must match the selected package version.

Set package.json `homepage` to the public GitHub repository. Bundle
`build/update-channel.json` with format 2, an HTTPS `feedUrl`, a `channel`
such as `stable`, and `trustedKeys` mapping key IDs to Ed25519 public PEM keys.
The feed can be
`https://github.com/OWNER/REPO/releases/latest/download/latest.json`.
Only bundled keys establish publisher trust. Feeds, settings and cached
records cannot introduce keys. Keep private keys outside source control.

Public Windows packaging requires `WIN_CSC_LINK` or `CSC_LINK`, its password,
and `EXOMINA_PUBLISHER_THUMBPRINT`. Application, first-party Windows helpers,
installer and generated uninstaller need verified timestamped publisher
signatures. Vendor executable bytes retain their upstream identity and hashes.
Release inventories are generated after signing. Public program files must be
free of EFS encryption.

Update export requires `EXOMINA_UPDATE_KEY_ID` and
`EXOMINA_UPDATE_PRIVATE_KEY_FILE`. The key must match a public key bundled
in the exact packaged application's ASAR configuration.

```powershell
npm run package:official
node scripts/create-public-update.mjs --build PATH/TO/win-unpacked --output release/publish --base-url https://github.com/OWNER/REPO/releases/download/vVERSION/
```

The exporter creates the program ZIP and signed latest.json locally. It does
not publish. The signature binds exact payload bytes, channel, publication and
expiry dates, build/version identity, archive URL, size, archive hash and file
inventory hash. Metadata validity is at most 90 days and defaults to 30 days.
Maintain fresh signed channel metadata during long gaps between releases.

Clients reject unsigned, expired, tampered and wrong-channel metadata, unknown
keys, mismatched archives/inventories, unsafe archive entries, links and
encrypted program caches. They revalidate cached releases before merge
preparation and immediately before executing staged code. The elevated
installer checks the approved complete receipt before activation. Earlier
unsigned caches cannot be adopted.

For key rotation, first ship both public keys through a release trusted by the
old key, then sign with the new key. Retire old pins after the transition.
The feed cannot silently establish a new publisher identity.

## GitHub release and security maintenance

- `.github/workflows/security-maintenance.yml` polls npm advisories and
  compatible direct releases, plus official Node 24 releases, every six hours.
  It prepares a pull request and runs tests and a production build. Native
  provider executables and incompatible upgrades remain review items.
- `.github/workflows/release.yml` builds a signed Windows candidate and retains
  its exact artifacts for qualification. A separate dispatch publishes that
  candidate only after matching qualification evidence is committed to the
  trusted default branch. It refuses to overwrite an existing or uncertain release.
- `.github/dependabot.yml` provides independent dependency update proposals.
- `.github/workflows/refresh-update-metadata.yml` can renew the current signed
  metadata before expiry, preserving its archive, inventory and release fields.
  Enable it with `EXOMINA_UPDATE_METADATA_REFRESH=true`. It rechecks the remote
  release and exact original hash before replacing latest.json. GitHub asset
  replacement has no atomic compare-and-swap operation; simultaneous manual
  publication remains a race requiring operator coordination.

Workflows use pinned setup and artifact Actions with native runner git/gh.
Configure a trusted Windows runner with the pinned Node 24.22.1 runtime.
Pull-request validation has no
signing secrets. Publication runs through the protected `public-release`
environment and trusted repository history.

Repository variables: `EXOMINA_PUBLIC_RELEASE_ENABLED=true`,
`EXOMINA_PUBLISHER_THUMBPRINT`, `EXOMINA_UPDATE_KEY_ID`.
Environment secrets: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`,
`EXOMINA_UPDATE_PRIVATE_KEY_PEM`. Configure environment protection and review
rules in GitHub; a workflow file does not establish them.

Optional `EXOMINA_SECURITY_AUTOMERGE=true` requires enforced strict branch
protection and the required `validate` check. Optional
`EXOMINA_SECURITY_AUTO_CANDIDATE=true` builds candidates for qualified maintenance
merges. Publishing still requires exact-candidate qualification. Otherwise
preparation remains automatic while merge and candidate creation await review.
Hosted services are patched by their operators.

Node candidates require official archive/executable checksums, valid
Authenticode from a bundled OpenJS signer pin, and a matching signed product
version. Preparation and runtime-selection pins advance together. Certificate
rotation and major upgrades require review. A registry release alone does not
authenticate arbitrary provider executables.

## Installation and migration

Public setup uses Program Files/Exomina/App with separate Private, Workspace
and editable Source siblings. A public ZIP is an update payload and cannot
initialize an arbitrary portable profile. Setup refuses existing installations
and profiles. Existing beta and portable users need an explicit verified
migration preserving their original profile; that migration is not automatic.

Initial public setup supports same-account administrator elevation. Alternate
administrator credentials require reviewed ownership migration. Clean Windows
installation, UAC, update, rollback, removal and antivirus qualification remain
required before release. Public removal verifies program inventory and keeps
Private, Workspace and Source. EFS protects private data after setup; executable
program files remain unencrypted.

## Customized installations

Publisher builds use `npm run package:official`. Ordinary `npm run package`
retains the installed official source baseline when available. Release ZIPs
include the checksum-verified `exomina-source` snapshot.

Settings → Updates → Prepare merged update compares the installed official
baseline, customized Source and incoming release in a separate workspace.
Review conflicts, then use `app_update_verify`. Verification asks permission
to install dependencies with lifecycle scripts disabled, prepare the pinned
runtime, run tests and package. Checks execute project code under the Windows
account; they do not sandbox malicious source.

Applying rechecks source and package receipts. The previous App remains
available. Journaled source promotion preserves the original source as
Source.previous-PLAN. Database migration rollback is not automatic. Missing
baselines or direct program edits require review before global replacement.

## Release qualification

Signing establishes publisher identity and integrity; it does not establish
SmartScreen reputation or antivirus acceptance. Test exact release hashes on
clean supported Windows systems with Defender and Bitdefender, including
install, startup, tools, update, cancellation, recovery and removal. Record
versions, detections, process ancestry and hashes. Submit confirmed false
positives through the vendor's review channel. Build scripts do not upload
samples, configure broad exclusions or change firewall policy.

A tag or a dispatch without `candidate_run_id` creates the
`windows-public-candidate` workflow artifact, retained for 30 days. Test those
exact files, then commit a qualification record and its reports to the default
branch. Dispatch `release.yml` with the successful `candidate_run_id` and
`qualification_file` (default `build/public-release-qualification.json`). The
publication job reuses the tested files and does not rebuild them.

The qualification record uses `format: 1` and binds `sourceRevision`, `buildId`,
`inventorySha256`, `installerSha256`, `archiveSha256` and `metadataSha256` from
the candidate manifest. It requires `signaturesVerified`, `cleanUpdate`,
`customizedUpdate`, `recovery` and `stockAntivirus` to be true. The four latter
checks each need a `reports` entry containing a repository-relative `path`,
that report's `sha256`, and an ISO `testedAt` date. These fields are a record of
actual tests; setting booleans does not perform qualification. The publication
job checks trusted ancestry, report and artifact hashes, current update keys
and the pinned installer signature before creating a release.
