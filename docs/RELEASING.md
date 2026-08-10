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
   - organization or user: `OleksandrBesan`;
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

## Homebrew follow-up

After `mdmaid-desk@0.1.0` exists on npm, create a dedicated
`OleksandrBesan/homebrew-tap` repository with a `mdmaid-desk` formula. The
formula should install the npm tarball into `libexec`, expose the
`mdmaid-desk` executable, and define a foreground `web` command for
`brew services`.

Target usage:

```bash
brew install OleksandrBesan/tap/mdmaid-desk
brew services start OleksandrBesan/tap/mdmaid-desk
mdmaid-desk tui
```

The tap should build bottles for supported macOS and Linux architectures so
users do not unexpectedly compile `better-sqlite3`. Updating the tap from the
npm/GitHub release is a separate cross-repository workflow and should use a
narrowly scoped GitHub App or token.

Windows initially uses the npm package. Scoop or WinGet manifests and signed
standalone binaries can follow after the npm and Homebrew paths are stable.
