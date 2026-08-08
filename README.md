# mdmaid.desk

`mdmaid.desk` is a persistent local document inbox and reading workspace for
Markdown artifacts produced by harnesses, editors, and scripts.

The repository name is `mdmaid.desk`; its initial executable is
`mdmaid-desk`.

## Status

The repository contains the first usable shared-service vertical slice:

- persistent workspace metadata;
- Markdown document registration;
- idempotent updates by canonical path;
- workspace and artifact-root containment;
- symlink-escape protection;
- document size limits;
- revision-aware Unread, Reading, and Done state;
- tags, archive, and missing-document state;
- transactional SQLite migrations and one-time JSON catalog import;
- user-only catalog permissions;
- authenticated loopback HTTP API and stable document/workspace routes;
- sanitized `mdmaid` HTML and terminal rendering;
- responsive browser queue, project/status filters, search, reader, and actions;
- terminal-native queue, filters, search, reader, and lifecycle actions;
- Server-Sent Event refreshes for both clients;
- atomic, user-only daemon discovery state so the TUI reuses a running service;
- optional secure `https://mdmaid.desk.localhost/` browser origin;
- `workspace`, `register`, `list`, `web`, and `tui` commands.

Background `daemon ensure/status/stop`, directory watching, stdin-managed
enqueue, comments, and editing remain planned milestones. `web` currently runs
the persistent service in the foreground; `tui` attaches to it when present and
uses an embedded loopback service otherwise.

## Responsibility

`mdmaid.desk` owns:

- the persistent local daemon;
- workspace and document catalogs;
- artifact-directory discovery;
- stable document URLs;
- the browser document library;
- local CLI and API access;
- attention metadata;
- presentation security boundaries.

It does not own:

- agent workflow state;
- task approvals;
- model or provider routing;
- Markdown rendering internals;
- editor-specific keymaps.

`mdmaid` remains the rendering engine. `agentctl` is a configurator only.
Harnesses and tools register documents directly through generic CLI/API
interfaces. `mdmaid.nvim` may become an optional client.

## Development

```bash
npm install
npm test
```

Build:

```bash
npm run build
```

Run the CLI from the build:

```bash
node dist/cli.js --help
```

## Current CLI

Register a workspace:

```bash
node dist/cli.js workspace add /path/to/repository \
  --id example \
  --name "Example"
```

Register a document:

```bash
node dist/cli.js register /path/to/repository/docs/plan.md \
  --workspace example \
  --task PROJECT-123 \
  --kind plan \
  --attention approval
```

List documents:

```bash
node dist/cli.js list --workspace example
node dist/cli.js list --task PROJECT-123
```

Run the browser workspace as a foreground local service:

```bash
node dist/cli.js web
node dist/cli.js web --port 43127
```

The command prints an authenticated browser URL and publishes a user-only
`daemon.json` beside the catalog for local clients. Stop it with `Ctrl-C`.

For a memorable local HTTPS URL, put a trusted local reverse proxy in front of
the loopback service. The included Caddy example maps the canonical
`https://mdmaid.desk.localhost/` origin to port `43127`:

```bash
caddy start --config examples/Caddyfile
node dist/cli.js web --public-url https://mdmaid.desk.localhost
```

Trust Caddy's local certificate authority once with `caddy trust`, or install
the same Caddyfile in a user service. The `.localhost` name resolves locally
without an `/etc/hosts` entry. The web command validates the public origin,
uses secure cookies and exact-origin mutation checks, and prints the one-time
authenticated URL to open. Its persistent random authentication token is kept
as a user-only `auth-token` file beside the catalog, so existing browser
sessions survive service restarts.

See [Local HTTPS](docs/LOCAL_HTTPS.md) for the proxy boundary and setup details.

Run the terminal workspace:

```bash
node dist/cli.js tui
```

The TUI reuses the running web daemon when available, so both clients share
catalog events and reading state. Keys are shown in its footer; the main flow
uses `j`/`k`, `Enter`, `/`, `m`, `u`, `a`, `b`, and `q`.

The default state directory is:

```text
${XDG_STATE_HOME:-~/.local/state}/mdmaid.desk/
  auth-token
  catalog.sqlite3
  daemon.json  # present while the web service is running
```

## Target Interaction

```mermaid
flowchart LR
    A[Harnesses and tools] -->|register document| S[mdmaid.desk]
    CFG[agentctl] -.->|optional configuration| A
    N[mdmaid.nvim] -->|register or open| S
    X[Scripts] -->|register| S
    S --> CAT[(Catalog)]
    S --> M[mdmaid renderer]
    S --> W[Web workspace]
    S --> T[TUI workspace]
    W --> H[Human]
    T --> H
    H -->|reading status and tags| S
```

Document registration and presentation never imply workflow approval.

## Documentation

- [Architecture and roadmap](docs/ARCHITECTURE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Naming

Current naming:

```text
Product/UI:  mdmaid.desk
Repository:  mdmaid.desk
Package:     mdmaid.desk
CLI:         mdmaid-desk
```

A future `mdmaid desk ...` umbrella command may delegate to this package, but
the repositories and release cycles remain separate.
