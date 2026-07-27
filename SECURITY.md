# Security

## Scope

Mdmaid.show reads local Markdown and serves rendered content to a local browser.
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

## Required Before Daemon Release

- bind to `127.0.0.1` by default;
- authenticate mutation requests using a local random token or Unix socket;
- reject unexpected browser origins;
- do not enable permissive CORS;
- apply API body and field limits;
- sanitize agent-generated raw HTML;
- define a strict Mermaid security profile;
- use a restrictive Content Security Policy;
- avoid exposing absolute paths in browser responses;
- reject special files and path changes between validation and read;
- add catalog locking or enforce one daemon writer;
- test stale daemon and state-file recovery.

## Reporting

Do not open public issues containing private paths, document contents, tokens,
or agent transcripts. Report security concerns privately to the repository
owners.
