# Global Space Switcher Plan

Status: proposed; this document records the product direction but does not
approve implementation.

## Goal

Let one mdmaid.desk catalog contain personal and professional projects without
mixing them in the visible application. A persistent selector in the global
header chooses a named space such as **Home** or **Work**, and that selection
scopes the entire Web workspace rather than only the document queue.

The selected space must constrain:

- projects and navigation;
- document queues, status counts, and search;
- review/action counts and review requests;
- readers and direct document navigation;
- live updates and empty states.

This is primarily an accidental-disclosure and screen-sharing safeguard. It is
not a multi-user permissions system: anyone with the user's authenticated local
browser session may still deliberately choose another space unless a separate
presentation lock or authorization model is added.

## Terminology

`Workspace` already has a precise domain meaning: it is a registered project,
repository root, and filesystem authorization boundary. Reusing that term for
Home and Work would make APIs, storage, and UI behavior ambiguous.

This plan uses **space** as the working domain name:

```text
Space: Work
  ├── Workspace/project: customer-portal
  ├── Workspace/project: internal-tools
  └── Workspace/project: company-notes
```

A space is a named, persistent collection of existing workspaces. Membership
behaves like tagging: a workspace may belong to more than one space, and
changing membership does not move files or change filesystem authorization.
Document tags remain content labels within projects; they are not reused as the
global scope mechanism.

The final user-facing label remains a product decision. Candidates are
**Space**, **Workspace group**, and **Context**.

## Proposed experience

```text
┌ mdmaid.desk ─────── [ Space: Work ▾ ] ─────── ● live  ◐ ┐
│ projects          │ What needs your eyes?                 │
│ all work projects │ search and counts include Work only   │
│ customer-portal   │                                       │
│ internal-tools    │ document queue and reader             │
└───────────────────┴───────────────────────────────────────┘
```

The header selector is present in queue and reader views. Choosing a space:

1. updates the route immediately;
2. clears any out-of-scope document from the reader before loading data;
3. fetches scoped projects, documents, reviews, and counts from the server;
4. restores only filters and selection valid inside the new space;
5. reconnects the live event stream for that space.

The menu lists named spaces, provides an explicit **All spaces** choice, and
links to a small management surface for creating, renaming, deleting, and
assigning projects. `All spaces` must never be an implicit fallback while a
space switch is loading. If a selected space disappears, show a neutral
"space unavailable" state and require an explicit new selection.

Space selection is encoded in the URL so tabs can show different spaces and
one client cannot mutate daemon-global selection for every other client:

```text
/s/<space-id>
/s/<space-id>/d/<document-id>
```

Existing `/`, `/w/<workspace-id>`, and `/d/<document-id>` routes remain stable
and represent the explicit all-spaces view. The browser may remember the last
selected space for root navigation, but an explicit scoped URL always wins.

## Scope

### Included

- durable space definitions and many-to-many workspace membership;
- runtime-validated catalog, CLI, and API operations for space management;
- server-side space filters for all data used by the Web shell;
- header selection and management UI;
- scoped routes, direct-reader behavior, and browser-local last selection;
- scoped SSE delivery or equivalent server-side event filtering;
- a corresponding global space filter in the TUI to preserve client parity;
- migration, accessibility, responsive layout, and regression tests.

### Excluded

- moving or copying repository files;
- changing workspace artifact-root authorization;
- deriving access from Git remotes, operating-system accounts, or producers;
- sharing mdmaid.desk over a network;
- per-person accounts, roles, or cryptographic access control;
- treating space selection as workflow approval;
- automatically classifying existing projects as Home or Work.

## Domain and persistence

Add a schema migration after the current SQLite version with two strict tables:

```sql
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL
) STRICT;

CREATE TABLE space_workspaces (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  PRIMARY KEY (space_id, workspace_id)
) STRICT;
```

