# Live source serving and refresh — discovery handoff

Status: superseded by approved implementation plan v1

## Decision record

- Decision: approved for implementation
- Human response: `yeah`
- Decision date: 2026-09-04
- Approved plan: `docs/plans/live-serving-plan.md`
- Approved SHA-256: `ad8d033001306a59198be6268fd068bd6f021f0c08d4e2f15af247a8c8c7ce9e`
- Accepted constraints, exclusions, risks, and acceptance criteria: those in
  the approved plan and this discovery handoff

Material changes to the approved plan invalidate this approval and require a
new human decision.

This file records the feature request and discovery evidence for work in branch
`feat/live-serving`. The approved decisions and executable sequence are in the
plan identified by the decision record above.

## Goal

Make mdmaid.desk a live viewer for source-backed Markdown documents:

- a registered document should continue to render from its authorized source
  path;
- while the daemon is running, source changes should appear in an open Web or
  TUI reader without another manual registration;
- the catalog should reconcile revision, reading state, review state, and local
  link mappings when the source changes;
- the UI should clearly distinguish a live source reference from an imported
  snapshot;
- workspace-local links and supported embedded media should continue to resolve
  safely from the document's source workspace.

Preserve `import` as the explicit durable-copy workflow for temporary files.
Opening, registering, importing, or live-refreshing a document never grants
workflow approval.

## Worktree

- Repository: `/Users/oleksandrbesan/data/riidii-md/mdmaid.desk`
- Worktree: `/Users/oleksandrbesan/data/riidii-md/mdmaid.desk/.worktrees/live-serving`
- Branch: `feat/live-serving`
- Base: `origin/main` at `23cc747` (`v0.1.12 [skip ci]`)
- Required repository verification: `npm run check`

The older `.worktrees/live-docs` checkout belongs to a separate, uncommitted
Live Docs editing/lease experiment. Do not modify, remove, or reuse it for this
feature.

## Prior pull-request evidence

There is no PR that proposes the complete switch described here, and the
relevant PRs have no comment or review discussion threads. Their PR bodies and
implementations establish the pieces:

- [#1 — plan mdmaid.desk web and TUI workspace](https://github.com/riidii-md/mdmaid.desk/pull/1)
  planned document-scoped events and independent live updates.
- [#4 — add web and TUI document workspaces](https://github.com/riidii-md/mdmaid.desk/pull/4)
  introduced SSE-backed client refresh, while leaving directory watching as a
  follow-up.
- [#10 — add optional daemon lifecycle](https://github.com/riidii-md/mdmaid.desk/pull/10)
  routed daemon-backed mutations through catalog events and again left watchers
  as follow-up work.
- [#14 — keep missing documents manageable](https://github.com/riidii-md/mdmaid.desk/pull/14)
  made registered source reads recover when a missing file returns.
- [#16 — add durable managed document imports](https://github.com/riidii-md/mdmaid.desk/pull/16)
  established the intended split: `register` keeps a source reference and
  `import` creates a private durable snapshot.
- [#18 — open workspace source links](https://github.com/riidii-md/mdmaid.desk/pull/18)
  explicitly kept linked repository files live instead of copying them.
- [#21 — open registered Markdown links in reader](https://github.com/riidii-md/mdmaid.desk/pull/21)
  routed registered Markdown targets to stable reader routes.
- [#25 — serve authenticated local SVG media](https://github.com/riidii-md/mdmaid.desk/pull/25)
  added document-scoped, re-authorized serving for workspace-local SVG images.

## Current behavior

The requested path-based source mode mostly exists already:

- `mdmaid-desk register <file.md> --workspace <id>` requires a path.
- `RegisterDocumentInput.path` is required by the CLI and HTTP API.
- registered documents persist `storage: "reference"` and their private
  canonical path;
- imported documents persist `storage: "managed"` and read a private copy;
- `Catalog.readDocument()` reads the physical registered source on every render
  request, so a manual browser reload/render sees the latest Markdown;
- public payloads already expose `storage` but never expose filesystem paths.

The missing live behavior is:

1. `Catalog.readDocument()` returns changed source bytes but does not update the
   stored content hash, revision, source-link mappings, reading state, or review
   state.
2. There is no implemented filesystem watcher. `artifactRoots` and the watcher
   design exist, but no runtime watches source changes.
3. SSE catalog events are emitted only by HTTP mutation handlers, not by source
   filesystem changes.
4. Web handles a catalog event with `load(false)`, which refreshes metadata and
   reviews but deliberately does not re-render the selected document.
5. TUI handles a catalog event by refreshing lists and reviews but does not
   re-render its open reader.
6. Local link/image mappings are discovered only during `register` or `import`.
   New, removed, or changed references in later Markdown are unknown until
   another registration.
7. Linked text files are already read live through authenticated source routes,
   and SVGs are already read live through authenticated media routes. The
   stored mapping can still become stale, and local raster media is not
   currently supported.

Relevant starting points:

- `src/catalog.ts`: registration, import, `readDocument`, source/media reads,
  revision and review invariants;
- `src/source-links.ts`: Markdown reference discovery and workspace
  authorization;
- `src/server.ts`: SSE `EventHub`, render/source/media routes, and public
  document projection;
- `src/web-client.ts`: selected-reader load and catalog-event handling;
- `src/tui.ts`: event refresh and terminal re-render flow;
- `src/domain.ts`, `src/storage.ts`, `src/sqlite-storage.ts`: persistence and
  public/private document boundaries.

## Proposed implementation shape

This is a candidate sequence for review, not yet an approved plan.

1. Write failing catalog tests for reconciling a changed registered source.
   The operation should re-read and re-authorize the source, compare its hash,
   increment revision once per distinct content change, rebuild source-link
   mappings, preserve metadata, make the new revision unread, and stale any
   pending review bound to the old hash/revision. A no-op reconciliation must
   not increment revision.
2. Add a narrow catalog reconciliation method for one reference document.
   Keep managed imports immutable and outside the watcher path. Prefer one
   catalog transaction for the document, mappings, and review transitions.
3. Write failing watcher/coordinator tests before adding runtime watching.
   Watch only cataloged reference sources or their authorized artifact roots,
   debounce/coalesce noisy events, reconstruct watches after daemon start, and
   handle change, deletion, atomic replacement, and restoration. Treat watcher
   notifications as hints: every reconciliation must re-authorize the real
   path and inspect the file independently.
4. Publish a path-free document event only after reconciliation is committed,
   for example a catalog event carrying `action: "source-changed"`, document
   ID, and revision. Publish missing/restored transitions as well. Avoid event
   storms and duplicate revisions.
5. Write Web tests proving that a source-change event re-renders only the open
   matching document, does not push browser history or issue an extra `opened`
   mutation, preserves the selected route, and handles Mermaid again. Preserve
   scroll or heading position where practical.
6. Write TUI tests proving that the open matching document re-renders at the
   current terminal width and preferences while unrelated document events only
   refresh queue metadata. Preserve reader selection and scroll where
   practical.
7. Display a concise source-mode badge in Web and TUI. Prefer deriving it from
   the existing public `storage` value (`reference` => live source, `managed`
   => snapshot) unless product review identifies a third semantic mode.
8. Rebuild Markdown link mappings during source reconciliation. Preserve the
   existing document-scoped source/media routes and stable registered-document
   routing. Test changed link targets, added/removed links, fragments, missing
   targets, and atomic source replacement.
9. Update README and architecture documentation to describe when live updates
   require a running daemon, how daemonless rendering behaves, and the exact
   source/media boundary.

## Open decisions requiring human review

1. Registration contract: keep the existing simple rule (`register` is always
   live/reference and `import` is always snapshot), or add a new explicit
   registration option? The current API already requires `path`, so a new path
   option alone would duplicate existing behavior.
2. Watch scope: watch each registered Markdown path, or watch authorized
   artifact roots and filter events? Per-document watches minimize scope;
   root watches may handle atomic replacement and many documents more reliably.
3. Linked-file updates: is live-on-request serving sufficient for linked source
   pages and media, or must changes to an open linked-source page also trigger
   an automatic browser refresh?
4. Media scope: retain the existing SVG-only allowlist, or explicitly add safe
   raster types such as PNG/JPEG/WebP/GIF? Adding types requires content
   signature validation, response limits, CSP review, and tests; file extension
   checks alone are insufficient.
5. Revision timing: reconcile immediately on filesystem notification, or only
   on render/list access with the watcher used to notify clients? Immediate
   reconciliation gives correct queue/review state before clients fetch.
6. Reader position: preserve raw scroll offset, nearest heading/anchor, or reset
   to the top after a live change. Heading-based restoration is less surprising
   when content above the viewport changes.

## Acceptance contract to approve or revise

- Registering an authorized Markdown path creates a visibly marked live-source
  document; importing creates a visibly marked snapshot.
- Editing a registered Markdown source while the daemon is running causes the
  matching open Web and TUI readers to show the new content without another
  `register` command or page reload.
- A distinct source content change increments the document revision exactly
  once, resets derived reading status to unread, and stales any pending review
  for the previous revision.
- Metadata-only filesystem noise and duplicate watcher events do not create
  revisions or repeated refresh loops.
- Added, removed, and retargeted relative Markdown links are reflected after
  reconciliation without re-registration.
- Existing linked text and supported media routes read current source content,
  use opaque IDs, and expose no filesystem paths.
- Missing, restored, replaced, symlinked, oversized, non-regular, escaped, and
  malformed sources fail safely and recover according to catalog state.
- Managed imports do not start following their original provenance path.
- Daemon restart reconstructs live watches from persisted reference documents.
- Daemonless registration and rendering remain functional; automatic push
  refresh is documented as daemon-dependent.
- Web/TUI parity is covered by automated tests.
- `npm run check` passes from this worktree.

## Guardrails

- Follow `AGENTS.md`: tests first, strict TypeScript, runtime input validation,
  real-path authorization before every read, atomic user-only state writes, and
  no ambient parent-workspace dependencies.
- Never expose source paths in API responses, rendered HTML, SSE payloads, logs,
  or error text.
- A watcher event is not authorization. Re-check containment, symlinks, regular
  file type, size, and content constraints on every read/reconciliation.
- Do not broaden registration beyond configured artifact roots.
- Do not turn registration, refresh, open, read, or review display into workflow
  approval.
- Preserve the existing uncommitted `.worktrees/live-docs` work.
- If an acceptance item conflicts with review-request invariants or requires a
  broader media security policy, stop and obtain an explicit decision rather
  than weakening the invariant.

## Verification

During implementation, run focused tests after each red/green step. Before
handoff or PR preparation, run:

```bash
npm run check
git diff --check
```

If media support changes, also run the repository's package smoke and coverage
checks discovered from `package.json`, and perform a changed-diff secret/path
exposure review.
