# Live source serving and refresh — implementation plan v1

## Goal

Make registered Markdown documents live source references whose current content,
revision state, source-link mappings, review state, and open Web/TUI readers
reconcile automatically while the daemon is running. Preserve imports as
durable snapshots and preserve daemonless registration and rendering.

## Approved decisions

1. Keep the existing contract: `register` creates a live reference and
   `import` creates a snapshot. Do not add another registration mode.
2. Watch shared parent directories for active reference documents and filter
   events to registered filenames. Reconcile all registered documents in a
   watched directory when the platform omits the event filename.
3. Treat watcher notifications as untrusted hints. Debounce them per document,
   then immediately re-authorize, inspect, and reconcile the document.
   `readDocument()` also reconciles on access so daemonless rendering cannot
   return content with stale revision metadata.
4. Watch primary Markdown sources only. Linked text and supported media remain
   live on request; their changes do not produce refresh events in this
   release.
5. Keep the existing SVG-only media allowlist. Raster support remains separate
   security work.
6. Preserve the nearest heading in the Web reader when practical. Preserve and
   clamp the line offset in the TUI reader.

## Implementation sequence

1. Add failing catalog tests for reference-source reconciliation: distinct
   content changes, no-op reads, revision-aware reading state, rebuilt links,
   pending-review staleness, missing/restored sources, invalid sources,
   managed snapshots, and concurrent/noisy reconciliation.
2. Add one narrow catalog reconciliation result with `unchanged`,
   `source-changed`, `source-missing`, and `source-restored` outcomes. Reuse it
   from `readDocument()`. Commit the document, link mappings, missing state, and
   review transition atomically.
3. Add failing coordinator tests, then implement a daemon-owned live-source
   coordinator. Share one non-recursive watcher per source parent directory,
   filter exact basenames, handle missing filenames, debounce per document,
   serialize reconciliation, recover watches from persisted active references,
   update watches after relevant catalog mutations, and close all watchers and
   timers with the server.
4. Emit only path-free catalog events after committed transitions:
   `source-changed`, `source-missing`, and `source-restored`, with document ID
   and current revision. Validate the extended event shape at runtime.
5. Add failing Web client tests, then separate initial open from live refresh.
   Refresh only the matching selected reader, rerun Mermaid, preserve the
   nearest heading where available, retain the route, and do not push history
   or send another `opened` mutation.
6. Add failing TUI tests, then rerender only the matching open reader at its
   current width and color/unicode preferences. Preserve and clamp scroll;
   unrelated events refresh queue and review metadata only.
7. Derive user-facing source labels from public `storage`: `reference` is
   `live source`, and `managed` is `snapshot`. Show the labels in Web and TUI
   without changing the public storage contract.
8. Update README and architecture documentation with daemon-dependent push
   refresh, daemonless reconciliation, watcher scope, source/link behavior, and
   the unchanged SVG media boundary.

## Acceptance criteria

- Editing a registered Markdown source while the daemon runs refreshes the
  matching open Web and TUI readers without registration or page reload.
- Each distinct content change increments revision exactly once, derives an
  unread status from the new revision, rebuilds relative link mappings, and
  stales a pending review for the prior revision.
- Duplicate or metadata-only events do not increment revision or cause refresh
  loops.
- Missing, restored, and atomically replaced sources transition safely and can
  recover without exposing a filesystem path.
- Every reconciliation repeats realpath containment, symlink, regular-file,
  size, Markdown, and link authorization checks before committing.
- Managed imports never follow or watch their original provenance path.
- Daemon restart reconstructs watches for persisted active live references.
- Web live refresh preserves route and reader position where possible, reruns
  Mermaid, and does not record another open action.
- TUI live refresh preserves reader selection, width, preferences, and a
  clamped scroll position.
- Web and TUI clearly label live sources and snapshots.
- Daemonless render remains functional and reconciles catalog revision state;
  automatic push refresh remains daemon-dependent.

## Exclusions and stop conditions

- Do not add raster media, linked-source-page watching, recursive artifact-root
  watching, editing/leases, or workflow approval semantics.
- Do not expose source paths in API payloads, SSE data, rendered output, logs,
  or errors.
- Stop for human review if reconciliation would require weakening path or
  review-request invariants, or if a platform fallback would broaden watcher
  scope beyond registered source parents.

## Verification

Run focused tests after each red/green step. Before handoff, run:

```bash
npm run check
git diff --check
```

