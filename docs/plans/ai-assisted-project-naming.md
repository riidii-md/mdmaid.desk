# AI-Assisted Project Naming

## Status

Core runtime implementation is included with this proposal. It adds schema
version 7, repository/task project identity, first-feature-name-wins behavior,
CLI/API fields, project routes, and browser/TUI grouping. Explicit legacy
reconciliation and the dependent Maisternia publisher contract remain follow-up
work requiring separate review before live configuration changes.

## Goal

Show one readable project for all documents that belong to the same repository
and Jira task, even when those documents come from different workspaces or
branches.

The visible name uses one fixed shape:

```text
<project or repository> / <JIRA-ID> (<minimal AI feature text>)
```

Example:

```text
EyWizards / SA-2913 (COA Worker Continuity)   4 docs
```

The AI creates the short feature text. Repository/project name and Jira ID are
grounded facts. A branch may help discover the Jira ID, but the branch is never
shown as the project name or used as a display fallback.

## Current Problem

mdmaid.desk currently treats `Workspace` as both:

- a canonical filesystem authorization boundary; and
- the logical project shown in browser and TUI navigation.

Workspace IDs are unique, but workspace display names and canonical roots are
not. The catalog can therefore contain two workspace IDs with the same name and
root. Documents are grouped by workspace ID, so the UI renders two identical
project labels with separate document counts.

Observed examples include typo variants such as:

```text
eywizards-sa2913-worker-continuity
eyewizards-sa2913-worker-continuity
```

Both can display as `EyWizards SA-2913 COA Worker Continuity` while remaining
different database groups.

The number on the right side of each current navigation entry is a document
count, but its bare rendering makes it look like part of the project identity.

## Current Architecture

The current domain contains:

```text
Workspace
  id
  name
  canonical root
  authorized artifact roots

Document
  workspaceId
  optional taskId
  producer, kind, title, tags, attention, reading/review state
```

SQLite schema version 6 stores workspaces and documents directly. Documents
are unique by `(workspace_id, path)`. Browser project navigation, TUI project
filtering, and the web queue's `project` grouping currently use `workspaceId`.
The web queue also supports `tag` and `all` grouping; those modes must remain
unchanged.

Workspace must remain the filesystem authorization boundary. A logical project
must not grant access to another root merely because documents share a name or
task.

## Proposed Model

Introduce a separate logical `Project` aggregate:

```text
Project
  id                 stable opaque route/storage ID
  repositoryKey      normalized repository identity
  taskKey             normalized Jira ID, or empty
  repositoryName     stored human repository/project label
  featureName        stored minimal AI-generated feature text
  featureNameSource  ai | user | derived | legacy
  createdAt
  updatedAt
```

Documents retain their existing workspace ownership and gain one project
mapping. Several authorized workspaces may contribute documents to the same
Project. Project membership changes presentation and filtering only; every
document read still resolves through its original Workspace.

## Identity And Display Name

Identity and presentation are deliberately separate.

### Hidden deterministic identity

The unique key is:

```text
normalized repository identity + normalized Jira task ID
```

The stored public route ID is an opaque digest of those complete inputs, for
example `project-<digest>`. Storage also enforces uniqueness over the complete
repository/task pair.

This hidden key prevents different agents from creating duplicate projects
when they choose different feature wording.

### AI-generated visible name

The producing AI supplies only the minimal feature text. mdmaid.desk assembles
the final label from grounded components:

```text
repositoryName / taskKey (featureName)
```

The AI feature text should:

- contain two to six meaningful words when practical;
- describe the durable feature or outcome;
- omit repository and Jira text already added by the UI;
- omit provider names, document kinds, dates, revisions, filenames, and
  temporary implementation mechanics;
- remain suitable for plans, research, reviews, and decisions for the task.

The first accepted feature text is stored. Later agents reuse it. A different
proposal for the same repository/task does not rename the Project and does not
create another Project.

An explicit authenticated rename changes only `featureName`, its source, and
the update timestamp. It does not change project ID, route, identity, document
membership, or workspace authorization.

### Missing Jira or AI context

Agent workflows should provide a grounded Jira ID and AI feature text for
normal task output. They may extract a Jira ID from an explicit task or from a
configured deterministic branch pattern such as `SA-[0-9]+`; they must never
invent one.

Non-agent callers remain supported:

- Jira ID without feature text renders `Repository / SA-2913`.
- Feature text without Jira ID renders `Repository (Feature Text)`.
- Neither renders only `Repository`.

No fallback exposes a branch name.

## Repository Identity

The implemented workspace registration stores a repository identity using this
order:

1. explicit `--repository <canonical-id>`;
2. deterministic local identity derived from the canonical root.

