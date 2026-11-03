# Prepare a source export

Run from a source checkout:

```sh
node scripts/prepare-beta-release.mjs --public --output ../exomina-export
```

The destination must be empty and outside the source tree. The exporter retains the selected package version, includes build and test inputs, uses Apache-2.0 licensing and preserves the public documentation and website when run from a public checkout. Native packaging commands and their pinned platform dependencies are included. Exporting does not qualify an installer or publish a release.

Use `--beta` instead of `--public` to prepare a manual-update beta from a public checkout. Its Apache-2.0 licence, public documentation and native build scripts are retained.

To reconcile a separate public checkout against a release tree, supply an explicitly verified common ancestor:

```sh
node scripts/prepare-beta-release.mjs --public --output ../exomina-export --public-base ../exomina-public --public-base-ancestor ../exomina-common-ancestor
```

Only allowlisted source, build and documentation paths participate. Source changes and public changes are merged from that ancestor. Unresolved text, binary or package-metadata conflicts stop preparation and report their paths before applying the reconciliation changes. Review the conflicts in an isolated checkout, then prepare a fresh export. The ancestor must actually be common to the versions being combined; the exporter cannot establish that history for a plain folder snapshot.

Run `npm ci`, `npm test` and `npm run build` in the resulting export. Native packages and signed updates require the additional target-specific qualification described in `BUILDING.md` and `PUBLIC-UPDATES.md`.
