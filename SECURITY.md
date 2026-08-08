# Security

## Scope

Mdmaid.desk reads local Markdown and serves rendered content to local clients.
Both the filesystem boundary and browser boundary are security-sensitive.

## Current Controls

- only `.md` files can be registered;
- workspaces and artifact roots are canonicalized;
- artifact roots must remain under their workspace;
- documents must remain under an artifact root after realpath resolution;
- final-path symlinks and symlink escapes are rejected;
- documents are limited to 2 MiB by default;
- the catalog stores metadata only;
- catalog writes are atomic;
- new catalog files use mode `0600`;
- new catalog directories use mode `0700`.
- the server binds only to loopback addresses;
- protected APIs require a random bearer token or HTTP-only same-site browser
  cookie;
- persistent authentication and daemon discovery files use mode `0600`;
- an optional public browser URL must be an HTTPS `.localhost` origin;
- HTTPS browser cookies are `Secure` and mutation requests require the exact
  configured origin;
- reverse-proxy forwarding headers are not part of the trust boundary;
- rendered HTML is sanitized and served with a restrictive CSP.

## Required Before Daemon Release

- do not enable permissive CORS;
- define a strict Mermaid security profile;
- avoid exposing absolute paths in any future browser responses;
- reject special files and path changes between validation and read;
- add catalog locking or enforce one daemon writer;
- test stale daemon and state-file recovery.

## Reporting

Do not open public issues containing private paths, document contents, tokens,
or agent transcripts. Report security concerns privately to the repository
owners.
