# Human Review Requests

Mdmaid.desk keeps document reading state and workflow decisions separate. A
document is passive unless its producer explicitly creates a review request.
Opening, registering, importing, or marking a document done never approves it.

## State Model

```text
pending -> approved
        -> changes_requested
        -> rejected
        -> stale
```

A request is bound internally to a document ID, revision, and content hash.
Changing the content or losing the source makes a pending request stale. A
metadata-only registration and all reading-state changes leave it pending.
Only one request may be pending for a document, while resolved history remains
durable.

The initial request kind is `plan-decision`. Human outcomes are `approved`,
`changes_requested`, and `rejected`. Request and response messages are stored as
plain text. Requested changes require a non-empty explanation; the other
outcomes may also carry useful context.

## Producer CLI

Publish and wait in one command:

```bash
mdmaid-desk register docs/plan.md \
  --workspace project \
  --producer codex \
  --kind plan \
  --expect plan-decision \
  --request-message "Verify migration and rollback." \
  --wait \
  --json
```

The same review flags work with `import`. Without `--expect`, registration and
import remain passive and show no decision controls.

Composable operations:

```bash
mdmaid-desk review create <document-id> \
  --kind plan-decision \
  --message "Verify migration and rollback."
mdmaid-desk review show <review-id> --json
mdmaid-desk review wait <review-id> --json
mdmaid-desk review respond <review-id> \
  --outcome approved \
  --message "Proceed after the backup check."
```

JSON output is versioned and contains the public document identity, complete
review request, producer message, final outcome, human message, and timestamps.
It never contains a content hash or filesystem path.

## API

Authenticated endpoints:

```text
POST /api/v1/review-requests
GET  /api/v1/review-requests
GET  /api/v1/review-requests/:id
POST /api/v1/review-requests/:id/respond
```

List filters:

```text
?document=doc-...
?status=pending
```

Creation accepts `documentId`, optional `documentRevision`, `kind`, and
`requestMessage`. Response accepts `outcome` and `message`. Unknown fields,
unknown enum values, unsafe control data, and oversized messages are rejected.
The first valid response wins atomically. An identical retry returns the stored
result, while a different retry receives a conflict.

## Web and TUI

Both clients expose an Actions filter and pending count. A document reader
shows the producer's request message and decision controls only for an explicit
pending request. After a response, the controls disappear and the stored result
is read-only.

The browser always provides a response text area. In the TUI, use `r` for the
Actions view, `y` to approve, `c` to request changes, or `x` to reject. The TUI
composer uses `Enter` for a newline, `Ctrl-D` to submit, and `Esc` to cancel.

## Waiting and Recovery

`review wait` checks durable state before subscribing, checks again once the
SSE stream is ready, and reads state after relevant events. An event is a wake
signal only; it is never the decision source of truth. If the daemon restarts,
the CLI resolves the current descriptor and reconnects. Without a daemon it
polls SQLite without holding a transaction, so a later web or TUI service can
respond through the same catalog.

The command waits without using model turns. If the waiting process exits, the
request and response remain recoverable with `review show` or another
`review wait`. Mdmaid.desk does not execute callbacks or relaunch a dead agent
session; that requires a separate supervisor.

## Security Boundaries

- Existing bearer/cookie authentication and browser-origin checks protect all
  review endpoints.
- Text is length-bounded, stored through parameterized SQL, inserted into the
  browser as text, and sanitized for terminal output.
- Review requests cannot contain callback URLs, shell commands, provider resume
  arguments, paths, or custom executable actions.
- The server selects and stores the private content hash; clients cannot supply
  or read it.
- Human response, reading state, and document attention remain distinct.
