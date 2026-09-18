# Human Review Requests

Mdmaid.desk keeps document reading state and workflow decisions separate. A
document is passive unless its producer explicitly creates a review request.
Opening, registering, importing, or marking a document done never approves it.

## State Model

```text
pending -> approved
        -> changes_requested
        -> rejected
        -> superseded
        -> stale
```

A request is bound internally to a document ID, revision, and content hash.
Changing the content or losing the source makes a pending request stale. A
metadata-only registration and all reading-state changes leave it pending.
Only one request may be pending for a document, while resolved history remains
durable.

Request kinds are `plan-decision` for plans and `change-decision` for
first-class `change-review` documents. A change decision is rejected when its
document is not a change review, and a change review rejects any other decision
kind. Review outcomes are `approved`, `changes_requested`, `rejected`, and
`superseded`. Superseded closes an old request without approving or rejecting
it, so a waiting producer can ignore that version. Request and response
messages are stored as plain text. Requested changes require a non-empty
explanation; the other outcomes may also carry useful context.

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

Publish a mandatory implementation review with:

```bash
mdmaid-desk register .agent-runs/change-reviews/current/review.md \
  --workspace project \
  --producer codex \
  --kind change-review \
  --attention approval \
  --expect change-decision \
  --request-message "Review this exact implementation before publication." \
  --wait \
  --json
```

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

# Close an older request after publishing a replacement:
mdmaid-desk review respond <old-review-id> \
  --outcome superseded \
  --message "Replaced by the newer change review."
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
`requestMessage`. Response accepts `outcome` (`approved`, `changes_requested`,
`rejected`, or `superseded`), `message`, and optional `items`.
Items are available only for `changes_requested`: a `feedback` item identifies
a safe relative `path`, optionally a stable `hunkId`, and optionally a paired
`line` plus `side` (`old` or `new`). A path-only feedback item is file-level;
a line anchor must also identify its hunk. Legacy file-level `todo` items remain
accepted. All items carry an ID and bounded plain-text message. Unknown
fields, unknown enum values, unsafe paths or control data, malformed anchors,
and oversized messages are rejected. The first valid response wins atomically.
An identical retry returns the stored result, while a different retry receives
a conflict.

```json
{
  "outcome": "changes_requested",
  "message": "Address the anchored feedback.",
  "items": [
    {
      "id": "feedback-33333333333333333333",
      "kind": "feedback",
      "path": "src/auth.ts",
      "hunkId": "hunk-44444444444444444444",
      "line": 14,
      "side": "new",
      "message": "Use a constant-time comparison."
    },
    {
      "id": "feedback-55555555555555555555",
      "kind": "todo",
      "path": "test/auth.test.ts",
      "message": "Cover expired tokens."
    }
  ]
}
```

## Web and TUI

Both clients expose an Actions filter and pending count. The TUI additionally
exposes a dedicated Change Reviews space through `c`; it contains only
`change-review` documents and labels their reader as Change Review. A document
reader shows the producer's request message and decision controls only for an
explicit pending request. After a response, the controls disappear and the
stored result is read-only.

The TUI queue groups documents by project by default. Press `g` to cycle to
tag groups and then to one ordered list. Wide layouts show section headings;
narrow layouts retain the same grouped navigation order without spending rows
on headings.

The browser always provides a separate general-note text area. In the TUI, use
`r` for the Actions view, `y` to approve, `c` to request changes, `x` to reject,
or `o` to supersede an obsolete request. The TUI composer uses `Enter` for a
newline, `Ctrl-D` to submit, and `Esc` to cancel.

A Change Review containing fenced Git patches opens in a native read-only diff
view. Use `p`/`n` for files (`[`/`]` remain aliases), `j`/`k`
to move through lines across hunk boundaries, `m` for
unified/side-by-side layout, and `d` for the complete Markdown explanation.
Both native viewers color common keywords, strings, comments, numbers,
properties, types, and function calls according to the changed file extension
while preserving the red/green line backgrounds and intra-line emphasis.
Use `f` for feedback on the selected line, `t` for feedback on the current
file, and `z` to undo the latest unsent note. The browser exposes equivalent
controls: click the visible `+` beside a line number or **feedback on file**.
Request Changes stores all anchored notes as response `items` and keeps the
general note separate; open notes block Approve, Reject, and Supersede so they
cannot be discarded accidentally. A
Change Review with no parsed files or any parser warning also blocks Approve,
because the displayed native diff may not contain the exact requested scope.

Every Mermaid fence is parsed during registration and import. Invalid diagrams
reject ingress with the diagram number, Markdown start line, and Mermaid parser
diagnostic so the producer can correct the artifact. Live reference changes are
validated by the same gate. The browser still isolates runtime failures per
diagram so an older document or client-only renderer problem cannot hide the
rest of the review.

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

`superseded` is terminal just like the decision outcomes, so `review wait`
returns immediately and the producer can ignore the obsolete review rather
than treating it as approval, requested changes, or rejection.

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
