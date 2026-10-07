# Document Feedback

Feedback is available on every catalogued document. It is independent from
human review: creating feedback does not create, resolve, or otherwise change a
review request. A `pending` review means only that a producer is waiting for an
explicit decision.

Each immutable submission has a `feedback-…` ID and stable `/f/:id` route. A
submission targets one exact document revision and contains an optional general
message plus up to 32 comments. Comments use `comment-…` IDs and an intent of
`feedback` or `todo`.

## Anchors

Markdown comments are selected against the renderer's versioned source map.
Clients send a `markdown-selection-v1` witness containing start/end renderer
references and UTF-16 offsets, together with the opaque `sourceWitness`
returned by the exact render. The server regenerates the map from the exact
registered source and stores a durable `markdown-v1` text anchor with:

- zero-based, end-exclusive UTF-16 source offsets;
- one-based line and column coordinates;
- exact selected text plus bounded prefix and suffix context.

Selections must remain inside one mapped Markdown block. Generated Mermaid,
raw HTML, omitted change-review diff fences, and other content without a
truthful source mapping cannot be selected.

Native change-review comments use `diff-file-v1` or `diff-lines-v1`. Line
anchors include the safe relative path, stable hunk ID, old/new side, start
line, and optional inclusive range end. The server validates every anchor
against the exact parsed diff.

## API

```text
POST /api/v1/feedback
GET  /api/v1/feedback/:id
GET  /api/v1/feedback?document=:documentId&revision=:revision&limit=50&cursor=:cursor
```

List results are newest first and paginate by the immutable `(createdAt, id)`
tuple. The default page size is 50 and the maximum is 100. All endpoints obey
the same optional Space scope as document reads.

Example submission:

```json
{
  "id": "feedback-0123456789abcdefabcd",
  "documentId": "doc-0123456789abcdefabcd",
  "documentRevision": 3,
  "sourceWitness": "witness-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "generalMessage": "The direction is sound.",
  "comments": [
    {
      "id": "comment-0123456789abcdefabcd",
      "intent": "feedback",
      "anchor": {
        "kind": "markdown-selection-v1",
        "start": { "ref": "m1-s4", "offset": 0 },
        "end": { "ref": "m1-s4", "offset": 18 }
      },
      "message": "Clarify this constraint."
    }
  ]
}
```

Retrying the same ID with the same payload is idempotent. Reusing it for a
different payload, targeting a changed revision, or submitting an invalid
anchor or stale source witness returns a conflict or validation error.

## CLI and readers

```bash
mdmaid-desk feedback show <feedback-id> --json
mdmaid-desk feedback list --document <document-id> --revision <n> --json
```

In Web, select mapped document text and use **+ comment on selection**. Native
diffs retain file and line/range `+` controls. General and specific comments
share one draft and one submission.

Readers load paginated feedback across document revisions. Current-revision
feedback may be placed inline; older submissions stay in history with an
explicit `historical` revision label and are never reattached to current text.

In TUI document view, `[`/`]` selects a source row, `f` comments it, `g` edits
general feedback, and `s` submits. In native diff view, `f` comments the current
line or selected range and `t` comments the file. These controls remain
available with no review request and after a review has reached a terminal
state.

When a decision is pending, Web and TUI may submit the same feedback draft with
the decision. The feedback submission and response link are committed in one
SQLite transaction. Legacy review response items remain readable and are
backfilled into the same feedback model during schema migration.
