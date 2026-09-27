# Releasing and distribution

`mdmaid-desk` is the canonical release artifact. GitHub releases and the
planned Homebrew formula use the same package version rather than building
independent distributions.

## Release flow

Every pull request runs:

- the full check suite on Node.js 22 and 24;
- an installed-package smoke test on Linux, macOS, and Windows;
- validation that the tarball contains the CLI, server, TUI, README, and
  license without compiled test files.

After a successful merge to `main`, the `publish` job:

1. re-runs checks and the installed-package smoke test;
2. publishes the current version, or increments the patch version when the
   current version is already released;
3. pushes the version commit and annotated tag;
4. creates the corresponding GitHub release with generated notes.

The workflow detects partially completed releases and can be re-run to recover
a published package that is missing its git tag or GitHub release.

## One-time npm bootstrap

npm requires a package to exist before a trusted publisher can be configured.
For the first `mdmaid-desk` publish only:

1. create a granular npm access token that can publish new public packages;
2. add it as `NPM_TOKEN` in the GitHub `prod` environment;
3. merge the release-readiness pull request and let CI publish `0.1.0`;
4. on npm, configure the package trusted publisher with:
   - organization or user: `riidii-md`;
   - repository: `mdmaid.desk`;
   - workflow: `ci.yml`;
   - environment: `prod`;
   - allowed action: `npm publish`;
5. remove `NPM_TOKEN` from GitHub after an OIDC release succeeds.

Subsequent releases use short-lived OIDC credentials and automatically carry
npm provenance. The repository URL in `package.json` must continue to match
the public GitHub repository exactly.

## Local package verification

```bash
npm run check
npm run package:smoke
```

The smoke test packs the exact publish allowlist, installs the tarball into an
isolated prefix, checks `--help` and `--version`, creates a real SQLite catalog,
starts the installed web daemon, and waits for its health endpoint.

## Schema 9 backup and downgrade recovery

Opening a schema-8 catalog with a release that contains Spaces upgrades it to
schema 9. Older binaries cannot open schema 9, and there is no supported
in-place downgrade. Before the first schema-9 start, stop every writer and make
one verified, non-overwriting sibling backup:

```bash
mdmaid-desk daemon stop
desk_state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/mdmaid.desk"
catalog_path="$desk_state_dir/catalog.sqlite3"
backup_path="$desk_state_dir/catalog.sqlite3.schema-8.backup"
test "$(mdmaid-desk daemon status)" = "daemon stopped"
test ! -e "$desk_state_dir/daemon.json"
test -f "$catalog_path"
test ! -e "$backup_path"
test "$(stat -f '%Lp' "$catalog_path" 2>/dev/null || stat -c '%a' "$catalog_path")" = 600
sqlite3 -readonly "$catalog_path" 'PRAGMA user_version; PRAGMA integrity_check;'
sqlite3 -readonly "$catalog_path" \
  'SELECT "workspaces", count(*) FROM workspaces UNION ALL SELECT "documents", count(*) FROM documents UNION ALL SELECT "review_requests", count(*) FROM review_requests;'
umask 077
cp -p "$catalog_path" "$backup_path"
chmod 600 "$backup_path"
shasum -a 256 "$catalog_path" "$backup_path"
test "$(stat -f '%Lp' "$backup_path" 2>/dev/null || stat -c '%a' "$backup_path")" = 600
sqlite3 -readonly "$backup_path" 'PRAGMA user_version; PRAGMA integrity_check;'
```

The first `PRAGMA user_version` must report `8`, both integrity checks must
report `ok`, both digests must match, and the source and backup must have mode
`0600`. The stopped status and absent descriptor are the quiescence check; also
stop any separately launched CLI, service manager, or test process that can
write this catalog.
Record the three table counts with the release evidence. Start the new release,
then verify that the live catalog reports version 9, `ok`, and the same counts.

To roll back, stop all writers again, keep the schema-9 file for diagnosis,
restore the verified backup to the canonical path, and verify it before starting
the older binary:

```bash
mdmaid-desk daemon stop
desk_state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/mdmaid.desk"
catalog_path="$desk_state_dir/catalog.sqlite3"
backup_path="$desk_state_dir/catalog.sqlite3.schema-8.backup"
test "$(mdmaid-desk daemon status)" = "daemon stopped"
test ! -e "$desk_state_dir/daemon.json"
test -f "$backup_path"
test ! -e "$catalog_path.schema-9.failed"
backup_digest="$(shasum -a 256 "$backup_path" | awk '{print $1}')"
mv "$catalog_path" "$catalog_path.schema-9.failed"
cp -p "$backup_path" "$catalog_path"
chmod 600 "$catalog_path"
test "$(stat -f '%Lp' "$catalog_path" 2>/dev/null || stat -c '%a' "$catalog_path")" = 600
test "$(shasum -a 256 "$catalog_path" | awk '{print $1}')" = "$backup_digest"
sqlite3 -readonly "$catalog_path" 'PRAGMA user_version; PRAGMA integrity_check;'
sqlite3 -readonly "$catalog_path" \
  'SELECT "workspaces", count(*) FROM workspaces UNION ALL SELECT "documents", count(*) FROM documents UNION ALL SELECT "review_requests", count(*) FROM review_requests;'
```

The restored catalog must report version 8, `ok`, and the recorded pre-upgrade
counts. Without the verified schema-8 backup, downgrade is unsupported.

## Homebrew follow-up

After `mdmaid-desk@0.1.0` exists on npm, create a dedicated
`riidii-md/homebrew-tap` repository with a `mdmaid-desk` formula. The
formula should install the npm tarball into `libexec`, expose the
`mdmaid-desk` executable, and define a foreground `web` command for
`brew services`.

Target usage:

```bash
brew install riidii-md/tap/mdmaid-desk
brew services start riidii-md/tap/mdmaid-desk
mdmaid-desk tui
```

The tap should build bottles for supported macOS and Linux architectures so
users do not unexpectedly compile `better-sqlite3`. Updating the tap from the
npm/GitHub release is a separate cross-repository workflow and should use a
narrowly scoped GitHub App or token.

Windows initially uses the npm package. Scoop or WinGet manifests and signed
standalone binaries can follow after the npm and Homebrew paths are stable.