Validate IDs with the existing slug-style limits and validate normalized,
bounded display names at runtime. Preserve deterministic ordering using
`position`, with the identifier as a stable tie-breaker. Create, rename,
reorder, delete, and membership replacement operations must be transactional.

Existing catalogs migrate with no spaces and no inferred memberships. All
existing documents remain available through the explicit all-spaces view.
Creating or updating a workspace does not silently assign it; the management UI
shows unassigned projects so they cannot be forgotten.

The catalog/storage interfaces should expose space membership as domain data,
not make clients reconstruct it from tags. Filtering a document by space joins
through its `workspace_id`; document records and stable IDs do not change.

## API and CLI contract

Representative authenticated endpoints:

```text
GET    /api/v1/spaces
POST   /api/v1/spaces
PATCH  /api/v1/spaces/:space-id
PUT    /api/v1/spaces/:space-id/workspaces
DELETE /api/v1/spaces/:space-id

GET /api/v1/workspaces?space=<space-id>
GET /api/v1/documents?space=<space-id>&status=&tag=&search=
GET /api/v1/review-requests?space=<space-id>&status=
GET /api/v1/events?space=<space-id>
```

Every structured request and query value is runtime validated. An unknown or
malformed space ID fails closed. A scoped document render/action request must
verify membership server-side and return a neutral not-found response when the
document is outside that scope; it must not reveal the document title, project,
or existence.

Representative management commands:

```bash
mdmaid-desk space add work --name "Work"
mdmaid-desk space assign work customer-portal internal-tools
mdmaid-desk space list
mdmaid-desk list --space work
```

CLI commands continue to use the daemon when healthy and the bounded catalog
fallback otherwise. Space mutations publish catalog events just like workspace
and document mutations.

## Web behavior

The server must send only the selected space's public data. Client-side
filtering of an already-loaded all-spaces payload is insufficient for the
screen-sharing goal because stale state, counts, search results, or error paths
could reveal out-of-scope documents.

On selection change, the client first enters a loading boundary and removes the
old queue, project names, review details, reader title, reader content, and
counts. It then loads the new scoped state. A failed load keeps that neutral
boundary; it does not restore data from the previous space.

Within a space, the existing project selector remains a narrower filter. The
relationship is:

```text
space (global header) -> project/workspace (sidebar) -> status/search/tags
```

If the current project or document is not present in the new space, clear it.
Browser history must preserve space transitions, and back/forward navigation
must reconstruct both the global space and the narrower project/document view.

The selector must be keyboard operable, expose an accessible label and selected
state, fit the narrow responsive header, and use native or fully tested menu
focus behavior.

## TUI parity

The TUI should fetch the same server-scoped datasets rather than load all
documents and filter locally. Add the current space to the header/status line
and provide a space picker before the existing project cycle. Changing it
clears an out-of-scope reader and resets invalid project filters just as the Web
client does.

## Tests-first implementation sequence

1. **Domain and migration contract**
   - Add failing tests for schema upgrade, empty legacy state, strict rows,
     ordering, unique membership, cascades, and transactional replacement.
   - Add `Space` domain/runtime validators and storage methods.

2. **Catalog behavior**
   - Add failing tests for CRUD, many-to-many membership, unassigned projects,
     and space-filtered documents/reviews.
   - Implement catalog operations without changing document identity or path
     authorization.

3. **API and CLI vertical slice**
   - Add failing API tests for CRUD, scoped lists, neutral out-of-scope reads,
     malformed inputs, and daemon-first CLI behavior.
   - Implement the smallest end-to-end `space add`, `space assign`, and scoped
     listing slice.

4. **Scoped Web routes and data loading**
   - Add failing Web state tests for switching, stale-data clearing, invalid
     project/document reset, history, empty/error states, and persistence.
   - Add `/s/:space-id` and `/s/:space-id/d/:document-id`, then place the
     selector in the shared header.

5. **Live updates and review flows**
   - Add failing integration tests proving out-of-scope document/review events
     and payloads are not delivered to a scoped client.
   - Scope event subscriptions and every review/action count.

