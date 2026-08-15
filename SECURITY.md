# Security

## Scope

Mdmaid.desk reads local Markdown and serves rendered content to local clients.
Both the filesystem boundary and browser boundary are security-sensitive.

## Current Controls

- only regular, bounded `.md` files can be registered or imported;
- workspaces and artifact roots are canonicalized;
- artifact roots must remain under their workspace;
- documents must remain under an artifact root after realpath resolution;
- import is a separate explicit operation and does not broaden registration or
  watcher artifact-root authorization;
- final-path symlinks and symlink escapes are rejected;
- documents are limited to 2 MiB by default;
- imported snapshots are written atomically into non-symlink, mode-`0700`
  managed directories and use mode `0600`;
- public API responses expose neither original nor managed filesystem paths;
- local Markdown links are stored as workspace-relative mappings and served
  only through authenticated, document-scoped routes;
- linked sources are re-authorized on every read, limited to regular UTF-8 text
  under the canonical workspace root, and never followed through symlinks;
- catalog writes are atomic;
- new catalog files use mode `0600`;
- new catalog directories use mode `0700`.
- the server binds only to loopback addresses;
- protected APIs require a random bearer token or HTTP-only same-site browser
  cookie;
- persistent authentication and daemon discovery files use mode `0600`;
- browser URLs must use an HTTP or HTTPS `.localhost` origin;
- browser mutation requests require the exact configured origin;
- HTTPS browser cookies are additionally marked `Secure` and responses include
  HSTS;
- forwarding headers are not part of the trust boundary;
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