Automatic local Git `remote.origin.url` discovery remains a follow-up. Agents
that need cross-worktree grouping must provide the same explicit repository
identity; mdmaid.desk does not guess from a branch name.

Discovery is local and never contacts the remote. Normalization must:

- make supported SSH and HTTPS forms resolve to the same host/path identity;
- remove terminal `.git`;
- strip URL user information and credentials before persistence, output, logs,
  or errors;
- reject empty or malformed identities;
- retain an explicit override for repositories without a usable remote.

The identity is stored when the workspace is registered or explicitly
reconciled. It is not silently recomputed after a remote changes.

A second registration for the same canonical root should reuse the existing
mapping when repository identity agrees and reject a conflicting mapping. A
spelling change in workspace ID must not create a second logical Project.

## Storage And Migration

Advance SQLite from schema version 6 to version 7 using additive tables rather
than rebuilding `documents`:

```text
projects
  id PRIMARY KEY
  repository_key
  task_key NOT NULL DEFAULT ''
  repository_name
  feature_name
  feature_name_source
  created_at
  updated_at
  UNIQUE(repository_key, task_key)

workspace_repositories
  workspace_id PRIMARY KEY REFERENCES workspaces(id)
  repository_key
  repository_name
  source

document_projects
  document_id PRIMARY KEY REFERENCES documents(id)
  project_id REFERENCES projects(id)
```

The startup migration runs in one transaction. It creates one legacy Project
per existing Workspace and maps every document to it. This preserves current
grouping, display names, document paths, revisions, reading state, reviews,
responses, tags, source links, and authorization.

Startup migration performs no Git discovery and no semantic merging. A failed
migration rolls back completely and leaves the version-6 database usable by the
previous release.

After migration, every document must have exactly one project mapping. Missing
or invalid mappings are catalog corruption rather than an implicit fallback.

## Explicit Legacy Reconciliation

Duplicate cleanup is separate from startup migration:

```text
mdmaid-desk project reconcile plan [--workspace <id> ...]
mdmaid-desk project reconcile apply --plan <receipt> --yes
```

The read-only plan shows:

- source workspace and Project IDs;
- canonical roots and redacted repository identities;
- grounded Jira IDs;
- proposed target Project and visible label;
- document counts and affected routes;
- ambiguities that prevent apply;
- a digest binding the complete proposal.

Apply requires the exact current receipt and confirmation. It transactionally
changes only project metadata and document-project mappings. It does not delete
workspaces, documents, reviews, source links, or files. A stale receipt or
changed catalog is rejected.

This flow must be able to combine the observed SA-2913 and SA-2928 typo-variant
registrations while preserving their workspace authorization records.

## CLI And API Contract

The core implementation adds:

```text
GET    /api/v1/projects
GET    /p/<project-id>
```

An authenticated `POST /api/v1/projects/:id/rename` operation remains part of
the reviewed follow-up rather than this implementation slice.

Extend workspace registration with optional repository identity. Extend
document registration and import with optional `featureName`, while continuing
to use existing `taskId` for the Jira ID.

Representative CLI calls:

```bash
mdmaid-desk workspace add /path/to/worktree \
  --id eywizards-sa2913 \
  --repository github.com/example/eywizards

mdmaid-desk register plan.md \
  --workspace eywizards-sa2913 \
  --task SA-2913 \
  --feature-name "COA Worker Continuity"
```

The response returns the canonical Project and assembled visible label, so the
producer reports what mdmaid.desk actually reused or created.

Keep `/w/<workspace-id>`, `/t/<task-id>`, and `/d/<document-id>` stable. Keep
workspace filtering as a secondary/administrative view.

Registration without new fields remains supported. A new CLI sending project
metadata to an older daemon must detect the protocol mismatch and fail with an
upgrade instruction rather than silently discarding metadata. Old clients can
continue using the new daemon because the new request fields are optional.

## Browser And TUI

- Make Project the primary navigation/filtering object.
- Change the web queue's existing `project` grouping from Workspace to Project.
- Preserve the existing `tag` and `all` queue-grouping modes.
- Keep Workspace available as secondary authorization/source information.
- Render one label:
  `Repository / JIRA-ID (AI Feature Text)`.
- Render counts as `1 doc` or `N docs`, never as an unexplained number.
- Preserve an active filter only while the Project has visible documents.
- Use existing browser text-node rendering and TUI control-character
  sanitization for all supplied names.

## AI And Product Boundaries

mdmaid.desk does not call a model. The agent already producing the document
creates the minimal feature text and sends it during registration.

AgentnykMaisternia does not assign runtime names or own Project state. After a
compatible mdmaid-desk release exists, a separate Maisternia PR should:

1. add a provider-neutral project-naming reference to `readable-output`;
2. require grounded repository/Jira context and AI-generated feature text;
3. update every direct mdmaid.desk publisher so none bypass the contract;
4. install the same resource for Codex, Claude, and Antigravity through the
   `software-engineer` collection;
5. raise the mdmaid-desk capability/version requirement;
6. preserve normal preview, conflict, backup, drift, and opt-in apply behavior.

The Maisternia PR depends on the finalized mdmaid-desk CLI/API and published
minimum version. It must not be merged first.

## Tests-First Delivery

### 1. Domain and storage contract

Write failing tests for:

- same repository/Jira task across multiple workspaces yields one Project;
- same Jira ID in different repositories yields different Projects;
- different AI feature wording does not duplicate or rename a Project;
- explicit rename preserves identity and membership;
- ticketless and non-AI fallbacks never expose a branch;
- repository identities are credential-free and stable.

Then implement Project types, storage, and transactional create/reuse behavior.

### 2. Schema version 7

Test migration from every supported schema version, future-version rejection,
rollback on injected failure, and preservation of all document/review/source
state. Then add the three mapping tables and conservative legacy population.

### 3. CLI/API compatibility

Test the extended request/response validators, project list/rename, stable
route, old request shapes, and mixed daemon/CLI behavior. Then implement the
versioned contract.

### 4. Browser and TUI project presentation

Test combined counts across workspaces, the exact visible-name shape, labeled
counts, safe rendering, filter recovery, and preservation of tag/all grouping.
Then switch primary navigation and project grouping.

### 5. Reconciliation

Test read-only planning, plan digest binding, stale rejection, ambiguity
handling, transactional apply, rollback, and copied fixtures representing the
observed typo variants. Then implement plan/apply.

### 6. Documentation, verification, and release

Document migration, backup, rollback, CLI/API, naming rules, and security
boundaries. Run:

```bash
npm run check
npm run package:smoke
```

Review and merge the runtime PR before publishing a compatible package release.

### 7. Dependent Maisternia PR

Use tests first for manifest membership, preset rendering, provider targets,
content rules, and the new minimum mdmaid-desk capability. Run the complete
Maisternia verification suite and disposable-home collection plans before
publishing or applying provider configuration.

## Safety And Compatibility

- Project membership never expands filesystem authority.
- Repository normalization never stores credentials or contacts remotes.
- AI text is validated, length-limited, and safely rendered.
- AI cannot choose project identity or Jira IDs.
- Startup migration never guesses or merges semantic identity.
- Reconciliation is previewed, digest-bound, confirmed, and transactional.
- No workspace, document, review, source link, or file is automatically
  deleted.
- Old stable routes and old registration calls remain valid.
- Protocol mismatch cannot silently discard project metadata.
- Branch names remain private context and never become displayed defaults.

## Acceptance Contract

The design is implemented when observable evidence proves:

- `EyWizards / SA-2913 (COA Worker Continuity)` appears once across all of its
  workspaces and branches;
- its count equals the number of visible documents in the combined Project;
- an AI wording variation cannot create or rename another Project;
- a different repository with `SA-2913` remains separate;
- an explicit rename changes only the feature text;
- ticketless and non-agent documents remain usable without branch labels;
- legacy migration preserves every catalog record and user state;
- duplicate reconciliation is separately previewed and approved;
- browser, TUI, API, CLI, daemon, and package checks pass;
- the later Maisternia contract renders consistently for Codex, Claude, and
  Antigravity without making Maisternia a runtime.

## Rollout And Rollback

1. Back up the live SQLite catalog.
2. Install the compatible mdmaid-desk release.
3. Verify conservative schema migration and all existing routes/documents.
4. Generate and review the duplicate-reconciliation plan.
5. Apply reconciliation only after explicit confirmation.
6. If validation fails, stop the new daemon and restore the backup with the
   previous binary; do not manually edit the database.
7. Merge and install the dependent Maisternia contract.
8. Preview the `software-engineer` collection and explicitly resolve all
   conflicts before apply.

## Follow-up Decisions

- Design an authenticated explicit rename operation; automatic AI renaming is
  already excluded by the implemented first-feature-name-wins rule.
- Decide whether automatic local Git-origin discovery should supplement the
  implemented explicit-identity and canonical-root paths.
- Finalize legacy cleanup as a separate plan/apply operation.
- Apply the pending `software-engineer` collection only after the dependent
  Maisternia publisher contract lands.

The core implementation follows the fixed naming decision in this document.
The remaining open decisions apply to reconciliation and later workflow rollout.