6. **Management and TUI parity**
   - Add tested create/rename/delete/membership controls and unassigned-project
     visibility.
   - Add the equivalent TUI picker and shared contract scenarios.

7. **Hardening and documentation**
   - Test keyboard navigation, narrow layouts, direct URLs, deletion races,
     daemon restart/reconnect, and catalogs migrated from every supported
     schema version.
   - Update architecture, local Web, CLI help, and user-facing terminology.

Keep each step independently runnable with strict TypeScript enabled. Reuse the
existing catalog storage boundary, runtime input validators, API error shape,
daemon-first CLI transport, and Web/TUI pure-state test patterns.

## Acceptance contract

- Given Home and Work spaces with different member projects, selecting Work
  shows no Home project, document title, tag, task, search result, status count,
  review count, reader content, or live-update payload anywhere in the Web UI.
- Switching space while a now-out-of-scope document is open removes its content
  before any network wait and lands on the selected space's queue.
- Refreshing, opening a scoped deep link, and browser back/forward preserve the
  explicit space.
- Two tabs may hold different spaces without changing each other's selection.
- A new document automatically appears in every space containing its existing
  workspace; no per-document reassignment is required.
- Unassigned projects are visible in management and in the explicit all-spaces
  view, but never appear inside a named space.
- Unknown, deleted, or malformed spaces fail closed without falling back to all
  data or leaking out-of-scope metadata.
- Space CRUD and membership updates survive daemon restart and preserve mode
  `0600` SQLite state and current filesystem authorization rules.
- Web and TUI use the same scoped API semantics.
- `npm run check` passes on every supported Node and package-smoke platform,
  with at least 80% line, branch, and function coverage for new behavior.

## Risks and blast-radius checks

- **Terminology collision:** keep `Workspace` unchanged in domain APIs until the
  user-facing name is decided; do not rename the authorization model as part of
  this feature.
- **False privacy:** describe spaces as presentation scopes, not user access
  controls. A separate locked presentation mode or multi-user design is needed
  if coworkers receive interactive access to the authenticated service.
- **Stale disclosure:** clear old state before switching and test failed loads,
  SSE reconnects, back navigation, and direct reader routes.
- **All-spaces fallback:** require explicit selection; never silently widen a
  missing or invalid scope.
- **Migration:** preserve all existing workspaces and documents without inferred
  classification or destructive rewrites.
- **Query drift:** centralize space membership checks so documents, reviews,
  counts, search, rendering, actions, and events cannot diverge.

Stop implementation if fulfilling the requirement would require network
sharing, per-colleague authentication, or an access-control guarantee; those
materially expand the product and threat model and need a separate decision.

## Alternatives considered

1. **Reuse document tags.** Smallest schema change, but spaces would have no
   stable identity, display name, ordering, management, or project-level default
   membership. A missing tag on one new document could leak it into the wrong
   view.
2. **Group registered workspaces (recommended).** Matches Home/Work project
   organization, automatically scopes new documents, and leaves filesystem
   boundaries intact. It cannot split mixed personal/work documents inside one
   registered workspace without first separating that workspace or adding a
   later override.
3. **Run separate catalogs/daemons.** Provides the strongest isolation but adds
   ports, authentication tokens, service lifecycle, and cross-catalog UX. Use
   this direction only if spaces must become a true security boundary.

## Open decisions

- Final UI term: Space, Workspace group, or Context?
- Should one workspace be allowed in several spaces, or exactly one?
- Should `All spaces` appear directly in the header menu or only in management?
- Is shoulder-surfing protection sufficient, or is a locked presentation mode
  required before showing the application to colleagues?
- If a single repository contains both Home and Work documents, should the
  first release support per-document overrides or require separate registered
  workspaces?

`/work-prove` is optional. Use it before implementation if spaces are expected
to provide an authorization guarantee rather than a global presentation scope.
